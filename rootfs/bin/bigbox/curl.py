import argparse
import base64
import json
import os
import sys
from urllib.parse import urlparse

from pyodide.http import pyfetch


def build_parser():
    parser = argparse.ArgumentParser(add_help=False, prog="curl")
    parser.add_argument("-L", "--location", action="store_true", help="Follow redirects")
    parser.add_argument("-I", "--head", action="store_true", help="Fetch headers only")
    parser.add_argument("-X", "--request", dest="method", help="HTTP method")
    parser.add_argument("-H", "--header", action="append", default=[], help="Custom header")
    parser.add_argument("-d", "--data", dest="data", help="HTTP request body")
    parser.add_argument("-o", "--output", dest="output", help="Write output to file")
    parser.add_argument("-s", "--silent", action="store_true", help="Silent mode")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")
    parser.add_argument("-h", "--help", action="store_true", dest="help_flag")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("url", nargs="?")
    return parser


def parse_headers(values):
    headers = {}
    for item in values:
        if ":" not in item:
            continue
        key, value = item.split(":", 1)
        headers[key.strip()] = value.lstrip()
    return headers


def decode_text(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def output_path_for_url(url):
    parsed = urlparse(url)
    name = os.path.basename(parsed.path.rstrip("/"))
    return name or "index.html"


def normalize_url(raw):
    value = (raw or "").strip()
    if not value:
        raise ValueError("URL is empty")
    parsed = urlparse(value)
    if parsed.scheme:
        return value
    if value.startswith("//"):
        return f"http:{value}"
    if "://" not in value:
        return f"http://{value}"
    raise ValueError(f"Malformed URL: {raw}")


def response_header_dict(headers_obj):
    if headers_obj is None:
        return {}
    if isinstance(headers_obj, dict):
        return {str(k): str(v) for k, v in headers_obj.items()}
    try:
        return {str(k): str(v) for k, v in dict(headers_obj.entries()).items()}
    except Exception:
        pass
    try:
        return {str(k): str(v) for k, v in headers_obj.items()}
    except Exception:
        return {}


async def fetch_via_proxy(url, method, headers, body):
    payload = {
        "url": url,
        "method": method,
        "headers": headers or {},
    }
    if body is not None:
        payload["body_base64"] = base64.b64encode(body.encode("utf-8")).decode("ascii")
    proxy_resp = await pyfetch(
        "/__edgeterm_http_proxy",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps(payload),
    )
    if not proxy_resp.ok:
        raise RuntimeError(f"proxy failed with HTTP {proxy_resp.status}")
    data = await proxy_resp.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or "proxy request failed")
    raw = base64.b64decode(data.get("body_base64", "") or "")
    return {
        "status": int(data.get("status", 0)),
        "status_text": str(data.get("reason", "")),
        "headers": data.get("headers", {}) or {},
        "body": raw,
        "ok": 200 <= int(data.get("status", 0)) < 300,
    }


async def main(argv):
    parser = build_parser()
    args, extras = parser.parse_known_args(argv)

    if args.help_flag:
        parser.print_help()
        return 0
    if args.version:
        print("curl 8.8.0 (EdgeTerm bigbox)")
        return 0
    if extras:
        print(f"curl: warning: unsupported arguments ignored: {' '.join(extras)}", file=sys.stderr)
    if not args.url:
        print("curl: no URL specified", file=sys.stderr)
        print("curl: try 'curl --help' for more information", file=sys.stderr)
        return 2
    try:
        url = normalize_url(args.url)
    except ValueError as exc:
        print(f"curl: (3) {exc}", file=sys.stderr)
        return 3

    method = args.method.upper() if args.method else ("HEAD" if args.head else ("POST" if args.data is not None else "GET"))
    headers = parse_headers(args.header)
    body = args.data if args.data is not None else None

    used_proxy = False
    try:
        response = await pyfetch(
            url,
            method=method,
            headers=headers,
            body=body,
            redirect="follow" if args.location else "manual",
        )
        raw = bytes(await response.bytes()) if not args.head else b""
        status = response.status
        status_text = response.status_text
        response_headers = response_header_dict(response.headers)
        ok = response.ok
        if status == 0:
            proxied = await fetch_via_proxy(url, method, headers, body)
            used_proxy = True
            raw = proxied["body"]
            status = proxied["status"]
            status_text = proxied["status_text"]
            response_headers = proxied["headers"]
            ok = proxied["ok"]
    except Exception as exc:
        message = str(exc)
        if "Failed to fetch" not in message:
            print(f"curl: (6) {message}", file=sys.stderr)
            return 6
        try:
            proxied = await fetch_via_proxy(url, method, headers, body)
        except Exception as proxy_exc:
            print(
                f"curl: (7) Request blocked by browser policy and proxy fallback failed: {proxy_exc}",
                file=sys.stderr,
            )
            return 7
        used_proxy = True
        raw = proxied["body"]
        status = proxied["status"]
        status_text = proxied["status_text"]
        response_headers = proxied["headers"]
        ok = proxied["ok"]

    if args.verbose and not args.silent:
        print(f"> {method} {url}", file=sys.stderr)
        for key, value in headers.items():
            print(f"> {key}: {value}", file=sys.stderr)
        if used_proxy:
            print("> via EdgeTerm local proxy", file=sys.stderr)
        print(f"< HTTP {status} {status_text}", file=sys.stderr)
        for key, value in response_headers.items():
            print(f"< {key}: {value}", file=sys.stderr)

    if args.head:
        if not args.silent:
            print(f"HTTP/1.1 {status} {status_text}")
            for key, value in response_headers.items():
                print(f"{key}: {value}")
            print()
        return 0 if ok else 22

    if args.output:
        target = os.path.abspath(args.output)
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(raw)
    elif not args.silent:
        print(decode_text(raw), end="" if raw.endswith(b"\n") else "\n")

    if ok:
        return 0
    if not args.silent:
        print(f"curl: (22) HTTP {status} {status_text}", file=sys.stderr)
    return 22
