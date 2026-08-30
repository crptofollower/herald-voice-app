"""Founder-only growth dashboard. Waitlist tables only. Temp SQLite. No SendGrid."""
from __future__ import annotations

import ast
import csv
import importlib
import io
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


def _load_api():
    os.environ.setdefault("HERALD_ACCESS_CODE", TEST_ACCESS)
    os.environ.setdefault("WEBHOOK_SECRET", TEST_WEBHOOK)
    os.environ.setdefault("GROWTH_DASHBOARD_SECRET", TEST_GROWTH)
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
}

ALLOWED_GROWTH_TABLES = {"waitlist", "partners", "campaigns", "referral_links"}


class GrowthDashboardTests(unittest.TestCase):
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
        self.api.GROWTH_DASHBOARD_SECRET = TEST_GROWTH
        self.api.WEBHOOK_SECRET = TEST_WEBHOOK
        self.api.init_db()
        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT INTO partners (name, partner_type, status) VALUES (?, ?, ?)",
            ("Example Partner", "community", "active"),
        )
        conn.execute(
            "INSERT INTO campaigns (partner_id, name, channel) VALUES (?, ?, ?)",
            (1, "Example Campaign", "event"),
        )
        conn.execute(
            """
            INSERT INTO referral_links (campaign_id, code, code_type, max_uses, active)
            VALUES (?, ?, ?, ?, ?)
            """,
            (1, "EXAMPLE", "link", None, 1),
        )
        conn.execute(
            """
            INSERT INTO waitlist (email, source, referral_code, visitor_id, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            """,
            ("ref@example.com", "referral", "EXAMPLE", "vid_abc12345"),
        )
        conn.execute(
            """
            INSERT INTO waitlist (email, source, referral_code, visitor_id, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            """,
            ("organic@example.com", "organic", None, "vid_org12345"),
        )
        conn.execute(
            """
            INSERT INTO waitlist (email, source, referral_code, visitor_id, created_at)
            VALUES (?, ?, ?, ?, datetime('now', '-30 days'))
            """,
            ("old@example.com", "landing", None, None),
        )
        conn.commit()
        conn.close()
        self.client = self.TestClient(self.api.app)

    def tearDown(self):
        try:
            os.unlink(self.db_path)
        except OSError:
            pass

    def _auth(self, secret=TEST_GROWTH):
        return {"Authorization": f"Bearer {secret}"}

    def _assert_no_store(self, response):
        self.assertEqual(response.headers.get("cache-control"), "no-store")

    def test_unauthorized_without_header(self):
        r = self.client.get("/growth/summary")
        self.assertEqual(r.status_code, 401)
        self._assert_no_store(r)

    def test_growth_routes_send_cache_control_no_store(self):
        for path in ("/growth/summary", "/growth/signups", "/growth/export.csv"):
            denied = self.client.get(path)
            self.assertEqual(denied.status_code, 401)
            self._assert_no_store(denied)
            ok = self.client.get(path, headers=self._auth())
            self.assertEqual(ok.status_code, 200)
            self._assert_no_store(ok)

    def test_query_string_secret_rejected(self):
        r = self.client.get(f"/growth/summary?secret={TEST_GROWTH}")
        self.assertEqual(r.status_code, 401)
        r2 = self.client.get(f"/growth/signups?token={TEST_GROWTH}")
        self.assertEqual(r2.status_code, 401)
        r3 = self.client.get(f"/growth/export.csv?secret={TEST_GROWTH}")
        self.assertEqual(r3.status_code, 401)

    def test_webhook_secret_cannot_open_growth(self):
        r = self.client.get("/growth/summary", headers=self._auth(TEST_WEBHOOK))
        self.assertEqual(r.status_code, 401)

    def test_fails_closed_when_growth_secret_unset(self):
        self.api.GROWTH_DASHBOARD_SECRET = ""
        r = self.client.get("/growth/summary", headers=self._auth(TEST_GROWTH))
        self.assertEqual(r.status_code, 401)

    def test_authorized_founder_retrieves_summary(self):
        r = self.client.get("/growth/summary", headers=self._auth())
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["new_last_7_days"], 2)
        self.assertEqual(data["organic"], 2)
        self.assertEqual(data["referred"], 1)
        self.assertEqual(
            data["by_referral_code"],
            [{"referral_code": "EXAMPLE", "count": 1}],
        )
        self.assertEqual(
            data["by_partner_campaign"],
            [{"partner": "Example Partner", "campaign": "Example Campaign", "count": 1}],
        )

    def test_authorized_founder_retrieves_waitlist_rows(self):
        r = self.client.get("/growth/signups", headers=self._auth())
        self.assertEqual(r.status_code, 200)
        entries = r.json()["entries"]
        self.assertEqual(r.json()["count"], 3)
        by_email = {row["email"]: row for row in entries}
        referred = by_email["ref@example.com"]
        self.assertEqual(referred["source"], "referral")
        self.assertEqual(referred["referral_code"], "EXAMPLE")
        self.assertEqual(referred["partner"], "Example Partner")
        self.assertEqual(referred["campaign"], "Example Campaign")
        organic = by_email["organic@example.com"]
        self.assertEqual(organic["source"], "organic")
        self.assertIsNone(organic["referral_code"])
        self.assertIsNone(organic["partner"])
        self.assertIsNone(organic["campaign"])

    def test_csv_export(self):
        r = self.client.get("/growth/export.csv", headers=self._auth())
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers.get("content-type", ""))
        parsed = list(csv.reader(io.StringIO(r.text)))
        self.assertEqual(
            parsed[0],
            ["signup_date", "email", "source", "referral_code", "partner", "campaign"],
        )
        body = parsed[1:]
        emails = {row[1] for row in body}
        self.assertEqual(emails, {"ref@example.com", "organic@example.com", "old@example.com"})
        ref_row = next(row for row in body if row[1] == "ref@example.com")
        self.assertEqual(ref_row[2:], ["referral", "EXAMPLE", "Example Partner", "Example Campaign"])
        org_row = next(row for row in body if row[1] == "organic@example.com")
        self.assertEqual(org_row[2:], ["organic", "", "", ""])

    def test_growth_sql_does_not_touch_personal_tables(self):
        sql = self.api._GROWTH_SIGNUPS_SQL.lower()
        for table in FORBIDDEN_TABLES:
            self.assertNotIn(table, sql)
        for table in ALLOWED_GROWTH_TABLES:
            self.assertIn(table, sql)

    def test_growth_handlers_do_not_call_personal_routes(self):
        tree = ast.parse(API_PATH.read_text(encoding="utf-8"))
        growth_names = {
            "growth_summary",
            "growth_signups",
            "growth_export_csv",
            "_growth_signup_rows",
            "_growth_summary_from_rows",
            "_growth_csv_bytes",
            "_growth_founder_authorized",
        }
        forbidden_calls = {
            "get_profile",
            "save_profile",
            "waitlist_list",
            "admin_waitlist",
            "admin_dashboard",
            "admin_user",
            "admin_proactive",
            "admin_clear_profile_field",
            "admin_set_profile_field",
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name not in growth_names:
                continue
            for child in ast.walk(node):
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                    self.assertNotIn(child.func.id, forbidden_calls)

    def test_growth_secret_not_read_from_query_in_source(self):
        tree = ast.parse(API_PATH.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            if node.name not in {
                "growth_summary",
                "growth_signups",
                "growth_export_csv",
                "_growth_founder_authorized",
            }:
                continue
            src = ast.get_source_segment(API_PATH.read_text(encoding="utf-8"), node) or ""
            self.assertNotIn("query_params", src)
            self.assertNotIn("secret: str", src)
