from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
import zipfile
from copy import deepcopy
from pathlib import Path

try:
    import pymysql
except Exception:  # pragma: no cover - optional dependency in some environments
    pymysql = None


DEFAULT_TIERS = {
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
}

DEFAULT_TOS_HTML = """
<p>By creating an EdgeTerm Cloud account, you agree to use the service lawfully, keep your credentials secure, and avoid uploading or sharing harmful, illegal, or abusive content.</p>
<p>Cloud features store rootfs snapshots and metadata, but EdgeTerm does not execute your code on the server. You remain responsible for the data and applications you upload, share, or publish through your account.</p>
<p>Service availability, storage limits, and features may change over time. If you do not agree with these terms, please continue using the offline edition instead of registering for cloud access.</p>
""".strip()


def default_db_state():
    return {
        "users": {},
        "sessions": {},
        "snapshots": {},
        "shares": {},
        "tiers": default_tiers(),
        "settings": {"sharingEnabled": True, "appModeEnabled": True, "cloudNoticeHtml": "", "tosHtml": DEFAULT_TOS_HTML},
    }


def utc_ms():
    return int(time.time() * 1000)


def default_tiers():
    return deepcopy(DEFAULT_TIERS)


def hash_password(password: str, salt: str | None = None, rounds: int = 260000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), rounds)
    return f"pbkdf2_sha256${rounds}${salt}${digest.hex()}"


def verify_password(password: str, stored: str):
    try:
        algo, rounds, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hash_password(password, salt, int(rounds)).split("$", 3)[3]
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


class MySQLCloudStore:
    def __init__(self, root: str | Path, config: dict):
        if pymysql is None:
            raise RuntimeError("PyMySQL is required for MySQL storage")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.blob_dir = self.root / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.driver = "mysql"
        self.config = {
            "host": config.get("host"),
            "port": int(config.get("port") or 3306),
            "user": config.get("user"),
            "password": config.get("password"),
            "database": config.get("database"),
            "charset": "utf8mb4",
            "autocommit": False,
            "cursorclass": pymysql.cursors.Cursor,
        }
        self._ensure_schema()
        self._migrate_legacy_state_if_needed()

    def _admin_connection(self):
        params = {k: v for k, v in self.config.items() if k != "database"}
        return pymysql.connect(**params)

    def _connection(self):
        return pymysql.connect(**self.config)

    def _ensure_schema(self):
        with self._admin_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f"CREATE DATABASE IF NOT EXISTS `{self.config['database']}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        with self._connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                      id VARCHAR(64) PRIMARY KEY,
                      email VARCHAR(255) NOT NULL UNIQUE,
                      name VARCHAR(255) NOT NULL,
                      password_hash TEXT NOT NULL,
                      role VARCHAR(32) NOT NULL,
                      tier VARCHAR(64) NOT NULL,
                      overrides_json LONGTEXT NOT NULL,
                      email_verified TINYINT(1) NOT NULL DEFAULT 0,
                      created_at BIGINT NOT NULL,
                      storage_used BIGINT NOT NULL DEFAULT 0,
                      tier_expires_at BIGINT NULL,
                      tier_fallback VARCHAR(64) NULL,
                      accepted_tos_at BIGINT NULL
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                      token VARCHAR(128) PRIMARY KEY,
                      user_id VARCHAR(64) NOT NULL,
                      created_at BIGINT NOT NULL,
                      expires_at BIGINT NOT NULL,
                      INDEX idx_sessions_user (user_id),
                      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS snapshots (
                      id VARCHAR(64) PRIMARY KEY,
                      user_id VARCHAR(64) NOT NULL,
                      name VARCHAR(255) NOT NULL,
                      workspace_id VARCHAR(255) NOT NULL,
                      size BIGINT NOT NULL,
                      created_at BIGINT NOT NULL,
                      updated_at BIGINT NOT NULL,
                      version INT NOT NULL DEFAULT 1,
                      format VARCHAR(32) NOT NULL DEFAULT 'zip',
                      app_mode TINYINT(1) NOT NULL DEFAULT 0,
                      extra_json LONGTEXT NOT NULL,
                      INDEX idx_snapshots_user (user_id),
                      CONSTRAINT fk_snapshots_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS shares (
                      id VARCHAR(64) PRIMARY KEY,
                      snapshot_id VARCHAR(64) NOT NULL,
                      owner_id VARCHAR(64) NOT NULL,
                      visibility VARCHAR(32) NOT NULL,
                      mode VARCHAR(32) NOT NULL,
                      allow_fork TINYINT(1) NOT NULL DEFAULT 1,
                      allow_cloud_write_back TINYINT(1) NOT NULL DEFAULT 0,
                      app_mode TINYINT(1) NOT NULL DEFAULT 0,
                      temp_mode TINYINT(1) NOT NULL DEFAULT 0,
                      revoked TINYINT(1) NOT NULL DEFAULT 0,
                      custom_slug VARCHAR(255) NULL,
                      created_at BIGINT NOT NULL,
                      expires_at BIGINT NULL,
                      extra_json LONGTEXT NOT NULL,
                      INDEX idx_shares_owner (owner_id),
                      INDEX idx_shares_snapshot (snapshot_id),
                      CONSTRAINT fk_shares_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
                      CONSTRAINT fk_shares_snapshot FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS share_allowed_users (
                      share_id VARCHAR(64) NOT NULL,
                      email VARCHAR(255) NOT NULL,
                      PRIMARY KEY (share_id, email),
                      CONSTRAINT fk_share_allowed_users_share FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS tiers (
                      id VARCHAR(64) PRIMARY KEY,
                      data LONGTEXT NOT NULL
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS settings (
                      `key` VARCHAR(128) PRIMARY KEY,
                      value LONGTEXT NOT NULL
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS edgeterm_state (
                      id TINYINT PRIMARY KEY,
                      data LONGTEXT NOT NULL,
                      updated_at BIGINT NOT NULL
                    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                    """
                )
            conn.commit()

    def _table_count(self, table_name):
        with self._connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM {table_name}")
                row = cur.fetchone()
                return int(row[0] if row else 0)

    def _migrate_legacy_state_if_needed(self):
        has_normalized_data = any(self._table_count(name) > 0 for name in ("users", "sessions", "snapshots", "shares", "tiers", "settings"))
        if has_normalized_data:
            return
        initial_state = None
        with self._connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT data FROM edgeterm_state WHERE id = 1")
                row = cur.fetchone()
                if row and row[0]:
                    try:
                        initial_state = json.loads(row[0])
                    except Exception:
                        initial_state = None
        if initial_state is None:
            initial_state = default_db_state()
        self.save_db(initial_state)

    def load_db(self):
        with self._connection() as conn:
            with conn.cursor() as cur:
                db = default_db_state()
                cur.execute(
                    """
                    SELECT id, email, name, password_hash, role, tier, overrides_json, email_verified,
                           created_at, storage_used, tier_expires_at, tier_fallback, accepted_tos_at
                    FROM users
                    """
                )
                for row in cur.fetchall():
                    db["users"][row[0]] = {
                        "id": row[0],
                        "email": row[1],
                        "name": row[2],
                        "passwordHash": row[3],
                        "role": row[4],
                        "tier": row[5],
                        "overrides": json.loads(row[6] or "{}"),
                        "emailVerified": bool(row[7]),
                        "createdAt": int(row[8] or 0),
                        "storageUsed": int(row[9] or 0),
                        "tierExpiresAt": int(row[10]) if row[10] is not None else None,
                        "tierFallback": row[11],
                        "acceptedTosAt": int(row[12]) if row[12] is not None else None,
                    }
                cur.execute("SELECT token, user_id, created_at, expires_at FROM sessions")
                for row in cur.fetchall():
                    db["sessions"][row[0]] = {
                        "userId": row[1],
                        "createdAt": int(row[2] or 0),
                        "expiresAt": int(row[3] or 0),
                    }
                cur.execute(
                    """
                    SELECT id, user_id, name, workspace_id, size, created_at, updated_at, version, format, app_mode, extra_json
                    FROM snapshots
                    """
                )
                for row in cur.fetchall():
                    extra = json.loads(row[10] or "{}")
                    snapshot = {
                        "id": row[0],
                        "userId": row[1],
                        "name": row[2],
                        "workspaceId": row[3],
                        "size": int(row[4] or 0),
                        "createdAt": int(row[5] or 0),
                        "updatedAt": int(row[6] or 0),
                        "version": int(row[7] or 1),
                        "format": row[8] or "zip",
                        "appMode": bool(row[9]),
                    }
                    snapshot.update(extra)
                    db["snapshots"][snapshot["id"]] = snapshot
                cur.execute(
                    """
                    SELECT id, snapshot_id, owner_id, visibility, mode, allow_fork, allow_cloud_write_back,
                           app_mode, temp_mode, revoked, custom_slug, created_at, expires_at, extra_json
                    FROM shares
                    """
                )
                share_rows = cur.fetchall()
                allowed_map = {}
                cur.execute("SELECT share_id, email FROM share_allowed_users")
                for share_id, email in cur.fetchall():
                    allowed_map.setdefault(share_id, []).append(email)
                for row in share_rows:
                    extra = json.loads(row[13] or "{}")
                    share = {
                        "id": row[0],
                        "snapshotId": row[1],
                        "ownerId": row[2],
                        "visibility": row[3],
                        "mode": row[4],
                        "allowFork": bool(row[5]),
                        "allowCloudWriteBack": bool(row[6]),
                        "appMode": bool(row[7]),
                        "tempMode": bool(row[8]),
                        "revoked": bool(row[9]),
                        "customSlug": row[10] or "",
                        "createdAt": int(row[11] or 0),
                        "expiresAt": int(row[12]) if row[12] is not None else None,
                        "allowedUsers": allowed_map.get(row[0], []),
                    }
                    share.update(extra)
                    db["shares"][share["id"]] = share
                cur.execute("SELECT id, data FROM tiers")
                tier_rows = cur.fetchall()
                db["tiers"] = default_tiers()
                for tier_id, payload in tier_rows:
                    db["tiers"][tier_id] = {**db["tiers"].get(tier_id, {}), **json.loads(payload or "{}")}
                cur.execute("SELECT `key`, value FROM settings")
                setting_rows = cur.fetchall()
                for key, value in setting_rows:
                    try:
                        db["settings"][key] = json.loads(value)
                    except Exception:
                        db["settings"][key] = value
        db.setdefault("users", {})
        db.setdefault("sessions", {})
        db.setdefault("snapshots", {})
        db.setdefault("shares", {})
        db.setdefault("tiers", default_tiers())
        db.setdefault("settings", {"sharingEnabled": True, "appModeEnabled": True, "cloudNoticeHtml": "", "tosHtml": DEFAULT_TOS_HTML})
        db["settings"].setdefault("cloudNoticeHtml", "")
        db["settings"].setdefault("tosHtml", DEFAULT_TOS_HTML)
        return db

    def save_db(self, db):
        with self._connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM share_allowed_users")
                cur.execute("DELETE FROM shares")
                cur.execute("DELETE FROM snapshots")
                cur.execute("DELETE FROM sessions")
                cur.execute("DELETE FROM users")
                cur.execute("DELETE FROM tiers")
                cur.execute("DELETE FROM settings")

                for user in db.get("users", {}).values():
                    cur.execute(
                        """
                        INSERT INTO users (
                          id, email, name, password_hash, role, tier, overrides_json, email_verified,
                          created_at, storage_used, tier_expires_at, tier_fallback, accepted_tos_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            user.get("id"),
                            user.get("email"),
                            user.get("name") or user.get("email", "").split("@", 1)[0],
                            user.get("passwordHash", ""),
                            user.get("role", "user"),
                            user.get("tier", "free"),
                            json.dumps(user.get("overrides", {}) or {}, sort_keys=True),
                            1 if user.get("emailVerified") else 0,
                            int(user.get("createdAt") or 0),
                            int(user.get("storageUsed") or 0),
                            int(user["tierExpiresAt"]) if user.get("tierExpiresAt") is not None else None,
                            user.get("tierFallback"),
                            int(user["acceptedTosAt"]) if user.get("acceptedTosAt") is not None else None,
                        ),
                    )

                for token, session in db.get("sessions", {}).items():
                    cur.execute(
                        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
                        (token, session.get("userId"), int(session.get("createdAt") or 0), int(session.get("expiresAt") or 0)),
                    )

                snapshot_known = {"id", "userId", "name", "workspaceId", "size", "createdAt", "updatedAt", "version", "format", "appMode"}
                for snapshot in db.get("snapshots", {}).values():
                    extra = {k: v for k, v in snapshot.items() if k not in snapshot_known}
                    cur.execute(
                        """
                        INSERT INTO snapshots (
                          id, user_id, name, workspace_id, size, created_at, updated_at, version, format, app_mode, extra_json
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            snapshot.get("id"),
                            snapshot.get("userId"),
                            snapshot.get("name", "Workspace Backup"),
                            snapshot.get("workspaceId", ""),
                            int(snapshot.get("size") or 0),
                            int(snapshot.get("createdAt") or 0),
                            int(snapshot.get("updatedAt") or snapshot.get("createdAt") or 0),
                            int(snapshot.get("version") or 1),
                            snapshot.get("format", "zip"),
                            1 if snapshot.get("appMode") else 0,
                            json.dumps(extra, sort_keys=True),
                        ),
                    )

                share_known = {"id", "snapshotId", "ownerId", "visibility", "mode", "allowFork", "allowCloudWriteBack", "appMode", "tempMode", "revoked", "customSlug", "allowedUsers", "createdAt", "expiresAt"}
                for share in db.get("shares", {}).values():
                    extra = {k: v for k, v in share.items() if k not in share_known}
                    cur.execute(
                        """
                        INSERT INTO shares (
                          id, snapshot_id, owner_id, visibility, mode, allow_fork, allow_cloud_write_back,
                          app_mode, temp_mode, revoked, custom_slug, created_at, expires_at, extra_json
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            share.get("id"),
                            share.get("snapshotId"),
                            share.get("ownerId"),
                            share.get("visibility", "private"),
                            share.get("mode", "read-only"),
                            1 if share.get("allowFork", True) else 0,
                            1 if share.get("allowCloudWriteBack") else 0,
                            1 if share.get("appMode") else 0,
                            1 if share.get("tempMode") else 0,
                            1 if share.get("revoked") else 0,
                            share.get("customSlug") or None,
                            int(share.get("createdAt") or 0),
                            int(share["expiresAt"]) if share.get("expiresAt") is not None else None,
                            json.dumps(extra, sort_keys=True),
                        ),
                    )
                    for email in share.get("allowedUsers", []) or []:
                        cur.execute(
                            "INSERT INTO share_allowed_users (share_id, email) VALUES (%s, %s)",
                            (share.get("id"), str(email).lower()),
                        )

                for tier_id, tier in (db.get("tiers") or {}).items():
                    cur.execute("INSERT INTO tiers (id, data) VALUES (%s, %s)", (tier_id, json.dumps(tier, sort_keys=True)))

                for key, value in (db.get("settings") or {}).items():
                    cur.execute("INSERT INTO settings (`key`, value) VALUES (%s, %s)", (key, json.dumps(value)))

                cur.execute(
                    """
                    INSERT INTO edgeterm_state (id, data, updated_at)
                    VALUES (1, %s, %s)
                    ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)
                    """,
                    (json.dumps(db, indent=2, sort_keys=True), utc_ms()),
                )
            conn.commit()


class CloudStore:
    def __new__(cls, root: str | Path, mysql_config: dict | None = None):
        config = mysql_config or {}
        host = str(config.get("host") or os.environ.get("EDGETERM_DB_HOST") or "").strip()
        merged = {
            "host": host,
            "port": int(config.get("port") or os.environ.get("EDGETERM_DB_PORT") or 3306),
            "user": config.get("user") or os.environ.get("EDGETERM_DB_USER"),
            "password": config.get("password") or os.environ.get("EDGETERM_DB_PASSWORD"),
            "database": config.get("database") or os.environ.get("EDGETERM_DB_NAME") or "edgeterm",
        }
        if not merged["host"]:
            raise RuntimeError("Cloud Edition requires MySQL. Set EDGETERM_DB_HOST or pass --db-host.")
        if not merged["user"] or merged["password"] is None:
            raise RuntimeError("Cloud Edition MySQL storage requires EDGETERM_DB_USER and EDGETERM_DB_PASSWORD.")
        return MySQLCloudStore(root, merged)


def tiers_for(db=None):
    if db and isinstance(db.get("tiers"), dict):
        merged = default_tiers()
        for key, value in db["tiers"].items():
            if isinstance(value, dict):
                merged[key] = {**merged.get(key, {}), **value}
        return merged
    return default_tiers()


def merged_permissions(user, db):
    catalog = tiers_for(db)
    base = dict(catalog.get(user.get("tier", "free"), catalog["free"]))
    base.update(user.get("overrides", {}) or {})
    settings = db.get("settings", {})
    if not settings.get("sharingEnabled", True):
        base["sharingEnabled"] = False
    else:
        base.setdefault("sharingEnabled", True)
    if not settings.get("appModeEnabled", True):
        base["appModeAllowed"] = False
    base.setdefault("autoSyncEnabled", False)
    base.setdefault("minimumAutoSyncMinutes", 0)
    base.setdefault("sharePermissions", ["private"])
    base.setdefault("keepLastBackups", int(base.get("maxSnapshots", 5)))
    return base


def public_user(user, db):
    permissions = merged_permissions(user, db)
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user.get("name", user["email"]),
        "role": user.get("role", "user"),
        "tier": user.get("tier", "free"),
        "emailVerified": bool(user.get("emailVerified", False)),
        "permissions": permissions,
        "storageUsed": user.get("storageUsed", 0),
        "createdAt": user.get("createdAt"),
        "tierExpiresAt": user.get("tierExpiresAt"),
        "tierFallback": user.get("tierFallback", default_signup_tier(db)),
    }


def admin_user_payload(user, db):
    payload = public_user(user, db)
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
        "acceptedTosAt": None,
    }


def create_session(db, user_id):
    token = secrets.token_urlsafe(32)
    db["sessions"][token] = {"userId": user_id, "createdAt": utc_ms(), "expiresAt": utc_ms() + 30 * 24 * 3600 * 1000}
    return token


def normalize_snapshot(snapshot):
    snapshot.setdefault("version", 1)
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
    return "-".join(part for part in value.split("-") if part)[:64]


def user_handle(user):
    return slugify(user.get("name") or user.get("email", "").split("@", 1)[0] or "user") or "user"


def share_public_path(db, share):
    owner = db["users"].get(share.get("ownerId", ""))
    return f"/{user_handle(owner or {})}/{share.get('customSlug') or share.get('id')}"


def share_url(db, share):
    if share.get("appMode"):
        return f"/s/{share.get('id')}/"
    public_path = share_public_path(db, share)
    return public_path if share.get("customSlug") else f"/?share={share.get('id')}"


def find_share_by_public_path(db, path):
    normalized = "/" + "/".join(part for part in str(path).strip("/").split("/") if part)
    if normalized.count("/") != 2:
        return None
    for share in db["shares"].values():
        if share_public_path(db, share) == normalized:
            return share
    return None


def default_signup_tier(db):
    for tier_id, tier in tiers_for(db).items():
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


def enforce_user_tier_expiry(db, user):
    expires_at = user.get("tierExpiresAt")
    if not expires_at:
        return False
    try:
        expired = int(expires_at) <= utc_ms()
    except Exception:
        expired = True
    if not expired:
        return False
    user["tier"] = user.get("tierFallback") or default_signup_tier(db)
    user["tierExpiresAt"] = None
    user["tierFallback"] = default_signup_tier(db)
    return True


def apply_expired_tiers(db):
    changed = False
    for user in db.get("users", {}).values():
        changed = enforce_user_tier_expiry(db, user) or changed
    return changed


def recompute_user_storage(db, user_id):
    total = sum(s.get("size", 0) for s in db["snapshots"].values() if s.get("userId") == user_id)
    if user_id in db["users"]:
        db["users"][user_id]["storageUsed"] = total
    return total


def prune_user_snapshots(db, store: CloudStore, user_id, keep_last):
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
        (store.blob_dir / f"{snapshot_id}.zip").unlink(missing_ok=True)
        for share_id, share in list(db["shares"].items()):
            if share.get("snapshotId") == snapshot_id:
                del db["shares"][share_id]
        removed.append(snapshot_id)
    recompute_user_storage(db, user_id)
    return removed


def validate_snapshot_zip(path: Path, max_size: int):
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
    except zipfile.BadZipFile as exc:
        raise ValueError("snapshot must be a valid zip archive") from exc
