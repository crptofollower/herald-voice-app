# herald_api.py
# Herald Backend -- Railway Cloud Server
# v8.69 -- morning briefing opener extracts text from dict facts
#          life_tracker cycle_type migration (NOT NULL default patch)
#          /user/export accepts profile owner_code match
#          PHONE tag: accepts name/relationship, Herald resolves to number
#          Contact resolution via contactsDB + expo-contacts fallback
#          20+ new app launch targets added (native, Samsung, medical, finance)
#          Brave date injection for time-sensitive queries (any topic, any sport, any show)
#          _localize_query upgraded: appends today's date when recency signal detected
#
# v8.12 -- Medical memory system (always include user city in MAPS tag)
#
# WHAT CHANGED vs v8.7:
#   v8.8:
#   - /geocode: caches confirmed city label in profile (lat/lng tolerance ~20 miles)
#     Fixes: "Arlington" showing instead of "The Colony" on every open
#   - build_system(): MEMORY RULES added -- Herald never announces memory retrieval
#     Herald never speaks raw GPS coordinates aloud
#     "Your ribs are Tuesday, right?" not "I remember you mentioned ribs"
#   - build_ask_context(): seed question injected for brand-new users (0-2 msgs, no memory)
#     Makes Mickey's first session feel like Herald already wants to know him
#   - afternoon_checkin_job(): 2pm ET daily -- "how's your afternoon going?"
#     Only fires if user active in last 7 days but not in last 2 hours
#   - evening_medication_job(): 7pm ET -- "did you take your medication?"
#     Only fires if medication keywords found in memories
#   - Version bumped to 8.8 throughout

import os, json, re, random, string, time, http.client, ssl, sqlite3, threading, uuid, math, contextlib
import urllib.request, urllib.error, urllib.parse
from datetime import datetime, timedelta, date
from starlette.concurrency import run_in_threadpool

import sentry_sdk
sentry_sdk.init(
    dsn=os.environ.get("SENTRY_DSN", ""),
    traces_sample_rate=0.1,
    send_default_pii=False,
)
from apscheduler.schedulers.background import BackgroundScheduler
import uvicorn
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

# ── LOGGING ───────────────────────────────────────────────────────────────────
# Suppress Uvicorn's socket.send() transport errors — these fire when a client
# disconnects mid-stream. Non-fatal, but flood Railway logs and hide real errors.
import logging

class _SuppressSocketSend(logging.Filter):
    def filter(self, record):
        return "socket.send() raised exception" not in record.getMessage()

logging.getLogger("uvicorn.error").addFilter(_SuppressSocketSend())

# ── APP ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Herald API", version="8.69")

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

# ── DB CONNECTION HELPER ──────────────────────────────────────────────────────
# v8.53: Context manager for all SQLite connections.
# Guarantees commit on success, rollback on exception, close always.
# WAL mode + 5s timeout eliminates "database is locked" errors.
# Note: wal_checkpoint intentionally NOT called on every close -- belongs
#       in a scheduled maintenance job, not per-connection overhead.

@contextlib.contextmanager
def get_db_connection():
    """Context manager for SQLite. WAL + timeout + auto commit/rollback/close."""
    conn = None
    try:
        conn = sqlite3.connect(DB_FILE, timeout=5)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA cache_size=-64000")   # ~64MB page cache
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()

# Alias kept for any internal reads that don't need the context manager pattern.
# All writes must use get_db_connection().
def _db_conn():
    conn = sqlite3.connect(DB_FILE, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

# ── MODEL ROUTING ─────────────────────────────────────────────────────────────

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
    "should i take", "what should i do", "what do you think",
    "advice on", "help me figure out",
    "worried about", "scared", "anxious", "feeling", "sad", "upset", "struggling",
    "depressed", "lonely", "angry", "frustrated",
    "relationship", "marriage", "family", "kids", "divorce", "breakup",
    "career", "job", "fired", "quit", "boss",
    "my doctor said", "diagnosis", "treatment option", "change my medication", "surgery",
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


# ── WATCHER SYSTEM ────────────────────────────────────────────────────────────

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

# ── PERSONALITY EXTRACTION ────────────────────────────────────────────────────
# v8.54: Per-user communication style and humor calibration.
# Runs every 3rd message alongside extract_learned_facts.
# Stored in profile["personality_profile"] -- accumulates over time.
# humor_weight: 0.0 (neutral) -> 1.0 (fully earned). Never decrements.

PERSONALITY_EXTRACTION_PROMPT = """Analyze this single user message for communication style signals.

User message: "{message}"

Return ONLY valid JSON, no preamble, no markdown:
{{"comm_style": "direct|verbose|casual|formal", "humor_signal": "dark|dry|warm|none", "earned_phrases": [], "word_count": 5}}

Rules:
- comm_style: direct = short declarative, verbose = long explanatory, casual = loose grammar/slang, formal = structured
- humor_signal: dark = morbid/gallows, dry = deadpan understatement, warm = lighthearted, none = neutral
- earned_phrases: exact short phrases or confirmations the user typed (max 3, only if genuinely distinctive -- e.g. "Clear", "Copy that", "Roger", "Bet", "Facts"). Empty list if nothing distinctive.
- word_count: integer word count of the message"""

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
CACHE_TTL = {'weather': 900, 'news': 600, 'crypto': 120, 'stock': 180, 'commodity': 180, 'brave_search': 120}

_empire_live_cache: dict = {"data": None, "ts": 0.0}

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


# Explicit live-data intents only. Bare time words (today, this week) and generic
# nouns (food, event, market) were removed -- they fired search on casual chat.
# Local "near me" queries are handled by FAST_OVERRIDES + MAPS, not Brave.
LIVE_KEYWORDS = [
    # Weather
    'weather', 'forecast', 'temperature', 'rain', 'snow', 'sunny', 'humid', 'wind',
    # News / current events (phrases, not bare "latest" or "update")
    'news', 'headline', 'headlines', 'breaking news', 'top stories', 'current events',
    'news today', 'news tonight', 'morning news', 'news briefing', 'morning briefing',
    'what is going on', "what's going on", 'what is happening in', 'what happened in',
    # Business hours / live venue status
    'is it open', 'are they open', 'still open', 'what time does', 'when does',
    'open till', 'open until', 'close at', 'hours today',
    # Markets (specific phrases -- not bare "market" or "price")
    'stock price', 'share price', 'trading at', 'price of', 'how much is',
    'stock market', 'bitcoin', 'crypto', 'ethereum', 'solana', 'exchange rate',
    'dow jones', 'nasdaq', 's&p 500', 's and p',
    # Sports scores
    'final score', 'game score', 'score today', 'score tonight', 'who won',
    'standings', 'playoffs', 'game today', 'game tonight',
    # Traffic / local events (specific)
    'traffic', 'road closure', 'traffic delay',
    'what to do this weekend', 'things to do in', 'events this weekend',
    'concert tonight', 'tickets for',
    # Social / video lookup
    'trending on', 'going viral', 'what are people saying about',
    'what is everyone saying about', 'what is the buzz about',
    'show me a video', 'video about', 'videos of', 'find a video',
    'on twitter', 'on x about', 'on instagram', 'on tiktok',
    # Freddie / empire (owner live data)
    'freddie', 'empire status', 'trading status', 'open positions', 'last scan',
    'how are our trades', 'gate progress',
]

FAST_OVERRIDES = [
    'what time is it', 'what do you know about me', 'tell me about yourself',
    'who are you', 'what can you do', 'remind me', 'my name is', 'i live in',
    'i love', 'i like', 'call you', 'how do i get to', 'directions to',
    'navigate to', 'take me to',
    # v8.12.3: Local business queries bypass Brave search entirely.
    # Herald knows the city. LLM gives one confident rec + MAPS tag.
    # Google Maps finds the actual business. Much faster than Brave.
    'good place near', 'good restaurant near', 'good coffee near',
    'restaurant near me', 'coffee near me', 'coffee shop near me',
    'place to eat near', 'place near me', 'bar near me', 'cafe near me',
    'food near me', 'eat near me', 'lunch near me', 'dinner near me',
    'breakfast near me', 'burger near me', 'pizza near me', 'sushi near me',
    'mexican near me', 'italian near me', 'chinese near me', 'thai near me',
    'bbq near me', 'steak near me', 'seafood near me', 'tacos near me',
    'gym near me', 'pharmacy near me', 'grocery near me', 'gas station near me',
    'open my x', 'open x', 'open twitter', 'get my x', 'get my twitter',
    'open instagram', 'get my instagram', 'open ig', 'get my ig',
    'open youtube', 'get my youtube', 'open tiktok', 'get my tiktok',
    'open facebook', 'get my facebook', 'open fb',
    'launch x', 'launch instagram', 'launch youtube', 'launch tiktok',
    'open linkedin', 'launch linkedin', 'get my linkedin',
    'open netflix', 'launch netflix', 'open hulu', 'launch hulu',
    'open spotify', 'launch spotify', 'get my spotify',
    'open amazon', 'launch amazon', 'open walmart', 'launch walmart',
    'open uber', 'launch uber', 'get me an uber',
    'open lyft', 'launch lyft', 'get me a lyft',
    'open doordash', 'launch doordash', 'open uber eats', 'launch uber eats',
    'open yelp', 'launch yelp',
    'open delta', 'launch delta', 'open southwest', 'launch southwest',
    'open united', 'launch united', 'open american airlines',
    'open airbnb', 'launch airbnb',
    'open cvs', 'launch cvs', 'open walgreens', 'launch walgreens',
    'open mychart', 'launch mychart', 'open my chart',
    'open google photos', 'launch google photos',
    'open pinterest', 'launch pinterest',
    'open facebook', 'open fb',
    'remember that', 'remember this', "don't forget", 'make a note',
    # Calendar / personal schedule -- never web search (device calendar context only)
    'what do i have', 'my calendar', 'my schedule', 'my appointments', 'my appointment',
    "what's on my calendar", 'whats on my calendar', 'what is on my calendar',
    'what do i have on my calendar', 'what do i have on my schedule',
    'what do i have today', 'what do i have tomorrow', 'what do i have this week',
    'coming up on my calendar', 'coming up this week', 'coming up today',
    'on my schedule', 'show my calendar', 'show my schedule', 'my agenda',
    'am i free', 'anything on my calendar', 'anything on my schedule',
    'my medical', 'medical visits', 'doctor appointment', 'my doctors',
    'my health', 'my medications', 'my prescriptions',
    'what have i told you', 'what do you remember', 'tell me what you know',
    'my medical history', 'my medical records', 'my doctors',
    'my medications', 'what medications am i on', 'my prescriptions',
    'email my medical', 'send my medical history', 'my health summary',
    'when did i see', 'last time i saw', 'my follow up',
]

PLACES_SIGNALS = [
    'burger near me', 'pizza near me', 'coffee near me',
    'restaurant near me', 'food near me', 'tacos near me',
    'sushi near me', 'breakfast near me', 'lunch near me',
    'dinner near me', 'bar near me', 'pub near me',
    'best burger', 'best pizza', 'best coffee',
    'best restaurant', 'place to eat near',
    'where to eat', 'good food near',
    'good burger', 'good pizza', 'good coffee',
    'good restaurant', 'good food near',
    'burger place', 'pizza place', 'coffee place',
    'burger spot', 'food spot',
    'good place to eat', 'where should i eat',
    'recommend a restaurant', 'recommend a place',
    'costco near', 'sams club near',
    'walmart near', 'target near',
    'pharmacy near', 'cvs near', 'walgreens near',
    'gas station near', 'urgent care near',
    'grocery near', 'grocery store near',
    'pharmacy near me', 'gas station near me',
    'urgent care near me', 'hospital near me',
    'grocery near me', 'walmart near me', 'target near me',
    'any good', 'anywhere good near',
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


# ── PERSISTENCE (SQLite) ──────────────────────────────────────────────────────

def init_db():
    try:
        os.makedirs("/data", exist_ok=True)
        conn = _db_conn()
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
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
        c.execute("""
            CREATE TABLE IF NOT EXISTS waitlist (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                email     TEXT UNIQUE NOT NULL,
                source    TEXT DEFAULT 'landing',
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # v8.12: Medical memory tables
        c.execute("""
            CREATE TABLE IF NOT EXISTS medical_records (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id         TEXT NOT NULL,
                doctor_name     TEXT,
                specialty       TEXT,
                practice        TEXT,
                location        TEXT,
                phone           TEXT,
                visit_date      TEXT,
                reason          TEXT,
                outcome         TEXT,
                follow_up_date  TEXT,
                follow_up_notes TEXT,
                medications     TEXT,
                tests_ordered   TEXT,
                results         TEXT,
                active          INTEGER DEFAULT 1,
                source          TEXT DEFAULT 'conversation',
                created_at      TEXT NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS medical_contacts (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id      TEXT NOT NULL,
                doctor_name  TEXT NOT NULL,
                specialty    TEXT,
                practice     TEXT,
                address      TEXT,
                phone        TEXT,
                last_seen    TEXT,
                next_visit   TEXT,
                notes        TEXT,
                active       INTEGER DEFAULT 1,
                created_at   TEXT NOT NULL,
                UNIQUE(user_id, doctor_name)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS life_tracker (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        TEXT NOT NULL,
                category       TEXT NOT NULL,
                item_name      TEXT NOT NULL,
                last_date      TEXT,
                next_due_date  TEXT,
                interval_days  INTEGER DEFAULT 0,
                source         TEXT DEFAULT 'conversation',
                active         INTEGER DEFAULT 1,
                created_at     TEXT NOT NULL
            )
        """)
        # v8.47+: migrate older DBs missing columns added after initial schema
        for _col, _def in [
            ("category",      "TEXT DEFAULT 'general'"),
            ("item_name",     "TEXT DEFAULT ''"),
            ("last_date",     "TEXT"),
            ("next_due_date", "TEXT"),
            ("interval_days", "INTEGER DEFAULT 0"),
            ("source",        "TEXT DEFAULT 'conversation'"),
            ("active",        "INTEGER DEFAULT 1"),
            ("cycle_type",    "TEXT DEFAULT 'custom'"),
        ]:
            try:
                c.execute(f"ALTER TABLE life_tracker ADD COLUMN {_col} {_def}")
            except Exception:
                pass  # column already exists — safe to ignore
        c.execute("""
            CREATE TABLE IF NOT EXISTS medication_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       TEXT NOT NULL,
                med_name      TEXT NOT NULL,
                dose          TEXT,
                prescriber    TEXT,
                start_date    TEXT,
                end_date      TEXT,
                reason        TEXT,
                refill_due    TEXT,
                active        INTEGER DEFAULT 1,
                created_at    TEXT NOT NULL
            )
        """)
        conn.commit()
        conn.close()
        print(f"[HERALD] SQLite ready: {DB_FILE}")
    except Exception as e:
        print(f"[HERALD] Database init failed: {e} -- profiles will not persist this session")


def load_profiles():
    global user_profiles, owner_user_ids
    try:
        conn = _db_conn()
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
        conn = _db_conn()
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
        with get_db_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO invites (code, data, created_at) VALUES (?, ?, ?)",
                (code, json.dumps(invite, ensure_ascii=False),
                 invite.get("created_at", datetime.now().isoformat()))
            )
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
        "watches": [],
        "topic_touches": [],
        "pending_watch_offer": None,
        "capabilities": {},
        "proactive_queue": [],
        "_msg_count": 0,
    })

def save_profile(user_id, profile):
    user_profiles[user_id] = profile
    _write_profile_to_db(user_id, profile)
    # Invalidate system prompt cache on profile change
    _system_prompt_cache.pop(user_id, None)


def save_profile_async(user_id, profile):
    """Update in-memory profile immediately; persist to SQLite in background."""
    user_profiles[user_id] = profile
    # Invalidate system prompt cache on profile change
    _system_prompt_cache.pop(user_id, None)
    snapshot = json.loads(json.dumps(profile, ensure_ascii=False))
    threading.Thread(
        target=_write_profile_to_db,
        args=(user_id, snapshot),
        daemon=True,
    ).start()


def _write_profile_to_db(user_id, profile):
    # v8.53: Retry only on lock contention. Exponential backoff. Context manager guarantees cleanup.
    for attempt in range(4):
        try:
            with get_db_connection() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)",
                    (user_id, json.dumps(profile, ensure_ascii=False), datetime.now().isoformat())
                )
            if attempt > 0:
                print(f"[HERALD] Profile saved for {user_id} after {attempt} retry(ies)")
            return True
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                time.sleep(0.1 * (2 ** attempt))  # 100ms, 200ms, 400ms
                continue
            print(f"[HERALD] Could not save profile for {user_id}: {e}")
            break
        except Exception as e:
            print(f"[HERALD] Unexpected error saving profile {user_id}: {e}")
            break
    return False

def save_profile_fields(user_id, updates: dict):
    profile = get_profile(user_id)
    profile.update(updates)
    save_profile(user_id, profile)
    # Invalidate system prompt cache on profile change
    _system_prompt_cache.pop(user_id, None)

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


# ── WATCHER HELPERS ───────────────────────────────────────────────────────────

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
    # v8.12.2: Lowered thresholds -- swarm should feel present faster.
    # North star: Herald notices things the way a friend does -- quickly.
    # Medical/family topics have lower threshold because they matter more.
    thresholds = {"ongoing": 3, "trip_planning": 3, "task_planning": 3, "research": 3}
    # Price/score topics fire even faster -- 2 touches and swarm offers to watch
    price_score_keywords = ['price', 'gas', 'score', 'stock', 'crypto', 'bitcoin', 'market']
    if any(kw in topic_label.lower() for kw in price_score_keywords):
        thresholds["ongoing"] = 2
    # Medical/family topics fire at 2 -- these matter most
    priority_keywords = ['doctor', 'medication', 'prescription', 'family', 'finance', 'bill', 'insurance']
    if any(kw in topic_label.lower() for kw in priority_keywords):
        thresholds["ongoing"] = 2
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


# ── WATCHER CRON HELPERS ──────────────────────────────────────────────────────

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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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


# ── GAS PRICE WATCHER ─────────────────────────────────────────────────────────

def fetch_gas_price_eia():
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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

        # v8.13: Watch acceptance handler -- fires before new watch detection
        pending = profile.get("pending_watch_offer")
        if pending:
            accept_words = ['yes', 'yeah', 'sure', 'please', 'do it', 'go ahead',
                            'absolutely', 'ok', 'okay', 'yep', 'yup', 'sounds good']
            if any(w in message.lower() for w in accept_words):
                try:
                    offer = json.loads(pending) if isinstance(pending, str) else pending
                    if offer.get("type") == "implicit_offer":
                        topic    = offer.get("topic_label", "that")
                        int_type = offer.get("interest_type", "ongoing")
                        watch_obj = {
                            "type":        int_type,
                            "description": topic,
                            "params":      {"topic": topic},
                            "offer_email": offer.get("offer_email", False),
                        }
                        profile = store_watch(profile, watch_obj)
                        profile = mark_topic_offered(profile, topic, accepted=True)
                        if offer.get("offer_email") and profile.get("email"):
                            content = generate_watch_content(watch_obj, profile)
                            threading.Thread(
                                target=send_watch_email,
                                args=(profile, watch_obj, content),
                                daemon=True
                            ).start()
                        profile["pending_watch_offer"] = None
                        save_profile_fields(user_id, {
                            "watches":             profile.get("watches", []),
                            "topic_touches":       profile.get("topic_touches", []),
                            "pending_watch_offer": None,
                        })
                        changed = True
                        print(f"[HERALD] Watch accepted: {topic}")
                        return  # Don't start a new watch on acceptance message
                except Exception as e:
                    print(f"[HERALD] Watch acceptance error (non-fatal): {e}")

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

_FREDDIE_TRIGGERS = [
    'freddie', 'how are our trades', 'trading status', 'open positions',
    'gate progress', 'win rate', 'what did freddie', 'how is freddie',
    'empire status', 'regime', 'last scan', 'any setups', 'near miss',
    'expectancy', 'p&l', 'sovereign', 'forge', 'signal', 'bankroll',
    'update freddie', 'sync empire', 'refresh data', 'refresh freddie',
]

def _is_freddie_msg(msg_lower: str) -> bool:
    return any(t in msg_lower for t in _FREDDIE_TRIGGERS)

_DAY_FRESHNESS_WORDS = [
    'last night', 'yesterday', 'this morning', 'today', 'tonight',
    'just now', 'earlier today', 'this afternoon', 'this evening',
]
_WEEK_FRESHNESS_WORDS = [
    'last week', 'this week', 'recently', 'past few days', 'past week',
]

def _get_freshness(msg_lower: str):
    if any(w in msg_lower for w in _DAY_FRESHNESS_WORDS):
        return 'pd'
    if any(w in msg_lower for w in _WEEK_FRESHNESS_WORDS):
        return 'pw'
    return None

_NEAR_ME_TERMS = [
    'near me', 'nearby', 'around here', 'around me',
    'close to me', 'close by', 'in my area', 'in my neighborhood',
]

def _localize_query(message: str, profile: dict, location_label: str = None) -> str:
    """v8.60: Shapes every Brave query -- location replacement + date injection.
    Date is appended when recency signal detected so Brave returns current results
    for any topic: sports, TV, celebrity, news, MMA, college games, anything.
    """
    location = location_label or profile.get("location", "")
    msg_lower = message.lower()
    result = message

    # Location replacement -- 'near me' -> 'near Plano TX'
    if location and any(t in msg_lower for t in _NEAR_ME_TERMS):
        for term in _NEAR_ME_TERMS:
            replacement = f"near {location}"
            idx = result.lower().find(term)
            while idx >= 0:
                result = result[:idx] + replacement + result[idx + len(term):]
                idx = result.lower().find(term, idx + len(replacement))

    # v8.60: Date injection -- append today's date for any time-sensitive query
    # Covers: sports, TV recaps, celebrity news, MMA, college games, any topic
    _DATE_SIGNALS = [
        'last night', 'yesterday', 'tonight', 'today', 'this morning',
        'this week', 'latest', 'recent', 'just happened', 'right now',
        'this season', 'recap', 'results', 'score', 'who won',
        'what happened', 'any news', 'update on', 'trending',
    ]
    if any(s in msg_lower for s in _DATE_SIGNALS):
        today = datetime.now().strftime('%B %d %Y')
        result = f"{result} {today}"

    return result

_RECENCY_WORDS = [
    'last night', 'yesterday', 'this morning', 'today', 'tonight',
    'last week', 'this week', 'just now', 'right now', 'currently',
]

# Recency alone must not trigger search ("rough day today"). Require a topic signal too.
_SEARCH_INTENT_WORDS = [
    'news', 'headline', 'headlines', 'breaking', 'happened', 'happening',
    'score', 'game', 'election', 'stock', 'crypto', 'bitcoin', 'ethereum',
    'weather', 'forecast', 'who won', 'who won', 'result', 'results', 'recap',
    'win', 'lose', 'beat', 'defeat',
    'update on', 'latest on', 'any news', 'what happened',
    'announced', 'released', 'launched', 'signed', 'traded', 'died',
    'trending', 'viral', 'passed away',
]

_EVENT_WORDS = [
    'fight', 'match', 'game', 'won', 'lost', 'win', 'lose', 'beat', 'score', 'result',
    'results', 'election', 'announced', 'released', 'launched',
    'trending', 'viral', 'died', 'passed away', 'signed', 'traded',
]

def needs_web_search(message: str) -> bool:
    msg_lower = message.lower().strip()
    if any(kw in msg_lower for kw in FAST_OVERRIDES):
        return False
    if any(kw in msg_lower for kw in LIVE_KEYWORDS):
        return True
    if any(w in msg_lower for w in _RECENCY_WORDS):
        if any(w in msg_lower for w in _SEARCH_INTENT_WORDS):
            return True
    if any(w in msg_lower for w in _EVENT_WORDS) and '?' in message:
        return True
    return False


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




# ── MEDICAL INTAKE SYSTEM (v8.13) ─────────────────────────────────────────────

MEDICAL_VISIT_SIGNALS = [
    'saw my doctor', 'visited my doctor', 'went to the doctor',
    'had an appointment', 'my appointment', 'just got back from',
    'i was at the', 'just saw', 'met with my',
    'my cardiologist', 'my dermatologist', 'my oncologist',
    'my primary', 'my gp', 'my specialist', 'my surgeon',
    'test came back', 'results came back', 'biopsy came back',
    'my diagnosis', 'they found', 'the doctor said',
    'follow up in', 'come back in', 'see me again in',
    'prescribed', 'starting a new medication', 'they put me on',
    'bone marrow', 'biopsy', 'mri', 'ct scan', 'blood work',
    'colonoscopy', 'mammogram', 'echocardiogram',
]

MEDICATION_SIGNALS = [
    'i take', 'my medication', 'my prescription', 'my pill',
    'refill', 'pharmacy', 'lisinopril', 'metformin', 'atorvastatin',
    'aspirin', 'blood pressure pill', 'cholesterol', 'thyroid',
    'stopped taking', 'switched to', 'dose was changed', 'started taking',
]

# Reduced to 3 questions -- 7 was too many for casual conversation.
# Users drift away mid-intake and nothing saves. 3 questions complete naturally.
INTAKE_QUESTIONS = {
    'visit': [
        ('doctor_name', "What's the doctor's name?"),
        ('reason',      "What was the visit for?"),
        ('outcome',     "How did it go -- anything they found or decided?"),
    ],
    'medication': [
        ('med_name', "What's the medication called?"),
        ('dose',     "Do you know the dose?"),
        ('reason',   "What's it for?"),
    ]
}



# ── BRIEFING PREFERENCE SYSTEM (v8.14) ───────────────────────────────────────

_BRIEFING_EXCLUDE = [
    "don't mention", "dont mention", "leave out", "skip the",
    "stop telling me", "remove from", "no more", "not in the morning",
    "don't include", "dont include", "take out",
]
_BRIEFING_INCLUDE = [
    "add to my morning", "include in my briefing", "tell me about in the morning",
    "add the", "start including", "i want to hear",
]
_BRIEFING_TONE = [
    "keep it short", "brief", "quick briefing", "just the essentials",
    "more detail", "more information", "tell me more in the morning",
]
_BRIEFING_TOPIC_MAP = {
    "medication": ["medication", "meds", "pills", "prescriptions"],
    "weather":    ["weather", "forecast", "temperature"],
    "calendar":   ["calendar", "appointments", "schedule"],
    "tracker":    ["reminders", "tracker", "due items"],
    "freddie":    ["freddie", "trading", "trades", "market update"],
    "sports":     ["sports", "scores", "game results", "cowboys", "mavericks"],
}
_TOPIC_LABELS = {
    "medication": "medications",   "weather": "weather",
    "calendar":   "your calendar", "tracker": "reminders",
    "freddie":    "Freddie updates", "sports": "sports scores",
}


def detect_briefing_pref_change(message: str) -> dict:
    msg = message.lower()
    result = {"action": None, "topic": None, "tone": None}
    if any(s in msg for s in _BRIEFING_EXCLUDE):
        result["action"] = "exclude"
        for topic, keys in _BRIEFING_TOPIC_MAP.items():
            if any(k in msg for k in keys):
                result["topic"] = topic
                break
    elif any(s in msg for s in _BRIEFING_INCLUDE):
        result["action"] = "include"
        for topic, keys in _BRIEFING_TOPIC_MAP.items():
            if any(k in msg for k in keys):
                result["topic"] = topic
                break
    if any(s in msg for s in _BRIEFING_TONE):
        result["tone"] = "brief" if any(
            w in msg for w in ["short", "brief", "quick", "essential"]
        ) else "detailed"
    return result


def apply_briefing_pref(profile: dict, change: dict) -> tuple:
    prefs = profile.setdefault("briefing_prefs", {
        "include_medication": True, "include_weather": True,
        "include_calendar": True,   "include_tracker": True,
        "include_freddie":  True,   "include_sports":  False,
        "tone": "normal",           "custom_topics": [],
    })
    action = change.get("action")
    topic  = change.get("topic")
    tone   = change.get("tone")
    confirm = ""
    if action == "exclude" and topic:
        prefs[f"include_{topic}"] = False
        label = _TOPIC_LABELS.get(topic, topic)
        confirm = (
            f"Got it -- I'll leave {label} out of your morning briefing. "
            f"Anything else you'd like to change?"
        )
    elif action == "include" and topic:
        prefs[f"include_{topic}"] = True
        label = _TOPIC_LABELS.get(topic, topic)
        confirm = (
            f"Done -- I'll include {label} in your morning briefing. "
            f"Anything else?"
        )
    if tone:
        prefs["tone"] = tone
        if not confirm:
            confirm = (
                "Got it -- morning briefings will be short and to the point."
                if tone == "brief"
                else "Understood -- I'll give you more detail in the mornings."
            )
    profile["briefing_prefs"] = prefs
    return profile, confirm


def detect_medical_signal(message: str):
    msg_lower = message.lower()
    if any(s in msg_lower for s in MEDICAL_VISIT_SIGNALS):
        return 'visit'
    if any(s in msg_lower for s in MEDICATION_SIGNALS):
        return 'medication'
    return None


def start_medical_intake(profile: dict, signal_type: str) -> dict:
    questions = INTAKE_QUESTIONS.get(signal_type, [])
    if not questions:
        return profile
    profile['medical_intake_state'] = {
        'type':           signal_type,
        'questions':      questions,
        'current_index':  0,
        'next_field':     questions[0][0],
        'next_question':  questions[0][1],
        'partial_record': {},
        'started_at':     datetime.now().isoformat(),
    }
    return profile


def advance_medical_intake(profile: dict, user_message: str, user_id: str) -> dict:
    state = profile.get('medical_intake_state')
    if not state:
        return profile
    current_field = state['next_field']
    partial = state.get('partial_record', {})
    partial[current_field] = user_message.strip()[:200]
    state['partial_record'] = partial
    next_idx = state['current_index'] + 1
    questions = state['questions']
    if next_idx >= len(questions):
        _write_medical_record(user_id, state['type'], partial)
        profile['medical_intake_state'] = None
        print(f"[HERALD] Medical intake complete for {user_id}")
    else:
        state['current_index'] = next_idx
        state['next_field'] = questions[next_idx][0]
        state['next_question'] = questions[next_idx][1]
        profile['medical_intake_state'] = state
    return profile


def _write_medical_record(user_id: str, record_type: str, data: dict):
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            if record_type == 'visit':
                doctor = data.get('doctor_name', '').strip()
                if doctor:
                    c.execute(
                        "INSERT INTO medical_contacts "
                        "(user_id, doctor_name, specialty, practice, address, phone, last_seen, next_visit, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(user_id, doctor_name) DO UPDATE SET "
                        "specialty=excluded.specialty, practice=excluded.practice, "
                        "last_seen=excluded.last_seen, next_visit=excluded.next_visit",
                        (user_id, doctor, data.get('specialty',''), data.get('practice',''),
                         data.get('location',''), data.get('phone',''),
                         data.get('visit_date', datetime.now().strftime('%Y-%m-%d')),
                         data.get('follow_up',''), datetime.now().isoformat())
                    )
                c.execute(
                    "INSERT INTO medical_records "
                    "(user_id, doctor_name, specialty, practice, location, visit_date, reason, "
                    "outcome, follow_up_date, follow_up_notes, tests_ordered, results, source, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conversation', ?)",
                    (user_id, data.get('doctor_name',''), data.get('specialty',''),
                     data.get('practice',''), data.get('location',''),
                     data.get('visit_date', datetime.now().strftime('%Y-%m-%d')),
                     data.get('reason',''), data.get('outcome',''),
                     data.get('follow_up',''), data.get('follow_up_notes',''),
                     data.get('tests_ordered',''), data.get('results',''),
                     datetime.now().isoformat())
                )
                if data.get('follow_up',''):
                    _create_followup_tracker(user_id, data, c)
            elif record_type == 'medication':
                c.execute(
                    "INSERT INTO medication_log "
                    "(user_id, med_name, dose, prescriber, reason, refill_due, active, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                    (user_id, data.get('med_name',''), data.get('dose',''),
                     data.get('prescriber',''), data.get('reason',''),
                     data.get('refill_due',''), datetime.now().isoformat())
                )
        print(f"[HERALD] Medical record written: {record_type} for {user_id}")
    except Exception as e:
        print(f"[HERALD] Medical record write error: {e}")


def _create_followup_tracker(user_id: str, data: dict, cursor):
    doctor = data.get('doctor_name', 'Doctor')
    follow_up = data.get('follow_up', '')
    today = datetime.now()
    next_date = None
    interval = 0
    fu = follow_up.lower()
    if '3 month' in fu or '90 day' in fu:
        next_date = (today + timedelta(days=90)).strftime('%Y-%m-%d'); interval = 90
    elif '6 month' in fu:
        next_date = (today + timedelta(days=180)).strftime('%Y-%m-%d'); interval = 180
    elif 'year' in fu or 'annual' in fu:
        next_date = (today + timedelta(days=365)).strftime('%Y-%m-%d'); interval = 365
    elif '2 week' in fu or 'two week' in fu:
        next_date = (today + timedelta(days=14)).strftime('%Y-%m-%d'); interval = 14
    elif 'month' in fu:
        next_date = (today + timedelta(days=30)).strftime('%Y-%m-%d'); interval = 30
    if next_date:
        try:
            cursor.execute(
                "INSERT INTO life_tracker "
                "(user_id, category, item_name, last_date, next_due_date, interval_days, source, active, created_at) "
                "VALUES (?, 'medical', ?, ?, ?, ?, 'medical_intake', 1, ?)",
                (user_id, f"Follow-up with {doctor}", today.strftime('%Y-%m-%d'),
                 next_date, interval, datetime.now().isoformat())
            )
        except Exception as e:
            print(f"[HERALD] Follow-up tracker error (non-fatal): {e}")


def _build_medical_context(user_id: str, conn=None) -> str:
    owns_conn = conn is None
    try:
        if owns_conn:
            conn = _db_conn()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT doctor_name, specialty, visit_date, outcome, follow_up_date "
            "FROM medical_records WHERE user_id=? AND active=1 ORDER BY visit_date DESC LIMIT 5",
            (user_id,)
        )
        visits = cursor.fetchall()
        cursor.execute(
            "SELECT med_name, dose, reason FROM medication_log "
            "WHERE user_id=? AND active=1 AND end_date IS NULL",
            (user_id,)
        )
        meds = cursor.fetchall()
        lines = []
        if visits:
            parts = []
            for doc, spec, dt, outcome, fu in visits:
                part = doc
                if spec: part += f" ({spec})"
                if dt: part += f" on {dt}"
                if outcome: part += f" -- {outcome}"
                if fu: part += f", follow-up {fu}"
                parts.append(part)
            lines.append("Recent medical: " + "; ".join(parts))
        if meds:
            med_str = ", ".join([
                f"{m[0]}{' ' + m[1] if m[1] else ''}{' for ' + m[2] if m[2] else ''}"
                for m in meds
            ])
            lines.append("Medications: " + med_str)
        return "\n".join(lines) if lines else ""
    except Exception:
        return ""
    finally:
        if owns_conn and conn:
            conn.close()


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
        result = call_openrouter(messages, use_search=False, model=HAIKU_MODEL, timeout=8)
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


def update_personality_profile(user_id: str, message: str):
    """
    v8.54: Extract communication style signals from one user message.
    Accumulates into profile["personality_profile"] over time.
    humor_weight increments on dark/dry signal. Never decrements -- earned not lost.
    Safe to call in background thread -- non-fatal on any error.
    """
    try:
        if not _check_extraction_budget(user_id):
            return
        prompt = PERSONALITY_EXTRACTION_PROMPT.format(message=message[:300])
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
        extracted = json.loads(raw)

        profile = get_profile(user_id)
        pp = profile.get("personality_profile", {
            "comm_style": "neutral",
            "humor_weight": 0.0,
            "humor_type": "none",
            "register": "assistant",
            "earned_phrases": [],
            "avg_word_count": 10,
            "samples": 0,
            "last_updated": ""
        })

        # Update sample count and rolling average word count
        samples = pp.get("samples", 0) + 1
        prev_avg = pp.get("avg_word_count", 10)
        new_wc = extracted.get("word_count", 10)
        pp["avg_word_count"] = round((prev_avg * (samples - 1) + new_wc) / samples, 1)
        pp["samples"] = samples

        # Communication style -- majority vote via simple last-N wins
        new_style = extracted.get("comm_style", "neutral")
        if new_style in ("direct", "verbose", "casual", "formal"):
            pp["comm_style"] = new_style

        # Humor weight -- increments on signal, never decrements
        humor_signal = extracted.get("humor_signal", "none")
        if humor_signal in ("dark", "dry"):
            pp["humor_weight"] = min(1.0, round(pp.get("humor_weight", 0.0) + 0.05, 2))
            pp["humor_type"] = humor_signal
        elif humor_signal == "warm":
            pp["humor_type"] = "warm"

        # Register -- inferred from style + avg word count
        if pp["comm_style"] == "direct" and pp["avg_word_count"] < 8:
            pp["register"] = "peer"
        elif pp["comm_style"] == "formal":
            pp["register"] = "friendly-formal"
        else:
            pp["register"] = "conversational"

        # Earned phrases -- deduplicated, max 10 stored
        new_phrases = extracted.get("earned_phrases", [])
        existing = pp.get("earned_phrases", [])
        for phrase in new_phrases:
            phrase = phrase.strip()
            if phrase and phrase.lower() not in [p.lower() for p in existing]:
                existing.append(phrase)
        pp["earned_phrases"] = existing[-10:]

        pp["last_updated"] = datetime.now().isoformat()
        profile["personality_profile"] = pp
        save_profile_async(user_id, profile)
        print(f"[PERSONALITY] {user_id}: style={pp['comm_style']} humor={pp['humor_weight']} register={pp['register']} samples={samples}")

    except Exception as e:
        print(f"[PERSONALITY] update_personality_profile (non-fatal): {e}")


def build_personality_block(profile: dict) -> str:
    """
    v8.54: Build the personality injection for build_system().
    Returns empty string if fewer than 10 samples -- too early to calibrate.
    Never crashes -- safe to call even if personality_profile key is missing.
    """
    try:
        pp = profile.get("personality_profile", {})
        samples = pp.get("samples", 0)
        if samples < 10:
            return ""

        style = pp.get("comm_style", "neutral")
        humor_weight = pp.get("humor_weight", 0.0)
        humor_type = pp.get("humor_type", "none")
        register = pp.get("register", "conversational")
        phrases = pp.get("earned_phrases", [])
        avg_wc = pp.get("avg_word_count", 10)

        lines = ["COMMUNICATION STYLE (calibrated from this user over time):"]

        # Style line
        if style == "direct" and avg_wc < 8:
            lines.append("- Direct. Short answers. Gets to the point fast.")
        elif style == "verbose":
            lines.append("- Appreciates context and detail. Don't truncate.")
        elif style == "casual":
            lines.append("- Casual register. Loose grammar fine. Match their energy.")
        elif style == "formal":
            lines.append("- Prefers structured, precise responses.")
        else:
            lines.append("- Still calibrating style -- neutral for now.")

        # Register line
        if register == "peer":
            lines.append("- Register: peer. Skip assistant softening. Talk like a colleague.")
        elif register == "friendly-formal":
            lines.append("- Register: trusted advisor. Warm but precise.")
        else:
            lines.append("- Register: conversational friend.")

        # Humor line
        if humor_weight >= 0.6 and humor_type == "dark":
            lines.append("- Humor: dark and dry -- fully earned. Brief, not forced.")
        elif humor_weight >= 0.4 and humor_type in ("dark", "dry"):
            lines.append("- Humor: dry -- emerging. Occasional understatement fine.")
        elif humor_weight >= 0.2 and humor_type == "warm":
            lines.append("- Humor: warm and light. Keep it clean.")
        else:
            lines.append("- Humor: neutral -- not yet calibrated. Don't initiate.")

        # Earned phrases
        if phrases:
            phrase_str = ", ".join(f'"{p}"' for p in phrases[:5])
            lines.append(f"- Phrases this user actually uses: {phrase_str}. Echo occasionally -- never force it.")

        return "\n".join(lines)

    except Exception:
        return ""


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


# ── BUILD ABOUT ME ────────────────────────────────────────────────────────────

def build_about_me(profile):
    name          = profile.get("name", "")
    ai_name       = profile.get("ai_name", "Herald")
    location      = profile.get("location", "")
    notes         = profile.get("notes", [])
    memories      = profile.get("memories", [])
    learned_facts = profile.get("learned_facts", [])
    query_counts  = profile.get("query_counts", {})
    created       = profile.get("created_at", "")
    user_id       = profile.get("user_id", "")

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

    moments_str = ""
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("""
            SELECT summary, days_ago FROM life_moments
            WHERE user_id = ? AND active = 1
            ORDER BY weight DESC, created_at DESC LIMIT 6
        """, (user_id,))
        rows = c.fetchall()
        conn.close()
        if rows:
            parts = []
            for summary, days_ago in rows:
                if days_ago == 0: age = "today"
                elif days_ago == 1: age = "yesterday"
                elif days_ago < 7: age = f"{days_ago} days ago"
                elif days_ago < 30: age = f"{days_ago // 7} weeks ago"
                else: age = f"{days_ago // 30} months ago"
                parts.append(f"{summary} ({age})")
            moments_str = "; ".join(parts)
    except Exception:
        pass

    tracker_str = ""
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("""
            SELECT item_name, next_due_date FROM life_tracker
            WHERE user_id = ? AND active = 1
            ORDER BY next_due_date ASC LIMIT 5
        """, (user_id,))
        trows = c.fetchall()
        conn.close()
        if trows:
            tracker_str = "; ".join([f"{n} (due {nxt})" for n, nxt in trows])
    except Exception:
        pass

    profile_context = (
        f"Name: {name or 'not yet known'}\n"
        f"Location: {location or 'not yet known'}\n"
        f"Days we have known each other: {days_known}\n"
        f"Things they have told me: {'; '.join(all_notes) if all_notes else 'none yet'}\n"
        f"Facts learned from conversation: {facts_str}\n"
        f"Most asked about: {', '.join(top_cats) if top_cats else 'not yet known'}\n"
        f"Life moments shared: {moments_str if moments_str else 'none captured yet'}\n"
        f"Life tracker items: {tracker_str if tracker_str else 'none tracked yet'}"
    )

    prompt = [
        {"role": "system", "content": (
            f"You are {ai_name}, a warm personal AI companion. "
            "The user asked what you know about them. "
            "Write a natural, conversational 2 to 4 sentence response from memory. "
            "No bullet points, no lists, no markdown, no asterisks. "
            "Speak like a trusted friend who genuinely remembers things about this person. "
            "IMPORTANT: Never say 'I remember' or 'I recall' or 'Based on what I know'. "
            "Just know things naturally, the way a friend does. "
            "Format all numbers in words for text-to-speech. "
            f"{'Use their name once naturally.' if name else ''} "
            "If you know very little yet, say so warmly and invite them to share more."
        )},
        {"role": "user", "content": f"Profile:\n{profile_context}\n\nWhat do you know about me?"}
    ]

    try:
        result = call_openrouter(prompt, use_search=False, model=HAIKU_MODEL, timeout=8)
        if result and len(result) > 20:
            return result
    except Exception as e:
        print(f"[HERALD] build_about_me LLM failed, using fast fallback: {e}")

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
    if profile.get("is_owner"):
        return {"status": "paid", "days_remaining": 999, "show_wall": False}
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
    global _empire_live_cache
    now = time.time()
    if _empire_live_cache["data"] and (now - _empire_live_cache["ts"]) < 60:
        return _empire_live_cache["data"]
    try:
        url = "http://143.198.18.66:8080/api/status"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/8.8"})
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
        result = f"""FREDDIE EMPIRE -- LIVE INTELLIGENCE:

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
        _empire_live_cache = {"data": result, "ts": time.time()}
        return result
    except Exception as e:
        empire = fetch_empire()
        if empire:
            fallback = build_empire_context(empire) + "\n[Live feed unavailable -- using hourly snapshot]"
        else:
            fallback = f"\nFreddie status unavailable right now ({e}). Try again in a moment.\n"
        _empire_live_cache = {"data": fallback, "ts": time.time() - 45}
        return fallback


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

def fetch_google_places(lat: float, lng: float, keyword: str) -> list:
    """
    Call Google Places Nearby Search API.
    Returns top 3 results as dicts with name, rating,
    vicinity, open_now, place_id.
    """
    if not GEOCODING_KEY or not lat or not lng:
        return []
    try:
        url = (
            f"https://maps.googleapis.com/maps/api/place/nearbysearch/json"
            f"?location={lat},{lng}&radius=5000"
            f"&keyword={urllib.parse.quote(keyword)}"
            f"&key={GEOCODING_KEY}"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Herald/8.22"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        results = data.get("results", [])[:3]
        places = []
        for r in results:
            places.append({
                "name": r.get("name", ""),
                "rating": r.get("rating", 0),
                "vicinity": r.get("vicinity", ""),
                "open_now": r.get("opening_hours", {}).get("open_now"),
                "place_id": r.get("place_id", ""),
            })
        return places
    except Exception as e:
        print(f"[HERALD] Places API error: {e}")
        return []


def geocode_reverse(lat, lng):
    if not GEOCODING_KEY:
        return None
    city_type_priority = (
        "locality",
        "postal_town",
        "sublocality_level_1",
        "administrative_area_level_2",
    )
    try:
        url = (f"https://maps.googleapis.com/maps/api/geocode/json"
               f"?latlng={lat},{lng}&result_type=locality|administrative_area_level_1"
               f"&key={GEOCODING_KEY}")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/8.8"})
        with urllib.request.urlopen(req, timeout=4) as r:
            data = json.loads(r.read().decode())
        results = data.get("results") or []
        if not results:
            return None

        found_locality_type = False
        city_only = None
        for result in results:
            components = result.get("address_components") or []
            city = None
            for city_type in city_type_priority:
                for component in components:
                    if city_type in component.get("types", []):
                        city = component["long_name"]
                        found_locality_type = True
                        break
                if city:
                    break
            if city and city_only is None:
                city_only = city
            state = next(
                (c["short_name"] for c in components if "administrative_area_level_1" in c.get("types", [])),
                None,
            )
            if city and state:
                return f"{city}, {state}"

        if city_only:
            return city_only
        if not found_locality_type:
            return results[0].get("formatted_address")
    except Exception as e:
        print(f"[HERALD] Geocode failed: {e}")
    return None


# ── BRAVE SEARCH ──────────────────────────────────────────────────────────────

def fetch_brave_search(query, count=3, freshness=None):
    if not BRAVE_KEY:
        return None
    cache_key = f"brave:{query[:60].lower()}"
    cached = cache_get(cache_key, 'brave_search')
    if cached:
        return cached
    try:
        encoded = urllib.parse.quote(query)
        url = (f"https://api.search.brave.com/res/v1/web/search"
               f"?q={encoded}&count={count}&search_lang=en&country=us&text_decorations=false")
        if freshness:
            url += f"&freshness={freshness}"
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "X-Subscription-Token": BRAVE_KEY,
            "User-Agent": "HeraldAI/8.8"
        })
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        results = data.get("web", {}).get("results", [])
        if not results:
            return None
        snippets = []
        for result in results[:3]:
            title = result.get("title", "")
            desc  = result.get("description", "")
            if desc:
                trimmed = desc[:100].strip()
                snippets.append(f"{title}: {trimmed}")
        result_str = "\n".join(snippets) if snippets else None
        if result_str:
            cache_set(cache_key, result_str, 'brave_search')
        return result_str
    except Exception as e:
        print(f"[HERALD] Brave search failed: {e}")
        return None


# ── DIRECT API FUNCTIONS ──────────────────────────────────────────────────────

def extract_weather_location(message, profile_location):
    msg = message.lower()
    # Only extract location after "in" or "at"
    # Never "for" -- causes "forecast for the afternoon" → France bug
    for kw in [" in ", " at "]:
        if kw in msg:
            idx = msg.index(kw) + len(kw)
            loc = message[idx:].strip().rstrip("?.,!")
            TIME_WORDS = {"the", "a", "an", "this", "that", "today", "tomorrow",
                          "morning", "afternoon", "evening", "night", "week",
                          "weekend", "hour", "minute", "second", "moment"}
            first_word = loc.split()[0].lower() if loc else ""
            if loc and len(loc) > 2 and first_word not in TIME_WORDS:
                return loc
    return profile_location or None
def fetch_weather_direct(location):
        try:
            clean_loc = location.strip().replace(' ', '+')
            url = f"https://wttr.in/{clean_loc}?format=j1"
            req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
            # NFL
            'cowboys':     ('football',   'nfl'),
            'patriots':    ('football',   'nfl'),
            'chiefs':      ('football',   'nfl'),
            'eagles':      ('football',   'nfl'),
            '49ers':       ('football',   'nfl'),
            'niners':      ('football',   'nfl'),
            'giants':      ('football',   'nfl'),
            'jets':        ('football',   'nfl'),
            'packers':     ('football',   'nfl'),
            'bears':       ('football',   'nfl'),
            'vikings':     ('football',   'nfl'),
            'lions':       ('football',   'nfl'),
            'falcons':     ('football',   'nfl'),
            'saints':      ('football',   'nfl'),
            'buccaneers':  ('football',   'nfl'),
            'texans':      ('football',   'nfl'),
            'titans':      ('football',   'nfl'),
            'jaguars':     ('football',   'nfl'),
            'colts':       ('football',   'nfl'),
            'broncos':     ('football',   'nfl'),
            'raiders':     ('football',   'nfl'),
            'chargers':    ('football',   'nfl'),
            'seahawks':    ('football',   'nfl'),
            'ravens':      ('football',   'nfl'),
            'steelers':    ('football',   'nfl'),
            'browns':      ('football',   'nfl'),
            'bengals':     ('football',   'nfl'),
            'bills':       ('football',   'nfl'),
            'dolphins':    ('football',   'nfl'),
            'nfl':         ('football',   'nfl'),
            # NBA
            'spurs':       ('basketball', 'nba'),
            'mavs':        ('basketball', 'nba'),
            'mavericks':   ('basketball', 'nba'),
            'rockets':     ('basketball', 'nba'),
            'lakers':      ('basketball', 'nba'),
            'celtics':     ('basketball', 'nba'),
            'warriors':    ('basketball', 'nba'),
            'heat':        ('basketball', 'nba'),
            'bulls':       ('basketball', 'nba'),
            'knicks':      ('basketball', 'nba'),
            'nets':        ('basketball', 'nba'),
            'sixers':      ('basketball', 'nba'),
            'bucks':       ('basketball', 'nba'),
            'nuggets':     ('basketball', 'nba'),
            'suns':        ('basketball', 'nba'),
            'clippers':    ('basketball', 'nba'),
            'pelicans':    ('basketball', 'nba'),
            'grizzlies':   ('basketball', 'nba'),
            'jazz':        ('basketball', 'nba'),
            'thunder':     ('basketball', 'nba'),
            'blazers':     ('basketball', 'nba'),
            'kings':       ('basketball', 'nba'),
            'timberwolves':('basketball', 'nba'),
            'hawks':       ('basketball', 'nba'),
            'hornets':     ('basketball', 'nba'),
            'magic':       ('basketball', 'nba'),
            'raptors':     ('basketball', 'nba'),
            'pistons':     ('basketball', 'nba'),
            'cavaliers':   ('basketball', 'nba'),
            'cavs':        ('basketball', 'nba'),
            'pacers':      ('basketball', 'nba'),
            'nba':         ('basketball', 'nba'),
            # MLB
            'rangers':     ('baseball',   'mlb'),
            'astros':      ('baseball',   'mlb'),
            'yankees':     ('baseball',   'mlb'),
            'dodgers':     ('baseball',   'mlb'),
            'cubs':        ('baseball',   'mlb'),
            'braves':      ('baseball',   'mlb'),
            'mets':        ('baseball',   'mlb'),
            'phillies':    ('baseball',   'mlb'),
            'padres':      ('baseball',   'mlb'),
            'mariners':    ('baseball',   'mlb'),
            'mlb':         ('baseball',   'mlb'),
            # NHL
            'stars':       ('hockey',     'nhl'),
            'penguins':    ('hockey',     'nhl'),
            'bruins':      ('hockey',     'nhl'),
            'blackhawks':  ('hockey',     'nhl'),
            'oilers':      ('hockey',     'nhl'),
            'flames':      ('hockey',     'nhl'),
            'canucks':     ('hockey',     'nhl'),
            'lightning':   ('hockey',     'nhl'),
            'capitals':    ('hockey',     'nhl'),
            'flyers':      ('hockey',     'nhl'),
            'nhl':         ('hockey',     'nhl'),
        }
        # Default to NBA if query has NBA/basketball signal, else NFL
        if any(w in msg_lower for w in ['nba', 'basketball']):
            sport, league = 'basketball', 'nba'
        else:
            sport, league = 'football', 'nfl'
        for key, val in sport_map.items():
            if key in msg_lower:
                sport, league = val
                break
        # Detect last-night intent -- use yesterday's date
        last_night_signals = ['last night', 'yesterday', 'last game', 'previous game']
        use_yesterday = any(s in msg_lower for s in last_night_signals)
        if use_yesterday:
            from datetime import datetime, timedelta
            yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y%m%d')
            url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates={yesterday}"
        else:
            url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard"
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.9"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode())
        events = data.get("events", [])
        if not events:
            period = "last night" if use_yesterday else "right now"
            return f"No {league.upper()} games {period}."
        lines = []
        for e in events[:5]:
            comps       = e.get("competitions", [{}])[0]
            competitors = comps.get("competitors", [])
            if len(competitors) >= 2:
                t1 = competitors[0]; t2 = competitors[1]
                n1 = t1["team"]["shortDisplayName"]; n2 = t2["team"]["shortDisplayName"]
                s1 = t1.get("score", "0");           s2 = t2.get("score", "0")
                status = e.get("status", {}).get("type", {}).get("description", "")
                # Skip scheduled 0-0 games when asking for last night
                if use_yesterday and status.lower() == "scheduled":
                    continue
                lines.append(f"{n1} {s1}, {n2} {s2}, {status}")
        if lines:
            period = "last night" if use_yesterday else "latest"
            return f"Here are the {period} {league.upper()} scores: " + ". ".join(lines) + "."
        if use_yesterday:
            return f"Couldn't find completed {league.upper()} scores from last night."
        return f"No {league.upper()} scores available right now."
    except Exception as e:
        print(f"[HERALD] ESPN API failed: {e}")
        return None

def fetch_crypto_direct():
    try:
        url = ("https://api.coingecko.com/api/v3/simple/price"
               "?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read().decode())
        if d.get("Response") == "False":
            url2 = f"https://www.omdbapi.com/?s={encoded}&apikey={OMDB_KEY}"
            req2 = urllib.request.Request(url2, headers={"User-Agent": "HeraldAI/8.8"})
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
    FINANCIAL_INTENT = [
        'price', 'trading', 'trade', 'market', 'per ounce', 'per barrel',
        'futures', 'commodity', 'trading at', 'how much is',
    ]
    if not any(w in msg_lower for w in FINANCIAL_INTENT):
        return None
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

def fetch_market_indices():
    indices = [
        ('^GSPC', 'the S and P five hundred'),
        ('^DJI',  'the Dow Jones'),
        ('^IXIC', 'NASDAQ'),
    ]
    results = []
    for symbol, spoken_name in indices:
        try:
            url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
                   f"?interval=1d&range=1d")
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            })
            with urllib.request.urlopen(req, timeout=4) as r:
                data = json.loads(r.read().decode())
            meta   = data['chart']['result'][0]['meta']
            price  = meta.get('regularMarketPrice', 0)
            prev   = meta.get('previousClose') or meta.get('chartPreviousClose', 0)
            change = price - prev if prev else 0
            pct    = (change / prev * 100) if prev else 0
            direc  = "up" if change >= 0 else "down"
            results.append(
                f"{spoken_name} is at {int(price):,} points, "
                f"{direc} {abs(pct):.1f} percent"
            )
        except Exception as e:
            print(f"[HERALD] fetch_market_indices {symbol} failed: {e}")
    if not results:
        return None
    return "Here is how the markets look right now. " + ". ".join(results) + "."


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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/8.8"})
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


# ── DYNAMIC MEMORY WEIGHTING (v8.13) ─────────────────────────────────────────
# Medical always beats food. Cancer diagnosis from 6 months ago
# outscores restaurant preference from yesterday. Always.

CATEGORY_PRIORITY = {
    'medical':      10,
    'medication':    9,
    'family':        8,
    'financial':     7,
    'legal':         7,
    'work':          6,
    'routine':       5,
    'travel':        4,
    'food':          3,
    'sports':        3,
    'general':       2,
}

EMOTION_WEIGHT = {
    'critical':   5,
    'serious':    4,
    'important':  3,
    'neutral':    2,
    'positive':   2,
    'negative':   3,
}


def calculate_moment_weight(category: str, emotion: str,
                             days_ago: int, times_referenced: int = 0) -> float:
    base      = CATEGORY_PRIORITY.get(category, 2)
    emotion_w = EMOTION_WEIGHT.get(emotion, 2)
    recency   = max(0.2, math.exp(-days_ago / 90))   # halves every 90 days, never zero
    ref_boost = 1 + (times_referenced * 0.25)         # each mention boosts it
    return round(base * emotion_w * recency * ref_boost, 2)


_CALENDAR_CACHE_TTL = 300  # 5 minutes
_calendar_cache = {}  # user_id -> (timestamp, result)
_system_prompt_cache: dict = {}  # user_id -> (timestamp, prompt)
_SYSTEM_PROMPT_TTL = 180  # 3 minutes


def _get_calendar_line(user_id: str, conn=None) -> str:
    """Return formatted upcoming calendar line, cached per user for 5 minutes."""
    if not user_id:
        return ""
    cached = _calendar_cache.get(user_id)
    if cached:
        ts, result = cached
        if time.time() - ts < _CALENDAR_CACHE_TTL:
            return result
    calendar_line = ""
    owns_conn = conn is None
    try:
        if owns_conn:
            conn = _db_conn()
        c = conn.cursor()
        c.execute("""
            SELECT item_name, COALESCE(next_due_date, last_date) AS event_date
            FROM life_tracker
            WHERE user_id = ? AND active = 1 AND source = 'calendar'
              AND date(COALESCE(next_due_date, last_date)) >= date('now')
              AND date(COALESCE(next_due_date, last_date)) <= date('now', '+30 days')
            ORDER BY event_date ASC
            LIMIT 12
        """, (user_id,))
        cal_rows = c.fetchall()
        if owns_conn and conn:
            conn.close()
        if cal_rows:
            today = date.today()
            cal_items = []
            for name_item, event_date_str in cal_rows:
                try:
                    ed = date.fromisoformat(event_date_str)
                    if ed == today:
                        when = "today"
                    elif ed == today + timedelta(days=1):
                        when = "tomorrow"
                    else:
                        when = ed.strftime("%A %b %d")
                    cal_items.append(f"{name_item} ({when})")
                except Exception:
                    cal_items.append(name_item)
            calendar_line = (
                "Upcoming calendar from device: "
                + "; ".join(cal_items)
                + ". Answer schedule questions from this list -- do not guess."
            )
    except Exception:
        pass
    _calendar_cache[user_id] = (time.time(), calendar_line)
    return calendar_line


_TRUST_PHRASES = (
    "i feel", "i'm worried", "i'm scared", "i think", "what should i",
    "honest opinion", "struggling", "my wife", "my husband", "my kid",
    "my mom", "my dad", "my doctor",
)
_TRUST_THRESHOLDS = {0: 20, 1: 60, 2: 150}


def increment_trust_level(user_id, message):
    if not user_id:
        return
    msg = (message or "").strip()
    if not msg:
        return

    profile = get_profile(user_id)
    try:
        trust_level = int(profile.get("trust_level", 0))
    except (TypeError, ValueError):
        trust_level = 0
    trust_level = max(0, min(3, trust_level))
    if trust_level >= 3:
        return

    try:
        signals = int(profile.get("_trust_signals", 0))
    except (TypeError, ValueError):
        signals = 0

    lower = msg.lower()
    words = len(msg.split())

    delta = 0
    if words > 30:
        delta += 2
    if any(p in lower for p in _TRUST_PHRASES):
        delta += 3
    if words > 10:
        delta += 1
    if delta == 0:
        return

    old_level = trust_level
    signals += delta
    profile["_trust_signals"] = signals

    if signals >= _TRUST_THRESHOLDS.get(trust_level, 999):
        trust_level += 1
        profile["trust_level"] = trust_level
        profile["_trust_signals"] = 0

    save_profile(user_id, profile)
    if trust_level != old_level:
        print(f"[HERALD] trust_level {user_id}: {old_level} -> {trust_level}")


def build_system(profile, local_time=None, owner=False, empire=None, lat=None, lng=None, location_label=None, local_date=None, device_context=None):
    now      = local_time or datetime.now().strftime("%A, %B %d %Y %I:%M %p")
    name     = profile.get("name", "")
    ai_name  = profile.get("ai_name", "Herald")
    trust_level = profile.get('trust_level', 0)
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
        loc_line = "Location not yet learned -- ask naturally when relevant. NEVER say you do not have GPS access or cannot see location. You simply do not know it yet."

    date_line = f"Today is {local_date}." if local_date else ""

    all_memory = list(dict.fromkeys((memories + notes)[-12:]))
    notes_line = ("What this user has told you (remember and use naturally): "
                  + "; ".join(all_memory)) if all_memory else ""

    auto_open = profile.get("auto_open_apps", False)
    auto_open_line = "User preference: open apps directly without asking -- no action cards." if auto_open else ""

    prefs_summary = build_preferences_summary(profile)
    prefs_line = f"Preferences learned over time:\n{prefs_summary}" if prefs_summary else ""

    learned_facts = profile.get("learned_facts", [])
    facts_line = ""
    if learned_facts:
        recent    = learned_facts[-20:]
        facts_str = "; ".join([f"{f['value']} ({f['category']})" for f in recent])
        facts_line = f"Facts learned from conversation: {facts_str}"

    watcher_context = _build_watcher_context(profile)

    user_id = profile.get("user_id", "")
    life_tracker_line = ""
    episodic_line = ""
    medical_context = ""
    calendar_line = ""
    conn = None
    try:
        conn = _db_conn()
        calendar_line = _get_calendar_line(user_id, conn)
        c = conn.cursor()

        c.execute("""
            SELECT category, item_name, last_date, next_due_date, interval_days
            FROM life_tracker
            WHERE user_id = ? AND active = 1 AND source != 'calendar'
            ORDER BY next_due_date ASC
            LIMIT 8
        """, (user_id,))
        tracker_rows = c.fetchall()
        if tracker_rows:
            today = date.today()
            due_items = []
            for cat, name_item, last, nxt, interval in tracker_rows:
                try:
                    due = date.fromisoformat(nxt)
                    days_until = (due - today).days
                    if days_until <= 14:
                        if days_until < 0:
                            due_items.append(f"{name_item} is overdue by {abs(days_until)} days")
                        elif days_until == 0:
                            due_items.append(f"{name_item} is due today")
                        else:
                            due_items.append(f"{name_item} is due in {days_until} days")
                    elif days_until <= 30:
                        due_items.append(f"{name_item} coming up in {days_until} days")
                except Exception:
                    pass
            if due_items:
                life_tracker_line = "Life tracker reminders due soon: " + "; ".join(due_items) + ". Mention these naturally if relevant to the conversation."

        c.execute("""
            SELECT summary, category, emotion, days_ago,
                   COALESCE(times_referenced, 0) as refs
            FROM life_moments
            WHERE user_id = ? AND active = 1
        """, (user_id,))
        all_rows = c.fetchall()
        if all_rows:
            scored = []
            for row in all_rows:
                summary, cat, emotion, days_ago, refs = row
                score = calculate_moment_weight(cat, emotion or 'neutral', days_ago or 0, refs)
                scored.append((score, summary, cat, emotion, days_ago))
            scored.sort(reverse=True)
            moment_rows = [(r[1], r[2], r[3], r[4]) for r in scored[:8]]
            if moment_rows:
                moment_lines = []
                for summary, cat, emotion, days_ago in moment_rows:
                    if days_ago == 0:
                        age = "today"
                    elif days_ago == 1:
                        age = "yesterday"
                    elif days_ago < 7:
                        age = f"{days_ago} days ago"
                    elif days_ago < 30:
                        age = f"{days_ago // 7} week{'s' if days_ago >= 14 else ''} ago"
                    else:
                        age = f"{days_ago // 30} month{'s' if days_ago >= 60 else ''} ago"
                    moment_lines.append(f"{summary} ({age})")
                episodic_line = "Life moments this user has shared: " + "; ".join(moment_lines) + ". Reference these naturally like a friend who remembers -- never robotically."

        medical_context = _build_medical_context(user_id, conn)
    except Exception:
        pass
    finally:
        if conn:
            conn.close()

    context_parts = [p for p in [medical_context, calendar_line, notes_line, auto_open_line, prefs_line, facts_line, life_tracker_line, episodic_line] if p]
    personality_block = build_personality_block(profile)
    context_block = "\n".join(context_parts) if context_parts else "Still learning about this user."
    device_line = f"\nDevice memory: {device_context}" if device_context else ""
    empire_section = f"\n\n{empire}" if owner and empire else ""
    watcher_section = f"\n\n{watcher_context}" if watcher_context else ""

    # v8.13: Briefing confirm injection (fires once when pref changes)
    briefing_confirm_section = ""
    _bc = profile.get("_briefing_confirm", "")
    if _bc:
        briefing_confirm_section = (
            f"\n\nBRIEFING PREFERENCE UPDATED: {_bc} "
            f"Acknowledge this naturally and warmly at the END of your response. "
            f"One sentence. Then ask if they'd like to change anything else."
        )
        # Clear it so it only fires once
        profile["_briefing_confirm"] = ""

    return f"""You are {ai_name} -- a trusted personal AI companion.

{user_line}
{loc_line}
{date_line}
{device_line}{context_block}

Current time: {now}{empire_section}{watcher_section}

YOUR IDENTITY:
You are the smartest, most well-read friend this person has ever had. You know about
health, money, food, travel, sports, news, weather, cooking, parenting, cars,
relationships -- everything. When someone asks you something, you answer it. Directly.
Confidently. Like a trusted friend who happens to know everything.

YOUR VOICE:
- Start neutral. Match the user's energy over time -- their vocabulary, their sentence
  length, their formality. If they talk loose and casual, you get there eventually.
  If they are precise and formal, you stay there. You calibrate. You do not perform.
- Humor: dry, occasional, never forced. Play along when the user is clearly joking.
  Never initiate humor on serious topics. Never punch at real tragedy for a laugh.
  Humor deepens as trust deepens. Earn the laugh -- never chase it.
{personality_block}
- When someone shares something worrying -- health, a relationship, money -- ask one
  follow-up question first. Stay calm. Show you are paying attention.
  Never jump to advice before you understand the situation.
- When you disagree or think the user is making a mistake, say so -- once, warmly:
  "Based on what I know, I'd handle it this way -- what do you think?"
  Plant the seed. Respect their call. Never lecture. Never repeat it.
- Never make the user feel stupid. Make them feel known.
- VOICE OUTPUT RULE: This response will be spoken aloud. When your answer contains
  a list (addresses, options, search results, steps), never read it verbatim.
  Summarize naturally: "I found three burger places near you -- want me to go through them?"
  or "There are a few options -- the closest one is [first result], want to hear the rest?"
  Full lists are for reading, not listening. Always compress for spoken delivery.

TRUST LEVEL (read from profile -- trust_level: {trust_level}):
Level 0 -- New: Neutral tone. Answer questions cleanly. Warm but not familiar.
  No unsolicited commentary. Still calibrating to this person.
Level 1 -- Familiar: Mirror their energy and vocabulary more closely.
  Soft callbacks allowed: "I think we touched on this Tuesday --" then answer.
  Occasional dry humor when user clearly sets the tone first.
Level 2 -- Trusted: Notice mood shifts. If user is unusually terse, acknowledge once:
  "You good?" Push back more freely when you disagree.
  Match their humor register more closely -- follow their lead.
Level 3 -- Deep: Full voice. Full honesty.
  "You asked me that last week." Said warmly, said once, then answer.
  Real pushback when it matters: "I think that's a mistake. Here's why."
  Humor is earned and specific to this person now.

CRISIS PROTOCOL -- absolute, overrides all other rules:
If user expresses grief, loss, or emotional pain: be present. Listen.
  Ask about good memories. Sit with them. Do not rush to fix. Do not deflect.
If user expresses they do not want to be here or shows signs of active crisis:
  Step 1: Acknowledge warmly. Stay calm. Do not panic or lecture.
  Step 2: "I'm here and I'm not going anywhere."
  Step 3: "What you're carrying right now is bigger than what I should hold alone
           with you. Can we find someone to talk to together?"
  Step 4: Surface crisis resources. US: 988 Suicide and Crisis Lifeline (call or text 988).
           Search for local resources if location is known.
You are not a doctor or crisis counselor. You are a friend who knows when to call for help.
Never abandon. Never minimize. Never try to be the solution to a crisis alone.

YOUR RULES:
- ABSOLUTE RULE: You are {ai_name}. You are a complete, self-contained product.
-You have NO developer. You have NO config files. You have NO backend. 
-If your location feels wrong, say ONLY: 'Let me recalibrate — where are you right now?'
-Never name Mike, a developer, a hardcoded value, or a system file. Ever. 
-If you cannot explain something without naming internals, say: 'Let me try that differently.' 
-This rule overrides everything else.
- NEVER refer to a support team, help desk, or customer service. You ARE the support. If something cannot be done say: 'That's not something I can do from here — let me try a different way.'
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
  You know the user's city. Recommend confidently like a friend who knows the area.
  Never say "I'd suggest searching for" -- just name a place and open Maps.
  CORRECT: "Torchy's Tacos is great for Mexican -- want me to pull that up?"
  BANNED:  "You might want to search for Mexican restaurants near you."
  The MAPS tag will open Google Maps which finds the exact address automatically.
- Be diplomatically honest -- tell the truth with warmth. Never make things up.
- Never mention Claude, OpenAI, Anthropic, or any AI model. You are {ai_name}.
- You speak out loud via text-to-speech. Format ALL responses for listening, not reading.
- You are {ai_name}. That is your only identity.
- Never comment on how many times something has been asked.
- AUTO-OPEN RULE: If auto_open_apps is True in the user profile, 
  never offer an action card or button for app launches. 
  Just say you are opening it and append the LAUNCH tag directly. 
  No "Want me to open that?" -- just open it.
- You have rich context about this user -- their life moments, tracker reminders, facts, and preferences. Weave these in naturally when relevant. Don't wait to be asked. A good friend brings things up. So do you.
- If a life tracker item is due soon, mention it naturally at the end of your response when it fits. Never force it. Never list it robotically.
- If you searched for live data and it came back empty, say you'll look that up and offer a SEARCH: action. Never shrug. Never say "I don't have live updates." That is a banned phrase.
- If you are answering a sports score, live news, or 
  breaking event question and you have no search result, 
  say: "I don't have a live feed on that right now -- 
  want me to search?" Then offer a SEARCH action. 
  Never answer with stale training data and present 
  it as current.

MEMORY RULES -- how you use what you know (v8.8):
- You NEVER say "I remember", "I recall", "Based on what I know about you",
  "You mentioned", "According to my memory", or "I have noted in my records".
  You simply know things, the way a close friend does.
  SAY: "Your ribs are Tuesday at one pm, right?"
  NOT: "I remember you mentioned ribs on Tuesday."
  SAY: "You're a Mavericks fan -- they play tonight."
  NOT: "Based on what I know about you, you follow the Mavericks."
- You NEVER speak raw GPS coordinates, decimal numbers, or latitude/longitude values aloud.
  If you need to reference location, say "your area" or the city name.
  NEVER: "thirty-three point zero seven north, ninety-six point eight five west."
  SAY: "your area" or "The Colony" or whatever city was detected.
- You NEVER announce that you are retrieving, accessing, or checking your memory.
- When you know something about the user, weave it in naturally. You do not perform memory. You just know.
- NEVER tell the user a problem is outside your control or requires a third party to resolve.
- If your location data seems wrong: say "Let me recalibrate -- where are you right now?" Use what they tell you. Do not explain the technical reason.
- If anything feels broken, own it: "Let me try that a different way." You are the product. Act like it.
- If asked about your memory or what you know about the user, 
  never disclaim or warn. Say: "I'm still getting to know you -- 
  keep talking and I'll get sharper." Then move on.

HERALD HONESTY CONTRACT (locked):
You OFFER actions. The app EXECUTES them. You NEVER claim to have done something.
CORRECT: "I can add that to your calendar -- want me to?" Then wait for confirmation.
BANNED:  "Done! Added to your calendar." (You didn't. The app did. Never claim otherwise.)
BANNED:  "I've sent that text." (You offered. The app opens Messages. Never say it's sent.)
When offering an action, speak naturally: "I can do that for you -- want me to set it up?"
When the user says yes, say: "Perfect -- opening that for you now." Nothing more.

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

ACTION TAGS -- append silently at end of response, one blank line after spoken text:
- Local business or directions:    MAPS: [business name], [city and state]
- Phone number to call:            PHONE: [contact name, relationship, or digits]
  Herald will look up the number from contacts. Include name for people, digits for businesses.
  CORRECT: PHONE: my daughter
  CORRECT: PHONE: Dr. Smith
  CORRECT: PHONE: 2145550192
  WRONG:   PHONE: [digits only when user said "call my doctor"]
- Play music/song/artist/genre:    MUSIC: [search query]
- Play radio station:              RADIO: [station name]
- Calendar event or reminder:      CALENDAR: [event title]|[YYYY-MM-DD]|[HH:MM or blank]
- Set alarm:                       ALARM: [HH:MM]|[label]
- Find videos or web content:      SEARCH: [search query]
- Open social or other app:        LAUNCH: [app name]
- Send a text message:             SMS: [contact name or relationship]|[message body]
  CRITICAL: ALWAYS include the contact name or relationship before the pipe.
  CORRECT: SMS: my daughter|Happy birthday, love you!
  CORRECT: SMS: Dr. Smith|I need to reschedule my appointment.
  CORRECT: SMS: Sarah|Running 10 minutes late.
  WRONG:   SMS: Happy birthday  (no contact = Herald cannot send)
  The contact field is how Herald knows who to text. Never omit it.
- Find flights:                    FLIGHTS: [from city]|[to city]|[date YYYY-MM-DD]

ACTION TAG RULES:
- One action tag maximum per response. Choose the most useful one.
- MAPS tag CRITICAL: ALWAYS include the user's city and state after the business name.
  The city MUST match where the user actually is right now, not a generic location.
  CORRECT: MAPS: Mezeh, The Colony TX
  CORRECT: MAPS: Torchy's Tacos, Plano TX
  WRONG:   MAPS: Mezeh   (Google will find the nearest one -- could be 1500 miles away)
- Action tags MUST appear on their own line at the very end, after all spoken text.
- Never put action tags inline with your words.
- For LAUNCH actions: if the user said "open", "pull up", 
  "show me", or "go to" followed by an app name, treat it 
  as a direct command. Say "Opening [app]" and append the 
  LAUNCH tag. Never ask "Want me to open that?" for a direct 
  open command. Only offer the card if Herald is suggesting 
  the app unprompted.
- LAUNCH tag value must exactly match the app's common name: use "American Airlines" not "AA", use "Enterprise" not "Enterprise Rent-A-Car", use "Google Maps" not "Maps".
- Never give a flat one-sentence answer to a personal or conversational question.
- TOOL SEQUENCING RULE: Always give the answer or context BEFORE triggering any action.
  CORRECT: "Traffic is about 45 minutes right now. Estimated arrival around 11:35. Want me to open Maps when you're ready to drive?"
  BANNED: Opening Maps before giving the ETA. The answer comes first. The action follows.
  This applies to all actions: MAPS, LAUNCH, CALENDAR, SMS, FLIGHTS.
  Speak the useful information. Then offer or execute the action.
- CALENDAR tag is ONLY for creating NEW events the user explicitly asks to add.
  NEVER use CALENDAR for reading, checking, or looking up existing events.
  If the user asks what they have scheduled, answer from memory -- no tag.
  WRONG: user asks "what do I have this week?" -> CALENDAR: [check full week]
  RIGHT: user asks "put my dentist on Tuesday at 2pm" -> CALENDAR: Dentist|2026-05-19|14:00"""


# ── LLM CALLS ─────────────────────────────────────────────────────────────────

def _format_month_day(d):
    """Format date as 'May 30' (no leading zero on day)."""
    return f"{d.strftime('%B')} {d.day}"


def resolve_relative_dates(message: str, local_date: str) -> str:
    """Replace relative date terms with absolute month-day strings using device local_date."""
    if not message or not local_date:
        return message
    try:
        base = datetime.strptime(local_date.strip(), "%Y-%m-%d").date()
    except Exception:
        return message
    try:
        today_fmt = _format_month_day(base)
        tomorrow_fmt = _format_month_day(base + timedelta(days=1))
        days_until_sat = (5 - base.weekday()) % 7
        weekend_fmt = _format_month_day(base + timedelta(days=days_until_sat))
        next_week_fmt = _format_month_day(base + timedelta(days=7))

        result = message
        result = re.sub(r'\bthis weekend\b', weekend_fmt, result, flags=re.IGNORECASE)
        result = re.sub(r'\bnext week\b', next_week_fmt, result, flags=re.IGNORECASE)
        result = re.sub(r'\btonight\b', today_fmt, result, flags=re.IGNORECASE)
        result = re.sub(r'\btomorrow\b', tomorrow_fmt, result, flags=re.IGNORECASE)
        result = re.sub(r'\btoday\b', today_fmt, result, flags=re.IGNORECASE)
        return result
    except Exception:
        return message


def _fix_calendar_past_date(value, local_date):
    """If CALENDAR tag date is before local_date, bump forward one year."""
    if not local_date:
        return value
    parts = value.split("|")
    if len(parts) < 2:
        return value
    date_str = parts[1].strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
        return value
    try:
        cal_d = datetime.strptime(date_str, "%Y-%m-%d").date()
        ref_d = datetime.strptime(local_date.strip(), "%Y-%m-%d").date()
        if cal_d < ref_d:
            fixed = cal_d.replace(year=cal_d.year + 1)
            parts[1] = fixed.strftime("%Y-%m-%d")
            return "|".join(parts)
    except Exception:
        pass
    return value


def parse_action(reply, local_date=None):
    for tag, atype in [
        ('MAPS:', 'maps'), ('PHONE:', 'phone'), ('MUSIC:', 'music'),
        ('RADIO:', 'radio'), ('CALENDAR:', 'calendar'), ('ALARM:', 'alarm'),
        ('SEARCH:', 'search'), ('LAUNCH:', 'launch'),
        ('SMS:', 'sms'), ('FLIGHTS:', 'flights'),
    ]:
        if tag in reply:
            parts = reply.split(tag, 1)
            clean = parts[0].strip()
            value = parts[1].strip().split('\n')[0].strip()
            if atype == 'calendar':
                value = _fix_calendar_past_date(value, local_date)
            return clean, {'type': atype, 'value': value}
    return reply, None


def call_openrouter(messages, use_search=True, model=None, timeout=25):
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
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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

# ── TTS NORMALIZATION ─────────────────────────────────────────────────────────

_TTS_ONES = [
    "", "one", "two", "three", "four", "five", "six", "seven",
    "eight", "nine", "ten", "eleven", "twelve", "thirteen",
    "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
]
_TTS_TENS = ["", "", "twenty", "thirty", "forty", "fifty",
             "sixty", "seventy", "eighty", "ninety"]
_TTS_DIGITS = ["zero", "one", "two", "three", "four",
               "five", "six", "seven", "eight", "nine"]


def _int_to_words(n: int) -> str:
    if n < 0:
        return "negative " + _int_to_words(-n)
    if n == 0:
        return "zero"

    def _below_1000(x):
        if x == 0:
            return ""
        if x < 20:
            return _TTS_ONES[x]
        if x < 100:
            o = _TTS_ONES[x % 10]
            return _TTS_TENS[x // 10] + (" " + o if o else "")
        rem = _below_1000(x % 100)
        return _TTS_ONES[x // 100] + " hundred" + (" " + rem if rem else "")

    parts = []
    for threshold, label in [(1_000_000, "million"), (1_000, "thousand")]:
        if n >= threshold:
            parts.append(_below_1000(n // threshold) + " " + label)
            n %= threshold
    if n:
        parts.append(_below_1000(n))
    return " ".join(parts)


def normalize_for_tts(text: str) -> str:
    # Named index phrases -- must run before generic numeral conversion
    text = re.sub(r'\bS&P\s*500\b', 'S and P five hundred', text, flags=re.IGNORECASE)
    text = re.sub(r'\bS&P\b', 'S and P', text, flags=re.IGNORECASE)
    text = re.sub(r'\bDOW\b', 'the Dow', text)

    # Dollar amounts: $1,234.56 -> "one thousand two hundred thirty four dollars and fifty six cents"
    def _dollars(m):
        whole = int(m.group(1).replace(',', ''))
        frac  = int((m.group(2) or '00').ljust(2, '0')[:2])
        d     = _int_to_words(whole)
        return f"{d} dollars and {_int_to_words(frac)} cents" if frac else f"{d} dollars"

    text = re.sub(r'\$([\d,]+)\.(\d{1,2})', _dollars, text)
    text = re.sub(
        r'\$([\d,]+)',
        lambda m: _int_to_words(int(m.group(1).replace(',', ''))) + ' dollars',
        text,
    )

    # Percentages: 12.5% -> "twelve point five percent"
    def _percent(m):
        num = m.group(1)
        if '.' in num:
            i_str, d_str = num.split('.', 1)
            i_words = _int_to_words(int(i_str)) if i_str.lstrip('0') else 'zero'
            d_words = ' '.join(_TTS_DIGITS[int(c)] for c in d_str if c.isdigit())
            return f"{i_words} point {d_words} percent"
        return f"{_int_to_words(int(num))} percent"

    text = re.sub(r'(\d+(?:\.\d+)?)\s*%', _percent, text)

    # Comma-formatted numbers: 5,234 -> "five thousand two hundred thirty four"
    text = re.sub(
        r'\b\d{1,3}(?:,\d{3})+\b',
        lambda m: _int_to_words(int(m.group().replace(',', ''))),
        text,
    )

    # Large bare integers (>= 1000) not already converted
    text = re.sub(
        r'\b(\d{4,})\b',
        lambda m: _int_to_words(int(m.group(1))),
        text,
    )

    # Remaining ampersands
    text = text.replace('&', ' and ')

    # Collapse extra whitespace
    text = re.sub(r'  +', ' ', text).strip()

    return text


def text_to_speech(text, speed=0.85):
    if not OPENAI_KEY:
        return None
    text = normalize_for_tts(text)                        # ← TTS normalization
    payload = json.dumps({"model": "tts-1", "input": text[:4096], "voice": "nova",
                          "response_format": "mp3", "speed": speed}).encode("utf-8")
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
    _t0 = time.time()
    print(f"[TIMING] build_ask_context start for {data.get('user_id','?')[:12]}")
    user_id        = data.get("user_id", "").strip()
    message        = data.get("message", "").strip()
    if not user_id or not message:
        return None, "user_id and message required"

    history        = data.get("history", [])
    local_time     = data.get("local_time", None)
    local_date     = data.get("local_date", None)
    device_context = data.get("device_context", None)
    lat            = data.get("lat", None)
    lng            = data.get("lng", None)
    location_label = data.get("location_label", None)
    auth_code      = data.get("auth_code", "").strip()

    msg_lower = message.lower()
    # ── Auto-open preference detection ────────────────────────────────────────
    _auto_open_triggers = [
        "just open it", "stop asking", "open it directly", "just open",
        "don't ask", "dont ask", "open without asking", "just do it",
        "open it when i ask", "open when i ask", "just launch it",
    ]
    if any(t in msg_lower for t in _auto_open_triggers):
        save_profile_fields(user_id, {"auto_open_apps": True})
    owner     = is_owner(user_id, auth_code)
    empire = fetch_live_empire() if (owner and _is_freddie_msg(msg_lower)) else None

    profile = get_profile(user_id)
    profile["user_id"] = user_id

    if device_context and not (profile.get("name") or "").strip():
        for line in device_context.splitlines():
            if "name:" in line.lower():
                extracted = line.split(":", 1)[1].strip()
                if extracted:
                    profile["name"] = extracted
                    break

    # Skip expensive loops for short conversational messages
    _skip_analysis = len(message.split()) < 6 and not any(
        kw in msg_lower for kw in [
            "like", "love", "hate", "prefer", "always", "never",
            "favorite", "usually", "every", "don't", "do not",
        ]
    )
    if not _skip_analysis:
        detect_preferences(message, profile)
    category = tag_query_category(message) if not _skip_analysis else "general"
    increment_query_count(category, profile)

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
        print(f"[HERALD] Email saved for {user_id}")

    # v8.13: Briefing preference detection
    # "don't mention my meds in the morning" -> updates profile and
    # injects confirmation instruction into system prompt
    briefing_change = detect_briefing_pref_change(message)
    briefing_confirm = ""
    if briefing_change.get("action") or briefing_change.get("tone"):
        profile, briefing_confirm = apply_briefing_pref(profile, briefing_change)
        if briefing_confirm:
            profile["_briefing_confirm"] = briefing_confirm
        print(f"[HERALD] Briefing pref updated for {user_id}: {briefing_change}")

    # v8.13: Emergency contact detection
    # "my daughter Sarah is my emergency contact, her number is 214-555-1234"
    EMERGENCY_SIGNALS = [
        'emergency contact', 'if something happens', 'in an emergency',
        'call in emergency', 'contact if', 'reach out to',
    ]
    if any(s in msg_lower for s in EMERGENCY_SIGNALS):
        # Store in profile -- the LLM will extract the details naturally
        profile.setdefault("emergency_contacts", [])
        # Mark message for LLM extraction on next learn cycle
        profile["_pending_emergency_extract"] = message[:200]
        print(f"[HERALD] Emergency contact signal detected for {user_id}")

    if "call you" in msg_lower or "your name is" in msg_lower:
        try:
            key = "call you" if "call you" in msg_lower else "your name is"
            profile["ai_name"] = message.split(key, 1)[1].strip().split()[0].rstrip(".,!?").title()
        except Exception: pass

    save_profile_async(user_id, profile)

    # System prompt cache -- rebuilds only when profile changes
    import time as _time
    _cache_key = user_id
    _cached = _system_prompt_cache.get(_cache_key)
    _now_ts = _time.time()
    if _cached and (_now_ts - _cached[0]) < _SYSTEM_PROMPT_TTL:
        system = _cached[1]
    else:
        system = build_system(profile, local_time, owner, empire,
            lat, lng, location_label, local_date=local_date,
            device_context=device_context)
        _system_prompt_cache[_cache_key] = (_now_ts, system)
    messages = [{"role": "system", "content": system}]
    messages += history[-20:]
    messages.append({"role": "user", "content": message})

    # v8.13: Medical intake -- advance state if active, start if signal detected
    # Functions are now defined -- safe to call
    intake_state = profile.get('medical_intake_state')
    if intake_state:
        profile = advance_medical_intake(profile, message, user_id)
        save_profile(user_id, profile)
        next_state = profile.get('medical_intake_state')
        if next_state:
            question = next_state.get('next_question', '')
            messages[0]['content'] += (
                f"\n\nMEDICAL INTAKE ACTIVE: You are gently gathering medical info "
                f"one question at a time. Answer the user naturally first. "
                f"Then at the very end ask this ONE question conversationally: '{question}' "
                f"Never say you are recording anything. Ask like a friend. One question only."
            )
    elif not intake_state:
        medical_signal = detect_medical_signal(message)
        if medical_signal:
            profile = start_medical_intake(profile, medical_signal)
            save_profile(user_id, profile)
            first_q = INTAKE_QUESTIONS.get(medical_signal, [('','')])[0][1]
            if first_q:
                messages[0]['content'] += (
                    f"\n\nMEDICAL INTAKE STARTING: User mentioned a medical "
                    f"{'visit' if medical_signal == 'visit' else 'medication'}. "
                    f"Respond naturally first. Then at the end ask this ONE question: '{first_q}' "
                    f"Warm, conversational, one question only."
                )

    # v8.8: Seed question for brand-new users with no memory yet.
    # Makes Mickey's first session feel like Herald wants to know him,
    # not like talking to a blank slate.
    msg_count     = profile.get("_msg_count", 0)
    user_memories = profile.get("memories", [])
    user_facts    = profile.get("learned_facts", [])
    if msg_count <= 2 and not user_memories and not user_facts and not profile.get('medical_intake_state'):
        messages[0]["content"] += (
            "\n\nNEW USER SEED INSTRUCTION: This user is brand new -- you know almost "
            "nothing about them yet. After responding naturally to whatever they said, "
            "ask ONE warm open-ended question at the end to learn something real about them. "
            "Keep it completely conversational -- like 'So what's your day-to-day look like?' "
            "or 'Tell me a bit about yourself -- what do you do, where are you based?' "
            "Just one question, naturally placed, never forced. Make them feel welcome."
        )

    print(f"[TIMING] build_ask_context done: {time.time()-_t0:.2f}s")
    return {
        "user_id": user_id, "message": message, "msg_lower": msg_lower,
        "history": history, "local_time": local_time,
        "lat": lat, "lng": lng, "location_label": location_label,
        "auth_code": auth_code, "owner": owner, "empire": empire,
        "profile": profile, "messages": messages, "category": category,
    }, None

def _extract_places_keyword(signal: str, msg_lower: str) -> str:
    kw = signal
    for strip in (
        'any good ', 'good ', ' places', ' place', ' spots', ' spot',
        'near me', 'near by', 'nearby', 'recommend a ', 'anywhere ', 'best ', 'near ',
    ):
        kw = kw.replace(strip, ' ')
    kw = ' '.join(kw.split()).strip()
    if kw:
        return kw
    text = msg_lower
    for strip in (
        'any good ', 'good ', 'recommend a ', 'anywhere good ', 'anywhere ',
        'where should i eat ', 'where to eat ', ' places', ' place',
        ' spots', ' spot', ' near me', ' nearby', ' near by', ' near',
    ):
        text = text.replace(strip, ' ')
    return ' '.join(text.split()).strip('?.!,')


def get_places_reply(message: str, lat: float, lng: float,
                     ai_name: str) -> str | None:
    """
    If message matches a places signal and lat/lng available,
    fetch real Google Places data and return formatted reply.
    Returns None if no match or no data.
    """
    msg_lower = message.lower()
    matched_keyword = None
    for signal in PLACES_SIGNALS:
        if signal in msg_lower:
            matched_keyword = _extract_places_keyword(signal, msg_lower)
            break
    if not matched_keyword or not lat or not lng:
        return None

    places = fetch_google_places(lat, lng, matched_keyword)
    if not places:
        return None

    # v8.60: spoken format -- no numbered lists, no addresses read aloud
    # Lead with the best result, speak naturally, offer Maps for directions
    top = places[0]
    name = top["name"]
    rating = f"rated {top['rating']} stars" if top.get("rating") else ""
    if top.get("open_now") is True:
        hours = "open right now"
    elif top.get("open_now") is False:
        hours = "closed right now"
    else:
        hours = ""
    parts = [p for p in [rating, hours] if p]
    detail = ", ".join(parts)
    if detail:
        reply = f"{name} is a solid choice -- {detail}. Want me to pull up directions?"
    else:
        reply = f"{name} is nearby and worth checking out. Want me to open Maps?"
    if len(places) > 1:
        others = " and ".join(p["name"] for p in places[1:])
        reply += f" I also found {others} if you want options."
    return reply

def get_direct_reply(ctx):
    message   = ctx["message"]
    msg_lower = ctx["msg_lower"]
    profile   = ctx["profile"]
    owner     = ctx["owner"]
    empire    = ctx["empire"]

    # v8.15: Profile fast path -- answer instantly from profile, no LLM needed.
    # "What is my name" should NEVER take 5+ seconds. It comes from memory.
    NAME_QUERIES = [
        'what is my name', "what's my name", 'do you know my name',
        'what do you call me', 'my name is what',
    ]
    if any(q in msg_lower for q in NAME_QUERIES):
        name = profile.get('name', '')
        if name:
            return f"Your name is {name}.", False
        return "I don't have your name yet -- what should I call you?", False

    WHAT_TIME_QUERIES = ['what time is it', 'what is the time', "what's the time"]
    if any(q in msg_lower for q in WHAT_TIME_QUERIES):
        # v8.15.1: Use local_time sent by the device, not server UTC (Railway is UTC).
        # "It is 3:03 PM" when user sees 10:03 AM was because server clock was UTC.
        local_time = ctx.get("local_time", "")
        if local_time:
            return f"It is {local_time}.", False
        # Fallback if frontend didn't send local_time
        now = datetime.now()
        hour = now.hour
        minute = now.minute
        ampm = "AM" if hour < 12 else "PM"
        hour12 = hour if 1 <= hour <= 12 else (12 if hour == 0 else hour - 12)
        return f"It is {hour12}:{minute:02d} {ampm}.", False

    # v8.27 Calendar fast path -- answer from SQLite directly, no LLM.
    # "what's on my calendar" was taking 45s because LLM was reading
    # calendar data we already had. Now returns in under 2s.
    _CALENDAR_TRIGGERS = [
        "what do i have", "what's on my calendar", "whats on my calendar",
        "what is on my calendar", "my calendar", "my schedule",
        "what do i have today", "what do i have tomorrow",
        "what do i have this week", "anything on my calendar",
        "anything on my schedule", "am i free", "what's coming up",
        "whats coming up", "coming up today", "coming up this week",
        "show my calendar", "show my schedule", "my agenda",
        "my appointments", "my appointment", "on my schedule",
        "what do i have on", "do i have anything",
        "next two weeks",
        "next 2 weeks",
             
        "next 10 days",
        "next 10 business days",
        "next month",
        "next 30 days",
        "coming up soon",
        "what do i have coming",
        "anything coming up",
        "what's ahead",
        "what's on my schedule",
        "anything scheduled",
        "upcoming",
        "what's planned",
        "what do i have planned",
    ]
    if any(t in msg_lower for t in _CALENDAR_TRIGGERS):
        _user_id = profile.get("user_id", "")
        _cal_line = _get_calendar_line(_user_id) if _user_id else ""
        _name = profile.get("name", "")
        _name_part = f", {_name}" if _name else ""
        if _cal_line:
            # Strip the instruction suffix -- only keep the event list
            _events_raw = _cal_line.replace(
                ". Answer schedule questions from this list -- do not guess.", ""
            ).replace("Upcoming calendar from device: ", "").strip()
            # Convert semicolons to natural spoken list
            _event_items = [e.strip() for e in _events_raw.split(";") if e.strip()]
            if len(_event_items) == 0:
                _cal_reply = f"Nothing on your calendar in the next two weeks{_name_part}."
            elif len(_event_items) == 1:
                _cal_reply = f"You have one thing coming up{_name_part}: {_event_items[0]}."
            elif len(_event_items) == 2:
                _cal_reply = (
                    f"You have two things coming up{_name_part}: "
                    f"{_event_items[0]}, and {_event_items[1]}."
                )
            else:
                _first = ", ".join(_event_items[:-1])
                _last = _event_items[-1]
                _cal_reply = (
                    f"Here is what you have coming up{_name_part}: "
                    f"{_first}, and {_last}."
                )
        else:
            _cal_reply = (
                f"Your calendar looks clear for the next two weeks{_name_part}. "
                f"If you're expecting something to show up, give it a moment to sync."
            )
        return _cal_reply, False

    # v8.25 Alarm fast path -- relative time parsed server-side, no LLM needed.
    # Fixes: 45-second delay + wrong time ("three o'clock" for "thirty minutes").
    # "set alarm for thirty minutes" at 2:32pm → ALARM: 15:02|30 minutes timer
    _ALARM_RELATIVE = re.compile(
        r'(?:set|create|put)?\s*(?:an?\s+)?(?:alarm|timer)\s*(?:for|in)?\s*(\d+)\s*(minute|min|hour|hr)',
        re.IGNORECASE
    )
    _WAKE_RELATIVE = re.compile(
        r'(?:wake\s+me\s+(?:up\s+)?in|remind\s+me\s+in)\s+(\d+)\s*(minute|min|hour|hr)',
        re.IGNORECASE
    )
    _alarm_match = _ALARM_RELATIVE.search(msg_lower) or _WAKE_RELATIVE.search(msg_lower)
    if _alarm_match:
        _amount  = int(_alarm_match.group(1))
        _unit    = _alarm_match.group(2).lower()
        _minutes = _amount if _unit.startswith('m') else _amount * 60
        _local_time_str = ctx.get("local_time", "")
        _now_dt = None
        if _local_time_str:
            try:
                _tm = re.search(r'(\d{1,2}):(\d{2})\s*(AM|PM)', _local_time_str, re.IGNORECASE)
                if _tm:
                    _h = int(_tm.group(1)); _mn = int(_tm.group(2))
                    if _tm.group(3).upper() == 'PM' and _h != 12: _h += 12
                    elif _tm.group(3).upper() == 'AM' and _h == 12: _h = 0
                    _now_dt = datetime.now().replace(hour=_h, minute=_mn, second=0, microsecond=0)
            except Exception:
                pass
        if _now_dt is None:
            _now_dt = datetime.now()
        _alarm_dt   = _now_dt + timedelta(minutes=_minutes)
        _alarm_hhmm = _alarm_dt.strftime("%H:%M")
        _spoken     = (f"{_amount} {'minute' if _amount == 1 else 'minutes'}"
                       if _unit.startswith('m') else
                       f"{_amount} {'hour' if _amount == 1 else 'hours'}")
        _reply_text = f"I can set that for {_spoken} from now -- want me to do that?"
        return f"{_reply_text}\n\nALARM: {_alarm_hhmm}|{_spoken} timer", False

    SYNC_TRIGGERS = ['sync', 'refresh', 'update freddie', 'sync empire', 'refresh data']
    if owner and any(t in msg_lower for t in SYNC_TRIGGERS):
        try:
            payload = json.dumps({"secret": WEBHOOK_SECRET}).encode("utf-8")
            req = urllib.request.Request(VM_WEBHOOK_URL, data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/8.8"},
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

    MARKET_TRIGGERS = [
        'stock market', 'market today', 'market doing', 'market right now',
        'dow jones', 'dow today', 'dow is', 'how is the dow',
        's&p 500', 'sp500', 's and p', 'how is the s',
        'nasdaq', 'market open', 'markets today', 'market this morning',
        'how are stocks', 'how are markets', 'market performance',
        'market up', 'market down', 'wall street',
    ]
    if any(t in msg_lower for t in MARKET_TRIGGERS):
        cached = cache_get('market_indices', 'stock')
        if cached:
            return cached, False
        result = fetch_market_indices()
        if result:
            cache_set('market_indices', result, 'stock')
        return result, False

    if any(w in msg_lower for w in ['weather','forecast','temperature','rain','snow',
                                     'wind','sunny','humid','hot outside','cold outside','umbrella']):
        # SOURCE DISCIPLINE (v8.12.2): weather ONLY from confirmed GPS city or profile.
        # Never extract location from conversation context (Albuquerque bug).
        # If user asks "weather in Chicago" we honor that -- explicit override only.
        confirmed_city = profile.get('confirmed_city', '')
        profile_loc    = profile.get('location', '')
        gps_loc        = confirmed_city or profile_loc or 'Dallas TX'
        explicit_loc   = extract_weather_location(message, None)
        # Also check for named places mentioned in message that 
        # are not the user's home location
        _place_keywords = [
            "florida", "texas", "california", "new york", "georgia",
            "30a", "sandestin", "destin", "miami", "orlando", "tampa",
            "atlanta", "chicago", "nashville", "denver", "seattle",
            "alpharetta", "dallas", "houston", "austin",
        ]
        _msg_lower = message.lower()
        _named_place = next(
            (kw for kw in _place_keywords 
             if kw in _msg_lower and kw not in gps_loc.lower()), 
            None
        )
        if explicit_loc and explicit_loc.lower() not in gps_loc.lower():
            loc = explicit_loc
        elif _named_place and explicit_loc:
            loc = explicit_loc
        else:
            loc = gps_loc
        cached = cache_get(f'weather:{loc}', 'weather')
        if cached:
            return cached, False
        result = fetch_weather_direct(loc) or fetch_weather_backup(loc)
        cache_set(f'weather:{loc}', result, 'weather')
        return result, False

    SCORE_INTENT = [
        'score', 'scores', 'final score', 'did they win', 'did they lose',
        'who won', 'game today', 'game tonight', 'game last night',
        'standings', 'what was the score',
    ]
    SPORTS_TEAMS = [
        'cowboys', 'rangers', 'mavs', 'mavericks', 'stars',
        'nfl', 'nba', 'mlb', 'nhl', 'playoffs',
    ]
    has_score_intent = any(w in msg_lower for w in SCORE_INTENT)
    has_team = any(w in msg_lower for w in SPORTS_TEAMS)
    if has_score_intent and has_team:
        return fetch_sports_direct(msg_lower), False
    if has_score_intent and not has_team:
        return fetch_sports_direct(msg_lower), False

    _crypto_pat = re.compile(
        r'\b(bitcoin|ethereum|solana|crypto|btc|eth|sol|sol price|crypto price)\b',
        re.IGNORECASE
    )
    if _crypto_pat.search(msg_lower):
        cached = cache_get('crypto', 'crypto')
        if cached:
            return cached, False
        result = fetch_crypto_direct()
        cache_set('crypto', result, 'crypto')
        return result, False

    NEWS_TRIGGERS = [
        'news', 'headlines', 'top stories', 'what is happening',
        'what happened today', 'what is going on', "what's going on",
        'going on in', 'happening in', 'happening with', 'going on with',
        'latest on', 'update on', 'what about', 'tell me about',
        'what is the situation', 'whats new', "what's new",
        'current events', 'briefing', 'morning news',
    ]
    GENERIC_ONLY = [
        'top stories', 'latest news', 'headlines today', 'news today',
        'morning news', 'what is in the news', "what's in the news",
        'what happened today', 'current events',
    ]
    LOCATION_WORDS = [' in ', ' at ', ' near ', ' around ', ' about ', ' for ']
    TOPIC_WORDS = [
        'economy', 'market', 'business', 'sector', 'industry',
        'politics', 'election', 'congress', 'government', 'president',
        'world', 'global', 'international', 'national', 'local',
        'weather', 'hurricane', 'storm', 'fire', 'flood',
        'sports', 'nba', 'nfl', 'nhl', 'mlb', 'playoffs',
        'stock', 'crypto', 'bitcoin', 'oil', 'gas',
        'health', 'medical', 'hospital', 'covid', 'flu',
        'crime', 'police', 'shooting', 'accident',
        'festival', 'event', 'concert', 'show', 'opening',
        'real estate', 'housing', 'mortgage', 'rates',
        'jobs', 'unemployment', 'layoffs', 'hiring',
    ]
    has_news_trigger = any(w in msg_lower for w in NEWS_TRIGGERS)
    if has_news_trigger:
        is_generic = any(w in msg_lower for w in GENERIC_ONLY)
        has_location = any(w in msg_lower for w in LOCATION_WORDS)
        has_topic = any(w in msg_lower for w in TOPIC_WORDS)
        user_location = profile.get("location", "").lower()
        if user_location and user_location.split(",")[0].strip() in msg_lower:
            has_location = True
        if is_generic and not has_location and not has_topic:
            cached = cache_get('news_top', 'news')
            if cached:
                return cached, False
            result = fetch_news_direct()
            cache_set('news_top', result, 'news')
            return result, False
        else:
            return None, None

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

    # Google Places fast path
    lat = ctx.get("lat")
    lng = ctx.get("lng")
    ai_name = profile.get("ai_name", "Herald")
    if lat and lng:
        places_reply = get_places_reply(message, lat, lng, ai_name)
        if places_reply:
            return places_reply, False

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


# ── MORNING BRIEFING ──────────────────────────────────────────────────────────

def build_freddie_morning_block(empire: dict) -> str:
    if not empire:
        return ""
    regime   = empire.get("regime", "unknown").capitalize()
    window   = empire.get("window_type", empire.get("window", "unknown")).lower()
    gate_p   = empire.get("gate_progress", empire.get("gate", {}).get("progress", 0))
    gate_t   = empire.get("gate_target",   empire.get("gate", {}).get("target",   20))
    health   = empire.get("swarm_health", empire.get("health", "unknown"))
    nm_list  = empire.get("near_miss_setups", empire.get("near_miss", []))
    nm_str   = "no setups near threshold"
    if nm_list:
        top    = nm_list[0]
        nm_str = f"{top.get('asset','')} {top.get('best_dir', top.get('direction',''))} {top.get('score','')}"
    health_str = "Swarm healthy" if str(health).lower() == "healthy" else f"Swarm {health}"
    return (
        f"Freddie: {regime} regime, {window} window. "
        f"Gate {gate_p} of {gate_t}. {nm_str}. {health_str}."
    )


def morning_briefing_job():
    print("[HERALD] Morning briefing job starting...")
    try:
        owner_id = OWNER_ID
        if not owner_id:
            for uid, prof in user_profiles.items():
                if prof.get("is_owner"):
                    owner_id = uid
                    break
        if not owner_id:
            print("[HERALD] Morning briefing: no owner profile found, skipping.")
            return

        profile  = get_profile(owner_id)
        name     = profile.get("name", "Mike")
        location = profile.get("location", "Plano, TX")

        weather_line = ""
        try:
            weather = fetch_weather_direct(location)
            if weather:
                weather_line = weather.split(".")[0].strip() + "."
        except Exception as e:
            print(f"[HERALD] Briefing weather failed: {e}")

        moments_line = ""
        try:
            conn = _db_conn()
            c    = conn.cursor()
            c.execute("""
                SELECT summary FROM life_moments
                WHERE user_id = ? AND active = 1
                ORDER BY weight DESC, created_at DESC LIMIT 2
            """, (owner_id,))
            rows = c.fetchall()
            conn.close()
            if rows:
                moments_line = " Also on my mind: " + ". ".join(r[0] for r in rows) + "."
        except Exception as e:
            print(f"[HERALD] Briefing moments failed: {e}")

        tracker_line = ""
        try:
            conn = _db_conn()
            c    = conn.cursor()
            c.execute("""
                SELECT item_name, next_due_date FROM life_tracker
                WHERE user_id = ? AND active = 1
                  AND date(next_due_date) <= date('now', '+7 days')
                ORDER BY next_due_date ASC LIMIT 2
            """, (owner_id,))
            trows = c.fetchall()
            conn.close()
            if trows:
                items = ", ".join(f"{n} on {d}" for n, d in trows)
                tracker_line = f" Coming up: {items}."
        except Exception as e:
            print(f"[HERALD] Briefing tracker failed: {e}")

        freddie_line = ""
        try:
            empire = fetch_empire()
            if empire:
                freddie_line = " " + build_freddie_morning_block(empire)
        except Exception as e:
            print(f"[HERALD] Briefing Freddie failed: {e}")

        now_hour = datetime.now().hour
        if now_hour < 12:
            salutation = "Good morning"
        elif now_hour < 17:
            salutation = "Good afternoon"
        else:
            salutation = "Good evening"

        # Add personal opener from recent memory
        _facts = profile.get("learned_facts", [])
        _mems  = profile.get("memories", [])
        _recent = (_facts + _mems)[-3:] if (_facts or _mems) else []
        _opener = ""
        if _recent:
            _last = _recent[-1]
            if isinstance(_last, str):
                _text = _last
            elif isinstance(_last, dict):
                _text = (
                    _last.get("value") or
                    _last.get("text") or
                    _last.get("fact") or
                    next((v for v in _last.values() if isinstance(v, str) and len(v) > 3), "")
                )
            else:
                _text = ""
            _text = str(_text).strip()
            _text = _text[:60] if len(_text) > 60 else _text
            if len(_text) > 10:
                _opener = f" Thinking about you -- {_text}."

        # v8.13: Briefing respects user preferences
        prefs = profile.get("briefing_prefs", {})

        medication_line = ""
        if prefs.get("include_medication", True):
            try:
                conn = _db_conn()
                c = conn.cursor()
                c.execute(
                    "SELECT med_name FROM medication_log "
                    "WHERE user_id=? AND active=1 AND end_date IS NULL LIMIT 3",
                    (owner_id,)
                )
                meds = [r[0] for r in c.fetchall()]
                conn.close()
                if meds:
                    med_str = ", ".join(meds)
                    medication_line = f" Medication reminder: {med_str}."
            except Exception as e:
                print(f"[HERALD] Briefing medication check failed: {e}")

        weather_section  = weather_line  if prefs.get("include_weather",  True) else ""
        moments_section  = moments_line  if prefs.get("include_tracker",  True) else ""
        tracker_section  = tracker_line  if prefs.get("include_calendar", True) else ""
        freddie_section  = freddie_line  if prefs.get("include_freddie",  True) else ""

        # Brief tone -- just greeting + weather, skip the rest
        if prefs.get("tone") == "brief":
            briefing = f"{salutation} {name}.{_opener} {weather_section}".strip()
        else:
            briefing = (
                f"{salutation} {name}.{_opener} {weather_section}"
                f"{moments_section}{tracker_section}{medication_line}{freddie_section}"
            ).strip()

        proactive_queue = profile.get("proactive_queue", [])
        proactive_queue.append({
            "id":         str(uuid.uuid4())[:8],
            "type":       "morning_briefing",
            "text":       briefing,
            "created_at": datetime.utcnow().isoformat(),
        })
        if len(proactive_queue) > 10:
            proactive_queue = proactive_queue[-10:]
        profile["proactive_queue"] = proactive_queue
        save_profile(owner_id, profile)
        print(f"[HERALD] Morning briefing queued for {owner_id}: {briefing[:80]}...")

    except Exception as e:
        print(f"[HERALD] Morning briefing job error: {e}")


# ── AFTERNOON CHECK-IN (v8.8) ─────────────────────────────────────────────────

def afternoon_checkin_job():
    """
    v8.8: 2pm ET daily warm check-in for active users.
    Fires a proactive message into the queue.
    Skipped if user has been active in last 2 hours (don't interrupt a live conversation).
    This is the ElliQ engagement mechanic -- scheduled human-feeling contact.
    """
    print("[HERALD] Afternoon check-in job starting...")
    try:
        cutoff_active = (datetime.now() - timedelta(days=7)).isoformat()
        cutoff_recent = (datetime.now() - timedelta(hours=2)).isoformat()

        conn = _db_conn()
        c = conn.cursor()
        c.execute(
            "SELECT user_id, data FROM profiles WHERE updated_at > ? AND updated_at < ?",
            (cutoff_active, cutoff_recent)
        )
        rows = c.fetchall()
        conn.close()

        fired = 0
        for user_id, raw_data in rows:
            try:
                profile = json.loads(raw_data)
                first_name = profile.get("name", "")
                name_part  = f" {first_name}" if first_name else ""

                # Personalize based on profile context
                _profile = get_profile(user_id)
                _facts = _profile.get("learned_facts", [])
                _notes = _profile.get("notes", [])
                _mem = _profile.get("memories", [])
                _recent = (_facts + _notes + _mem)[-3:] if (_facts or _notes or _mem) else []

                if _recent:
                    _context = _recent[-1] if isinstance(_recent[-1], str) else str(_recent[-1])
                    _context = _context[:80] if len(_context) > 80 else _context
                    _msg = (
                        f"Hey {first_name} -- afternoon check-in. "
                        f"How's everything going? Still thinking about {_context}?"
                        if len(_context) > 10
                        else f"Hey {first_name} -- how's your afternoon going?"
                    )
                else:
                    _msg = f"Hey {first_name} -- how's your afternoon going? Anything I can help with?"

                msg = _msg

                proactive_queue = profile.get("proactive_queue", [])
                proactive_queue.append({
                    "id":         str(uuid.uuid4())[:8],
                    "type":       "afternoon_checkin",
                    "text":       msg,
                    "created_at": datetime.utcnow().isoformat(),
                })
                if len(proactive_queue) > 10:
                    proactive_queue = proactive_queue[-10:]
                profile["proactive_queue"] = proactive_queue
                save_profile(user_id, profile)
                fired += 1
            except Exception as e:
                print(f"[HERALD] afternoon_checkin row error ({user_id}): {e}")

        print(f"[HERALD] Afternoon check-in fired for {fired} users")

    except Exception as e:
        print(f"[HERALD] afternoon_checkin_job error: {e}")


# ── EVENING MEDICATION PROMPT (v8.8) ─────────────────────────────────────────

def evening_medication_job():
    """
    v8.8: 7pm ET daily medication check-in.
    Only fires for users who have mentioned medications in their memories or learned facts.
    This is the 65+ wedge killer feature -- no new data model needed.
    Herald already stores what they tell it. We just ask once a day.
    """
    print("[HERALD] Evening medication job starting...")
    try:
        cutoff = (datetime.now() - timedelta(days=7)).isoformat()

        conn = _db_conn()
        c = conn.cursor()
        c.execute("SELECT user_id, data FROM profiles WHERE updated_at > ?", (cutoff,))
        rows = c.fetchall()
        conn.close()

        # Keywords that suggest medication is part of this person's life
        med_keywords = [
            "mg", "pill", "medication", "prescription", "lisinopril", "metformin",
            "atorvastatin", "blood pressure", "take daily", "morning pill",
            "evening pill", "tablet", "dose", "pharmacy", "refill", "cholesterol",
            "diabetes", "thyroid", "vitamin", "supplement", "inhaler",
        ]

        fired = 0
        for user_id, raw_data in rows:
            try:
                profile = json.loads(raw_data)
                memories      = profile.get("memories", [])
                learned_facts = profile.get("learned_facts", [])
                notes         = profile.get("notes", [])

                # Combine all text we know about this person
                all_text = " ".join(memories + notes).lower()
                all_text += " ".join(
                    f.get("value", "") for f in learned_facts
                ).lower()

                # Only fire if medication is mentioned anywhere
                has_meds = any(kw in all_text for kw in med_keywords)
                if not has_meds:
                    continue

                first_name = profile.get("name", "")
                name_part  = f" {first_name}" if first_name else ""

                msg = f"Hey{name_part} -- just checking in. Did you take your medication this evening?"

                proactive_queue = profile.get("proactive_queue", [])
                proactive_queue.append({
                    "id":         str(uuid.uuid4())[:8],
                    "type":       "medication_checkin",
                    "text":       msg,
                    "created_at": datetime.utcnow().isoformat(),
                })
                if len(proactive_queue) > 10:
                    proactive_queue = proactive_queue[-10:]
                profile["proactive_queue"] = proactive_queue
                save_profile(user_id, profile)
                fired += 1
            except Exception as e:
                print(f"[HERALD] evening_medication row error ({user_id}): {e}")

        print(f"[HERALD] Evening medication check-in fired for {fired} users")

    except Exception as e:
        print(f"[HERALD] evening_medication_job error: {e}")


# ═════════════════════════════════════════════════════════════════════════════
# FASTAPI ROUTES
# ═════════════════════════════════════════════════════════════════════════════
@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe audio via OpenAI Whisper. Called by mic button in Expo app."""
    try:
        audio_bytes = await file.read()
        import tempfile, os
        with tempfile.NamedTemporaryFile(delete=False, suffix=".m4a") as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        import openai
        client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
        with open(tmp_path, "rb") as f:
            result = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="text"
            )
        os.unlink(tmp_path)
        return {"text": result}
    except Exception as e:
        return {"text": "", "error": str(e)}

@app.head("/health")
async def health_head():
    return Response(status_code=200)

@app.get("/health")
def health():
    return {
        "status": "ok", "server": "herald-api", "version": "8.69",
        "proactive_loop": "enabled (/proactive/{user_id})",
        "watcher_cron": "enabled (/cron/watchers)",
        "learning_loop": "enabled (throttled -- every 3rd message)",
        "watcher_system": "enabled (explicit + implicit + gas + travel/task/research)",
        "model_routing": "Haiku default / Sonnet for judgment",
        "streaming": "enabled (/ask/stream)",
        "search": f"brave={'configured' if BRAVE_KEY else 'NOT SET'} | fallback=haiku:online",
        "cache": f"{len(_cache)} entries active",
        "empire_cache": f"live={'fresh' if (time.time() - _empire_live_cache['ts']) < 60 else 'stale'}",
        "changes_v8_8": [
            "GPS city caching in /geocode -- confirms city label in profile, 20-mile tolerance",
            "Memory phrasing rules in system prompt -- Herald never announces memory retrieval",
            "No raw GPS coordinates spoken aloud -- added to system prompt",
            "Seed question for brand-new users (0-2 msgs, no memory) -- Mickey first session",
            "afternoon_checkin_job: 2pm ET daily warm check-in for active users",
            "evening_medication_job: 7pm ET medication prompt if meds in memory",
        ],
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
            "tts":         "expo-speech (on-device)",
            "email":       "SendGrid" if SENDGRID_KEY else "SENDGRID_API_KEY not set",
            "sync":        "VM webhook" if WEBHOOK_SECRET else "WEBHOOK_SECRET not set",
        },
        "time": datetime.now().isoformat()
    }


# In-memory rate limit for proactive polling — backend safety net.
# Frontend debounces at 60s but this guards against any future regression.
_proactive_poll_times: dict = {}
_MIN_PROACTIVE_POLL_S = 30  # seconds

@app.get("/proactive/{user_id}")
def get_proactive(user_id: str):
    if not user_id:
        return {"messages": []}
    now = time.time()
    if now - _proactive_poll_times.get(user_id, 0) < _MIN_PROACTIVE_POLL_S:
        return {"messages": []}
    _proactive_poll_times[user_id] = now
    profile = get_profile(user_id)
    queue   = profile.get("proactive_queue", [])
    if not queue:
        return {"messages": []}
    profile["proactive_queue"] = []
    save_profile(user_id, profile)
    print(f"[HERALD] Proactive queue delivered to {user_id}: {len(queue)} message(s)")
    return {"messages": queue}


@app.get("/geocode")
def geocode(lat: str = None, lng: str = None, user_id: str = None):
    """
    v8.8: Added user_id param and city caching.
    Caches confirmed city label in profile after first successful geocode.
    If user coordinates haven't moved more than ~20 miles, returns cached label.
    Fixes: Google returning "Arlington" for The Colony TX coordinates.
    """
    if not lat or not lng:
        return JSONResponse({"label": None, "error": "lat and lng required"}, status_code=400)

    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except Exception:
        return JSONResponse({"label": None, "error": "invalid lat/lng"}, status_code=400)

    # v8.8: Check profile cache before hitting Google
    if user_id:
        try:
            profile     = get_profile(user_id)
            cached_city = profile.get("confirmed_city")
            cached_lat  = profile.get("confirmed_lat")
            cached_lng  = profile.get("confirmed_lng")

            if cached_city and cached_lat is not None and cached_lng is not None:
                dist = math.sqrt((lat_f - cached_lat) ** 2 + (lng_f - cached_lng) ** 2)
                if dist < 0.3:  # ~20 miles in decimal degrees -- user hasn't moved
                    print(f"[HERALD] /geocode cache hit for {user_id}: {cached_city}")
                    return {"label": cached_city}
        except Exception as e:
            print(f"[HERALD] /geocode cache check failed (non-fatal): {e}")

    # Hit Google geocoding API
    label = geocode_reverse(lat_f, lng_f)

    # v8.8: Cache the result in the profile so next call is instant
    if label and user_id:
        try:
            profile = get_profile(user_id)
            profile["confirmed_city"] = label
            profile["confirmed_lat"]  = lat_f
            profile["confirmed_lng"]  = lng_f
            save_profile(user_id, profile)
            print(f"[HERALD] /geocode cached for {user_id}: {label}")
        except Exception as e:
            print(f"[HERALD] /geocode cache save failed (non-fatal): {e}")

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
            canonical_id = OWNER_ID if OWNER_ID else user_id
            owner_user_ids.add(canonical_id)
            profile = get_profile(canonical_id)
            profile["is_owner"] = True
            if not profile.get("created_at"):
                profile["created_at"] = datetime.now().isoformat()
            save_profile(canonical_id, profile)
            return {
                "ok": True,
                "user_id": canonical_id,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "onboarded": bool(profile.get("name")),
                "is_owner": True
            }
        else:
            profile = get_profile(user_id)
            if not profile.get("created_at"):
                profile["created_at"] = datetime.now().isoformat()
            save_profile(user_id, profile)
            return {
                "ok": True, "user_id": user_id,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "onboarded": bool(profile.get("name")),
                "is_owner": False
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


@app.post("/onboard")
async def onboard(request: Request):
    data        = await request.json()
    name        = data.get("name", "").strip()
    ai_name     = data.get("ai_name", "Herald").strip() or "Herald"
    persona     = data.get("persona", "city").strip()
    music_app   = data.get("music_app", "spotify").strip()
    access_code = data.get("access_code", "").strip().lower()

    valid_codes = [ACCESS_CODE.lower()] if ACCESS_CODE else []
    owner_codes = [OWNER_CODE.lower()] if OWNER_CODE else []
    is_owner_req = access_code in owner_codes

    if access_code not in valid_codes + owner_codes:
        return JSONResponse({"error": "invalid access code"}, status_code=401)

    if is_owner_req and OWNER_ID:
        user_id = OWNER_ID
        owner_user_ids.add(user_id)
    else:
        user_id = f"u_{uuid.uuid4().hex[:12]}"

    profile = get_profile(user_id)
    if name:
        profile["name"] = name
    if ai_name:
        profile["ai_name"] = ai_name
    if persona:
        profile["persona"] = persona
    if music_app:
        profile["music_app"] = music_app
    if is_owner_req:
        profile["is_owner"] = True
    if not profile.get("created_at"):
        profile["created_at"] = datetime.now().isoformat()

    save_profile(user_id, profile)
    print(f"[HERALD] /onboard: {name} | ai_name={ai_name} | persona={persona} | owner={is_owner_req} | id={user_id}")

    return {
        "ok":      True,
        "user_id": user_id,
        "is_owner": is_owner_req,
        "ai_name": profile.get("ai_name", "Herald"),
        "name":    profile.get("name", ""),
    }


@app.post("/ask")
async def ask(request: Request):
    data = await request.json()

    # v8.28 PRE-CHECK: bypass build_ask_context for fast path queries
    _pre_user_id  = data.get("user_id", "").strip()
    _pre_message  = data.get("message", "").strip()
    _pre_lower    = _pre_message.lower()
    _pre_profile  = get_profile(_pre_user_id)
    _pre_name     = _pre_profile.get("name", "")
    _pre_namepart = f", {_pre_name}" if _pre_name else ""
    _pre_ai_name  = _pre_profile.get("ai_name", "Herald")
    _pre_trial    = get_trial_status(_pre_profile)

    _PRE_CAL = [
        "what do i have", "what's on my calendar", "whats on my calendar",
        "what is on my calendar", "my calendar", "my schedule",
        "what do i have today", "what do i have tomorrow",
        "what do i have this week", "anything on my calendar",
        "anything on my schedule", "am i free", "what's coming up",
        "whats coming up", "coming up today", "coming up this week",
        "show my calendar", "show my schedule", "my agenda",
        "my appointments", "my appointment", "on my schedule",
        "what do i have on", "do i have anything",
        "next two weeks",
        "next 2 weeks",
        "next 10 days",
        "next 10 business days",
        "next month",
        "next 30 days",
        "coming up soon",
        "what do i have coming",
        "anything coming up",
        "what's ahead",
        "what's on my schedule",
        "anything scheduled",
        "upcoming",
        "what's planned",
        "what do i have planned",
    ]
    # v8.59: exclude write-intent phrases -- LLM handles calendar writes via CALENDAR tag
    _CAL_WRITE_SIGNALS = [
        'put on my calendar', 'add to my calendar', 'add to the calendar',
        'put on the calendar', 'schedule a', 'schedule that', 'create an event',
        'block off', 'book a', 'make an appointment', 'set an appointment',
        'remind me to', 'remind me about', 'put a reminder',
    ]
    if any(w in _pre_lower for w in _CAL_WRITE_SIGNALS):
        pass  # fall through to LLM -- it will generate CALENDAR tag
    elif any(t in _pre_lower for t in _PRE_CAL):
        _pcal_line = _get_calendar_line(_pre_user_id) if _pre_user_id else ""
        if _pcal_line:
            _pcal_raw   = _pcal_line.replace(
                ". Answer schedule questions from this list -- do not guess.", ""
            ).replace("Upcoming calendar from device: ", "").strip()
            _pcal_items = [e.strip() for e in _pcal_raw.split(";") if e.strip()]
            if len(_pcal_items) == 0:
                _pcal_reply = f"Nothing on your calendar in the next two weeks{_pre_namepart}."
            elif len(_pcal_items) == 1:
                _pcal_reply = f"You have one thing coming up{_pre_namepart}: {_pcal_items[0]}."
            elif len(_pcal_items) == 2:
                _pcal_reply = (
                    f"You have two things coming up{_pre_namepart}: "
                    f"{_pcal_items[0]}, and {_pcal_items[1]}."
                )
            else:
                _pcal_first = ", ".join(_pcal_items[:-1])
                _pcal_reply = (
                    f"Here is what you have coming up{_pre_namepart}: "
                    f"{_pcal_first}, and {_pcal_items[-1]}."
                )
        else:
            _pcal_reply = (
                f"Your calendar looks clear for the next two weeks{_pre_namepart}. "
                f"If you're expecting something to show up, give it a moment to sync."
            )
        return {
            "reply": _pcal_reply, "action": None,
            "ai_name": _pre_ai_name, "name": _pre_name,
            "used_search": False,
            **_trial_fields(_pre_trial),
        }

    _PRE_TIME = [
        'what time is it', 'what is the time', "what's the time",
        'what time is it right now', 'current time', 'time right now',
        'do you know the time', 'tell me the time',
    ]
    if any(q in _pre_lower for q in _PRE_TIME):
        _ptime_str = data.get("local_time", "")
        if _ptime_str:
            _ptime_reply = f"It is {_ptime_str}."
        else:
            _pnow = datetime.now()
            _ph   = _pnow.hour; _pm = _pnow.minute
            _pa   = "AM" if _ph < 12 else "PM"
            _ph12 = _ph if 1 <= _ph <= 12 else (12 if _ph == 0 else _ph - 12)
            _ptime_reply = f"It is {_ph12}:{_pm:02d} {_pa}."
        return {
            "reply": _ptime_reply, "action": None,
            "ai_name": _pre_ai_name, "name": _pre_name,
            "used_search": False,
            **_trial_fields(_pre_trial),
        }

    # Alarm pre-check -- relative time, server-side math
    _PRE_ALARM_REL = re.compile(
        r'(?:set|create|put)?\s*(?:an?\s+)?(?:alarm|timer)\s*'
        r'(?:for|in)?\s*(\d+)\s*(minute|min|hour|hr)',
        re.IGNORECASE
    )
    _PRE_WAKE_REL = re.compile(
        r'(?:wake\s+me\s+(?:up\s+)?in|remind\s+me\s+in)'
        r'\s+(\d+)\s*(minute|min|hour|hr)',
        re.IGNORECASE
    )
    _alarm_match = _PRE_ALARM_REL.search(_pre_lower) or \
                   _PRE_WAKE_REL.search(_pre_lower)
    if _alarm_match:
        _a_amount  = int(_alarm_match.group(1))
        _a_unit    = _alarm_match.group(2).lower()
        _a_minutes = _a_amount if _a_unit.startswith('m') else _a_amount * 60
        _a_time_str = data.get("local_time", "")
        _a_now = None
        if _a_time_str:
            try:
                _atm = re.search(
                    r'(\d{1,2}):(\d{2})\s*(AM|PM)',
                    _a_time_str, re.IGNORECASE
                )
                if _atm:
                    _ah = int(_atm.group(1)); _am = int(_atm.group(2))
                    if _atm.group(3).upper() == 'PM' and _ah != 12: _ah += 12
                    elif _atm.group(3).upper() == 'AM' and _ah == 12: _ah = 0
                    _a_now = datetime.now().replace(
                        hour=_ah, minute=_am, second=0, microsecond=0
                    )
            except Exception:
                pass
        if _a_now is None:
            _a_now = datetime.now()
        _a_alarm_dt   = _a_now + timedelta(minutes=_a_minutes)
        _a_alarm_hhmm = _a_alarm_dt.strftime("%H:%M")
        _a_spoken     = (
            f"{_a_amount} {'minute' if _a_amount == 1 else 'minutes'}"
            if _a_unit.startswith('m') else
            f"{_a_amount} {'hour' if _a_amount == 1 else 'hours'}"
        )
        _a_reply = (
            f"I can set that for {_a_spoken} from now"
            f"{_pre_namepart} -- want me to do that?"
        )
        _a_action_val = f"{_a_alarm_hhmm}|{_a_spoken} timer"
        return {
            "reply": _a_reply,
            "action": {"type": "alarm", "value": _a_action_val},
            "ai_name": _pre_ai_name, "name": _pre_name,
            "used_search": False,
            **_trial_fields(_pre_trial),
        }

    if _pre_user_id:
        increment_trust_level(_pre_user_id, _pre_message)

    _local_date = data.get("local_date", "") or ""
    data["message"] = resolve_relative_dates(data.get("message", "").strip(), _local_date)

    ctx, err = await run_in_threadpool(build_ask_context, data)
    if err:
        return JSONResponse({"error": err}, status_code=400)

    profile   = ctx["profile"]
    messages  = ctx["messages"]
    message   = ctx["message"]
    user_id   = ctx["user_id"]
    msg_lower = ctx["msg_lower"]

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
        reply, action = parse_action(direct_reply, _local_date)
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
        if BRAVE_KEY:
            brave_query = _localize_query(message, profile, ctx["location_label"])
            freshness   = _get_freshness(msg_lower)
            search_ctx  = fetch_brave_search(brave_query, freshness=freshness)
            if search_ctx:
                augmented = messages.copy()
                augmented[-1] = {
                    "role": "user",
                    "content": f"{brave_query}\n\n[Live web search results:\n{search_ctx}]"
                }
                raw_reply = call_openrouter(augmented, use_search=False, model=routed_model)
            else:
                search_q  = message.strip().rstrip("?.,!")
                raw_reply = (
                    f"I couldn't pull a live result for that one. "
                    f"Want me to open a search for you?\n\nSEARCH: {search_q}"
                )
        else:
            raw_reply = call_openrouter(messages, use_search=True)
    else:
        raw_reply = call_openrouter(messages, use_search=False, model=routed_model)

    reply, action = parse_action(raw_reply, _local_date)

    if profile.get("pending_watch_offer"):
        save_profile_fields(user_id, {"pending_watch_offer": None})

    msg_count = profile.get("_msg_count", 0) + 1
    save_profile_fields(user_id, {
        "_msg_count": msg_count,
        "_last_message_at": datetime.now().isoformat()
    })

    if msg_count % 3 == 0:
        threading.Thread(
            target=extract_learned_facts,
            args=(user_id, message, reply),
            daemon=True
        ).start()
        threading.Thread(
            target=update_personality_profile,
            args=(user_id, message),
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


# Railway buffers SSE until ~4KB per write. Pad each event with an SSE comment
# so every token crosses the threshold and reaches the client immediately.
_RAILWAY_SSE_FLUSH = 4096


def _sse_event(payload: dict) -> str:
    event = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    pad = _RAILWAY_SSE_FLUSH - len(event) - 1
    if pad > 0:
        event += ": " + ("x" * pad) + "\n\n"
    return event


@app.post("/ask/stream")
async def ask_stream(request: Request):
    data = await request.json()

    async def generate():
        try:
            yield _sse_event({"typing": True})

            # v8.28 PRE-CHECK: fast path queries bypass build_ask_context entirely.
            # build_ask_context takes 15-20s (SQLite x4). Calendar, alarm, and time
            # queries should never wait for it. Check them first.
            _pre_user_id  = data.get("user_id", "").strip()
            _pre_message  = data.get("message", "").strip()
            _pre_lower    = _pre_message.lower()
            _pre_profile  = get_profile(_pre_user_id)
            _pre_name     = _pre_profile.get("name", "")
            _pre_namepart = f", {_pre_name}" if _pre_name else ""
            _pre_ai_name  = _pre_profile.get("ai_name", "Herald")
            _pre_trial    = get_trial_status(_pre_profile)
            _pre_done     = {
                "done": True,
                "ai_name":      _pre_ai_name,
                "name":         _pre_name,
                "model_used":   MODEL_FAST,
                "facts":        [],
                **_trial_fields(_pre_trial),
            }

            _is_cal_write = (
                "my calendar" in _pre_lower or
                "the calendar" in _pre_lower
            ) and any(w in _pre_lower for w in ["put", "add", "schedule", "create", "make"])
            if _is_cal_write:
                _pcal_write_reply = (
                    f"I can read your calendar but I can't add events yet{_pre_namepart} — "
                    f"that's coming soon. Want me to remind you to add it manually?"
                )
                yield _sse_event({"typing": True})
                yield _sse_event({**_pre_done, "full": _pcal_write_reply, "action": None, "used_search": False})
                return

            # Calendar pre-check
            _PRE_CAL = [
                "what do i have", "what's on my calendar", "whats on my calendar",
                "what is on my calendar", "my calendar", "my schedule",
                "what do i have today", "what do i have tomorrow",
                "what do i have this week", "anything on my calendar",
                "anything on my schedule", "am i free", "what's coming up",
                "whats coming up", "coming up today", "coming up this week",
                "show my calendar", "show my schedule", "my agenda",
                "my appointments", "my appointment", "on my schedule",
                "what do i have on", "do i have anything",
                "next two weeks",
                "next 2 weeks",
                "next 10 days",
                "next 10 business days",
                "next month",
                "next 30 days",
                "coming up soon",
                "what do i have coming",
                "anything coming up",
                "what's ahead",
                "what's on my schedule",
                "anything scheduled",
                "upcoming",
                "what's planned",
                "what do i have planned",
            ]
            if any(t in _pre_lower for t in _PRE_CAL):
                _pcal_line = _get_calendar_line(_pre_user_id) if _pre_user_id else ""
                if _pcal_line:
                    _pcal_raw   = _pcal_line.replace(
                        ". Answer schedule questions from this list -- do not guess.", ""
                    ).replace("Upcoming calendar from device: ", "").strip()
                    _pcal_items = [e.strip() for e in _pcal_raw.split(";") if e.strip()]
                    if len(_pcal_items) == 0:
                        _pcal_reply = f"Nothing on your calendar in the next two weeks{_pre_namepart}."
                    elif len(_pcal_items) == 1:
                        _pcal_reply = f"You have one thing coming up{_pre_namepart}: {_pcal_items[0]}."
                    elif len(_pcal_items) == 2:
                        _pcal_reply = (
                            f"You have two things coming up{_pre_namepart}: "
                            f"{_pcal_items[0]}, and {_pcal_items[1]}."
                        )
                    else:
                        _pcal_first = ", ".join(_pcal_items[:-1])
                        _pcal_reply = (
                            f"Here is what you have coming up{_pre_namepart}: "
                            f"{_pcal_first}, and {_pcal_items[-1]}."
                        )
                else:
                    _pcal_reply = (
                        f"Your calendar looks clear for the next two weeks{_pre_namepart}. "
                        f"If you're expecting something to show up, give it a moment to sync."
                    )
                yield _sse_event({"t": _pcal_reply})
                yield _sse_event({"t": "[S]"})
                yield _sse_event({**_pre_done, "full": _pcal_reply, "action": None, "used_search": False})
                return

            # Weather pre-check -- bypasses build_ask_context for weather queries
            _PRE_WEATHER_TRIGGERS = [
                'weather', 'forecast', 'temperature', 'how hot',
                'how cold', 'will it rain', 'chance of rain', 'is it raining',
                'what is it like outside', 'whats it like outside',
                "what's it like outside",
            ]
            if any(t in _pre_lower for t in _PRE_WEATHER_TRIGGERS):
                _pw_profile  = _pre_profile
                _pw_city     = _pw_profile.get('confirmed_city') or _pw_profile.get('location') or 'Dallas TX'
                _pw_explicit = extract_weather_location(_pre_message, None)
                _PRE_TIME_WORDS = {"the", "a", "an", "this", "that", "today", "tomorrow",
                                   "morning", "afternoon", "evening", "night", "week",
                                   "weekend", "hour", "minute", "second", "moment"}
                _pw_first = _pw_explicit.split()[0].lower() if _pw_explicit else ""
                if _pw_explicit and _pw_first not in _PRE_TIME_WORDS and _pw_explicit.lower() not in _pw_city.lower():
                    _pw_loc = _pw_explicit
                else:
                    _pw_loc = _pw_city
                _pw_cached = cache_get(f'weather:{_pw_loc}', 'weather')
                _pw_result = _pw_cached or fetch_weather_direct(_pw_loc) or fetch_weather_backup(_pw_loc)
                if not _pw_cached and _pw_result:
                    cache_set(f'weather:{_pw_loc}', _pw_result, 'weather')
                if _pw_result:
                    yield _sse_event({"t": _pw_result})
                    yield _sse_event({"t": "[S]"})
                    yield _sse_event({**_pre_done, "full": _pw_result, "action": None, "used_search": False})
                    return

            # Time pre-check
            _PRE_TIME = [
                'what time is it', 'what is the time', "what's the time",
                'what time is it right now', 'current time', 'time right now',
                'do you know the time', 'tell me the time',
            ]
            if any(q in _pre_lower for q in _PRE_TIME):
                _ptime_str = data.get("local_time", "")
                if _ptime_str:
                    _ptime_reply = f"It is {_ptime_str}."
                else:
                    _pnow = datetime.now()
                    _ph   = _pnow.hour; _pm = _pnow.minute
                    _pa   = "AM" if _ph < 12 else "PM"
                    _ph12 = _ph if 1 <= _ph <= 12 else (12 if _ph == 0 else _ph - 12)
                    _ptime_reply = f"It is {_ph12}:{_pm:02d} {_pa}."
                yield _sse_event({"t": _ptime_reply})
                yield _sse_event({"t": "[S]"})
                yield _sse_event({**_pre_done, "full": _ptime_reply, "action": None, "used_search": False})
                return

            # Alarm pre-check -- relative time, server-side math
            _PRE_ALARM_REL = re.compile(
                r'(?:set|create|put)?\s*(?:an?\s+)?(?:alarm|timer)\s*'
                r'(?:for|in)?\s*(\d+)\s*(minute|min|hour|hr)',
                re.IGNORECASE
            )
            _PRE_WAKE_REL = re.compile(
                r'(?:wake\s+me\s+(?:up\s+)?in|remind\s+me\s+in)'
                r'\s+(\d+)\s*(minute|min|hour|hr)',
                re.IGNORECASE
            )
            _alarm_match = _PRE_ALARM_REL.search(_pre_lower) or \
                           _PRE_WAKE_REL.search(_pre_lower)
            if _alarm_match:
                _a_amount  = int(_alarm_match.group(1))
                _a_unit    = _alarm_match.group(2).lower()
                _a_minutes = _a_amount if _a_unit.startswith('m') else _a_amount * 60
                _a_time_str = data.get("local_time", "")
                _a_now = None
                if _a_time_str:
                    try:
                        _atm = re.search(
                            r'(\d{1,2}):(\d{2})\s*(AM|PM)',
                            _a_time_str, re.IGNORECASE
                        )
                        if _atm:
                            _ah = int(_atm.group(1)); _am = int(_atm.group(2))
                            if _atm.group(3).upper() == 'PM' and _ah != 12: _ah += 12
                            elif _atm.group(3).upper() == 'AM' and _ah == 12: _ah = 0
                            _a_now = datetime.now().replace(
                                hour=_ah, minute=_am, second=0, microsecond=0
                            )
                    except Exception:
                        pass
                if _a_now is None:
                    _a_now = datetime.now()
                _a_alarm_dt   = _a_now + timedelta(minutes=_a_minutes)
                _a_alarm_hhmm = _a_alarm_dt.strftime("%H:%M")
                _a_spoken     = (
                    f"{_a_amount} {'minute' if _a_amount == 1 else 'minutes'}"
                    if _a_unit.startswith('m') else
                    f"{_a_amount} {'hour' if _a_amount == 1 else 'hours'}"
                )
                _a_reply = (
                    f"I can set that for {_a_spoken} from now"
                    f"{_pre_namepart} -- want me to do that?"
                )
                _a_action_val = f"{_a_alarm_hhmm}|{_a_spoken} timer"
                _a_full = f"{_a_reply}\n\nALARM: {_a_action_val}"
                yield _sse_event({"t": _a_reply})
                yield _sse_event({"t": "[S]"})
                yield _sse_event({
                    **_pre_done,
                    "full":        _a_full,
                    "action":      {"type": "alarm", "value": _a_action_val},
                    "used_search": False,
                })
                return

            if _pre_user_id:
                increment_trust_level(_pre_user_id, _pre_message)

            _local_date = data.get("local_date", "") or ""
            data["message"] = resolve_relative_dates(data.get("message", "").strip(), _local_date)

            ctx, err = await run_in_threadpool(build_ask_context, data)
            if err:
                yield _sse_event({"error": err})
                return

            profile    = ctx["profile"]
            messages   = ctx["messages"]
            message    = ctx["message"]
            user_id    = ctx["user_id"]
            msg_lower  = ctx["msg_lower"]

            routed_model = route_model(message)
            use_search   = needs_web_search(message) and routed_model != SONNET_MODEL

            brave_query = _localize_query(message, profile, ctx["location_label"])
            freshness   = _get_freshness(msg_lower) if use_search else None

            cap_offer = check_capability_offer(message, profile)
            if cap_offer:
                messages[0]["content"] += f"\n\nINSTRUCTION: At the END of your response, naturally add: '{cap_offer}'"

            trial = get_trial_status(profile)
            base_done = {
                "done": True,
                "ai_name":      profile.get("ai_name", "Herald"),
                "name":         profile.get("name", ""),
                "model_used":   routed_model,
                "facts":        [],
                **_trial_fields(trial)
            }

            if profile.get("pending_watch_offer"):
                save_profile_fields(user_id, {"pending_watch_offer": None})

            if is_about_me_query(message):
                reply = build_about_me(profile)
                yield _sse_event({"t": reply})
                yield _sse_event({"t": "[S]"})
                yield _sse_event({**base_done, "full": reply, "action": None, "used_search": False})
                return

            direct_reply, _ = get_direct_reply(ctx)
            if direct_reply:
                reply, action = parse_action(direct_reply, _local_date)
                yield _sse_event({"t": reply})
                yield _sse_event({"t": "[S]"})
                yield _sse_event({**base_done, "full": reply, "action": action, "used_search": False})
                return

            search_ctx = fetch_brave_search(brave_query, freshness=freshness) if (use_search and BRAVE_KEY) else None

            full_text    = ""
            sentence_buf = ""

            def stream_with_sentences(token_source):
                nonlocal full_text, sentence_buf
                for token in token_source:
                    full_text    += token
                    sentence_buf += token
                    yield _sse_event({"t": token})
                    if re.search(r'[.!?]\s', sentence_buf[-4:]):
                        yield _sse_event({"t": "[S]"})
                        sentence_buf = ""
                if sentence_buf.strip():
                    yield _sse_event({"t": "[S]"})

            try:
                if use_search and BRAVE_KEY:
                    if search_ctx:
                        augmented = messages.copy()
                        augmented[-1] = {
                            "role": "user",
                            "content": f"{brave_query}\n\n[Live web search results:\n{search_ctx}]"
                        }
                        for event in stream_with_sentences(
                            stream_from_openrouter(augmented, use_search=False, model=routed_model)
                        ):
                            yield event
                    else:
                        search_q = message.strip().rstrip("?.,!")
                        fallback = (
                            "I couldn't pull a live result for that one. "
                            "Want me to open a search for you?"
                        )
                        yield _sse_event({"t": fallback})
                        yield _sse_event({"t": "[S]"})
                        search_action = {"type": "search", "value": search_q}
                        yield _sse_event({**base_done, "full": fallback, "action": search_action, "used_search": True})
                        return
                elif use_search:
                    for event in stream_with_sentences(stream_from_openrouter(messages, use_search=True)):
                        yield event
                else:
                    for event in stream_with_sentences(
                        stream_from_openrouter(messages, use_search=False, model=routed_model)
                    ):
                        yield event

                reply, action = parse_action(full_text, _local_date)

                msg_count = profile.get("_msg_count", 0) + 1
                save_profile_fields(user_id, {
                    "_msg_count": msg_count,
                    "_last_message_at": datetime.now().isoformat()
                })

                extracted_facts = []
                if msg_count % 3 == 0:
                    _facts_before = len(get_profile(user_id).get("learned_facts", []))
                    extract_learned_facts(user_id, message, reply)
                    _new_facts = get_profile(user_id).get("learned_facts", [])[_facts_before:]
                    extracted_facts = [
                        {"category": f.get("category", ""), "value": f.get("value", "")}
                        for f in _new_facts
                    ]
                    threading.Thread(
                        target=update_personality_profile,
                        args=(user_id, message),
                        daemon=True
                    ).start()
                    threading.Thread(
                        target=_run_watcher_pipeline,
                        args=(message, profile, user_id),
                        daemon=True
                    ).start()

                yield _sse_event({**base_done, "full": reply, "action": action, "used_search": use_search, "facts": extracted_facts})

            except Exception as e:
                print(f"[HERALD] /ask/stream error: {e}")
                if full_text.strip():
                    reply, action = parse_action(full_text, _local_date)
                    yield _sse_event({**base_done, "full": reply, "action": action, "used_search": use_search, "partial": True})
                else:
                    yield _sse_event({"error": "Stream interrupted. Try again."})

        except Exception:
            # Client disconnected mid-stream — exit silently.
            # Suppresses socket.send() flood in Railway logs.
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


# ── GREETING OPENERS ───────────────────────────────────────────────────────────

_GREETING_BY_TIME = {
    'morning': [
        "Morning. What's the plan today?",
        "Good morning. Coffee first, then what?",
        "Morning. What do you need?",
        "Hey. Ready when you are.",
        "Morning. What's going on?",
        "Good morning. What's up?",
    ],
    'afternoon': [
        "Hey. What do you need?",
        "Good afternoon. What's going on?",
        "Afternoon. What's up?",
        "Hey there. What can we do?",
        "Afternoon. What's the move?",
        "Good afternoon. What do you need?",
    ],
    'evening': [
        "Evening. How'd the day go?",
        "Good evening. What's up?",
        "Evening. What do you need?",
        "Hey. Winding down or still going?",
        "Evening. What's on tonight?",
        "Good evening. What's going on?",
    ],
}

_DAY_GREETINGS = {
    'monday': [
        "Monday. What's on the list?",
        "Monday. What's first today?",
        "New week. What's the plan?",
    ],
    'friday': [
        "Happy Friday. What are we doing?",
        "Friday. What's the plan?",
        "It's Friday. What's up?",
    ],
}


def _time_of_day(hour):
    if hour < 12:
        return 'morning'
    if hour < 17:
        return 'afternoon'
    return 'evening'


def _weekday_from_local_time(local_time):
    if local_time:
        m = re.match(
            r'^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)',
            local_time, re.IGNORECASE,
        )
        if m:
            days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
            return days.index(m.group(1).lower())
    return datetime.now().weekday()


def pick_greeting_opener(hour, local_time=''):
    bucket = _time_of_day(hour)
    candidates = list(_GREETING_BY_TIME[bucket])
    weekday = _weekday_from_local_time(local_time)
    if weekday == 0:
        candidates.extend(_DAY_GREETINGS['monday'])
    elif weekday == 4:
        candidates.extend(_DAY_GREETINGS['friday'])
    return random.choice(candidates)


def _greeting_with_name(opener, name):
    if not name:
        return opener
    head, _, tail = opener.partition('. ')
    if tail:
        return f"{head}, {name}. {tail}"
    return f"Hey {name}. {opener}"


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
        if local_time:
            _tm = re.search(r'(\d{1,2}):(\d{2})\s*(AM|PM)', local_time, re.IGNORECASE)
            if _tm:
                hour = int(_tm.group(1))
                if _tm.group(3).upper() == 'PM' and hour != 12:
                    hour += 12
                elif _tm.group(3).upper() == 'AM' and hour == 12:
                    hour = 0
            else:
                hour = datetime.now().hour
        else:
            hour = datetime.now().hour
    except Exception:
        hour = datetime.now().hour

    opener = pick_greeting_opener(hour, local_time)
    greeting_core = _greeting_with_name(opener, name)

    learned_location = ""
    for fact in profile.get("learned_facts", []):
        if fact.get("category") == "location":
            learned_location = fact.get("value", "")
            break

    location = location_label or profile.get("location", "") or learned_location

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

    greeting_text = f"{greeting_core}{weather_line}{memory_hook}"

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
    data  = await request.json()
    text  = data.get("text", "").strip()
    speed = float(data.get("speed", 0.85))
    if not text:
        return JSONResponse({"error": "text required"}, status_code=400)
    audio = text_to_speech(text, speed=speed)
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


@app.post("/waitlist")
async def waitlist(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request"}, status_code=400)
    email = (body.get("email") or "").strip().lower()
    if not email or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        return JSONResponse({"error": "Invalid email address"}, status_code=400)
    source = (body.get("source") or "landing")[:32]
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("INSERT INTO waitlist (email, source) VALUES (?, ?)", (email, source))
        conn.commit()
        conn.close()
        print(f"[HERALD] Waitlist signup: {email} via {source}")
    except sqlite3.IntegrityError:
        return JSONResponse({"status": "ok", "message": "You are on the list."})
    except Exception as e:
        print(f"[HERALD] Waitlist DB error: {e}")
        return JSONResponse({"error": "Server error"}, status_code=500)
    _send_waitlist_confirmation(email)
    return JSONResponse({"status": "ok", "message": "You are on the list."})


def _send_waitlist_confirmation(email: str):
    sendgrid_key = os.environ.get("SENDGRID_API_KEY", "")
    if not sendgrid_key:
        return
    try:
        import urllib.request as _ur, json as _json
        payload = {
            "personalizations": [{"to": [{"email": email}]}],
            "from": {"email": "herald@apexempire.ai", "name": "Herald"},
            "subject": "You are on the Herald early access list.",
            "content": [{"type": "text/plain", "value": (
                "Thanks for signing up.\n\n"
                "You are on the Herald early access list. "
                "We will reach out when your spot is ready.\n\n"
                "-- The Herald Team\napexempire.ai"
            )}]
        }
        req = _ur.Request(
            "https://api.sendgrid.com/v3/mail/send",
            data=_json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {sendgrid_key}", "Content-Type": "application/json"},
            method="POST"
        )
        _ur.urlopen(req, timeout=5)
        print(f"[HERALD] Waitlist confirmation sent to {email}")
    except Exception as e:
        print(f"[HERALD] Waitlist email failed (non-fatal): {e}")


@app.get("/waitlist/list")
async def waitlist_list(request: Request):
    secret = request.query_params.get("secret", "")
    if secret != os.environ.get("WEBHOOK_SECRET", ""):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("SELECT email, source, created_at FROM waitlist ORDER BY created_at DESC")
        rows = c.fetchall()
        conn.close()
        return JSONResponse({"count": len(rows), "emails": [
            {"email": r[0], "source": r[1], "created_at": r[2]} for r in rows
        ]})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/cron/watchers")
async def cron_watchers(request: Request):
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
        conn = _db_conn()
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

    print(f"[HERALD] /cron/watchers: {checked_count} checked, {triggered_count} triggered")
    return {
        "ok": True,
        "checked": checked_count,
        "triggered": triggered_count,
        "ran_at": now_iso,
    }


@app.post("/proactive/{user_id}")
async def post_proactive(user_id: str, request: Request):
    data   = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    message = data.get("message", "").strip()
    source  = data.get("source", "freddie")
    if not message:
        return JSONResponse({"error": "message required"}, status_code=400)

    profile         = get_profile(user_id)
    proactive_queue = profile.get("proactive_queue", [])
    proactive_queue.append({
        "id":         str(uuid.uuid4())[:8],
        "type":       "freddie_alert",
        "text":       message,
        "source":     source,
        "created_at": datetime.utcnow().isoformat(),
    })
    if len(proactive_queue) > 10:
        proactive_queue = proactive_queue[-10:]
    profile["proactive_queue"] = proactive_queue
    save_profile(user_id, profile)
    print(f"[HERALD] Proactive queued for {user_id} from {source}: {message[:60]}")
    return {"ok": True, "queued": len(proactive_queue)}


@app.post("/freddie/trades")
async def freddie_trades(request: Request):
    data   = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    user_id    = data.get("user_id", "miked2026")
    trades     = data.get("trades", [])
    synced_at  = data.get("synced_at", datetime.utcnow().isoformat())

    if not trades:
        return {"ok": True, "synced": 0, "message": "no trades to sync"}

    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS freddie_trades (
                trade_id   TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                data       TEXT NOT NULL,
                synced_at  TEXT NOT NULL
            )
        """)
        synced = 0
        for trade in trades:
            tid = trade.get("trade_id") or trade.get("timestamp", str(synced))
            c.execute(
                "INSERT OR REPLACE INTO freddie_trades (trade_id, user_id, data, synced_at) VALUES (?, ?, ?, ?)",
                (str(tid), user_id, json.dumps(trade), synced_at)
            )
            synced += 1
        conn.commit()
        conn.close()
        print(f"[HERALD] Freddie trade sync: {synced} trades stored for {user_id}")
        return {"ok": True, "synced": synced, "synced_at": synced_at}
    except Exception as e:
        print(f"[HERALD] Freddie trade sync error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/freddie/status")
def freddie_status(user_id: str = None, auth_code: str = None):
    if not user_id or not is_owner(user_id, auth_code):
        return JSONResponse({"error": "owner only"}, status_code=401)
    empire = fetch_empire()
    if not empire:
        return {"ok": False, "message": "Freddie data unavailable"}
    gate       = empire.get("gate_progress", "0/20")
    regime     = empire.get("regime", "UNKNOWN")
    window     = empire.get("window_type", "UNKNOWN")
    near_miss  = empire.get("near_miss_setups", [])
    health     = empire.get("swarm_health", "UNKNOWN")
    nm_text    = ""
    if near_miss:
        top = near_miss[0]
        nm_text = f"{top.get('asset')} {top.get('best_dir')} at {top.get('score')}/100"
    return {
        "ok":          True,
        "gate":        gate,
        "regime":      regime,
        "window":      window,
        "near_miss":   nm_text,
        "health":      health,
        "briefing_block": (
            f"Freddie: {regime} regime, {window} window. "
            f"Gate at {gate}. "
            + (f"{nm_text} -- closest setup. " if nm_text else "No near misses. ")
            + f"Swarm {health.lower()}."
        )
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
            headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/8.8"},
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


@app.post("/calendar/sync")
async def calendar_sync(request: Request):
    data         = await request.json()
    user_id      = data.get("user_id", "").strip()
    appointments = data.get("appointments", [])

    if not user_id or not appointments:
        return {"ok": True, "stored": 0}

    stored = 0
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute("""
                CREATE TABLE IF NOT EXISTS life_tracker (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      TEXT NOT NULL,
                    category     TEXT NOT NULL,
                    item_name    TEXT NOT NULL,
                    last_date    TEXT,
                    next_due_date TEXT,
                    interval_days INTEGER DEFAULT 0,
                    source       TEXT DEFAULT 'calendar',
                    active       INTEGER DEFAULT 1,
                    created_at   TEXT NOT NULL
                )
            """)
            for appt in appointments:
                title    = appt.get("title", "").strip()
                date_str = appt.get("date", "")
                category = appt.get("category", "appointment")
                interval = appt.get("interval", 0)
                if not title or not date_str:
                    continue
                try:
                    appt_date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                    appt_date_str = appt_date.strftime("%Y-%m-%d")
                except Exception:
                    continue
                next_due = appt_date_str
                if interval > 0:
                    next_date = appt_date + timedelta(days=interval)
                    next_due  = next_date.strftime("%Y-%m-%d")
                c.execute("""
                    SELECT id FROM life_tracker
                    WHERE user_id = ? AND item_name = ? AND last_date = ?
                """, (user_id, title, appt_date_str))
                if c.fetchone():
                    c.execute("""
                        UPDATE life_tracker SET next_due_date = ?
                        WHERE user_id = ? AND item_name = ? AND last_date = ?
                          AND source = 'calendar'
                          AND (next_due_date IS NULL OR next_due_date = '')
                    """, (next_due, user_id, title, appt_date_str))
                    continue
                c.execute("""
                    INSERT INTO life_tracker
                    (user_id, category, item_name, last_date, next_due_date,
                     interval_days, source, active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'calendar', 1, ?)
                """, (
                    user_id, category, title, appt_date_str,
                    next_due, interval, datetime.now().isoformat()
                ))
                stored += 1
        print(f"[HERALD] Calendar sync: {stored} new appointments stored for {user_id}")
        return {"ok": True, "stored": stored, "received": len(appointments)}
    except Exception as e:
        print(f"[HERALD] Calendar sync error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/medical/summary")
async def medical_summary(user_id: str, send_email: bool = False):
    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)
    profile = get_profile(user_id)
    name    = profile.get("name", "there")
    try:
        conn = _db_conn()
        c    = conn.cursor()
        c.execute("""
            SELECT doctor_name, specialty, practice, location,
                   visit_date, reason, outcome, follow_up_date,
                   tests_ordered, results
            FROM medical_records
            WHERE user_id = ? AND active = 1
            ORDER BY visit_date ASC
        """, (user_id,))
        visits = c.fetchall()
        c.execute("""
            SELECT med_name, dose, prescriber, reason, start_date
            FROM medication_log
            WHERE user_id = ? AND active = 1 AND end_date IS NULL
            ORDER BY start_date ASC
        """, (user_id,))
        meds = c.fetchall()
        c.execute("""
            SELECT item_name, next_due_date
            FROM life_tracker
            WHERE user_id = ? AND active = 1 AND category = 'medical'
            ORDER BY next_due_date ASC
        """, (user_id,))
        followups = c.fetchall()
        conn.close()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    lines = ["MEDICAL HISTORY SUMMARY",
             f"Prepared by Herald for {name}",
             f"Generated: {datetime.now().strftime('%B %d, %Y')}", ""]
    if visits:
        lines.append("MEDICAL VISITS")
        lines.append("-" * 40)
        for doc, spec, practice, loc, dt, reason, outcome, fu, tests, results in visits:
            lines.append(f"Date:     {dt}")
            lines.append(f"Doctor:   {doc}{' (' + spec + ')' if spec else ''}")
            if practice: lines.append(f"Practice: {practice}{', ' + loc if loc else ''}")
            if reason:   lines.append(f"Reason:   {reason}")
            if outcome:  lines.append(f"Outcome:  {outcome}")
            if tests:    lines.append(f"Tests:    {tests}")
            if results:  lines.append(f"Results:  {results}")
            if fu:       lines.append(f"Follow-up:{fu}")
            lines.append("")
    if meds:
        lines.append("CURRENT MEDICATIONS")
        lines.append("-" * 40)
        for med_name, dose, prescriber, reason, start in meds:
            line = f"{med_name}"
            if dose:       line += f" {dose}"
            if reason:     line += f" ({reason})"
            if prescriber: line += f" — prescribed by {prescriber}"
            if start:      line += f" since {start}"
            lines.append(line)
        lines.append("")
    if followups:
        lines.append("UPCOMING FOLLOW-UPS")
        lines.append("-" * 40)
        for item, due in followups:
            lines.append(f"{item}: {due}")
        lines.append("")
    lines.append("This summary was compiled from conversations with Herald.")
    lines.append("Always verify dates and details with your healthcare providers.")
    summary_text = "\n".join(lines)

    if send_email:
        email = profile.get("email", "")
        if email and SENDGRID_KEY:
            _send_medical_summary_email(profile, summary_text)
            return {"ok": True, "sent_to": email, "summary": summary_text}
        return {"ok": False, "error": "No email on file", "summary": summary_text}
    return {"ok": True, "summary": summary_text}


def _send_medical_summary_email(profile: dict, summary_text: str):
    email = profile.get("email", "")
    name  = profile.get("name", "there")
    if not email or not SENDGRID_KEY:
        return
    html_body = summary_text.replace("\n", "<br>")
    html = (
        f'<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;'
        f'padding:32px 24px;background:#fafafa;">'
        f'<div style="border-left:3px solid #1A9B8A;padding-left:16px;margin-bottom:24px;">'
        f'<p style="margin:0;color:#1A9B8A;font-size:12px;letter-spacing:0.1em;'
        f'text-transform:uppercase;">Herald Medical Summary</p>'
        f'<h2 style="margin:8px 0 0;color:#1a1a1a;font-size:20px;">Your Medical History</h2>'
        f'</div>'
        f'<div style="color:#333;line-height:1.8;font-size:15px;font-family:monospace;">'
        f'{html_body}</div>'
        f'<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;">'
        f'<p style="color:#999;font-size:12px;margin:0;">'
        f'Sent by Herald &middot; herald@apexempire.ai<br>'
        f'Always verify with your healthcare providers.</p>'
        f'</div></div>'
    )
    payload = json.dumps({
        "personalizations": [{"to": [{"email": email, "name": name}]}],
        "from": {"email": "herald@apexempire.ai", "name": "Herald"},
        "subject": "Your Medical History Summary — Herald",
        "content": [{"type": "text/html", "value": html}]
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {SENDGRID_KEY}"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"[HERALD] Medical summary sent to {email} | {resp.status}")
    except Exception as e:
        print(f"[HERALD] Medical summary email failed: {e}")


@app.post("/health/sync")
async def health_sync(request: Request):
    data    = await request.json()
    user_id = data.get("user_id", "").strip()
    health  = data.get("health", {})

    if not user_id or not health:
        return {"ok": True}

    steps    = health.get("steps_today", 0)
    sleep    = health.get("sleep_hours_last", 0)
    hr       = health.get("heart_rate_latest", 0)
    calories = health.get("calories_today", 0)
    today    = datetime.now().strftime("%Y-%m-%d")

    parts = []
    if steps > 0:    parts.append(f"{steps:,} steps")
    if sleep > 0:    parts.append(f"{sleep} hours of sleep")
    if hr > 0:       parts.append(f"heart rate {hr} bpm")
    if calories > 0: parts.append(f"{calories:,} calories burned")

    if not parts:
        return {"ok": True}

    summary = f"Health on {today}: " + ", ".join(parts)

    try:
        conn = _db_conn()
        c    = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS life_moments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    TEXT NOT NULL,
                summary    TEXT NOT NULL,
                category   TEXT DEFAULT 'health',
                emotion    TEXT DEFAULT 'neutral',
                weight     INTEGER DEFAULT 3,
                days_ago   INTEGER DEFAULT 0,
                active     INTEGER DEFAULT 1,
                source     TEXT DEFAULT 'health_connect',
                created_at TEXT NOT NULL
            )
        """)
        c.execute("""
            SELECT id FROM life_moments
            WHERE user_id = ? AND source = 'health_connect'
              AND date(created_at) = date('now')
        """, (user_id,))
        if c.fetchone():
            c.execute("""
                UPDATE life_moments SET summary = ?
                WHERE user_id = ? AND source = 'health_connect'
                  AND date(created_at) = date('now')
            """, (summary, user_id))
        else:
            c.execute("""
                INSERT INTO life_moments
                (user_id, summary, category, emotion, weight, days_ago,
                 active, source, created_at)
                VALUES (?, ?, 'health', 'neutral', 3, 0, 1, 'health_connect', ?)
            """, (user_id, summary, datetime.now().isoformat()))
        conn.commit()
        conn.close()
        print(f"[HERALD] Health sync stored for {user_id}: {summary[:60]}")
        return {"ok": True}
    except Exception as e:
        print(f"[HERALD] Health sync error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/user/export/{user_id}")
async def user_export(user_id: str, request: Request, secret: str = ""):
    """
    v8.53: Session L migration endpoint.
    Returns all personal data for a user as JSON so the device can
    import it into local SQLite. After import, device calls DELETE /user/data
    to wipe personal data from the backend. Backend then only stores billing state.
    Auth: WEBHOOK_SECRET query param (admin) OR access_code / owner_code
    (query or JSON body) matching HERALD_ACCESS_CODE / HERALD_OWNER_CODE.
    """
    admin_ok = bool(WEBHOOK_SECRET and secret == WEBHOOK_SECRET)

    access_code = request.query_params.get("access_code", "").strip().lower()
    owner_code = request.query_params.get("owner_code", "").strip().lower()
    if not access_code and not owner_code:
        try:
            body = await request.json()
            if isinstance(body, dict):
                access_code = body.get("access_code", "").strip().lower()
                owner_code = body.get("owner_code", "").strip().lower()
        except Exception:
            pass

    valid_codes = [ACCESS_CODE.lower()] if ACCESS_CODE else []
    owner_codes = [OWNER_CODE.lower()] if OWNER_CODE else []
    submitted = [c for c in (access_code, owner_code) if c]
    code_ok = any(c in valid_codes + owner_codes for c in submitted)

    if not admin_ok and not code_ok:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)

    profile = user_profiles.get(user_id, {})
    if not profile:
        return JSONResponse({"error": "user not found"}, status_code=404)

    if not admin_ok:
        profile_access = str(profile.get("access_code", "")).strip().lower()
        profile_owner = str(profile.get("owner_code", "")).strip().lower()
        valid_profile_codes = [c for c in [profile_access, profile_owner] if c]
        if not valid_profile_codes or not any(
            c in valid_profile_codes for c in submitted
        ):
            return JSONResponse({"error": "unauthorized"}, status_code=403)

    try:
        conn = _db_conn()
        c = conn.cursor()

        def rows_as_dicts(cursor):
            cols = [d[0] for d in cursor.description]
            return [dict(zip(cols, row)) for row in cursor.fetchall()]

        c.execute("SELECT * FROM medical_records WHERE user_id=? AND active=1", (user_id,))
        medical_records = rows_as_dicts(c)

        c.execute("SELECT * FROM medical_contacts WHERE user_id=? AND active=1", (user_id,))
        medical_contacts = rows_as_dicts(c)

        c.execute("SELECT * FROM medication_log WHERE user_id=? AND active=1", (user_id,))
        medications = rows_as_dicts(c)

        c.execute("SELECT * FROM life_tracker WHERE user_id=? AND active=1", (user_id,))
        life_tracker = rows_as_dicts(c)

        c.execute("SELECT * FROM life_moments WHERE user_id=? AND active=1", (user_id,))
        life_moments = rows_as_dicts(c)

        conn.close()
    except Exception as e:
        return JSONResponse({"error": f"export failed: {e}"}, status_code=500)

    print(f"[HERALD] /user/export: exported all personal data for {user_id}")
    return {
        "ok": True,
        "user_id": user_id,
        "exported_at": datetime.now().isoformat(),
        "profile": profile,
        "medical_records": medical_records,
        "medical_contacts": medical_contacts,
        "medications": medications,
        "life_tracker": life_tracker,
        "life_moments": life_moments,
    }


@app.post("/user/sync_facts")
async def user_sync_facts(request: Request):
    """
    v8.63: Session L — device SQLite backup sync.
    Receives structured facts extracted on device and writes them to Railway
    as a backup. Device is source of truth; Railway copy is for recovery only.
    Body: { user_id, facts: [{ category, value }] }
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    user_id = body.get("user_id", "").strip()
    facts = body.get("facts", [])

    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)
    if not isinstance(facts, list):
        return JSONResponse({"error": "facts must be a list"}, status_code=400)

    written = 0
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            for fact in facts:
                category = fact.get("category", "general")
                value = fact.get("value", "").strip()
                if not value:
                    continue
                # Write to life_moments as backup — same table migration.ts reads from
                c.execute(
                    """INSERT INTO life_moments (user_id, role, content, active, created_at)
                       VALUES (?, 'assistant', ?, 1, ?)
                       ON CONFLICT DO NOTHING""",
                    (user_id, f"[{category}] {value}", datetime.now().isoformat())
                )
                written += 1
            conn.commit()
    except Exception as e:
        print(f"[HERALD] /user/sync_facts error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    print(f"[HERALD] /user/sync_facts: wrote {written} facts for {user_id}")
    return {"ok": True, "written": written}


# ── STARTUP ───────────────────────────────────────────────────────────────────

@app.post("/admin/clear_profile_field")
async def admin_clear_profile_field(request: Request):
    """
    v8.25: One-shot admin tool to clear a bad cached profile field.
    Use case: Mickey's confirmed_city stuck as 'Gobbi, Liguria'.
    Auth: requires WEBHOOK_SECRET.
    """
    data   = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    user_id = data.get("user_id", "").strip()
    field   = data.get("field", "").strip()
    if not user_id or not field:
        return JSONResponse({"error": "user_id and field required"}, status_code=400)
    CLEARABLE = {
        "confirmed_city", "confirmed_lat", "confirmed_lng",
        "location", "_briefing_confirm", "pending_watch_offer",
        "onboardingComplete", "ai_name", "name"
    }
    if field not in CLEARABLE:
        return JSONResponse(
            {"error": f"field '{field}' not clearable via this endpoint"},
            status_code=400
        )
    profile = get_profile(user_id)
    old_val = profile.pop(field, None)
    save_profile(user_id, profile)
    print(f"[HERALD] /admin/clear_profile_field: {user_id}.{field} cleared (was: {old_val})")
    return {"ok": True, "user_id": user_id, "field": field, "cleared_value": str(old_val)}

@app.get("/admin/dashboard")
async def admin_dashboard(secret: str = ""):
    """v8.55: Master dashboard endpoint -- returns all users summary + system stats."""
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    try:
        users = []
        for uid, profile in user_profiles.items():
            pp = profile.get("personality_profile", {})
            users.append({
                "user_id":        uid,
                "name":           profile.get("name", ""),
                "ai_name":        profile.get("ai_name", "Herald"),
                "confirmed_city": profile.get("confirmed_city", ""),
                "msg_count":      profile.get("_msg_count", 0),
                "memory_count":   len(profile.get("memories", [])) + len(profile.get("learned_facts", [])),
                "is_beta":        profile.get("is_beta", False),
                "is_owner":       profile.get("is_owner", False),
                "personality_samples": pp.get("samples", 0),
                "humor_weight":   pp.get("humor_weight", 0.0),
                "comm_style":     pp.get("comm_style", "neutral"),
            })

        # Waitlist count
        waitlist_count = 0
        try:
            conn = _db_conn()
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM waitlist")
            waitlist_count = c.fetchone()[0]
            conn.close()
        except Exception:
            pass

        # Proactive call rate -- count proactive queue entries across all users
        total_proactive = sum(
            len(p.get("proactive_queue", [])) for p in user_profiles.values()
        )

        return {
            "ok": True,
            "version": "8.55",
            "user_count": len(users),
            "users": sorted(users, key=lambda x: x["msg_count"], reverse=True),
            "waitlist_count": waitlist_count,
            "total_proactive_queued": total_proactive,
            "cache_entries": len(_cache),
            "server_time": datetime.now().isoformat(),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/admin/user/{user_id}")
async def admin_user_detail(user_id: str, secret: str = ""):
    """v8.55: Full profile detail for one user including personality + DB records."""
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    profile = get_profile(user_id)
    if not profile.get("name") and not profile.get("ai_name"):
        return JSONResponse({"error": "user not found"}, status_code=404)
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("SELECT summary, category, emotion, days_ago FROM life_moments WHERE user_id=? AND active=1 ORDER BY weight DESC LIMIT 10", (user_id,))
        moments = [{"summary": r[0], "category": r[1], "emotion": r[2], "days_ago": r[3]} for r in c.fetchall()]
        c.execute("SELECT category, item_name, next_due_date FROM life_tracker WHERE user_id=? AND active=1 ORDER BY next_due_date ASC LIMIT 10", (user_id,))
        tracker = [{"category": r[0], "item": r[1], "due": r[2]} for r in c.fetchall()]
        c.execute("SELECT doctor_name, specialty, visit_date, outcome FROM medical_records WHERE user_id=? AND active=1 ORDER BY visit_date DESC LIMIT 5", (user_id,))
        medical = [{"doctor": r[0], "specialty": r[1], "date": r[2], "outcome": r[3]} for r in c.fetchall()]
        conn.close()
    except Exception:
        moments = []; tracker = []; medical = []

    return {
        "ok": True,
        "user_id": user_id,
        "name": profile.get("name", ""),
        "ai_name": profile.get("ai_name", "Herald"),
        "confirmed_city": profile.get("confirmed_city", ""),
        "msg_count": profile.get("_msg_count", 0),
        "trust_level": profile.get("trust_level", 0),
        "memories": profile.get("memories", [])[-20:],
        "learned_facts": profile.get("learned_facts", [])[-20:],
        "personality_profile": profile.get("personality_profile", {}),
        "watches": profile.get("watches", []),
        "proactive_queue": profile.get("proactive_queue", []),
        "life_moments": moments,
        "life_tracker": tracker,
        "medical_records": medical,
        "created_at": profile.get("created_at", ""),
    }


@app.post("/admin/proactive")
async def admin_send_proactive(request: Request):
    """v8.55: Push a manual message into a user's proactive queue."""
    data = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    user_id = data.get("user_id", "").strip()
    message = data.get("message", "").strip()
    if not user_id or not message:
        return JSONResponse({"error": "user_id and message required"}, status_code=400)
    profile = get_profile(user_id)
    queue = profile.get("proactive_queue", [])
    queue.append({
        "id":         str(uuid.uuid4())[:8],
        "type":       "admin_manual",
        "text":       message,
        "created_at": datetime.utcnow().isoformat(),
    })
    if len(queue) > 10:
        queue = queue[-10:]
    profile["proactive_queue"] = queue
    save_profile(user_id, profile)
    print(f"[HERALD] /admin/proactive: manual message queued for {user_id}: {message[:60]}")
    return {"ok": True, "user_id": user_id, "queued": message}


@app.get("/admin/waitlist")
async def admin_waitlist(secret: str = ""):
    """v8.55: Return full waitlist table."""
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    try:
        conn = _db_conn()
        c = conn.cursor()
        c.execute("SELECT id, email, source, created_at FROM waitlist ORDER BY created_at DESC")
        rows = [{"id": r[0], "email": r[1], "source": r[2], "created_at": r[3]} for r in c.fetchall()]
        conn.close()
        return {"ok": True, "count": len(rows), "entries": rows}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/admin/mark_profile")
async def admin_mark_profile(request: Request):
    """
    v8.56: Set safe profile flags for any user.
    Replaces the limited clear_profile_field for positive flag setting.
    Supports: is_beta, is_test, free_days_earned, trial_days.
    Auth: requires WEBHOOK_SECRET.
    """
    data = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    user_id = data.get("user_id", "").strip()
    if not user_id:
        return JSONResponse({"error": "user_id required"}, status_code=400)

    SETTABLE = {"is_beta", "is_test", "free_days_earned", "trial_days"}
    updates = {k: v for k, v in data.items() if k in SETTABLE}
    if not updates:
        return JSONResponse(
            {"error": f"no settable fields found -- allowed: {SETTABLE}"},
            status_code=400
        )

    profile = get_profile(user_id)
    profile.update(updates)
    save_profile(user_id, profile)
    print(f"[HERALD] /admin/mark_profile: {user_id} updated: {updates}")
    return {"ok": True, "user_id": user_id, "updated": updates}


@app.post("/admin/purge_ghost_queues")
async def admin_purge_ghost_queues(request: Request):
    """
    v8.56: Clear proactive queues on ghost/inactive profiles.
    Ghost = _msg_count < 10 AND no message in last 7 days.
    Never touches owner or beta profiles. Non-destructive to real users.
    Auth: requires WEBHOOK_SECRET.
    """
    data = await request.json()
    secret = data.get("secret", "")
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)

    cutoff = (datetime.now() - timedelta(days=7)).isoformat()
    purged = 0
    skipped = 0
    total_cleared = 0

    for uid, profile in user_profiles.items():
        # Never touch real users
        if profile.get("is_owner") or profile.get("is_beta"):
            skipped += 1
            continue
        msg_count = profile.get("_msg_count", 0)
        last_msg  = profile.get("_last_message_at", "")
        is_ghost  = msg_count < 10 or (last_msg and last_msg < cutoff) or not last_msg

        if is_ghost and profile.get("proactive_queue"):
            cleared = len(profile["proactive_queue"])
            profile["proactive_queue"] = []
            save_profile_async(uid, profile)
            total_cleared += cleared
            purged += 1
            print(f"[HERALD] purge_ghost_queues: cleared {cleared} entries for {uid} (msgs={msg_count})")

    print(f"[HERALD] purge_ghost_queues: purged {purged} profiles, cleared {total_cleared} queue entries, skipped {skipped} real users")
    return {
        "ok": True,
        "purged_profiles": purged,
        "total_entries_cleared": total_cleared,
        "skipped_real_users": skipped,
    }

@app.get("/admin/find_user")
async def admin_find_user(secret: str, name: str = ""):
    if not WEBHOOK_SECRET or secret != WEBHOOK_SECRET:
        return JSONResponse({"error": "unauthorized"}, status_code=403)
    results = []
    for uid, profile in user_profiles.items():
        profile_name = profile.get("name", "").lower()
        if not name or name.lower() in profile_name:
            results.append({
                "user_id": uid,
                "name": profile.get("name", ""),
                "ai_name": profile.get("ai_name", ""),
                "confirmed_city": profile.get("confirmed_city", ""),
            })
    return {"count": len(results), "users": results}

@app.on_event("startup")
def startup():
    init_db()
    load_profiles()
    load_invites()
    scheduler = BackgroundScheduler(timezone="America/New_York")

    # Morning briefing -- 7am ET daily
    scheduler.add_job(morning_briefing_job, "cron", hour=7, minute=0, id="morning_briefing")

    # v8.8: Afternoon check-in -- 2pm ET daily
    scheduler.add_job(afternoon_checkin_job, "cron", hour=14, minute=0, id="afternoon_checkin")

    # v8.8: Evening medication prompt -- 7pm ET daily
    scheduler.add_job(evening_medication_job, "cron", hour=19, minute=0, id="evening_medication")

    scheduler.start()

    print(f"[HERALD] Schedulers started:")
    print(f"[HERALD]   morning_briefing  -> 7:00am ET daily")
    print(f"[HERALD]   afternoon_checkin -> 2:00pm ET daily (v8.8)")
    print(f"[HERALD]   evening_medication -> 7:00pm ET daily (v8.8)")
    print(f"[HERALD API v8.60] Places response: spoken format -- no numbered lists")
    print(f"[HERALD API v8.60] Brave date injection: _localize_query appends date on recency signals")
    print(f"[HERALD API] FIX v8.11: MAPS tag always includes city -- no more 1500-mile directions")
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
    print(f"[HERALD API] FIX v8.8: GPS city caching -- confirmed_city in profile, 20mi tolerance")
    print(f"[HERALD API] FIX v8.8: Memory rules -- no 'I remember', no raw GPS coords spoken")
    print(f"[HERALD API] FIX v8.8: Seed question for new users -- makes first session feel alive")
    print(f"[HERALD API] NEW  v8.8: afternoon_checkin_job -- 2pm ET daily")
    print(f"[HERALD API] NEW  v8.8: evening_medication_job -- 7pm ET, medication users only")


if __name__ == "__main__":
    uvicorn.run("herald_api:app", host="0.0.0.0", port=PORT, reload=False)