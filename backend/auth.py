from flask import Blueprint, current_app, jsonify, request

from models import create_session, default_signup_tier, make_user, public_user, verify_password


bp = Blueprint("auth_api", __name__)


@bp.post("/api/register")
def register():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).lower().strip()
    password = str(data.get("password", ""))
    accepted_tos = bool(data.get("acceptedTos"))
    if "@" not in email or len(password) < 8:
        return jsonify({"error": "valid email and 8+ character password required"}), 400
    if not accepted_tos:
        return jsonify({"error": "you must agree to the Terms of Service to register"}), 400
    if any(u["email"] == email for u in db["users"].values()):
        return jsonify({"error": "email already registered"}), 409
    is_first = not db["users"]
    user = make_user(email, password, "admin" if is_first else "user", "pro" if is_first else default_signup_tier(db), str(data.get("name", "")))
    user["acceptedTosAt"] = user["createdAt"]
    db["users"][user["id"]] = user
    token = create_session(db, user["id"])
    store.save_db(db)
    return jsonify({"token": token, "user": public_user(user, db)}), 201


@bp.post("/api/login")
def login():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).lower().strip()
    password = str(data.get("password", ""))
    user = next((u for u in db["users"].values() if u["email"] == email), None)
    if not user or not verify_password(password, user.get("passwordHash", "")):
        return jsonify({"error": "invalid email or password"}), 401
    token = create_session(db, user["id"])
    store.save_db(db)
    return jsonify({"token": token, "user": public_user(user, db)})


@bp.post("/api/logout")
def logout():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    token = current_app.extensions["edgeterm_current_token"](db)
    if token:
        db["sessions"].pop(token, None)
        store.save_db(db)
    return jsonify({"ok": True})


@bp.get("/api/me")
def me():
    store = current_app.extensions["edgeterm_store"]
    db = store.load_db()
    user = current_app.extensions["edgeterm_current_user"](db)
    return jsonify(
        {
            "user": public_user(user, db) if user else None,
            "settings": db["settings"],
            "tiers": db["tiers"],
            "backend": {"driver": getattr(store, "driver", "unknown"), "cloudRoot": str(store.root)},
        }
    )
