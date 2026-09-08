// src/constants/features.ts
// Runtime feature flags. Flip to enable/disable subsystems without touching
// call sites. Deliberately tiny and dependency-free.
//
// LOCAL_LLM_ENABLED:
//   Gates on-device model download (App.tsx), model load (useLocalLLM), and
//   the tier-3 intent classifier (classifyWithLLM). Phrase-out does NOT
//   exist — no LLM ever authors or wraps a stored value (Spine §3).
//   HARDWARE PRECONDITION: init is CPU-only (n_gpu_layers: 0). NEVER
//   re-introduce forced accel (devices:['HTP0'] / n_gpu_layers > 0) without
//   device-capability detection + CPU-fallback retry — forced HTP0
//   black-screened non-Snapdragon hardware (Motorola, pre-916c18aa).
//   Changes to this flag require a ratified session + state-doc FLAG
//   REGISTRY entry in the same session (LLM_LIVE_DESIGN_SPEC P7).
export const LOCAL_LLM_ENABLED = false;

// CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED:
//   Independent on-device conversational GGUF (Qwen) offered through
//   ConversationalWorker → resolveEphemeralSeam. Does NOT enable the
//   retired classifier, App.tsx Llama-3.2 downloads, or useLocalLLM.
export const CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED = true;

// LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED:
//   Bounded diagnostic: independent Qwen ctx proposes list_remove semantics;
//   deterministic code grounds against a pre-mutation grocery snapshot and
//   logs a hypothetical authority decision. OFF ⇒ no snapshot, no second
//   context, no completion, no shadow logs, no production timing from this
//   path. Never writes, speaks, pending-arms, or shares the conversational
//   Qwen context.
export const LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED = true;

// PROACTIVE_SURFACING_ENABLED:
//   Gates Beat 1 medical appointment surfacing on cold mount
//   (MEDICAL_SURFACING_DESIGN_SPEC §2.3). Flip false to silence
//   proactive offers without removing the sweep/read path.
export const PROACTIVE_SURFACING_ENABLED = true;

// CORRECTION_REPAIR_ENABLED:
// Additive marker-based single-turn correction during an active pending
// confirmation ("no, it's Dr. Nguyen" / "actually X"). Governing spec:
// S_CONVERSATIONAL_REPAIR_DESIGN_SPEC.md v2. Does not alter existing
// Yes/No matching or any domain's committed-write path.
export const CORRECTION_REPAIR_ENABLED = true;

// MEDICATION_SEMANTIC_INTERPRETATION_ENABLED:
//   Governing docs: HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_IMPLEMENTATION_DESIGN.md,
//   HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_CTO_REVIEW_RESOLUTION.md.
//   Gates the SemanticProposal -> deterministic admission seam in
//   routeIntent.ts (medicationSemanticInterpretation.ts). Runs only after
//   every deterministic capturer/floor mechanism has had first refusal and
//   only before the generic classifyLLM tier-3 capture path. OFF ⇒ the seam
//   never generates a proposal, never calls admission, and routing is
//   byte-for-byte identical to before this flag existed. Does not gate the
//   classifyLLM medication-evidence bypass closure in routeIntent.ts, which
//   is unconditional production code (medication-only, additive, and
//   strictly narrows an existing gap — not new capability requiring a flag).
//   Default OFF — do not flip without CTO review of device evidence.
export const MEDICATION_SEMANTIC_INTERPRETATION_ENABLED = true;

// CAPABILITY_READ_ROUTER_ENABLED:
//   Governing design: HERALD_NL_AUTHORITY_ARCHITECTURE_SYNTHESIS_2026-09-07.md
//   (Natural Language Authority V1 / Slice 1 — medication catalog READ).
//   Gates the bounded capability-selection READ path in routeIntent.ts
//   (capabilityRouting.ts): a probabilistic CapabilityProposal over a closed
//   vocabulary → deterministic structural admission → the EXISTING authoritative
//   SQLite medication summary reader (composeMedicalSummary). Runs only after
//   every deterministic capturer/floor + the legacy medication read banks have
//   had first refusal, and before the write seam. It is READ-ONLY: it can only
//   return a device_read RouteDecision; it constructs no IntentRecord, reaches
//   no writer, and mutates nothing. OFF ⇒ the read path never generates a
//   proposal, never calls admission, and routing is byte-for-byte identical to
//   before this flag existed.
//
//   Default ON, deliberately: this path is safe by construction (SQL-sourced,
//   no persistence, no fabrication) and its purpose is to close a live hole in
//   which a personal medication-recall question the legacy banks miss can reach
//   the generative Qwen ephemeral path. It is strictly lower-risk than the
//   already-ON write sibling above. CTO may set OFF to hold activation until the
//   Slice 1 falsification battery is run on device — the closing behavior only
//   takes effect while this is ON.
export const CAPABILITY_READ_ROUTER_ENABLED = true;
