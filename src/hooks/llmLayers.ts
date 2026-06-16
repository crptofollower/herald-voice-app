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
Respond with ONE JSON object only. No prose. No markdown.

INTENT SCHEMAS (use exact keys):
{"type":"list_add","items":["apple","milk"],"listName":"grocery"}
{"type":"list_remove","item":"milk","listName":"grocery"}
{"type":"insurance_capture","insType":"car","carrier":"Allstate","agent":"Karen","phone":"800-555-0100"}
{"type":"medical_capture","drug":"Lisinopril","dosage":"10mg","frequency":"daily","raw":"I take Lisinopril 10mg daily"}
{"type":"service_capture","category":"plumber","name":"Joe","phone":"972-555-0100"}
{"type":"family_capture","relation":"father-in-law","name":"David","location":"Little Elm Texas","phone":""}
{"type":"todo_add","body":"call the dentist"}
{"type":"todo_complete","hint":"called the dentist"}
{"type":"pass"}

Rules:
- Split shopping rambles into separate list_add items. Strip filler words like "oh" and "also".
- "is now with Progressive" or "switched to Progressive" → insurance_capture carrier=Progressive
- medical drug names and dosages: copy verbatim from user speech, never guess or correct
- known contacts: ${hints.contacts.slice(0, 15).join(', ') || 'none'}
- known lists: ${hints.lists.join(', ') || 'grocery, todo'}
- user name: ${hints.name ?? 'unknown'}
- needs live data, general knowledge, or truly unclear → {"type":"pass"}

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
