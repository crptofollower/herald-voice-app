# HERALD_OWNERSHIP_MAP.md

**Status:** Live engineering reference — source-audited against HEAD `47689a99`  
**Purpose:** Who owns a user turn before probabilistic conversation may speak.  
**Scope:** Operational ownership only. Not a replacement for Constitution, Spine, or subsystem specs.

---

## Core rule

**Deterministic systems have authority over probabilistic systems.**

The local LLM may classify, extract candidate structure, or generate conversational wording. It does **not** create personal truth, write memory, execute device actions, override recall or safety, or originate live/world facts.

Ephemeral conversation is the **lowest-authority speaker**.

---

## Turn order (source-proven)

1. **Law 0** — `detectEmergency` in ChatScreen (legacy pending-refs) and again first in `processUtterance`. If claimed: stop. Conversation never preempts.
2. **Pending / session** — `session.hasPending()` → `resolvePending`. Conversation does not consume that reply.
3. **`classifyQuery` then `routeIntent`** — deterministic action/read/capture first; LLM classify is proposal-only (KITT wall grounding). `live:data` → `kind: "backend"`. Unclaimed leftover → `kind: "needs_clarification"` (usually `reason: "default"`). **`backend + default` is not a valid pair.**
4. **ChatScreen leftover** — only `needs_clarification` + `reason: "default"`:
   - `isEligibleForEphemeralConversation(text)` (pure speech-act fence)
   - `canRunEphemeralConversation(...)` (runtime/busy/pending)
   - `generateEphemeralConversation` if both pass
   - canned clarification on ineligible / decline / empty / error  
   Then return. Does not fall through to `askHeraldStream`.

The old online `backend && reason === "default"` seam was **deleted** at `47689a99`. Do not rely on it.

---

## What conversation may and may not do

**May:** ordinary narrative, feelings, fragments, opinion/reflection, short follow-ups. Bounded in-memory prior turn only. Context is not Memory.

**Must not:** personal truth, live/world facts, device actions, writes, pending decisions, safety. Fact-seeking leftover (including Tell-me fact requests and clause-initial action requests) **fail closed** to canned clarification — never invent an answer.

If a reader already owns the question (`memory:probe`, `family:read`, medical reads, `live:data`), that owner speaks. If a personal-truth question has no reader, leftover still fail-closes.

Turn-by-turn: conversation must relinquish when the next utterance is truth or action.

---

## Closed vs parked

**Closed at `47689a99`:** leftover `default` reaches bounded local conversation only behind the ownership predicate. Gate: 1443/1443. Fence tests: 55/55. **Not device-proven.**

**Parked (not ownership law):** call/todo phrasing mismatches; `Hunter reminded me to call him` call over-claim; Tell-me medical capture misroute; stocks/`I should` todo misroute; unfenced offline ephemeral path for non-default leftover; seam busy-flag hardcoding.

**Do not reopen casually:** `continuous:false` one-shot STT; temporal-recall false ownership; Law 0 `help me` narrative correction; KITT wall grounding.

---

## Next objective

**Device proof** on S24+: natural ordinary talk with Kit, while refusing to impersonate personal truth or device-action authority.
