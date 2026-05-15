# Herald App -- Expo React Native MVP

## What this is

Complete frontend rebuild per May 9 decision (FREDDIE_HERALD_BUILD_HANDOFF_May10_2026).
Moving from Capacitor PWA to Expo React Native. One codebase: iOS + Android + Web.
Backend (Railway) does NOT change. Frontend swap only.

---

## File structure

```
herald-app/
├── App.tsx                          Root + navigation + providers
├── app.json                         Expo config (OneSignal plugin)
├── package.json                     Dependencies
├── src/
│   ├── api/
│   │   └── herald.ts                API client (all endpoints typed)
│   ├── constants/
│   │   ├── api.ts                   API_BASE, feature flags
│   │   └── personas.ts              LOCKED: 5 persona environments
│   ├── components/
│   │   ├── PersonaBackground.tsx    Gradient background per persona
│   │   ├── MessageBubble.tsx        Chat message display
│   │   └── ProactiveCard.tsx        Dismissable proactive alerts
│   ├── hooks/
│   │   ├── useSpeech.ts             TTS (expo-speech)
│   │   └── useProactiveQueue.ts     Polls backend, debounced (fixes double greeting)
│   ├── screens/
│   │   ├── OnboardingScreen.tsx     Name + persona picker (first run)
│   │   └── ChatScreen.tsx           Main Herald interface
│   └── store/
│       └── useStore.ts              Zustand global state (persisted)
└── backend-patches/
    ├── patch_bug2_memory_sync.py    Fixes desktop/mobile memory disconnect
    ├── patch_bug3_morning_briefing_freddie.py  Adds Freddie block to 7am job
    └── schema.sql                   Full Herald database schema
```

---

## Bugs fixed by this build

| Bug | Root cause | Fix |
|-----|-----------|-----|
| Double greeting | App fired greeting on open AND resume events | `useProactiveQueue` debounces: won't re-poll within 60s |
| Desktop/mobile memory | session_id differed between clients | Normalize queries by `user_id`, not `session_id` |
| Morning briefing missing Freddie | No call to empire_status.json | `patch_bug3_morning_briefing_freddie.py` |

---

## Quick start

```bash
cd herald-app
npm install
npx expo start
```

### iOS (TestFlight)
```bash
eas build --platform ios
```

### Android
```bash
eas build --platform android
```

---

## Environment variables

Create `.env` in project root:
```
EXPO_PUBLIC_API_BASE=https://your-railway-app.railway.app
EXPO_PUBLIC_OWNER_CODE=your_owner_auth_code
EXPO_PUBLIC_ONESIGNAL_APP_ID=your_onesignal_id
```

---

## Backend patches (apply in order)

1. **Schema migration** -- run `schema.sql` against Railway SQLite once
2. **Bug 2 fix** -- apply `patch_bug2_memory_sync.py` patches to `herald_api.py`
3. **Morning briefing** -- apply `patch_bug3_morning_briefing_freddie.py` to briefing job

---

## Freddie integration (all live as of May 10)

- `/freddie/status` -- FORGE-014, owner-gated, shows gate + regime + near misses
- `/freddie/trades` -- FORGE-016, nightly sync from VM
- `/proactive` -- FORGE-015, level_watcher fires into this queue
- `/ask` -- FORGE-017, Freddie intent routing already in `get_direct_reply()`

---

## What is NOT in this build (locked -- do not add)

- New Freddie signal types
- Live money activation (gate must close naturally)
- Emergency Assist Mode (security layer not designed yet)
- Stripe billing (Phase 5)
- Multi-user (Phase 5)

---

## Architecture decisions (locked May 9, 2026)

- Expo managed workflow (not bare -- simpler for solo operator)
- Zustand for state (not Redux -- less boilerplate)
- React Query for mutations (not raw fetch -- handles retry/loading)
- expo-speech for TTS (not third-party -- no cost, native quality)
- OneSignal for push (locked choice -- wired from day one)
- persona system: 5 environments, picked once at signup, full color theming
