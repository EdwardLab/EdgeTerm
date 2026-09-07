import json
from dataclasses import dataclass, field
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit


@dataclass
class Request:
    method: str = "GET"
    path: str = "/"
    query_string: str = ""
    headers: dict = field(default_factory=dict)
    body: str = ""
    args: dict = field(default_factory=dict)
    form: dict = field(default_factory=dict)
    json: object = None


class EdgeTermApp:
    def __init__(self):
        self._routes = {}
        self._request = Request()

    def reset(self):
        self._routes.clear()
        self._request = Request()

    def route(self, path, methods=None):
        route_path = self._normalize_path(path)
        route_methods = tuple((methods or ["GET"]))

        def decorator(func):
            for method in route_methods:
                self._routes[(method.upper(), route_path)] = func
            return func

        return decorator

    def dispatch(self, path="/", method="GET", query_string="", headers=None, body=""):
        method = (method or "GET").upper()
        split = urlsplit(path or "/")
        route_path = self._normalize_path(split.path or "/")
        merged_query = "&".join(part for part in [split.query, query_string] if part)
        handler = self._routes.get((method, route_path))
        if handler is None:
            return {
                "status": 404,
                "headers": {"content-type": "text/html; charset=utf-8"},
                "body": f"<h1>404 Not Found</h1><p>No EdgeTerm app route for <code>{route_path}</code>.</p>",
            }

        current_request = Request(
            method=method,
            path=route_path,
            query_string=merged_query,
            headers={str(k).lower(): str(v) for k, v in (headers or {}).items()},
            body=body or "",
        )
        current_request.args = {key: values[-1] if len(values) == 1 else values for key, values in parse_qs(merged_query, keep_blank_values=True).items()}

        content_type = current_request.headers.get("content-type", "")
        if current_request.body and "application/json" in content_type:
            try:
                current_request.json = json.loads(current_request.body)
            except Exception:
                current_request.json = None
        elif current_request.body and "application/x-www-form-urlencoded" in content_type:
            current_request.form = {
                key: values[-1] if len(values) == 1 else values
                for key, values in parse_qs(current_request.body, keep_blank_values=True).items()
            }

        previous_request = self._request
        self._request = current_request
        _apply_request_state(current_request)
        try:
            result = handler()
            if hasattr(result, "__await__"):
                raise RuntimeError("Async EdgeTerm app route handlers are not supported yet.")
            return self._normalize_response(result)
        finally:
            self._request = previous_request

    @property
    def request(self):
        return self._request

    def _normalize_response(self, result):
        status = 200
        headers = {}
        body = result

        if isinstance(result, tuple):
            if len(result) == 2:
                body, status = result
            elif len(result) == 3:
                body, status, headers = result
            else:
                raise ValueError("Route return tuples must be (body, status) or (body, status, headers).")

        if isinstance(body, (dict, list)):
            return {
                "status": int(status),
                "headers": {"content-type": "application/json; charset=utf-8", **self._normalize_headers(headers)},
                "body": json.dumps(body),
            }

        if body is None:
            body = ""
        if not isinstance(body, str):
            body = str(body)
        normalized_headers = self._normalize_headers(headers)
        normalized_headers.setdefault("content-type", "text/html; charset=utf-8")
        return {"status": int(status), "headers": normalized_headers, "body": body}

    @staticmethod
    def _normalize_headers(headers):
        return {str(key).lower(): str(value) for key, value in (headers or {}).items()}

    @staticmethod
    def _normalize_path(path):
        cleaned = str(path or "/").strip() or "/"
        if not cleaned.startswith("/"):
            cleaned = "/" + cleaned
        return cleaned


app = EdgeTermApp()
request = SimpleNamespace()
_wsgi_app = None


def _apply_request_state(state):
    request.method = state.method
    request.path = state.path
    request.query_string = state.query_string
    request.headers = state.headers
    request.body = state.body
    request.args = state.args
    request.form = state.form
    request.json = state.json


def reset_app():
    global _wsgi_app
    _wsgi_app = None
    app.reset()
    _apply_request_state(app.request)


def set_wsgi_app(wsgi_app):
    global _wsgi_app
    _wsgi_app = wsgi_app


def dispatch_request(path="/", method="GET", query_string="", headers=None, body=""):
    if _wsgi_app is not None:
        import edgeterm_wsgi

        return edgeterm_wsgi.dispatch(
            _wsgi_app,
            path=path,
            method=method,
            query_string=query_string,
            headers=headers,
            body=body,
        )
    response = app.dispatch(path=path, method=method, query_string=query_string, headers=headers, body=body)
    return response
