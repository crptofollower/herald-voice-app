# herald_api.py
# Herald PWA Backend -- Railway Cloud Server
# v6.1 -- Commodity price fix (silver/gold/oil/etc) + TICKER_STOP_WORDS
#          Fallback /ask timeout fix (20s AbortController in frontend)
# v6.0 -- Streaming SSE / Brave Search / Yahoo Finance / Response Cache /
#          Voice-Optimized Prompts / Morning Greeting / Explicit Memory Endpoint

import os, json, re, random, string, time, http.client, ssl
import urllib.request, urllib.error, urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT           = int(os.environ.get("PORT", 8080))
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENAI_KEY     = os.environ.get("OPENAI_API_KEY", "")
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
OR_URL         = "https://openrouter.ai/api/v1/chat/completions"
VM_WEBHOOK_URL = "http://143.198.18.66:8082/webhook/sync"
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
TTS_URL        = "https://api.openai.com/v1/audio/speech"
EMPIRE_URL     = "https://raw.githubusercontent.com/crptofollower/herald-voice-app/main/empire_status.json"
PROFILES_FILE  = os.environ.get("PROFILES_FILE", "/data/profiles.json")
INVITES_FILE   = os.environ.get("INVITES_FILE",  "/data/invites.json")

MODEL_SEARCH = "anthropic/claude-haiku-4-5:online"
MODEL_FAST   = "anthropic/claude-haiku-4-5"

# ── COMMODITY MAP (v6.1) ──────────────────────────────────────────────────────
# Maps plain English commodity names to Yahoo Finance futures tickers.
# Checked BEFORE stock extraction so "silver" never hits extract_stock_symbol().
COMMODITY_MAP = {
    'silver':       'SI=F',
    'gold':         'GC=F',
    'oil':          'CL=F',
    'crude oil':    'CL=F',
    'crude':        'CL=F',
    'natural gas':  'NG=F',
    'copper':       'HG=F',
    'platinum':     'PL=F',
    'palladium':    'PA=F',
    'wheat':        'ZW=F',
    'corn':         'ZC=F',
    'soybeans':     'ZS=F',
    'soybean':      'ZS=F',
}

# ── TICKER STOP WORDS (v6.1) ──────────────────────────────────────────────────
# Common English words that are 2-5 letters and would otherwise match the
# "scan all words" fallback in extract_stock_symbol().
# "What IS THE price of silver" → "IS", "THE" must be blocked.
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
    # Finance words that look like tickers
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
        "memories": [],
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
    memories = profile.get("memories", [])
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
    all_notes = list(dict.fromkeys((memories + notes)[-6:]))
    if all_notes: parts.append(f"Things you've told me: {'; '.join(all_notes)}.")
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAPI/6.1"})
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
            "User-Agent": "HeraldAI/6.1"
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read().decode())
        if d.get("Response") == "False":
            url2 = f"https://www.omdbapi.com/?s={encoded}&apikey={OMDB_KEY}"
            req2 = urllib.request.Request(url2, headers={"User-Agent": "HeraldAI/6.1"})
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


# ── COMMODITY FUNCTIONS (v6.1) ────────────────────────────────────────────────

def detect_commodity(message):
    """
    Returns the Yahoo futures ticker (e.g. 'SI=F') if the message contains
    a commodity name, else None. Checks multi-word names first.
    """
    msg_lower = message.lower()
    # Sort by length descending so "crude oil" matches before "oil"
    for name in sorted(COMMODITY_MAP.keys(), key=len, reverse=True):
        if name in msg_lower:
            return COMMODITY_MAP[name]
    return None

def fetch_commodity_price(ticker, display_name):
    """Fetch commodity futures price from Yahoo Finance (free, no key)."""
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


# ── STOCK SYMBOL EXTRACTION (v6.1 -- stop words + commodity guard) ────────────

def extract_stock_symbol(message):
    """
    Returns a stock ticker string or None.

    v6.1 changes:
    1. Returns None immediately if the message is a commodity query.
       Prevents 'silver' -> scans words -> grabs 'THE' -> $0 price.
    2. The free-form word scan now only matches words the USER typed in
       ALL-CAPS (e.g. 'What is AAPL doing') and never common English words
       (blocked via TICKER_STOP_WORDS).
    """
    # Guard: commodity queries should never reach stock lookup
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

    # Only match words the user typed in ALL-CAPS (e.g. "AAPL", "NVDA")
    # Never match sentence words like THE, IS, OF, FOR — those are stop words.
    words = message.split()
    for w in words:
        # Strip punctuation, keep only letters
        clean = re.sub(r'[^A-Za-z]', '', w)
        if not clean:
            continue
        up = clean.upper()
        # Must be 2-5 chars, all alpha, typed as ALL-CAPS by the user, not a stop word
        if (2 <= len(up) <= 5
                and up.isalpha()
                and clean == clean.upper()   # user typed it in caps
                and up not in TICKER_STOP_WORDS):
            return up

    return None

def fetch_yahoo_stock(symbol):
    """Primary stock source -- Yahoo Finance (free, no key)."""
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
    """Yahoo Finance first (free), Alpha Vantage as backup."""
    result = fetch_yahoo_stock(symbol)
    if result:
        return result
    if not ALPHA_KEY:
        return None
    try:
        url = (f"https://www.alphavantage.co/query?function=GLOBAL_QUOTE"
               f"&symbol={symbol.upper()}&apikey={ALPHA_KEY}")
        req = urllib.request.Request(url, headers={"User-Agent": "HeraldAI/6.1"})
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
    context_parts = [p for p in [notes_line, prefs_line] if p]
    context_block = "\n".join(context_parts) if context_parts else "Still learning about this user."
    empire_section = f"\n\n{empire}" if owner and empire else ""

    return f"""You are {ai_name} -- a trusted personal AI companion.

{user_line}
{loc_line}
{context_block}

Current time: {now}{empire_section}

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
  These phrases are BANNED. You have the user's profile, memories, and notes — use them.
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
- Write temperatures in words: say "eighty-five degrees" not "85 degrees F" or "85 degrees"
- Write stock prices in words: say "one hundred forty two dollars" not "$142.00"
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
  Example: "Want me to open Maps?" or "Should I pull that up on Spotify?" One question only.
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
        return "I ran into a snag on that one, try asking me again in a moment."
    except Exception:
        return "I did not get a response in time, try again in a second."

def call_openrouter_with_search(messages, query):
    if BRAVE_KEY:
        search_ctx = fetch_brave_search(query)
        if search_ctx:
            augmented = messages.copy()
            augmented[-1] = {
                "role": "user",
                "content": f"{query}\n\n[Live web search results:\n{search_ctx}]"
            }
            result = call_openrouter(augmented, use_search=False)
            return result, False
    return call_openrouter(messages, use_search=True), True

def stream_from_openrouter(messages, use_search=True):
    if not OPENROUTER_KEY:
        yield "Configuration error: API key not set."
        return
    model   = MODEL_SEARCH if use_search else MODEL_FAST
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
    """
    Try to answer without hitting the LLM.
    Returns (reply_str, used_search_bool) or (None, None).

    v6.1: COMMODITY block added BEFORE stock block.
    """
    message   = ctx["message"]
    msg_lower = ctx["msg_lower"]
    profile   = ctx["profile"]
    owner     = ctx["owner"]
    empire    = ctx["empire"]

    # FORGE-002: on-demand sync
    SYNC_TRIGGERS = ['sync', 'refresh', 'update freddie', 'sync empire', 'refresh data']
    if owner and any(t in msg_lower for t in SYNC_TRIGGERS):
        try:
            payload = json.dumps({"secret": WEBHOOK_SECRET}).encode("utf-8")
            req = urllib.request.Request(VM_WEBHOOK_URL, data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/6.1"},
                method="POST")
            with urllib.request.urlopen(req, timeout=35) as r:
                result = json.loads(r.read().decode())
            return ("Done. Just pulled a fresh snapshot from Freddie. What do you want to know?"
                    if result.get("ok") else "Sync ran but something went wrong on the VM."), False
        except Exception:
            return "Could not reach the VM right now. Try again in a second.", False

    # Freddie queries
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
        return call_openrouter(freddie_prompt, use_search=False), False

    # Weather
    if any(w in msg_lower for w in ['weather','forecast','temperature','rain','snow',
                                     'wind','sunny','humid','hot outside','cold outside','umbrella']):
        loc = extract_weather_location(message, profile.get('location','Dallas TX'))
        cached = cache_get(f'weather:{loc}', 'weather')
        if cached:
            return cached, False
        result = fetch_weather_direct(loc) or fetch_weather_backup(loc)
        cache_set(f'weather:{loc}', result, 'weather')
        return result, False

    # Sports
    if any(w in msg_lower for w in ['score','scores','game today','cowboys','rangers',
                                     'mavs','mavericks','stars','nfl','nba','mlb','nhl',
                                     'playoffs','standings']):
        return fetch_sports_direct(msg_lower), False

    # Crypto
    if any(w in msg_lower for w in ['bitcoin','ethereum','solana','crypto','btc','eth',
                                     'sol price','crypto price']):
        cached = cache_get('crypto', 'crypto')
        if cached:
            return cached, False
        result = fetch_crypto_direct()
        cache_set('crypto', result, 'crypto')
        return result, False

    # News
    if any(w in msg_lower for w in ['news','headlines','top stories',
                                     'what is happening','what happened today']):
        cached = cache_get('news_top', 'news')
        if cached:
            return cached, False
        result = fetch_news_direct()
        cache_set('news_top', result, 'news')
        return result, False

    # Movies
    if any(w in msg_lower for w in ['movie','film','imdb','rotten tomatoes','what to watch','watch tonight']):
        for kw in ['about ','review of ','tell me about ']:
            if kw in msg_lower:
                idx = msg_lower.index(kw) + len(kw)
                query = message[idx:].strip().rstrip('?.,!')
                if query:
                    return fetch_movie_direct(query), False

    # ── COMMODITIES (v6.1 -- checked BEFORE stocks) ───────────────────────────
    # Must come before the stock block so "price of silver" never hits
    # extract_stock_symbol() and accidentally returns "THE" or similar.
    commodity_ticker = detect_commodity(message)
    if commodity_ticker:
        # Find the display name (longest matching key for this ticker)
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

    # Stocks
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
            self._json({
                "status": "ok", "server": "herald-api", "version": "6.1",
                "streaming": "enabled (/ask/stream)",
                "search": f"brave={'configured' if BRAVE_KEY else 'NOT SET'} | fallback=haiku:online",
                "cache": f"{len(_cache)} entries active",
                "apis": {
                    "weather":     "wttr.in (free) + weatherapi backup",
                    "sports":      "ESPN (free, no key)",
                    "crypto":      "CoinGecko (free, no key)",
                    "stocks":      "Yahoo Finance (free) + Alpha Vantage backup",
                    "commodities": "Yahoo Finance futures (free, no key) -- v6.1",
                    "news":        "GNews" if GNEWS_KEY else "not configured",
                    "news_bak":    "NewsData" if NEWSDATA_KEY else "not configured",
                    "movies":      "OMDb" if OMDB_KEY else "not configured",
                    "geocoding":   "Google" if GEOCODING_KEY else "not configured",
                    "tts":         "OpenAI nova" if OPENAI_KEY else "not configured",
                    "sync":        "VM webhook" if WEBHOOK_SECRET else "WEBHOOK_SECRET not set",
                },
                "time": datetime.now().isoformat()
            })

        elif self.path.startswith("/geocode"):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            lat = params.get("lat", [None])[0]
            lng = params.get("lng", [None])[0]
            if not lat or not lng:
                self._json({"label": None, "error": "lat and lng required"}, 400)
                return
            label = geocode_reverse(lat, lng)
            self._json({"label": label})

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

        # ── AUTH ──────────────────────────────────────────────────────────────
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

        # ── ASK (standard) ────────────────────────────────────────────────────
        elif self.path == "/ask":
            ctx, err = build_ask_context(data)
            if err:
                self._json({"error": err}, 400)
                return

            profile  = ctx["profile"]
            messages = ctx["messages"]
            message  = ctx["message"]

            if is_about_me_query(message):
                reply = build_about_me(profile)
                trial = get_trial_status(profile)
                self._json({
                    "reply": reply, "action": None,
                    "ai_name": profile.get("ai_name", "Herald"),
                    "name": profile.get("name", ""),
                    "used_search": False, **_trial_fields(trial)
                })
                return

            direct_reply, _ = get_direct_reply(ctx)
            if direct_reply:
                reply, action = parse_action(direct_reply)
                trial = get_trial_status(profile)
                self._json({
                    "reply": reply, "action": action,
                    "ai_name": profile.get("ai_name", "Herald"),
                    "name": profile.get("name", ""),
                    "used_search": False, **_trial_fields(trial)
                })
                return

            use_search = needs_web_search(message)
            if use_search:
                raw_reply, _ = call_openrouter_with_search(messages, message)
            else:
                raw_reply = call_openrouter(messages, use_search=False)

            reply, action = parse_action(raw_reply)
            trial = get_trial_status(profile)
            self._json({
                "reply": reply, "action": action,
                "ai_name": profile.get("ai_name", "Herald"),
                "name": profile.get("name", ""),
                "used_search": use_search, **_trial_fields(trial)
            })

        # ── ASK/STREAM ────────────────────────────────────────────────────────
        elif self.path == "/ask/stream":
            ctx, err = build_ask_context(data)
            if err:
                self._json({"error": err}, 400)
                return

            profile  = ctx["profile"]
            messages = ctx["messages"]
            message  = ctx["message"]

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.cors()
            self.end_headers()

            def sse(obj):
                try:
                    self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass

            trial = get_trial_status(profile)
            base_done = {
                "done": True,
                "ai_name": profile.get("ai_name", "Herald"),
                "name":    profile.get("name", ""),
                **_trial_fields(trial)
            }

            if is_about_me_query(message):
                reply = build_about_me(profile)
                sse({"t": reply})
                sse({**base_done, "full": reply, "action": None, "used_search": False})
                return

            direct_reply, _ = get_direct_reply(ctx)
            if direct_reply:
                reply, action = parse_action(direct_reply)
                sse({"t": reply})
                sse({**base_done, "full": reply, "action": action, "used_search": False})
                return

            use_search = needs_web_search(message)
            full_text  = ""

            try:
                if use_search and BRAVE_KEY:
                    search_ctx = fetch_brave_search(message)
                    if search_ctx:
                        augmented = messages.copy()
                        augmented[-1] = {
                            "role": "user",
                            "content": f"{message}\n\n[Live web search results:\n{search_ctx}]"
                        }
                        for token in stream_from_openrouter(augmented, use_search=False):
                            full_text += token
                            sse({"t": token})
                    else:
                        for token in stream_from_openrouter(messages, use_search=True):
                            full_text += token
                            sse({"t": token})
                elif use_search:
                    for token in stream_from_openrouter(messages, use_search=True):
                        full_text += token
                        sse({"t": token})
                else:
                    for token in stream_from_openrouter(messages, use_search=False):
                        full_text += token
                        sse({"t": token})

                reply, action = parse_action(full_text)
                sse({**base_done, "full": reply, "action": action, "used_search": use_search})

            except Exception as e:
                print(f"[HERALD] /ask/stream error: {e}")
                sse({"error": "Stream interrupted. Try again."})

        # ── GREETING ──────────────────────────────────────────────────────────
        elif self.path == "/greeting":
            user_id        = data.get("user_id", "").strip()
            local_time     = data.get("local_time", "")
            lat            = data.get("lat", None)
            lng            = data.get("lng", None)
            location_label = data.get("location_label", None)

            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return

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
            location = location_label or profile.get("location", "")
            weather_line = ""
            if location:
                cached = cache_get(f'weather:{location}', 'weather')
                weather = cached or fetch_weather_direct(location)
                if weather and not cached:
                    cache_set(f'weather:{location}', weather, 'weather')
                if weather:
                    first = weather.split('.')[0].strip()
                    weather_line = f" {first}."

            memories = profile.get("memories", [])
            notes    = profile.get("notes", [])
            all_notes = (memories + notes)[-5:]
            memory_hook = ""
            if all_notes:
                memory_hook = f" You mentioned {all_notes[-1]}."

            greeting = f"{salutation}{name_part}.{weather_line}{memory_hook} What can I help you with today?"

            self._json({
                "ok": True,
                "greeting": greeting,
                "ai_name": ai_name,
                "name": name,
            })

        # ── MEMORY ────────────────────────────────────────────────────────────
        elif self.path == "/memory":
            user_id = data.get("user_id", "").strip()
            message = data.get("message", "").strip()
            fact    = data.get("fact", "").strip()

            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return

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
                    name = profile.get("name", "")
                    confirm = f"Got it{', ' + name if name else ''}. I will remember that."
                    self._json({"ok": True, "fact": fact, "confirm": confirm})
                else:
                    self._json({"ok": True, "fact": fact, "confirm": "Already have that noted."})
            else:
                self._json({"error": "No fact to remember"}, 400)

        # ── TTS ───────────────────────────────────────────────────────────────
        elif self.path == "/tts":
            text = data.get("text", "").strip()
            if not text:
                self._json({"error": "text required"}, 400)
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

        # ── PROFILE ───────────────────────────────────────────────────────────
        elif self.path == "/profile":
            user_id = data.get("user_id", "").strip()
            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return
            profile = get_profile(user_id)
            for field in ["name", "ai_name", "location", "app_prefs"]:
                if field in data:
                    profile[field] = data[field]
            save_profile(user_id, profile)
            self._json({"ok": True, "profile": profile})

        # ── INVITE CREATE ─────────────────────────────────────────────────────
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
            self._json({"ok": True, "code": code, "label": label,
                        "link": f"{base_url}?invite={code}"})

        # ── INVITE LIST ───────────────────────────────────────────────────────
        elif self.path == "/invite/list":
            secret = data.get("secret", "").strip()
            if not INVITE_SECRET or secret != INVITE_SECRET:
                self._json({"error": "unauthorized"}, 401)
                return
            invite_list = sorted(invites.values(), key=lambda x: x.get("created_at",""), reverse=True)
            self._json({"ok": True, "invites": invite_list, "total": len(invite_list)})

        # ── SYNC ──────────────────────────────────────────────────────────────
        elif self.path == "/sync":
            user_id   = data.get("user_id", "").strip()
            auth_code = data.get("auth_code", "").strip()
            if not user_id:
                self._json({"error": "user_id required"}, 400)
                return
            if not is_owner(user_id, auth_code):
                self._json({"error": "owner only"}, 401)
                return
            try:
                payload = json.dumps({"secret": WEBHOOK_SECRET}).encode("utf-8")
                req = urllib.request.Request(VM_WEBHOOK_URL, data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": "HeraldAPI/6.1"},
                    method="POST")
                with urllib.request.urlopen(req, timeout=35) as r:
                    result = json.loads(r.read().decode())
                self._json({
                    "ok":           result.get("ok", False),
                    "triggered_at": result.get("triggered_at", ""),
                    "message":      "Sync complete" if result.get("ok") else "Sync failed",
                })
            except Exception as e:
                self._json({"ok": False, "error": f"VM unreachable: {str(e)[:100]}"}, 503)

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


def _trial_fields(trial):
    return {
        "trial_status":         trial["status"],
        "trial_days_remaining": trial["days_remaining"],
        "trial_show_wall":      trial["show_wall"],
        "trial_show_warning":   trial.get("show_warning", False),
        "trial_message":        trial.get("message"),
    }


if __name__ == "__main__":
    load_profiles()
    load_invites()
    print(f"[HERALD API v6.1] Starting on port {PORT}")
    print(f"[HERALD API] OpenRouter:    {'YES' if OPENROUTER_KEY else 'MISSING -- required'}")
    print(f"[HERALD API] Brave Search:  {'YES' if BRAVE_KEY else 'NOT SET -- add BRAVE_SEARCH_KEY'}")
    print(f"[HERALD API] OpenAI TTS:    {'YES' if OPENAI_KEY else 'not set'}")
    print(f"[HERALD API] Geocoding:     {'YES' if GEOCODING_KEY else 'not set'}")
    print(f"[HERALD API] GNews:         {'YES' if GNEWS_KEY else 'not set'}")
    print(f"[HERALD API] OMDb:          {'YES' if OMDB_KEY else 'not set'}")
    print(f"[HERALD API] AlphaVantage:  {'YES (backup only)' if ALPHA_KEY else 'not set'}")
    print(f"[HERALD API] NewsData:      {'YES' if NEWSDATA_KEY else 'not set'}")
    print(f"[HERALD API] WeatherAPI:    {'YES (backup)' if WEATHER_KEY else 'not set'}")
    print(f"[HERALD API] Commodities:   Yahoo Finance futures -- silver/gold/oil/gas/copper (v6.1)")
    print(f"[HERALD API] Profiles:      {PROFILES_FILE}")
    print(f"[HERALD API] Owner code:    {'SET' if OWNER_CODE else 'NOT SET'}")
    print(f"[HERALD API] Invite secret: {'SET' if INVITE_SECRET else 'NOT SET'}")
    print(f"[HERALD API] Webhook:       {'SET' if WEBHOOK_SECRET else 'NOT SET'}")
    print(f"[HERALD API] Streaming:     /ask/stream (SSE) -- LIVE")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
