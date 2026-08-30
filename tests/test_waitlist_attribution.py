"""Waitlist growth attribution. Uses a temp SQLite DB. Does not call production SendGrid."""
from __future__ import annotations

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TEST_ACCESS = "test-access-configured"
TEST_WEBHOOK = "test-webhook-configured"


def _load_api():
    os.environ.setdefault("HERALD_ACCESS_CODE", TEST_ACCESS)
    os.environ.setdefault("WEBHOOK_SECRET", TEST_WEBHOOK)
    import herald_api as api
    return importlib.reload(api)


class WaitlistAttributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = _load_api()
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient

    def setUp(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.db_path = path
        self.api.DB_FILE = path
        self.api.PROFILES_FILE = path + ".noprofiles"
        self.api.INVITES_FILE = path + ".noinvites"
        self.api.init_db()
        conn = sqlite3.connect(path)
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
        conn.commit()
        conn.close()
        self.client = self.TestClient(self.api.app)
        self.send_calls = []

    def tearDown(self):
        try:
            os.unlink(self.db_path)
        except OSError:
            pass

    def _row(self, email):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT email, source, referral_code, visitor_id FROM waitlist WHERE email = ?",
            (email,),
        ).fetchone()
        conn.close()
        return row

    def _patch_sendgrid(self):
        def fake_urlopen(req, timeout=5):
            self.send_calls.append(json.loads(req.data.decode("utf-8")))
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.__exit__.return_value = False
            return resp
        return patch.dict(os.environ, {"SENDGRID_API_KEY": "test-sendgrid-key"}), patch(
            "urllib.request.urlopen", side_effect=fake_urlopen
        )

    def test_email_only_signup_records_organic(self):
        env, urlopen = self._patch_sendgrid()
        with env, urlopen:
            r = self.client.post("/waitlist", json={"email": "organic@example.com"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("status"), "ok")
        row = self._row("organic@example.com")
        self.assertEqual(row["source"], "organic")
        self.assertIsNone(row["referral_code"])
        self.assertIsNone(row["visitor_id"])
        self.assertEqual(len(self.send_calls), 1)

    def test_valid_referral_and_visitor_id_preserved(self):
        env, urlopen = self._patch_sendgrid()
        with env, urlopen:
            r = self.client.post("/waitlist", json={
                "email": "ref@example.com",
                "referral_code": "EXAMPLE",
                "visitor_id": "vid_abc12345",
            })
        self.assertEqual(r.status_code, 200)
        row = self._row("ref@example.com")
        self.assertEqual(row["referral_code"], "EXAMPLE")
        self.assertEqual(row["visitor_id"], "vid_abc12345")
        self.assertEqual(row["source"], "referral")
        self.assertEqual(len(self.send_calls), 1)

    def test_duplicate_cannot_overwrite_first_attribution(self):
        env, urlopen = self._patch_sendgrid()
        with env, urlopen:
            first = self.client.post("/waitlist", json={
                "email": "once@example.com",
                "referral_code": "EXAMPLE",
                "visitor_id": "vid_first001",
            })
            second = self.client.post("/waitlist", json={
                "email": "once@example.com",
                "referral_code": "OTHER",
                "visitor_id": "vid_second02",
                "source": "linkedin",
            })
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json().get("message"), "You are on the list.")
        row = self._row("once@example.com")
        self.assertEqual(row["referral_code"], "EXAMPLE")
        self.assertEqual(row["visitor_id"], "vid_first001")
        self.assertEqual(row["source"], "referral")
        self.assertEqual(len(self.send_calls), 1)

    def test_unknown_and_malformed_referral_fail_safe(self):
        env, urlopen = self._patch_sendgrid()
        with env, urlopen:
            unknown = self.client.post("/waitlist", json={
                "email": "unk@example.com",
                "referral_code": "NOTAREALCODE",
            })
            bad = self.client.post("/waitlist", json={
                "email": "bad@example.com",
                "referral_code": "no spaces allowed!!",
                "visitor_id": "short",
            })
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(bad.status_code, 200)
        unk = self._row("unk@example.com")
        self.assertIsNone(unk["referral_code"])
        self.assertEqual(unk["source"], "organic")
        bad_row = self._row("bad@example.com")
        self.assertIsNone(bad_row["referral_code"])
        self.assertIsNone(bad_row["visitor_id"])
        self.assertEqual(bad_row["source"], "organic")

    def test_legacy_waitlist_rows_survive_schema_upgrade(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            conn = sqlite3.connect(path)
            conn.execute(
                """
                CREATE TABLE waitlist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    source TEXT DEFAULT 'landing',
                    created_at TEXT DEFAULT (datetime('now'))
                )
                """
            )
            conn.execute(
                "INSERT INTO waitlist (email, source) VALUES (?, ?)",
                ("legacy@example.com", "landing"),
            )
            conn.commit()
            c = conn.cursor()
            self.api._ensure_growth_attribution_schema(c)
            conn.commit()
            cols = {row[1] for row in conn.execute("PRAGMA table_info(waitlist)").fetchall()}
            self.assertIn("referral_code", cols)
            self.assertIn("visitor_id", cols)
            row = conn.execute(
                "SELECT email, source, referral_code, visitor_id FROM waitlist WHERE email = ?",
                ("legacy@example.com",),
            ).fetchone()
            self.assertEqual(row[0], "legacy@example.com")
            self.assertEqual(row[1], "landing")
            self.assertIsNone(row[2])
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            self.assertIn("partners", tables)
            self.assertIn("campaigns", tables)
            self.assertIn("referral_links", tables)
            conn.close()
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
