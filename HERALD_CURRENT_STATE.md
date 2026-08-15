# HERALD_CURRENT_STATE.md

**Last updated:** 2026-08-15  
**Purpose:** Short live operational reference. Reduce stale-context cost. Not a full history.

---

## HEAD

`47689a99` — *Conversation ownership fence: reach bounded local conversation safely*

Branch: `master` (Expo app). Do not treat May 2025 CURRENT_STATE session docs as current.

---

## Gate

Authoritative: **1443/1443 green** (pre-commit, accepted).  
Ownership fence: **55/55 green**.

---

## Device-proven facts

Do **not** claim the new conversation seam is device-proven.

Carry-forward (prior, still treat as settled unless new evidence):

- one-shot manual STT using `continuous: false` (do not restore `continuous: true` / SODA ambient path)
- local conversational model can generate on-device (diagnostic probe — capability, not this seam)
- Law 0 `help me` narrative false-ownership correction (rev. 4)
- KITT wall partial/substring grounding
- temporal-recall false ownership correction

---

## Closed mechanism

**Root cause:** ordinary default language terminated at ChatScreen `needs_clarification` with canned clarification and never reached ephemeral conversation. The later `backend && default` online seam was unreachable (`routeIntent` only emits `backend` for `live:data`).

**Closed at:** `47689a99`

**Committed behavior:** leftover path is

`classifyQuery` `tier:3/default`  
→ `routeIntent` `needs_clarification/default`  
→ `isEligibleForEphemeralConversation`  
→ `canRunEphemeralConversation`  
→ bounded local ephemeral conversation  
→ canned clarification on ineligible / decline / error

Dead `backend/default` seam **removed**. Conversation does not write, act, or own safety/pending.

---

## Ownership fence

Targeted **55/55**. Predicate-only (speech-act shape). Wrong-layer correction/emergency cases are **not** in this suite (pending / Law 0 own those upstream).

**Key rule:** ephemeral conversation is lowest-authority. Fact-seeking and clause-initial action leftover fail closed. Opinion/reflection may converse.

---

## Current blocker / next objective

**DEVICE PROOF.** Not more routing design.

Does the committed build allow a natural ordinary conversation with Kit on the **S24+** while still refusing to impersonate personal truth or device-action authority?

---

## Known follow-ups — not blockers

Parked only:

- `I should probably call Hunter.` current routing (todo, not call)
- `Do you think you could call him?` current routing (default/opinion, not call)
- `Hunter reminded me to call him.` call false-positive
- Tell-me medical read/write misroute
- stocks / embedded `I should` todo misroute
- offline ephemeral seam (unfenced; ordinary `default` leftover no longer reaches it)
- busy-state hardcoding at the ChatScreen seam (`generateEphemeralConversation` still re-checks busy)

---

## Foundation streak / session type

This closeout is **foundation / ownership-fence** work (routing leftover → bounded conversation).

**FOUNDATION STREAK:** needs reconciliation. No reliable streak number is recorded in a current operational doc (legacy `HERALD_CURRENT_STATE_May25_2026_SessionO.md` is stale and must not be used to invent a count).
