// src/hooks/llmLayers.ts
// On-device intent classification for Herald.
//
// Layer 1 — classifyWithLLM: messy speech → structured IntentRecord JSON
//   Temperature 0, n_predict 256, 5s timeout.
//   Falls back to null on any failure — caller uses tierRouter regex as fallback.
//
// MedicalEvent import kept minimal — type only, no runtime dependency.

import type { LlamaContext } from 'llama.rn';
import { SERVICE_SYNONYMS, INSURANCE_SYNONYMS } from '../utils/householdRead';
import { FAMILY_SYNONYMS } from '../utils/familyRead';

// ─── Intent types ─────────────────────────────────────────────────────────────

export type IntentRecord =
  | { type: 'list_add'; items: string[]; listName: string }
  | { type: 'list_remove'; item: string; listName: string }
  | { type: 'insurance_capture'; insType: string; carrier: string; agent?: string; phone?: string }
  | { type: 'medical_capture'; drug?: string; dosage?: string; frequency?: string; raw: string }
  | { type: 'medical_visit'; doctor_name?: string; specialty?: string; advice?: string; raw: string }
  | { type: 'medical_visit_upcoming'; doctor_name?: string; specialty?: string; raw: string }
  | { type: 'doctor_intro_capture'; name: string; specialty: string; raw: string }
  | { type: 'service_capture'; category: string; name: string; phone?: string }
  | { type: 'family_capture'; relation: string; name: string; location?: string; phone?: string }
  | { type: 'phone_capture'; name: string; phone: string; relationship?: string }
  | { type: 'address_capture'; name: string; address: string }
  | { type: 'emergency_contact'; name: string; phone?: string }
  | { type: 'diagnosis_capture'; condition: string; raw: string }
  | { type: 'contact_call'; contact: string;
      candidates?: Array<{ name: string; relationship?: string; phone: string; importance: number }>;
      phonelessNames?: string[];
      devicePhone?: string; deviceName?: string; raw: string }
  | { type: 'todo_add'; body: string }
  | { type: 'todo_complete'; hint: string }
  | { type: 'pass' };

// Keep in sync with every type literal in IntentRecord above — cannot drift apart.
const KNOWN_TYPES = new Set<IntentRecord['type']>([
  'list_add', 'list_remove', 'insurance_capture', 'medical_capture',
  'medical_visit', 'medical_visit_upcoming', 'doctor_intro_capture',
  'service_capture', 'family_capture', 'phone_capture', 'address_capture',
  'emergency_contact', 'diagnosis_capture', 'contact_call',
  'todo_add', 'todo_complete', 'pass',
]);

const STEP_FORMS = [
  'stepson', 'stepdaughter', 'stepmother', 'stepfather',
  'stepbrother', 'stepsister',
]; // SESSION_W W3c: FAMILY_SYNONYMS ∪ step forms

const CLASSIFY_TIMEOUT_MS = 10_000;

function extractJsonObject(raw: string): string | null {
  const m = raw.match(/\{[\s\S]*\}/);
  return m?.[0] ?? null;
}

export function extractJsonArray(raw: string): string | null {
  // Prefer a top-level / prose array of objects. Nested arrays inside a bare
  // object (e.g. items:["apples"]) must not win over W2b object-wrap.
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr?.[0]) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (
        Array.isArray(parsed)
        && (parsed.length === 0
          || parsed.some(el => el !== null && typeof el === 'object' && !Array.isArray(el)))
      ) {
        return arr[0];
      }
    } catch {
      // fall through to bare-object wrap
    }
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj?.[0]) return `[${obj[0]}]`;
  return null;
}

export type ClassifierVocab = {
  knownLists: string[];      // caller passes hints.lists
  categories: Set<string>;   // will compile from SERVICE_SYNONYMS values
  insTypes: Set<string>;     // will compile from INSURANCE_SYNONYMS values
  relations: Set<string>;    // will compile from FAMILY_SYNONYMS keys+values + step forms
};

export function buildClassifierVocab(knownLists: string[]): ClassifierVocab {
  const categories = new Set<string>();
  for (const vals of Object.values(SERVICE_SYNONYMS)) {
    for (const v of vals) categories.add(v.toLowerCase());
  }
  const insTypes = new Set<string>();
  for (const vals of Object.values(INSURANCE_SYNONYMS)) {
    for (const v of vals) insTypes.add(v.toLowerCase());
  }
  const relations = new Set<string>();
  for (const [k, vals] of Object.entries(FAMILY_SYNONYMS)) {
    relations.add(k.toLowerCase());
    for (const v of vals) relations.add(v.toLowerCase());
  }
  for (const s of STEP_FORMS) relations.add(s.toLowerCase());
  return { knownLists, categories, insTypes, relations };
}

const ROUTING_FIELDS = new Set(['type', 'listName', 'category', 'insType', 'relation']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Standard verbatim span: whitespace-flexible word join; raw span wins (W3d). */
function findStandardSpan(rawUtterance: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean).map(escapeRegExp);
  const re = new RegExp(parts.join('\\s+'), 'i');
  const hit = rawUtterance.match(re);
  if (hit) return hit[0];
  // Model may collapse whitespace ("10mg" vs "10 mg") — still ground to utterance span.
  const collapsed = trimmed.replace(/\s+/g, '');
  if (collapsed.length === 0) return null;
  const soft = new RegExp(collapsed.split('').map(escapeRegExp).join('\\s*'), 'i');
  const softHit = rawUtterance.match(soft);
  return softHit ? softHit[0] : null;
}

function findPhoneSpan(rawUtterance: string, value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const re = new RegExp(digits.split('').map(escapeRegExp).join('[\\s\\-().+]*'), 'i');
  const hit = rawUtterance.match(re);
  return hit ? hit[0] : null;
}

export function verifyVerbatim(
  rec: IntentRecord, rawUtterance: string,
): IntentRecord | null {
  const out: Record<string, unknown> = { ...rec };

  if ('items' in out && Array.isArray(out.items)) {
    const grounded: string[] = [];
    for (const it of out.items as unknown[]) {
      if (typeof it !== 'string') continue;
      if (!it.trim()) continue;
      const span = findStandardSpan(rawUtterance, it);
      if (!span) return null;
      grounded.push(span);
    }
    out.items = grounded;
  }

  // W3d: raw_phrase remains the full original utterance, unconditionally.
  if ('raw' in out) out.raw = rawUtterance;

  for (const [key, val] of Object.entries(out)) {
    if (ROUTING_FIELDS.has(key)) continue;
    if (key === 'items') continue;
    if (key === 'raw') continue; // W3d: grounded above, never model-authored.
    if (typeof val !== 'string') continue;
    if (!val.trim()) continue;
    if (key === 'phone') {
      const span = findPhoneSpan(rawUtterance, val);
      if (!span) return null;
      out[key] = span;
      continue;
    }
    const span = findStandardSpan(rawUtterance, val);
    if (!span) return null;
    out[key] = span;
  }

  return out as unknown as IntentRecord;
}

function passesRoutingVocab(rec: IntentRecord, vocab: ClassifierVocab): boolean {
  const r = rec as Record<string, unknown>;
  if (typeof r.listName === 'string' && r.listName.trim()) {
    const ln = r.listName.trim().toLowerCase();
    const allowed = new Set([
      ...vocab.knownLists.map(l => l.toLowerCase()),
      'grocery',
      'todo',
    ]);
    if (!allowed.has(ln)) return false;
  }
  if (typeof r.category === 'string' && r.category.trim()) {
    if (!vocab.categories.has(r.category.trim().toLowerCase())) return false;
  }
  if (typeof r.insType === 'string' && r.insType.trim()) {
    if (!vocab.insTypes.has(r.insType.trim().toLowerCase())) return false;
  }
  if (typeof r.relation === 'string' && r.relation.trim()) {
    if (!vocab.relations.has(r.relation.trim().toLowerCase())) return false;
  }
  return true;
}

export function parseClassifierOutput(
  rawText: string, rawUtterance: string, vocab: ClassifierVocab,
): IntentRecord[] {
  const arrStr = extractJsonArray(rawText);
  if (!arrStr) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const objects = parsed.filter(
    (el): el is Record<string, unknown> => !!el && typeof el === 'object' && !Array.isArray(el),
  );
  // W2c — first 4 elements kept, before validation
  const capped = objects.slice(0, 4);
  const survivors: IntentRecord[] = [];
  for (const el of capped) {
    try {
      const rec = el as unknown as IntentRecord;
      if (!rec.type || rec.type === 'pass') continue;
      if (!KNOWN_TYPES.has(rec.type)) continue;
      if (!isCaptureComplete(rec)) continue;
      if (!passesRoutingVocab(rec, vocab)) continue;
      const verified = verifyVerbatim(rec, rawUtterance);
      if (!verified) continue;
      survivors.push(verified);
    } catch {
      continue;   // malformed element — drop it, siblings unaffected
    }
  }
  return survivors;
}

// Names that are placeholders, pronouns, or STT noise — not real captures.
// Mirrors the name.length>=2 floor in householdCapture.ts (one rule, two gates).
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'unnamed', 'none', 'n/a', 'someone', 'somebody',
  'that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them',
]);

function isRealName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
}

// Guard: a capture is only complete when all required slots have real values.
// Incomplete proposals return null → caller treats as pass → asks instead of inventing.
function isCaptureComplete(rec: IntentRecord): boolean {
  switch (rec.type) {
    case 'service_capture': {
      const hasCategory = !!rec.category?.trim();
      const hasPhone = !!rec.phone?.trim();
      if (isRealName(rec.name) && hasCategory) return true;
      // Partial but actionable — ChatScreen asks for missing name; don't drop to backend.
      if (hasCategory || hasPhone) return true;
      return false;
    }
    case 'family_capture':    return isRealName(rec.name) && !!rec.relation?.trim();
    case 'medical_capture':   return !!rec.drug?.trim();
    case 'medical_visit':     return !!(rec.doctor_name?.trim() || rec.specialty?.trim());
    case 'list_add':          return Array.isArray(rec.items) && rec.items.some(i => !!i?.trim());
    case 'list_remove':       return !!rec.item?.trim();
    case 'insurance_capture': return !!rec.carrier?.trim() && !!rec.insType?.trim();
    case 'todo_add':          return !!rec.body?.trim();
    case 'todo_complete':     return !!rec.hint?.trim();
    case 'phone_capture':
      return !!(rec.name?.trim() && rec.phone?.trim());
    case 'address_capture':
      return !!(rec.name?.trim() && rec.address?.trim());
    case 'emergency_contact':
      return !!(rec.name?.trim());
    case 'diagnosis_capture':
      return !!rec.condition?.trim();
    default:                  return true;
  }
}

// ─── Layer 1 — Classifier ─────────────────────────────────────────────────────

export async function classifyWithLLM(
  userText: string,
  ctx: LlamaContext | null,
  hints: { contacts: string[]; lists: string[]; name?: string },
): Promise<IntentRecord[]> {
  if (!ctx) return [];
  const trimmed = userText.trim();
  if (!trimmed) return [];

  const prompt = `You are Herald's on-device intent classifier.
Respond with a JSON ARRAY of 1-4 intent objects: [{...}]. Always an array,
even for a single intent. Output the array on ONE LINE. No prose. No
markdown. No explanation.

INTENT SCHEMAS with EXAMPLES:

LIST ADD — ALWAYS split items into separate array entries, never one string:
{"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"I need apples oranges and milk" → {"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"add pay bills and call mom to my to-do list" → {"type":"list_add","items":["pay bills","call mom"],"listName":"todo"}

LIST REMOVE — single item removal:
{"type":"list_remove","item":"milk","listName":"grocery"}
"I got the milk" → {"type":"list_remove","item":"milk","listName":"grocery"}

INSURANCE CAPTURE — replacing, updating, or stating insurance carrier:
{"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"my car insurance is Allstate" → {"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"remove Allstate and replace with Progressive" → {"type":"insurance_capture","insType":"auto","carrier":"Progressive"}

MEDICAL CAPTURE — medications only, never diagnoses:
{"type":"medical_capture","drug":"Lisinopril","dosage":"10mg","frequency":"daily","raw":"I take Lisinopril 10mg daily"}
"I'm on metformin" → {"type":"medical_capture","drug":"metformin","raw":"I'm on metformin"}

MEDICAL VISIT — doctor visits and appointments (never diagnoses, never medications):
{"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today"}
"I saw my cardiologist" → {"type":"medical_visit","specialty":"cardiologist","raw":"I saw my cardiologist"}

SERVICE CAPTURE — plumbers, electricians, mechanics, contractors:
{"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"my plumber is Joe his number is 555-0100" → {"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"my plumber number is 555-0104" → {"type":"service_capture","category":"plumber","name":"","phone":"555-0104"}

FAMILY CAPTURE — relationships and family members:
{"type":"family_capture","relation":"father-in-law","name":"David","location":"Little Elm Texas"}
"my son lives in New York City his name is Michael" → {"type":"family_capture","relation":"son","name":"Michael","location":"New York City"}

TODO ADD:
{"type":"todo_add","body":"call the dentist"}
"remind me to call the dentist" → {"type":"todo_add","body":"call the dentist"}

TODO COMPLETE:
{"type":"todo_complete","hint":"called dentist"}
"I called the dentist" → {"type":"todo_complete","hint":"called dentist"}

PASS — use when live data needed, unclear, or none of the above:
{"type":"pass"}

COMPOUND UTTERANCES — one sentence can carry MORE THAN ONE intent. Emit one
object per intent, in the order spoken:
"I'm taking lisinopril 5mg and I need apples" → [{"type":"medical_capture","drug":"lisinopril","dosage":"5mg","raw":"I'm taking lisinopril 5mg and I need apples"},{"type":"list_add","items":["apples"],"listName":"grocery"}]
"my plumber is Joe and remind me to call the dentist" → [{"type":"service_capture","category":"plumber","name":"Joe"},{"type":"todo_add","body":"call the dentist"}]
"I saw Dr. Reyes today and I need milk and eggs" → [{"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today and I need milk and eggs"},{"type":"list_add","items":["milk","eggs"],"listName":"grocery"}]
A single intent is still an array: "I need apples" → [{"type":"list_add","items":["apples"],"listName":"grocery"}]

CRITICAL RULES:
- ALWAYS respond with an array, on one line. Maximum 4 objects. Never more.
- ALWAYS split list items into array — "apples oranges milk" = ["apples","oranges","milk"], NEVER one string
- Drug names and dosages: copy VERBATIM from speech, never guess or correct spelling
- A visit specialty (cardiologist, dentist, doctor) is NEVER a doctor_name — put it in the specialty field, never invent a "Dr." name
- "remove X replace with Y" for insurance = insurance_capture with new carrier Y, never list_remove
- "got X" or "picked up X" = list_remove
- If user says "add X to my list" or "put X on my list" = ALWAYS list_add, never service_capture or todo_add — even if X sounds like a provider (dentist, plumber, doctor)
- todo_add only when no list name mentioned: "remind me to call dentist", "add pay bills to my to-do"
- Known contacts: ${hints.contacts.slice(0, 15).join(', ') || 'none'}
- Known lists: ${hints.lists.join(', ') || 'grocery, todo'}
- User name: ${hints.name ?? 'unknown'}
- When genuinely unclear → [{"type":"pass"}]

User: "${trimmed.replace(/"/g, '\\"')}"`;

  const __t0 = Date.now();
  try {
    const result = await Promise.race([
      ctx.completion({
        messages: [{ role: 'user', content: prompt }],
        n_predict: 256,
        temperature: 0,
        top_k: 1,
        seed: 0,
        stop: ['\n\n', '<|end|>', '<|eot_id|>'],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('classify timeout')), CLASSIFY_TIMEOUT_MS),
      ),
    ]);

    const raw = result?.text?.trim();
    console.log('[classifyWithLLM]', JSON.stringify({ ms: Date.now() - __t0, rawLen: raw?.length ?? 0 }));
    if (!raw) return [];
    const vocab = buildClassifierVocab(hints.lists);
    return parseClassifierOutput(raw, trimmed, vocab);
  } catch (e) {
    console.log('[classifyWithLLM] failed', JSON.stringify({ ms: Date.now() - __t0, error: String(e) }));
    return [];
  }
}
