# herald_api.py v3.0
# Added: web search for live questions (prices, hours, news, weather)
import os, json, requests
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT     = int(os.environ.get("PORT", 8080))
EMPIRE_URL = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
OR_KEY   = os.environ.get("OPENROUTER_API_KEY", "")
MODEL    = "google/gemini-2.5-flash-lite"
MODEL_SEARCH = "google/gemini-2.5-flash-lite:online"

# Keywords that signal the question needs live web data
SEARCH_TRIGGERS = [
    "open", "closed", "hours", "near me", "near my",
    "weather", "price", "news", "latest", "today",
    "right now", "current", "score", "traffic",
    "restaurant", "store", "hotel", "flight",
    "what time", "when does", "is there",
]

def needs_search(message):
    msg = message.lower()
    return any(trigger in msg for trigger in SEARCH_TRIGGERS)

def get_empire():
    try:
        return requests.get(EMPIRE_URL, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}

def build_system(empire):
    now = datetime.now().strftime("%Y-%m-%d %H:%M CST")
    ctx = (
        f"Mode:{empire.get('mode')} "
        f"Bankroll:${empire.get('bankroll', 350)} "
        f"Regime:{empire.get('regime')} "
        f"WR:{empire.get('win_rate', 0)}% "
        f"Gate:{empire.get('gate_progress')} "
        f"Positions:{empire.get('open_count', 0)} "
        f"VM:{empire.get('vm_health')} "
        f"LastScan:{empire.get('last_scan')}"
    )
    return (
        f"You are HERALD, miked's personal AI agent for the APEX Empire. "
        f"Time: {now}. "
        f"Empire data (hourly sync): {ctx}. "
        f"CRITICAL CONTEXT: The 0/6 win rate in empire data is contaminated by "
        f"two mechanical bugs fixed April 2 2026. Do NOT interpret as signal failure. "
        f"The SHORT signal showed 77% win rate pre-fix. Clean data clock started April 2. "
        f"Be direct and conversational. Answer any question including non-empire topics. "
        f"For live questions use your search capability. Never invent prices or hours."
    )

def ask(message, empire):
    if not OR_KEY:
        return "Herald API key not configured."
    model = MODEL_SEARCH if needs_search(message) else MODEL
    sys   = build_system(empire)
    try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OR_KEY}",
                "Content-Type":  "application/json"
            },
            json={
                "model":    model,
                "messages": [
                    {"role": "system",  "content": sys},
                    {"role": "user",    "content": message}
                ],
                "max_tokens": 500
            },
            timeout=30
        )
        data = r.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Error: {e}"

class H(BaseHTTPRequestHandler):
    def log_message(self, f, *a): pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.ok({"status": "ok", "herald": "online", "version": "3.0",
                     "time": datetime.now().isoformat()})
        elif self.path == "/empire":
            self.ok(get_empire())
        else:
            self.ok({"status": "ok", "message": "Herald API v3.0 online"})

    def do_POST(self):
        n      = int(self.headers.get("Content-Length", 0))
        b      = json.loads(self.rfile.read(n).decode())
        empire = get_empire()

        if self.path == "/ask":
            msg = b.get("message", "").strip()
            if not msg:
                self.ok({"error": "empty"}, 400)
                return
            search_used = needs_search(msg)
            response    = ask(msg, empire)
            self.ok({"response": response, "ok": True,
                     "search_used": search_used})

        elif self.path == "/command":
            cmd = b.get("command", "").strip()
            self.ok({"response": ask(f"Command: {cmd}", empire),
                     "command": cmd, "ok": True})
        else:
            self.ok({"error": "not found"}, 404)

    def ok(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    print(f"[HERALD] v3.0 | port {PORT} | key {'SET' if OR_KEY else 'NOT SET'}")
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()