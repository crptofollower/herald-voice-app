// src/utils/phone.ts
// Device-side phone-number validation + formatting. No LLM, no network.
//
// Used by every phone-capture site (ChatScreen contact capture, pending
// call/text collect, householdCapture service/insurance) so a misheard number
// is caught and read back to the user BEFORE it is trusted.
//
// IMPORTANT: this validates digit COUNT and formats grouping only. It is
// format-checking, NOT content rewriting — consistent with the medical
// guardrail. It must NEVER be used on dosages, drug names, or any medical
// numeral; those are deterministic-template-only and are never normalized.

export type PhoneIssue = 'ok' | 'short' | 'long' | 'empty';

export interface PhoneResult {
  raw: string; // digits exactly as heard, after stripping non-digits
  normalized: string; // 10-digit US number when resolvable, else the raw digits
  valid: boolean; // true ONLY when it resolves to a 10-digit US number
  issue: PhoneIssue;
  spoken: string; // read-back-friendly string, e.g. "972-555-0100"
}

// "9725550100" → "972-555-0100"
export function formatUS(tenDigits: string): string {
  if (tenDigits.length !== 10) return groupForReadback(tenDigits);
  return `${tenDigits.slice(0, 3)}-${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
}

// Best-effort grouping so a malformed number can still be read back clearly.
function groupForReadback(d: string): string {
  if (d.length <= 4) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  // 11+ digits — group the extra so the user hears exactly what was captured
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export function normalizePhone(input: string): PhoneResult {
  const digits = (input ?? '').replace(/\D/g, '');

  if (digits.length === 0) {
    return { raw: '', normalized: '', valid: false, issue: 'empty', spoken: '' };
  }

  // US country code: a legit 11-digit number starting with 1 → drop the 1.
  let core = digits;
  if (core.length === 11 && core.startsWith('1')) {
    core = core.slice(1);
  }

  if (core.length === 10) {
    return {
      raw: digits,
      normalized: core,
      valid: true,
      issue: 'ok',
      spoken: formatUS(core),
    };
  }

  return {
    raw: digits,
    normalized: core,
    valid: false,
    issue: core.length < 10 ? 'short' : 'long',
    spoken: groupForReadback(core),
  };
}