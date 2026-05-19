from __future__ import annotations

import argparse
import os
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from flask import Flask, jsonify, render_template, request

from admin import bp as admin_bp
from auth import bp as auth_bp
from models import CloudStore, apply_expired_tiers, find_share_by_public_path
from shares import bp as shares_bp
from snapshots import bp as snapshots_bp


TTY_SESSIONS = {}
TTY_LOCK = threading.Lock()


def load_dotenv_file(*paths: Path):
    for path in paths:
        try:
            if not path or not path.exists():
                continue
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if not key or key in os.environ:
                    continue
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                    value = value[1:-1]
                os.environ[key] = value
        except Exception:
            continue


def tty_session(session_id):
    with TTY_LOCK:
        session = TTY_SESSIONS.get(session_id)
        if session is None:
            session = {"cond": threading.Condition(), "line": None, "closed": False, "updated": time.time()}
            TTY_SESSIONS[session_id] = session
        return session


def create_app(cloud_dir: str | Path = ".edgeterm-cloud", mysql_config: dict | None = None):
    backend_dir = Path(__file__).resolve().parent
    repo_root = backend_dir.parent
    load_dotenv_file(repo_root / ".env", backend_dir / ".env")
    if mysql_config is None:
        mysql_config = {
            "host": os.environ.get("EDGETERM_DB_HOST", ""),
            "port": int(os.environ.get("EDGETERM_DB_PORT", "3306")),
            "user": os.environ.get("EDGETERM_DB_USER", ""),
            "password": os.environ.get("EDGETERM_DB_PASSWORD", ""),
            "database": os.environ.get("EDGETERM_DB_NAME", "edgeterm"),
        }
    app = Flask(__name__, static_folder="static", template_folder="templates")
    store = CloudStore(Path(cloud_dir), mysql_config=mysql_config)
    app.extensions["edgeterm_store"] = store

    def bearer_token(db):
        auth = request.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth.split(" ", 1)[1].strip()
        cookie = request.cookies.get("edgeterm_session")
        return cookie or ""

    def current_user(db):
        changed = apply_expired_tiers(db)
        token = bearer_token(db)
        if not token:
            if changed:
                store.save_db(db)
            return None
        session = db["sessions"].get(token)
        if not session or session.get("expiresAt", 0) < int(time.time() * 1000):
            if changed:
                store.save_db(db)
            return None
        user = db["users"].get(session["userId"])
        if changed:
            store.save_db(db)
        return user

    def require_user(db):
        return current_user(db)

    app.extensions["edgeterm_current_token"] = bearer_token
    app.extensions["edgeterm_current_user"] = current_user
    app.extensions["edgeterm_require_user"] = require_user

    app.register_blueprint(auth_bp)
    app.register_blueprint(snapshots_bp)
    app.register_blueprint(shares_bp)
    app.register_blueprint(admin_bp)

    @app.after_request
    def add_headers(response):
        request_path = request.path or ""
        is_static_asset = request.endpoint == "static" or request_path.startswith("/static/")
        if is_static_asset:
            response.headers["Cache-Control"] = "public, max-age=120, must-revalidate"
            response.headers.pop("Pragma", None)
            response.headers.pop("Expires", None)
        else:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
        response.headers["Origin-Agent-Cluster"] = "?1"
        response.headers["Permissions-Policy"] = "cross-origin-isolated=(self)"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.get("/")
    @app.get("/index.html")
    def index():
        return render_template("index.html")

    @app.get("/app")
    @app.get("/app/")
    @app.get("/app/<path:route_path>")
    def local_app_page(route_path=""):
        return render_template("index.html")

    @app.get("/w/<workspace_slug>")
    @app.get("/w/<workspace_slug>/")
    @app.get("/w/<workspace_slug>/<path:route_path>")
    def local_named_app_page(workspace_slug, route_path=""):
        return render_template("index.html")

    @app.get("/admin")
    def admin_page():
        return render_template("admin.html")

    @app.get("/s/<share_id>")
    @app.get("/s/<share_id>/")
    @app.get("/s/<share_id>/<path:route_path>")
    def share_app_page(share_id, route_path=""):
        db = store.load_db()
        share = db["shares"].get(share_id)
        if not share or share.get("revoked"):
            return render_template("share.html"), 404
        return render_template("share.html")

    @app.get("/<owner>/<slug>")
    @app.get("/<owner>/<slug>/")
    def share_page(owner, slug):
        db = store.load_db()
        share = find_share_by_public_path(db, f"/{owner}/{slug}")
        if not share:
            return render_template("share.html"), 404
        return render_template("share.html")

    @app.get("/__edgeterm_tty_read")
    def tty_read():
        session_id = request.args.get("id", "")
        if not session_id:
            return jsonify({"error": "missing tty session id"}), 400
        session = tty_session(session_id)
        cond = session["cond"]
        with cond:
            deadline = time.time() + 3600
            while session["line"] is None and not session["closed"] and time.time() < deadline:
                cond.wait(timeout=30)
            if session["closed"]:
                return jsonify({"line": None})
            line = session["line"]
            session["line"] = None
            session["updated"] = time.time()
        return jsonify({"line": line})

    @app.post("/__edgeterm_tty_write")
    def tty_write():
        session_id = request.args.get("id", "")
        if not session_id:
            return jsonify({"error": "missing tty session id"}), 400
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {"line": request.get_data(as_text=True)}
        session = tty_session(session_id)
        cond = session["cond"]
        with cond:
            session["line"] = "" if payload.get("line") is None else str(payload.get("line", ""))
            session["updated"] = time.time()
            cond.notify_all()
        return jsonify({"ok": True})

    @app.delete("/__edgeterm_tty")
    def tty_delete():
        session_id = request.args.get("id", "")
        with TTY_LOCK:
            session = TTY_SESSIONS.pop(session_id, None)
        if session:
            cond = session["cond"]
            with cond:
                session["closed"] = True
                cond.notify_all()
        return jsonify({"ok": True})

    @app.post("/__edgeterm_http_proxy")
    def http_proxy():
        payload = request.get_json(silent=True) or {}
        target_url = str(payload.get("url", "")).strip()
        method = str(payload.get("method", "GET")).upper()
        headers = payload.get("headers", {}) or {}
        body_b64 = payload.get("body_base64")
        if not target_url.startswith(("http://", "https://")):
            return jsonify({"error": "only absolute http/https URLs are supported"}), 400
        import base64

        body = base64.b64decode(body_b64) if body_b64 is not None else None
        req_headers = {str(k).strip(): str(v) for k, v in headers.items() if str(k).strip().lower() not in {"host", "content-length"}}
        upstream = Request(target_url, data=body, headers=req_headers, method=method)
        try:
            with urlopen(upstream, timeout=30) as resp:
                data = resp.read()
                return jsonify({"ok": True, "status": int(getattr(resp, "status", 200)), "reason": getattr(resp, "reason", ""), "headers": dict(resp.headers.items()), "body_base64": base64.b64encode(data).decode("ascii")})
        except HTTPError as exc:
            data = exc.read() if hasattr(exc, "read") else b""
            return jsonify({"ok": True, "status": int(getattr(exc, "code", 500)), "reason": str(getattr(exc, "reason", "")), "headers": dict(getattr(exc, "headers", {}).items()) if getattr(exc, "headers", None) else {}, "body_base64": base64.b64encode(data).decode("ascii")})
        except URLError as exc:
            return jsonify({"error": f"upstream network error: {exc}"}), 502
        except Exception as exc:
            return jsonify({"error": f"proxy failure: {exc}"}), 500

    return app


def main():
    parser = argparse.ArgumentParser(description="Run EdgeTerm Cloud Edition with Flask.")
    parser.add_argument("--host", default=os.environ.get("EDGETERM_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("EDGETERM_PORT", "8081")))
    parser.add_argument("--cloud-dir", default=os.environ.get("EDGETERM_CLOUD_DIR", ".edgeterm-cloud"))
    parser.add_argument("--db-host", default=os.environ.get("EDGETERM_DB_HOST", ""))
    parser.add_argument("--db-port", type=int, default=int(os.environ.get("EDGETERM_DB_PORT", "3306")))
    parser.add_argument("--db-user", default=os.environ.get("EDGETERM_DB_USER", ""))
    parser.add_argument("--db-password", default=os.environ.get("EDGETERM_DB_PASSWORD", ""))
    parser.add_argument("--db-name", default=os.environ.get("EDGETERM_DB_NAME", "edgeterm"))
    args = parser.parse_args()
    mysql_config = None
    if args.db_host:
        mysql_config = {
            "host": args.db_host,
            "port": args.db_port,
            "user": args.db_user,
            "password": args.db_password,
            "database": args.db_name,
        }
    app = create_app(args.cloud_dir, mysql_config=mysql_config)
    backend_driver = getattr(app.extensions.get("edgeterm_store"), "driver", "unknown")
    print(f"Serving EdgeTerm Cloud Edition on http://{args.host}:{args.port}/ ({backend_driver})")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
