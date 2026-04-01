# herald_api.py v2.0
import os, json, requests
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT = int(os.environ.get("PORT", 8080))
EMPIRE_URL = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
OR_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "google/gemini-2.5-flash-lite"

def get_empire():
    try:
        return requests.get(EMPIRE_URL, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}

def ask(message, empire):
    if not OR_KEY:
        return "Herald API key not configured."
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    ctx = f"Mode:{empire.get('mode')} Bankroll:${empire.get('bankroll',350)} Regime:{empire.get('regime')} WR:{empire.get('win_rate',0)}% Gate:{empire.get('gate_progress')} Positions:{empire.get('open_count',0)} VM:{empire.get('vm_health')} LastScan:{empire.get('last_scan')}"
    sys = f"You are HERALD, miked's personal AI agent. Empire data (hourly sync): {ctx}. Be direct and conversational. Answer any question. Data may be up to 1hr old. Time: {now}"
    try:
        r = requests.post("https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization":f"Bearer {OR_KEY}","Content-Type":"application/json"},
            json={"model":MODEL,"messages":[{"role":"system","content":sys},{"role":"user","content":message}],"max_tokens":500},
            timeout=30)
        return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Error: {e}"

class H(BaseHTTPRequestHandler):
    def log_message(self, f, *a): pass
    def cors(self):
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
    def do_OPTIONS(self):
        self.send_response(200); self.cors(); self.end_headers()
    def do_GET(self):
        if self.path=="/health": self.ok({"status":"ok","herald":"online","time":datetime.now().isoformat()})
        elif self.path=="/empire": self.ok(get_empire())
        else: self.ok({"status":"ok","message":"Herald API online"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length",0))
        b = json.loads(self.rfile.read(n).decode())
        empire = get_empire()
        if self.path=="/ask":
            msg = b.get("message","").strip()
            if not msg: self.ok({"error":"empty"},400); return
            self.ok({"response":ask(msg,empire),"ok":True})
        elif self.path=="/command":
            cmd = b.get("command","").strip()
            self.ok({"response":ask(f"Command: {cmd}. Status: {json.dumps(empire)}",empire),"command":cmd,"ok":True})
        else: self.ok({"error":"not found"},404)
    def ok(self, data, code=200):
        body=json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.cors(); self.end_headers(); self.wfile.write(body)

if __name__=="__main__":
    print(f"[HERALD] port {PORT} key {'SET' if OR_KEY else 'NOT SET'}")
    HTTPServer(("0.0.0.0",PORT),H).serve_forever()
