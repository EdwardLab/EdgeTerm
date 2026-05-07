import secrets

from flask import Blueprint, current_app, jsonify, request, send_file

from models import (
    admin_user_payload,
    apply_expired_tiers,
    clean_tier_payload,
    hash_password,
    merged_permissions,
    public_user,
    recompute_user_storage,
    share_public_path,
    share_url,
    slugify,
    tiers_for,
    utc_ms,
    validate_snapshot_zip,
)


bp = Blueprint("admin_api", __name__)


def require_admin(db):
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return None, (jsonify({"error": "login required"}), 401)
    if user.get("role") != "admin":
        return None, (jsonify({"error": "admin required"}), 403)
    return user, None


def apply_platform_policies(store, db):
    if apply_expired_tiers(db):
        store.save_db(db)


def admin_snapshot_payload(db, snapshot):
    owner = db["users"].get(snapshot.get("userId"))
    return {
        **snapshot,
        "owner": public_user(owner, db) if owner else None,
    }


def matches_query(value, query):
    if not query:
        return True
    haystack = " ".join(str(part or "") for part in value if part is not None).lower()
    return query in haystack


def delete_snapshot_for_admin(db, store, snapshot_id):
    snapshot = db["snapshots"].pop(snapshot_id, None)
    if not snapshot:
        return None
    (store.blob_dir / f"{snapshot_id}.zip").unlink(missing_ok=True)
    for share_id, share in list(db["shares"].items()):
        if share.get("snapshotId") == snapshot_id:
            del db["shares"][share_id]
    recompute_user_storage(db, snapshot["userId"])
    return snapshot


@bp.get("/api/admin/users")
def admin_users():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    query = str(request.args.get("q", "")).strip().lower()
    users = [
        admin_user_payload(user, db)
        for user in db["users"].values()
        if matches_query(
            [user.get("email"), user.get("name"), user.get("role"), user.get("tier"), user.get("id")],
            query,
        )
    ]
    users.sort(key=lambda item: ((item.get("role") != "admin"), item.get("email", "")))
    return jsonify({"users": users, "query": query})


@bp.post("/api/admin/users")
def admin_create_user():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    if "@" not in email:
        return jsonify({"error": "valid email required"}), 400
    if any(existing["email"] == email for existing in db["users"].values()):
        return jsonify({"error": "email already registered"}), 409
    from models import make_user

    user = make_user(email, str(data.get("password", "ChangeMe123!")), str(data.get("role", "user")), str(data.get("tier", "free")), str(data.get("name", "")))
    if isinstance(data.get("overrides"), dict):
        user["overrides"] = data["overrides"]
    if data.get("tierExpiresAt"):
        user["tierExpiresAt"] = int(data["tierExpiresAt"])
    if data.get("tierFallback"):
        user["tierFallback"] = str(data["tierFallback"])
    db["users"][user["id"]] = user
    store.save_db(db)
    return jsonify({"user": admin_user_payload(user, db)}), 201


@bp.post("/api/admin/users/<user_id>")
def admin_update_user(user_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    target = db["users"].get(user_id)
    if not target:
        return jsonify({"error": "user not found"}), 404
    data = request.get_json(silent=True) or {}
    if "email" in data:
        email = str(data["email"]).strip().lower()
        if "@" not in email:
            return jsonify({"error": "valid email required"}), 400
        if any(existing["email"] == email and existing["id"] != user_id for existing in db["users"].values()):
            return jsonify({"error": "email already registered"}), 409
        target["email"] = email
    for key in ("role", "tier", "name"):
        if key in data:
            target[key] = data[key]
    if data.get("password"):
        target["passwordHash"] = hash_password(str(data["password"]))
    if isinstance(data.get("overrides"), dict):
        target["overrides"] = data["overrides"]
    if "tierExpiresAt" in data:
        target["tierExpiresAt"] = int(data["tierExpiresAt"]) if data.get("tierExpiresAt") else None
    if "tierFallback" in data:
        target["tierFallback"] = str(data.get("tierFallback") or "free")
    store.save_db(db)
    return jsonify({"user": admin_user_payload(target, db)})


@bp.delete("/api/admin/users/<user_id>")
def admin_delete_user(user_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    if user_id == admin["id"]:
        return jsonify({"error": "cannot delete current admin"}), 400
    doomed = db["users"].pop(user_id, None)
    for token, session in list(db["sessions"].items()):
        if session.get("userId") == user_id:
            del db["sessions"][token]
    for snapshot_id, snapshot in list(db["snapshots"].items()):
        if snapshot["userId"] == user_id:
            (store.blob_dir / f"{snapshot_id}.zip").unlink(missing_ok=True)
            del db["snapshots"][snapshot_id]
    for share_id, share in list(db["shares"].items()):
        if share["ownerId"] == user_id:
            del db["shares"][share_id]
        elif doomed and doomed["email"] in set(share.get("allowedUsers", [])):
            share["allowedUsers"] = [email for email in share.get("allowedUsers", []) if email != doomed["email"]]
    store.save_db(db)
    return jsonify({"ok": True})


@bp.get("/api/admin/storage")
def admin_storage():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    query = str(request.args.get("q", "")).strip().lower()
    total = 0
    per_user = []
    for user in db["users"].values():
        used = recompute_user_storage(db, user["id"])
        total += used
        if matches_query([user.get("email"), user.get("name"), user.get("tier"), user.get("id")], query):
            per_user.append({"user": admin_user_payload(user, db), "storageUsed": used})
    store.save_db(db)
    return jsonify({"totalStorageUsed": total, "users": per_user, "query": query})


@bp.get("/api/admin/shares")
def admin_shares():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    query = str(request.args.get("q", "")).strip().lower()
    payload = []
    for share in db["shares"].values():
        owner = db["users"].get(share.get("ownerId"))
        if not matches_query(
            [
                share.get("id"),
                share.get("visibility"),
                share.get("mode"),
                share.get("customSlug"),
                share_public_path(db, share),
                owner.get("email") if owner else "",
                owner.get("name") if owner else "",
            ],
            query,
        ):
            continue
        item = dict(share)
        item["publicPath"] = share_public_path(db, share)
        item["url"] = share_url(db, share)
        item["owner"] = public_user(owner, db) if owner else None
        payload.append(item)
    payload.sort(key=lambda item: item.get("createdAt", 0), reverse=True)
    return jsonify({"shares": payload, "query": query})


@bp.post("/api/admin/shares/<share_id>")
def admin_update_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    share = db["shares"].get(share_id)
    if not share:
        return jsonify({"error": "share not found"}), 404
    data = request.get_json(silent=True) or {}
    for key in ("visibility", "expiresAt", "revoked"):
        if key in data:
            share[key] = data[key]
    if "allowedUsers" in data:
        share["allowedUsers"] = [str(item).lower() for item in data.get("allowedUsers", []) if str(item).strip()]
    if "customSlug" in data:
        share["customSlug"] = slugify(data.get("customSlug", ""))
    if "mode" in data and data["mode"] in {"read-only", "read-write"}:
        share["mode"] = data["mode"]
    for key in ("allowFork", "allowCloudWriteBack", "tempMode", "appMode"):
        if key in data:
            share[key] = bool(data[key])
    if share.get("customSlug"):
        desired = share_public_path(db, share)
        for existing in db["shares"].values():
            if existing.get("id") != share_id and share_public_path(db, existing) == desired:
                return jsonify({"error": "custom share url already in use"}), 409
    store.save_db(db)
    payload = dict(share)
    payload["publicPath"] = share_public_path(db, share)
    payload["url"] = share_url(db, share)
    return jsonify({"share": payload})


@bp.delete("/api/admin/shares/<share_id>")
def admin_delete_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    if share_id not in db["shares"]:
        return jsonify({"error": "share not found"}), 404
    del db["shares"][share_id]
    store.save_db(db)
    return jsonify({"ok": True})


@bp.get("/api/admin/tiers")
def admin_tiers():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    return jsonify({"tiers": tiers_for(db)})


@bp.post("/api/admin/tiers")
def admin_save_tier():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    data = request.get_json(silent=True) or {}
    tier_id = str(data.get("id", "")).strip().lower().replace(" ", "-")
    if not tier_id or not all(ch.isalnum() or ch in {"-", "_"} for ch in tier_id):
        return jsonify({"error": "valid tier id required"}), 400
    db["tiers"][tier_id] = clean_tier_payload(data)
    if db["tiers"][tier_id].get("isDefault"):
        for existing_id, tier in db["tiers"].items():
            if existing_id != tier_id:
                tier["isDefault"] = False
    store.save_db(db)
    return jsonify({"tiers": tiers_for(db)})


@bp.delete("/api/admin/tiers/<tier_id>")
def admin_delete_tier(tier_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    if tier_id in {"free", "plus", "pro"}:
        return jsonify({"error": "built-in tiers cannot be deleted"}), 400
    if tier_id in db["tiers"]:
        del db["tiers"][tier_id]
    for user in db["users"].values():
        if user.get("tier") == tier_id:
            user["tier"] = "free"
    store.save_db(db)
    return jsonify({"tiers": tiers_for(db)})


@bp.post("/api/admin/settings")
def admin_settings():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    data = request.get_json(silent=True) or {}
    for key in ("sharingEnabled", "appModeEnabled"):
        if key in data:
            db["settings"][key] = bool(data[key])
    if "cloudNoticeHtml" in data:
        db["settings"]["cloudNoticeHtml"] = str(data.get("cloudNoticeHtml", ""))[:50000]
    if "tosHtml" in data:
        db["settings"]["tosHtml"] = str(data.get("tosHtml", ""))[:100000]
    store.save_db(db)
    return jsonify({"settings": db["settings"]})


@bp.get("/api/admin/snapshots")
def admin_snapshots():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    query = str(request.args.get("q", "")).strip().lower()
    user_id = str(request.args.get("userId", "")).strip()
    items = []
    for snapshot in db["snapshots"].values():
        if user_id and snapshot.get("userId") != user_id:
            continue
        owner = db["users"].get(snapshot.get("userId"))
        if not matches_query(
            [
                snapshot.get("id"),
                snapshot.get("name"),
                snapshot.get("workspaceId"),
                owner.get("email") if owner else "",
                owner.get("name") if owner else "",
            ],
            query,
        ):
            continue
        items.append(admin_snapshot_payload(db, snapshot))
    items.sort(key=lambda item: (item.get("updatedAt", item.get("createdAt", 0)), item.get("createdAt", 0)), reverse=True)
    return jsonify({"snapshots": items, "query": query, "userId": user_id})


@bp.get("/api/admin/snapshots/<snapshot_id>/download")
def admin_download_snapshot(snapshot_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    snapshot = db["snapshots"].get(snapshot_id)
    if not snapshot:
        return jsonify({"error": "snapshot not found"}), 404
    return send_file(
        store.blob_dir / f"{snapshot_id}.zip",
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{snapshot.get('name', 'backup')}.workspace.zip",
    )


@bp.delete("/api/admin/snapshots/<snapshot_id>")
def admin_delete_snapshot(snapshot_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    snapshot = delete_snapshot_for_admin(db, store, snapshot_id)
    if not snapshot:
        return jsonify({"error": "snapshot not found"}), 404
    store.save_db(db)
    return jsonify({"ok": True, "snapshotId": snapshot_id})


@bp.post("/api/admin/snapshots/import")
def admin_import_snapshot():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    apply_platform_policies(store, db)
    admin, error = require_admin(db)
    if error:
        return error
    target_user_id = str(request.form.get("userId", "")).strip()
    target = db["users"].get(target_user_id)
    if not target:
        return jsonify({"error": "target user not found"}), 404
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "backup zip file required"}), 400
    perms = merged_permissions(target, db)
    current = recompute_user_storage(db, target["id"])
    user_snapshots = [s for s in db["snapshots"].values() if s["userId"] == target["id"]]
    raw = upload.read()
    if len(user_snapshots) >= int(perms["maxSnapshots"]):
        return jsonify({"error": "snapshot limit exceeded for target user"}), 403
    if current + len(raw) > int(perms["storageQuota"]):
        return jsonify({"error": "storage quota exceeded for target user"}), 403
    snapshot_id = secrets.token_urlsafe(12)
    blob_path = store.blob_dir / f"{snapshot_id}.zip"
    blob_path.write_bytes(raw)
    try:
        validate_snapshot_zip(blob_path, int(perms["storageQuota"]))
    except Exception:
        blob_path.unlink(missing_ok=True)
        raise
    snapshot = {
        "id": snapshot_id,
        "userId": target["id"],
        "name": str(request.form.get("name") or upload.filename or "Imported Backup")[:120],
        "workspaceId": str(request.form.get("workspaceId") or "admin-import")[:120],
        "size": blob_path.stat().st_size,
        "createdAt": utc_ms(),
        "updatedAt": utc_ms(),
        "version": 1,
        "format": "zip",
        "appMode": str(request.form.get("appMode", "false")).lower() == "true",
        "importedByAdminId": admin["id"],
    }
    db["snapshots"][snapshot_id] = snapshot
    recompute_user_storage(db, target["id"])
    store.save_db(db)
    return jsonify({"snapshot": admin_snapshot_payload(db, snapshot)}), 201
