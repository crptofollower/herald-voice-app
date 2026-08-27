# Herald Session Handoff — Capture Repair V1

**Status:** RATIFIED / CLOSED  
**Date:** 2026-08-27  
**Session type:** Capability (language / Call-Text recovery arc)  
**HEAD at landing:** `769ddac3` — Refine capability surface presentation (`capability-surface`)  
**Authoritative gate:** 2556 passed / 0 failed / 2556 total (HEAD 2488 + 68 ARR). Device-proven EAS preview `6e557329` was built from a dirtier 2583 tree that also contained unrelated suites; those suites are **not** in this landing.  
**Device-proven preview build:** `6e557329-656e-48b4-8da1-683acd1d85e4`  
**Device-proven APK SHA-256:** `94644D883078009A068F6FDB112B178C1EA5CF0248A9DD060F5452B68AD667CE`

---

## Executive summary

CAPTURE_REPAIR V1 is device-proven on Samsung S24+ (`R5CX22SWVTV` / `SM_S926U`).

When Herald already holds a **finite candidate set** and an **active Call/Text task**, a capture miss (STT mangling, typed noise) recovers **inside that set**. The original SMS body is retained. The user is not forced to restart.

User-visible objective, met:

> When Herald mishears a difficult name, the user can recover without restarting the text.

---

## Device-proven behavior (S24+)

Named SMS with a finite OS Paul candidate set retained the original task and body.

1. Repeated STT mangling (`Paul Cioffre` → “Show Fray” / “Show free”) did **not** abandon the task.
2. First unresolved capture: `I didn't catch that name clearly. Which one do you mean?`
3. Second unresolved capture: `You can say it again, type the name, or tap the person below.` plus tappable current OS labels.
4. Tap **Paul Cioffre** resolved the retained SMS with the original body.
5. Typed **Cioffre** resolved through the same pending resume.
6. Safety: **Yes** with no live proposal did not select a person, did not open Messages, and left the candidate task unresolved.

---

## Mechanism

One `ConversationSession`. Capture Repair miss policy:

| Consecutive unresolved capture | Behavior |
|---|---|
| 1 | Keep pending. Acknowledge capture difficulty. No action. |
| 2 | Keep pending. Second-miss copy + `recoveryChoices` (current finite labels only). Tap feeds `sendMessage(name)` into the same `resolvePending`. |
| 3 (OS finite path) | Graceful stop: `I've lost who you mean. Want to start that one over?` Not the generic session-budget line. |

Exact unique token / tap authorizes **only** an already-listed candidate.

Fuzzy `proposeConstrainedCandidate` may **propose** one or two names from that set. It never authorizes action. Confirmation uses existing `CONFIRM_YES_RE` / `CONFIRM_NO_RE`. Yes with no live proposal does nothing.

### Authority (source-specific; not merged)

| Path | Pending key | Candidate authority | Action payload |
|---|---|---|---|
| Herald finite-person ambiguity | `call_text_recovery` | Herald SQLite identity | `completeReadySms` / Herald-ready person |
| OS finite phoneable set | `sms_disambiguate` | Snapshotted OS rows (name + phone in closure) | OS phone already held; **not** `completeReadySms` |
| Unresolved `him` / missing content | `call_text_recovery` | Herald identity after the user names someone | same as Herald path |

OS contacts are **not** promoted into Herald identity. `resolvePersonIdentity` is not re-run on OS resume. Fuzzy matching is not action authority. `ConversationSession` `DEFAULT_STANDARD_BUDGET` was not changed. CALL was not flattened into the SMS OS binder (`sms_disambiguate_os_capability` left untouched; `resolvePersonCapability` never returns `ambiguous`).

---

## Failed paths (preserve this history)

1. **Legacy `sms_disambiguate`** used exact `matchCandidateToken`, empty-ack `noop` on miss, and generic `ConversationSession` budget 2. User-visible: “I'm not sure I caught that…” then “Let's come back to that…”. Capture Repair never ran.

2. **Herald-only Capture Repair** covered `identity.status === 'ambiguous'` (`call_text_recovery`). Real-device “Text Paul…” on the S24+ resolved as **OS-only / OS-multi fallthrough** (`sms_disambiguate`), so the first repair did not own that journey.

3. **Provenance trap:** an earlier installed APK SHA did not match the EAS 2570 artifact. Preview APK ~200 MB is legitimate: GGUF is downloaded after install into app files, not bundled. Do **not** use APK size as a source-version proof. Artifact SHA-256 + bundle fingerprints are the proof.

The final repair reused Capture Repair miss policy for the finite OS candidate set (`bindOsFiniteSmsDisambiguate`) while keeping OS authority and snapshotted phones.

---

## Lessons learned

- Named-intent tests that seed **in-memory Herald Pauls** do not prove the OS `sms_disambiguate` owner. Device contact cardinality must be inspected.
- Empty-ack `noop` hands miss handling to the global session budget. Domain resume must return `pending` (or a named stop ack) if Capture Repair owns the miss.
- EAS `gitCommitHash` can label HEAD even when untracked recovery files were uploaded. Fingerprint the JS bundle, not the git label or APK byte size.
- Runtime architecture: fat native APK + on-device model download. GGUF absence from the APK is expected.

---

## Explicitly out of scope (do not reopen)

1B / 3B training, TP3 / TP4, llama.rn runtime bake-off, ConversationSession redesign, global pending-budget change, promoting OS rows into Herald identity, making fuzzy matching authoritative, flattening CALL into SMS OS recovery.

---

## Gate note

The device-proven EAS preview (`6e557329`) was produced from a dirty working tree whose full gate was **2583**, including unrelated untracked suites (Contract V1 Stage-B harness, send-tap diagnostics) that are **not** part of this landing. This handoff’s source landing is the language/recovery/Capture Repair tree only: **2556**.
