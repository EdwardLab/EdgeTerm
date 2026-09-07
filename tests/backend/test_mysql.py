"""Opt-in route integration tests against a disposable MySQL database."""

import os
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

import pymysql
from test_routes import backend, workspace_zip


@unittest.skipUnless(os.environ.get("EDGETERM_TEST_MYSQL_HOST"), "Set EDGETERM_TEST_MYSQL_HOST for MySQL integration tests")
class MySQLRoutesTest(unittest.TestCase):
    def setUp(self):
        self.database = "edgeterm_test_" + secrets.token_hex(6)
        self.config = {
            "host": os.environ["EDGETERM_TEST_MYSQL_HOST"],
            "port": int(os.environ.get("EDGETERM_TEST_MYSQL_PORT", "3306")),
            "user": os.environ.get("EDGETERM_TEST_MYSQL_USER", "root"),
            "password": os.environ.get("EDGETERM_TEST_MYSQL_PASSWORD", ""),
        }
        self.connection = pymysql.connect(**self.config, autocommit=True)
        self.addCleanup(self.connection.close)
        with self.connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE `{self.database}`")
        self.addCleanup(self.drop_database)
        self.temp = tempfile.TemporaryDirectory(prefix="edgeterm-mysql-test-")
        self.addCleanup(self.temp.cleanup)
        self.config["database"] = self.database
        with patch.object(backend, "load_dotenv_file"):
            self.app = backend.create_app(self.temp.name, mysql_config=self.config)
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def drop_database(self):
        with self.connection.cursor() as cursor:
            cursor.execute(f"DROP DATABASE `{self.database}`")

    def register(self, email):
        response = self.client.post("/api/register", json={"email": email, "password": "integration-test-password", "acceptedTos": True})
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json(), {"Authorization": "Bearer " + response.get_json()["token"]}

    def test_account_persists_across_app_instances(self):
        account, headers = self.register("owner@example.test")
        with patch.object(backend, "load_dotenv_file"):
            reopened = backend.create_app(self.temp.name, mysql_config=self.config).test_client()
        response = reopened.get("/api/me", headers=headers)
        self.assertEqual(response.get_json()["user"]["id"], account["user"]["id"])
        self.assertEqual(response.get_json()["backend"]["driver"], "mysql")
        self.assertEqual(reopened.post("/api/logout", headers=headers).status_code, 200)
        self.assertIsNone(self.client.get("/api/me", headers=headers).get_json()["user"])

    def test_snapshots_shares_and_permissions_roundtrip(self):
        _, owner = self.register("owner@example.test")
        _, other = self.register("other@example.test")
        response = self.client.post("/api/snapshot/upload", data=workspace_zip(), headers=owner)
        self.assertEqual(response.status_code, 201, response.get_json())
        snapshot = response.get_json()["snapshot"]
        share = self.client.post("/api/share/create", headers=owner, json={"snapshotId": snapshot["id"], "visibility": "private"})
        self.assertEqual(share.status_code, 201, share.get_json())
        share_id = share.get_json()["share"]["id"]
        self.assertEqual(self.client.get(f"/api/share/{share_id}", headers=other).status_code, 403)
        with self.client.get(f"/api/snapshot/download/{snapshot['id']}", headers=owner) as download:
            self.assertEqual(download.data, workspace_zip())
        self.assertEqual(self.client.delete(f"/api/snapshot/{snapshot['id']}", headers=owner).status_code, 200)
        self.assertEqual(self.client.get(f"/api/share/{share_id}", headers=owner).status_code, 404)
        self.assertEqual(list((Path(self.temp.name) / "blobs").glob("*.zip")), [])


if __name__ == "__main__":
    unittest.main()
