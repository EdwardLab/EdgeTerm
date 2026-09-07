import asyncio
import base64
import importlib
import io
import json
import mimetypes
import os
import sys
import time
from dataclasses import dataclass
from urllib.parse import unquote


@dataclass
class AppInstance:
    id: str
    mode: str
    target: object
    working_directory: str
    route_prefix: str
    label: str = ""


_instances = {}
_websocket_sessions = {}


def create_instance(mode, spec="", working_directory=None, instance_id="", route_prefix=""):
    requested_mode = str(mode or "wsgi").lower()
    normalized_mode = _normalize_mode(mode)
    cwd = os.path.abspath(working_directory or os.environ.get("PWD") or os.getcwd())
    if cwd and cwd not in sys.path:
        sys.path.insert(0, cwd)
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)

    instance_id = _safe_instance_id(instance_id or _make_instance_id(normalized_mode))
    route_prefix = _normalize_prefix(route_prefix or f"/{normalized_mode}-{instance_id}")
    if normalized_mode == "static":
        target = os.path.abspath(spec or cwd or ".")
    else:
        if requested_mode == "django":
            _prepare_django_context(force=True)
        target = load_app(spec, cwd)
        # After Django app is loaded and settings are configured, set
        # FORCE_SCRIPT_NAME so Django generates URLs (static, admin)
        # with the EdgeTerm route prefix.
        if requested_mode == "django":
            try:
                from django.conf import settings as _dj_settings
                _dj_settings.FORCE_SCRIPT_NAME = route_prefix
            except Exception:
                pass
    instance = AppInstance(
        id=instance_id,
        mode=normalized_mode,
        target=target,
        working_directory=cwd,
        route_prefix=route_prefix,
        label=str(spec or target),
    )
    _instances[instance_id] = instance
    return instance_info(instance)


def remove_instance(instance_id):
    return _instances.pop(str(instance_id or ""), None) is not None


def get_instance(instance_id):
    instance = _instances.get(str(instance_id or ""))
    if instance is None:
        raise KeyError(f"EdgeTerm app instance not found: {instance_id}")
    return instance


def list_instances():
    return [instance_info(instance) for instance in _instances.values()]


def instance_info(instance):
    return {
        "id": instance.id,
        "mode": instance.mode,
        "routePrefix": instance.route_prefix,
        "workingDirectory": instance.working_directory,
        "label": instance.label,
    }


def load_app(spec, working_directory=None):
    raw = str(spec or "").strip()
    if ":" not in raw:
        raise ValueError("App spec must look like module:object, for example app:app")
    module_name, object_path = raw.split(":", 1)
    module_name = module_name.strip()
    object_path = object_path.strip() or "app"
    if not module_name:
        raise ValueError("App spec is missing a module name")

    if working_directory and working_directory not in sys.path:
        sys.path.insert(0, working_directory)

    if module_name.endswith(".py"):
        module_name = module_name[:-3].replace("/", ".").replace("\\", ".")
    module = importlib.import_module(module_name)
    target = module
    for part in object_path.split("."):
        if not part:
            continue
        target = getattr(target, part)
    if not callable(target):
        raise TypeError(f"{raw} did not resolve to a callable app object.")
    return target


def _django_settings_polluted():
    try:
        from django.conf import settings

        if not getattr(settings, "configured", False):
            return False
        wrapped = getattr(settings, "_wrapped", None)
        settings_module = getattr(wrapped, "SETTINGS_MODULE", None) or os.environ.get("DJANGO_SETTINGS_MODULE")
        databases = getattr(wrapped, "DATABASES", None) or {}
        default_db = databases.get("default", {}) if isinstance(databases, dict) else {}
        engine = str(default_db.get("ENGINE", ""))
        return not settings_module or engine == "django.db.backends.dummy"
    except Exception:
        return False


def _reset_django_modules():
    for name in list(sys.modules):
        if name == "django" or name.startswith("django."):
            sys.modules.pop(name, None)


def _prepare_django_context(force=False):
    if force or _django_settings_polluted():
        _reset_django_modules()
    os.environ.setdefault("DJANGO_ALLOW_ASYNC_UNSAFE", "true")
    _install_pbkdf2_hmac_compat()


def _install_pbkdf2_hmac_compat():
    import hashlib as _hl
    import hmac as _hmac
    import struct as _struct

    def _pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None):
        _hash = _hl.new(hash_name)
        digest_size = _hash.digest_size
        if dklen is None:
            dklen = digest_size
        if dklen > (2 ** 32 - 1) * digest_size:
            raise OverflowError("dklen too large")
        if isinstance(password, str):
            password = password.encode("utf-8")
        if isinstance(salt, str):
            salt = salt.encode("utf-8")
        block_count = (dklen + digest_size - 1) // digest_size
        blocks = [b""] * block_count
        for index in range(1, block_count + 1):
            u_value = _hmac.new(password, salt + _struct.pack(">I", index), hash_name).digest()
            block = u_value
            for _ in range(1, iterations):
                u_value = _hmac.new(password, u_value, hash_name).digest()
                block = bytes(left ^ right for left, right in zip(block, u_value))
            blocks[index - 1] = block
        return b"".join(blocks)[:dklen]

    _hl.pbkdf2_hmac = _pbkdf2_hmac


def _serve_django_static(path_info):
    """Serve a Django static file using staticfiles finders.
    Returns a response dict or None if the file is not found."""
    try:
        from django.contrib.staticfiles.finders import get_finders
        from django.contrib.staticfiles.storage import staticfiles_storage
    except ImportError:
        return None
    # Path is like /static/admin/css/base.css — strip the STATIC_URL prefix
    try:
        from django.conf import settings
        static_url = getattr(settings, "STATIC_URL", "/static/")
    except Exception:
        static_url = "/static/"
    path_info = _normalize_path(path_info)
    if "/static/" in path_info and not path_info.startswith("/static/"):
        path_info = path_info[path_info.index("/static/") :]
    if static_url and not static_url.startswith("/"):
        static_url = f"/{static_url}"
    if static_url and not static_url.endswith("/"):
        static_url = f"{static_url}/"
    if static_url and "/static/" in static_url and not path_info.startswith(static_url):
        static_url = static_url[static_url.index("/static/") :]
    if not path_info.startswith(static_url or "/static/"):
        static_url = "/static/"
    relative = path_info
    if static_url and static_url != "/" and path_info.startswith(static_url):
        relative = path_info[len(static_url):]
    elif path_info.startswith("/static/"):
        relative = path_info[len("/static/"):]
    if not relative:
        return None
    # Try staticfiles_storage first (handles hashed filenames)
    try:
        if staticfiles_storage.exists(relative):
            with staticfiles_storage.open(relative, "rb") as f:
                data = f.read()
            content_type = mimetypes.guess_type(relative)[0] or "application/octet-stream"
            return _response_from_bytes("200 OK", [("content-type", content_type)], data)
    except Exception:
        pass
    # Fall back to finders
    for finder in get_finders():
        try:
            full_path = finder.find(relative)
            if full_path:
                with open(full_path, "rb") as f:
                    data = f.read()
                content_type = mimetypes.guess_type(relative)[0] or "application/octet-stream"
                return _response_from_bytes("200 OK", [("content-type", content_type)], data)
        except Exception:
            continue
    return None


def dispatch(app, path="/", method="GET", query_string="", headers=None, body="", script_name=""):
    body_bytes = _body_bytes(body)
    normalized_headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    script_name = "" if script_name == "/" else _normalize_prefix(script_name or "")
    path_info = _strip_mount_prefix(path, script_name)

    environ = {
        "REQUEST_METHOD": str(method or "GET").upper(),
        "SCRIPT_NAME": script_name,
        "PATH_INFO": path_info,
        "QUERY_STRING": str(query_string or ""),
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "80",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(body_bytes),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
        "CONTENT_LENGTH": str(len(body_bytes)),
        "REMOTE_ADDR": "127.0.0.1",
        "REMOTE_HOST": "localhost",
    }

    content_type = normalized_headers.get("content-type")
    if content_type:
        environ["CONTENT_TYPE"] = content_type
    for key, value in normalized_headers.items():
        header_name = key.upper().replace("-", "_")
        if header_name in {"CONTENT_TYPE", "CONTENT_LENGTH"}:
            continue
        environ[f"HTTP_{header_name}"] = value

    response = {"status": "500 Internal Server Error", "headers": []}

    def start_response(status, response_headers, exc_info=None):
        response["status"] = status
        response["headers"] = list(response_headers or [])
        return lambda data: None

    chunks = []
    iterable = app(environ, start_response)
    try:
        for chunk in iterable:
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8")
            chunks.append(bytes(chunk))
    finally:
        close = getattr(iterable, "close", None)
        if close:
            close()

    return _response_from_bytes(response["status"], response["headers"], b"".join(chunks))


async def dispatch_asgi(app, path="/", method="GET", query_string="", headers=None, body="", root_path=""):
    body_bytes = _body_bytes(body)
    normalized_headers = [(str(k).lower().encode("latin-1"), str(v).encode("latin-1")) for k, v in (headers or {}).items()]
    root_path = "" if root_path == "/" else _normalize_prefix(root_path or "")
    path_info = _strip_mount_prefix(path, root_path)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": str(method or "GET").upper(),
        "scheme": "http",
        "path": path_info,
        "raw_path": path_info.encode("utf-8"),
        "query_string": str(query_string or "").encode("utf-8"),
        "root_path": root_path,
        "headers": normalized_headers,
        "client": ("127.0.0.1", 0),
        "server": ("localhost", 80),
    }
    sent_body = False
    messages = []

    async def receive():
        nonlocal sent_body
        if sent_body:
            return {"type": "http.disconnect"}
        sent_body = True
        return {"type": "http.request", "body": body_bytes, "more_body": False}

    async def send(message):
        messages.append(dict(message))

    result = app(scope, receive, send)
    if hasattr(result, "__await__"):
        await result

    status = 500
    response_headers = []
    chunks = []
    for message in messages:
        if message.get("type") == "http.response.start":
            status = int(message.get("status") or 500)
            response_headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in message.get("headers", [])]
        elif message.get("type") == "http.response.body":
            chunks.append(bytes(message.get("body") or b""))
    return _response_from_bytes(f"{status} {_reason_phrase(status)}", response_headers, b"".join(chunks))


async def open_websocket_instance(instance_id, connection_id, path="/", query_string="", headers=None, protocols=None):
    instance = get_instance(instance_id)
    if instance.mode != "asgi":
        return {"ok": False, "status": 1002, "reason": "WebSocket is only supported by ASGI EdgeServe apps."}

    path_info = _strip_mount_prefix(path, instance.route_prefix)
    normalized_headers = [
        (str(k).lower().encode("latin-1"), str(v).encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    inbound = asyncio.Queue()
    outbound = asyncio.Queue()
    session = {
        "instance_id": instance_id,
        "connection_id": connection_id,
        "inbound": inbound,
        "outbound": outbound,
        "accepted": False,
        "closed": False,
        "task": None,
    }
    _websocket_sessions[connection_id] = session

    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "scheme": "ws",
        "path": path_info,
        "raw_path": path_info.encode("utf-8"),
        "query_string": str(query_string or "").encode("utf-8"),
        "root_path": "" if instance.route_prefix == "/" else instance.route_prefix,
        "headers": normalized_headers,
        "client": ("127.0.0.1", 0),
        "server": ("localhost", 80),
        "subprotocols": [str(item) for item in (protocols or [])],
    }

    async def receive():
        return await inbound.get()

    async def send(message):
        message = dict(message or {})
        message_type = message.get("type")
        if message_type == "websocket.accept":
            session["accepted"] = True
            await outbound.put({
                "type": "accept",
                "subprotocol": message.get("subprotocol") or "",
                "headers": _decode_asgi_headers(message.get("headers", [])),
            })
        elif message_type == "websocket.send":
            if "bytes" in message and message.get("bytes") is not None:
                await outbound.put({
                    "type": "message",
                    "kind": "bytes",
                    "dataBase64": base64.b64encode(bytes(message.get("bytes") or b"")).decode("ascii"),
                })
            else:
                await outbound.put({"type": "message", "kind": "text", "data": str(message.get("text") or "")})
        elif message_type == "websocket.close":
            session["closed"] = True
            await outbound.put({
                "type": "close",
                "code": int(message.get("code") or 1000),
                "reason": str(message.get("reason") or ""),
            })

    async def run_app():
        previous_cwd = os.getcwd()
        if instance.working_directory and os.path.isdir(instance.working_directory):
            os.chdir(instance.working_directory)
        try:
            result = instance.target(scope, receive, send)
            if hasattr(result, "__await__"):
                await result
            if not session["closed"]:
                session["closed"] = True
                await outbound.put({"type": "close", "code": 1000, "reason": ""})
        except Exception as exc:
            session["closed"] = True
            await outbound.put({"type": "close", "code": 1011, "reason": str(exc)})
        finally:
            os.chdir(previous_cwd)

    await inbound.put({"type": "websocket.connect"})
    session["task"] = asyncio.create_task(run_app())
    try:
        first = await asyncio.wait_for(outbound.get(), timeout=5)
    except asyncio.TimeoutError:
        await close_websocket(connection_id, 1006, "WebSocket accept timed out")
        return {"ok": False, "status": 1006, "reason": "WebSocket accept timed out"}
    if first.get("type") == "accept":
        return {"ok": True, **first}
    _websocket_sessions.pop(connection_id, None)
    return {"ok": False, "status": int(first.get("code") or 1000), "reason": str(first.get("reason") or "")}


async def websocket_send(connection_id, kind="text", data="", data_base64=""):
    session = _websocket_sessions.get(str(connection_id or ""))
    if not session or session.get("closed"):
        return {"ok": False, "error": "WebSocket is closed."}
    if kind == "bytes":
        message = {"type": "websocket.receive", "bytes": base64.b64decode(data_base64 or ""), "text": None}
    else:
        message = {"type": "websocket.receive", "text": str(data or ""), "bytes": None}
    await session["inbound"].put(message)
    return {"ok": True}


async def websocket_poll(connection_id, timeout=0.25):
    session = _websocket_sessions.get(str(connection_id or ""))
    if not session:
        return {"ok": False, "events": [{"type": "close", "code": 1006, "reason": "WebSocket session not found."}]}
    events = []
    deadline = time.time() + max(0.0, float(timeout or 0))
    while True:
        remaining = deadline - time.time()
        try:
            event = await asyncio.wait_for(session["outbound"].get(), timeout=max(0.0, remaining))
            events.append(event)
            if event.get("type") == "close":
                _websocket_sessions.pop(str(connection_id or ""), None)
                break
            if len(events) >= 50:
                break
        except asyncio.TimeoutError:
            break
    return {"ok": True, "events": events}


async def close_websocket(connection_id, code=1000, reason=""):
    session = _websocket_sessions.get(str(connection_id or ""))
    if not session:
        return {"ok": True}
    if not session.get("closed"):
        session["closed"] = True
        await session["inbound"].put({"type": "websocket.disconnect", "code": int(code or 1000), "reason": str(reason or "")})
    task = session.get("task")
    if task and not task.done():
        try:
            await asyncio.wait_for(task, timeout=1)
        except Exception:
            task.cancel()
    _websocket_sessions.pop(str(connection_id or ""), None)
    return {"ok": True}


async def dispatch_instance(instance_id, path="/", method="GET", query_string="", headers=None, body=""):
    instance = get_instance(instance_id)
    path_info = _strip_mount_prefix(path, instance.route_prefix)
    previous_cwd = os.getcwd()
    if instance.working_directory and os.path.isdir(instance.working_directory):
        os.chdir(instance.working_directory)
    try:
        if instance.mode in ("wsgi", "django"):
            _install_pbkdf2_hmac_compat()
        # Serve Django static files directly from site-packages when
        # DEBUG=True, matching the development-server behaviour.
        if instance.mode in ("wsgi", "django") and path_info.startswith("/static/"):
            static_result = _serve_django_static(path_info)
            if static_result:
                return static_result
        if instance.mode == "asgi":
            return await dispatch_asgi(
                instance.target,
                path=path_info,
                method=method,
                query_string=query_string,
                headers=headers,
                body=body,
                root_path=instance.route_prefix,
            )
        if instance.mode == "static":
            return dispatch_static(instance.target, path=path_info)
        return dispatch(
            instance.target,
            path=path_info,
            method=method,
            query_string=query_string,
            headers=headers,
            body=body,
            script_name=instance.route_prefix,
        )
    finally:
        os.chdir(previous_cwd)


def _decode_asgi_headers(headers):
    decoded = {}
    for key, value in headers or []:
        key_text = key.decode("latin-1") if isinstance(key, (bytes, bytearray)) else str(key)
        value_text = value.decode("latin-1") if isinstance(value, (bytes, bytearray)) else str(value)
        decoded[key_text.lower()] = value_text
    return decoded


def dispatch_static(root, path="/"):
    root = os.path.abspath(str(root or "."))
    route_path = _normalize_path(path)
    rel = unquote(route_path).lstrip("/")
    fs_path = os.path.abspath(os.path.join(root, rel))
    try:
        inside_root = os.path.commonpath([root, fs_path]) == root
    except ValueError:
        inside_root = False
    if not inside_root:
        return {"status": 403, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": "Forbidden"}
    if os.path.isdir(fs_path):
        fs_path = os.path.join(fs_path, "index.html")
    if not os.path.isfile(fs_path):
        return {"status": 404, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": "Not found"}
    with open(fs_path, "rb") as handle:
        data = handle.read()
    content_type = mimetypes.guess_type(fs_path)[0] or "application/octet-stream"
    return _response_from_bytes("200 OK", [("content-type", content_type), ("x-edgeterm-fs-path", fs_path)], data)


def _response_from_bytes(status_text, headers, body_bytes):
    try:
        status_code = int(str(status_text).split(" ", 1)[0])
    except Exception:
        status_code = 500
    header_list = [(str(k).lower(), str(v)) for k, v in (headers or [])]
    response_headers = {}
    for key, value in header_list:
        if key in response_headers:
            if isinstance(response_headers[key], list):
                response_headers[key].append(value)
            else:
                response_headers[key] = [response_headers[key], value]
        else:
            response_headers[key] = value
    response_headers.setdefault("content-type", "text/html; charset=utf-8")
    content_type = str(response_headers.get("content-type", ""))
    is_text = _is_text_content_type(content_type)
    return {
        "status": status_code,
        "headers": response_headers,
        "headerList": header_list,
        "body": body_bytes.decode("utf-8", errors="replace") if is_text else "",
        "bodyBase64": "" if is_text else base64.b64encode(body_bytes).decode("ascii"),
    }


def _body_bytes(body):
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray):
        return bytes(body)
    return str(body).encode("utf-8")


def _is_text_content_type(content_type):
    value = str(content_type or "").lower()
    if not value:
        return True
    if value.startswith("text/"):
        return True
    return any(marker in value for marker in ("json", "xml", "javascript", "svg", "x-www-form-urlencoded"))


def _normalize_mode(mode):
    mode = str(mode or "wsgi").lower()
    aliases = {"flask": "wsgi", "django": "wsgi", "wsgi": "wsgi", "fastapi": "asgi", "starlette": "asgi", "asgi": "asgi", "static": "static"}
    if mode not in aliases:
        raise ValueError(f"Unsupported edgeserve mode: {mode}")
    return aliases[mode]


def _normalize_path(path):
    path_info = unquote(str(path or "/") or "/")
    if not path_info.startswith("/"):
        path_info = "/" + path_info
    return path_info


def _strip_mount_prefix(path, script_name):
    path_info = _normalize_path(path)
    mount = "" if script_name == "/" else _normalize_prefix(script_name or "")
    if mount and (path_info == mount or path_info.startswith(f"{mount}/")):
        path_info = path_info[len(mount) :] or "/"
    if not path_info.startswith("/"):
        path_info = "/" + path_info
    return path_info or "/"


def _normalize_prefix(prefix):
    value = str(prefix or "").strip()
    if not value:
        return ""
    if not value.startswith("/"):
        value = "/" + value
    return value.rstrip("/") or "/"


def _safe_instance_id(value):
    safe = "".join(ch for ch in str(value or "") if ch.isalnum() or ch in {"-", "_"})
    return safe or _make_instance_id("app")


def _make_instance_id(mode):
    return f"{int(time.time() * 1000):x}{len(_instances):02x}"[-10:]


def _reason_phrase(status):
    return {
        200: "OK",
        201: "Created",
        204: "No Content",
        301: "Moved Permanently",
        302: "Found",
        303: "See Other",
        307: "Temporary Redirect",
        308: "Permanent Redirect",
        400: "Bad Request",
        403: "Forbidden",
        404: "Not Found",
        500: "Internal Server Error",
    }.get(int(status or 500), "OK")
