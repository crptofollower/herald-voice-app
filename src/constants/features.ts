// src/constants/features.ts
// Runtime feature flags. Flip to enable/disable subsystems without touching
// call sites. Deliberately tiny and dependency-free.
//
// LOCAL_LLM_ENABLED:
//   The on-device LLM (llama.rn) is NOT a shipped feature yet (Build B/C).
//   Its startup init (initLlama with a hard-forced Hexagon 'HTP0' device) is the
//   top suspect for the Motorola black-screen crash — a native fault JS cannot
//   catch. Until the model is wired into a real feature AND the init does proper
//   device-capability detection (CPU fallback on non-Snapdragon hardware), this
//   stays FALSE so no llama.rn native code runs at startup on any device.
export const LOCAL_LLM_ENABLED = false;
