"""Cloud API contract tests with isolated metadata and real ZIP/blob operations."""

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import app as backend
from models import default_db_state, make_user, create_session, utc_ms


def workspace_zip(content="hello", name="home/user/hello.txt"):
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, content)
    return output.getvalue()


class IsolatedStore:
    driver = "test"

    def __init__(self, root):
        self.root = Path(root)
        self.blob_dir = self.root / "blobs"
        self.blob_dir.mkdir()
        self.state = default_db_state()

    def load_db(self):
        return deepcopy(self.state)

    def save_db(self, db):
        self.state = deepcopy(db)


class CloudRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.users = [make_user("owner@example.test", "test-password", "admin", "pro"),
                     make_user("reader@example.test", "test-password", "user", "plus"),
                     make_user("other@example.test", "test-password", "user", "free")]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="edgeterm-api-test-")
        self.addCleanup(self.temp.cleanup)
        self.store = IsolatedStore(self.temp.name)
        with patch.object(backend, "CloudStore", return_value=self.store), patch.object(backend, "load_dotenv_file"):
            self.app = backend.create_app(self.temp.name, mysql_config={})
        self.app.config.update(TESTING=True)
        self.client = self.app.test_client()
        self.headers = []
        for user in deepcopy(self.users):
            self.store.state["users"][user["id"]] = user
            token = create_session(self.store.state, user["id"])
            self.headers.append({"Authorization": f"Bearer {token}"})

    def upload(self, actor=0, **kwargs):
        return self.client.post("/api/snapshot/upload", data=workspace_zip(), headers=self.headers[actor], **kwargs)

    def share(self, **options):
        snapshot = self.upload().get_json()["snapshot"]
        response = self.client.post("/api/share/create", headers=self.headers[0], json={
            "snapshotId": snapshot["id"], "visibility": "public", **options,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()["share"], snapshot

    def test_public_routes_and_isolation_headers(self):
        for route in ["/", "/index.html", "/admin", "/app/", "/w/test/"]:
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["Cross-Origin-Opener-Policy"], "same-origin")
                self.assertEqual(response.headers["Cross-Origin-Embedder-Policy"], "require-corp")

    def test_anonymous_account_and_protected_routes(self):
        self.assertIsNone(self.client.get("/api/me").get_json()["user"])
        for route in ["/api/snapshot/list", "/api/share/list", "/api/admin/users", "/api/admin/storage"]:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(route).status_code, 401)

    def test_register_requires_terms_and_valid_credentials(self):
        for body in [{}, {"email": "new@example.test", "password": "short", "acceptedTos": True},
                     {"email": "new@example.test", "password": "test-password"}]:
            self.assertEqual(self.client.post("/api/register", json=body).status_code, 400)

    def test_register_duplicate_and_no_password_disclosure(self):
        body = {"email": "New@Example.test", "password": "test-password", "acceptedTos": True}
        response = self.client.post("/api/register", json=body)
        self.assertEqual(response.status_code, 201)
        user = response.get_json()["user"]
        self.assertEqual(user["email"], "new@example.test")
        self.assertEqual(user["role"], "user")
        self.assertNotIn("passwordHash", user)
        self.assertEqual(self.client.post("/api/register", json=body).status_code, 409)

    def test_login_logout_and_expired_session(self):
        self.assertEqual(self.client.post("/api/login", json={"email": "owner@example.test", "password": "wrong"}).status_code, 401)
        response = self.client.post("/api/login", json={"email": "owner@example.test", "password": "test-password"})
        self.assertEqual(response.status_code, 200)
        token = response.get_json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        self.assertIsNotNone(self.client.get("/api/me", headers=headers).get_json()["user"])
        self.assertEqual(self.client.post("/api/logout", headers=headers).status_code, 200)
        self.assertIsNone(self.client.get("/api/me", headers=headers).get_json()["user"])
        token = self.headers[0]["Authorization"].split()[1]
        self.store.state["sessions"][token]["expiresAt"] = utc_ms() - 1000
        self.assertEqual(self.client.get("/api/snapshot/list", headers=self.headers[0]).status_code, 401)

    def test_non_admin_cannot_read_or_change_admin_resources(self):
        for route in ["users", "storage", "shares", "tiers", "snapshots"]:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(f"/api/admin/{route}", headers=self.headers[1]).status_code, 403)
        response = self.client.post("/api/admin/settings", headers=self.headers[1], json={"sharingEnabled": False})
        self.assertEqual(response.status_code, 403)
        self.assertTrue(self.store.state["settings"]["sharingEnabled"])

    def test_admin_can_read_resources(self):
        for route in ["users", "storage", "shares", "tiers", "snapshots"]:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(f"/api/admin/{route}", headers=self.headers[0]).status_code, 200)

    def test_snapshot_roundtrip_and_owner_isolation(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.get_json())
        snapshot = response.get_json()["snapshot"]
        route = f"/api/snapshot/download/{snapshot['id']}"
        with self.client.get(route, headers=self.headers[0]) as download:
            self.assertEqual(download.data, workspace_zip())
        self.assertEqual(self.client.get(route, headers=self.headers[1]).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/snapshot/{snapshot['id']}", headers=self.headers[1]).status_code, 404)
        self.assertEqual(len(self.client.get("/api/snapshot/list", headers=self.headers[0]).get_json()["snapshots"]), 1)
        self.assertEqual(self.client.get("/api/snapshot/list", headers=self.headers[1]).get_json()["snapshots"], [])

    def test_invalid_snapshot_and_path_traversal_leave_no_blobs(self):
        for raw in [b"not a zip", workspace_zip(name="../outside.txt"), workspace_zip(name="/absolute.txt")]:
            response = self.client.post("/api/snapshot/upload", data=raw, headers=self.headers[0])
            self.assertEqual(response.status_code, 400, response.get_json())
        self.assertEqual(list(self.store.blob_dir.iterdir()), [])
        self.assertEqual(self.store.state["snapshots"], {})

    def test_snapshot_quota_and_count_limits(self):
        user = self.store.state["users"][self.users[0]["id"]]
        user["overrides"] = {"storageQuota": 1}
        self.assertEqual(self.upload().status_code, 403)
        user["overrides"] = {"maxSnapshots": 0}
        self.assertEqual(self.upload().status_code, 403)
        self.assertEqual(list(self.store.blob_dir.iterdir()), [])

    def test_snapshot_delete_removes_dependent_share(self):
        share, snapshot = self.share()
        response = self.client.delete(f"/api/snapshot/{snapshot['id']}", headers=self.headers[0])
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(share["id"], self.store.state["shares"])
        self.assertEqual(list(self.store.blob_dir.iterdir()), [])
        self.assertEqual(self.store.state["users"][self.users[0]["id"]]["storageUsed"], 0)

    def test_batch_delete_cannot_delete_another_users_snapshot(self):
        own = self.upload(0).get_json()["snapshot"]["id"]
        other = self.upload(1).get_json()["snapshot"]["id"]
        response = self.client.post("/api/snapshot/batch-delete", headers=self.headers[0], json={"snapshotIds": [own, other]})
        self.assertEqual(response.get_json()["deleted"], [own])
        self.assertIn(other, self.store.state["snapshots"])

    def test_share_visibility_and_restricted_allowlist(self):
        share, _ = self.share(visibility="restricted", allowedUsers=["reader@example.test"])
        route = f"/api/share/{share['id']}"
        self.assertEqual(self.client.get(route).status_code, 401)
        self.assertEqual(self.client.get(route, headers=self.headers[1]).status_code, 200)
        self.assertEqual(self.client.get(route, headers=self.headers[2]).status_code, 403)
        with self.client.get(route + "?download=1", headers=self.headers[1]) as download:
            self.assertEqual(download.data, workspace_zip())

    def test_private_share_denies_other_users(self):
        share, _ = self.share(visibility="private")
        route = f"/api/share/{share['id']}"
        self.assertEqual(self.client.get(route, headers=self.headers[0]).status_code, 200)
        self.assertEqual(self.client.get(route, headers=self.headers[1]).status_code, 403)

    def test_share_mutations_require_ownership(self):
        share, _ = self.share()
        self.assertEqual(self.client.post(f"/api/share/update/{share['id']}", headers=self.headers[1], json={"readWrite": True}).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/share/{share['id']}", headers=self.headers[1]).status_code, 404)
        self.assertEqual(self.store.state["shares"][share["id"]]["mode"], "read-only")

    def test_expired_share_rejects_guest_writeback(self):
        share, snapshot = self.share(readWrite=True, allowCloudWriteBack=True)
        self.store.state["shares"][share["id"]]["expiresAt"] = utc_ms() - 1000
        self.assertEqual(self.client.get(f"/api/share/{share['id']}").status_code, 410)
        response = self.client.post(f"/api/share/writeback/{share['id']}", data=workspace_zip("changed"))
        self.assertEqual(response.status_code, 410)
        self.assertEqual((self.store.blob_dir / f"{snapshot['id']}.zip").read_bytes(), workspace_zip())

    def test_revoked_share_rejects_read_and_write(self):
        share, _ = self.share(readWrite=True)
        self.store.state["shares"][share["id"]]["revoked"] = True
        self.assertEqual(self.client.get(f"/api/share/{share['id']}").status_code, 404)
        self.assertEqual(self.client.post(f"/api/share/writeback/{share['id']}", data=workspace_zip()).status_code, 404)

    def test_read_only_share_rejects_writeback(self):
        share, _ = self.share()
        self.assertEqual(self.client.post(f"/api/share/writeback/{share['id']}", headers=self.headers[0], data=workspace_zip()).status_code, 403)

    def test_writeback_version_conflict_and_roundtrip(self):
        share, snapshot = self.share(readWrite=True, allowCloudWriteBack=True)
        route = f"/api/share/writeback/{share['id']}"
        response = self.client.post(route, headers={**self.headers[0], "X-EdgeTerm-Base-Version": "99"}, data=workspace_zip("changed"))
        self.assertEqual(response.status_code, 409)
        response = self.client.post(route, headers={**self.headers[0], "X-EdgeTerm-Base-Version": "1"}, data=workspace_zip("changed"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["snapshot"]["version"], 2)
        self.assertEqual((self.store.blob_dir / f"{snapshot['id']}.zip").read_bytes(), workspace_zip("changed"))

    def test_fork_permission_is_enforced(self):
        share, _ = self.share(readWrite=True, allowCloudWriteBack=True, allowFork=False)
        response = self.client.post(f"/api/share/writeback/{share['id']}?strategy=fork", headers=self.headers[1], data=workspace_zip())
        self.assertEqual(response.status_code, 403)

    def test_invalid_zip_writeback_preserves_original(self):
        share, snapshot = self.share(readWrite=True, allowCloudWriteBack=True)
        response = self.client.post(f"/api/share/writeback/{share['id']}", headers=self.headers[0], data=b"invalid")
        self.assertEqual(response.status_code, 400)
        self.assertEqual((self.store.blob_dir / f"{snapshot['id']}.zip").read_bytes(), workspace_zip())
        self.assertEqual(len(list(self.store.blob_dir.iterdir())), 1)

    def test_invalid_retention_is_rejected_before_writing(self):
        response = self.client.post("/api/snapshot/upload", data=workspace_zip(), headers={**self.headers[0], "X-EdgeTerm-Keep-Last-Backups": "invalid"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(self.store.blob_dir.iterdir()), [])

    def test_json_arrays_are_rejected(self):
        for route in ["/api/register", "/api/login", "/api/share/create", "/api/admin/settings"]:
            with self.subTest(route=route):
                self.assertEqual(self.client.post(route, json=["invalid"], headers=self.headers[0]).status_code, 400)


if __name__ == "__main__":
    unittest.main()
