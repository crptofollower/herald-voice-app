================================================================================
HERALD CURRENT STATE
Last updated: May 25, 2026 -- Session O complete
================================================================================

PURPOSE:
  Living operational document for Herald build track.
  Read this FIRST at the start of every session.
  Update this LAST at the end of every session.
  This document is the ONLY source of truth.

⚠️  TWO SEPARATE FOLDERS -- NEVER MIX THEM:

  herald-voice-app\  → BACKEND ONLY (Railway auto-deploys on git push)
                       Branch: main
                       Commands: git add / git commit / git push
                       NEVER run: npx expo start here

  herald-app\        → EXPO APP ONLY (runs on phone via EAS APK)
                       Branch: master
                       Commands: npx expo start --clear
                       NEVER run: git push to Railway from here

⚠️  BRANCH RULE -- CRITICAL:
  git checkout master  →  Expo app (app.json, App.tsx, src/)
  git checkout main    →  Backend (herald_api.py, index.html)
  How to tell which you're in:
    dir app.json       →  shows up = Expo (master)
    dir herald_api.py  →  shows up = Backend (main)

================================================================================
SECTION 0 -- START HERE (Session P)
================================================================================

BACKEND:  v8.32 live on Railway ✅

BUILD 4:  cb3eea5f in queue -- has all Session O fixes + Session R persona work
          Commit: 1f0e2c01 (master pushed May 25, 2026)
          Logs: https://expo.dev/accounts/apexempires-organization/projects/herald/builds/cb3eea5f-f00e-40d1-b223-01ec33f91905

FIRST THING SESSION P:
  1. Health check → confirm v8.32:
     Invoke-RestMethod https://web-production-b4083.up.railway.app/health
     Expected: {"version":"8.32",...}

  2. Check build cb3eea5f on expo.dev:
     npx eas build:list --limit 1
     Wait for status: finished

  3. Wipe S24+ → install Build 4 → test onboarding fresh:
     Settings → Apps → Herald → Storage → Clear Data
     Install APK from expo.dev artifact URL

  4. Test sequence on S24+:
     a. Onboarding runs fresh (not skipped)
     b. Persona picker -- "Pick your look", palette dots, scale animation, teal Continue
     c. Confirm flash -- AI name cinematic, tap-to-skip, auto-advance to Chat
     d. "What time is it" -- under 2 seconds total
     e. Offline mode -- airplane mode, personal/calendar queries still answer locally

  5. If all pass → send Mickey (see Section 4)

MICKEY:  Needs clean wipe + new build. Do NOT send until S24+ passes.

IGNORE THESE BUILDS (duplicates on old commit b1cc6a17):
  b6d64bc2-9672-4dda-a73b-3c3b5995cd2f  -- duplicate, ignore
  e6cf7cfe-4dcc-4a5b-8338-e2d426d61330  -- duplicate, ignore
  USE cb3eea5f ONLY.

================================================================================
SECTION 1 -- WHAT IS LIVE
================================================================================

BACKEND: herald_api.py v8.32 -- LIVE on Railway
  URL:    https://web-production-b4083.up.railway.app
  Repo:   github.com/crptofollower/herald-voice-app (main branch)

  COMPLETE BACKEND FEATURE LIST (cumulative through v8.32):

  CORE INTELLIGENCE:
    ✅ Dynamic memory weighting -- medical(10) always beats food(3)
    ✅ Medical intake state machine -- detect, start, advance, write SQLite
    ✅ _build_medical_context() -- medical data in every system prompt
    ✅ Briefing preference system -- "don't mention meds", "keep it short"
    ✅ Emergency contact detection
    ✅ Watch acceptance handler -- "yes" stores watch
    ✅ Learning throttle -- extract facts every 3rd message only

  PERFORMANCE -- FAST PATHS:
    ✅ save_profile_async -- profile saves run in background thread
    ✅ Single SQLite connection in build_system (was 4)
    ✅ LIVE_KEYWORDS tightened -- casual chat no longer triggers search
    ✅ Calendar queries in FAST_OVERRIDES -- bypass search entirely
    ✅ Calendar cache -- 5 min TTL per user
    ✅ SSE streaming -- pads every token past Railway 4KB buffer
    ✅ TYPING EVENT FIRST -- fires before build_ask_context blocks
    ✅ SONNET_SIGNALS tightened -- simple queries stay on Haiku
    ✅ FAST_OVERRIDES expanded to 90+ phrases
    ✅ Calendar / time / alarm PRE-CHECK -- bypass build_ask_context entirely
    ✅ Google Places fast path -- Nearby Search, top 3, 5km radius

  v8.25 -- Alarm fast path + system prompt hardening
  v8.26 -- Admin tooling (/admin/find_user)
  v8.27 -- Calendar direct reply in get_direct_reply()
  v8.28 -- PRE-CHECK system (calendar/time before build_ask_context)
  v8.29 -- Alarm pre-check server-side
  v8.30 -- ABSOLUTE RULE:
    ✅ System prompt hardening -- Herald never exposes internals, never blames developer
    ✅ Absolute time/date discipline in responses where applicable
  v8.31 -- Personality / trust / crisis:
    ✅ Trust level system live in system prompt
    ✅ Crisis detection and appropriate response routing
    ✅ Personality layer -- Herald speaks as companion not chatbot
  v8.32 -- No support-team deflection:
    ✅ Herald never deflects to "contact support" or "support team"
    ✅ Owns the answer or says what it can do -- no handoff language

  SCHEDULERS:
    ✅ 7:00am ET -- morning_briefing_job
    ✅ 2:00pm ET -- afternoon_checkin_job
    ✅ 7:00pm ET -- evening_medication_job

  ADMIN ENDPOINTS:
    ✅ POST /admin/clear_profile_field
    ✅ GET  /admin/find_user

  KNOWN BACKEND ISSUES:
    ❌ Medical context still uses relative dates in some paths ("today" vs "May 15")
    ❌ Version string drift pattern -- always bump header + FastAPI + /health on edit

APP: master branch -- Build 4 (cb3eea5f) when it lands
  Commit: 1f0e2c01
  Branch: master (Expo project)
  EAS profile: preview (APK, internal distribution)

  WHAT BUILD 4 CONTAINS (Session O fixes + Session R persona work):

  SESSION O -- STABILITY + PERFORMANCE:
    ✅ ON_DEVICE_TTS flag -- expo-speech primary, Nova path preserved (fa07fcb5)
    ✅ expo-speech sentence queue -- drainExpoQueue prevents TTS overlap (0797cb96)
    ✅ expo-speech-recognition in package.json -- on-device STT (93c33368)
    ✅ Onboarding fix -- setOnboardingComplete guarded userId + name (339d2e91)
    ✅ Migration v8_17_force_onboarding_reset -- reset when aiName/name still defaults (b1cc6a17)
    ✅ Offline mode -- expo-network check, on-device calendar + memory fallback (372bceb2)
    ✅ Geocode timeout + on-device calendar today/tomorrow/week (f6f761d6)
    ✅ saveDeviceMemory on stream done
    ✅ Stream stuck state -- abort on background, 60s max, reset on unmount (c654fda4)
    ✅ streamAbortRef maxTimer syntax fix (ece92600)
    ✅ PERSONAS crash guard + idle resume duplicate greeting blocked (8a5303a9)
    ✅ liveGreetingAddedRef guard + hands-free useEffect deps (2ef199bc)
    ✅ KITT interceptor (localAnswers.ts) -- personal queries from device SQLite
    ✅ Deep link library (45+ apps)
    ✅ Gradient persona backgrounds (PersonaBackground.tsx)
    ✅ Device SQLite (useDeviceMemory) + local medical reads

  SESSION R -- PERSONA SYSTEM (design handoff shipped):
    ✅ Persona token adoption -- accent, surfaceTint, palette, description, BRAND, getPersona (4c2d21a8)
    ✅ Source Serif 4 + Inter via @expo-google-fonts at startup (46cda3d3)
    ✅ Persona picker UI upgrade -- surfaceTint gradient, palette dots, scale animation (c325273a)
    ✅ PersonaConfirmScreen -- cinematic flash after persona pick (1f0e2c01)
    ✅ personaImages.ts -- shared PERSONA_IMAGES constants
    ✅ Onboarding flow: persona → confirm flash → handleFinish → Chat

  DESIGN HANDOFF REFERENCE (not runtime, in repo):
    design_handoff_persona_system/ -- README, personas.ts, tokens.css, prototype

  NOT IN BUILD 4 (Session P+):
    ❌ Lock screen notification styling (Screen 4 handoff)
    ❌ Home widget + themed app icon (Screen 3 -- deferred Session R native)
    ❌ Per-persona Android app icon aliases
    ❌ "Use your own photo" persona tile (out of scope)

================================================================================
SECTION 2 -- SESSION O SUMMARY (May 25, 2026)
================================================================================

FULL DAY SESSION. Largest combined backend + app + design session since Session N.

WHAT WAS DIAGNOSED:
  Onboarding still skipping on some fresh installs -- AsyncStorage herald-store-v3 persists
  aiName/name default "Herald" treated as completed onboarding
  Stream hang after background -- abort ref and max timer needed
  TTS overlap on streaming responses -- expo-speech queue not draining
  Duplicate greeting on app resume
  Offline gap -- network fail had no warm fallback message
  Calendar "next two weeks" not intercepted locally -- falls to network
  Alarm action card "something went wrong" -- Linking URL audit needed
  Dead store fields: voiceEnabled, ttsEnabled, isMuted, Freddie status -- wired nowhere
  expo-audio plugin in app.json may be redundant post-SDK 54 migration
  Three duplicate EAS builds submitted on same old commit -- waste of build quota

WHAT WAS SHIPPED -- BACKEND (herald-voice-app main):
  ✅ v8.30 -- ABSOLUTE RULE system prompt hardening
  ✅ v8.31 -- Personality / trust level / crisis handling
  ✅ v8.32 -- No support-team deflection rule
  ✅ All live on Railway -- verify /health shows 8.32

WHAT WAS SHIPPED -- APP (herald-app master):
  ✅ ON_DEVICE_TTS + offline mode + stream fixes (Session O core)
  ✅ Migration v8_17_force_onboarding_reset
  ✅ Full Session R persona pipeline:
     tokens → fonts → picker UI → PersonaConfirmScreen → shared personaImages
  ✅ master pushed to origin (1f0e2c01)
  ✅ Build 4 submitted: cb3eea5f-f00e-40d1-b223-01ec33f91905

WHAT SESSION R DELIVERED:
  ✅ Screen 1 -- Persona Picker upgrade (handoff fidelity)
  ✅ Screen 2 -- Confirmation Flash (PersonaConfirmScreen)
  ⏭ Screen 3 -- Home widget + themed icon (deferred -- OS surfaces)
  ⏭ Screen 4 -- Lock screen notification styling (deferred)

NOT DONE YET (Session P):
  ❌ S24+ test of Build 4 (cb3eea5f)
  ❌ Send Mickey new build after S24+ passes
  ❌ Wire or remove dead store fields (voiceEnabled, ttsEnabled, isMuted, Freddie status)
  ❌ expo-audio plugin cleanup in app.json
  ❌ Calendar "next two weeks" pattern not intercepted (falls to network)
  ❌ Alarm "something went wrong" error on action card -- needs Linking URL audit
  ❌ Identity layer (email anchor) -- Session T
  ❌ Proactive triggers -- Session S

================================================================================
SECTION 3 -- ROADMAP (updated May 25, 2026)
================================================================================

  K  ✅ DONE  Hotfix + Mickey APK + v8.14 backend
  L  ✅ DONE  Device SQLite + instant greeting + anonymous token foundation
  M  ✅ DONE  Cursor audit + 7 performance fixes + calendar + SSE fix
  N  ✅ DONE  Geocoding fix + TTS fix + device_context + greeting rotation
  O  ✅ DONE  v8.30-8.32 backend live
              ON_DEVICE_TTS + offline mode + stream/TTS fixes
              Migration v8_17_force_onboarding_reset
              Build 4 submitted (cb3eea5f)

  P  NEXT     S24+ gate session:
              Test Build 4 fresh install on S24+
              Persona picker + confirm flash + time query + offline mode
              Wire/remove dead store fields
              expo-audio plugin cleanup
              Calendar "next two weeks" local intercept
              Alarm action card Linking audit
              If passes → wipe Mickey device → send Build 4

  R  ✅ DONE  Persona system (design handoff):
              Token adoption, fonts, picker UI, PersonaConfirmScreen
              Screens 3+4 deferred to later native work

  S  UPCOMING Proactive triggers + notification styling (lock screen handoff Screen 4)
              OneSignal push + reminder tier system (Friendly/Standard/Aggressive)
              Medical dates absolute everywhere
              PiP video preview -- YouTube inline

  T  UPCOMING Identity layer (email anchor) + Outlook OAuth (Heather case study)
              Permission learning system -- ask once, remember forever
              Billing architecture foundation

  U  UPCOMING 65+ onboarding polish -- voice-first refinements
              sync-down on login (server → device SQLite)

  V  UPCOMING Referral system + family tier
              Emergency contact, caregiver digest email

  W  FUTURE   On-device LLM -- Phi-3 Mini / Gemma 2B (KITT moment)
              Per-persona Android app icon aliases

  X  FUTURE   iOS build -- MacBook required
              iOS alternate icon mechanism

  Y  FUTURE   Continuous awareness -- wake word, proactive initiation at scale

================================================================================
SECTION 4 -- MICKEY STATUS
================================================================================

  Mickey user_id:  u_8e4abdec3bd7
  Mickey name:       Mick
  Mickey ai_name:    Obi
  Access code:       herald2026
  Mickey URL:        tinyurl.com/Herald-Mickey (update before texting)

  RAILWAY PROFILE:   Clean -- Gobbi gone (confirmed_city/lat/lng wiped Session B)
  CURRENT APK:       Old build -- does NOT have Session O fixes or Session R persona work
  NEEDS:             Clean wipe + Build 4 (cb3eea5f) install

  DO NOT SEND UNTIL:
    Mike's S24+ passes full test sequence (Section 0)
    tinyurl updated to new APK artifact URL

  TEXT TO SEND WHEN READY:
    "New build ready. Same code herald2026.
     Pick your look during setup -- Herald takes its colors from there.
     You'll see [Obi] flash on screen when it's ready.
     Ask Obi what time it is -- should be instant.
     Try airplane mode -- still answers personal stuff.
     Use it a few days. Tell me what Heather needs."

  HEATHER (Gate 3 case study):
    46, brand ambassador. Needs Outlook OAuth (Session T).
    First real non-technical user. Do not pitch until Mickey stable.

================================================================================
SECTION 5 -- PERFORMANCE ARCHITECTURE (updated May 25, 2026)
================================================================================

THE KITT PRINCIPLE:
  Device is the fast lane. Server is the safety net.
  Personal queries should never need the network.

CURRENT ROUND TRIP MODEL:

  WITH ON_DEVICE_TTS = true (SHIPPED Session O):
    Round trip 1: On-device STT (expo-speech-recognition)     ~500ms
    Round trip 2: /ask/stream OR localAnswers interceptor       0-10s
    Round trip 3: LLM (OpenRouter) -- skipped on fast paths     0-8s
    Round trip 4: TTS -- expo-speech on-device (ON_DEVICE_TTS)  ~instant
    "What time is it" target:  <2s total (device local_time + on-device TTS)
    Personal queries target:   <200ms (KITT interceptor, zero network)

  OFFLINE MODE (SHIPPED Session O -- 372bceb2):
    expo-network connectivity check before Railway call
    If offline:
      localAnswers.ts intercepts personal queries from device SQLite
      On-device calendar read for today/tomorrow/week patterns
      Warm fallback message if no local answer:
        "I'm offline right now, but I can still help -- ask me about your
         calendar, schedule, medications, or anything personal."
    Works in airplane mode for intercepted patterns only
    NOT offline: weather, news, search, LLM reasoning

  FAST PATHS (no LLM):
    ✅ "What time is it" -- device local_time
    ✅ "What is my name" -- profile / SQLite
    ✅ Calendar today/tomorrow/week -- device + server pre-check
    ✅ Alarm -- server-side math pre-check
    ✅ KITT interceptor -- medications, medical history, profile
    ❌ "Next two weeks" calendar -- NOT intercepted yet (Session P)

  STILL NETWORK-BOUND:
    Weather, news, sports, markets, Google Places, complex reasoning
    Full LLM stream when localAnswers returns null

NEXT PERFORMANCE WINS:
  Session P: Calendar "next two weeks" local pattern
  Session W: On-device LLM for simple reasoning without network

================================================================================
SECTION 6 -- ADMIN REFERENCE (unchanged)
================================================================================

FIND A USER:
  Invoke-RestMethod "https://web-production-b4083.up.railway.app/admin/find_user?secret=freddie_sync_2026"
  Filter by name: add &name=mickey
  Returns: user_id, name, ai_name, confirmed_city for all profiles

CLEAR A BAD CACHED FIELD:
  Invoke-RestMethod -Method Post `
    -Uri "https://web-production-b4083.up.railway.app/admin/clear_profile_field" `
    -ContentType "application/json" `
    -Body '{"secret":"freddie_sync_2026","user_id":"TARGET_USER_ID","field":"confirmed_city"}'

  Clearable fields: confirmed_city, confirmed_lat, confirmed_lng,
                    location, _briefing_confirm, pending_watch_offer

MICKEY'S PROFILE:
  user_id:        u_8e4abdec3bd7
  name:           Mick
  ai_name:        Obi
  location:       Davenport, FL (fresh geocode on next GPS ping)
  APK version:    old -- awaiting Build 4

WIPE TEST DEVICE (before fresh install testing):
  Settings → Apps → Herald → Storage → Clear Data
  Or: adb shell pm clear com.herald.app (verify package name in android/)

HEALTH CHECK:
  Invoke-RestMethod https://web-production-b4083.up.railway.app/health
  Expected: version 8.32

================================================================================
SECTION 7 -- MIGRATION SYSTEM
================================================================================

FILES:
  src/migrations/migrations.ts    -- registry of all migrations ever written
  src/migrations/runMigrations.ts -- runner, called from App.tsx on every open

HOW IT WORKS:
  - Runs before app hydrates (App.tsx ready gate)
  - Each migration runs exactly once per device, ever
  - Completed migration IDs stored in AsyncStorage key: herald_completed_migrations
  - Never delete or rename a migration ID
  - Add new migrations at the BOTTOM of MIGRATIONS array only

CURRENT MIGRATIONS:
  v8.16_fix_onboarding_flag   -- clears stuck flag when userId or name absent
  v8.16_fix_ai_name_default   -- ensures aiName defaults to "Herald"
  v8_17_force_onboarding_reset -- NEW Session O:
    Resets onboardingComplete when onboarding marked done but aiName or name
    are still defaults (missing or "Herald")
    Commit: b1cc6a17
    Fixes: fresh install / stale blob shows Chat without real onboarding

ADDING A FUTURE MIGRATION:
  Open src/migrations/migrations.ts
  Add new object at bottom of MIGRATIONS array with unique id
  Never change existing migration IDs

================================================================================
SECTION 8 -- CURSOR WORKFLOW (unchanged)
================================================================================

  Cursor writes. Claude reviews every diff before commit.
  NEVER let Cursor commit without reviewing diff here first.

  Audit prompt:  "Audit only. Read [file]. Tell me [question]. No changes."
  Fix prompt:    "Show me the diff. Do not commit yet."
  Safe commit sequence:
    1. Cursor shows diff
    2. Paste diff here for review (or review in Cursor)
    3. Approve
    4. git add [specific file only]
    5. git commit -m "feat: description"
    6. git push origin master (app) or main (backend)
    7. Verify health check / EAS build

  POWERSHELL NOTES:
    Use single-line Invoke-RestMethod for POST calls (no backtick multiline)
    Health check: Invoke-RestMethod https://web-production-b4083.up.railway.app/health
    EAS builds:   npx eas build --platform android --profile preview --no-wait

  DESIGN HANDOFF WORKFLOW:
    1. Read design_handoff_persona_system/README.md
    2. Audit first -- show plan, files touched, no commits
    3. Implement one screen at a time
    4. Review diff before each commit

================================================================================
SECTION 9 -- PERSONALITY UPGRADE
================================================================================

STATUS: ✅ COMPLETE (backend v8.31 live)

WHAT IS LIVE:
  ✅ Trust level system in system prompt
  ✅ Crisis detection and appropriate response routing
  ✅ Personality layer -- companion voice not chatbot
  ✅ v8.32 -- no support-team deflection
  ✅ v8.30 -- ABSOLUTE RULE (no internals exposure, no developer blame)

WHAT IS BUILT IN APP:
  ✅ ai_name personalization -- onboarding captures name, used in header/greeting
  ✅ PersonaConfirmScreen -- AI name cinematic "waking up" moment
  ✅ Persona accent colors per environment -- drives ChatScreen UI

WHAT STILL NEEDS PERSONALITY LEARNING LOOP (future):
  ❌ Herald learns tone preferences over time ("keep it short", "be direct")
  ❌ Reminder tier selection based on urgency + user preference (Session S)
  ❌ Proactive message tone variants (Friendly / Standard / Aggressive)
  ❌ Cross-session personality consistency audit

  Personality is prompt-level today. Learning loop is Session S+.

================================================================================
SECTION 10 -- COMMERCIAL CONTEXT
================================================================================

PRODUCT VISION (locked):
  "Herald is your memory of life. Online or off."

THE PITCH (one sentence):
  "Life Alert does one thing for $40/month.
   Siri knows nothing about you.
   Herald knows everything and costs $7.99."

COMMERCIAL GATES (updated May 25, 2026):
  Gate 1: Mickey APK working, no crashes                    ✅ (historical)
  Gate 2: 30-day Mickey test -- memory moat holding         ← IN PROGRESS
           BLOCKED ON: S24+ Build 4 test + send Mickey
  Gate 3: 5 beta users from 65+ market (Heather first)      ← Session T
  Gate 4: 50 daily active users
  Gate 5: First B2B2C partner conversation
  Gate 6: iOS build live, both platforms stable             ← Session X
  Gate 7: Revenue covers infrastructure ($30/month)

PRICING: $7.99/month | $59/year (LOCKED)
TRIAL:   30 days, full access, no credit card

ARCHITECTURE PLANNED:
  Session T: Identity layer (email anchor) -- account survives reinstall
  Session T/U: Billing architecture (Stripe) -- tied to identity
  Session V: Referral system -- Mickey GTM wedge

PARTNER TARGETS: Life Alert, Medical Guardian, Life360, AARP AgeTech

================================================================================
SECTION 11 -- DESIGN ASSETS
================================================================================

PERSONA SYSTEM HANDOFF:
  Location: herald-app/design_handoff_persona_system/
  Files: README.md, personas.ts, tokens.css, index.html, app.jsx,
         assets/personas/*.jpg (beach, mountain, city, country, desert)

SESSION R STATUS: ✅ COMPLETE (in Build 4)

  SHIPPED IN BUILD 4:
    ✅ Screen 1 -- Persona Picker upgrade
       "Pick your look", palette dots, surfaceTint gradient, scale animation
       Teal Continue (#2dd4bf), Source Serif 4 + Inter fonts
    ✅ Screen 2 -- PersonaConfirmScreen (Confirmation Flash)
       Full-bleed photo, AI name 72px, glow pulse, tap-to-skip
       Auto-advance → handleFinish → Chat
    ✅ src/constants/personas.ts -- handoff tokens (accent, surfaceTint, palette)
    ✅ src/constants/personaImages.ts -- shared image map
    ✅ App.tsx -- Source Serif 4 + Inter loaded at startup

  DEFERRED (not in Build 4):
    ⏭ Screen 3 -- Home widget + persona-themed app icon (Android activity-alias)
    ⏭ Screen 4 -- Lock screen Herald notification styling
    ⏭ "Use your own photo" tile (out of scope)
    ⏭ Launcher label change to AI name (keep "Herald" per handoff recommendation)

REFERENCE PROTOTYPE:
  Open design_handoff_persona_system/index.html in browser for visual spec

================================================================================
SECTION 12 -- FORBIDDEN (unchanged)
================================================================================

  NEVER RUN:
    npx cap add android          -- Destroys Capacitor (happened May 14)
    git push --force             -- Breaks Railway auto-deploy
    npm audit fix --force        -- Breaks package versions
    npx expo start in herald-voice-app\ -- Wrong folder

  NEVER DO:
    Run Herald code on 143.198.18.66 (Freddie VM only)
    Skip version bump in /health on backend edits
    Let Cursor commit without reviewing diff first
    Send Mickey APK before S24+ passes full test sequence
    Use weather/location from conversation context -- GPS only
    Edit files in GitHub web editor -- mangles indentation
    Commit node_modules/ or .expo/
    Mix master and main branches -- they are different projects
    Use duplicate EAS builds (b6d64bc2, e6cf7cfe) -- cb3eea5f only

================================================================================
END HERALD CURRENT STATE
May 25, 2026 -- Session O complete, Session P ready

SESSION O SHIPPED TODAY:
  Backend v8.30 + v8.31 + v8.32 live on Railway
  App: ON_DEVICE_TTS, offline mode, stream fixes, migration v8_17
  App: Full Session R persona pipeline (picker + confirm flash + tokens + fonts)
  Build 4 (cb3eea5f) submitted -- awaiting S24+ test

FIRST THING SESSION P:
  Health check v8.32 → wait for cb3eea5f → wipe S24+ → test → send Mickey
================================================================================
