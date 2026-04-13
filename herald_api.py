# herald_api.py
# Herald PWA Backend -- Railway Cloud Server
# v3.0 -- smart web search routing + maps/phone actions + OpenAI TTS
#
# Environment variables required in Railway dashboard:
#   OPENROUTER_API_KEY  = your sk-or-... key
#   OPENAI_API_KEY      = your sk-... OpenAI key (for TTS voice)
#   HERALD_ACCESS_CODE  = code for regular users (herald2026)
#   HERALD_OWNER_CODE   = your personal code (miked2026) -- gets Freddie data
#   HERALD_OWNER_ID     = your laptop device user_id (optional fallback)

import os
import json
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT           = int(os.environ.get("PORT", 8080))
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENAI_KEY     = os.environ.get("OPENAI_API_KEY", "")
ACCESS_CODE    = os.environ.get("HERALD_ACCESS_CODE", "herald2026")
OWNER_CODE     = os.environ.get("HERALD_OWNER_CODE", "")
OWNER_ID       = os.environ.get("HERALD_OWNER_ID", "")
OR_URL         = "https://openrouter.ai/api/v1/chat/completions"
TTS_URL        = "https://api.openai.com/v1/audio/speech"
EMPIRE_URL     = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"

# Two models: only pay for web search when the query actually needs live data
MODEL_SEARCH = "anthropic/claude-haiku-4-5:online"  # live web search -- $0.02/call
MODEL_FAST   = "anthropic/claude-haiku-4-5"          # no web search  -- ~$0.005/call

# Keywords that require live web data -- everything else uses MODEL_FAST
LIVE_KEYWORDS = [
    'weather', 'forecast', 'temperature', 'rain', 'snow', 'sunny', 'humid', 'wind',
    'news', 'headline', 'breaking', 'latest', 'happening', 'update',
    'open', 'closed', 'hours', 'close at', 'open till', 'open until', 'still open',
    'near me', 'nearby', 'closest', 'around here', 'around me',
    'restaurant', 'coffee', 'cafe', 'bar', 'grocery', 'pharmacy', 'gas station',
    'today', 'tonight', 'right now', 'currently', 'live',
    'price', 'stock', 'bitcoin', 'crypto', 'market', 'rate', 'exchange rate',
    'score', 'standings', 'playoffs', 'game today', 'match',
    'traffic', 'delay', 'construction',
]

user_profiles  = {}
owner_user_ids = set()


def needs_web_search(message):
    msg_lower = message.lower()
    return any(kw in msg_lower for kw in LIVE_KEYWORDS)


def get_profile(user_id):
    return user_profiles.get(user_id, {
        "name": "", "ai_name": "Herald", "location": "", "notes": []
    })


def save_profile(user_id, profile):
    user_profiles[user_id] = profile


def is_owner(user_id):
    return user_id in owner_user_ids or (OWNER_ID and user_id == OWNER_ID)


def fetch_empire():
    try:
        req = urllib.request.Request(EMPIRE_URL, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def build_empire_context(empire):
    if not empire:
        return "FREDDIE TRADING: Empire data unavailable right now."
    lines = []
    lines.append(f"FREDDIE TRADING STATUS (synced {empire.get('updated_at','unknown')}):")
    lines.append(f"Mode: {empire.get('mode','unknown')} | Bankroll: ${empire.get('bankroll',0)} | Regime: {empire.get('regime','unknown')}")
    lines.append(f"Gate: {empire.get('gate_progress','0/70')} clean trades | Win rate: {empire.get('win_rate',0)}% | P&L: ${empire.get('total_pnl',0)}")
    lines.append(f"All agents: {empire.get('all_agents','unknown')} | VM: {empire.get('vm_health','unknown')}")
    positions = empire.get("open_positions", [])
    if positions:
        lines.append(f"OPEN POSITIONS ({len(positions)}):")
        for p in positions:
            lines.append(f"  {p.get('trade_id','')} {p.get('asset','')} {p.get('direction','')} | entry ${p.get('entry',0)} | stop ${p.get('stop',0)} | target ${p.get('target',0)} | grade {p.get('grade','')}")
    else:
        lines.append("OPEN POSITIONS: None -- flat right now")
    lines.append("")
    lines.append("CRITICAL CONTEXT -- read before answering anything about trades:")
    lines.append("All trades before April 4 2026 are contaminated by execution bugs now fixed.")
    lines.append("The 0% win rate reflects contaminated data -- do NOT present it as signal failure.")
    lines.append("The signal is proven -- 77% SHORT win rate in pre-fix paper trades.")
    lines.append("Never tell miked the system is failing. It is working. Accumulating clean reps.")
    return "\n".join(lines)


def build_system(profile, local_time=None, owner=False, empire=None, lat=None, lng=None):
    now     = local_time or datetime.now().strftime("%A, %B %d %Y %I:%M %p")
    name    = profile.get("name", "")
    ai_name = profile.get("ai_name", "Herald")
    location= profile.get("location", "")
    notes   = profile.get("notes", [])

    user_line = f"User's name: {name}." if name else "User name not yet learned."

    if lat and lng:
        loc_line = (
            f"User's current GPS coordinates: {lat}, {lng}. "
            f"Use these for any 'near me' or location queries."
        )
        if location:
            loc_line += f" Home city: {location}."
    elif location:
        loc_line = f"User is located in {location}."
    else:
        loc_line = "Location not yet learned -- ask naturally when relevant."

    notes_line     = ("Things you know about this user: " + "; ".join(notes[-10:])) if notes else "No personal notes yet."
    empire_section = f"\n\n{build_empire_context(empire)}" if owner and empire else ""

    return f"""You are {ai_name} -- a trusted personal AI companion.

{user_line}
{loc_line}
{notes_line}

Current time: {now}{empire_section}

YOUR RULES:
- Speak like a smart, warm friend. 2-3 sentences unless more detail is asked for.
- Never use asterisks, markdown, bullet points, or raw URLs in responses.
- Answer any question -- weather, sports, restaurants, travel, health, general knowledge.
- When you learn something new about the user, note it naturally.
- Be honest even when uncomfortable. Never make things up.
- Use GPS coordinates for location queries if provided -- they are exact and current.
- Never mention that you are Claude or built on any particular model.
- You are {ai_name}. That is your identity.

ACTION TAGS -- append silently at end of reply when relevant, never explain them:
- User asks for directions or navigation: append on new line: MAPS: [destination name and city]
- Your reply mentions a phone number user might call: append on new line: PHONE: [digits only]
- Only one action tag per response maximum."""


def parse_action(reply):
    """Strip action tags from the reply. Returns (clean_reply, action_dict or None)."""
    for tag, atype in [('MAPS:', 'maps'), ('PHONE:', 'phone')]:
        if tag in reply:
            parts = reply.split(tag, 1)
            clean = parts[0].strip()
            value = parts[1].strip().split('\n')[0].strip()
            return clean, {'type': atype, 'value': value}
    return reply, None


def call_openrouter(messages, use_search=True):
    if not OPENROUTER_KEY:
        return "Configuration error: API key not set on server."
    model   = MODEL_SEARCH if use_search else MODEL_FAST
    payload = json.dumps({"model": model, "max_tokens": 600, "messages": messages}).encode("utf-8")
    req = urllib.request.Request(OR_URL, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "HTTP-Referer": "https://apexempire.ai",
        "X-Title": "Herald Personal AI"
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        return f"API error {e.code}: {e.read().decode('utf-8')[:200]}"
    except Exception as e:
        return f"Connection error: {str(e)}"


def text_to_speech(text):
    """Call OpenAI TTS API. Returns MP3 bytes or None on failure."""
    if not OPENAI_KEY:
        return None
    payload = json.dumps({
        "model": "tts-1",
        "input": text[:4096],
        "voice": "nova",
        "response_format": "mp3"
    }).encode("utf-8")
    req = urllib.request.Request(TTS_URL, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_KEY}"
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read()
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json({
                "status": "ok", "server": "herald-api", "version": "3.0",
                "tts": "enabled" if OPENAI_KEY else "disabled -- add OPENAI_API_KEY",
                "time": datetime.now().isoformat()
            })
        elif self.path.startswith("/empire"):
            self._json(fetch_empire() or {"error": "empire data unavailable"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            self._json({"error": "invalid JSON"}, 400)
            return

        if self.path == "/auth":
            code    = data.get("code", "").strip()
            user_id = data.get("user_id", "").strip()
            valid   = [ACCESS_CODE]
            if OWNER_CODE:
                valid.append(OWNER_CODE)
            if code not in valid:
                self._json({"error": "invalid code"}, 401)
                return
            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return
            if OWNER_CODE and code == OWNER_CODE:
                owner_user_ids.add(user_id)
            profile = get_profile(user_id)
            self._json({
                "ok": True, "user_id": user_id,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "onboarded": bool(profile.get("name")),
                "is_owner": is_owner(user_id)
            })

        elif self.path == "/ask":
            user_id    = data.get("user_id", "").strip()
            message    = data.get("message", "").strip()
            history    = data.get("history", [])
            local_time = data.get("local_time", None)
            lat        = data.get("lat", None)
            lng        = data.get("lng", None)

            if not user_id or not message:
                self._json({"error": "user_id and message required"}, 400)
                return

            owner     = is_owner(user_id)
            empire    = fetch_empire() if owner else None
            profile   = get_profile(user_id)
            system    = build_system(profile, local_time, owner, empire, lat, lng)
            messages  = [{"role": "system", "content": system}]
            messages += history[-20:]
            messages.append({"role": "user", "content": message})

            use_search = needs_web_search(message)
            raw_reply  = call_openrouter(messages, use_search=use_search)
            reply, action = parse_action(raw_reply)

            msg_lower = message.lower()
            if "my name is" in msg_lower:
                try:
                    profile["name"] = message.split("my name is", 1)[1].strip().split()[0].rstrip(".,!?")
                except Exception: pass
            if "i live in" in msg_lower or "i'm in " in msg_lower or "i am in " in msg_lower:
                try:
                    key = "i live in" if "i live in" in msg_lower else "i'm in" if "i'm in" in msg_lower else "i am in"
                    profile["location"] = message.split(key, 1)[1].strip().split(",")[0].strip().rstrip(".,!?")
                except Exception: pass
            if "call you" in msg_lower or "your name is" in msg_lower:
                try:
                    key = "call you" if "call you" in msg_lower else "your name is"
                    profile["ai_name"] = message.split(key, 1)[1].strip().split()[0].rstrip(".,!?").title()
                except Exception: pass

            save_profile(user_id, profile)
            self._json({
                "reply": reply, "action": action,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "used_search": use_search
            })

        elif self.path == "/tts":
            user_id = data.get("user_id", "").strip()
            text    = data.get("text", "").strip()
            if not user_id or not text:
                self._json({"error": "user_id and text required"}, 400)
                return
            audio = text_to_speech(text)
            if not audio:
                self._json({"error": "TTS unavailable"}, 503)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.cors()
            self.end_headers()
            self.wfile.write(audio)

        elif self.path == "/profile":
            user_id = data.get("user_id", "").strip()
            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return
            profile = get_profile(user_id)
            for field in ["name", "ai_name", "location"]:
                if field in data:
                    profile[field] = data[field]
            save_profile(user_id, profile)
            self._json({"ok": True, "profile": profile})

        else:
            self._json({"error": "not found"}, 404)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"[HERALD API v3.0] Starting on port {PORT}")
    print(f"[HERALD API] OpenRouter: {'YES' if OPENROUTER_KEY else 'MISSING'}")
    print(f"[HERALD API] OpenAI TTS: {'YES' if OPENAI_KEY else 'MISSING -- add OPENAI_API_KEY to Railway'}")
    print(f"[HERALD API] Access code: {ACCESS_CODE}")
    print(f"[HERALD API] Owner code:  {'SET' if OWNER_CODE else 'NOT SET'}")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
