"""Waitlist confirmation email copy. Does not call production SendGrid."""
from __future__ import annotations

import importlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TEST_ACCESS = "test-access-configured"
TEST_WEBHOOK = "test-webhook-configured"

EXPECTED_SUBJECT = "Welcome to the Herald early access list."
EXPECTED_BODY = (
    "Thanks for your interest in Herald.\n\n"
    "We've recorded your place on the Herald early access list.\n\n"
    "As Herald moves toward a safe, commercially ready beta, we'll invite a limited group of early users to try Herald and share their feedback.\n\n"
    "We'll contact you at this email address when we're ready.\n\n"
    "-- The Herald Team\napexempire.ai"
)


def _load_api():
    os.environ.setdefault("HERALD_ACCESS_CODE", TEST_ACCESS)
    os.environ.setdefault("WEBHOOK_SECRET", TEST_WEBHOOK)
    import herald_api as api
    return importlib.reload(api)


class WaitlistConfirmationCopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = _load_api()

    def test_confirmation_copy_and_from_unchanged(self):
        captured = {}

        def fake_urlopen(req, timeout=5):
            captured["url"] = req.full_url
            captured["payload"] = json.loads(req.data.decode("utf-8"))
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.__exit__.return_value = False
            return resp

        with patch.dict(os.environ, {"SENDGRID_API_KEY": "test-sendgrid-key"}):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                self.api._send_waitlist_confirmation("waitlist-copy-test@example.com")

        self.assertEqual(captured["url"], "https://api.sendgrid.com/v3/mail/send")
        payload = captured["payload"]
        self.assertEqual(payload["from"], {"email": "herald@apexempire.ai", "name": "Herald"})
        self.assertNotIn("reply_to", payload)
        self.assertEqual(payload["subject"], EXPECTED_SUBJECT)
        self.assertEqual(payload["content"][0]["type"], "text/plain")
        self.assertEqual(payload["content"][0]["value"], EXPECTED_BODY)
        self.assertEqual(payload["personalizations"][0]["to"][0]["email"], "waitlist-copy-test@example.com")

    def test_missing_sendgrid_key_does_not_send(self):
        with patch.dict(os.environ, {"SENDGRID_API_KEY": ""}, clear=False):
            os.environ["SENDGRID_API_KEY"] = ""
            with patch("urllib.request.urlopen") as mocked:
                self.api._send_waitlist_confirmation("waitlist-copy-test@example.com")
                mocked.assert_not_called()

    def test_sendgrid_failure_is_non_fatal(self):
        with patch.dict(os.environ, {"SENDGRID_API_KEY": "test-sendgrid-key"}):
            with patch("urllib.request.urlopen", side_effect=RuntimeError("network")):
                self.api._send_waitlist_confirmation("waitlist-copy-test@example.com")


if __name__ == "__main__":
    unittest.main()
