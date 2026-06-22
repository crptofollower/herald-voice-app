// src/hooks/llmLayers.ts
// Two-layer on-device LLM architecture for Herald.
//
// Layer 1 — classifyWithLLM: messy speech → structured IntentRecord JSON
//   Temperature 0.1, n_predict 80, 5s timeout.
//   Falls back to null on any failure — caller uses tierRouter regex as fallback.
//
// Layer 2 — phraseWithLLM: SQL result + persona context → natural sentence
//   Temperature 0.7, n_predict 100, 8s timeout.
//   Falls back to null — caller uses deterministic string.
//   NEVER used for medical reads (medical stays deterministic SQL template only).
//
// MedicalEvent import kept minimal — type only, no runtime dependency.

import type { LlamaContext } from 'llama.rn';
import { buildPersonaContext } from '../utils/personaContext';
import { getDB } from '../db/schema';

// ─── Intent types ─────────────────────────────────────────────────────────────

export type IntentRecord =
  | { type: 'list_add'; items: string[]; listName: string }
  | { type: 'list_remove'; item: string; listName: string }
  | { type: 'insurance_capture'; insType: string; carrier: string; agent?: string; phone?: string }
  | { type: 'medical_capture'; drug?: string; dosage?: string; frequency?: string; raw: string }
  | { type: 'service_capture'; category: string; name: string; phone?: string }
  | { type: 'family_capture'; relation: string; name: string; location?: string; phone?: string }
  | { type: 'todo_add'; body: string }
  | { type: 'todo_complete'; hint: string }
  | { type: 'pass' };

const CLASSIFY_TIMEOUT_MS = 5_000;
const PHRASE_TIMEOUT_MS = 8_000;

function extractJsonObject(raw: string): string | null {
  const m = raw.match(/\{[\s\S]*\}/);
  return m?.[0] ?? null;
}

// ─── Layer 1 — Classifier ─────────────────────────────────────────────────────

export async function classifyWithLLM(
  userText: string,
  ctx: LlamaContext | null,
  hints: { contacts: string[]; lists: string[]; name?: string },
): Promise<IntentRecord | null> {
  if (!ctx) return null;
  const trimmed = userText.trim();
  if (!trimmed) return null;

  const prompt = `You are Herald's on-device intent classifier.
Respond with ONE JSON object only. No prose. No markdown. No explanation.

INTENT SCHEMAS with EXAMPLES:

LIST ADD — ALWAYS split items into separate array entries, never one string:
{"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"I need apples oranges and milk" → {"type":"list_add","items":["apples","oranges","milk"],"listName":"grocery"}
"add eggs bread and butter to my grocery list" → {"type":"list_add","items":["eggs","bread","butter"],"listName":"grocery"}
"pick up milk oh and also get some apples and sourdough bread" → {"type":"list_add","items":["milk","apples","sourdough bread"],"listName":"grocery"}
"put call dentist on my to-do list" → {"type":"list_add","items":["call dentist"],"listName":"todo"}
"add pay bills and call mom to my to-do list" → {"type":"list_add","items":["pay bills","call mom"],"listName":"todo"}

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

SERVICE CAPTURE — plumbers, electricians, mechanics, contractors:
{"type":"service_capture","category":"plumber","name":"Joe","phone":"972-555-0100"}
"my plumber is Joe his number is 972-555-0100" → {"type":"service_capture","category":"plumber","name":"Joe","phone":"972-555-0100"}
"our electrician Mike his phone number is 214-555-0199" → {"type":"service_capture","category":"electrician","name":"Mike","phone":"214-555-0199"}
"the guy who fixes our AC is Bob" → {"type":"service_capture","category":"hvac","name":"Bob"}
"my mechanic is Steve" → {"type":"service_capture","category":"mechanic","name":"Steve"}

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
- "remove X replace with Y" for insurance = insurance_capture with new carrier Y, never list_remove
- "got X" or "picked up X" = list_remove
- "I need to add X to my grocery list" = list_add NOT todo_add — if user says "list" it's list_add
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
        n_predict: 80,
        temperature: 0.1,
        stop: ['\n\n', '<|end|>', '<|eot_id|>'],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('classify timeout')), CLASSIFY_TIMEOUT_MS),
      ),
    ]);

    const raw = result?.text?.trim();
    if (!raw) return null;
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as IntentRecord;
    if (parsed.type === 'pass') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Layer 2 — Voice wrapper ──────────────────────────────────────────────────

export async function phraseWithLLM(
  ctx: LlamaContext | null,
  args: {
    userQuestion: string;
    confirmedData: string;
    isMedical?: boolean;
  },
): Promise<string | null> {
  if (!ctx) return null;
  const data = args.confirmedData.trim();
  const question = args.userQuestion.trim();
  if (!data || !question) return null;

  // HARD RULE: never use LLM voice wrapper for medical reads.
  // Medical stays deterministic SQL template only.
  if (args.isMedical) return null;

  const personaBlock = buildPersonaContext(getDB());

  const prompt = `${personaBlock}
User asked: "${question.replace(/"/g, '\\"')}"
CONFIRMED DATA (these facts are authoritative — repeat them exactly, do not add or omit anything):
${data.replace(/"/g, '\\"')}
Do not add location claims, relationship history, or any detail not present in the CONFIRMED DATA above.
Reply in ONE warm spoken sentence as a friend who remembers. Under 25 words. No lists, no bullets.`;

  try {
    const result = await Promise.race([
      ctx.completion({
        messages: [{ role: 'user', content: prompt }],
        n_predict: 100,
        temperature: 0.7,
        stop: ['\n\n', '<|end|>', '<|eot_id|>'],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('phrase timeout')), PHRASE_TIMEOUT_MS),
      ),
    ]);

    const text = result?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
