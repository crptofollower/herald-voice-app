"""Temporary Phase 1C seed. Temp SQLite. No production secrets. Remove with the seed routes."""
from __future__ import annotations

import ast
import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

API_PATH = ROOT / "herald_api.py"
TEST_ACCESS = "test-access-configured"
TEST_WEBHOOK = "test-webhook-configured"
TEST_GROWTH = "test-growth-dashboard-secret"
TEST_SEED = "test-phase1c-seed-secret-value"


def _load_api():
    os.environ.setdefault("HERALD_ACCESS_CODE", TEST_ACCESS)
    os.environ.setdefault("WEBHOOK_SECRET", TEST_WEBHOOK)
    os.environ.setdefault("GROWTH_DASHBOARD_SECRET", TEST_GROWTH)
    os.environ.setdefault("PHASE1C_SEED_SECRET", TEST_SEED)
    import herald_api as api
    return importlib.reload(api)


FORBIDDEN_TABLES = {
    "profiles",
    "memories",
    "medical_records",
    "medical_contacts",
    "medication_log",
    "life_tracker",
    "life_moments",
    "learned_facts",
    "contacts",
    "conversations",
    "invites",
    "waitlist",
}


class Phase1CSeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = _load_api()
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient

    def setUp(self):
        handle, db_path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        self.db_path = db_path
        self.api.DB_FILE = db_path
        self.api.PROFILES_FILE = db_path + ".noprofiles"
        self.api.INVITES_FILE = db_path + ".noinvites"
        self.api.PHASE1C_SEED_SECRET = TEST_SEED
        self.api.GROWTH_DASHBOARD_SECRET = TEST_GROWTH
        self.api.WEBHOOK_SECRET = TEST_WEBHOOK
        self.api.init_db()
        self.client = self.TestClient(self.api.app)

    def tearDown(self):
        try:
            os.unlink(self.db_path)
        except OSError:
            pass

    def _auth(self, secret=TEST_SEED):
        return {"Authorization": f"Bearer {secret}"}

    def test_unauthenticated_is_401(self):
        r = self.client.get("/growth/phase1c-seed")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.headers.get("cache-control"), "no-store")

    def test_bogus_bearer_is_401(self):
        r = self.client.get("/growth/phase1c-seed", headers=self._auth("bogus-token-not-the-seed"))
        self.assertEqual(r.status_code, 401)

    def test_query_string_secret_cannot_authorize(self):
        r = self.client.get(f"/growth/phase1c-seed?secret={TEST_SEED}")
        self.assertEqual(r.status_code, 401)
        r2 = self.client.post(
            f"/growth/phase1c-seed?token={TEST_SEED}",
            json={"confirm": "create-PHASE1C_TEST"},
        )
        self.assertEqual(r2.status_code, 401)

    def test_webhook_secret_cannot_authorize(self):
        r = self.client.get("/growth/phase1c-seed", headers=self._auth(TEST_WEBHOOK))
        self.assertEqual(r.status_code, 401)

    def test_growth_dashboard_secret_cannot_authorize(self):
        r = self.client.post(
            "/growth/phase1c-seed",
            headers=self._auth(TEST_GROWTH),
            json={"confirm": "create-PHASE1C_TEST"},
        )
        self.assertEqual(r.status_code, 401)

    def test_wrong_confirmation_is_400(self):
        r = self.client.post(
            "/growth/phase1c-seed",
            headers=self._auth(),
            json={"confirm": "yes"},
        )
        self.assertEqual(r.status_code, 400)
        r2 = self.client.post(
            "/growth/phase1c-seed",
            headers=self._auth(),
            json={"confirm": "create-PHASE1C_TEST", "sql": "DROP TABLE waitlist"},
        )
        self.assertEqual(r2.status_code, 400)

    def test_exact_confirmation_creates_exact_chain_and_is_idempotent(self):
        missing = self.client.get("/growth/phase1c-seed", headers=self._auth())
        self.assertEqual(missing.status_code, 200)
        self.assertFalse(missing.json()["exists"])
        created = self.client.post(
            "/growth/phase1c-seed",
            headers=self._auth(),
            json={"confirm": "create-PHASE1C_TEST"},
        )
        self.assertEqual(created.status_code, 200)
        body = created.json()
        self.assertTrue(body["created"])
        self.assertTrue(body["exists"])
        self.assertEqual(body["code"], "PHASE1C_TEST")
        self.assertEqual(body["max_uses"], 1)
        self.assertEqual(body["active"], 1)
        self.assertIsInstance(body["partner_id"], int)
        self.assertIsInstance(body["campaign_id"], int)
        self.assertIsInstance(body["referral_link_id"], int)
        conn = sqlite3.connect(self.db_path)
        partner = conn.execute(
            "SELECT name, partner_type, status FROM partners WHERE id = ?",
            (body["partner_id"],),
        ).fetchone()
        campaign = conn.execute(
            "SELECT name, channel FROM campaigns WHERE id = ?",
            (body["campaign_id"],),
        ).fetchone()
        link = conn.execute(
            "SELECT code, code_type, max_uses, active FROM referral_links WHERE id = ?",
            (body["referral_link_id"],),
        ).fetchone()
        waitlist_n = conn.execute("SELECT COUNT(1) FROM waitlist").fetchone()[0]
        partner_n = conn.execute("SELECT COUNT(1) FROM partners").fetchone()[0]
        conn.close()
        self.assertEqual(partner, ("ApexEmpire Internal", "internal", "active"))
        self.assertEqual(campaign, ("Phase 1C Live Proof", "internal-test"))
        self.assertEqual(link, ("PHASE1C_TEST", "test", 1, 1))
        self.assertEqual(waitlist_n, 0)
        self.assertEqual(partner_n, 1)
        again = self.client.post(
            "/growth/phase1c-seed",
            headers=self._auth(),
            json={"confirm": "create-PHASE1C_TEST"},
        )
        self.assertEqual(again.status_code, 200)
        dup = again.json()
        self.assertFalse(dup["created"])
        self.assertEqual(dup["partner_id"], body["partner_id"])
        self.assertEqual(dup["campaign_id"], body["campaign_id"])
        self.assertEqual(dup["referral_link_id"], body["referral_link_id"])
        conn = sqlite3.connect(self.db_path)
        self.assertEqual(conn.execute("SELECT COUNT(1) FROM partners").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(1) FROM campaigns").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(1) FROM referral_links").fetchone()[0], 1)
        conn.close()

    def test_handlers_reject_arbitrary_sql_and_skip_personal_tables(self):
        src = API_PATH.read_text(encoding="utf-8")
        tree = ast.parse(src)
        names = {
            "growth_phase1c_seed_get",
            "growth_phase1c_seed_post",
            "_phase1c_seed_authorized",
            "_phase1c_chain_status",
            "_phase1c_seed_chain",
        }
        forbidden_calls = {
            "get_profile",
            "save_profile",
            "waitlist",
            "admin_waitlist",
            "admin_dashboard",
            "admin_find_user",
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name not in names:
                continue
            segment = ast.get_source_segment(src, node) or ""
            self.assertNotIn("query_params", segment)
            self.assertNotIn("execute(body", segment)
            self.assertNotIn("exec(", segment)
            for child in ast.walk(node):
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                    self.assertNotIn(child.func.id, forbidden_calls)
        seed_sql = ""
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_phase1c_seed_chain":
                seed_sql = ast.get_source_segment(src, node) or ""
        for table in FORBIDDEN_TABLES:
            self.assertNotIn(table, seed_sql.lower())
