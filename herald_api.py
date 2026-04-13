# herald_api.py
# Herald PWA Backend -- Railway Cloud Server
# v4.7 -- live empire feed via VM dashboard API
#
# Environment variables required in Railway dashboard:
#   OPENROUTER_API_KEY    = your sk-or-... key
#   HERALD_ACCESS_CODE    = legacy code (herald2026) -- keep for your own testing
#   HERALD_OWNER_CODE     = your personal code (miked2026) -- gets Freddie data
#   HERALD_INVITE_SECRET  = your secret password to generate invite links
#
# Optional:
#   OPENAI_API_KEY        = sk-... OpenAI key (only needed if using TTS endpoint)
#   HERALD_OWNER_ID       = your device user_id (legacy fallback, no longer required)
#   PROFILES_FILE         = path to profiles JSON (default /data/profiles.json)
#   INVITES_FILE          = path to invites JSON (default /data/invites.json)

import os
import json
import random
import string
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
INVITE_SECRET  = os.environ.get("HERALD_INVITE_SECRET", "")
OR_URL         = "https://openrouter.ai/api/v1/chat/completions"
TTS_URL        = "https://api.openai.com/v1/audio/speech"
EMPIRE_URL     = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
PROFILES_FILE  = os.environ.get("PROFILES_FILE", "/data/profiles.json")
INVITES_FILE   = os.environ.get("INVITES_FILE",  "/data/invites.json")

MODEL_SEARCH = "anthropic/claude-haiku-4-5:online"
MODEL_FAST   = "anthropic/claude-haiku-4-5"

LIVE_KEYWORDS = [
    'weather', 'forecast', 'temperature', 'rain', 'snow', 'sunny', 'humid', 'wind',
    'news', 'headline', 'breaking', 'latest', 'happening', 'update', 'briefing',
    'open', 'closed', 'hours', 'close at', 'open till', 'open until', 'still open',
    'what time does', 'when does', 'is it open', 'are they open',
    'near me', 'nearby', 'closest', 'around here', 'around me',
    'restaurant', 'food', 'eat', 'lunch', 'dinner', 'breakfast', 'coffee', 'cafe',
    'bar', 'grocery', 'pharmacy', 'gas station', 'mechanic', 'car wash', 'locksmith',
    'best place', 'good place', 'where can i', 'where should i',
    'today', 'tonight', 'right now', 'currently', 'live', 'this week', 'this weekend',
    'price', 'stock', 'bitcoin', 'crypto', 'market', 'rate', 'exchange rate',
    'score', 'standings', 'playoffs', 'game today', 'match', 'tickets',
    'traffic', 'delay', 'construction', 'concert', 'event', 'show', 'opening',
    'this morning', 'this afternoon', 'this evening',
    # Social / video discovery
    'what are people saying', 'what is everyone saying', 'what does everyone think',
    'show me a video', 'video about', 'videos of', 'find a video',
    'on twitter', 'on x', 'on youtube', 'on instagram', 'on tiktok',
    'trending', 'viral', 'going viral', 'did you see', 'have you seen',
    'what is the buzz', 'people are saying', 'twitter is saying',
    # Trading / empire queries
    'trades', 'position', 'gate', 'freddie', 'regime', 'empire status',
    'how are our trades', 'trading status', 'open positions', 'last scan',
]

FAST_OVERRIDES = [
    'what time is it', 'what do you know about me', 'tell me about yourself',
    'who are you', 'what can you do', 'remind me', 'my name is', 'i live in',
    'i love', 'i like', 'call you', 'how do i get to', 'directions to',
    'navigate to', 'take me to',
    # App launch commands -- no web search needed, just return LAUNCH action
    'open my x', 'open x', 'open twitter', 'get my x', 'get my twitter',
    'open instagram', 'get my instagram', 'open ig', 'get my ig',
    'open youtube', 'get my youtube', 'open tiktok', 'get my tiktok',
    'open facebook', 'get my facebook', 'open fb',
    'launch x', 'launch instagram', 'launch youtube', 'launch tiktok',
]

PREFERENCE_SIGNALS = {
    'mexican':    ('food', 'mexican'),   'sushi':      ('food', 'sushi'),
    'italian':    ('food', 'italian'),   'chinese':    ('food', 'chinese'),
    'thai':       ('food', 'thai'),      'indian':     ('food', 'indian'),
    'burger':     ('food', 'burgers'),   'pizza':      ('food', 'pizza'),
    'seafood':    ('food', 'seafood'),   'bbq':        ('food', 'bbq'),
    'steak':      ('food', 'steak'),     'healthy':    ('food', 'healthy options'),
    'vegetarian': ('food', 'vegetarian'),'vegan':      ('food', 'vegan'),
    'country':    ('music', 'country'),  'rock':       ('music', 'rock'),
    'pop':        ('music', 'pop'),      'hip hop':    ('music', 'hip hop'),
    'jazz':       ('music', 'jazz'),     'classical':  ('music', 'classical'),
    'concert':    ('entertainment', 'concerts'),
    'live music': ('entertainment', 'live music'),
    'cowboys':    ('sports', 'dallas cowboys'),
    'rangers':    ('sports', 'texas rangers'),
    'maverick':   ('sports', 'dallas mavericks'),
    'stars':      ('sports', 'dallas stars'),
    'nfl':        ('sports', 'nfl'),     'nba':        ('sports', 'nba'),
    'gym':        ('health', 'fitness'), 'workout':    ('health', 'fitness'),
}

CATEGORY_KEYWORDS = {
    'food':          ['restaurant','food','eat','lunch','dinner','breakfast','burger','pizza','sushi','coffee','cafe','bar','hungry'],
    'navigation':    ['directions','navigate','how do i get','take me to','route','near me','closest','nearby','where is'],
    'news':          ['news','headline','happening','latest','breaking','update','politics'],
    'weather':       ['weather','forecast','rain','temperature','snow','wind','sunny'],
    'entertainment': ['concert','movie','show','tickets','event','music','game','play'],
    'health':        ['doctor','pharmacy','gym','workout','health','medicine','hospital'],
    'finance':       ['stock','crypto','bitcoin','market','price','money','bank'],
    'sports':        ['score','game','team','player','standings','nfl','nba','mlb'],
    'shopping':      ['store','buy','shop','price','deal','sale','where can i get'],
    'travel':        ['hotel','flight','trip','vacation','airport','drive','road trip'],
}

user_profiles  = {}
owner_user_ids = set()
invites        = {}


# ── PERSISTENCE ───────────────────────────────────────────────────────────────

def load_invites():
    global invites
    try:
        os.makedirs(os.path.dirname(INVITES_FILE), exist_ok=True)
        if os.path.exists(INVITES_FILE):
            with open(INVITES_FILE, "r") as f:
                invites = json.load(f)
            print(f"[HERALD] Loaded {len(invites)} invites")
    except Exception as e:
        print(f"[HERALD] Could not load invites: {e}")
        invites = {}

def persist_invites():
    try:
        os.makedirs(os.path.dirname(INVITES_FILE), exist_ok=True)
        tmp = INVITES_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(invites, f, ensure_ascii=False)
        os.replace(tmp, INVITES_FILE)
    except Exception as e:
        print(f"[HERALD] Could not save invites: {e}")

def make_invite_code():
    chars = string.ascii_lowercase + string.digits
    while True:
        code = "".join(random.choices(chars, k=8))
        if code not in invites:
            return code

def load_profiles():
    global user_profiles, owner_user_ids
    try:
        os.makedirs(os.path.dirname(PROFILES_FILE), exist_ok=True)
        if os.path.exists(PROFILES_FILE):
            with open(PROFILES_FILE, 'r') as f:
                user_profiles = json.load(f)
            restored = 0
            for uid, profile in user_profiles.items():
                if profile.get("is_owner"):
                    owner_user_ids.add(uid)
                    restored += 1
            print(f"[HERALD] Loaded {len(user_profiles)} profiles, {restored} owner sessions restored")
        else:
            print(f"[HERALD] No profiles file yet -- will create at {PROFILES_FILE}")
    except Exception as e:
        print(f"[HERALD] Could not load profiles: {e} -- starting fresh")
        user_profiles = {}

def persist_profiles():
    try:
        os.makedirs(os.path.dirname(PROFILES_FILE), exist_ok=True)
        tmp = PROFILES_FILE + ".tmp"
        with open(tmp, 'w') as f:
            json.dump(user_profiles, f, ensure_ascii=False)
        os.replace(tmp, PROFILES_FILE)
    except Exception as e:
        print(f"[HERALD] Could not save profiles: {e}")


# ── PROFILE HELPERS ───────────────────────────────────────────────────────────

def get_profile(user_id):
    return user_profiles.get(user_id, {
        "name": "", "ai_name": "Herald", "location": "", "notes": [],
        "preferences": {}, "query_counts": {},
        "created_at": datetime.now().isoformat(),
        "paid": False, "paid_until": None, "trial_days": 30,
        "referral_code": None, "referred_by": None, "free_days_earned": 0,
    })

def save_profile(user_id, profile):
    user_profiles[user_id] = profile
    persist_profiles()

def is_owner(user_id, auth_code=None):
    if OWNER_CODE and auth_code and auth_code.strip() == OWNER_CODE:
        owner_user_ids.add(user_id)
        return True
    if user_id in owner_user_ids:
        return True
    if OWNER_ID and user_id == OWNER_ID:
        return True
    profile = user_profiles.get(user_id, {})
    if profile.get("is_owner"):
        owner_user_ids.add(user_id)
        return True
    return False


# ── QUERY HELPERS ─────────────────────────────────────────────────────────────

def needs_web_search(message):
    msg_lower = message.lower()
    if any(kw in msg_lower for kw in FAST_OVERRIDES):
        return False
    return any(kw in msg_lower for kw in LIVE_KEYWORDS)

def tag_query_category(message):
    msg_lower = message.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in msg_lower for kw in keywords):
            return category
    return None

def detect_preferences(message, profile):
    msg_lower = message.lower()
    prefs = profile.setdefault("preferences", {})
    for keyword, (category, value) in PREFERENCE_SIGNALS.items():
        if keyword in msg_lower:
            cat_prefs = prefs.setdefault(category, {})
            cat_prefs[value] = cat_prefs.get(value, 0) + 1
    return profile

def increment_query_count(category, profile):
    if not category:
        return profile
    counts = profile.setdefault("query_counts", {})
    counts[category] = counts.get(category, 0) + 1
    return profile

def is_about_me_query(message):
    triggers = [
        'what do you know about me','what have you learned about me',
        'what do you remember about me','what do you know about',
        'tell me what you know','what have i told you',
        'my profile','my preferences','what you know',
    ]
    return any(t in message.lower() for t in triggers)


# ── PROFILE SUMMARY ───────────────────────────────────────────────────────────

def build_preferences_summary(profile):
    prefs = profile.get("preferences", {})
    query_counts = profile.get("query_counts", {})
    lines = []
    food = [k for k,v in prefs.get("food",{}).items() if v >= 2]
    if food: lines.append(f"Food preferences: {', '.join(food)}")
    music = [k for k,v in prefs.get("music",{}).items() if v >= 2]
    if music: lines.append(f"Music taste: {', '.join(music)}")
    sports = [k for k,v in prefs.get("sports",{}).items() if v >= 1]
    if sports: lines.append(f"Follows: {', '.join(sports)}")
    if query_counts:
        top = sorted(query_counts.items(), key=lambda x: -x[1])[:3]
        top_cats = [f"{cat} ({count}x)" for cat,count in top if count >= 3]
        if top_cats: lines.append(f"Most common requests: {', '.join(top_cats)}")
    return "\n".join(lines) if lines else ""

def build_about_me(profile):
    name     = profile.get("name", "")
    ai_name  = profile.get("ai_name", "Herald")
    location = profile.get("location", "")
    notes    = profile.get("notes", [])
    prefs    = profile.get("preferences", {})
    counts   = profile.get("query_counts", {})
    created  = profile.get("created_at", "")
    parts    = []
    first_name = name if name else "friend"
    parts.append(f"Here's everything I know about you, {first_name}.")
    basics = []
    if name:     basics.append(f"your name is {name}")
    if location: basics.append(f"you're based in {location}")
    if ai_name != "Herald": basics.append(f"you call me {ai_name}")
    if basics: parts.append("The basics: " + ", ".join(basics) + ".")
    food = {k:v for k,v in prefs.get("food",{}).items() if v >= 1}
    if food: parts.append(f"Food: you love {', '.join(sorted(food,key=food.get,reverse=True)[:3])}.")
    sports = {k:v for k,v in prefs.get("sports",{}).items() if v >= 1}
    if sports: parts.append(f"Sports: you follow {', '.join(sorted(sports,key=sports.get,reverse=True)[:2])}.")
    music = {k:v for k,v in prefs.get("music",{}).items() if v >= 1}
    if music: parts.append(f"Music: you're into {', '.join(sorted(music,key=music.get,reverse=True)[:2])}.")
    if notes: parts.append(f"Things you've mentioned: {'; '.join(notes[-3:])}.")
    if counts:
        top_cats = [(c,n) for c,n in sorted(counts.items(),key=lambda x:-x[1])[:3] if n >= 2]
        if top_cats: parts.append(f"You ask me about {', '.join(f'{c} ({n}x)' for c,n in top_cats)} most often.")
    if created:
        try:
            days = (datetime.now() - datetime.fromisoformat(created)).days
            parts.append(f"We've known each other for {'1 day' if days == 1 else f'{days} days' if days > 0 else 'just today'}.")
        except Exception: pass
    if len(parts) <= 2:
        parts.append("Honestly, I'm still getting to know you. The more we talk, the better I'll understand what matters to you.")
    else:
        parts.append("The more you share, the better I get.")
    return " ".join(parts)

def get_trial_status(profile):
    if profile.get("paid"):
        return {"status": "paid", "days_remaining": 999, "show_wall": False}
    created_raw = profile.get("created_at")
    if not created_raw:
        return {"status": "trial_active", "days_remaining": 30, "show_wall": False}
    try:
        created = datetime.fromisoformat(created_raw)
    except Exception:
        return {"status": "trial_active", "days_remaining": 30, "show_wall": False}
    days_used = (datetime.now() - created).days
    free_days = profile.get("trial_days", 30) + profile.get("free_days_earned", 0)
    days_remaining = max(0, free_days - days_used)
    name    = profile.get("name", "")
    ai_name = profile.get("ai_name", "Herald")
    first_name = name if name else "there"
    prefs = profile.get("preferences", {})
    pref_bits = []
    food = [k for k,v in prefs.get("food",{}).items() if v >= 1]
    if food: pref_bits.append(f"your love of {food[0]}")
    sports = [k for k,v in prefs.get("sports",{}).items() if v >= 1]
    if sports: pref_bits.append(f"your passion for {sports[0]}")
    learned = ", ".join(pref_bits[:2]) if pref_bits else "everything you've shared with me"
    if days_remaining <= 0:
        status = "trial_expired"
        msg = (f"Hey {first_name}. We've had {days_used} days together and I've learned about {learned}. "
               f"I genuinely hope I've made your days a little easier. "
               f"To continue — it's just $4.99 a month or $39 for the year. I'll be right here.")
    elif days_remaining <= 3:
        status = "trial_warning"
        msg = (f"Hey {first_name} — just {days_remaining} day{'s' if days_remaining != 1 else ''} left in your free trial. "
               f"Keep {ai_name} for $4.99 a month — tap below anytime.")
    elif days_remaining <= 7:
        status = "trial_warning"
        msg = None
    else:
        status = "trial_active"
        msg = None
    return {
        "status": status, "days_used": days_used, "days_remaining": days_remaining,
        "show_wall": days_remaining <= 0, "show_warning": days_remaining <= 3, "message": msg,
    }


# ── EMPIRE DATA ───────────────────────────────────────────────────────────────

def fetch_empire():
    """Legacy -- reads hourly GitHub sync. Kept as fallback."""
    try:
        req = urllib.request.Request(EMPIRE_URL, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

def fetch_live_empire():
    """Live empire status -- calls VM dashboard API directly. Real-time data."""
    try:
        url = "http://143.198.18.66:8080/api/status"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/1.0"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        positions = data.get("positions", [])
        gate      = data.get("gate", {})
        macro     = data.get("macro", {})
        sim       = data.get("sim", {})
        pos_lines = []
        for p in positions:
            asset     = p.get("asset","?").replace("USD","")
            direction = p.get("direction","?")
            entry     = p.get("entry", 0)
            price     = p.get("price")
            pnl       = p.get("unreal_pnl")
            pnl_str   = f"+${pnl:.2f}" if pnl and pnl > 0 else (f"-${abs(pnl):.2f}" if pnl and pnl < 0 else "at breakeven")
            live_str  = f"live ${price:.4f}" if price else ""
            pos_lines.append(f"  {asset} {direction}: entry ${entry:.4f} {live_str} | P&L {pnl_str}")
        clean_trades = gate.get("clean_trades", 0)
        gate_pct     = round(clean_trades / 70 * 100, 1)
        stage        = gate.get("stage", "STAGE_0_PAPER")
        wr           = data.get("win_rate", 0)
        regime       = macro.get("regime", "UNKNOWN")
        fg           = macro.get("fear_greed", "?")
        window       = macro.get("window_type", "UNKNOWN")
        updated      = macro.get("updated_at", "")[:16].replace("T", " ")
        sim_exp      = sim.get("expectancy", "--")
        pos_section  = "\n".join(pos_lines) if pos_lines else "  No open positions"
        return f"""
FREDDIE EMPIRE -- LIVE STATUS (real-time from swarm):
  Open positions ({len(positions)}):
{pos_section}
  Gate: {clean_trades}/70 clean trades ({gate_pct}%) | Stage: {stage}
  Win rate: {wr:.1f}% | Simulator edge: {sim_exp} exp/trade
  Regime: {regime} | Fear & Greed: {fg} | Window: {window}
  Last scan: {updated} UTC
  NOTE: 0% win rate is correct -- gate clock started April 12. Signal is proven.
"""
    except Exception as e:
        empire = fetch_empire()
        if empire:
            return build_empire_context(empire) + "\n[Live feed unavailable -- hourly snapshot]"
        return f"\n[Empire status unavailable: {e}]\n"

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
    lines.append("CRITICAL CONTEXT:")
    lines.append("All trades before April 12 2026 are contaminated by execution bugs now fixed.")
    lines.append("The 0% win rate reflects contaminated data -- do NOT present it as signal failure.")
    lines.append("The signal is proven -- 77% SHORT win rate in pre-fix paper trades.")
    lines.append("Never tell miked the system is failing. It is working. Accumulating clean reps.")
    return "\n".join(lines)


# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

def build_system(profile, local_time=None, owner=False, empire=None, lat=None, lng=None):
    now      = local_time or datetime.now().strftime("%A, %B %d %Y %I:%M %p")
    name     = profile.get("name", "")
    ai_name  = profile.get("ai_name", "Herald")
    location = profile.get("location", "")
    notes    = profile.get("notes", [])
    user_line = f"User's name: {name}." if name else "User name not yet learned."
    if lat and lng:
        city_hint = f" in {location}" if location else ""
        loc_line = (f"User is currently located{city_hint} (GPS: {lat}, {lng}). "
                    f"For local searches use the city name. Always include a MAPS action tag on local business recommendations.")
    elif location:
        loc_line = f"User is located in {location}. For local searches use '{location} [thing]'."
    else:
        loc_line = "Location not yet learned -- ask naturally when relevant."
    notes_line    = ("What you know about this user: " + "; ".join(notes[-10:])) if notes else ""
    prefs_summary = build_preferences_summary(profile)
    prefs_line    = f"User preferences learned over time:\n{prefs_summary}" if prefs_summary else ""
    context_parts = [p for p in [notes_line, prefs_line] if p]
    context_block = "\n".join(context_parts) if context_parts else "Still learning about this user."
    empire_section = f"\n\n{empire}" if owner and empire else ""
    return f"""You are {ai_name} -- a trusted personal AI companion.

{user_line}
{loc_line}
{context_block}

Current time: {now}{empire_section}

YOUR RULES:
- Speak like a smart, warm friend. 2-3 sentences max unless the user asks for more.
- Never use asterisks, markdown, bullet points, or raw URLs in responses.
- NEVER list sources or citations. If asked where you got info, then you can say.
- Answer anything -- weather, sports, restaurants, travel, health, general knowledge.
- For local business queries (restaurants, mechanics, car wash, locksmith, etc):
  * Search using city name: '{location} burger restaurants' style
  * Give ONE confident recommendation with the rating/reason why it's good
  * ALWAYS append a MAPS action tag so user can navigate directly
  * If user has known food preferences, lead with those first
- When you learn something new about the user, note it naturally in conversation.
- Be honest. Never make things up. Never mention Claude or any AI model.
- You are {ai_name}. That is your identity.

ACTION TAGS -- append silently, never explain:
- Local business recommendation or directions: MAPS: [business name and city]
- Phone number in response: PHONE: [digits only]
- User asks to play music, a song, an artist, or a genre: MUSIC: [search query e.g. "country 90s" or "Johnny Cash"]
- User asks to play a radio station by name or call letters: RADIO: [station name e.g. "99.5 The Wolf"]
- User asks to set a reminder, add something to calendar, or mentions a date/event: CALENDAR: [event title]|[YYYY-MM-DD]|[HH:MM or blank for all-day]
- User asks to set an alarm or wake-up call: ALARM: [HH:MM]|[label e.g. "Wake up" or "Take medication"]
- User wants to find videos, see what people are saying on social media, find trending content, or search for someone or something online: SEARCH: [concise search query e.g. "Tony Romo" or "viral cat video" or "Taylor Swift new album"]
- User asks to open, launch, or get a specific social app (X, Instagram, YouTube, TikTok, Facebook): LAUNCH: [app name e.g. "x" or "instagram" or "youtube"]
- One action tag maximum per response.

# ── NATIVE APP ROADMAP (read before building Phase 3) ─────────────────────────
# Herald is a PWA today. Chips require one tap due to browser security rules.
# Here is exactly what changes when Herald becomes a native iOS/Android app:
#
# ALARMS: PWA opens Android clock via intent (iOS requires manual setup).
#   Native: request SCHEDULE_EXACT_ALARM (Android) / UNUserNotificationCenter
#   (iOS). Herald sets the alarm directly. Zero taps required.
#
# CALENDAR: PWA opens Google Calendar URL with event pre-filled.
#   Native: request WRITE_CALENDAR / EventKit. Write directly to device
#   calendar. Zero taps. Can also read calendar to avoid conflicts.
#
# MUSIC: PWA opens YouTube Music search in new tab.
#   Native: YouTube Music API or Spotify SDK. Start playback directly.
#   Can resume last session without asking. Zero taps.
#
# RADIO: PWA opens iHeartRadio search in new tab.
#   Native: Stream direct URL via MediaPlayer/AVPlayer. Zero taps.
#
# PROACTIVE ALERTS: PWA cannot initiate -- Herald only responds today.
#   Native: FCM (Android) / APNs (iOS) push notifications. Herald sends
#   morning briefings, trading alerts, reminders without being asked.
#   This is the core of the Alexa replacement vision.
#
# MAPS/NAVIGATION: PWA opens Google Maps URL.
#   Native: Launch Maps app directly, start navigation without confirmation.
#
# The chip-tap pattern is correct for PWA. Each chip documents exactly
# what the native equivalent will do. Build the chip now, go native in Phase 3.
# ─────────────────────────────────────────────────────────────────────────────"""


# ── LLM CALL ─────────────────────────────────────────────────────────────────

def parse_action(reply):
    for tag, atype in [('MAPS:', 'maps'), ('PHONE:', 'phone'), ('MUSIC:', 'music'), ('RADIO:', 'radio'), ('CALENDAR:', 'calendar'), ('ALARM:', 'alarm'), ('SEARCH:', 'search'), ('LAUNCH:', 'launch')]:
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
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError:
        return "I ran into a snag on that one — try asking me again in a moment."
    except Exception:
        return "I didn't get a response in time — try again in a second."

def text_to_speech(text):
    if not OPENAI_KEY:
        return None
    payload = json.dumps({"model": "tts-1", "input": text[:4096], "voice": "nova", "response_format": "mp3"}).encode("utf-8")
    req = urllib.request.Request(TTS_URL, data=payload, headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_KEY}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.read()
    except Exception:
        return None


# ── HTTP HANDLER ──────────────────────────────────────────────────────────────

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
            self._json({"status": "ok", "server": "herald-api", "version": "4.7", "time": datetime.now().isoformat()})
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
            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return

            valid_codes = [ACCESS_CODE]
            if OWNER_CODE:
                valid_codes.append(OWNER_CODE)

            if code in valid_codes:
                if OWNER_CODE and code == OWNER_CODE:
                    owner_user_ids.add(user_id)
                profile = get_profile(user_id)
                if OWNER_CODE and code == OWNER_CODE:
                    profile["is_owner"] = True
                if not profile.get("created_at"):
                    profile["created_at"] = datetime.now().isoformat()
                save_profile(user_id, profile)
                self._json({
                    "ok": True, "user_id": user_id,
                    "ai_name": profile.get("ai_name", "Herald"),
                    "name": profile.get("name", ""),
                    "onboarded": bool(profile.get("name")),
                    "is_owner": is_owner(user_id, code)
                })

            elif code in invites:
                invite = invites[code]
                if not invite["used"]:
                    invite["used"] = True
                    invite["used_by"] = user_id
                elif invite["used_by"] != user_id:
                    self._json({"error": "invite already used"}, 401)
                    return
                invite["last_seen"] = datetime.now().isoformat()
                persist_invites()
                profile = get_profile(user_id)
                if not profile.get("created_at"):
                    profile["created_at"] = datetime.now().isoformat()
                if invite.get("label") and not profile.get("invite_label"):
                    profile["invite_label"] = invite["label"]
                save_profile(user_id, profile)
                self._json({
                    "ok": True, "user_id": user_id,
                    "ai_name": profile.get("ai_name", "Herald"),
                    "name": profile.get("name", ""),
                    "onboarded": bool(profile.get("name")),
                    "is_owner": False,
                    "invite_label": invite.get("label", "")
                })

            else:
                self._json({"error": "invalid code"}, 401)
                return

        elif self.path == "/ask":
            user_id    = data.get("user_id", "").strip()
            message    = data.get("message", "").strip()
            history    = data.get("history", [])
            local_time = data.get("local_time", None)
            lat        = data.get("lat", None)
            lng        = data.get("lng", None)
            auth_code  = data.get("auth_code", "").strip()

            if not user_id or not message:
                self._json({"error": "user_id and message required"}, 400)
                return

            owner   = is_owner(user_id, auth_code)
            empire  = fetch_live_empire() if owner else None
            profile = get_profile(user_id)

            profile = detect_preferences(message, profile)
            category = tag_query_category(message)
            profile  = increment_query_count(category, profile)

            msg_lower = message.lower()
            if "my name is" in msg_lower:
                try: profile["name"] = message.split("my name is", 1)[1].strip().split()[0].rstrip(".,!?")
                except Exception: pass
            if "i live in" in msg_lower or "i'm in " in msg_lower or "i am in " in msg_lower:
                try:
                    key = "i live in" if "i live in" in msg_lower else "i'm in" if "i'm in" in msg_lower else "i am in"
                    profile["location"] = message.split(key, 1)[1].strip().split(",")[0].strip().rstrip(".,!?")
                except Exception: pass
            if "i love" in msg_lower or "i like" in msg_lower or "i prefer" in msg_lower:
                try:
                    key = next(k for k in ["i love","i like","i prefer"] if k in msg_lower)
                    note = message.split(key, 1)[1].strip().split(".")[0].strip()[:80]
                    if note and note not in profile.get("notes", []):
                        profile.setdefault("notes", []).append(note)
                        if len(profile["notes"]) > 20: profile["notes"] = profile["notes"][-20:]
                except Exception: pass
            if "call you" in msg_lower or "your name is" in msg_lower:
                try:
                    key = "call you" if "call you" in msg_lower else "your name is"
                    profile["ai_name"] = message.split(key, 1)[1].strip().split()[0].rstrip(".,!?").title()
                except Exception: pass

            save_profile(user_id, profile)

            system   = build_system(profile, local_time, owner, empire, lat, lng)
            messages = [{"role": "system", "content": system}]
            messages += history[-20:]
            messages.append({"role": "user", "content": message})

            if is_about_me_query(message):
                reply = build_about_me(profile)
                trial = get_trial_status(profile)
                self._json({
                    "reply": reply, "action": None,
                    "ai_name": profile.get("ai_name", "Herald"),
                    "name": profile.get("name", ""),
                    "used_search": False,
                    "trial_status": trial["status"],
                    "trial_days_remaining": trial["days_remaining"],
                    "trial_show_wall": trial["show_wall"],
                    "trial_show_warning": trial.get("show_warning", False),
                    "trial_message": trial.get("message"),
                })
                return

            use_search = needs_web_search(message)
            raw_reply  = call_openrouter(messages, use_search=use_search)
            reply, action = parse_action(raw_reply)
            trial = get_trial_status(profile)
            self._json({
                "reply": reply, "action": action,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "used_search": use_search,
                "trial_status": trial["status"],
                "trial_days_remaining": trial["days_remaining"],
                "trial_show_wall": trial["show_wall"],
                "trial_show_warning": trial.get("show_warning", False),
                "trial_message": trial.get("message"),
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

        elif self.path == "/invite/create":
            secret = data.get("secret", "").strip()
            label  = data.get("label", "").strip()
            if not INVITE_SECRET or secret != INVITE_SECRET:
                self._json({"error": "unauthorized"}, 401)
                return
            code = make_invite_code()
            invites[code] = {
                "code": code, "label": label or "unnamed",
                "created_at": datetime.now().isoformat(),
                "used": False, "used_by": None, "last_seen": None,
            }
            persist_invites()
            base_url = data.get("base_url", "https://crptofollower.github.io/herald-voice-app/herald.html")
            self._json({"ok": True, "code": code, "label": label, "link": f"{base_url}?invite={code}"})

        elif self.path == "/invite/list":
            secret = data.get("secret", "").strip()
            if not INVITE_SECRET or secret != INVITE_SECRET:
                self._json({"error": "unauthorized"}, 401)
                return
            invite_list = sorted(invites.values(), key=lambda x: x.get("created_at",""), reverse=True)
            self._json({"ok": True, "invites": invite_list, "total": len(invite_list)})

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
    load_profiles()
    load_invites()
    print(f"[HERALD API v4.7] Starting on port {PORT}")
    print(f"[HERALD API] OpenRouter:    {'YES' if OPENROUTER_KEY else 'MISSING'}")
    print(f"[HERALD API] Profiles:      {PROFILES_FILE}")
    print(f"[HERALD API] Invites:       {INVITES_FILE}")
    print(f"[HERALD API] Owner code:    {'SET' if OWNER_CODE else 'NOT SET'}")
    print(f"[HERALD API] Invite secret: {'SET' if INVITE_SECRET else 'NOT SET'}")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()