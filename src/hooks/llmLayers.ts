// src/hooks/llmLayers.ts
// On-device intent classification for Herald.
//
// Layer 1 — classifyWithLLM: messy speech → structured IntentRecord JSON
//   Temperature 0, n_predict 120, 5s timeout.
//   Falls back to null on any failure — caller uses tierRouter regex as fallback.
//
// MedicalEvent import kept minimal — type only, no runtime dependency.

import type { LlamaContext } from 'llama.rn';

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

const CLASSIFY_TIMEOUT_MS = 5_000;

function extractJsonObject(raw: string): string | null {
  const m = raw.match(/\{[\s\S]*\}/);
  return m?.[0] ?? null;
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
Respond with ONE JSON object only. No prose. No markdown. No explanation.

INTENT SCHEMAS with EXAMPLES:

LIST ADD — ALWAYS split items into separate array entries, never one string:
{"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"I need apples oranges and milk" → {"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"add eggs bread and butter to my grocery list" → {"type":"list_add","items":["eggs","bread","butter"],"listName":"grocery"}
"pick up milk oh and also get some apples and sourdough bread" → {"type":"list_add","items":["milk","apples","sourdough bread"],"listName":"grocery"}
"I need to pick up rib eyes I need to pick up apples some oranges and some cleaning supplies" → {"type":"list_add","items":["rib eyes","apples","oranges","cleaning supplies"],"listName":"grocery"}
"put call dentist on my to-do list" → {"type":"list_add","items":["call dentist"],"listName":"todo"}
"add pay bills and call mom to my to-do list" → {"type":"list_add","items":["pay bills","call mom"],"listName":"todo"}
"add call my dentist to my to-do list" → {"type":"list_add","items":["call my dentist"],"listName":"todo"}
"add the dentist to my to-do list" → {"type":"list_add","items":["the dentist"],"listName":"todo"}

LIST REMOVE — single item removal:
{"type":"list_remove","item":"milk","listName":"grocery"}
"I got the milk" → {"type":"list_remove","item":"milk","listName":"grocery"}
"take eggs off my grocery list" → {"type":"list_remove","item":"eggs","listName":"grocery"}
"crossed off bread" → {"type":"list_remove","item":"bread","listName":"grocery"}
"I picked up the apples" → {"type":"list_remove","item":"apples","listName":"grocery"}

INSURANCE CAPTURE — replacing, updating, or stating insurance carrier:
{"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"my car insurance is Allstate" → {"type":"insurance_capture","insType":"car","carrier":"Allstate"}
"my home insurance is with State Farm" → {"type":"insurance_capture","insType":"home","carrier":"State Farm"}
"remove Allstate and replace with Progressive" → {"type":"insurance_capture","insType":"auto","carrier":"Progressive"}
"I switched my car insurance to Progressive" → {"type":"insurance_capture","insType":"car","carrier":"Progressive"}
"can you remove Allstate and replace it with Progressive for my insurance" → {"type":"insurance_capture","insType":"auto","carrier":"Progressive"}
"my insurance is now with Geico" → {"type":"insurance_capture","insType":"auto","carrier":"Geico"}

MEDICAL CAPTURE — medications only, never diagnoses:
{"type":"medical_capture","drug":"Lisinopril","dosage":"10mg","frequency":"daily","raw":"I take Lisinopril 10mg daily"}
"I take Lisinopril 10mg" → {"type":"medical_capture","drug":"Lisinopril","dosage":"10mg","raw":"I take Lisinopril 10mg"}
"I'm on metformin" → {"type":"medical_capture","drug":"metformin","raw":"I'm on metformin"}
"I started taking vitamin D 2000 IU every morning" → {"type":"medical_capture","drug":"vitamin D","dosage":"2000 IU","frequency":"every morning","raw":"I started taking vitamin D 2000 IU every morning"}
"stop taking metformin" → {"type":"list_remove","item":"metformin","listName":"medications"}

MEDICAL VISIT — doctor visits and appointments (never diagnoses, never medications):
{"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today"}
"I saw Dr. Reyes today" → {"type":"medical_visit","doctor_name":"Dr. Reyes","raw":"I saw Dr. Reyes today"}
"I saw my cardiologist" → {"type":"medical_visit","specialty":"cardiologist","raw":"I saw my cardiologist"}
"my doctor told me to cut salt" → {"type":"medical_visit","specialty":"doctor","advice":"cut salt","raw":"my doctor told me to cut salt"}

SERVICE CAPTURE — plumbers, electricians, mechanics, contractors:
{"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"my plumber is Joe his number is 555-0100" → {"type":"service_capture","category":"plumber","name":"Joe","phone":"555-0100"}
"our electrician Mike his phone number is 555-0101" → {"type":"service_capture","category":"electrician","name":"Mike","phone":"555-0101"}
"the guy who fixes our AC is Bob" → {"type":"service_capture","category":"hvac","name":"Bob"}
"my HVAC guy is Ed, 555-0102" → {"type":"service_capture","category":"hvac","name":"Ed","phone":"555-0102"}
"my air conditioning guy is Ed" → {"type":"service_capture","category":"hvac","name":"Ed"}
"my heating and cooling person is Ed" → {"type":"service_capture","category":"hvac","name":"Ed"}
"my furnace guy is Ed" → {"type":"service_capture","category":"hvac","name":"Ed"}
"my pest control guy is Ray, 555-0103" → {"type":"service_capture","category":"pest control","name":"Ray","phone":"555-0103"}
"my exterminator is Ray" → {"type":"service_capture","category":"pest control","name":"Ray"}
"my mechanic is Steve" → {"type":"service_capture","category":"mechanic","name":"Steve"}
"my plumber number is 555-0104" → {"type":"service_capture","category":"plumber","name":"","phone":"555-0104"}
"electrician number is 555-0105" → {"type":"service_capture","category":"electrician","name":"","phone":"555-0105"}

FAMILY CAPTURE — relationships and family members:
{"type":"family_capture","relation":"father-in-law","name":"David","location":"Little Elm Texas"}
"my father-in-law David lives in Little Elm Texas" → {"type":"family_capture","relation":"father-in-law","name":"David","location":"Little Elm Texas"}
"my son lives in New York City his name is Michael" → {"type":"family_capture","relation":"son","name":"Michael","location":"New York City"}
"my daughter is Sarah she lives in Austin" → {"type":"family_capture","relation":"daughter","name":"Sarah","location":"Austin"}
"my mom's name is Barbara" → {"type":"family_capture","relation":"mother","name":"Barbara"}

TODO ADD:
{"type":"todo_add","body":"call the dentist"}
"remind me to call the dentist" → {"type":"todo_add","body":"call the dentist"}
"add pick up prescription to my to-do" → {"type":"todo_add","body":"pick up prescription"}

TODO COMPLETE:
{"type":"todo_complete","hint":"called dentist"}
"I called the dentist" → {"type":"todo_complete","hint":"called dentist"}
"done with the prescription pickup" → {"type":"todo_complete","hint":"prescription pickup"}

PASS — use when live data needed, unclear, or none of the above:
{"type":"pass"}

CRITICAL RULES:
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
- When genuinely unclear → {"type":"pass"}

User: "${trimmed.replace(/"/g, '\\"')}"`;

  try {
    const result = await Promise.race([
      ctx.completion({
        messages: [{ role: 'user', content: prompt }],
        n_predict: 120,
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
    if (!raw) return [];
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) return [];
    const parsed = JSON.parse(jsonStr) as IntentRecord;
    if (parsed.type === 'pass') return [];
    if (!isCaptureComplete(parsed)) return [];
    return [parsed];
  } catch {
    return [];
  }
}
