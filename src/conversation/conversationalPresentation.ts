// Presentation-only sanitation for the experimental Qwen conversational adapter.
// Strips Qwen think-tag wrappers so they never reach customer UI.
// Non-empty think content is a defect: logged, never shown, not parsed.

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

export function sanitizeConversationalPresentation(text: string): {
  text: string;
  nonemptyThinkStripped: boolean;
} {
  let nonemptyThinkStripped = false;
  const stripped = text.replace(THINK_BLOCK_RE, (block) => {
    const inner = block.replace(/^<think>/i, '').replace(/<\/think>$/i, '');
    if (inner.trim().length > 0) nonemptyThinkStripped = true;
    return '';
  });
  if (nonemptyThinkStripped) {
    console.log('[CW-EXPERIMENT] nonempty think tags stripped from customer presentation');
  }
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), nonemptyThinkStripped };
}
