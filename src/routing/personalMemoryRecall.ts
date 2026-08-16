// src/routing/personalMemoryRecall.ts
// Neutral recall-question speech-act for the Site-A LLM capture floor
// (routeIntent.ts) and the service-provider detector (householdCapture.ts).
// One definition — not household-owned, not a classifier prompt, not a
// framework. Do not broaden this pattern without a new evidenced miss;
// the forms are exactly the Fix-2 fence already proven in detectServiceCapture.

const PERSONAL_MEMORY_RECALL_QUESTION_RE =
  /\b(?:do\s+you\s+(?:remember|recall|know)|did\s+i\s+(?:tell|mention)|what\s+did\b[\s\S]*?\b(?:say|tell)\b)\b/i;

export function isPersonalMemoryRecallQuestion(text: string): boolean {
  return PERSONAL_MEMORY_RECALL_QUESTION_RE.test(text);
}
