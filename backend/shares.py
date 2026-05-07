import secrets

from flask import Blueprint, current_app, jsonify, request, send_file

from models import (
    can_view_share,
    find_share_by_public_path,
    merged_permissions,
    normalize_snapshot,
    prune_user_snapshots,
    public_user,
    recompute_user_storage,
    share_public_path,
    share_url,
    slugify,
    utc_ms,
    validate_snapshot_zip,
)


bp = Blueprint("share_api", __name__)


def share_payload(db, share):
    payload = dict(share)
    payload["publicPath"] = share_public_path(db, share)
    payload["url"] = share_url(db, share)
    return payload


def public_guest_writeable(share):
    return (
        share.get("visibility") == "public"
        and share.get("mode") == "read-write"
        and not share.get("tempMode")
    )


@bp.get("/api/share/list")
def list_shares():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    shares = []
    for share in db["shares"].values():
        if share["ownerId"] != user["id"]:
            continue
        shares.append(share_payload(db, share))
    shares.sort(key=lambda item: item["createdAt"], reverse=True)
    return jsonify({"shares": shares})


@bp.get("/api/share/resolve")
def resolve_share():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    share = find_share_by_public_path(db, request.args.get("path", ""))
    if not share or share.get("revoked"):
        return jsonify({"error": "share not found"}), 404
    if share.get("expiresAt") and share["expiresAt"] < utc_ms():
        return jsonify({"error": "share expired"}), 410
    snapshot = db["snapshots"].get(share["snapshotId"])
    owner = db["users"].get(share["ownerId"])
    if not snapshot or not owner:
        return jsonify({"error": "shared snapshot not found"}), 404
    viewer = current_app.extensions["edgeterm_current_user"](db)
    allowed, reason = can_view_share(share, viewer)
    if not allowed:
        return jsonify({"error": reason}), 401 if reason == "login required" else 403
    normalize_snapshot(snapshot)
    return jsonify({"share": share_payload(db, share), "snapshot": snapshot, "owner": public_user(owner, db)})


@bp.get("/api/share/<share_id>")
def get_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    share = db["shares"].get(share_id)
    if not share or share.get("revoked"):
        return jsonify({"error": "share not found"}), 404
    if share.get("expiresAt") and share["expiresAt"] < utc_ms():
        return jsonify({"error": "share expired"}), 410
    snapshot = db["snapshots"].get(share["snapshotId"])
    owner = db["users"].get(share["ownerId"])
    if not snapshot or not owner:
        return jsonify({"error": "shared snapshot not found"}), 404
    viewer = current_app.extensions["edgeterm_current_user"](db)
    allowed, reason = can_view_share(share, viewer)
    if not allowed:
        return jsonify({"error": reason}), 401 if reason == "login required" else 403
    if request.args.get("download") == "1":
        return send_file(store.blob_dir / f"{snapshot['id']}.zip", mimetype="application/zip", as_attachment=True, download_name=f"{snapshot['name']}.workspace.zip")
    normalize_snapshot(snapshot)
    return jsonify({"share": share_payload(db, share), "snapshot": snapshot, "owner": public_user(owner, db)})


@bp.post("/api/share/create")
def create_share():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    perms = merged_permissions(user, db)
    if not perms.get("sharingEnabled", True):
        return jsonify({"error": "sharing is disabled"}), 403
    owned_shares = [item for item in db["shares"].values() if item["ownerId"] == user["id"]]
    if len(owned_shares) >= int(perms["maxShareLinks"]):
        return jsonify({"error": "share link limit exceeded"}), 403
    data = request.get_json(silent=True) or {}
    snapshot = db["snapshots"].get(str(data.get("snapshotId", "")))
    if not snapshot or snapshot["userId"] != user["id"]:
        return jsonify({"error": "snapshot not found"}), 404
    visibility = str(data.get("visibility", "private"))
    if visibility not in perms["sharePermissions"]:
        return jsonify({"error": "tier does not allow this share visibility"}), 403
    custom_slug = slugify(data.get("customSlug", ""))
    share_id = secrets.token_urlsafe(10)
    expires_in = int(data.get("expiresInSeconds") or 0)
    if expires_in <= 0:
        expires_in = int(perms.get("defaultExpirationSeconds", 0))
    share = {
        "id": share_id,
        "snapshotId": snapshot["id"],
        "ownerId": user["id"],
        "visibility": visibility,
        "mode": "read-write" if data.get("readWrite") else "read-only",
        "allowFork": bool(data.get("allowFork", True)),
        "allowCloudWriteBack": bool(data.get("allowCloudWriteBack", False)),
        "appMode": bool(data.get("appMode", False)),
        "tempMode": bool(data.get("tempMode", False)),
        "revoked": False,
        "customSlug": custom_slug,
        "allowedUsers": [str(item).lower() for item in data.get("allowedUsers", []) if str(item).strip()],
        "createdAt": utc_ms(),
        "expiresAt": utc_ms() + expires_in * 1000 if expires_in > 0 else None,
    }
    if custom_slug:
        desired = share_public_path(db, share)
        for existing in db["shares"].values():
            if share_public_path(db, existing) == desired:
                return jsonify({"error": "custom share url already in use"}), 409
    db["shares"][share_id] = share
    store.save_db(db)
    payload = share_payload(db, share)
    return jsonify({"share": payload, "url": payload["url"]}), 201


@bp.post("/api/share/update/<share_id>")
def update_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    share = db["shares"].get(share_id)
    if not share or share["ownerId"] != user["id"]:
        return jsonify({"error": "share not found"}), 404
    data = request.get_json(silent=True) or {}
    perms = merged_permissions(user, db)
    if "visibility" in data:
        visibility = str(data["visibility"])
        if visibility not in perms["sharePermissions"]:
            return jsonify({"error": "tier does not allow this share visibility"}), 403
        share["visibility"] = visibility
    if "expiresInSeconds" in data:
        expires_in = int(data.get("expiresInSeconds") or 0)
        share["expiresAt"] = utc_ms() + expires_in * 1000 if expires_in > 0 else None
    if "allowedUsers" in data:
        share["allowedUsers"] = [str(item).lower() for item in data.get("allowedUsers", []) if str(item).strip()]
    if "customSlug" in data:
        share["customSlug"] = slugify(data.get("customSlug", ""))
    for key in ("allowFork", "allowCloudWriteBack", "revoked", "tempMode"):
        if key in data:
            share[key] = bool(data[key])
    if "readWrite" in data:
        share["mode"] = "read-write" if data.get("readWrite") else "read-only"
    if "appMode" in data:
        share["appMode"] = bool(data["appMode"])
    if share.get("customSlug"):
        desired = share_public_path(db, share)
        for existing in db["shares"].values():
            if existing.get("id") != share_id and share_public_path(db, existing) == desired:
                return jsonify({"error": "custom share url already in use"}), 409
    store.save_db(db)
    return jsonify({"share": share_payload(db, share)})

@bp.delete("/api/share/<share_id>")
def delete_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    share = db["shares"].get(share_id)
    if not share or share["ownerId"] != user["id"]:
        return jsonify({"error": "share not found"}), 404
    del db["shares"][share_id]
    store.save_db(db)
    return jsonify({"ok": True})


@bp.post("/api/share/revoke/<share_id>")
def delete_share_legacy(share_id):
    return delete_share(share_id)


@bp.post("/api/share/writeback/<share_id>")
def writeback_share(share_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_current_user"](db)
    share = db["shares"].get(share_id)
    if not share or share.get("revoked"):
        return jsonify({"error": "share not found"}), 404
    owner = db["users"].get(share["ownerId"])
    snapshot = db["snapshots"].get(share["snapshotId"])
    if not owner or not snapshot:
        return jsonify({"error": "shared snapshot not found"}), 404
    guest_overwrite = user is None and public_guest_writeable(share)
    if not guest_overwrite:
        allowed, reason = can_view_share(share, user)
        if not allowed:
            return jsonify({"error": reason}), 401 if reason == "login required" else 403
    if share.get("mode") != "read-write":
        return jsonify({"error": "share is read-only"}), 403
    if not guest_overwrite and not share.get("allowCloudWriteBack"):
        return jsonify({"error": "cloud write-back is not enabled for this share"}), 403
    strategy = (request.headers.get("X-EdgeTerm-Conflict-Strategy") or request.args.get("strategy", "overwrite")).strip().lower()
    base_version = int(request.headers.get("X-EdgeTerm-Base-Version", "0") or "0")
    raw = request.get_data(cache=False, as_text=False)
    if strategy not in {"overwrite", "fork"}:
        return jsonify({"error": "invalid conflict strategy"}), 400
    if guest_overwrite and strategy != "overwrite":
        return jsonify({"error": "guest write-back only supports overwrite"}), 403
    owner_perms = merged_permissions(owner, db)
    if strategy == "fork":
        if user is None:
            return jsonify({"error": "login required for fork"}), 401
        actor_perms = merged_permissions(user, db)
        actor_current = recompute_user_storage(db, user["id"])
        actor_snaps = [s for s in db["snapshots"].values() if s["userId"] == user["id"]]
        if len(actor_snaps) >= int(actor_perms["maxSnapshots"]):
            return jsonify({"error": "snapshot limit exceeded for fork"}), 403
        if actor_current + len(raw) > int(actor_perms["storageQuota"]):
            return jsonify({"error": "storage quota exceeded for fork", "storageUsed": actor_current, "quota": actor_perms["storageQuota"]}), 403
    else:
        normalize_snapshot(snapshot)
        if base_version and base_version != int(snapshot.get("version", 1)):
            return jsonify({"error": "share has changed since this copy was opened", "currentVersion": snapshot.get("version", 1)}), 409
        owner_current = recompute_user_storage(db, owner["id"])
        projected = owner_current - int(snapshot.get("size", 0)) + len(raw)
        if projected > int(owner_perms["storageQuota"]):
            return jsonify({"error": "owner storage quota exceeded", "storageUsed": owner_current, "quota": owner_perms["storageQuota"]}), 403

    temp_id = secrets.token_urlsafe(12)
    temp_path = store.blob_dir / f"{temp_id}.zip"
    temp_path.write_bytes(raw)
    try:
        validate_snapshot_zip(temp_path, max(int(owner_perms["storageQuota"]), len(raw)))
        if strategy == "fork":
            new_id = secrets.token_urlsafe(12)
            final_path = store.blob_dir / f"{new_id}.zip"
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
            prune_user_snapshots(db, store, user["id"], merged_permissions(user, db).get("keepLastBackups"))
            store.save_db(db)
            return jsonify({"snapshot": new_snapshot, "mode": "fork"}), 201
        final_path = store.blob_dir / f"{snapshot['id']}.zip"
        temp_path.replace(final_path)
        snapshot["size"] = final_path.stat().st_size
        snapshot["updatedAt"] = utc_ms()
        snapshot["version"] = int(snapshot.get("version", 1)) + 1
        snapshot["appMode"] = bool(share.get("appMode", snapshot.get("appMode", False)))
        recompute_user_storage(db, owner["id"])
        store.save_db(db)
        return jsonify({"snapshot": snapshot, "mode": "overwrite", "publicGuestWriteback": guest_overwrite})
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
