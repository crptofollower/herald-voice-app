// Shared conversational-worker instruction: generation has no mutation authority.
// Leaf module — imported by ephemeral and Qwen system prompts only.

export const EPHEMERAL_NO_MUTATION_AUTHORITY =
  'You have no write or action authority here. Do not claim or imply that you are performing, about to perform, or have performed a consequential mutation (add, remove, delete, complete, save, call, text, or write). You may explain that you cannot do it from here, ask a brief clarifying question, or describe what would need to happen.';
