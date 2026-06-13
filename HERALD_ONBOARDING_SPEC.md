# Herald — Onboarding Spec (Voice-First, Trust-First)

> **Status:** v1 draft. Fidelity: mostly-there + open questions flagged at the bottom.
> **Audience:** Cursor / Claude (implementers) and Mike (review surface).
> **Companions — read first:**
> - `design_handoff_persona_system/README.md` — persona system + KITT main screen + lock screen, with the full token table.
> - `HERALD_CURRENT_STATE_*.md` — build context. This spec is the design for **Session U: "65+ onboarding rebuild — voice-first."**
> - `kitt-mode.jsx` — the main interface onboarding hands off to.
> - Live visual version of this doc: `Herald Onboarding Spec.html` (live mockups of every screen).

This is a **design reference, not production code.** Recreate these screens inside the Expo app (`herald-app`, `master`) using existing conventions — `useStore`, AsyncStorage, `expo-blur`, `expo-linear-gradient`, the persona system in `personas.ts`. Audit first, propose a plan, no commits until the diff is reviewed (CURRENT_STATE §6).

---

## 1. The vision — a rock-solid friend who has your back

Our people are **55 and older.** They've watched technology break promises for thirty years. They don't trust AI, and they trust the companies behind it even less. An app that opens with a wall of permission requests confirms every fear they already have.

So we don't open like an app. We open like **KITT** — the calm, capable voice from their youth that was unmistakably *on their side.* A friend in the passenger seat who knows things, looks out for you, and never has an angle.

Every screen in onboarding has one job: **earn a little trust, then ask for a little in return** — in the AI's own voice, never the system's.

### The trust contract (state it out loud, unprompted)

| Promise | What it means |
|---|---|
| **I won't sell what I know about you.** | No data brokers. No ad targeting. Ever. |
| **I don't track where you go.** | No background location. No map of your day on a server. |
| **I only look when it helps you.** | A good place to eat. Help if you're lost or in trouble. Always because you asked. |

---

## 2. The problem today — the words are right, the room is wrong

The current onboarding copy is already warm and honest — first-person, reassuring, no jargon. But it's delivered on **flat navy screens with clip-art emoji and a generic "Allow" dialog.** To a wary 55-year-old it reads as *every other app.*

The fix is **not new words** — it's giving the AI a room to say them in.

**Out:** dead navy background · 🔔📍🎤 emoji · system-permission-wall look · no sign anyone is on the other end.

**In:** full-bleed persona wallpaper (a real place) · the AI present at the top with his breathing KITT scanner · every ask framed as *his* voice · always a soft way out ("Not yet").

---

## 3. Visual system (align with what's already built)

Pull the visual language straight from `kitt-mode.jsx` so onboarding reads as the **same product** as the main interface.

- **Canvas (pre-persona):** Beach wallpaper + dark scrim (0.78–0.88 opacity gradient). Persona accent locks only at Screen 08.
- **Heading / the AI's voice:** Source Serif 4, 26–31px, weight 400.
- **Body / reassurance:** Inter, 14–15px, line-height 1.55–1.6.
- **Step caption:** Inter, 11px, 0.18em tracked, uppercase.
- **Primary CTA:** persona-accent fill, `#0d1217` text, 56px tall, radius 28.
- **Soft decline:** ghost button, 1.5px white@22% border, 48px, radius 24.
- **Presence mark:** a glossy circular medallion in the persona accent showing **the AI's initial** (see §4 Screen 03 note). The KITT scanner waveform breathes at the bottom — the signal that he's alive and present.
- **No emoji, no clip-art.** Clean line-art icons in the persona accent inside a softly-breathing halo.

Accent (onboarding): `#4dd4d6` (Beach) → locks to chosen persona at Screen 08.
Brand-fixed teal `#2dd4bf` is used only for the persona-picker Continue button.

---

## 4. The flow — nine beats, about five minutes

One thing per screen. Each beat either gives the AI a little more presence, or asks for a little more trust — in that order, always.

| # | Beat | What it does |
|---|---|---|
| 01 | Welcome | Invite code, warm — a place and a presence, not a wall |
| 02 | Your name | He asks who he's meeting |
| 03 | Naming your Herald | The user names the companion |
| 04 | The Promise | The three trust commitments, stated before any ask |
| 05 | Notifications | First permission, in his voice |
| 06 | Location | The most trust-sensitive ask |
| 07 | Microphone | Unlocks the voice-first core |
| 08 | Your place | Persona picker — colors from where you feel at home |
| 09 | Ready | Confirmation flash → hands off to KITT mode |

> **Naming note:** **Herald is the product.** The AI name is **user-chosen** and defaults to "Herald" itself (CURRENT_STATE migration `v8.16_fix_ai_name_default`). This spec uses **"Sam"** purely as an example of a personalized name — it is not a brand term. "Mike" is the example user.

---

## 5. Screen-by-screen

Copy blocks are **verbatim and ready to ship.** Build notes flag the wiring and the known issues each screen touches.

### Screen 01 — Welcome
**Purpose:** Replace the cold access-code wall. First impression sets the tone: a calm place, a guide, no pressure.
**What this beat earns:** He shows up as a place and a presence before he asks for a single thing. The invite code stays, but it now feels like being let *into* something, not locked *out* of it.

**Copy**
- *Caption:* `Step 1 of 7 · about 5 minutes`
- *Title (serif):* **Let's get you set up.**
- *Body:* I'll walk you through it one step at a time. Nothing here is permanent — you can change any of it later, or stop me whenever you like.
- *Field:* `Enter your invite code`
- *Button:* `Begin`

**Build notes**
- Beach wallpaper + dark scrim is the default canvas for all pre-persona screens.
- State progress in plain words ("about 5 minutes"), not a thin progress bar — reassurance beats precision for this audience.
- Idle scanner at the bottom signals "he's alive and waiting," not "loading."

---

### Screen 02 — Your name
**Purpose:** He asks who he's talking to — the warm opener that turns a code redemption into a hello.
**What this beat earns:** He asks before he tells. "Who do I have the pleasure of meeting?" makes the user the subject from the very first moment — and hands him the name he'll use for the rest of onboarding and beyond.

**Copy**
- *Caption:* `Step 2 of 7`
- *Title (serif):* **Who do I have the pleasure of meeting?**
- *Body:* Just your first name is perfect — it's how I'll greet you from now on.
- *Field:* `Type your name`
- *Button:* `That's me`

**Build notes**
- Capture **first name only** and persist to device SQLite + Railway profile — the app already greets "Good morning, Mike," so this is the value that feeds it.
- One field, nothing else. No last name, no email — anything extra reads as data collection and undoes the trust we're building.
- Natural spot to introduce talking, but mic permission comes later (Screen 07) — so default to typed entry here, voice as a Phase-2 nicety.

---

### Screen 03 — Naming your Herald
**Purpose:** Turn a setup field into the moment a relationship starts. The user names the companion they'll talk to.
**What this beat earns:** Naming creates ownership. He greets the user by the name captured a step earlier, then hands them the power to name him back. This is the first two-way exchange.

**Copy**
- *Greeting:* Good to meet you, Mike.
- *Title (serif):* **What would you like to call me?**
- *Body:* Pick a name that feels easy to say out loud. This is who you'll be talking to.
- *Options:* Sam · Kit · Cal · Friday · Something else…
- *Button:* `Call you Sam`

**Build notes**
- Default suggestions nod to the era (KITT / Knight Rider) without naming the trademark.
- `aiName` must persist to device SQLite (`saveLocalProfile("ai_name", aiName)`) and Railway profile — see CURRENT_STATE known issue on `ai_name` not saving.
- **Once named, the corner presence monogram switches to the AI's initial** (e.g. "S" for Sam) as a glossy persona-accent medallion. **The Herald "H" stays on the home-screen app icon and notifications for brand recognition.**
- The user's own name is captured on the preceding screen (Screen 02); this screen greets them with it, then sets `aiName`.

---

### Screen 04 — The Promise
**Purpose:** A dedicated trust moment **before** any permission is requested. This is the spine of the redesign — net-new, not in today's flow.
**What this beat earns:** Say the quiet part first, out loud, unprompted. By stating the three promises before asking for anything, the permission screens that follow read as "here's why," not "gotcha."

**Copy**
- *Caption:* `My promise to you`
- *Title (serif):* **Before anything else, here's the deal.**
- *Line 1 (serif):* I'll never sell what I know about you. Not to anyone, not ever.
- *Line 2 (serif):* I don't track where you go. There's no map of your day on some server.
- *Line 3 (serif):* I only look when you ask — to find you a good meal, or get help if you're ever lost or in trouble.
- *Footer:* You're in charge of every bit of it. Turn anything off, anytime — and I'll still be here.
- *Button:* `Okay — I'm listening`

**Build notes**
- This screen earns the right to ask for notifications/location/mic on the next three screens. **Do not skip or reorder it.**
- Each promise maps 1:1 to a later ask: data→(all), tracking→location, "only when you ask"→mic & location. The symmetry is intentional.
- Consider a quiet "Read the full privacy promise" text link for the few who want detail — never a wall.

---

### Screen 05 — Notifications
**Purpose:** First permission ask. Reframed from an OS dialog into the AI asking a friend's permission to interrupt.
**What this beat earns:** The title is a human metaphor ("tap you on the shoulder"), not a feature name. The body gives concrete, personal examples and hands back control in the same breath.

**Copy**
- *Caption:* `A quick ask · Step 4 of 7`
- *Title (serif):* **Can I tap you on the shoulder?**
- *Body:* So I can let you know when something happens — a score you follow, a price you're watching, a friend's birthday coming up. You decide what's worth a tap, and you can turn it off anytime.
- *Allow:* `Yes, you can`
- *Decline:* `Not yet`

**Build notes**
- Icon is a clean line-art bell in the persona accent inside a breathing halo — never the 🔔 emoji.
- The decline path is soft ("Not yet"), never red or scary. Declining must not dead-end onboarding.
- Maps to OneSignal push setup (CURRENT_STATE Session S). Tie the actual OS prompt to the "Yes, you can" tap.

---

### Screen 06 — Location
**Purpose:** The most trust-sensitive ask. Must be unmistakably "only when you ask, only to help you."
**What this beat earns:** This is where the demographic's deepest fear lives (being tracked). The copy leads with benefit (rain, a good meal, help if lost) and states the non-negotiable: never in the background, never shared.

**Copy**
- *Caption:* `A quick ask · Step 5 of 7`
- *Title (serif):* **Where are you?**
- *Body:* So I can tell you if it's raining outside, point you to a good place to eat nearby, or help if you're ever lost. I only check when you ask — never in the background, and I never share it with anyone.
- *Allow:* `Sure, go ahead`
- *Decline:* `Not yet`

**Build notes**
- Request **foreground / while-using** location only. Background location would break the promise made on Screen 04 — **do not request it.**
- "Help if you're lost or in trouble" is the emotional anchor for this audience — keep it.
- Ties to the existing GPS city-detection + Google Places fast path (CURRENT_STATE §1).

---

### Screen 07 — Microphone
**Purpose:** Unlock the voice-first core. This is the gateway to KITT mode itself.
**What this beat earns:** Framed as "so you can just talk to me" — the payoff is conversation, not data collection. Reassures that listening is tap-gated and nothing is recorded or kept.

**Copy**
- *Caption:* `One more · Step 6 of 7`
- *Title (serif):* **Can I hear you?**
- *Body:* So you can just talk to me instead of typing. I only listen the moment you tap the mic — never in the background. I don't record or keep your voice.
- *Allow:* `Turn on talking`
- *Decline:* `Not yet`

**Build notes**
- Wire the OS mic prompt to "Turn on talking." After grant, the very next surface is KITT mode (`kitt-mode.jsx`).
- Respect the known audio-mode fix (CURRENT_STATE Session Q): `AudioModule.setAudioModeAsync` before recording, or the mic captures silence.
- If declined, fall back gracefully to typed input — the app must still work without voice.

---

### Screen 08 — Your place (persona picker)
**Purpose:** Pick the persona. One choice drives wallpaper, accent, and the app icon — see README persona spec for the full token table.
**What this beat earns:** A warm, low-stakes, personal choice to end on — "where do you feel most at home?" It's about them, not the software, and it makes the whole phone feel like theirs.

**Copy**
- *Caption:* `Step 7 of 7`
- *Title (serif):* **Where do you feel most at home?**
- *Body:* I'll take my colors from the place you pick. You can always change it.
- *Cards:* Beach · Mountain · City · Country · Desert (+ Use your own photo)
- *Button:* `Continue`

**Build notes**
- This is the existing "Pick your look" screen from the persona handoff — same tokens, same cards. Full spec in README §4 Screen 1.
- Continue button stays brand teal `#2dd4bf` (not the persona accent) to keep onboarding visually consistent.
- Ship all five personas plus the "Use your own photo" tile.

---

### Screen 09 — Ready (confirmation flash)
**Purpose:** The cinematic "he's awake" payoff before landing in KITT mode.
**What this beat earns:** Everything resolves: their place fills the screen, his name glows, and he says he's ready. The reward for five minutes of trust is a moment that feels like meeting someone.

**Copy**
- *Name (serif, ~76px, glowing halo in persona accent):* **Sam**
- *Line:* Ready when you are.

**Build notes**
- Matches README Screen 2 (Confirmation Flash): photo fades in, name rises + glows, ~1.5s, then cross-fade to KITT mode.
- Tap anywhere to skip. No back navigation from here.
- Hand-off target is the main KITT interface (`kitt-mode.jsx`) — the scanner here is the visual bridge to it.

---

## 6. Principles (hold across every screen)

1. **It's always the AI asking, never the OS.** Every screen is first person, in his voice. The system permission dialog appears only *after* the user has already said yes to him.
2. **Give before you take.** Presence and the promise come before any ask. By the time we request location, we've already told them we won't track them.
3. **Always a soft way out.** "Not yet" on every ask. Declining never dead-ends onboarding, never turns red, never guilt-trips. The app works without any single permission.
4. **Concrete, personal examples.** Not "enable location services." Instead: "find you a good place to eat, or help if you're lost."
5. **One thing per screen.** No screen asks for two things. Density reads as a trap; whitespace reads as honesty.
6. **No emoji, no clip-art.** Clean line-art icons in the persona accent. Emoji signals "cheap app" to this demographic; Herald is not a cheap app.

---

## 7. Onboarding tokens

| Token | Value |
|---|---|
| Canvas (pre-persona) | Beach wallpaper + dark scrim 0.78–0.88 |
| Heading / the AI's voice | Source Serif 4 · 26–31px · weight 400 |
| Body / reassurance | Inter · 14–15px · 1.55–1.6 line-height |
| Caption (steps) | Inter · 11px · 0.18em tracked · uppercase |
| Primary CTA | Persona accent fill, `#0d1217` text, 56px, radius 28 |
| Soft decline | Ghost · 1.5px white@22% · 48px · radius 24 |
| Presence medallion | Circular, persona-accent radial gradient, AI's initial in `#0d1217` |
| Accent (onboarding) | `#4dd4d6` Beach → locks to chosen persona at Screen 08 |
| Brand-fixed CTA | `#2dd4bf` teal (persona Continue button only) |

Full persona token table (accents, surface tints, palette dots, app-icon spec) lives in **README §7** and **`personas.ts`**.

---

## 8. Open questions (decide before build)

The flow and copy are settled. These calls are open and worth a pass with Claude first:

1. Does **The Promise (Screen 04)** need a tappable "full privacy promise" detail view for skeptics, or does plain-spoken cover it?
2. **Permission order:** notifications → location → mic. Is location better *last* (after the most trust is built), or does mic-before-KITT-mode have to be last?
3. Should onboarding be **fully voice-navigable** (he reads each screen, user says "yes" / "not yet"), or tap-first with voice as a bonus? **This is the biggest open call.**
4. **Confirmation flash:** auto-advance at 1.5s, or wait for a tap so slower users aren't rushed?
5. Do we offer a **"set this up with someone you trust"** path (hand the phone to family) for the least confident users?

---

*End — Herald Onboarding Spec v1 draft.*
