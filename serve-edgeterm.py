from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import threading
import time
import zipfile
from copy import deepcopy
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


TTY_SESSIONS = {}
TTY_LOCK = threading.Lock()
CLOUD_LOCK = threading.RLock()
CLOUD_ROOT = None
CLOUD_DB_PATH = None
CLOUD_BLOB_DIR = None
ADMIN_GATE_USER = None
ADMIN_GATE_PASSWORD_HASH = None
SECURE_COOKIES = False

TIERS = {
    "free": {
        "storageQuota": 100 * 1024 * 1024,
        "maxSnapshots": 5,
        "autoSyncEnabled": False,
        "minimumAutoSyncMinutes": 0,
        "sharePermissions": ["private"],
        "maxShareLinks": 2,
        "defaultExpirationSeconds": 7 * 24 * 3600,
        "appModeAllowed": True,
        "keepLastBackups": 5,
        "isDefault": True,
    },
    "plus": {
        "storageQuota": 1024 * 1024 * 1024,
        "maxSnapshots": 25,
        "autoSyncEnabled": True,
        "minimumAutoSyncMinutes": 5,
        "sharePermissions": ["private", "restricted", "public"],
        "maxShareLinks": 20,
        "defaultExpirationSeconds": 30 * 24 * 3600,
        "appModeAllowed": True,
        "keepLastBackups": 10,
        "isDefault": False,
    },
    "pro": {
        "storageQuota": 10 * 1024 * 1024 * 1024,
        "maxSnapshots": 100,
        "autoSyncEnabled": True,
        "minimumAutoSyncMinutes": 1,
        "sharePermissions": ["private", "restricted", "public"],
        "maxShareLinks": 100,
        "defaultExpirationSeconds": 90 * 24 * 3600,
        "appModeAllowed": True,
        "keepLastBackups": 25,
        "isDefault": False,
    },
    "custom": {
        "storageQuota": 1024 * 1024 * 1024,
        "maxSnapshots": 25,
        "autoSyncEnabled": True,
        "minimumAutoSyncMinutes": 5,
        "sharePermissions": ["private", "restricted", "public"],
        "maxShareLinks": 20,
        "defaultExpirationSeconds": 30 * 24 * 3600,
        "appModeAllowed": True,
        "keepLastBackups": 10,
        "isDefault": False,
    },
}


def utc_ms():
    return int(time.time() * 1000)


def default_tiers():
    return deepcopy(TIERS)


def tiers_for(db=None):
    if db and isinstance(db.get("tiers"), dict):
        merged = default_tiers()
        for key, value in db["tiers"].items():
            if isinstance(value, dict):
                merged[key] = {**merged.get(key, {}), **value}
        return merged
    return TIERS


def merged_permissions(user, context=None):
    settings = context.get("settings", context) if isinstance(context, dict) else None
    tier_catalog = tiers_for(context if isinstance(context, dict) and "tiers" in context else None)
    base = dict(tier_catalog.get(user.get("tier", "free"), tier_catalog.get("free", TIERS["free"])))
    overrides = user.get("overrides", {}) or {}
    base.update(overrides)
    if settings is not None:
        if not settings.get("sharingEnabled", True):
            base["sharingEnabled"] = False
        else:
            base.setdefault("sharingEnabled", True)
        if not settings.get("appModeEnabled", True):
            base["appModeAllowed"] = False
    base.setdefault("sharingEnabled", True)
    base.setdefault("appModeAllowed", True)
    base.setdefault("autoSyncEnabled", False)
    base.setdefault("minimumAutoSyncMinutes", 0)
    base.setdefault("sharePermissions", ["private"])
    base.setdefault("keepLastBackups", int(base.get("maxSnapshots", 5)))
    return base


def tty_session(session_id):
    with TTY_LOCK:
        session = TTY_SESSIONS.get(session_id)
        if session is None:
            session = {"cond": threading.Condition(), "line": None, "closed": False, "updated": time.time()}
            TTY_SESSIONS[session_id] = session
        return session


def init_cloud(root):
    global CLOUD_ROOT, CLOUD_DB_PATH, CLOUD_BLOB_DIR
    CLOUD_ROOT = Path(root).resolve()
    CLOUD_DB_PATH = CLOUD_ROOT / "db.json"
    CLOUD_BLOB_DIR = CLOUD_ROOT / "blobs"
    CLOUD_BLOB_DIR.mkdir(parents=True, exist_ok=True)
    if not CLOUD_DB_PATH.exists():
        save_db(
            {
                "users": {},
                "sessions": {},
                "snapshots": {},
                "shares": {},
                "tiers": default_tiers(),
                "settings": {"sharingEnabled": True, "appModeEnabled": True, "cloudNoticeHtml": ""},
            }
        )


def load_db():
    with CLOUD_LOCK:
        with CLOUD_DB_PATH.open("r", encoding="utf-8") as fh:
            db = json.load(fh)
        db.setdefault("users", {})
        db.setdefault("sessions", {})
        db.setdefault("snapshots", {})
        db.setdefault("shares", {})
        db.setdefault("tiers", default_tiers())
        db.setdefault("settings", {"sharingEnabled": True, "appModeEnabled": True, "cloudNoticeHtml": ""})
        db["settings"].setdefault("cloudNoticeHtml", "")
        return db


def save_db(db):
    with CLOUD_LOCK:
        tmp = CLOUD_DB_PATH.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(db, fh, indent=2, sort_keys=True)
        tmp.replace(CLOUD_DB_PATH)


def hash_password(password, salt=None, rounds=260000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), rounds)
    return f"pbkdf2_sha256${rounds}${salt}${digest.hex()}"


def verify_password(password, stored):
    try:
        algo, rounds, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hash_password(password, salt, int(rounds)).split("$", 3)[3]
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


def configure_admin_gate(username, password, secure_cookies=False):
    global ADMIN_GATE_USER, ADMIN_GATE_PASSWORD_HASH, SECURE_COOKIES
    ADMIN_GATE_USER = username
    ADMIN_GATE_PASSWORD_HASH = hash_password(password) if password else None
    SECURE_COOKIES = bool(secure_cookies)


def public_user(user, settings=None):
    merged = merged_permissions(user, settings)
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user.get("name", user["email"]),
        "role": user.get("role", "user"),
        "tier": user.get("tier", "free"),
        "emailVerified": bool(user.get("emailVerified", False)),
        "permissions": merged,
        "storageUsed": user.get("storageUsed", 0),
        "createdAt": user.get("createdAt"),
    }


def admin_user_payload(user, settings=None):
    payload = public_user(user, settings)
    payload["overrides"] = user.get("overrides", {}) or {}
    return payload


def make_user(email, password, role="user", tier="free", name=""):
    return {
        "id": secrets.token_urlsafe(12),
        "email": email.lower().strip(),
        "name": name.strip() or email.split("@", 1)[0],
        "passwordHash": hash_password(password),
        "role": role,
        "tier": tier or "free",
        "overrides": {},
        "emailVerified": False,
        "createdAt": utc_ms(),
        "storageUsed": 0,
    }


def normalize_snapshot(snapshot):
    if "version" not in snapshot:
        snapshot["version"] = 1
    snapshot.setdefault("updatedAt", snapshot.get("createdAt"))
    return snapshot


def clean_tier_payload(data):
    tier = {}
    int_fields = {
        "storageQuota": 100 * 1024 * 1024,
        "maxSnapshots": 5,
        "maxShareLinks": 2,
        "defaultExpirationSeconds": 7 * 24 * 3600,
        "keepLastBackups": 5,
        "minimumAutoSyncMinutes": 0,
    }
    for key, fallback in int_fields.items():
        try:
            tier[key] = max(0, int(data.get(key, fallback)))
        except Exception:
            tier[key] = fallback
    tier["autoSyncEnabled"] = bool(data.get("autoSyncEnabled", False))
    tier["appModeAllowed"] = bool(data.get("appModeAllowed", True))
    tier["isDefault"] = bool(data.get("isDefault", False))
    visibility = data.get("sharePermissions", ["private"])
    if isinstance(visibility, str):
        visibility = [part.strip() for part in visibility.split(",")]
    allowed = [item for item in visibility if item in {"private", "restricted", "public"}]
    tier["sharePermissions"] = allowed or ["private"]
    return tier


def slugify(value):
    value = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value).strip())
    parts = [part for part in value.split("-") if part]
    return "-".join(parts)[:64]


def user_handle(user):
    return slugify(user.get("name") or user.get("email", "").split("@", 1)[0] or "user") or "user"


def share_public_path(db, share):
    owner = db["users"].get(share.get("ownerId", ""))
    owner_slug = user_handle(owner or {})
    share_slug = share.get("customSlug") or share.get("id")
    return f"/{owner_slug}/{share_slug}"


def find_share_by_public_path(db, path):
    normalized = "/" + "/".join(part for part in path.strip("/").split("/") if part)
    if normalized.count("/") != 2:
        return None
    for share in db["shares"].values():
        if share_public_path(db, share) == normalized:
            return share
    return None


def default_signup_tier(db):
    tier_catalog = tiers_for(db)
    for tier_id, tier in tier_catalog.items():
        if tier.get("isDefault"):
            return tier_id
    return "free"


def can_view_share(share, viewer):
    if share["visibility"] == "public":
        return True, None
    if share["visibility"] == "private":
        return (viewer is not None), "login required"
    if share["visibility"] == "restricted":
        allowed = set(share.get("allowedUsers", []))
        if not viewer:
            return False, "login required"
        if viewer["email"] not in allowed:
            return False, "not allowed"
    return True, None


def recompute_user_storage(db, user_id):
    total = sum(s.get("size", 0) for s in db["snapshots"].values() if s.get("userId") == user_id)
    if user_id in db["users"]:
        db["users"][user_id]["storageUsed"] = total
    return total


def prune_user_snapshots(db, user_id, keep_last):
    if keep_last is None:
        return []
    keep = int(keep_last)
    if keep <= 0:
        return []
    snapshots = [s for s in db["snapshots"].values() if s.get("userId") == user_id]
    snapshots.sort(key=lambda s: s.get("createdAt", 0), reverse=True)
    removed = []
    for snapshot in snapshots[keep:]:
        snapshot_id = snapshot["id"]
        db["snapshots"].pop(snapshot_id, None)
        (CLOUD_BLOB_DIR / f"{snapshot_id}.zip").unlink(missing_ok=True)
        for share_id, share in list(db["shares"].items()):
            if share.get("snapshotId") == snapshot_id:
                del db["shares"][share_id]
        removed.append(snapshot_id)
    recompute_user_storage(db, user_id)
    return removed


def validate_snapshot_zip(path, max_size):
    size = path.stat().st_size
    if size <= 0 or size > max_size:
        raise ValueError("snapshot is empty or exceeds the upload limit")
    try:
        with zipfile.ZipFile(path) as archive:
            names = [name.replace("\\", "/").lstrip("/") for name in archive.namelist()]
            if any(".." in name.split("/") for name in names):
                raise ValueError("snapshot contains unsafe paths")
            has_rootfs = any(name.startswith("rootfs/") or "/rootfs/" in name for name in names)
            has_home = any(name.startswith("home/") or "/home/" in name for name in names)
            has_overlay = any(name.startswith("overlay/") or "/overlay/" in name for name in names)
            if not has_rootfs or not (has_home or has_overlay):
                raise ValueError("snapshot must contain rootfs plus home or overlay data")
    except zipfile.BadZipFile:
        raise ValueError("snapshot must be a valid zip archive")


class EdgeTermHandler(SimpleHTTPRequestHandler):
    server_version = "EdgeTermCloud/1.0"

    def admin_gate_authorized(self):
        if not ADMIN_GATE_PASSWORD_HASH:
            return False
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("basic "):
            return False
        try:
            raw = base64.b64decode(auth.split(" ", 1)[1]).decode("utf-8")
            username, _, password = raw.partition(":")
        except Exception:
            return False
        return hmac.compare_digest(username, ADMIN_GATE_USER or "") and verify_password(password, ADMIN_GATE_PASSWORD_HASH)

    def require_admin_gate(self):
        if self.admin_gate_authorized():
            return True
        body = b"EdgeTerm admin access requires HTTP Basic authentication.\n"
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="EdgeTerm Admin", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/admin":
            self.path = "/index.html"
            return super().do_GET()
        if parsed.path in {"/app", "/app/"} or parsed.path.startswith("/app/"):
            self.path = "/index.html"
            return super().do_GET()
        if parsed.path.startswith("/w/"):
            self.path = "/index.html"
            return super().do_GET()
        if parsed.path not in {"/", "/index.html"}:
            try:
                db = load_db()
                share = find_share_by_public_path(db, parsed.path)
                if share:
                    self.path = "/index.html"
                    return super().do_GET()
            except Exception:
                pass
        if parsed.path == "/__edgeterm_tty_read":
            self.handle_tty_read(parsed)
            return
        if parsed.path.startswith("/api/"):
            self.handle_api("GET", parsed)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/__edgeterm_tty_write":
            self.handle_tty_write(parsed)
            return
        if parsed.path == "/__edgeterm_http_proxy":
            self.handle_http_proxy()
            return
        if parsed.path.startswith("/api/"):
            self.handle_api("POST", parsed)
            return
        super().do_POST()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/__edgeterm_tty":
            self.handle_tty_delete(parsed)
            return
        if parsed.path.startswith("/api/"):
            self.handle_api("DELETE", parsed)
            return
        super().do_DELETE()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            return json.loads(raw or "{}")
        except json.JSONDecodeError:
            raise ValueError("invalid json payload")

    def send_file(self, path, filename):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def bearer_token(self):
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth.split(" ", 1)[1].strip()
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            key, _, value = part.strip().partition("=")
            if key == "edgeterm_session":
                return value
        return ""

    def current_user(self, db):
        token = self.bearer_token()
        if not token:
            return None, None
        session = db["sessions"].get(token)
        if not session or session.get("expiresAt", 0) < utc_ms():
            return None, None
        user = db["users"].get(session["userId"])
        return user, token

    def require_user(self, db):
        user, token = self.current_user(db)
        if not user:
            self.send_json(401, {"error": "login required"})
            return None, None
        return user, token

    def require_admin(self, db):
        user, token = self.require_user(db)
        if not user:
            return None, None
        if user.get("role") != "admin":
            self.send_json(403, {"error": "admin required"})
            return None, None
        return user, token

    def handle_api(self, method, parsed):
        try:
            path = parsed.path
            db = load_db()
            if method == "POST" and path == "/api/register":
                data = self.read_json()
                email = str(data.get("email", "")).lower().strip()
                password = str(data.get("password", ""))
                if "@" not in email or len(password) < 8:
                    return self.send_json(400, {"error": "valid email and 8+ character password required"})
                if any(u["email"] == email for u in db["users"].values()):
                    return self.send_json(409, {"error": "email already registered"})
                is_first = not db["users"]
                user = make_user(email, password, "admin" if is_first else "user", "pro" if is_first else default_signup_tier(db), str(data.get("name", "")))
                db["users"][user["id"]] = user
                token = self.create_session(db, user["id"])
                save_db(db)
                return self.send_json(201, {"token": token, "user": public_user(user, db)})

            if method == "POST" and path == "/api/login":
                data = self.read_json()
                email = str(data.get("email", "")).lower().strip()
                password = str(data.get("password", ""))
                user = next((u for u in db["users"].values() if u["email"] == email), None)
                if not user or not verify_password(password, user.get("passwordHash", "")):
                    return self.send_json(401, {"error": "invalid email or password"})
                token = self.create_session(db, user["id"])
                save_db(db)
                return self.send_json(200, {"token": token, "user": public_user(user, db)})

            if method == "POST" and path == "/api/logout":
                user, token = self.current_user(db)
                if token:
                    db["sessions"].pop(token, None)
                    save_db(db)
                return self.send_json(200, {"ok": True})

            if method == "GET" and path == "/api/me":
                user, _ = self.current_user(db)
                return self.send_json(200, {"user": public_user(user, db) if user else None, "settings": db["settings"], "tiers": tiers_for(db), "backend": {"driver": "json-file", "cloudRoot": str(CLOUD_ROOT)}})

            if path.startswith("/api/snapshot"):
                return self.handle_snapshot_api(method, parsed, db)
            if path.startswith("/api/share"):
                return self.handle_share_api(method, parsed, db)
            if path.startswith("/api/admin"):
                return self.handle_admin_api(method, parsed, db)
            return self.send_json(404, {"error": "unknown api route"})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            return self.send_json(500, {"error": f"server error: {exc}"})

    def create_session(self, db, user_id):
        token = secrets.token_urlsafe(32)
        db["sessions"][token] = {"userId": user_id, "createdAt": utc_ms(), "expiresAt": utc_ms() + 30 * 24 * 3600 * 1000}
        return token

    def handle_snapshot_api(self, method, parsed, db):
        user, _ = self.require_user(db)
        if not user:
            return
        perms = merged_permissions(user, db)
        if method == "GET" and parsed.path == "/api/snapshot/list":
            items = [normalize_snapshot(s) for s in db["snapshots"].values() if s["userId"] == user["id"]]
            items.sort(key=lambda s: s["createdAt"], reverse=True)
            return self.send_json(200, {"snapshots": items, "storageUsed": recompute_user_storage(db, user["id"]), "quota": perms["storageQuota"]})
        if method == "POST" and parsed.path == "/api/snapshot/upload":
            current = recompute_user_storage(db, user["id"])
            user_snapshots = [s for s in db["snapshots"].values() if s["userId"] == user["id"]]
            if len(user_snapshots) >= int(perms["maxSnapshots"]):
                return self.send_json(403, {"error": "snapshot limit exceeded"})
            length = int(self.headers.get("Content-Length", "0") or "0")
            if current + length > int(perms["storageQuota"]):
                return self.send_json(403, {"error": "storage quota exceeded", "storageUsed": current, "quota": perms["storageQuota"]})
            snapshot_id = secrets.token_urlsafe(12)
            blob_path = CLOUD_BLOB_DIR / f"{snapshot_id}.zip"
            with blob_path.open("wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    fh.write(chunk)
            try:
                validate_snapshot_zip(blob_path, int(perms["storageQuota"]))
            except ValueError:
                blob_path.unlink(missing_ok=True)
                raise
            query = parse_qs(parsed.query)
            name = self.headers.get("X-EdgeTerm-Name") or query.get("name", ["Workspace Backup"])[0]
            workspace_id = self.headers.get("X-EdgeTerm-Workspace") or query.get("workspaceId", [""])[0]
            is_app = self.headers.get("X-EdgeTerm-App-Mode", "false").lower() == "true"
            snapshot = {
                "id": snapshot_id,
                "userId": user["id"],
                "name": name[:120],
                "workspaceId": workspace_id[:120],
                "size": blob_path.stat().st_size,
                "createdAt": utc_ms(),
                "updatedAt": utc_ms(),
                "version": 1,
                "format": "zip",
                "appMode": is_app,
            }
            db["snapshots"][snapshot_id] = snapshot
            recompute_user_storage(db, user["id"])
            requested_keep = self.headers.get("X-EdgeTerm-Keep-Last-Backups") or query.get("keepLastBackups", [""])[0]
            keep_last = perms.get("keepLastBackups")
            if str(requested_keep).strip():
                keep_last = min(max(0, int(requested_keep)), int(perms.get("maxSnapshots", keep_last)))
            pruned = prune_user_snapshots(db, user["id"], keep_last)
            save_db(db)
            return self.send_json(201, {"snapshot": snapshot, "storageUsed": db["users"][user["id"]]["storageUsed"], "quota": perms["storageQuota"], "prunedSnapshots": pruned})
        if method == "GET" and parsed.path.startswith("/api/snapshot/download/"):
            snapshot_id = parsed.path.rsplit("/", 1)[1]
            snapshot = db["snapshots"].get(snapshot_id)
            if not snapshot or snapshot["userId"] != user["id"]:
                return self.send_json(404, {"error": "snapshot not found"})
            normalize_snapshot(snapshot)
            return self.send_file(CLOUD_BLOB_DIR / f"{snapshot_id}.zip", f"{snapshot['name']}.workspace.zip")
        if method == "DELETE" and parsed.path.startswith("/api/snapshot/"):
            snapshot_id = parsed.path.rsplit("/", 1)[1]
            snapshot = db["snapshots"].get(snapshot_id)
            if not snapshot or snapshot["userId"] != user["id"]:
                return self.send_json(404, {"error": "snapshot not found"})
            del db["snapshots"][snapshot_id]
            (CLOUD_BLOB_DIR / f"{snapshot_id}.zip").unlink(missing_ok=True)
            for share_id, share in list(db["shares"].items()):
                if share["snapshotId"] == snapshot_id:
                    del db["shares"][share_id]
            recompute_user_storage(db, user["id"])
            save_db(db)
            return self.send_json(200, {"ok": True})
        return self.send_json(404, {"error": "unknown snapshot route"})

    def handle_share_api(self, method, parsed, db):
        if method == "GET" and parsed.path == "/api/share/list":
            user, _ = self.require_user(db)
            if not user:
                return
            shares = []
            for share in db["shares"].values():
                if share["ownerId"] != user["id"]:
                    continue
                share = dict(share)
                share["publicPath"] = share_public_path(db, share)
                shares.append(share)
            shares.sort(key=lambda s: s["createdAt"], reverse=True)
            return self.send_json(200, {"shares": shares})

        if method == "GET" and parsed.path == "/api/share/resolve":
            path = parse_qs(parsed.query).get("path", [""])[0]
            share = find_share_by_public_path(db, path)
            if not share or share.get("revoked"):
                return self.send_json(404, {"error": "share not found"})
            if share.get("expiresAt") and share["expiresAt"] < utc_ms():
                return self.send_json(410, {"error": "share expired"})
            snapshot = db["snapshots"].get(share["snapshotId"])
            owner = db["users"].get(share["ownerId"])
            if not snapshot or not owner:
                return self.send_json(404, {"error": "shared snapshot not found"})
            normalize_snapshot(snapshot)
            viewer, _ = self.current_user(db)
            allowed, reason = can_view_share(share, viewer)
            if not allowed:
                return self.send_json(401 if reason == "login required" else 403, {"error": reason})
            share_payload = dict(share)
            share_payload["publicPath"] = share_public_path(db, share)
            return self.send_json(200, {"share": share_payload, "snapshot": snapshot, "owner": public_user(owner, db)})

        if method == "GET" and parsed.path.startswith("/api/share/"):
            share_id = parsed.path.rsplit("/", 1)[1]
            share = db["shares"].get(share_id)
            if not share or share.get("revoked"):
                return self.send_json(404, {"error": "share not found"})
            if share.get("expiresAt") and share["expiresAt"] < utc_ms():
                return self.send_json(410, {"error": "share expired"})
            snapshot = db["snapshots"].get(share["snapshotId"])
            owner = db["users"].get(share["ownerId"])
            if not snapshot or not owner:
                return self.send_json(404, {"error": "shared snapshot not found"})
            normalize_snapshot(snapshot)
            viewer, _ = self.current_user(db)
            allowed, reason = can_view_share(share, viewer)
            if not allowed:
                return self.send_json(401 if reason == "login required" else 403, {"error": reason})
            query = parse_qs(parsed.query)
            if query.get("download", ["0"])[0] == "1":
                return self.send_file(CLOUD_BLOB_DIR / f"{snapshot['id']}.zip", f"{snapshot['name']}.workspace.zip")
            share_payload = dict(share)
            share_payload["publicPath"] = share_public_path(db, share)
            return self.send_json(200, {"share": share_payload, "snapshot": snapshot, "owner": public_user(owner, db)})

        user, _ = self.require_user(db)
        if not user:
            return
        if method == "POST" and parsed.path == "/api/share/create":
            if not db["settings"].get("sharingEnabled", True):
                return self.send_json(403, {"error": "sharing is disabled"})
            data = self.read_json()
            snapshot = db["snapshots"].get(str(data.get("snapshotId", "")))
            if not snapshot or snapshot["userId"] != user["id"]:
                return self.send_json(404, {"error": "snapshot not found"})
            perms = merged_permissions(user, db)
            if not perms.get("sharingEnabled", True):
                return self.send_json(403, {"error": "sharing is disabled for this user"})
            existing = [s for s in db["shares"].values() if s["ownerId"] == user["id"] and not s.get("revoked")]
            if len(existing) >= int(perms["maxShareLinks"]):
                return self.send_json(403, {"error": "share link limit exceeded"})
            visibility = str(data.get("visibility", "private"))
            if visibility not in perms["sharePermissions"]:
                return self.send_json(403, {"error": "tier does not allow this share visibility"})
            app_mode = bool(data.get("appMode", snapshot.get("appMode", False)))
            if app_mode and not (db["settings"].get("appModeEnabled", True) and perms.get("appModeAllowed", True)):
                return self.send_json(403, {"error": "app mode sharing is disabled"})
            share_id = secrets.token_urlsafe(10)
            expires_in = int(data.get("expiresInSeconds") or perms["defaultExpirationSeconds"])
            share = {
                "id": share_id,
                "ownerId": user["id"],
                "snapshotId": snapshot["id"],
                "customSlug": slugify(data.get("customSlug", "")),
                "visibility": visibility,
                "mode": "read-write" if data.get("readWrite") else "read-only",
                "tempMode": bool(data.get("tempMode", False)),
                "allowFork": bool(data.get("allowFork", True)),
                "allowCloudWriteBack": bool(data.get("allowCloudWriteBack", False)),
                "allowedUsers": [str(x).lower() for x in data.get("allowedUsers", []) if str(x).strip()],
                "appMode": app_mode,
                "createdAt": utc_ms(),
                "expiresAt": utc_ms() + expires_in * 1000 if expires_in > 0 else None,
                "revoked": False,
            }
            if share["customSlug"]:
                desired = share_public_path(db, share)
                for existing in db["shares"].values():
                    if existing.get("id") != share_id and share_public_path(db, existing) == desired:
                        return self.send_json(409, {"error": "custom share url already in use"})
            db["shares"][share_id] = share
            save_db(db)
            share_payload = dict(share)
            share_payload["publicPath"] = share_public_path(db, share)
            return self.send_json(201, {"share": share_payload, "url": share_payload["publicPath"] if share.get("customSlug") else f"/?share={share_id}"})
        if method == "POST" and parsed.path.startswith("/api/share/update/"):
            share_id = parsed.path.rsplit("/", 1)[1]
            share = db["shares"].get(share_id)
            if not share or share["ownerId"] != user["id"]:
                return self.send_json(404, {"error": "share not found"})
            data = self.read_json()
            perms = merged_permissions(user, db)
            if "visibility" in data:
                visibility = str(data["visibility"])
                if visibility not in perms["sharePermissions"]:
                    return self.send_json(403, {"error": "tier does not allow this share visibility"})
                share["visibility"] = visibility
            if "expiresInSeconds" in data:
                expires_in = int(data.get("expiresInSeconds") or 0)
                share["expiresAt"] = utc_ms() + expires_in * 1000 if expires_in > 0 else None
            if "allowedUsers" in data:
                share["allowedUsers"] = [str(x).lower() for x in data.get("allowedUsers", []) if str(x).strip()]
            if "customSlug" in data:
                share["customSlug"] = slugify(data.get("customSlug", ""))
                if share["customSlug"]:
                    desired = share_public_path(db, share)
                    for existing in db["shares"].values():
                        if existing.get("id") != share_id and share_public_path(db, existing) == desired:
                            return self.send_json(409, {"error": "custom share url already in use"})
            for key in ("allowFork", "allowCloudWriteBack", "revoked", "tempMode"):
                if key in data:
                    share[key] = bool(data[key])
            if "readWrite" in data:
                share["mode"] = "read-write" if data.get("readWrite") else "read-only"
            if "appMode" in data:
                share["appMode"] = bool(data["appMode"])
            save_db(db)
            share_payload = dict(share)
            share_payload["publicPath"] = share_public_path(db, share)
            return self.send_json(200, {"share": share_payload})
        if method == "POST" and parsed.path.startswith("/api/share/revoke"):
            share_id = parsed.path.rsplit("/", 1)[-1]
            if share_id == "revoke":
                share_id = str(self.read_json().get("id", ""))
            share = db["shares"].get(share_id)
            if not share or share["ownerId"] != user["id"]:
                return self.send_json(404, {"error": "share not found"})
            share["revoked"] = True
            save_db(db)
            return self.send_json(200, {"ok": True})
        if method == "POST" and parsed.path.startswith("/api/share/writeback/"):
            share_id = parsed.path.rsplit("/", 1)[1]
            share = db["shares"].get(share_id)
            if not share or share.get("revoked"):
                return self.send_json(404, {"error": "share not found"})
            owner = db["users"].get(share["ownerId"])
            snapshot = db["snapshots"].get(share["snapshotId"])
            if not owner or not snapshot:
                return self.send_json(404, {"error": "shared snapshot not found"})
            allowed, reason = can_view_share(share, user)
            if not allowed:
                return self.send_json(401 if reason == "login required" else 403, {"error": reason})
            if share.get("mode") != "read-write" or not share.get("allowCloudWriteBack"):
                return self.send_json(403, {"error": "cloud write-back is not enabled for this share"})
            length = int(self.headers.get("Content-Length", "0") or "0")
            strategy = (self.headers.get("X-EdgeTerm-Conflict-Strategy") or parse_qs(parsed.query).get("strategy", ["overwrite"])[0]).strip().lower()
            base_version = int(self.headers.get("X-EdgeTerm-Base-Version", "0") or "0")
            if strategy not in {"overwrite", "fork"}:
                return self.send_json(400, {"error": "invalid conflict strategy"})
            owner_perms = merged_permissions(owner, db)
            if strategy == "fork":
                actor_perms = merged_permissions(user, db)
                actor_current = recompute_user_storage(db, user["id"])
                actor_snaps = [s for s in db["snapshots"].values() if s["userId"] == user["id"]]
                if len(actor_snaps) >= int(actor_perms["maxSnapshots"]):
                    return self.send_json(403, {"error": "snapshot limit exceeded for fork"})
                if actor_current + length > int(actor_perms["storageQuota"]):
                    return self.send_json(403, {"error": "storage quota exceeded for fork", "storageUsed": actor_current, "quota": actor_perms["storageQuota"]})
            else:
                normalize_snapshot(snapshot)
                if base_version and base_version != int(snapshot.get("version", 1)):
                    return self.send_json(409, {"error": "share has changed since this copy was opened", "currentVersion": snapshot.get("version", 1)})
                owner_current = recompute_user_storage(db, owner["id"])
                projected = owner_current - int(snapshot.get("size", 0)) + length
                if projected > int(owner_perms["storageQuota"]):
                    return self.send_json(403, {"error": "owner storage quota exceeded", "storageUsed": owner_current, "quota": owner_perms["storageQuota"]})

            temp_id = secrets.token_urlsafe(12)
            temp_path = CLOUD_BLOB_DIR / f"{temp_id}.zip"
            with temp_path.open("wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    fh.write(chunk)
            try:
                validate_snapshot_zip(temp_path, max(int(owner_perms["storageQuota"]), length))
                if strategy == "fork":
                    new_id = secrets.token_urlsafe(12)
                    final_path = CLOUD_BLOB_DIR / f"{new_id}.zip"
                    temp_path.replace(final_path)
                    new_snapshot = {
                        "id": new_id,
                        "userId": user["id"],
                        "name": f"{snapshot['name']} (Fork)",
                        "workspaceId": snapshot.get("workspaceId", ""),
                        "size": final_path.stat().st_size,
                        "createdAt": utc_ms(),
                        "updatedAt": utc_ms(),
                        "version": 1,
                        "format": "zip",
                        "appMode": bool(share.get("appMode", snapshot.get("appMode", False))),
                    }
                    db["snapshots"][new_id] = new_snapshot
                    recompute_user_storage(db, user["id"])
                    save_db(db)
                    return self.send_json(201, {"snapshot": new_snapshot, "mode": "fork"})

                final_path = CLOUD_BLOB_DIR / f"{snapshot['id']}.zip"
                temp_path.replace(final_path)
                snapshot["size"] = final_path.stat().st_size
                snapshot["updatedAt"] = utc_ms()
                snapshot["version"] = int(snapshot.get("version", 1)) + 1
                snapshot["appMode"] = bool(share.get("appMode", snapshot.get("appMode", False)))
                recompute_user_storage(db, owner["id"])
                save_db(db)
                return self.send_json(200, {"snapshot": snapshot, "mode": "overwrite"})
            except Exception:
                temp_path.unlink(missing_ok=True)
                raise
        return self.send_json(404, {"error": "unknown share route"})

    def handle_admin_api(self, method, parsed, db):
        admin, _ = self.require_admin(db)
        if not admin:
            return
        if method == "GET" and parsed.path == "/api/admin/users":
            return self.send_json(200, {"users": [admin_user_payload(u, db) for u in db["users"].values()]})
        if method == "POST" and parsed.path == "/api/admin/users":
            data = self.read_json()
            user = make_user(str(data.get("email", "")), str(data.get("password", secrets.token_urlsafe(9))), str(data.get("role", "user")), str(data.get("tier", "free")), str(data.get("name", "")))
            if "@" not in user["email"]:
                return self.send_json(400, {"error": "valid email required"})
            if any(existing["email"] == user["email"] for existing in db["users"].values()):
                return self.send_json(409, {"error": "email already registered"})
            if isinstance(data.get("overrides"), dict):
                user["overrides"] = data["overrides"]
            db["users"][user["id"]] = user
            save_db(db)
            return self.send_json(201, {"user": admin_user_payload(user, db)})
        if method == "DELETE" and parsed.path.startswith("/api/admin/users/"):
            user_id = parsed.path.rsplit("/", 1)[1]
            if user_id == admin["id"]:
                return self.send_json(400, {"error": "cannot delete current admin"})
            doomed = db["users"].pop(user_id, None)
            for token, session in list(db["sessions"].items()):
                if session.get("userId") == user_id:
                    del db["sessions"][token]
            for sid, snap in list(db["snapshots"].items()):
                if snap["userId"] == user_id:
                    (CLOUD_BLOB_DIR / f"{sid}.zip").unlink(missing_ok=True)
                    del db["snapshots"][sid]
            for share_id, share in list(db["shares"].items()):
                if share["ownerId"] == user_id:
                    del db["shares"][share_id]
                elif doomed and doomed["email"] in set(share.get("allowedUsers", [])):
                    share["allowedUsers"] = [email for email in share.get("allowedUsers", []) if email != doomed["email"]]
            save_db(db)
            return self.send_json(200, {"ok": True})
        if method == "POST" and parsed.path.startswith("/api/admin/users/"):
            user_id = parsed.path.rsplit("/", 1)[1]
            target = db["users"].get(user_id)
            if not target:
                return self.send_json(404, {"error": "user not found"})
            data = self.read_json()
            if "email" in data:
                email = str(data["email"]).strip().lower()
                if "@" not in email:
                    return self.send_json(400, {"error": "valid email required"})
                if any(existing["email"] == email and existing["id"] != user_id for existing in db["users"].values()):
                    return self.send_json(409, {"error": "email already registered"})
                target["email"] = email
            for key in ["role", "tier", "name"]:
                if key in data:
                    target[key] = data[key]
            if data.get("password"):
                target["passwordHash"] = hash_password(str(data["password"]))
            if isinstance(data.get("overrides"), dict):
                target["overrides"] = data["overrides"]
            save_db(db)
            return self.send_json(200, {"user": admin_user_payload(target, db)})
        if method == "GET" and parsed.path == "/api/admin/storage":
            total = 0
            per_user = []
            for user in db["users"].values():
                used = recompute_user_storage(db, user["id"])
                total += used
                per_user.append({"user": admin_user_payload(user, db), "storageUsed": used})
            save_db(db)
            return self.send_json(200, {"totalStorageUsed": total, "users": per_user})
        if method == "GET" and parsed.path == "/api/admin/shares":
            return self.send_json(200, {"shares": list(db["shares"].values())})
        if method == "GET" and parsed.path == "/api/admin/tiers":
            return self.send_json(200, {"tiers": tiers_for(db)})
        if method == "POST" and parsed.path == "/api/admin/tiers":
            data = self.read_json()
            tier_id = str(data.get("id", "")).strip().lower().replace(" ", "-")
            if not tier_id or not all(ch.isalnum() or ch in {"-", "_"} for ch in tier_id):
                return self.send_json(400, {"error": "valid tier id required"})
            db["tiers"][tier_id] = clean_tier_payload(data)
            if db["tiers"][tier_id].get("isDefault"):
                for existing_id, tier in db["tiers"].items():
                    if existing_id != tier_id:
                        tier["isDefault"] = False
            save_db(db)
            return self.send_json(200, {"tiers": tiers_for(db)})
        if method == "DELETE" and parsed.path.startswith("/api/admin/tiers/"):
            tier_id = parsed.path.rsplit("/", 1)[1]
            if tier_id in {"free", "plus", "pro"}:
                return self.send_json(400, {"error": "built-in tiers cannot be deleted"})
            if tier_id in db["tiers"]:
                del db["tiers"][tier_id]
            for user in db["users"].values():
                if user.get("tier") == tier_id:
                    user["tier"] = "free"
            save_db(db)
            return self.send_json(200, {"tiers": tiers_for(db)})
        if method == "POST" and parsed.path.startswith("/api/admin/shares/"):
            share_id = parsed.path.rsplit("/", 1)[1]
            share = db["shares"].get(share_id)
            if not share:
                return self.send_json(404, {"error": "share not found"})
            data = self.read_json()
            for key in ["visibility", "expiresAt", "revoked"]:
                if key in data:
                    share[key] = data[key]
            if "allowedUsers" in data:
                share["allowedUsers"] = [str(x).lower() for x in data.get("allowedUsers", []) if str(x).strip()]
            if "customSlug" in data:
                share["customSlug"] = slugify(data.get("customSlug", ""))
                if share["customSlug"]:
                    desired = share_public_path(db, share)
                    for existing in db["shares"].values():
                        if existing.get("id") != share_id and share_public_path(db, existing) == desired:
                            return self.send_json(409, {"error": "custom share url already in use"})
            if "mode" in data and data["mode"] in {"read-only", "read-write"}:
                share["mode"] = data["mode"]
            if "allowFork" in data:
                share["allowFork"] = bool(data["allowFork"])
            if "allowCloudWriteBack" in data:
                share["allowCloudWriteBack"] = bool(data["allowCloudWriteBack"])
            if "tempMode" in data:
                share["tempMode"] = bool(data["tempMode"])
            if "appMode" in data:
                share["appMode"] = bool(data["appMode"])
            save_db(db)
            share_payload = dict(share)
            share_payload["publicPath"] = share_public_path(db, share)
            return self.send_json(200, {"share": share_payload})
        if method == "POST" and parsed.path == "/api/admin/settings":
            data = self.read_json()
            db["settings"].update({k: bool(v) for k, v in data.items() if k in {"sharingEnabled", "appModeEnabled"}})
            if "cloudNoticeHtml" in data:
                db["settings"]["cloudNoticeHtml"] = str(data.get("cloudNoticeHtml", ""))[:50000]
            save_db(db)
            return self.send_json(200, {"settings": db["settings"]})
        return self.send_json(404, {"error": "unknown admin route"})

    def handle_tty_read(self, parsed):
        session_id = parse_qs(parsed.query).get("id", [""])[0]
        if not session_id:
            self.send_json(400, {"error": "missing tty session id"})
            return
        session = tty_session(session_id)
        cond = session["cond"]
        with cond:
            deadline = time.time() + 3600
            while session["line"] is None and not session["closed"] and time.time() < deadline:
                cond.wait(timeout=30)
            if session["closed"]:
                self.send_json(200, {"line": None})
                return
            line = session["line"]
            session["line"] = None
            session["updated"] = time.time()
        self.send_json(200, {"line": line})

    def handle_tty_write(self, parsed):
        session_id = parse_qs(parsed.query).get("id", [""])[0]
        if not session_id:
            self.send_json(400, {"error": "missing tty session id"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {"line": body}
        session = tty_session(session_id)
        cond = session["cond"]
        with cond:
            session["line"] = "" if payload.get("line") is None else str(payload.get("line", ""))
            session["updated"] = time.time()
            cond.notify_all()
        self.send_json(200, {"ok": True})

    def handle_tty_delete(self, parsed):
        session_id = parse_qs(parsed.query).get("id", [""])[0]
        with TTY_LOCK:
            session = TTY_SESSIONS.pop(session_id, None)
        if session:
            cond = session["cond"]
            with cond:
                session["closed"] = True
                cond.notify_all()
        self.send_json(200, {"ok": True})

    def handle_http_proxy(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid json payload"})
            return

        target_url = str(payload.get("url", "")).strip()
        method = str(payload.get("method", "GET")).upper()
        headers = payload.get("headers", {}) or {}
        body_b64 = payload.get("body_base64")
        parsed = urlparse(target_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            self.send_json(400, {"error": "only absolute http/https URLs are supported"})
            return
        body = base64.b64decode(body_b64) if body_b64 is not None else None
        req_headers = {str(k).strip(): str(v) for k, v in headers.items() if str(k).strip().lower() not in {"host", "content-length"}}
        request = Request(target_url, data=body, headers=req_headers, method=method)
        try:
            with urlopen(request, timeout=30) as resp:
                data = resp.read()
                self.send_json(200, {"ok": True, "status": int(getattr(resp, "status", 200)), "reason": getattr(resp, "reason", ""), "headers": dict(resp.headers.items()), "body_base64": base64.b64encode(data).decode("ascii")})
        except HTTPError as exc:
            data = exc.read() if hasattr(exc, "read") else b""
            self.send_json(200, {"ok": True, "status": int(getattr(exc, "code", 500)), "reason": str(getattr(exc, "reason", "")), "headers": dict(getattr(exc, "headers", {}).items()) if getattr(exc, "headers", None) else {}, "body_base64": base64.b64encode(data).decode("ascii")})
        except URLError as exc:
            self.send_json(502, {"error": f"upstream network error: {exc}"})
        except Exception as exc:
            self.send_json(500, {"error": f"proxy failure: {exc}"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Origin-Agent-Cluster", "?1")
        self.send_header("Permissions-Policy", "cross-origin-isolated=(self)")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        if SECURE_COOKIES:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description="Serve EdgeTerm with optional local cloud backend APIs.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--dir", default=".")
    parser.add_argument("--cloud-dir", default=".edgeterm-cloud")
    parser.add_argument("--admin-gate-user", default=os.environ.get("EDGETERM_ADMIN_GATE_USER", "admin"))
    parser.add_argument("--admin-gate-password", default=os.environ.get("EDGETERM_ADMIN_GATE_PASSWORD", ""))
    parser.add_argument("--secure-cookies", action="store_true", default=os.environ.get("EDGETERM_SECURE_COOKIES", "").lower() in {"1", "true", "yes"})
    args = parser.parse_args()

    os.chdir(args.dir)
    init_cloud(args.cloud_dir)
    configure_admin_gate(args.admin_gate_user, args.admin_gate_password, args.secure_cookies)
    server = ThreadingHTTPServer((args.host, args.port), EdgeTermHandler)
    print(f"Serving EdgeTerm on http://{args.host}:{args.port}/")
    print(f"Cloud backend storage: {CLOUD_ROOT}")
    print("/admin is protected by the EdgeTerm admin login session.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
