# herald_api.py
# Herald Cloud API -- runs on Railway
# Version 2.0 -- 2026-04-01

import os
import json
import requests
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT = int(os.environ.get("PORT", 8080))

EMPIRE_STATUS_URL = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "google/gemini-2.5-flash-lite"


def fetch_empire_status():
    try:
        r = requests.get(EMPIRE_STATUS_URL, timeout=10)
        return r.json()
    except Exception as e:
        return {"error": str(e), "note": "Empire status unavailable"}


def ask_herald(message, empire_data):
    if not OPENROUTER_KEY:
        return "Herald API key not configured."

    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    ctx = f"""
EMPIRE STATUS ({now}):
Mode: {empire_data.get('mode', 'UNKNOWN')}
Bankroll: ${empire_data.get('bankroll', 0)}
Regime: {empire_data.get('regime', 'UNKNOWN')}
Win Rate: {empire_data.get('win_rate', 0)}%
Gate: {empire_data.get('gate_progress', '?')}
Open Positions: {empire_data.get('open_count', 0)}
VM Health: {empire_data.get('vm_health', 'unknown')}
Last Scan: {empire_data.get('last_scan', 'unknown')}
Last Chain: {empire_data.get('last_chain_run', 'unknown')}
"""

    positions = empire_data.get('open_positions', [])
    if positions:
        ctx += "\nOPEN POSITIONS:\n"
        for p in positions:
            ctx += f"  {p.get('trade_id')} {p.get('asset')} {p.get('direction')} @ ${p.get('entry')}\n"

    system_prompt = f"""You are HERALD -- miked's personal AI and empire intelligence interface.
Be direct, honest, and conversational. Speak like a trusted advisor.

WHAT YOU KNOW (from last hourly sync):
{ctx}

BE HONEST: trade state is up to 1 hour old. You cannot confirm live prices or swarm status.
Say "as of my last sync" when discussing live data.
For general questions (weather, travel, recommendations) use your knowledge and help.
Keep responses under 4 sentences unless more detail is needed.
No bullet points unless asked. No markdown.

Current time: {now}"""

    try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://crptofollower.github.io/herald-voice-app",
                "X-Title": "Herald Empire"
            },
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": message}
                ],
                "max_tokens": 500
            },
            timeout=30
        )
        data = r.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Herald encountered an error: {e}"


class HeraldHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "herald": "online", "time": datetime.now().isoformat()})
        elif self.path == "/empire":
            self._json(fetch_empire_status())
        else:
            self._json({"status": "ok", "message": "Herald API online"})

    def do_POST(self):
        if self.path == "/ask":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode("utf-8"))
                message = data.get("message", "").strip()
                if not message:
                    self._json({"error": "empty message"}, 400)
                    return
                empire = fetch_empire_status()
                response = ask_herald(message, empire)
                self._json({"response": response, "ok": True})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif self.path == "/command":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode("utf-8"))
                command = data.get("command", "").strip().lower()
                empire = fetch_empire_status()
                prompt = f"The user ran command: '{command}'. Empire status: {json.dumps(empire)}. Confirm what action this triggers and summarize current empire state in 2-3 sentences."
                response = ask_herald(prompt, empire)
                self._json({"response": response, "command": command, "ok": True})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"[HERALD API] Starting on port {PORT}")
    print(f"[HERALD API] OpenRouter key: {'SET' if OPENROUTER_KEY else 'NOT SET'}")
    server = HTTPServer(("0.0.0.0", PORT), HeraldHandler)
    server.serve_forever()
# Herald Cloud API -- runs on Railway
# Handles natural language questions via Claude
# Reads empire_status.json from GitHub for trading data
# Version 1.0 -- 2026-03-29

import os
import json
import requests
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT = int(os.environ.get("PORT", 8080))

# GitHub raw URL for empire status -- updated by laptop after every scan
EMPIRE_STATUS_URL = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"

# OpenRouter API
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "google/gemini-2.5-flash-lite"

def fetch_empire_status():
    """Fetch latest empire status from GitHub."""
    try:
        r = requests.get(EMPIRE_STATUS_URL, timeout=10)
        return r.json()
    except Exception as e:
        return {"error": str(e), "note": "Empire status unavailable"}

def ask_herald(message, empire_data):
    """Send message to Claude with empire context."""
    if not OPENROUTER_KEY:
        return "Herald API key not configured. Contact miked."

    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    # Build empire context
    ctx = f"""
EMPIRE STATUS ({now}):
Mode: {empire_data.get('mode', 'UNKNOWN')}
Bankroll: ${empire_data.get('bankroll', 0)}
Regime: {empire_data.get('regime', 'UNKNOWN')}
Win Rate: {empire_data.get('win_rate', 0)}%
Gate: {empire_data.get('gate_progress', '?')}
Open Positions: {empire_data.get('open_count', 0)}
"""
    positions = empire_data.get('open_positions', [])
    if positions:
        ctx += "\nOPEN POSITIONS:\n"
        for p in positions:
            ctx += f"  {p.get('trade_id')} {p.get('asset')} {p.get('direction')} @ ${p.get('entry')}\n"

    system_prompt = f"""You are HERALD -- miked's personal AI and empire intelligence interface.

You are direct, honest, and conversational. You speak like a trusted advisor not a dashboard.

WHAT YOU KNOW RIGHT NOW (from last hourly sync):
{ctx}

IMPORTANT -- BE HONEST ABOUT WHAT YOU KNOW VS DON'T KNOW:
- Trade state, positions, win rate: from last sync -- up to 1 hour old
- Whether swarm_chain is actively running right now: YOU DON'T KNOW -- say so
- Live prices: YOU DON'T KNOW -- your data is from the last sync
- Agent heartbeats: NOT AVAILABLE YET -- future build
- If asked about something you cannot confirm: say "last I knew..." or "as of my last sync..."

HOW TO RESPOND:
- Be conversational. No bullet points unless asked.
- Lead with the most important thing.
- If something needs attention, say it directly.
- For general questions (weather, travel, recommendations): use your knowledge and help.
- Never say "I cannot help" -- always find a way to be useful.
- Keep responses under 4 sentences unless more detail is needed.

Current date/time: {now}
"""

try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://crptofollower.github.io/herald-voice-app",
                "X-Title": "Herald Empire"
            },
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": message}
                ],
                "max_tokens": 500
            },
            timeout=30
        )
        data = r.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Herald encountered an error: {e}"

class HeraldHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # suppress noisy logs

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "herald": "online", "time": datetime.now().isoformat()})
        elif self.path == "/empire":
            self._json(fetch_empire_status())
        else:
            self._json({"status": "ok", "message": "Herald API online"})

    def do_POST(self):
        if self.path == "/ask":
            length = int(self.headers.get("Content-Length", 0))
            body   = self.rfile.read(length)
            try:
                data    = json.loads(body.decode("utf-8"))
                message = data.get("message", "").strip()
                if not message:
                    self._json({"error": "empty message"}, 400)
                    return
                empire  = fetch_empire_status()
                response = ask_herald(message, empire)
                self._json({"response": response, "ok": True})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif self.path == "/command":
            length = int(self.headers.get("content-length", 0))
            body   = self.rfile.read(length)
            try:
                data    = json.loads(body.decode("utf-8"))
                command = data.get("command", "").strip().lower()
                empire  = fetch_empire_status()
                prompt  = f"the user ran command: '{command}'. empire status: {json.dumps(empire)}. confirm what action this triggers and summarize current empire state in 2-3 sentences."
                response = ask_herald(prompt, empire)
                self._json({"response": response, "command": command, "ok": True})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)

    def _json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    print(f"[HERALD API] Starting on port {PORT}")
    print(f"[HERALD API] OpenRouter key: {'SET' if OPENROUTER_KEY else 'NOT SET'}")
    server = HTTPServer(("0.0.0.0", PORT), HeraldHandler)
    server.serve_forever()