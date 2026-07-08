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
export const LOCAL_LLM_ENABLED = true;
