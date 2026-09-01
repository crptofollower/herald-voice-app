// Herald-as-addressee conversational shape. Leaf module — no llama, no DB.
// Distinguishes self/referent talk from Site-A personal-memory recall.

const USER_FACT_POSSESSION_RE =
  /\b(?:my|mine|about me|about myself|who i am|how old i am)\b/i;
const HERALD_SELF_OBJECT_RE =
  /\b(?:I(?:'m| am) talking about you|(?:that(?:'s| is) you)|(?:created|built|making|building)\s+you|about yourself)\b/i;

/** True when the utterance identifies or asks about Herald-as-addressee. */
export function isHeraldSelfReferentConversationalShape(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!HERALD_SELF_OBJECT_RE.test(t)) return false;
  if (USER_FACT_POSSESSION_RE.test(t) && !/\b(?:created|built|making|building)\s+you\b/i.test(t)) {
    return false;
  }
  return true;
}
