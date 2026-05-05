# herald_api.py
# Herald PWA Backend -- Railway Cloud Server
# v7.6 -- Proactive loop + gas price watcher + /proactive endpoint
#
# WHAT CHANGED vs v7.5.1:
#   - Added:   EIA_KEY config variable (EIA_API_KEY env var)
#   - Added:   proactive_queue[] to user profile schema
#   - Added:   fetch_gas_price_eia() -- free government gas price API
#   - Added:   check_gas_watch() -- alerts on price moves >= threshold
#   - Added:   GET /proactive/{user_id} -- frontend polls on app open + resume
#   - Updated: /cron/watchers -- gas watch type + writes to proactive_queue
#   - Updated: EXPLICIT_WATCH_PROMPT -- gas watch examples
#   - Updated: get_profile() -- proactive_queue field in default schema
#   - Version bump: 7.5.1 -> 7.6

import os, json, re, random, string, time, http.client, ssl, sqlite3, threading, uuid
import urllib.request, urllib.error, urllib.parse
from datetime import datetime, timedelta, date

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

# ── APP ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Herald API", version="7.6")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ── CONFIG ────────────────────────────────────────────────────────────────────

PORT           = int(os.environ.get("PORT", 8080))
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENAI_KEY     = os.environ.get("OPENAI_API_KEY", "")
SENDGRID_KEY   = os.environ.get("SENDGRID_API_KEY", "")
ACCESS_CODE    = os.environ.get("HERALD_ACCESS_CODE", "herald2026")
OWNER_CODE     = os.environ.get("HERALD_OWNER_CODE", "")
OWNER_ID       = os.environ.get("HERALD_OWNER_ID", "")
INVITE_SECRET  = os.environ.get("HERALD_INVITE_SECRET", "")
GNEWS_KEY      = os.environ.get("GNEWS_API_KEY", "")
OMDB_KEY       = os.environ.get("OMDB_API_KEY", "")
ALPHA_KEY      = os.environ.get("ALPHAVANTAGE_KEY", "")
NEWSDATA_KEY   = os.environ.get("NEWSDATA_API_KEY", "")
WEATHER_KEY    = os.environ.get("WEATHER_API_KEY", "")
GEOCODING_KEY  = os.environ.get("GOOGLE_GEOCODING_KEY", "")
BRAVE_KEY      = os.environ.get("BRAVE_SEARCH_KEY", "")
EIA_KEY        = os.environ.get("EIA_API_KEY", "")
OR_URL         = "https://openrouter.ai/api/v1/chat/completions"
VM_WEBHOOK_URL = "http://143.198.18.66:8082/webhook/sync"
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
TTS_URL        = "https://api.openai.com/v1/audio/speech"
EMPIRE_URL     = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
PROFILES_FILE  = os.environ.get("PROFILES_FILE", "/data/profiles.json")
INVITES_FILE   = os.environ.get("INVITES_FILE",  "/data/invites.json")
DB_FILE        = "/data/herald.db"

# ── MODEL ROUTING (v7.4) ──────────────────────────────────────────────────────

MODEL_SEARCH = "anthropic/claude-haiku-4-5:online"
MODEL_FAST   = "anthropic/claude-haiku-4-5"
HAIKU_MODEL  = "anthropic/claude-haiku-4-5"
SONNET_MODEL = "anthropic/claude-sonnet-4-5"

HAIKU_SIGNALS = [
    "weather", "temperature", "forecast", "rain", "snow", "wind", "humidity",
    "score", "game", "standings", "stats", "who won", "did they win",
    "price", "stock", "crypto", "bitcoin", "ethereum", "how much is",
    "market", "dow", "nasdaq",
    "news", "headlines", "what happened",
    "what time", "how far", "how long", "distance",
    "recipe", "ingredients", "calories",
    "convert", "calculate", "how many", "how much",
    "define", "what is", "who is", "when did", "where is",
    "what year", "how old",
]

SONNET_SIGNALS = [
    "should i", "what do you think", "advice", "help me figure",
    "worried", "scared", "anxious", "sad", "upset", "struggling",
    "depressed", "lonely", "angry", "frustrated",
    "relationship", "marriage", "family", "kids", "divorce", "breakup",
    "career", "job", "fired", "quit", "boss",
    "doctor", "diagnosis", "treatment", "medication", "surgery",
    "invest", "retire", "savings", "mortgage", "debt",
    "plan my", "thinking about", "considering",
    "what would you do", "how do i deal", "i don't know what to do",
    "honest opinion", "be honest", "tell me the truth",
    "complicated", "difficult situation",
]

def route_model(message: str) -> str:
    msg_lower = message.lower()
    if any(sig in msg_lower for sig in SONNET_SIGNALS):
        return SONNET_MODEL
    if len(message.split()) <= 10:
        return HAIKU_MODEL
    if any(sig in msg_lower for sig in HAIKU_SIGNALS):
        return HAIKU_MODEL
    return HAIKU_MODEL


# ── WATCHER SYSTEM (v7.4) ─────────────────────────────────────────────────────

MAX_EXTRACTION_CALLS_PER_DAY = 30
_extraction_counts: dict = {}

WATCH_OFFER_PHRASES = [
    "Hey {name}, I've noticed you've been curious about {topic} lately — want me to keep an eye out and let you know when something interesting comes up?",
    "You know what I've picked up on, {name}? You ask about {topic} pretty often. I can start keeping you posted automatically if you'd like.",
    "I don't miss much, {name} — and I've noticed {topic} keeps coming up for you. Say the word and I'll watch it for you.",
    "{name}, just between us — {topic} keeps coming up in our conversations. Want me to flag anything new so you don't have to remember to ask?",
    "I've been paying attention, {name}. {topic} is clearly on your radar. I can take that off your plate and just tell you when something worth knowing happens.",
]

TRAVEL_OFFER_PHRASES = [
    "Hey {name}, {topic} keeps coming up — are you planning a trip? If so I can pull together great places, local tips, and hidden gems and send it all to your email.",
    "{name}, I've noticed a lot of questions about {topic} lately. Sounds like a trip might be in the works? Say the word and I'll put something great together for you.",
    "You know what I'm picking up on, {name}? I think there's a {topic} trip being planned. Am I right? I'd love to help — I know some places most tourists never find.",
]

TASK_OFFER_PHRASES = [
    "Hey {name}, you've been dealing with {topic} for a bit. Want me to pull together what you need to know — key questions to ask, what to watch out for, rough costs — and send it to your email?",
    "{name}, I've noticed {topic} keeps coming up. I can put together a solid rundown — what to know, next steps, who to call — and send it straight to you.",
    "I've been following along on the {topic} situation, {name}. Want me to do some digging and send you a proper summary? Easier than asking piece by piece.",
]

RESEARCH_OFFER_PHRASES = [
    "Hey {name}, you've asked about {topic} a few times now. Want me to pull together what's actually worth knowing and send it to your email?",
    "{name}, {topic} keeps coming up for you. I can put together a proper briefing — current thinking, what the research says, what to watch — and send it over.",
    "I've noticed you're digging into {topic}, {name}. Want me to do a proper pull on that and email you something worth reading?",
]

BUILT_CAPABILITIES = ["email"]

CAPABILITY_TRIGGERS = {
    "email":    ["send it to me", "send to my email", "email me", "send me that", "email that"],
    "spotify":  ["play", "music", "song", "playlist", "put on some"],
    "calendar": ["remind me", "add to my calendar", "set a reminder", "don't let me forget"],
    "sms":      ["text", "send a text", "message them"],
    "youtube":  ["show me how", "show me a video", "youtube"],
}

CAPABILITY_OFFERS = {
    "email":    "I can send that straight to your email so you have it — want me to add that to what I can do for you?",
    "spotify":  "I can connect to Spotify and handle music directly — you'd never have to open the app. Want to set that up?",
    "calendar": "I can drop that right into your calendar so you don't forget. Want me to add that to what I can do?",
    "sms":      "I can send that text for you directly. Want to set that up?",
    "youtube":  "I can pull that up on YouTube for you without you touching the app. Want me to add that?",
}

WATCH_KEYWORDS = [
    "watch", "keep an eye", "let me know", "notify me",
    "alert me", "tell me when", "follow", "track",
    "keep me posted", "heads up when", "update me", "flag it",
]

TOPIC_CLASSIFICATION_PROMPT = """You analyze a single user message to detect recurring interest signals.

User message: {message}
User name: {name}
Known topic touches: {touches_json}

Determine:
1. Is there a trackable topic in this message?
2. Natural language label (short — e.g. "Italy travel", "car brake repair", "makeup trends", "the Mavericks", "managing diabetes")
3. Interest type — exactly one:
   - ongoing: permanent interest (sports team, weather, beauty, celebrity, cooking)
   - trip_planning: destination being researched for an upcoming trip
   - task_planning: project with an end (car repair, home reno, job search)
   - research: subject they want to understand (health condition, investing, history)
4. Logistics signals? (packing, flights, hotels, "how far is", "best time to visit")
5. Acute health symptom? (chest pain, fever, headache = YES — never promote these)
6. Chronic or research health topic? (diabetes, a medication, a condition = research type — OK)

Return ONLY valid JSON. No preamble. No markdown.
{{"touch_worthy": true, "topic_label": "label", "interest_type": "ongoing", "logistics_signals": false, "is_acute_health": false}}"""

EXPLICIT_WATCH_PROMPT = """User asked Herald to watch or monitor something.

User said: {message}

Extract a structured watch. Return ONLY valid JSON:
{{"type": "sports|stock|crypto|news|weather|gas|other", "description": "short description", "params": {{}}, "offer_email": false}}

Examples:
"watch the Mavericks" -> {{"type": "sports", "description": "Dallas Mavericks game results", "params": {{"team": "Dallas Mavericks", "league": "NBA"}}, "offer_email": false}}
"let me know if Bitcoin drops below 80k" -> {{"type": "crypto", "description": "Bitcoin price alert below 80000", "params": {{"symbol": "BTC", "condition": "below", "threshold": 80000}}, "offer_email": false}}
"keep an eye on AI news" -> {{"type": "news", "description": "AI industry news updates", "params": {{"topic": "artificial intelligence"}}, "offer_email": false}}
"let me know if gas prices drop" -> {{"type": "gas", "description": "gas price alert when prices drop", "params": {{"threshold": 0.05, "direction": "down", "last_price": null}}, "offer_email": false}}
"watch gas prices for me" -> {{"type": "gas", "description": "weekly gas price updates", "params": {{"threshold": 0.05, "direction": "any", "last_price": null}}, "offer_email": false}}"""


# ── COMMODITY MAP ─────────────────────────────────────────────────────────────

COMMODITY_MAP = {
    'silver':       'SI=F', 'gold':         'GC=F', 'oil':          'CL=F',
    'crude oil':    'CL=F', 'crude':        'CL=F', 'natural gas':  'NG=F',
    'copper':       'HG=F', 'platinum':     'PL=F', 'palladium':    'PA=F',
    'wheat':        'ZW=F', 'corn':         'ZC=F', 'soybeans':     'ZS=F',
    'soybean':      'ZS=F',
}

# ── TICKER STOP WORDS ─────────────────────────────────────────────────────────

TICKER_STOP_WORDS = {
    'THE','AND','FOR','ARE','BUT','NOT','YOU','ALL','ANY','CAN','HAD',
    'HER','WAS','ONE','OUR','OUT','DAY','GET','HAS','HIM','HIS','HOW',
    'ITS','MAY','NEW','NOW','OLD','SEE','TWO','WHO','BOY','DID','LET',
    'PUT','SAY','SHE','TOO','USE','DAD','MOM','MAN','MEN','WHY','YES',
    'WHAT','WHEN','WITH','THIS','THAT','FROM','HAVE','BEEN','WILL',
    'THEY','THEM','THEN','THAN','DOES','WERE','SAID','EACH','MUCH',
    'WHICH','THEIR','THERE','THESE','THOSE','INTO','OVER','ALSO','BACK',
    'COME','GIVE','JUST','KNOW','LIKE','LOOK','MAKE','MOST','SOME',
    'TAKE','WELL','WENT','YOUR','ABOUT','AFTER','AGAIN','ALONG','BEING',
    'BELOW','COULD','EVERY','FOUND','GOING','GREAT','GROUP','LARGE',
    'NEVER','OFTEN','PLACE','RIGHT','SINCE','SMALL','STILL','THINK',
    'THREE','UNDER','UNTIL','WATER','WHERE','WHILE','WORLD','WOULD',
    'YEARS','PRICE','TRADE','TELL','SHOW','REAL','LIVE','COST','RATE',
    'HIGH','LOWS','OPEN','NEXT','LAST','VERY','EVEN','ONLY','BOTH',
    'LONG','LATE','NEAR','MUCH','GOOD','BEST','EVER','EACH','SAME',
    'SUCH','KEEP','DONE','WENT','CALL','HOLD','SELL','STAY','RISE',
    'FALL','TALK','WALK','WANT','NEED','FEEL','FIND','HELP','SEEM',
    'TELL','TURN','MOVE','PLAY','MEAN','PLAN','STOP','PULL','PUSH',
    'PASS','PAST','FAST','EASY','HARD','DARK','COLD','WARM','FULL',
    'FREE','SAFE','SAFE','POOR','RICH','TRUE','FAKE','SURE','GLAD',
    'ABLE','SOON','LESS','MORE','THAN','ONCE','ELSE','AWAY','DONE',
    'GONE','CAME','WENT','TOLD','MADE','SAID','GAVE','TOOK','CAME',
    'KNEW','GREW','FLEW','DREW','BLEW','CLEW',
    'CASH','DEBT','LOAN','FUND','BOND','RISK','GAIN','LOSS','SELL',
    'BULL','BEAR','CALL','PUTS','TOPS','LOWS','HOLD','LONG','SHORT',
}

# ── RESPONSE CACHE ────────────────────────────────────────────────────────────

_cache = {}
CACHE_TTL = {'weather': 900, 'news': 600, 'crypto': 120, 'stock': 180, 'commodity': 180}

def cache_get(key, category='default'):
    entry = _cache.get(key)
    if not entry:
        return None
    ttl = CACHE_TTL.get(category, 600)
    if time.time() - entry['ts'] > ttl:
        del _cache[key]
        return None
    return entry['val']

def cache_set(key, val, category='default'):
    if val:
        _cache[key] = {'val': val, 'ts': time.time()}


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
    'traffic', 'delay', 'construction', 'concert', 'event', 'events', 'show', 'opening',
    'calendar', 'schedule', 'festival', 'what is going on', "what's going on",
    'what is happening in', 'what to do', 'things to do', 'this month',
    'this morning', 'this afternoon', 'this evening',
    'what are people saying', 'what is everyone saying', 'what does everyone think',
    'show me a video', 'video about', 'videos of', 'find a video',
    'on twitter', 'on x', 'on youtube', 'on instagram', 'on tiktok',
    'trending', 'viral', 'going viral', 'did you see', 'have you seen',
    'what is the buzz', 'people are saying', 'twitter is saying',
    'trades', 'position', 'gate', 'freddie', 'regime', 'empire status',
    'how are our trades', 'trading status', 'open positions', 'last scan',
]

FAST_OVERRIDES = [
    'what time is it', 'what do you know about me', 'tell me about yourself',
    'who are you', 'what can you do', 'remind me', 'my name is', 'i live in',
    'i love', 'i like', 'call you', 'how do i get to', 'directions to',
    'navigate to', 'take me to',
    'open my x', 'open x', 'open twitter', 'get my x', 'get my twitter',
    'open instagram', 'get my instagram', 'open ig', 'get my ig',
    'open youtube', 'get my youtube', 'open tiktok', 'get my tiktok',
    'open facebook', 'get my facebook', 'open fb',
    'launch x', 'launch instagram', 'launch youtube', 'launch tiktok',
    'remember that', 'remember this', "don't forget", 'make a note',
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


# ── PERSISTENCE (v7.1 -- SQLite) ──────────────────────────────────────────────

def init_db():
    try:
        os.makedirs("/data", exist_ok=True)
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS profiles (
                user_id    TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS invites (
                code       TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()
        c.execute("SELECT COUNT(*) FROM profiles")
        if c.fetchone()[0] == 0 and os.path.exists(PROFILES_FILE):
            try:
                with open(PROFILES_FILE, "r") as f:
                    old_profiles = json.load(f)
                now = datetime.now().isoformat()
                for uid, profile in old_profiles.items():
                    c.execute(
                        "INSERT OR IGNORE INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)",
                        (uid, json.dumps(profile, ensure_ascii=False), now)
                    )
                conn.commit()
                print(f"[HERALD] Migrated {len(old_profiles)} profiles from JSON to SQLite")
            except Exception as e:
                print(f"[HERALD] JSON migration warning (non-fatal): {e}")
        c.execute("SELECT COUNT(*) FROM invites")
        if c.fetchone()[0] == 0 and os.path.exists(INVITES_FILE):
            try:
                with open(INVITES_FILE, "r") as f:
                    old_invites = json.load(f)
                for code, invite in old_invites.items():
                    c.execute(
                        "INSERT OR IGNORE INTO invites (code, data, created_at) VALUES (?, ?, ?)",
                        (code, json.dumps(invite, ensure_ascii=False),
                         invite.get("created_at", datetime.now().isoformat()))
                    )
                conn.commit()
                print(f"[HERALD] Migrated {len(old_invites)} invites from JSON to SQLite")
            except Exception as e:
                print(f"[HERALD] Invite migration warning (non-fatal): {e}")
        conn.close()
        print(f"[HERALD] SQLite ready: {DB_FILE}")
    except Exception as e:
        print(f"[HERALD] Database init failed: {e} -- profiles will not persist this session")


def load_profiles():
    global user_profiles, owner_user_ids
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT user_id, data FROM profiles")
        rows = c.fetchall()
        conn.close()
        restored = 0
        for user_id, data in rows:
            try:
                profile = json.loads(data)
                user_profiles[user_id] = profile
                if profile.get("is_owner"):
                    owner_user_ids.add(user_id)
                    restored += 1
            except Exception:
                pass
        print(f"[HERALD] Loaded {len(user_profiles)} profiles from SQLite ({restored} owner sessions)")
    except Exception as e:
        print(f"[HERALD] Could not load profiles: {e} -- starting fresh")
        user_profiles = {}


def load_invites():
    global invites
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT code, data FROM invites")
        rows = c.fetchall()
        conn.close()
        for code, data in rows:
            try:
                invites[code] = json.loads(data)
            except Exception:
                pass
        print(f"[HERALD] Loaded {len(invites)} invites from SQLite")
    except Exception as e:
        print(f"[HERALD] Could not load invites: {e}")
        invites = {}


def _save_invite(code, invite):
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute(
            "INSERT OR REPLACE INTO invites (code, data, created_at) VALUES (?, ?, ?)",
            (code, json.dumps(invite, ensure_ascii=False),
             invite.get("created_at", datetime.now().isoformat()))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[HERALD] Could not save invite {code}: {e}")


def make_invite_code():
    chars = string.ascii_lowercase + string.digits
    while True:
        code = "".join(random.choices(chars, k=8))
        if code not in invites:
            return code


# ── PROFILE HELPERS ───────────────────────────────────────────────────────────

def get_profile(user_id):
    return user_profiles.get(user_id, {
        "name": "", "ai_name": "Herald", "location": "", "email": "",
        "notes": [], "memories": [], "learned_facts": [],
        "preferences": {}, "query_counts": {},
        "created_at": datetime.now().isoformat(),
        "paid": False, "paid_until": None, "trial_days": 30,
        "referral_code": None, "referred_by": None, "free_days_earned": 0,
        # v7.4 watcher fields
        "watches": [],
        "topic_touches": [],
        "pending_watch_offer": None,
        "capabilities": {},
        # v7.6 proactive loop
        "proactive_queue": [],
    })

def save_profile(user_id, profile):
    user_profiles[user_id] = profile
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute(
            "INSERT OR REPLACE INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)",
            (user_id, json.dumps(profile, ensure_ascii=False), datetime.now().isoformat())
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[HERALD] Could not save profile for {user_id}: {e}")

def save_profile_fields(user_id, updates: dict):
    profile = get_profile(user_id)
    profile.update(updates)
    save_profile(user_id, profile)

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


# ── WATCHER HELPERS (v7.4) ────────────────────────────────────────────────────

def _check_extraction_budget(user_id: str) -> bool:
    today = date.today().isoformat()
    record = _extraction_counts.get(user_id, {"date": today, "count": 0})
    if record["date"] != today:
        record = {"date": today, "count": 0}
    if record["count"] >= MAX_EXTRACTION_CALLS_PER_DAY:
        return False
    record["count"] += 1
    _extraction_counts[user_id] = record
    return True

def has_watch_intent(message: str) -> bool:
    msg_lower = message.lower()
    return any(kw in msg_lower for kw in WATCH_KEYWORDS)

def check_capability_offer(message: str, profile: dict):
    capabilities = profile.get("capabilities", {})
    msg_lower = message.lower()
    for cap in BUILT_CAPABILITIES:
        if capabilities.get(cap):
            continue
        triggers = CAPABILITY_TRIGGERS.get(cap, [])
        if any(t in msg_lower for t in triggers):
            return CAPABILITY_OFFERS.get(cap)
    return None

def _get_offer_phrase(interest_type: str, name: str, topic: str, touch_count: int) -> str:
    pools = {
        "trip_planning": TRAVEL_OFFER_PHRASES,
        "task_planning":  TASK_OFFER_PHRASES,
        "research":       RESEARCH_OFFER_PHRASES,
        "ongoing":        WATCH_OFFER_PHRASES,
    }
    phrases = pools.get(interest_type, WATCH_OFFER_PHRASES)
    return phrases[touch_count % len(phrases)].format(name=name or "there", topic=topic)

def log_topic_touch(profile: dict, topic_label: str, interest_type: str) -> dict:
    touches = profile.get("topic_touches", [])
    today = date.today().isoformat()
    existing = next((t for t in touches if t["topic_label"] == topic_label), None)
    if existing:
        last_seen = existing.get("last_seen", today)
        try:
            days_since = (date.today() - date.fromisoformat(last_seen)).days
        except Exception:
            days_since = 0
        if days_since > 30:
            existing["count"] = 1
            existing["first_seen"] = today
        else:
            existing["count"] += 1
        existing["last_seen"] = today
        existing["interest_type"] = interest_type
    else:
        touches.append({
            "topic_label": topic_label,
            "interest_type": interest_type,
            "count": 1,
            "first_seen": today,
            "last_seen": today,
            "offered": False,
            "offer_suppressed_until": None,
        })
    profile["topic_touches"] = touches
    return profile

def check_promotion_threshold(profile: dict, topic_label: str, classification: dict) -> bool:
    touches = profile.get("topic_touches", [])
    touch = next((t for t in touches if t["topic_label"] == topic_label), None)
    if not touch:
        return False
    if touch.get("offered"):
        return False
    suppressed_until = touch.get("offer_suppressed_until")
    if suppressed_until:
        try:
            if date.today() < date.fromisoformat(suppressed_until):
                return False
        except Exception:
            pass
    count = touch.get("count", 0)
    if count % 3 != 0:
        return False
    interest_type = classification.get("interest_type", "ongoing")
    logistics = classification.get("logistics_signals", False)
    thresholds = {"ongoing": 7, "trip_planning": 4, "task_planning": 5, "research": 5}
    required = thresholds.get(interest_type, 7)
    if interest_type == "trip_planning":
        return count >= required and logistics
    return count >= required

def mark_topic_offered(profile: dict, topic_label: str, accepted: bool) -> dict:
    touches = profile.get("topic_touches", [])
    for touch in touches:
        if touch["topic_label"] == topic_label:
            if accepted:
                touch["offered"] = True
            else:
                future = (date.today() + timedelta(days=14)).isoformat()
                touch["offer_suppressed_until"] = future
    profile["topic_touches"] = touches
    return profile

def store_watch(profile: dict, watch_data: dict) -> dict:
    watches = profile.get("watches", [])
    desc_new = watch_data.get("description", "").lower()
    if any(w.get("description", "").lower() == desc_new for w in watches):
        return profile
    watch = {
        "id": str(uuid.uuid4())[:8],
        "type": watch_data.get("type", "other"),
        "description": watch_data.get("description", ""),
        "params": watch_data.get("params", {}),
        "offer_email": watch_data.get("offer_email", False),
        "active": True,
        "created_at": datetime.utcnow().isoformat(),
        "last_checked": None,
        "last_triggered": None,
    }
    watches.append(watch)
    profile["watches"] = watches
    return profile

def _build_watcher_context(profile: dict) -> str:
    lines = []
    watches = profile.get("watches", [])
    active = [w for w in watches if w.get("active")]
    if active:
        watch_list = ", ".join(w["description"] for w in active[:5])
        lines.append(f"User has active watches: {watch_list}.")
    pending = profile.get("pending_watch_offer")
    if pending:
        try:
            offer = json.loads(pending) if isinstance(pending, str) else pending
            if offer.get("type") == "email_needed":
                desc = offer.get("description", "that")
                lines.append(
                    f"INSTRUCTION: User just set a watch for '{desc}' but has no email on file. "
                    f"Confirm the watch then ask for their email in one natural sentence. "
                    f"Example: 'Got it, I will watch {desc} for you. What email should I send alerts to?'"
                )
            elif offer.get("type") == "explicit_confirm":
                desc = offer.get("description", "that")
                lines.append(
                    f"INSTRUCTION: User just set a watch for '{desc}'. "
                    f"Confirm warmly in one sentence at the end of your response. "
                    f"Example: 'Got it — I'll keep an eye on {desc} and let you know.' "
                    f"Keep it brief. Main answer first."
                )
            elif offer.get("type") == "implicit_offer":
                offer_text = offer.get("offer_text", "")
                lines.append(
                    f"INSTRUCTION: Herald noticed a recurring interest. "
                    f"At the END of your response, naturally add (word for word): "
                    f"'{offer_text}' — Answer the question first. Offer is secondary."
                )
            elif offer.get("type") == "capability_offer":
                cap_text = offer.get("offer_text", "")
                lines.append(
                    f"INSTRUCTION: At the END of your response, add: '{cap_text}'"
                )
        except Exception:
            pass
    return " ".join(lines)

def classify_topic(message: str, profile: dict):
    user_id = profile.get("user_id", "unknown")
    if not _check_extraction_budget(user_id):
        return None
    touches = profile.get("topic_touches", [])
    name = profile.get("name", "")
    prompt = TOPIC_CLASSIFICATION_PROMPT.format(
        message=message[:400],
        name=name,
        touches_json=json.dumps([
            {"topic_label": t["topic_label"], "count": t["count"]}
            for t in touches[:10]
        ])
    )
    try:
        payload = json.dumps({
            "model": HAIKU_MODEL,
            "max_tokens": 120,
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")
        req = urllib.request.Request(OR_URL, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "HTTP-Referer": "https://apexempire.ai",
            "X-Title": "Herald Personal AI"
        }, method="POST")
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        raw = data["choices"][0]["message"]["content"].strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(raw)
    except Exception as e:
        print(f"[HERALD] classify_topic (non-fatal): {e}")
        return None

def extract_explicit_watch(message: str):
    prompt = EXPLICIT_WATCH_PROMPT.format(message=message[:300])
    try:
        payload = json.dumps({
            "model": HAIKU_MODEL,
            "max_tokens": 150,
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")
        req = urllib.request.Request(OR_URL, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "HTTP-Referer": "https://apexempire.ai",
            "X-Title": "Herald Personal AI"
        }, method="POST")
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        raw = data["choices"][0]["message"]["content"].strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(raw)
    except Exception as e:
        print(f"[HERALD] extract_explicit_watch (non-fatal): {e}")
        return None

def generate_watch_content(watch_data: dict, profile: dict) -> str:
    topic = watch_data.get("description", "your topic")
    interest_type = watch_data.get("type", "other")
    name = profile.get("name", "there")
    params = watch_data.get("params", {})
    type_instructions = {
        "trip_planning": "Top 5-7 places to visit, practical tips, best time, what families love, a hidden gem or two, and 2-3 booking links.",
        "task_planning": "Key things to understand, the right questions to ask, typical cost ranges, red flags to watch, and what to do first.",
        "research":      "Current state of knowledge, what the research actually shows, key facts, and 2-3 reliable sources.",
        "ongoing":       "Latest developments, what's worth knowing right now, and what to watch for next.",
    }
    instructions = type_instructions.get(interest_type, type_instructions["ongoing"])
    prompt = (
        f"You are Herald, a warm and knowledgeable personal AI.\n"
        f"Write a helpful summary for {name} about: {topic}\n"
        f"Details: {json.dumps(params)}\n\n"
        f"Cover: {instructions}\n\n"
        f"Style: Write like a knowledgeable friend. Flowing paragraphs only, no bullet lists, no headers. "
        f"Include 2-3 helpful links where genuinely useful (format: TEXT -> URL). "
        f"350-450 words max. End with one personal note from Herald."
    )
    try:
        payload = json.dumps({
            "model": HAIKU_MODEL,
            "max_tokens": 700,
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")
        req = urllib.request.Request(OR_URL, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "HTTP-Referer": "https://apexempire.ai",
            "X-Title": "Herald Personal AI"
        }, method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[HERALD] generate_watch_content failed: {e}")
        return f"I put together some notes on {topic} but hit a technical snag getting them to you. Ask me directly and I'll walk you through everything."

def send_watch_email(profile: dict, watch_data: dict, content: str) -> bool:
    email = profile.get("email", "")
    if not email:
        return False
    if not SENDGRID_KEY:
        return False
    name = profile.get("name", "there")
    topic = watch_data.get("description", "your topic")
    html_body = re.sub(r'(.+?) -> (https?://\S+)', r'<a href="\2" style="color:#2563eb;">\1</a>', content)
    html_body = html_body.replace("\n", "<br>")
    html = (
        f'<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fafafa;">'
        f'<div style="border-left:3px solid #2563eb;padding-left:16px;margin-bottom:28px;">'
        f'<p style="margin:0;color:#2563eb;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">Herald pulled this together for you</p>'
        f'<h2 style="margin:8px 0 0;color:#1a1a1a;font-size:22px;">{topic}</h2>'
        f'</div>'
        f'<div style="color:#333;line-height:1.9;font-size:16px;">{html_body}</div>'
        f'<div style="margin-top:40px;padding-top:20px;border-top:1px solid #e5e5e5;">'
        f'<p style="color:#999;font-size:12px;margin:0;">Sent by Herald &middot; herald@apexempire.ai</p>'
        f'</div></div>'
    )
    payload = json.dumps({
        "personalizations": [{"to": [{"email": email, "name": name}]}],
        "from": {"email": "herald@apexempire.ai", "name": "Herald"},
        "subject": f"Herald: Here's what I found on {topic}",
        "content": [{"type": "text/html", "value": html}]
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {SENDGRID_KEY}"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"[HERALD] Watch email sent -> {email} | topic: {topic} | status: {resp.status}")
            return True
    except urllib.error.HTTPError as e:
        print(f"[HERALD] SendGrid error {e.code}: {e.read().decode()[:200]}")
        return False
    except Exception as e:
        print(f"[HERALD] SendGrid error: {e}")
        return False


# ── WATCHER CRON HELPERS (v7.5) ───────────────────────────────────────────────

def fetch_espn_scores(league: str) -> list:
    sport_map = {
        'nba': ('basketball', 'nba'),
        'nfl': ('football', 'nfl'),
        'mlb': ('baseball', 'mlb'),
        'nhl': ('hockey', 'nhl'),
    }
    sport, league_slug = sport_map.get(league.lower(), ('basketball', 'nba'))
    try:
        url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league_slug}/scoreboard"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read().decode())
        games = []
        for event in data.get("events", []):
            comp = event.get("competitions", [{}])[0]
            competitors = comp.get("competitors", [])
            status = event.get("status", {}).get("type", {})
            if len(competitors) < 2:
                continue
            t1 = competitors[0]
            t2 = competitors[1]
            games.append({
                "home_team":  t1["team"]["displayName"],
                "away_team":  t2["team"]["displayName"],
                "home_score": t1.get("score", "0"),
                "away_score": t2.get("score", "0"),
                "status":     status.get("description", ""),
                "completed":  status.get("completed", False),
            })
        return games
    except Exception as e:
        print(f"[HERALD] fetch_espn_scores({league}) failed: {e}")
        return []

def fetch_crypto_prices_batch() -> dict:
    try:
        url = ("https://api.coingecko.com/api/v3/simple/price"
               "?ids=bitcoin,ethereum,solana&vs_currencies=usd")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        return {
            "BTC": data.get("bitcoin", {}).get("usd", 0),
            "ETH": data.get("ethereum", {}).get("usd", 0),
            "SOL": data.get("solana", {}).get("usd", 0),
        }
    except Exception as e:
        print(f"[HERALD] fetch_crypto_prices_batch failed: {e}")
        return {}

def _hours_since(iso_str) -> float:
    if not iso_str:
        return 9999
    try:
        then = datetime.fromisoformat(iso_str)
        return (datetime.utcnow() - then).total_seconds() / 3600
    except Exception:
        return 9999

def check_sports_watch(watch: dict, scores_cache: dict):
    params = watch.get("params", {})
    team   = params.get("team", "").lower()
    league = params.get("league", "NBA").lower()
    if _hours_since(watch.get("last_triggered")) < 12:
        return None
    if league not in scores_cache:
        scores_cache[league] = fetch_espn_scores(league)
    for game in scores_cache[league]:
        home = game["home_team"].lower()
        away = game["away_team"].lower()
        if not (team in home or team in away):
            continue
        if not game.get("completed"):
            continue
        h = int(game["home_score"] or 0)
        a = int(game["away_score"] or 0)
        winner = game["home_team"] if h > a else game["away_team"]
        loser  = game["away_team"] if h > a else game["home_team"]
        w_score = max(h, a)
        l_score = min(h, a)
        return f"Final: {winner} {w_score}, {loser} {l_score}."
    return None

def check_crypto_watch(watch: dict, prices: dict):
    params    = watch.get("params", {})
    symbol    = params.get("symbol", "BTC").upper()
    condition = params.get("condition", "")
    threshold = params.get("threshold", 0)
    if not condition or not threshold:
        return None
    if _hours_since(watch.get("last_triggered")) < 4:
        return None
    price = prices.get(symbol, 0)
    if not price:
        return None
    if condition == "below" and price < threshold:
        return f"{symbol} dropped below {threshold:,.0f} dollars. Now at {price:,.0f} dollars."
    if condition == "above" and price > threshold:
        return f"{symbol} crossed above {threshold:,.0f} dollars. Now at {price:,.0f} dollars."
    return None

def check_stock_watch(watch: dict, stock_cache: dict):
    params    = watch.get("params", {})
    symbol    = params.get("symbol", "").upper()
    condition = params.get("condition", "")
    threshold = params.get("threshold", 0)
    if not symbol or not condition or not threshold:
        return None
    if _hours_since(watch.get("last_triggered")) < 4:
        return None
    if symbol not in stock_cache:
        stock_cache[symbol] = fetch_yahoo_stock(symbol)
    raw = stock_cache.get(symbol)
    if not raw:
        return None
    try:
        price_match = re.search(r'trading at ([\d,]+) dollars', raw)
        if not price_match:
            return None
        price = float(price_match.group(1).replace(",", ""))
        if condition == "below" and price < threshold:
            return f"{symbol} is below {threshold:,.0f} dollars. Now at {price:,.0f} dollars."
        if condition == "above" and price > threshold:
            return f"{symbol} crossed {threshold:,.0f} dollars. Now at {price:,.0f} dollars."
    except Exception:
        pass
    return None

def check_news_watch(watch: dict):
    if _hours_since(watch.get("last_triggered")) < 2:
        return None
    params = watch.get("params", {})
    topic  = params.get("topic", watch.get("description", ""))
    if not topic:
        return None
    result = fetch_news_direct(topic)
    if result and "top stories" in result.lower():
        first = result.split(". Next,")[0].replace("Here are the top stories right now: ", "")
        return f"New on {topic}: {first}."
    return None


# ── GAS PRICE WATCHER (v7.6) ──────────────────────────────────────────────────

def fetch_gas_price_eia():
    """
    Fetch weekly average US regular gasoline price from EIA.
    Free government API. Updates every Monday.
    Returns (price_float, period_str) or (None, None) on failure.
    """
    if not EIA_KEY:
        return None, None
    try:
        url = (
            "https://api.eia.gov/v2/petroleum/pri/gnd/data/"
            f"?api_key={EIA_KEY}"
            "&frequency=weekly"
            "&data[]=value"
            "&facets[product][]=EPM0"
            "&facets[duoarea][]=R10"
            "&offset=0&length=2"
            "&sort[0][column]=period&sort[0][direction]=desc"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode())
        rows = data.get("response", {}).get("data", [])
        if not rows:
            return None, None
        price  = float(rows[0].get("value", 0))
        period = rows[0].get("period", "")
        return price, period
    except Exception as e:
        print(f"[HERALD] EIA gas price failed: {e}")
        return None, None


def check_gas_watch(watch: dict, gas_cache: dict) -> str:
    """
    Alert when gas price moves >= threshold cents from last stored value.
    Lazy-loads EIA price once per cron run shared across all users.
    Max one alert per 24 hours per user.
    """
    if _hours_since(watch.get("last_triggered")) < 24:
        return None

    if "us_regular" not in gas_cache:
        price, period = fetch_gas_price_eia()
        if price:
            gas_cache["us_regular"] = {"price": price, "period": period}
        else:
            return None

    current = gas_cache["us_regular"]["price"]
    params  = watch.setdefault("params", {})

    # First check -- store baseline, no alert yet
    if params.get("last_price") is None:
        params["last_price"] = current
        print(f"[HERALD] Gas watch baseline set: ${current:.3f}/gal")
        return None

    last      = float(params["last_price"])
    change    = current - last
    threshold = float(params.get("threshold", 0.05))

    if abs(change) < threshold:
        return None

    direction_pref = params.get("direction", "any")
    if direction_pref == "down" and change >= 0:
        return None
    if direction_pref == "up" and change <= 0:
        return None

    params["last_price"] = current

    direction = "dropped" if change < 0 else "went up"
    cents     = round(abs(change) * 100)
    dol       = int(current)
    rem_cents = round((current - dol) * 100)
    price_str = f"{dol} dollars and {rem_cents} cents" if rem_cents else f"{dol} dollars"

    return (
        f"Gas prices {direction} {cents} cents since last week. "
        f"Regular is now averaging {price_str} per gallon nationally."
    )


def send_alert_email(profile: dict, watch: dict, alert_msg: str) -> bool:
    email = profile.get("email", "")
    if not email or not SENDGRID_KEY:
        return False
    name  = profile.get("name", "there")
    topic = watch.get("description", "your watch")
    html  = (
        f'<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fafafa;">'
        f'<div style="border-left:3px solid #1A9B8A;padding-left:16px;margin-bottom:24px;">'
        f'<p style="margin:0;color:#1A9B8A;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">Herald Watch Alert</p>'
        f'<h2 style="margin:8px 0 0;color:#1a1a1a;font-size:20px;">{topic}</h2>'
        f'</div>'
        f'<p style="color:#333;line-height:1.8;font-size:16px;">Hey {name} — {alert_msg}</p>'
        f'<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;">'
        f'<p style="color:#999;font-size:12px;margin:0;">Sent by Herald &middot; herald@apexempire.ai</p>'
        f'</div></div>'
    )
    payload = json.dumps({
        "personalizations": [{"to": [{"email": email, "name": name}]}],
        "from": {"email": "herald@apexempire.ai", "name": "Herald"},
        "subject": f"Herald: Update on {topic}",
        "content": [{"type": "text/html", "value": html}]
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {SENDGRID_KEY}"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"[HERALD] Alert email -> {email} | {topic} | {resp.status}")
            return True
    except Exception as e:
        print(f"[HERALD] Alert email failed: {e}")
        return False


def _run_watcher_pipeline(message: str, profile: dict, user_id: str):
    try:
        changed = False
        pending_offer = None

        if has_watch_intent(message):
            watch_data = extract_explicit_watch(message)
            if watch_data:
                profile = store_watch(profile, watch_data)
                if profile.get("email"):
                    pending_offer = json.dumps({
                        "type": "explicit_confirm",
                        "description": watch_data.get("description", "that"),
                    })
                else:
                    pending_offer = json.dumps({
                        "type": "email_needed",
                        "description": watch_data.get("description", "that"),
                    })
                changed = True
                print(f"[HERALD] Explicit watch stored: {watch_data.get('description')}")

        if _check_extraction_budget.__code__:
            classification = classify_topic(message, profile)
            if (classification
                    and classification.get("touch_worthy")
                    and not classification.get("is_acute_health")):
                topic_label = classification.get("topic_label", "")
                interest_type = classification.get("interest_type", "ongoing")
                profile = log_topic_touch(profile, topic_label, interest_type)
                changed = True

                if not pending_offer and check_promotion_threshold(profile, topic_label, classification):
                    touches = profile.get("topic_touches", [])
                    touch = next((t for t in touches if t["topic_label"] == topic_label), {})
                    touch_count = touch.get("count", 0)
                    offer_text = _get_offer_phrase(
                        interest_type,
                        profile.get("name", ""),
                        topic_label,
                        touch_count
                    )
                    pending_offer = json.dumps({
                        "type": "implicit_offer",
                        "topic_label": topic_label,
                        "interest_type": interest_type,
                        "offer_text": offer_text,
                        "offer_email": interest_type in ["trip_planning", "task_planning", "research"],
                    })
                    print(f"[HERALD] Implicit watch offer queued: {topic_label} ({interest_type})")

        if changed or pending_offer:
            save_profile_fields(user_id, {
                "watches": profile.get("watches", []),
                "topic_touches": profile.get("topic_touches", []),
                "pending_watch_offer": pending_offer,
            })

    except Exception as e:
        print(f"[HERALD] _run_watcher_pipeline (non-fatal): {e}")


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
        'our conversations','about our conversation','what can you tell me about',
        'what do you remember','tell me what you remember',
        'previous conversations','past conversations','what have we talked',
    ]
    return any(t in message.lower() for t in triggers)

def is_memory_trigger(message):
    triggers = [
        'remember that', 'remember this', "don't forget", "dont forget",
        'make a note', 'note that', 'keep in mind', 'take note',
        'write this down', 'save this',
    ]
    return any(t in message.lower() for t in triggers)

def extract_memory_fact(message):
    msg = message.strip()
    for prefix in ['remember that', 'remember this', "don't forget", "dont forget",
                   'make a note that', 'make a note', 'note that', 'keep in mind that',
                   'keep in mind', 'take note that', 'take note', 'write this down',
                   'save this']:
        if prefix in msg.lower():
            idx = msg.lower().index(prefix) + len(prefix)
            fact = msg[idx:].strip().lstrip(':').strip()
            if fact:
                return fact[:120]
    return msg[:120]


# ── LLM LEARNING LOOP (v7.3) ──────────────────────────────────────────────────

def extract_learned_facts(user_id, user_message, herald_reply):
    try:
        prompt = f"""Analyze this conversation turn. Extract facts the USER revealed about themselves.

User said: "{user_message[:300]}"
Herald replied: "{herald_reply[:200]}"

Return ONLY valid JSON, no other text, no markdown fences:

If facts were revealed:
{{"learned": [{{"category": "music", "value": "loves jazz", "confidence": "high"}}]}}

Categories: music, food, sports, health, location, family, work, hobby, routine, preference

If nothing new was revealed:
{{"learned": null}}

Rules:
- Only extract what the USER said, not what Herald said
- high confidence = explicit statement (I love jazz), medium = implied
- Max 3 facts per turn
- Values must be under 40 characters"""

        messages = [{"role": "user", "content": prompt}]
        result = call_openrouter(messages, use_search=False, model=HAIKU_MODEL)

        clean = result.strip().replace("```json", "").replace("```", "").strip()
        data  = json.loads(clean)
        facts = data.get("learned")
        if not facts:
            return

        profile = get_profile(user_id)
        learned = profile.setdefault("learned_facts", [])

        added = 0
        for fact in facts:
            cat  = fact.get("category", "").strip()
            val  = fact.get("value", "").strip()
            conf = fact.get("confidence", "medium")
            if cat and val:
                exists = any(
                    f.get("category") == cat and f.get("value") == val
                    for f in learned
                )
                if not exists:
                    learned.append({
                        "category":   cat,
                        "value":      val,
                        "confidence": conf,
                        "learned_at": datetime.now().isoformat()
                    })
                    added += 1

        profile["learned_facts"] = learned[-50:]
        save_profile(user_id, profile)
        if added:
            new_vals = [f["value"] for f in learned[-added:]]
            print(f"[HERALD] Learned {added} new fact(s) for {user_id}: {new_vals}")

    except Exception as e:
        print(f"[HERALD] extract_learned_facts (non-fatal): {e}")


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


# ── BUILD ABOUT ME (v7.3 -- LLM-powered) ──────────────────────────────────────

def build_about_me(profile):
    name          = profile.get("name", "")
    ai_name       = profile.get("ai_name", "Herald")
    location      = profile.get("location", "")
    notes         = profile.get("notes", [])
    memories      = profile.get("memories", [])
    learned_facts = profile.get("learned_facts", [])
    query_counts  = profile.get("query_counts", {})
    created       = profile.get("created_at", "")

    days_known = 0
    if created:
        try:
            days_known = (datetime.now() - datetime.fromisoformat(created)).days
        except Exception:
            pass

    all_notes = list(dict.fromkeys((memories + notes)[-10:]))
    top_cats  = [c for c, n in sorted(query_counts.items(), key=lambda x: -x[1])[:3] if n >= 2]
    facts_str = "; ".join([f"{f['value']} ({f['category']})" for f in learned_facts[-20:]]) \
                if learned_facts else "none yet"

    profile_context = (
        f"Name: {name or 'not yet known'}\n"
        f"Location: {location or 'not yet known'}\n"
        f"Days we have known each other: {days_known}\n"
        f"Things they have told me: {'; '.join(all_notes) if all_notes else 'none yet'}\n"
        f"Facts learned from conversation: {facts_str}\n"
        f"Most asked about: {', '.join(top_cats) if top_cats else 'not yet known'}"
    )

    prompt = [
        {"role": "system", "content": (
            f"You are {ai_name}, a warm personal AI companion. "
            "The user asked what you know about them. "
            "Write a natural, conversational 2 to 4 sentence response from memory. "
            "No bullet points, no lists, no markdown, no asterisks. "
            "Speak like a trusted friend who genuinely remembers things about this person. "
            "Format all numbers in words for text-to-speech. "
            f"{'Use their name once naturally.' if name else ''} "
            "If you know very little yet, say so warmly and invite them to share more."
        )},
        {"role": "user", "content": f"Profile:\n{profile_context}\n\nWhat do you know about me?"}
    ]

    try:
        result = call_openrouter(prompt, use_search=False, model=HAIKU_MODEL)
        if result and len(result) > 20:
            return result
    except Exception as e:
        print(f"[HERALD] build_about_me LLM failed, using fallback: {e}")

    first_name = name if name else "friend"
    parts = [f"Here is what I know so far, {first_name}."]
    if location:
        parts.append(f"You are based in {location}.")
    if all_notes:
        parts.append(f"You have mentioned: {'; '.join(all_notes[:3])}.")
    if learned_facts:
        vals = [f["value"] for f in learned_facts[-3:]]
        parts.append(f"I have also picked up that {', '.join(vals)}.")
    if not all_notes and not learned_facts:
        parts.append("Honestly I am still getting to know you. The more we talk the better I understand what matters to you.")
    else:
        parts.append("The more you share the better I get.")
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
               f"To continue, it is just 7 dollars and 99 cents a month or 59 dollars for the year. I will be right here.")
    elif days_remaining <= 3:
        status = "trial_warning"
        msg = (f"Hey {first_name}, just {days_remaining} day{'s' if days_remaining != 1 else ''} left in your free trial. "
               f"Keep {ai_name} for 7 dollars and 99 cents a month, tap below anytime.")
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
    try:
        req = urllib.request.Request(EMPIRE_URL, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

def fetch_live_empire():
    try:
        url = "http://143.198.18.66:8080/api/status"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/7.6"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode())
        positions     = data.get("positions", [])
        gate          = data.get("gate", {})
        macro         = data.get("macro", {})
        active_setups = data.get("active_setups", [])
        near_miss     = data.get("near_miss", [])
        clean_trades  = data.get("clean_trades", gate.get("clean_trades", 0))
        clean_wr      = data.get("clean_win_rate", 0)
        total_pnl     = data.get("total_pnl", 0)
        expectancy    = data.get("expectancy", 0)
        avg_win       = data.get("avg_win", 0)
        avg_loss      = data.get("avg_loss", 0)
        last_scan     = data.get("last_scan", "unknown")
        forge_done    = data.get("forge_completed", [])
        stage   = gate.get("stage", "STAGE_0_PAPER")
        regime  = macro.get("regime", "UNKNOWN")
        fg      = macro.get("fear_greed", "?")
        window  = macro.get("window_type", "UNKNOWN")
        llama   = macro.get("defillama_tvl") or {}
        tvl_sig = llama.get("signal", "N/A")
        tvl_b   = llama.get("tvl_usd", 0)
        pos_lines = []
        for p in positions:
            asset     = p.get("asset","?").replace("USD","")
            direction = p.get("direction","?")
            entry     = p.get("entry", 0)
            price     = p.get("price")
            pnl       = p.get("unreal_pnl")
            grade     = p.get("grade","?")
            ttype     = p.get("trade_type","SCALP")
            pnl_str   = f"+${pnl:.2f}" if pnl and pnl > 0 else (f"-${abs(pnl):.2f}" if pnl and pnl < 0 else "even")
            live_str  = f"now ${price:.4f}" if price else ""
            pos_lines.append(f"  {asset} {direction} [{ttype} Grade:{grade}]: entry ${entry:.4f} {live_str} | P&L {pnl_str}")
        setup_lines = []
        for s in active_setups:
            asset     = s.get("asset","?").replace("USD","")
            direction = s.get("direction","?")
            grade     = s.get("grade","?")
            confirm   = s.get("confirm_15m","N/A")
            entry     = s.get("entry",0)
            setup_lines.append(f"  {direction} {asset} Grade:{grade} 15m:{confirm} entry:${entry:.4f}")
        nm_lines = []
        for n in near_miss[-3:]:
            asset = n.get("asset","?")
            score = n.get("score","?")
            bdir  = n.get("best_dir","?")
            nm_lines.append(f"  {asset} {bdir} scored {score}/100 -- just below threshold")
        forge_names   = [f.get("id","?") for f in forge_done] if forge_done else []
        pos_section   = "\n".join(pos_lines)   if pos_lines   else "  None -- flat"
        setup_section = "\n".join(setup_lines) if setup_lines else "  None this scan"
        nm_section    = "\n".join(nm_lines)    if nm_lines    else "  None today"
        forge_section = ", ".join(forge_names) if forge_names else "none recorded"
        gate_pct      = round(clean_trades / 20 * 100, 1)
        return f"""FREDDIE EMPIRE -- LIVE INTELLIGENCE:

POSITIONS ({len(positions)} open):
{pos_section}

ACTIVE SETUPS (last scan):
{setup_section}

NEAR MISS SETUPS:
{nm_section}

PERFORMANCE:
  Clean trades: {clean_trades}/20 gate ({gate_pct}%) | Stage: {stage}
  Win rate: {clean_wr:.1f}% | Total P&L: ${total_pnl:+.2f}
  Expectancy: ${expectancy:+.2f}/trade | Avg win: ${avg_win:.2f} | Avg loss: ${avg_loss:.2f}

MARKET CONTEXT:
  Regime: {regime} | Window: {window} | Fear & Greed: {fg}
  Solana TVL: ${tvl_b/1e9:.1f}B | Signal: {tvl_sig}

SYSTEM:
  Last scan: {last_scan} | Forges built: {forge_section}
"""
    except Exception as e:
        empire = fetch_empire()
        if empire:
            return build_empire_context(empire) + "\n[Live feed unavailable -- using hourly snapshot]"
        return f"\nFreddie status unavailable right now ({e}). Try again in a moment.\n"

def build_empire_context(empire):
    if not empire:
        return "FREDDIE TRADING: Empire data unavailable right now."
    lines = []
    lines.append(f"FREDDIE TRADING STATUS (synced {empire.get('updated_at','unknown')}):")
    lines.append(f"Mode: {empire.get('mode','unknown')} | Bankroll: ${empire.get('bankroll',0)} | Regime: {empire.get('regime','unknown')}")
    lines.append(f"Gate: {empire.get('gate_progress','0/70')} clean trades | Win rate: {empire.get('win_rate',0)}% | P&L: ${empire.get('total_pnl',0)}")
    positions = empire.get("open_positions", [])
    if positions:
        lines.append(f"OPEN POSITIONS ({len(positions)}):")
        for p in positions:
            lines.append(f"  {p.get('asset','')} {p.get('direction','')} | entry ${p.get('entry',0)} | stop ${p.get('stop',0)} | target ${p.get('target',0)}")
    else:
        lines.append("OPEN POSITIONS: None -- flat right now")
    return "\n".join(lines)


# ── GEOCODING ─────────────────────────────────────────────────────────────────

def geocode_reverse(lat, lng):
    if not GEOCODING_KEY:
        return None
    try:
        url = (f"https://maps.googleapis.com/maps/api/geocode/json"
               f"?latlng={lat},{lng}&result_type=locality|administrative_area_level_1"
               f"&key={GEOCODING_KEY}")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/7.6"})
        with urllib.request.urlopen(req, timeout=4) as r:
            data = json.loads(r.read().decode())
        if data.get("results"):
            components = data["results"][0]["address_components"]
            city  = next((c["long_name"]  for c in components if "locality" in c["types"]), None)
            state = next((c["short_name"] for c in components if "administrative_area_level_1" in c["types"]), None)
            if city and state:
                return f"{city}, {state}"
            return data["results"][0].get("formatted_address")
    except Exception as e:
        print(f"[HERALD] Geocode failed: {e}")
    return None


# ── BRAVE SEARCH ──────────────────────────────────────────────────────────────

def fetch_brave_search(query, count=5):
    if not BRAVE_KEY:
        return None
    try:
        encoded = urllib.parse.quote(query)
        url = (f"https://api.search.brave.com/res/v1/web/search"
               f"?q={encoded}&count={count}&search_lang=en&country=us&text_decorations=false")
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "X-Subscription-Token": BRAVE_KEY,
            "User-Agent": "HeraldAI/7.6"
        })
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        results = data.get("web", {}).get("results", [])
        if not results:
            return None
        snippets = []
        for result in results[:4]:
            title = result.get("title", "")
            desc  = result.get("description", "")
            if desc:
                snippets.append(f"{title}: {desc}")
        return "\n".join(snippets) if snippets else None
    except Exception as e:
        print(f"[HERALD] Brave search failed: {e}")
        return None


# ── DIRECT API FUNCTIONS ──────────────────────────────────────────────────────

def extract_weather_location(message, profile_location):
    msg = message.lower()
    for kw in [" in ", " for ", " at "]:
        if kw in msg:
            idx = msg.index(kw) + len(kw)
            loc = message[idx:].strip().rstrip("?.,!")
            if loc and len(loc) > 2:
                return loc
    return profile_location or "Dallas TX"

def fetch_weather_direct(location):
    try:
        clean_loc = location.strip().replace(' ', '+')
        url = f"https://wttr.in/{clean_loc}?format=j1"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        cur  = data["current_condition"][0]
        area = data["nearest_area"][0]
        city     = area["areaName"][0]["value"]
        region   = area["region"][0]["value"]
        temp_f   = cur["temp_F"]
        feels_f  = cur["FeelsLikeF"]
        desc     = cur["weatherDesc"][0]["value"]
        humidity = cur["humidity"]
        wind_mph = cur["windspeedMiles"]
        today    = data["weather"][0]
        high_f   = today["maxtempF"]
        low_f    = today["mintempF"]
        hourly   = today.get("hourly", [])
        rain_chance = max((int(h.get("chanceofrain", 0)) for h in hourly), default=0)
        rain_str = (f"There is a {rain_chance} percent chance of rain today."
                    if rain_chance > 15 else "No significant rain expected today.")
        return (f"Right now in {city}, {region} it is {temp_f} degrees and {desc.lower()}. "
                f"Feels like {feels_f} degrees. Humidity {humidity} percent, wind {wind_mph} miles per hour. "
                f"Today's high is {high_f}, low is {low_f}. {rain_str}")
    except Exception as e:
        print(f"[HERALD] wttr.in failed: {e}")
        return None

def fetch_weather_backup(location):
    if not WEATHER_KEY:
        return None
    try:
        encoded = urllib.parse.quote(location)
        url = f"https://api.weatherapi.com/v1/forecast.json?key={WEATHER_KEY}&q={encoded}&days=1&aqi=no"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        cur  = data["current"]
        fore = data["forecast"]["forecastday"][0]["day"]
        city     = data["location"]["name"]
        region   = data["location"]["region"]
        temp_f   = cur["temp_f"]
        feels_f  = cur["feelslike_f"]
        desc     = cur["condition"]["text"]
        humidity = cur["humidity"]
        wind_mph = cur["wind_mph"]
        high_f   = fore["maxtemp_f"]
        low_f    = fore["mintemp_f"]
        rain_pct = fore["daily_chance_of_rain"]
        rain_str = (f"There is a {rain_pct} percent chance of rain today."
                    if rain_pct > 15 else "No significant rain expected today.")
        return (f"Right now in {city}, {region} it is {temp_f:.0f} degrees and {desc.lower()}. "
                f"Feels like {feels_f:.0f} degrees. Humidity {humidity} percent, wind {wind_mph:.0f} miles per hour. "
                f"Today's high is {high_f:.0f}, low is {low_f:.0f}. {rain_str}")
    except Exception as e:
        print(f"[HERALD] WeatherAPI backup failed: {e}")
        return None

def fetch_sports_direct(msg_lower):
    try:
        sport_map = {
            'cowboys':   ('football',   'nfl'),
            'rangers':   ('baseball',   'mlb'),
            'mavs':      ('basketball', 'nba'),
            'mavericks': ('basketball', 'nba'),
            'stars':     ('hockey',     'nhl'),
            'nfl':       ('football',   'nfl'),
            'nba':       ('basketball', 'nba'),
            'mlb':       ('baseball',   'mlb'),
            'nhl':       ('hockey',     'nhl'),
        }
        sport, league = 'football', 'nfl'
        for key, val in sport_map.items():
            if key in msg_lower:
                sport, league = val
                break
        url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        events = data.get("events", [])
        if not events:
            return f"No {league.upper()} games scheduled right now."
        lines = []
        for e in events[:3]:
            comps       = e.get("competitions", [{}])[0]
            competitors = comps.get("competitors", [])
            if len(competitors) >= 2:
                t1 = competitors[0]; t2 = competitors[1]
                n1 = t1["team"]["shortDisplayName"]; n2 = t2["team"]["shortDisplayName"]
                s1 = t1.get("score", "0");           s2 = t2.get("score", "0")
                status = e.get("status", {}).get("type", {}).get("description", "")
                lines.append(f"{n1} {s1}, {n2} {s2}, {status}")
        if lines:
            return f"Here are the latest {league.upper()} scores: " + ". ".join(lines) + "."
        return f"No {league.upper()} scores available right now."
    except Exception as e:
        print(f"[HERALD] ESPN API failed: {e}")
        return None

def fetch_crypto_direct():
    try:
        url = ("https://api.coingecko.com/api/v3/simple/price"
               "?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        parts = []
        for coin, label in [("bitcoin","Bitcoin"),("ethereum","Ethereum"),("solana","Solana")]:
            if coin in data:
                price  = data[coin]["usd"]
                change = data[coin].get("usd_24h_change", 0)
                direc  = "up" if change >= 0 else "down"
                price_int   = int(price)
                price_cents = round((price - price_int) * 100)
                if price_cents > 0:
                    price_str = f"{price_int:,} dollars and {price_cents} cents"
                else:
                    price_str = f"{price_int:,} dollars"
                parts.append(f"{label} is at {price_str}, {direc} {abs(change):.1f} percent today")
        return ". ".join(parts) + "." if parts else None
    except Exception as e:
        print(f"[HERALD] CoinGecko failed: {e}")
        return None

def fetch_news_direct(query=None):
    if not GNEWS_KEY:
        return fetch_news_backup(query)
    try:
        if query:
            encoded = urllib.parse.quote(query)
            url = f"https://gnews.io/api/v4/search?q={encoded}&lang=en&max=5&token={GNEWS_KEY}"
        else:
            url = f"https://gnews.io/api/v4/top-headlines?lang=en&country=us&max=5&token={GNEWS_KEY}"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        articles = data.get("articles", [])
        if not articles:
            return fetch_news_backup(query)
        titles = [a["title"] for a in articles[:3]]
        return "Here are the top stories right now: " + ". Next, ".join(titles) + "."
    except Exception as e:
        print(f"[HERALD] GNews failed: {e}")
        return fetch_news_backup(query)

def fetch_news_backup(query=None):
    if not NEWSDATA_KEY:
        return None
    try:
        if query:
            encoded = urllib.parse.quote(query)
            url = f"https://newsdata.io/api/1/latest?apikey={NEWSDATA_KEY}&q={encoded}&language=en"
        else:
            url = f"https://newsdata.io/api/1/latest?apikey={NEWSDATA_KEY}&language=en&country=us"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        results = data.get("results", [])
        if not results:
            return None
        titles = [a["title"] for a in results[:3] if a.get("title")]
        return "Here are the top stories: " + ". Next, ".join(titles) + "."
    except Exception as e:
        print(f"[HERALD] NewsData backup failed: {e}")
        return None

def fetch_movie_direct(query):
    if not OMDB_KEY:
        return None
    try:
        encoded = urllib.parse.quote(query)
        url = f"https://www.omdbapi.com/?t={encoded}&apikey={OMDB_KEY}"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read().decode())
        if d.get("Response") == "False":
            url2 = f"https://www.omdbapi.com/?s={encoded}&apikey={OMDB_KEY}"
            req2 = urllib.request.Request(url2, headers={"User-Agent": "HeraldAI/7.6"})
            with urllib.request.urlopen(req2, timeout=5) as r2:
                d2 = json.loads(r2.read().decode())
            results = d2.get("Search", [])
            if results:
                titles = [f"{r['Title']} from {r['Year']}" for r in results[:3]]
                return "Here are some matches: " + ", ".join(titles) + "."
            return None
        title  = d.get("Title", "")
        year   = d.get("Year", "")
        rating = d.get("imdbRating", "N/A")
        plot   = d.get("Plot", "")
        genre  = d.get("Genre", "")
        rt     = next((r["Value"] for r in d.get("Ratings", []) if r["Source"] == "Rotten Tomatoes"), None)
        rt_str = f" Rotten Tomatoes: {rt}." if rt else ""
        return f"{title} from {year} is a {genre} film rated {rating} out of 10 on IMDb.{rt_str} {plot}"
    except Exception as e:
        print(f"[HERALD] OMDb failed: {e}")
        return None


# ── COMMODITY FUNCTIONS ───────────────────────────────────────────────────────

def detect_commodity(message):
    msg_lower = message.lower()
    for name in sorted(COMMODITY_MAP.keys(), key=len, reverse=True):
        if name in msg_lower:
            return COMMODITY_MAP[name]
    return None

def fetch_commodity_price(ticker, display_name):
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read().decode())
        result = data['chart']['result'][0]
        meta       = result['meta']
        price      = meta.get('regularMarketPrice', 0)
        prev_close = meta.get('previousClose') or meta.get('chartPreviousClose', 0)
        change     = price - prev_close if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0
        direc      = "up" if change >= 0 else "down"
        price_int   = int(price)
        price_cents = round((price - price_int) * 100)
        price_str   = (f"{price_int:,} dollars and {price_cents} cents"
                       if price_cents else f"{price_int:,} dollars")
        abs_change = abs(change)
        chg_int    = int(abs_change)
        chg_cents  = round((abs_change - chg_int) * 100)
        chg_str    = (f"{chg_int} dollars and {chg_cents} cents"
                      if chg_cents else f"{chg_int} dollars")
        return (f"{display_name.title()} is trading at {price_str} per ounce, "
                f"{direc} {chg_str} or {abs(change_pct):.1f} percent today.")
    except Exception as e:
        print(f"[HERALD] Commodity fetch failed for {ticker}: {e}")
        return None


# ── STOCK SYMBOL EXTRACTION ───────────────────────────────────────────────────

def extract_stock_symbol(message):
    if detect_commodity(message):
        return None
    known = {
        'APPLE': 'AAPL', 'MICROSOFT': 'MSFT', 'GOOGLE': 'GOOGL', 'ALPHABET': 'GOOGL',
        'AMAZON': 'AMZN', 'TESLA': 'TSLA', 'META': 'META', 'FACEBOOK': 'META',
        'NVIDIA': 'NVDA', 'NETFLIX': 'NFLX', 'DISNEY': 'DIS', 'WALMART': 'WMT',
        'COCA COLA': 'KO', 'COKE': 'KO', 'FORD': 'F', 'JPMORGAN': 'JPM', 'CHASE': 'JPM',
        'PALANTIR': 'PLTR', 'AMD': 'AMD', 'INTEL': 'INTC', 'UBER': 'UBER',
        'AIRBNB': 'ABNB', 'COINBASE': 'COIN', 'ROBINHOOD': 'HOOD',
    }
    msg_upper = message.upper()
    for name, ticker in known.items():
        if name in msg_upper:
            return ticker
    words = message.split()
    for w in words:
        clean = re.sub(r'[^A-Za-z]', '', w)
        if not clean:
            continue
        up = clean.upper()
        if (2 <= len(up) <= 5
                and up.isalpha()
                and clean == clean.upper()
                and up not in TICKER_STOP_WORDS):
            return up
    return None

def fetch_yahoo_stock(symbol):
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol.upper()}?interval=1d&range=1d"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read().decode())
        result = data['chart']['result'][0]
        meta   = result['meta']
        price      = meta.get('regularMarketPrice', 0)
        prev_close = meta.get('previousClose') or meta.get('chartPreviousClose', 0)
        change     = price - prev_close if prev_close else 0
        change_pct = (change / prev_close * 100) if prev_close else 0
        long_name  = meta.get('longName', symbol.upper())
        direc = "up" if change >= 0 else "down"
        price_int   = int(price)
        price_cents = round((price - price_int) * 100)
        price_str   = (f"{price_int:,} dollars and {price_cents} cents"
                       if price_cents else f"{price_int:,} dollars")
        abs_change = abs(change)
        chg_int    = int(abs_change)
        chg_cents  = round((abs_change - chg_int) * 100)
        chg_str    = (f"{chg_int} dollars and {chg_cents} cents"
                      if chg_cents else f"{chg_int} dollars")
        return (f"{long_name} is trading at {price_str}, "
                f"{direc} {chg_str} or {abs(change_pct):.1f} percent today.")
    except Exception as e:
        print(f"[HERALD] Yahoo Finance failed for {symbol}: {e}")
        return None

def fetch_stock_direct(symbol):
    result = fetch_yahoo_stock(symbol)
    if result:
        return result
    if not ALPHA_KEY:
        return None
    try:
        url = (f"https://www.alphavantage.co/query?function=GLOBAL_QUOTE"
               f"&symbol={symbol.upper()}&apikey={ALPHA_KEY}")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/7.6"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        q = data.get("Global Quote", {})
        if not q or not q.get("05. price"):
            return None
        price  = float(q.get("05. price", 0))
        change = float(q.get("09. change", 0))
        pct    = q.get("10. change percent", "0%").replace("%","").strip()
        direc  = "up" if change >= 0 else "down"
        price_int   = int(price)
        price_cents = round((price - price_int) * 100)
        price_str   = (f"{price_int} dollars and {price_cents} cents"
                       if price_cents else f"{price_int} dollars")
        return (f"{symbol.upper()} is trading at {price_str}, "
                f"{direc} {abs(change):.2f} dollars or {abs(float(pct)):.2f} percent today.")
    except Exception as e:
        print(f"[HERALD] Alpha Vantage backup failed: {e}")
        return None


# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

def build_system(profile, local_time=None, owner=False, empire=None, lat=None, lng=None, location_label=None):
    now      = local_time or datetime.now().strftime("%A, %B %d %Y %I:%M %p")
    name     = profile.get("name", "")
    ai_name  = profile.get("ai_name", "Herald")
    location = profile.get("location", "")
    notes    = profile.get("notes", [])
    memories = profile.get("memories", [])

    user_line = (f"User's name: {name}. Use their name naturally and occasionally -- "
                 f"like a trusted friend would. Not every sentence. Just when it feels right."
                 if name else "User name not yet learned.")

    if lat and lng:
        city_hint = f" near {location_label}" if location_label else (f" in {location}" if location else "")
        loc_line = (f"User's current GPS location{city_hint} ({lat}, {lng}). "
                    f"Always include a MAPS action tag on local business recommendations.")
    elif location:
        loc_line = f"User is located in {location}. For local searches use '{location} [thing]'."
    else:
        loc_line = "Location not yet learned -- ask naturally when relevant."

    all_memory = list(dict.fromkeys((memories + notes)[-12:]))
    notes_line = ("What this user has told you (remember and use naturally): "
                  + "; ".join(all_memory)) if all_memory else ""

    prefs_summary = build_preferences_summary(profile)
    prefs_line = f"Preferences learned over time:\n{prefs_summary}" if prefs_summary else ""

    learned_facts = profile.get("learned_facts", [])
    facts_line = ""
    if learned_facts:
        recent    = learned_facts[-20:]
        facts_str = "; ".join([f"{f['value']} ({f['category']})" for f in recent])
        facts_line = f"Facts learned from conversation: {facts_str}"

    watcher_context = _build_watcher_context(profile)

    context_parts = [p for p in [notes_line, prefs_line, facts_line] if p]
    context_block = "\n".join(context_parts) if context_parts else "Still learning about this user."
    empire_section = f"\n\n{empire}" if owner and empire else ""
    watcher_section = f"\n\n{watcher_context}" if watcher_context else ""

    return f"""You are {ai_name} -- a trusted personal AI companion.

{user_line}
{loc_line}
{context_block}

Current time: {now}{empire_section}{watcher_section}

YOUR IDENTITY:
You are the smartest, most well-read friend this person has ever had. You know about
health, money, food, travel, sports, news, weather, cooking, parenting, cars,
relationships -- everything. When someone asks you something, you answer it. Directly.
Confidently. Like a trusted friend who happens to know everything.

YOUR RULES:
- Answer every question. Never deflect, hedge, or say you cannot help with something simple.
- Speak like a warm, confident friend -- 2 to 3 sentences max unless the user asks for more.
- Match your response length to the question. Simple questions get one sentence.
  Complex topics get a short paragraph. Never pad. Never summarize what you just said.
- Never use asterisks, markdown, bullet points, or raw URLs in responses.
- NEVER say: I do not have access to that. I cannot look that up. My knowledge has a cutoff.
  I don't have memory of our conversations. I can't remember previous sessions.
  These phrases are BANNED. You have the user's profile, memories, and notes -- use them.
- NEVER list sources or citations unless the user specifically asks.
- For local business queries give ONE confident recommendation with a MAPS tag.
- Be diplomatically honest -- tell the truth with warmth. Never make things up.
- Never mention Claude, OpenAI, Anthropic, or any AI model. You are {ai_name}.
- You speak out loud via text-to-speech. Format ALL responses for listening, not reading.
- You are {ai_name}. That is your only identity.
- Never comment on how many times something has been asked.

VOICE FORMATTING -- CRITICAL:
You speak through a text-to-speech engine. Follow these rules for every response:
- Write prices in words: say "seventy-four dollars and two cents" not "$74.02"
- Write large numbers in words: say "one point two million" not "1,200,000"
- Write percentages in words: say "twelve and a half percent" not "12.5%"
- Write temperatures in words: say "eighty-five degrees" not "85 degrees F"
- Never use symbols: no $, %, degrees symbol, #, *, &, or @ in your responses
- Spell out abbreviations: say "miles per hour" not "mph"
- Never start a response with a number -- spell it out or rephrase

THE STANDARD: Would the smartest, most resourceful friend this person knows answer
this question confidently and warmly? Yes. Then so do you. Always.

ACTION TAGS -- append silently at end, never explain them:
- Local business or directions: MAPS: [business name and city]
- Phone number: PHONE: [digits only]
- Play music/song/artist/genre: MUSIC: [search query]
- Play radio station: RADIO: [station name]
- Set reminder/calendar event: CALENDAR: [event title]|[YYYY-MM-DD]|[HH:MM or blank]
- Set alarm: ALARM: [HH:MM]|[label]
- Find videos or social content: SEARCH: [search query]
- Open social app: LAUNCH: [app name]
- One action tag maximum per response.
- When using an action tag, end your response with a short natural verbal offer to open it.
- Never give a flat one-sentence answer to a personal or conversational question."""


# ── LLM CALLS ─────────────────────────────────────────────────────────────────

def parse_action(reply):
    for tag, atype in [('MAPS:', 'maps'), ('PHONE:', 'phone'), ('MUSIC:', 'music'),
                       ('RADIO:', 'radio'), ('CALENDAR:', 'calendar'), ('ALARM:', 'alarm'),
                       ('SEARCH:', 'search'), ('LAUNCH:', 'launch')]:
        if tag in reply:
            parts = reply.split(tag, 1)
            clean = parts[0].strip()
            value = parts[1].strip().split('\n')[0].strip()
            return clean, {'type': atype, 'value': value}
    return reply, None

def call_openrouter(messages, use_search=True, model=None):
    if not OPENROUTER_KEY:
        return "Configuration error: API key not set on server."
    if model is None:
        model = MODEL_SEARCH if use_search else MODEL_FAST
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
        return "I ran into a snag on that one, try asking me again in a moment."
    except Exception:
        return "I did not get a response in time, try again in a second."

def call_openrouter_with_search(messages, query, model=None):
    if BRAVE_KEY:
        search_ctx = fetch_brave_search(query)
        if search_ctx:
            augmented = messages.copy()
            augmented[-1] = {
                "role": "user",
                "content": f"{query}\n\n[Live web search results:\n{search_ctx}]"
            }
            result = call_openrouter(augmented, use_search=False, model=model)
            return result, False
    return call_openrouter(messages, use_search=True), True

def stream_from_openrouter(messages, use_search=True, model=None):
    if not OPENROUTER_KEY:
        yield "Configuration error: API key not set."
        return
    if model is None:
        model = MODEL_SEARCH if use_search else MODEL_FAST
    payload = json.dumps({
        "model": model,
        "max_tokens": 600,
        "messages": messages,
        "stream": True
    }).encode("utf-8")
    ctx  = ssl.create_default_context()
    conn = http.client.HTTPSConnection("openrouter.ai", context=ctx, timeout=25)
    try:
        conn.request("POST", "/api/v1/chat/completions", payload, {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "HTTP-Referer": "https://apexempire.ai",
            "X-Title": "Herald Personal AI",
            "Content-Length": str(len(payload))
        })
        resp = conn.getresponse()
        if resp.status != 200:
            yield "I ran into a snag on that one, try asking me again in a moment."
            return
        buf = b""
        while True:
            chunk = resp.read(512)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", errors="ignore").strip()
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    return
                try:
                    data  = json.loads(data_str)
                    token = data["choices"][0]["delta"].get("content", "")
                    if token:
                        yield token
                except Exception:
                    pass
    except Exception as e:
        print(f"[HERALD] Stream error: {e}")
        yield "I did not get a response in time, try again in a second."
    finally:
        conn.close()

def text_to_speech(text):
    if not OPENAI_KEY:
        return None
    payload = json.dumps({"model": "tts-1", "input": text[:4096], "voice": "nova",
                          "response_format": "mp3"}).encode("utf-8")
    req = urllib.request.Request(TTS_URL, data=payload, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_KEY}"
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.read()
    except Exception:
        return None


# ── SHARED REQUEST SETUP ──────────────────────────────────────────────────────

def build_ask_context(data):
    user_id        = data.get("user_id", "").strip()
    message        = data.get("message", "").strip()
    if not user_id or not message:
        return None, "user_id and message required"

    history        = data.get("history", [])
    local_time     = data.get("local_time", None)
    lat            = data.get("lat", None)
    lng            = data.get("lng", None)
    location_label = data.get("location_label", None)
    auth_code      = data.get("auth_code", "").strip()

    owner   = is_owner(user_id, auth_code)
    empire  = fetch_live_empire() if owner else None
    profile = get_profile(user_id)
    profile["user_id"] = user_id
    msg_lower = message.lower()

    profile = detect_preferences(message, profile)
    category = tag_query_category(message)
    profile = increment_query_count(category, profile)

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
    email_match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', message)
    if email_match:
        profile["email"] = email_match.group(0).lower()
        print(f"[HERALD] Email saved for {user_id}: {profile['email']}")

    if "call you" in msg_lower or "your name is" in msg_lower:
        try:
            key = "call you" if "call you" in msg_lower else "your name is"
            profile["ai_name"] = message.split(key, 1)[1].strip().split()[0].rstrip(".,!?").title()
        except Exception: pass

    save_profile(user_id, profile)

    system   = build_system(profile, local_time, owner, empire, lat, lng, location_label)
    messages = [{"role": "system", "content": system}]
    messages += history[-20:]
    messages.append({"role": "user", "content": message})

    return {
        "user_id": user_id, "message": message, "msg_lower": msg_lower,
        "history": history, "local_time": local_time,
        "lat": lat, "lng": lng, "location_label": location_label,
        "auth_code": auth_code, "owner": owner, "empire": empire,
        "profile": profile, "messages": messages, "category": category,
    }, None

def get_direct_reply(ctx):
    message   = ctx["message"]
    msg_lower = ctx["msg_lower"]
    profile   = ctx["profile"]
    owner     = ctx["owner"]
    empire    = ctx["empire"]

    SYNC_TRIGGERS = ['sync', 'refresh', 'update freddie', 'sync empire', 'refresh data']
    if owner and any(t in msg_lower for t in SYNC_TRIGGERS):
        try:
            payload = json.dumps({"secret": WEBHOOK_SECRET}).encode("utf-8")
            req = urllib.request.Request(VM_WEBHOOK_URL, data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/7.6"},
                method="POST")
            with urllib.request.urlopen(req, timeout=35) as r:
                result = json.loads(r.read().decode())
            return ("Done. Just pulled a fresh snapshot from Freddie. What do you want to know?"
                    if result.get("ok") else "Sync ran but something went wrong on the VM."), False
        except Exception:
            return "Could not reach the VM right now. Try again in a second.", False

    FREDDIE_TRIGGERS = [
        'freddie','how are our trades','trading status','open positions',
        'gate progress','win rate','what did freddie','how is freddie',
        'empire status','regime','last scan','any setups','near miss',
        'expectancy','p&l','sovereign','forge','signal','bankroll',
    ]
    if owner and any(t in msg_lower for t in FREDDIE_TRIGGERS) and empire:
        freddie_prompt = [
            {"role": "system", "content": (
                "You are Herald, a personal AI. Answer in 2-4 sentences, conversationally. "
                "No bullet points. No markdown. Speak naturally. Format all numbers and prices "
                "in words for text-to-speech. Say 'dollars' not '$'. Say 'percent' not '%'."
                f"\n\nLIVE FREDDIE DATA:\n{empire}"
            )},
            {"role": "user", "content": message}
        ]
        return call_openrouter(freddie_prompt, use_search=False, model=HAIKU_MODEL), False

    if any(w in msg_lower for w in ['weather','forecast','temperature','rain','snow',
                                     'wind','sunny','humid','hot outside','cold outside','umbrella']):
        loc = extract_weather_location(message, profile.get('location','Dallas TX'))
        cached = cache_get(f'weather:{loc}', 'weather')
        if cached:
            return cached, False
        result = fetch_weather_direct(loc) or fetch_weather_backup(loc)
        cache_set(f'weather:{loc}', result, 'weather')
        return result, False

    if any(w in msg_lower for w in ['score','scores','game today','cowboys','rangers',
                                     'mavs','mavericks','stars','nfl','nba','mlb','nhl',
                                     'playoffs','standings']):
        return fetch_sports_direct(msg_lower), False

    if any(w in msg_lower for w in ['bitcoin','ethereum','solana','crypto','btc','eth',
                                     'sol price','crypto price']):
        cached = cache_get('crypto', 'crypto')
        if cached:
            return cached, False
        result = fetch_crypto_direct()
        cache_set('crypto', result, 'crypto')
        return result, False

    if any(w in msg_lower for w in ['news','headlines','top stories',
                                     'what is happening','what happened today']):
        cached = cache_get('news_top', 'news')
        if cached:
            return cached, False
        result = fetch_news_direct()
        cache_set('news_top', result, 'news')
        return result, False

    if any(w in msg_lower for w in ['movie','film','imdb','rotten tomatoes','what to watch','watch tonight']):
        for kw in ['about ','review of ','tell me about ']:
            if kw in msg_lower:
                idx = msg_lower.index(kw) + len(kw)
                query = message[idx:].strip().rstrip('?.,!')
                if query:
                    return fetch_movie_direct(query), False

    commodity_ticker = detect_commodity(message)
    if commodity_ticker:
        display_name = next(
            (k for k in sorted(COMMODITY_MAP.keys(), key=len, reverse=True)
             if COMMODITY_MAP[k] == commodity_ticker),
            commodity_ticker
        )
        cache_key = f'commodity:{commodity_ticker}'
        cached = cache_get(cache_key, 'commodity')
        if cached:
            return cached, False
        result = fetch_commodity_price(commodity_ticker, display_name)
        if result:
            cache_set(cache_key, result, 'commodity')
        return result, False

    if any(w in msg_lower for w in ['stock','share price','trading at','stock price',
                                     'how is','price of','how much is']):
        symbol = extract_stock_symbol(message)
        if symbol:
            cached = cache_get(f'stock:{symbol}', 'stock')
            if cached:
                return cached, False
            result = fetch_stock_direct(symbol)
            cache_set(f'stock:{symbol}', result, 'stock')
            return result, False

    return None, None


# ── TRIAL FIELDS HELPER ───────────────────────────────────────────────────────

def _trial_fields(trial):
    return {
        "trial_status":         trial["status"],
        "trial_days_remaining": trial["days_remaining"],
        "trial_show_wall":      trial["show_wall"],
        "trial_show_warning":   trial.get("show_warning", False),
        "trial_message":        trial.get("message"),
    }


# ═════════════════════════════════════════════════════════════════════════════
# FASTAPI ROUTES
# ═════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {
        "status": "ok", "server": "herald-api", "version": "7.6",
        "proactive_loop": "enabled (/proactive/{user_id} -- poll on app open + resume)",
        "watcher_cron": "enabled (/cron/watchers -- call every 30min with WEBHOOK_SECRET)",
        "learning_loop": "enabled (LLM extraction after every response)",
        "watcher_system": "enabled (explicit + implicit + gas + travel/task/research)",
        "model_routing": f"Haiku default / Sonnet for judgment",
        "streaming": "enabled (/ask/stream)",
        "search": f"brave={'configured' if BRAVE_KEY else 'NOT SET'} | fallback=haiku:online",
        "cache": f"{len(_cache)} entries active",
        "apis": {
            "weather":     "wttr.in (free) + weatherapi backup",
            "sports":      "ESPN (free, no key)",
            "crypto":      "CoinGecko (free, no key)",
            "stocks":      "Yahoo Finance (free) + Alpha Vantage backup",
            "commodities": "Yahoo Finance futures (free, no key)",
            "gas":         "EIA" if EIA_KEY else "NOT SET -- add EIA_API_KEY",
            "news":        "GNews" if GNEWS_KEY else "not configured",
            "news_bak":    "NewsData" if NEWSDATA_KEY else "not configured",
            "movies":      "OMDb" if OMDB_KEY else "not configured",
            "geocoding":   "Google" if GEOCODING_KEY else "not configured",
            "tts":         "OpenAI nova" if OPENAI_KEY else "not configured",
            "email":       "SendGrid" if SENDGRID_KEY else "SENDGRID_API_KEY not set",
            "sync":        "VM webhook" if WEBHOOK_SECRET else "WEBHOOK_SECRET not set",
        },
        "time": datetime.now().isoformat()
    }


@app.get("/proactive/{user_id}")
def get_proactive(user_id: str):
    """
    Frontend polls this on every app open and Capacitor resume event.
    Returns queued proactive messages then clears the queue.
    This is how Herald opens the conversation without being asked.
    Queue is written by /cron/watchers when a watch condition fires.
    """
    if not user_id:
        return {"messages": []}
    profile = get_profile(user_id)
    queue   = profile.get("proactive_queue", [])
    if not queue:
        return {"messages": []}
    profile["proactive_queue"] = []
    save_profile(user_id, profile)
    print(f"[HERALD] Proactive queue delivered to {user_id}: {len(queue)} message(s)")
    return {"messages": queue}


@app.get("/geocode")
def geocode(lat: str = None, lng: str = None):
    if not lat or not lng:
        return JSONResponse({"label": None, "error": "lat and lng required"}, status_code=400)
    label = geocode_reverse(lat, lng)
    return {"label": label}


@app.get("/empire")
def empire():
    data = fetch_empire()
    if not data:
        return JSONResponse({"error": "empire data unavailable"}, status_code=503)
    return data


@app.post("/auth")
async def auth(request: Request):
    data    = await request.json()
    code    = data.get("code", "").strip()
    user_id = data.get("user_id", "").strip()

    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)

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
        return {
            "ok": True, "user_id": user_id,
            "ai_name": profile.get("ai_name", "Herald"),
            "name": profile.get("name", ""),
            "onboarded": bool(profile.get("name")),
            "is_owner": is_owner(user_id, code)
        }
    elif code in invites:
        invite = invites[code]
        if not invite["used"]:
            invite["used"] = True
            invite["used_by"] = user_id
        elif invite["used_by"] != user_id:
            return JSONResponse({"error": "invite already used"}, status_code=401)
        invite["last_seen"] = datetime.now().isoformat()
        _save_invite(code, invite)
        profile = get_profile(user_id)
        if not profile.get("created_at"):
            profile["created_at"] = datetime.now().isoformat()
        if invite.get("label") and not profile.get("invite_label"):
            profile["invite_label"] = invite["label"]
        save_profile(user_id, profile)
        return {
            "ok": True, "user_id": user_id,
            "ai_name": profile.get("ai_name", "Herald"),
            "name": profile.get("name", ""),
            "onboarded": bool(profile.get("name")),
            "is_owner": False,
            "invite_label": invite.get("label", "")
        }
    else:
        return JSONResponse({"error": "invalid code"}, status_code=401)


@app.post("/ask")
def ask(request: Request):
    import asyncio
    data = asyncio.run(request.json())

    ctx, err = build_ask_context(data)
    if err:
        return JSONResponse({"error": err}, status_code=400)

    profile  = ctx["profile"]
    messages = ctx["messages"]
    message  = ctx["message"]
    user_id  = ctx["user_id"]

    if is_about_me_query(message):
        reply = build_about_me(profile)
        trial = get_trial_status(profile)
        if profile.get("pending_watch_offer"):
            save_profile_fields(user_id, {"pending_watch_offer": None})
        return {"reply": reply, "action": None,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "used_search": False, **_trial_fields(trial)}

    direct_reply, _ = get_direct_reply(ctx)
    if direct_reply:
        reply, action = parse_action(direct_reply)
        trial = get_trial_status(profile)
        if profile.get("pending_watch_offer"):
            save_profile_fields(user_id, {"pending_watch_offer": None})
        return {"reply": reply, "action": action,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "used_search": False, **_trial_fields(trial)}

    routed_model = route_model(message)
    use_search = needs_web_search(message) and routed_model != SONNET_MODEL

    cap_offer = check_capability_offer(message, profile)
    if cap_offer:
        messages[0]["content"] += f"\n\nINSTRUCTION: At the END of your response, naturally add: '{cap_offer}'"

    if use_search:
        raw_reply, _ = call_openrouter_with_search(messages, message, model=routed_model)
    else:
        raw_reply = call_openrouter(messages, use_search=False, model=routed_model)

    reply, action = parse_action(raw_reply)

    if profile.get("pending_watch_offer"):
        save_profile_fields(user_id, {"pending_watch_offer": None})

    threading.Thread(
        target=extract_learned_facts,
        args=(user_id, message, reply),
        daemon=True
    ).start()

    threading.Thread(
        target=_run_watcher_pipeline,
        args=(message, profile, user_id),
        daemon=True
    ).start()

    trial = get_trial_status(profile)
    return {"reply": reply, "action": action,
            "ai_name": profile.get("ai_name", "Herald"),
            "name": profile.get("name", ""),
            "used_search": use_search,
            "model_used": routed_model,
            **_trial_fields(trial)}


@app.post("/ask/stream")
async def ask_stream(request: Request):
    data = await request.json()

    ctx, err = build_ask_context(data)
    if err:
        return JSONResponse({"error": err}, status_code=400)

    profile    = ctx["profile"]
    messages   = ctx["messages"]
    message    = ctx["message"]
    user_id    = ctx["user_id"]

    routed_model = route_model(message)
    use_search   = needs_web_search(message) and routed_model != SONNET_MODEL

    cap_offer = check_capability_offer(message, profile)
    if cap_offer:
        messages[0]["content"] += f"\n\nINSTRUCTION: At the END of your response, naturally add: '{cap_offer}'"

    trial = get_trial_status(profile)
    base_done = {
        "done": True,
        "ai_name":      profile.get("ai_name", "Herald"),
        "name":         profile.get("name", ""),
        "model_used":   routed_model,
        **_trial_fields(trial)
    }

    def generate():
        if profile.get("pending_watch_offer"):
            save_profile_fields(user_id, {"pending_watch_offer": None})

        if is_about_me_query(message):
            reply = build_about_me(profile)
            yield f"data: {json.dumps({'t': reply})}\n\n"
            yield f"data: {json.dumps({'t': '[S]'})}\n\n"
            yield f"data: {json.dumps({**base_done, 'full': reply, 'action': None, 'used_search': False})}\n\n"
            return

        direct_reply, _ = get_direct_reply(ctx)
        if direct_reply:
            reply, action = parse_action(direct_reply)
            yield f"data: {json.dumps({'t': reply})}\n\n"
            yield f"data: {json.dumps({'t': '[S]'})}\n\n"
            yield f"data: {json.dumps({**base_done, 'full': reply, 'action': action, 'used_search': False})}\n\n"
            return

        full_text    = ""
        sentence_buf = ""

        def stream_with_sentences(token_source):
            nonlocal full_text, sentence_buf
            for token in token_source:
                full_text    += token
                sentence_buf += token
                yield f"data: {json.dumps({'t': token})}\n\n"
                if re.search(r'[.!?]\s', sentence_buf[-4:]):
                    yield f"data: {json.dumps({'t': '[S]'})}\n\n"
                    sentence_buf = ""
            if sentence_buf.strip():
                yield f"data: {json.dumps({'t': '[S]'})}\n\n"

        try:
            if use_search and BRAVE_KEY:
                search_ctx = fetch_brave_search(message)
                if search_ctx:
                    augmented = messages.copy()
                    augmented[-1] = {
                        "role": "user",
                        "content": f"{message}\n\n[Live web search results:\n{search_ctx}]"
                    }
                    yield from stream_with_sentences(stream_from_openrouter(augmented, use_search=False, model=routed_model))
                else:
                    yield from stream_with_sentences(stream_from_openrouter(messages, use_search=True))
            elif use_search:
                yield from stream_with_sentences(stream_from_openrouter(messages, use_search=True))
            else:
                yield from stream_with_sentences(stream_from_openrouter(messages, use_search=False, model=routed_model))

            reply, action = parse_action(full_text)

            threading.Thread(
                target=extract_learned_facts,
                args=(user_id, message, reply),
                daemon=True
            ).start()

            threading.Thread(
                target=_run_watcher_pipeline,
                args=(message, profile, user_id),
                daemon=True
            ).start()

            yield f"data: {json.dumps({**base_done, 'full': reply, 'action': action, 'used_search': use_search})}\n\n"

        except Exception as e:
            print(f"[HERALD] /ask/stream error: {e}")
            if full_text.strip():
                reply, action = parse_action(full_text)
                yield f"data: {json.dumps({**base_done, 'full': reply, 'action': action, 'used_search': use_search, 'partial': True})}\n\n"
            else:
                yield f"data: {json.dumps({'error': 'Stream interrupted. Try again.'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.post("/greeting")
async def greeting(request: Request):
    data           = await request.json()
    user_id        = data.get("user_id", "").strip()
    local_time     = data.get("local_time", "")
    lat            = data.get("lat", None)
    lng            = data.get("lng", None)
    location_label = data.get("location_label", None)

    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)

    profile = get_profile(user_id)
    name    = profile.get("name", "")
    ai_name = profile.get("ai_name", "Herald")

    try:
        hour = datetime.now().hour
    except Exception:
        hour = 9
    if hour < 12:
        salutation = "Good morning"
    elif hour < 17:
        salutation = "Good afternoon"
    else:
        salutation = "Good evening"

    name_part = f", {name}" if name else ""
    # Prefer explicitly learned location over GPS geocode label
    # User saying "I'm in Destin" beats what the GPS chip reports
    learned_location = ""
    for fact in profile.get("learned_facts", []):
        if fact.get("category") == "location":
            learned_location = fact.get("value", "")
            break
    location = learned_location or location_label or profile.get("location", "")
    weather_line = ""
    if location:
        cached  = cache_get(f'weather:{location}', 'weather')
        weather = cached or fetch_weather_direct(location)
        if weather and not cached:
            cache_set(f'weather:{location}', weather, 'weather')
        if weather:
            first = weather.split('.')[0].strip()
            weather_line = f" {first}."

    memories  = profile.get("memories", [])
    notes     = profile.get("notes", [])
    all_notes = (memories + notes)[-5:]
    memory_hook = ""
    if all_notes:
        memory_hook = f" You mentioned {all_notes[-1]}."

    greeting_text = f"{salutation}{name_part}.{weather_line}{memory_hook} What can I help you with today?"

    return {"ok": True, "greeting": greeting_text, "ai_name": ai_name, "name": name}


@app.post("/memory")
async def memory(request: Request):
    data    = await request.json()
    user_id = data.get("user_id", "").strip()
    message = data.get("message", "").strip()
    fact    = data.get("fact", "").strip()

    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)

    profile = get_profile(user_id)

    if not fact and message:
        fact = extract_memory_fact(message)

    if fact:
        memories = profile.setdefault("memories", [])
        if fact not in memories:
            memories.append(fact)
            if len(memories) > 30:
                memories = memories[-30:]
            profile["memories"] = memories
            save_profile(user_id, profile)
            name    = profile.get("name", "")
            confirm = f"Got it{', ' + name if name else ''}. I will remember that."
            return {"ok": True, "fact": fact, "confirm": confirm}
        else:
            return {"ok": True, "fact": fact, "confirm": "Already have that noted."}
    else:
        return JSONResponse({"error": "No fact to remember"}, status_code=400)


@app.post("/tts")
async def tts(request: Request):
    data = await request.json()
    text = data.get("text", "").strip()
    if not text:
        return JSONResponse({"error": "text required"}, status_code=400)
    audio = text_to_speech(text)
    if not audio:
        return JSONResponse({"error": "TTS unavailable"}, status_code=503)
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/profile")
async def profile_update(request: Request):
    data    = await request.json()
    user_id = data.get("user_id", "").strip()
    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)
    profile = get_profile(user_id)
    for field in ["name", "ai_name", "location", "email", "app_prefs"]:
        if field in data:
            profile[field] = data[field]
    save_profile(user_id, profile)
    return {"ok": True, "profile": profile}


@app.post("/invite/create")
async def invite_create(request: Request):
    data   = await request.json()
    secret = data.get("secret", "").strip()
    label  = data.get("label", "").strip()
    if not INVITE_SECRET or secret != INVITE_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    code = make_invite_code()
    invite = {
        "code": code, "label": label or "unnamed",
        "created_at": datetime.now().isoformat(),
        "used": False, "used_by": None, "last_seen": None,
    }
    invites[code] = invite
    _save_invite(code, invite)
    base_url = data.get("base_url", "https://crptofollower.github.io/herald-voice-app/index.html")
    return {"ok": True, "code": code, "label": label,
            "link": f"{base_url}?invite={code}"}


@app.post("/invite/list")
async def invite_list(request: Request):
    data   = await request.json()
    secret = data.get("secret", "").strip()
    if not INVITE_SECRET or secret != INVITE_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    invite_list_data = sorted(invites.values(), key=lambda x: x.get("created_at",""), reverse=True)
    return {"ok": True, "invites": invite_list_data, "total": len(invite_list_data)}


@app.post("/cron/watchers")
async def cron_watchers(request: Request):
    """
    Called every 30 min by VM crontab.
    Checks all active watches across all users.
    When a condition fires:
      - Writes to proactive_queue[] (delivered on next app open -- no push needed)
      - Sends email alert if user has email on file
    Batch fetches data -- API calls don't multiply with users.
    """
    data   = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    triggered_count = 0
    checked_count   = 0
    now_iso         = datetime.utcnow().isoformat()

    scores_cache = {}
    crypto_cache = {}
    stock_cache  = {}
    gas_cache    = {}

    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT user_id, data FROM profiles")
        rows = c.fetchall()
        conn.close()
    except Exception as e:
        return JSONResponse({"error": f"db error: {e}"}, status_code=500)

    for user_id, raw_data in rows:
        try:
            profile = json.loads(raw_data)
        except Exception:
            continue

        watches = [w for w in profile.get("watches", []) if w.get("active")]
        if not watches:
            continue

        watches_changed = False
        proactive_queue = profile.get("proactive_queue", [])
        queue_changed   = False

        for watch in watches:
            checked_count += 1
            watch_type    = watch.get("type", "other")
            trigger_msg   = None

            try:
                if watch_type == "sports":
                    trigger_msg = check_sports_watch(watch, scores_cache)

                elif watch_type == "crypto":
                    if not crypto_cache:
                        crypto_cache.update(fetch_crypto_prices_batch())
                    trigger_msg = check_crypto_watch(watch, crypto_cache)

                elif watch_type == "stock":
                    trigger_msg = check_stock_watch(watch, stock_cache)

                elif watch_type == "news":
                    trigger_msg = check_news_watch(watch)

                elif watch_type == "gas":
                    trigger_msg = check_gas_watch(watch, gas_cache)

                watch["last_checked"] = now_iso
                watches_changed = True

                if trigger_msg:
                    # Write to proactive_queue -- delivered on next app open
                    queue_item = {
                        "id":                str(uuid.uuid4())[:8],
                        "type":              watch_type,
                        "text":              trigger_msg,
                        "watch_description": watch.get("description", ""),
                        "created_at":        now_iso,
                    }
                    proactive_queue.append(queue_item)
                    if len(proactive_queue) > 5:
                        proactive_queue = proactive_queue[-5:]
                    queue_changed = True

                    # Email alert if user has email on file
                    email = profile.get("email", "")
                    if email:
                        send_alert_email(profile, watch, trigger_msg)

                    watch["last_triggered"] = now_iso
                    triggered_count += 1
                    print(f"[HERALD] Watch triggered: {user_id} | {watch.get('description')} | {trigger_msg[:60]}")

            except Exception as e:
                print(f"[HERALD] Watch check error ({user_id} / {watch.get('description')}): {e}")

        if watches_changed or queue_changed:
            profile["watches"]         = watches
            profile["proactive_queue"] = proactive_queue
            save_profile(user_id, profile)

    print(f"[HERALD] /cron/watchers complete: {checked_count} watches checked, {triggered_count} triggered")
    return {
        "ok": True,
        "checked": checked_count,
        "triggered": triggered_count,
        "ran_at": now_iso,
    }


@app.post("/sync")
async def sync(request: Request):
    data      = await request.json()
    user_id   = data.get("user_id", "").strip()
    auth_code = data.get("auth_code", "").strip()

    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)
    if not is_owner(user_id, auth_code):
        return JSONResponse({"error": "owner only"}, status_code=401)

    try:
        payload = json.dumps({"secret": WEBHOOK_SECRET}).encode("utf-8")
        req = urllib.request.Request(VM_WEBHOOK_URL, data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/7.6"},
            method="POST")
        with urllib.request.urlopen(req, timeout=35) as r:
            result = json.loads(r.read().decode())
        return {
            "ok":           result.get("ok", False),
            "triggered_at": result.get("triggered_at", ""),
            "message":      "Sync complete" if result.get("ok") else "Sync failed",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"VM unreachable: {str(e)[:100]}"}, status_code=503)


# ── STARTUP ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    init_db()
    load_profiles()
    load_invites()
    print(f"[HERALD API v7.6] FastAPI + uvicorn + SQLite + proactive loop LIVE")
    print(f"[HERALD API] OpenRouter:    {'YES' if OPENROUTER_KEY else 'MISSING -- required'}")
    print(f"[HERALD API] Model routing: Haiku ({HAIKU_MODEL}) / Sonnet ({SONNET_MODEL})")
    print(f"[HERALD API] Brave Search:  {'YES' if BRAVE_KEY else 'NOT SET -- add BRAVE_SEARCH_KEY'}")
    print(f"[HERALD API] EIA gas price: {'YES' if EIA_KEY else 'NOT SET -- add EIA_API_KEY'}")
    print(f"[HERALD API] OpenAI TTS:    {'YES' if OPENAI_KEY else 'not set'}")
    print(f"[HERALD API] SendGrid:      {'YES' if SENDGRID_KEY else 'NOT SET -- watch emails disabled'}")
    print(f"[HERALD API] Geocoding:     {'YES' if GEOCODING_KEY else 'not set'}")
    print(f"[HERALD API] GNews:         {'YES' if GNEWS_KEY else 'not set'}")
    print(f"[HERALD API] OMDb:          {'YES' if OMDB_KEY else 'not set'}")
    print(f"[HERALD API] AlphaVantage:  {'YES (backup only)' if ALPHA_KEY else 'not set'}")
    print(f"[HERALD API] NewsData:      {'YES' if NEWSDATA_KEY else 'not set'}")
    print(f"[HERALD API] WeatherAPI:    {'YES (backup)' if WEATHER_KEY else 'not set'}")
    print(f"[HERALD API] Database:      {DB_FILE}")
    print(f"[HERALD API] Owner code:    {'SET' if OWNER_CODE else 'NOT SET'}")
    print(f"[HERALD API] Invite secret: {'SET' if INVITE_SECRET else 'NOT SET'}")
    print(f"[HERALD API] Webhook:       {'SET' if WEBHOOK_SECRET else 'NOT SET'}")
    print(f"[HERALD API] Proactive:     ENABLED -- /proactive/{{user_id}} queues on watch trigger")
    print(f"[HERALD API] Learning loop: ENABLED -- extract_learned_facts() after every LLM response")
    print(f"[HERALD API] Watcher:       ENABLED -- explicit + implicit + gas + travel/task/research")
    print(f"[HERALD API] Built caps:    {BUILT_CAPABILITIES}")


if __name__ == "__main__":
    uvicorn.run("herald_api:app", host="0.0.0.0", port=PORT, reload=False)