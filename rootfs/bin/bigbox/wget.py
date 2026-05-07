import argparse
import base64
import json
import os
import sys
from urllib.parse import urlparse

from pyodide.http import pyfetch


def build_parser():
    parser = argparse.ArgumentParser(add_help=False, prog="wget")
    parser.add_argument("-O", "--output-document", dest="output")
    parser.add_argument("-q", "--quiet", action="store_true")
    parser.add_argument("-S", "--server-response", action="store_true")
    parser.add_argument("-h", "--help", action="store_true", dest="help_flag")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("url", nargs="?")
    return parser


def output_name(url):
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


async def fetch_via_proxy(url):
    proxy_resp = await pyfetch(
        "/__edgeterm_http_proxy",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"url": url, "method": "GET", "headers": {}}),
    )
    if not proxy_resp.ok:
        raise RuntimeError(f"proxy failed with HTTP {proxy_resp.status}")
    data = await proxy_resp.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or "proxy request failed")
    return {
        "status": int(data.get("status", 0)),
        "status_text": str(data.get("reason", "")),
        "headers": data.get("headers", {}) or {},
        "body": base64.b64decode(data.get("body_base64", "") or ""),
        "ok": 200 <= int(data.get("status", 0)) < 300,
    }


async def main(argv):
    parser = build_parser()
    args, extras = parser.parse_known_args(argv)

    if args.help_flag:
        parser.print_help()
        return 0
    if args.version:
        print("GNU Wget 1.24 (EdgeTerm bigbox)")
        return 0
    if extras:
        print(f"wget: warning: unsupported arguments ignored: {' '.join(extras)}", file=sys.stderr)
    if not args.url:
        print("wget: missing URL", file=sys.stderr)
        print("Usage: wget [OPTION]... [URL]...", file=sys.stderr)
        return 2
    try:
        url = normalize_url(args.url)
    except ValueError as exc:
        print(f"wget: {exc}", file=sys.stderr)
        return 2

    target = os.path.abspath(args.output or output_name(url))

    if not args.quiet:
        print(f"--{url}--")
        print(f"Saving to: '{os.path.basename(target)}'")

    used_proxy = False
    try:
        response = await pyfetch(url, method="GET", redirect="follow")
        status = response.status
        status_text = response.status_text
        response_headers = response_header_dict(response.headers)
        data = bytes(await response.bytes())
        ok = response.ok
        if status == 0:
            proxied = await fetch_via_proxy(url)
            used_proxy = True
            status = proxied["status"]
            status_text = proxied["status_text"]
            response_headers = proxied["headers"]
            data = proxied["body"]
            ok = proxied["ok"]
    except Exception as exc:
        message = str(exc)
        if "Failed to fetch" not in message:
            print(f"wget: unable to resolve host address '{url}': {message}", file=sys.stderr)
            return 4
        try:
            proxied = await fetch_via_proxy(url)
        except Exception as proxy_exc:
            print(
                f"wget: unable to fetch '{url}' (browser blocked direct request; proxy fallback failed: {proxy_exc})",
                file=sys.stderr,
            )
            return 4
        used_proxy = True
        status = proxied["status"]
        status_text = proxied["status_text"]
        response_headers = proxied["headers"]
        data = proxied["body"]
        ok = proxied["ok"]

    if args.server_response:
        if used_proxy:
            print("  via EdgeTerm local proxy", file=sys.stderr)
        print(f"  HTTP/1.1 {status} {status_text}", file=sys.stderr)
        for key, value in response_headers.items():
            print(f"  {key}: {value}", file=sys.stderr)

    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(data)

    if not args.quiet:
        print(f"{len(data)} bytes written to {target}")

    if ok:
        return 0
    print(f"wget: server returned error: HTTP {status} {status_text}", file=sys.stderr)
    return 8
