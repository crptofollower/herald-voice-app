"""Fail-closed credential configuration for Herald API.

Uses synthetic test values only. Does not read or print production secrets.
"""
from __future__ import annotations

import ast
import importlib
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

API_PATH = ROOT / "herald_api.py"

# Synthetic values for this harness only — not production credentials.
TEST_ACCESS = "test-access-configured"
TEST_WEBHOOK = "test-webhook-configured"


def _load_api():
    os.environ.setdefault("HERALD_ACCESS_CODE", TEST_ACCESS)
    os.environ.setdefault("WEBHOOK_SECRET", TEST_WEBHOOK)
    import herald_api as api
    return importlib.reload(api)


class CredentialFailClosedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = _load_api()
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient

    def setUp(self):
        self.api.ACCESS_CODE = TEST_ACCESS
        self.api.WEBHOOK_SECRET = TEST_WEBHOOK
        self.api.OWNER_CODE = ""
        self.api.OWNER_ID = ""
        self.api.invites = {}
        self.client = self.TestClient(self.api.app)

    def test_source_has_no_nonempty_access_code_fallback(self):
        tree = ast.parse(API_PATH.read_text(encoding="utf-8"))
        found = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if "ACCESS_CODE" not in names:
                continue
            found = True
            call = node.value
            self.assertIsInstance(call, ast.Call)
            self.assertIsInstance(call.func, ast.Attribute)
            self.assertEqual(call.func.attr, "get")
            self.assertGreaterEqual(len(call.args), 1)
            self.assertIsInstance(call.args[0], ast.Constant)
            self.assertEqual(call.args[0].value, "HERALD_ACCESS_CODE")
            if len(call.args) >= 2:
                self.assertIsInstance(call.args[1], ast.Constant)
                self.assertFalse(call.args[1].value)
        self.assertTrue(found)

    def test_missing_access_code_is_not_a_usable_credential(self):
        env = os.environ.copy()
        env.pop("HERALD_ACCESS_CODE", None)
        env["WEBHOOK_SECRET"] = TEST_WEBHOOK
        code = (
            "import os, importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('herald_api', r'{API_PATH}')\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "sys.modules['herald_api'] = mod\n"
            "spec.loader.exec_module(mod)\n"
            "val = mod.ACCESS_CODE\n"
            "print('EMPTY' if not val else 'NONEMPTY')\n"
        )
        import subprocess
        result = subprocess.run(
            [sys.executable, "-c", code],
            env=env,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(result.stdout.strip().splitlines()[-1], "EMPTY")

    def test_auth_fails_closed_when_access_code_unset(self):
        self.api.ACCESS_CODE = ""
        r = self.client.post("/auth", json={"user_id": "u_test", "code": TEST_ACCESS})
        self.assertEqual(r.status_code, 401)
        r2 = self.client.post("/auth", json={"user_id": "u_test", "code": ""})
        self.assertEqual(r2.status_code, 401)

    def test_onboard_fails_closed_when_access_code_unset(self):
        self.api.ACCESS_CODE = ""
        r = self.client.post("/onboard", json={
            "name": "Test",
            "access_code": TEST_ACCESS,
        })
        self.assertEqual(r.status_code, 401)

    def test_configured_access_code_still_auths(self):
        with patch.object(self.api, "_write_profile_to_db"):
            r = self.client.post("/auth", json={"user_id": "u_test", "code": TEST_ACCESS})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("user_id"), "u_test")

    def test_configured_access_code_still_onboards(self):
        with patch.object(self.api, "_write_profile_to_db"):
            r = self.client.post("/onboard", json={
                "name": "Test",
                "ai_name": "Herald",
                "persona": "city",
                "access_code": TEST_ACCESS,
            })
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok"))
        self.assertTrue(body.get("user_id"))

    def test_waitlist_list_fails_closed_when_webhook_secret_unset(self):
        self.api.WEBHOOK_SECRET = ""
        r = self.client.get("/waitlist/list")
        self.assertEqual(r.status_code, 401)
        r2 = self.client.get("/waitlist/list", params={"secret": ""})
        self.assertEqual(r2.status_code, 401)
        r3 = self.client.get("/waitlist/list", params={"secret": TEST_WEBHOOK})
        self.assertEqual(r3.status_code, 401)

    def test_waitlist_list_rejects_wrong_secret_when_configured(self):
        r = self.client.get("/waitlist/list", params={"secret": "wrong-secret"})
        self.assertEqual(r.status_code, 401)

    def test_waitlist_list_accepts_configured_secret(self):
        def _mem_db():
            conn = sqlite3.connect(":memory:")
            conn.execute(
                "CREATE TABLE waitlist (email TEXT, source TEXT, created_at TEXT)"
            )
            conn.commit()
            return conn
        with patch.object(self.api, "_db_conn", side_effect=_mem_db):
            r = self.client.get("/waitlist/list", params={"secret": TEST_WEBHOOK})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body.get("count"), 0)
        self.assertEqual(body.get("emails"), [])


if __name__ == "__main__":
    unittest.main()
