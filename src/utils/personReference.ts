// Shared person/relationship-reference cleanup for CALL, TEXT, and NAVIGATE.
// normalizePersonTarget: relocated from dispatch.ts navigation arm.
// isNameShapedToken / SMS_BODY_OPENERS: relocated from parseTime.ts (was Sms-prefixed).

export const PERSON_RELATIONSHIP_ALTERNATION =
  'wife|husband|son|daughter|mom|dad|mother|father|brother|sister|grandson|granddaughter';

// Common message-opener words — never the second word of a contact name.
// Bounded stopgap for greedy name capture; durable fix is contact-anchored
// splitting in the C-4 contact_text arc.
export const SMS_BODY_OPENERS = /^(?:how|what|when|where|why|that|to|about|i|i'm|im|i'll|ill|hi|hey|hello|please|can|could|will|would|are|is|do|don't|dont|good|thanks|thank|the|a|your|you're|youre|happy|call|come|meet|see|be|we|let's|lets|saying|tell)$/i;

/** Proper-name token after a relationship word — capitalized, not a sentence-starter/body opener. */
export function isNameShapedToken(token: string): boolean {
  if (!token || SMS_BODY_OPENERS.test(token)) return false;
  return /^[A-Z][A-Za-z\-]*$/.test(token);
}

export function normalizePersonTarget(raw: string): string {
  return raw
    .replace(/[\u2018\u2019\u02BC\u0060]/g, "'")
    .replace(/^(my|the|our)\s+/i, '')
    .replace(/'s\s+(house|home|place|address)\s*$/i, '')
    .replace(/'s\s*$/i, '')
    .trim();
}

/**
 * After normalizePersonTarget: if cleaned is "<rel>" or "<rel> <Name>",
 * return the name when name-shaped, else the relationship word.
 * 3+ tokens after the rel word are left unchanged.
 */
export function liftRelationshipName(cleaned: string): string {
  const parts = cleaned.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return cleaned;
  const relOnly = new RegExp(`^(${PERSON_RELATIONSHIP_ALTERNATION})$`, 'i');
  if (!relOnly.test(parts[0])) return cleaned;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && isNameShapedToken(parts[1])) return parts[1];
  return cleaned; // 3+ trailing tokens: out of scope, leave unchanged
}
