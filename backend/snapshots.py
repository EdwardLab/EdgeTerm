import secrets
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request, send_file

from models import merged_permissions, normalize_snapshot, prune_user_snapshots, recompute_user_storage, utc_ms, validate_snapshot_zip


bp = Blueprint("snapshot_api", __name__)


def delete_snapshot_records(db, store, user_id, snapshot_ids):
    deleted = []
    for snapshot_id in snapshot_ids:
        snapshot = db["snapshots"].get(snapshot_id)
        if not snapshot or snapshot["userId"] != user_id:
            continue
        del db["snapshots"][snapshot_id]
        (store.blob_dir / f"{snapshot_id}.zip").unlink(missing_ok=True)
        for share_id, share in list(db["shares"].items()):
            if share.get("snapshotId") == snapshot_id:
                del db["shares"][share_id]
        deleted.append(snapshot_id)
    recompute_user_storage(db, user_id)
    store.save_db(db)
    return deleted


@bp.get("/api/snapshot/list")
def list_snapshots():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    perms = merged_permissions(user, db)
    items = [normalize_snapshot(s) for s in db["snapshots"].values() if s["userId"] == user["id"]]
    items.sort(key=lambda s: (s.get("updatedAt", s.get("createdAt", 0)), s.get("createdAt", 0)), reverse=True)
    return jsonify({"snapshots": items, "storageUsed": recompute_user_storage(db, user["id"]), "quota": perms["storageQuota"]})


@bp.post("/api/snapshot/upload")
def upload_snapshot():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    perms = merged_permissions(user, db)
    current = recompute_user_storage(db, user["id"])
    user_snapshots = [s for s in db["snapshots"].values() if s["userId"] == user["id"]]
    if len(user_snapshots) >= int(perms["maxSnapshots"]):
        return jsonify({"error": "snapshot limit exceeded"}), 403
    raw = request.get_data(cache=False, as_text=False)
    if current + len(raw) > int(perms["storageQuota"]):
        return jsonify({"error": "storage quota exceeded", "storageUsed": current, "quota": perms["storageQuota"]}), 403

    snapshot_id = secrets.token_urlsafe(12)
    blob_path = store.blob_dir / f"{snapshot_id}.zip"
    blob_path.write_bytes(raw)
    try:
        validate_snapshot_zip(blob_path, int(perms["storageQuota"]))
    except Exception:
        blob_path.unlink(missing_ok=True)
        raise

    name = request.headers.get("X-EdgeTerm-Name") or request.args.get("name", "Workspace Backup")
    workspace_id = request.headers.get("X-EdgeTerm-Workspace") or request.args.get("workspaceId", "")
    is_app = request.headers.get("X-EdgeTerm-App-Mode", "false").lower() == "true"
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
    requested_keep = request.headers.get("X-EdgeTerm-Keep-Last-Backups") or request.args.get("keepLastBackups", "")
    keep_last = perms.get("keepLastBackups")
    if str(requested_keep).strip():
        keep_last = min(max(0, int(requested_keep)), int(perms.get("maxSnapshots", keep_last)))
    pruned = prune_user_snapshots(db, store, user["id"], keep_last)
    store.save_db(db)
    return jsonify({"snapshot": snapshot, "storageUsed": db["users"][user["id"]]["storageUsed"], "quota": perms["storageQuota"], "prunedSnapshots": pruned}), 201


@bp.get("/api/snapshot/download/<snapshot_id>")
def download_snapshot(snapshot_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    snapshot = db["snapshots"].get(snapshot_id)
    if not snapshot or snapshot["userId"] != user["id"]:
        return jsonify({"error": "snapshot not found"}), 404
    normalize_snapshot(snapshot)
    return send_file(Path(store.blob_dir / f"{snapshot_id}.zip"), mimetype="application/zip", as_attachment=True, download_name=f"{snapshot['name']}.workspace.zip")


@bp.delete("/api/snapshot/<snapshot_id>")
def delete_snapshot(snapshot_id):
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    snapshot = db["snapshots"].get(snapshot_id)
    if not snapshot or snapshot["userId"] != user["id"]:
        return jsonify({"error": "snapshot not found"}), 404
    delete_snapshot_records(db, store, user["id"], [snapshot_id])
    return jsonify({"ok": True})


@bp.post("/api/snapshot/batch-delete")
def batch_delete_snapshots():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    payload = request.get_json(silent=True) or {}
    snapshot_ids = payload.get("snapshotIds", [])
    if not isinstance(snapshot_ids, list) or not snapshot_ids:
        return jsonify({"error": "snapshotIds is required"}), 400
    deleted = delete_snapshot_records(db, store, user["id"], [str(item) for item in snapshot_ids])
    return jsonify({"ok": True, "deleted": deleted, "count": len(deleted), "storageUsed": db["users"][user["id"]]["storageUsed"]})


@bp.delete("/api/snapshot")
def delete_all_snapshots():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_require_user"](db)
    if user is None:
        return jsonify({"error": "login required"}), 401
    snapshot_ids = [snapshot["id"] for snapshot in db["snapshots"].values() if snapshot["userId"] == user["id"]]
    deleted = delete_snapshot_records(db, store, user["id"], snapshot_ids)
    return jsonify({"ok": True, "deleted": deleted, "count": len(deleted), "storageUsed": db["users"][user["id"]]["storageUsed"]})
