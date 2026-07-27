// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord, ClassifyOutcome } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';
import { writeServiceProvider, detectServiceCapture, detectPhoneCapture, detectInsuranceCapture, captureHouseholdInsurance, normalizeCarrier } from '../utils/householdCapture';
import { detectDiagnosisCapture, detectDoctorIntroCapture, detectMedicalEvent } from '../utils/detectMedicalEvent';
import { detectFamilyCapture } from '../utils/familyCapture';
import { getDB } from '../db/schema';
import { capturePerson } from '../db/capturePerson';
import { findContactByName, setEmergencyContact, getEmergencyContact, retireRelationshipHolder, RELATIONSHIP_WORDS, resolvePersonIdentity, contactHasCapability, resolvePersonCapability } from '../db/contactsDB';
import { normalizePersonTarget, liftRelationshipName } from '../utils/personReference';

type ActionIntent = NonNullable<TierDecision['actionIntent']>;

export type RouteDecision =
  | { kind: 'device_read'; tier: 1; response: string; isMedical?: boolean; reason: string }
  | { kind: 'device_action'; tier: 1; actionIntent: ActionIntent; reason: string }
  | { kind: 'capture'; intents: IntentRecord[]; source: 'deterministic' | 'llm'; reason: string }
  | { kind: 'not_ready'; reason: string }
  | { kind: 'memory_probe'; tier: 2; context: LocalContext; reason: string }
  | { kind: 'backend'; tier: 3; reason: string }
  | { kind: 'needs_clarification'; guess?: string; reason: string }

// ─── Routing authority scaffolding (Commit 1) ────────────────────────────────
// CommitResult: the only gate for ACK strings. A string is never spoken for a
// write that was not verified. Added here; wired to domains one commit at a time.

export type CommitResult =
  | { status: 'committed'; ack: string;
      effect?:
        | { kind: 'dial'; phone: string; failAck: string }
        | { kind: 'sms'; phone: string; body?: string; failAck: string }
        | { kind: 'navigate'; address: string; failAck: string } }
  | { status: 'pending';   prompt: string; pendingKey: string;
      kind?: 'standard' | 'destructive';
      reaskPrompt?: string;
      resume: (userText: string) => Promise<CommitResult> }
  | { status: 'noop';      ack: string }
  | { status: 'failed';    ack: string };

export type ResolveContactFn = (n: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;

export interface DomainWriter {
  add(intent: IntentRecord, rawPhrase: string, ctx?: { resolveContact?: ResolveContactFn }): Promise<CommitResult>;
  remove(item: string): Promise<CommitResult>;
  clear(): Promise<CommitResult>;
}

export type CaptureContext = { contacts: string[]; lists: string[]; name?: string };
export type DeterministicCapturer = (text: string, ctx: CaptureContext) => IntentRecord[];

// Deterministic capture floor (tier-2). First non-empty result wins — capturers are
// NEVER merged (merging is the parallel-island bug). The on-device LLM (tier-3) is
// reached only when every capturer here returns []. One entry today; phone/list/todo
// follow, one per gated commit.
const DETERMINISTIC_CAPTURERS: DeterministicCapturer[] = [
  (text) => detectDoctorIntroCapture(text),
  (text) => detectInsuranceCapture(text),
  (text) => detectServiceCapture(text),
  (text, ctx) => detectPhoneCapture(text, ctx.contacts),
  (text) => detectDiagnosisCapture(text),
  (text) => detectFamilyCapture(text),
];

export async function resolveContactCallIntent(
  contactName: string,
  raw: string,
  deps: {
    resolveContact?: (n: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;
  },
): Promise<IntentRecord> {
  const cleaned = liftRelationshipName(normalizePersonTarget(contactName));

  const identity = resolvePersonIdentity(contactName);

  if (identity.status === 'ambiguous') {
    return {
      type: 'contact_call',
      contact: contactName,
      candidates: identity.candidates.map(c => ({
        name: c.name,
        relationship: c.relationship,
        phone: (c.phone ?? '').trim(),
        importance: c.importance,
      })),
      raw,
    };
  }

  if (identity.status === 'single') {
    const c = identity.contact;
    const cap = await resolvePersonCapability(c, 'phone');
    if (cap.status === 'available') {
      return {
        type: 'contact_call',
        contact: contactName,
        candidates: [{
          name: c.name,
          relationship: c.relationship,
          phone: cap.value,
          importance: c.importance,
        }],
        raw,
      };
    }
    if (cap.status === 'ambiguous') {
      // OS returned multiple phones for this known person — ask, never top-1.
      return {
        type: 'contact_call',
        contact: contactName,
        candidates: cap.candidates.map(x => ({
          name: x.name,
          phone: (x.phone ?? '').trim(),
          importance: 5,
        })),
        raw,
      };
    }
    // Known person, no phone in Herald or OS — empty-phone candidate → writer known-missing collect.
    return {
      type: 'contact_call',
      contact: contactName,
      candidates: [{
        name: c.name,
        relationship: c.relationship,
        phone: '',
        importance: c.importance,
      }],
      raw,
    };
  }

  // identity.status === 'none' — temporary exception: existing OS fall-through.
  const deviceQuery = cleaned || contactName.trim().toLowerCase()
    .replace(/[\u2018\u2019\u02BC\u0060]/g, "'")
    .replace(/^(?:my|the|a)\s+/, '');
  const device = deps.resolveContact ? await deps.resolveContact(deviceQuery) : null;
  if (device && device.phone) {
    return { type: 'contact_call', contact: contactName, devicePhone: device.phone, deviceName: device.name, raw };
  }
  if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
    const candidates = device.deviceCandidates.map(c => ({
      name: c.name,
      phone: c.phone,
      importance: 5,
    }));
    return { type: 'contact_call', contact: contactName, candidates, raw };
  }
  return { type: 'contact_call', contact: contactName, raw };
}

// DD-2 (PENDING_UNIFICATION spec): LLM 'call' intents map to contact_call
// BEFORE any allConverted check — one call-confirm authority (§4a).
export async function mapCallIntents(
  intents: IntentRecord[],
  rawText: string,
  deps: { resolveContact?: Parameters<typeof resolveContactCallIntent>[2]['resolveContact'] },
): Promise<IntentRecord[]> {
  const out: IntentRecord[] = [];
  for (const i of intents) {
    if (i.type === 'call' && typeof (i as any).contact === 'string') {
      const contactName = ((i as any).contact as string)
        .replace(/\s+(?:at|on|using|with|via)\b.*/i, '').trim();
      if (contactName) {
        out.push(await resolveContactCallIntent(contactName, rawText, deps));
        continue;
      }
    }
    out.push(i);
  }
  return out;
}

// Registry: empty now. One domain added per conversion commit.
export const DOMAIN_WRITERS: Partial<Record<string, DomainWriter>> = {
  service_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'service_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { category, name, phone } = intent;
      const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone',
        'somebody','that','this','it','he','she','they','him','her','them',
        'guy','gal','lady','person','man','woman','dude','fellow','girl','folks']);
      const isRealName = (v: string): boolean => {
        if (typeof v !== 'string') return false;
        const t = v.trim();
        if (t.length < 2) return false;
        if (PLACEHOLDER_NAMES.has(t.toLowerCase())) return false;
        if (/^\d[\d\s\-\(\)\+\.]*$/.test(t)) return false; // digit-only
        const first = t.split(/\s+/)[0].toLowerCase();
        const STOP_WORDS = new Set([
          'what','whats',"what's",'who','when','where','why','how',
          'my','our','his','her','their','your','its',
          'the','a','an','this','that','these','those',
          'never','no','nope','nah','cancel','stop','ok','okay',
          // Imperative action verbs — never a valid service-provider name.
          // Last-line-of-defence: blocks "Delete"/"Remove" leaking in as names
          // if the LLM classifies a removal utterance as service_capture.
          'delete','remove','clear','erase','update','change',
        ]);
        if (STOP_WORDS.has(first)) return false;
        return true;
      };
      if (!category?.trim()) {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const commit = (nm: string): CommitResult => {
        const spId = writeServiceProvider(category, nm, phone);
        if (!spId) {
          return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
        }
        const phoneForAck = phone && /^\d{10}$/.test(phone)
          ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6, 10)}`
          : phone;
        const numberPart = phoneForAck ? ` — you can reach them at ${phoneForAck}` : '';
        return { status: 'committed', ack: `Got it — ${nm} is your ${category}${numberPart}.` };
      };

      const extractName = (raw: string): string | null => {
        let t = raw.trim().replace(/[.!?]+$/, '');
        // Strip common lead-ins so "It's Joe" → "Joe", "His name is Joe" → "Joe"
        t = t.replace(/^(it'?s|that'?s|his name is|her name is|the name is|he'?s|she'?s|call (?:him|her)|name'?s|the (?:guy|person) is)\s+/i, '');
        // If what remains looks like a NEW capture command, abort — do not treat
        // "My roofer is 552-03303" as a name when pending electrician.
        if (/^(my|our)\s+\w/i.test(t)) return null;
        const first = t.split(/\s+/)[0];
        if (!first) return null;
        // Reuse the hardened isRealName check on the extracted first word
        if (!isRealName(first)) return null;
        // Must look like a name: starts alpha, only alpha/apostrophe/hyphen,
        // max 2 words (handles "Mary Beth"), not all-caps abbreviation
        if (!/^[A-Za-z][a-zA-Z'\-]+$/.test(first)) return null;
        return first;
      };

      if (!isRealName(name)) {
        const prompt = phone
          ? `Who's your ${category} at ${phone}?`
          : `I didn't catch the name — who's your ${category}?`;
        return {
          status: 'pending', prompt, pendingKey: 'service_capture',
          resume: async (userText: string): Promise<CommitResult> => {
            const nm = extractName(userText);
            if (!nm) return { status: 'noop', ack: '' }; // non-answer → caller re-routes, no write
            return commit(nm);
          },
        };
      }
      return commit(name);
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: `I can't take that off just yet — but I've still got it, and I won't lose it.` };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: `I can't take that off just yet — but I've still got it, and I won't lose it.` };
    },
  },
  list_add: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'list_add') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const rawListName = intent.listName ?? 'grocery';
      const listName = rawListName === 'todo' ? 'todos' : rawListName;
      const itemList = (intent.items ?? []).filter(i => i?.trim().length > 0);
      if (itemList.length === 0) {
        return { status: 'failed', ack: `What did you want to add to your ${listName} list?` };
      }
      const db = getDB();
      let list = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?`, [listName]);
      const now = new Date().toISOString();
      let addedCount = 0;
      // Same transaction pattern as calendarCacheDB: BEGIN IMMEDIATE / COMMIT / ROLLBACK
      // so list creation + item inserts are atomic (no partial multi-item write).
      try {
        db.execSync('BEGIN IMMEDIATE;');
      } catch (beginErr) {
        console.error('[LIST_ADD_BEGIN_FAILED]', beginErr);
        throw beginErr;
      }
      try {
        if (!list) {
          const listId = `list_${Date.now()}`;
          db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`, [listId, listName, now]);
          list = { id: listId };
        }
        for (const item of itemList) {
          const exists = db.getFirstSync<{ id: string }>(
            `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
             WHERE l.name = ? AND lower(li.body) = lower(?) AND li.checked = 0`,
            [listName, item],
          );
          if (!exists) {
            db.runSync(
              `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?)`,
              [`item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, list.id, item, now],
            );
            addedCount++;
          }
        }
        db.execSync('COMMIT;');
      } catch (err) {
        console.error('[LIST_ADD_CATCH]', err);
        db.execSync('ROLLBACK;');
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      if (addedCount === 0) {
        return { status: 'noop', ack: `${itemList.length === 1 ? `${itemList[0]} was` : 'Those were'} already on your ${listName} list.` };
      }
      if (addedCount === 1) {
        return { status: 'committed', ack: `Got it — ${itemList[0]} is on your ${listName} list.` };
      }
      return { status: 'committed', ack: `Got it — added ${addedCount} items to your ${listName} list.` };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  todo_add: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'todo_add') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const body = intent.body?.trim();
      if (!body || body.length < 2) {
        return { status: 'failed', ack: "What did you want me to remember to do?" };
      }
      const db = getDB();
      let todoList = db.getFirstSync<{ id: string }>(`SELECT id FROM lists WHERE name = ?`, ['todos']);
      if (!todoList) {
        const listId = `list_todos_${Date.now()}`;
        db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`, [listId, 'todos', new Date().toISOString()]);
        todoList = { id: listId };
      }
      const exists = db.getFirstSync<{ id: string }>(
        `SELECT li.id FROM list_items li JOIN lists l ON l.id = li.list_id
         WHERE l.name = 'todos' AND lower(li.body) = lower(?) AND li.checked = 0`,
        [body],
      );
      if (exists) {
        return { status: 'noop', ack: `That's already on your to-do list.` };
      }
      db.runSync(
        `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, 0, ?)`,
        [`todo_${Date.now()}`, todoList.id, body, new Date().toISOString()],
      );
      const openCount = db.getFirstSync<{ n: number }>(
        `SELECT COUNT(*) as n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'todos' AND li.checked = 0`,
      )?.n ?? 1;
      const ack = openCount === 1
        ? `Got it — '${body}' is on your to-do list.`
        : `Got it — '${body}' added. You've got ${openCount} open to-dos.`;
      return { status: 'committed', ack };
    },
    async remove(item: string): Promise<CommitResult> {
      const db = getDB();
      const row = db.getFirstSync<{ id: string; body: string; checked: number }>(
        `SELECT id, body, checked FROM list_items WHERE id = ?;`,
        [item],
      );
      if (!row || row.checked !== 0) {
        return { status: 'noop', ack: "I don't have that on your list anymore." };
      }
      const body = row.body;
      return {
        status: 'pending',
        kind: 'standard',
        prompt: `Just to make sure — you're saying you've completed '${body}'? I can mark that off your list.`,
        pendingKey: 'todo_complete',
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: `Got it — leaving '${body}' on your list.` };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            try {
              const now = new Date().toISOString();
              db.runSync(
                `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?;`,
                [now, item],
              );
            } catch {
              return { status: 'failed', ack: "Couldn't update that. Try again." };
            }
            return { status: 'committed', ack: `Done — crossed off '${body}'.` };
          }
          return { status: 'noop', ack: '' };
        },
      };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  phone_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'phone_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const phone = intent.phone?.trim();
      const relationship = intent.relationship?.trim() || undefined;
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — who's number is that?" };
      }
      if (!phone || phone.length < 7) {
        return { status: 'failed', ack: "I didn't catch the number — can you say it again?" };
      }
      try {
        capturePerson({ name, phone, relationship });
        const saved = findContactByName(name);
        if (!saved) {
          return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
        }
        const relPart = relationship ? `, your ${relationship},` : '';
        const formattedPhone = phone && /^\d{10}$/.test(phone.replace(/\D/g,''))
          ? `(${phone.replace(/\D/g,'').slice(0,3)}) ${phone.replace(/\D/g,'').slice(3,6)}-${phone.replace(/\D/g,'').slice(6)}`
          : phone;
        return { status: 'committed', ack: `Got it — ${name}${relPart} at ${formattedPhone}.` };
      } catch {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  address_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'address_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const address = intent.address?.trim();
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — whose address is that?" };
      }
      if (!address || address.length < 5) {
        return { status: 'failed', ack: "I didn't catch the address — can you say it again?" };
      }
      try {
        capturePerson({ name, address });
        const saved = findContactByName(name);
        if (!saved) {
          return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
        }
        return { status: 'committed', ack: `Got it — I'll remember that for next time you need directions.` };
      } catch {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  family_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'family_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone',
        'somebody','that','this','it','he','she','they','him','her','them']);
      const isRealName = (v: unknown): v is string => {
        if (typeof v !== 'string') return false;
        const t = v.trim();
        return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
      };
      const famName = intent.name?.trim();
      const relation = intent.relation?.trim();
      const location = intent.location?.trim() || undefined;
      if (!relation) {
        return { status: 'failed', ack: "I didn't catch the relationship — who are they to you?" };
      }
      if (!isRealName(famName)) {
        return { status: 'failed', ack: `I didn't catch the name — who is your ${relation}?` };
      }
      const confirmPrompt = location
        ? `${famName}, your ${relation}, in ${location} — that right?`
        : `${famName}, your ${relation} — that right?`;
      return {
        status: 'pending',
        prompt: confirmPrompt,
        pendingKey: 'family_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|affirmative|confirmed|confirm|y)[\s.,!]*$/i;
          const NO = /^(no|nope|nah|wrong|incorrect|that'?s wrong|not right|cancel|nevermind|never mind)[\s.,!]*$/i;
          if (NO.test(userText.trim())) {
            return {
              status: 'pending',
              prompt: `No problem — what's the correct name?`,
              pendingKey: 'family_capture_correction',
              resume: async (correctionText: string): Promise<CommitResult> => {
                const correctedName = correctionText.trim();
                if (!isRealName(correctedName)) {
                  return { status: 'noop', ack: '' };
                }
                try {
                  const { capturePerson } = await import('../db/capturePerson');
                  const { findContactByName } = await import('../db/contactsDB');
                  capturePerson({ name: correctedName, relationship: relation, location });
                  const saved = findContactByName(correctedName);
                  if (!saved) {
                    return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                  }
                  const ack = location
                    ? `Got it — I'll remember ${correctedName} is your ${relation} in ${location}.`
                    : `Got it — I'll remember ${correctedName} is your ${relation}.`;
                  return { status: 'committed', ack };
                } catch {
                  return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
                }
              },
            };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { capturePerson } = await import('../db/capturePerson');
            const { findContactByName } = await import('../db/contactsDB');
            capturePerson({ name: famName, relationship: relation, location });
            const saved = findContactByName(famName);
            if (!saved) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            const ack = location
              ? `Got it — I'll remember ${famName} is your ${relation} in ${location}.`
              : `Got it — I'll remember ${famName} is your ${relation}.`;
            return { status: 'committed', ack };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  emergency_contact: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'emergency_contact') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const phone = intent.phone?.trim() || undefined;
      if (!name || name.length < 2) {
        return { status: 'failed', ack: "I didn't catch the name — who's your emergency contact?" };
      }
      try {
        setEmergencyContact(name, phone);
        const saved = getEmergencyContact();
        if (!saved) {
          return { status: 'failed', ack: "Something went wrong holding onto that. Try again." };
        }
        const ack = phone
          ? `Got it — if you ever need help, I'll reach ${name} at that number.`
          : `Got it — ${name} is your emergency contact. Tell me their number when you get a chance.`;
        return { status: 'committed', ack };
      } catch {
        return { status: 'failed', ack: "Something went wrong holding onto that. Try again." };
      }
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  medical_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const raw = intent.raw ?? rawPhrase;
      const { guessMedicationName } = await import('../db/medicalDB');
      const name = intent.drug?.trim() || guessMedicationName(raw);
      const dosage = intent.dosage?.trim() || undefined;
      if (!name || name.trim().length < 2) {
        return { status: 'failed', ack: 'What medication is that?' };
      }
      const { isMedicationCorroborated } = await import('../db/factDB');
      const confirmPrompt = isMedicationCorroborated(raw)
        ? (dosage ? `Got it — ${name}, ${dosage}. Sound right?` : `Got it — ${name}. Sound right?`)
        : `Want me to remember ${name} as a medication?`;
      return {
        status: 'pending',
        prompt: confirmPrompt,
        pendingKey: 'medical_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) return { status: 'noop', ack: `No problem — I won't add that.` };
          if (!YES.test(userText.trim())) return { status: 'noop', ack: '' };
          try {
            const { confirmMedicationCapture, getActiveMedications } = await import('../db/medicalDB');
            const result = confirmMedicationCapture(name, dosage, raw);
            const verified = getActiveMedications().some(m => m.id === result.id);
            if (!verified) {
              return { status: 'failed', ack: "I'm having trouble holding onto that — say it once more?" };
            }
            if (result.action === 'superseded') {
              return { status: 'committed',
                ack: dosage ? `Got it — updated your ${name} to ${dosage}.` : `Got it — updated your ${name}.` };
            }
            return { status: 'committed',
              ack: dosage ? `Got it — I'll remember ${name}, ${dosage}, with your medications.`
                          : `Got it — I'll remember ${name} with your medications.` };
          } catch {
            return { status: 'failed', ack: "I'm having trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      try {
        const { deactivateMedicationByName } = await import('../db/medicalDB');
        const changes = deactivateMedicationByName(item);
        return changes > 0
          ? { status: 'committed', ack: `Got it — took ${item} off your current medications.` }
          : { status: 'noop', ack: `I don't have ${item} in your current medications.` };
      } catch { return { status: 'failed', ack: "I couldn't do that right now — try again." }; }
    },
    async clear(): Promise<CommitResult> {
      // Destructive class (Spine §4a + S_DISCLOSE §4.5): clear NEVER executes
      // without an explicit anchored YES. Ambiguity releases, never wipes.
      let count = 0;
      try {
        const { getActiveMedications } = await import('../db/medicalDB');
        count = getActiveMedications().length;
      } catch {
        return { status: 'failed', ack: "I couldn't do that right now — try again." };
      }
      if (count === 0) {
        return { status: 'noop', ack: `You don't have any medications saved right now.` };
      }
      return {
        status: 'pending',
        kind: 'destructive',
        prompt: `This will remove all ${count} of your medications. Are you sure?`,
        pendingKey: 'medical_clear',
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: `Okay — I left your medications as they are.` };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            let removed = 0;
            try {
              const { clearAllMedications } = await import('../db/medicalDB');
              removed = clearAllMedications();
            } catch {
              return { status: 'failed', ack: "I couldn't do that right now — try again." };
            }
            return { status: 'committed',
              ack: removed > 0
                ? `Done — cleared ${removed} ${removed === 1 ? 'medication' : 'medications'}. You can start fresh anytime.`
                : `There were no active medications to clear.` };
          }
          return { status: 'noop', ack: '' }; // ambiguous → primitive releases; never executes
        },
      };
    },
  },
  medical_visit: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_visit') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { writeMedicalRecord } = await import('../db/medicalDB');
      const { extractDoctorName } = await import('../utils/detectMedicalEvent');
      const { parseDatePhrase } = await import('../utils/parseTime');
      const raw = intent.raw ?? rawPhrase;
      const advice = intent.advice?.trim();
      const visitDate = parseDatePhrase(raw) ?? new Date().toLocaleDateString('en-CA');

      const commitVisit = (doctorName: string): CommitResult => {
        writeMedicalRecord({
          doctor_name: doctorName,
          notes: advice ? `${raw} — ${advice}` : raw,
          visit_date: visitDate,
        });
        return { status: 'committed', ack: `Got it — I'll remember you saw ${doctorName}.` };
      };

      // A clean doctor name is HEARD (Dr. X), not guessed → write immediately
      // (Spine §3/§5). No confirm gate — unlike a guessed drug name.
      const heardName = intent.doctor_name?.trim();
      if (heardName) return commitVisit(heardName);

      // No clean name (specialty-only / nameless) → ask, write NOTHING (Spine §5,
      // Graceful Confusion). Replaces the old writeClarification('', ...) empty-id bug.
      return {
        status: 'pending',
        prompt: 'Got it — who did you see?',
        pendingKey: 'medical_visit',
        resume: async (userText: string): Promise<CommitResult> => {
          let name = extractDoctorName(userText);
          if (!name) {
            const t = userText.trim().replace(/[.!?]+$/, '')
              .replace(/^(it'?s|that'?s|i saw|i went to|his name is|her name is|the name is|it was)\s+/i, '');
            const first = t.split(/\s+/).slice(0, 2).join(' ');
            if (/^[A-Za-z][a-zA-Z'\-]+(?:\s+[A-Za-z][a-zA-Z'\-]+)?$/.test(first) && first.length >= 2) {
              name = first;
            }
          }
          if (!name) return { status: 'noop', ack: '' }; // not a name → caller re-routes
          return commitVisit(name);
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      // medical_records.removed_at landed in schema v18. A visit-remove path can
      // now soft-delete; left as a deliberate noop until a visit-remove utterance
      // is actually wired. Never a hard delete.
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  medical_visit_upcoming: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'medical_visit_upcoming') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { writeMedicalRecord, passesSubstringGate } = await import('../db/medicalDB');
      const { parseDatePhrase, formatSpokenDate } = await import('../utils/parseTime');
      const raw = intent.raw ?? rawPhrase;
      const doctorNameRaw = intent.doctor_name?.trim();
      const doctorName = (doctorNameRaw && passesSubstringGate(doctorNameRaw, raw)) ? doctorNameRaw : undefined;

      const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
      const NO = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;

      const commitUpcoming = (resolvedDate: string): CommitResult => {
        writeMedicalRecord({
          doctor_name: doctorName,
          notes: raw,
          visit_date: resolvedDate,
          status: 'upcoming',
        });
        return { status: 'committed', ack: "Got it — I'll remind you." };
      };

      const confirmStage = (resolvedDate: string): CommitResult => {
        const spoken = formatSpokenDate(resolvedDate);
        const who = doctorName ? ` with ${doctorName}` : '';
        return {
          status: 'pending',
          prompt: `Say yes and I'll remember — appointment${who} ${spoken}.`,
          pendingKey: 'medical_visit_upcoming',
          resume: async (userText: string): Promise<CommitResult> => {
            if (NO.test(userText.trim())) {
              return { status: 'noop', ack: "No problem — tell me again and I'll get it right." };
            }
            if (!YES.test(userText.trim())) return { status: 'noop', ack: '' };
            return commitUpcoming(resolvedDate);
          },
        };
      };

      const parsedDate = parseDatePhrase(raw);
      if (parsedDate) return confirmStage(parsedDate);

      // No parseable date — one Graceful Confusion question. Never commit a
      // dateless 'upcoming' row (it could never surface and would rot).
      const who = doctorName ? ` with ${doctorName}` : '';
      return {
        status: 'pending',
        prompt: `I want to get this right — when is your appointment${who}?`,
        pendingKey: 'medical_visit_upcoming_date',
        resume: async (userText: string): Promise<CommitResult> => {
          const retryDate = parseDatePhrase(userText);
          if (!retryDate) return { status: 'noop', ack: '' };
          return confirmStage(retryDate);
        },
      };
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  diagnosis_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'diagnosis_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const condition = intent.condition?.trim();
      const raw = intent.raw ?? rawPhrase;
      if (!condition || condition.length < 2) {
        return { status: 'failed', ack: "I didn't catch that — what did the doctor say it was?" };
      }
      // Confirm-gate read-back: STT mangles long clinical phrases, and a wrong-
      // stored diagnosis is the worst failure Herald can make. Verify the exact
      // words before the write. No emotional overreach — capture honestly, gently.
      return {
        status: 'pending',
        prompt: `I want to make sure I have this exactly right — you said ${condition}?`,
        pendingKey: 'diagnosis_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) {
            return { status: 'noop', ack: `No problem — tell me again and I'll get it right.` };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { writeDiagnosis, getDiagnoses } = await import('../db/medicalDB');
            writeDiagnosis(condition, raw);
            const verified = getDiagnoses().some(
              d => (d.diagnosis ?? '').trim().toLowerCase() === condition.toLowerCase(),
            );
            if (!verified) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            return { status: 'committed', ack: `Got it — I'll remember that. You can ask me about it anytime.` };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  doctor_intro_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'doctor_intro_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const name = intent.name?.trim();
      const specialty = intent.specialty?.trim();
      const raw = intent.raw ?? rawPhrase;
      if (!name || !specialty) {
        return { status: 'failed', ack: "I didn't catch that — who's your doctor and what's their specialty?" };
      }
      return {
        status: 'pending',
        prompt: `Say yes and I'll remember ${name} as your ${specialty}.`,
        pendingKey: 'doctor_intro_capture',
        resume: async (userText: string): Promise<CommitResult> => {
          const YES = /^(yes|yeah|yep|yup|correct|right|that'?s right|sure|ok|okay|sounds good|that'?s it|exactly|y)\b/i;
          const NO  = /^(no|nope|nah|wrong|not right|that'?s wrong|incorrect|cancel|nevermind|never mind)\b/i;
          if (NO.test(userText.trim())) {
            return { status: 'noop', ack: `No problem — tell me again and I'll get it right.` };
          }
          if (!YES.test(userText.trim())) {
            return { status: 'noop', ack: '' };
          }
          try {
            const { writeMedicalContact, getMedicalContacts, passesSubstringGate } = await import('../db/medicalDB');
            if (!passesSubstringGate(name, raw) || !passesSubstringGate(specialty, raw)) {
              return { status: 'failed', ack: "I want to make sure I get this exactly right — can you say that again?" };
            }
            writeMedicalContact({ name, specialty, is_primary: 0 });
            const verified = getMedicalContacts().some(
              c => c.name.trim().toLowerCase() === name.toLowerCase() &&
                   (c.specialty ?? '').trim().toLowerCase() === specialty.toLowerCase(),
            );
            if (!verified) {
              return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
            }
            return { status: 'committed', ack: `Got it — I'll remember ${name} as your ${specialty}.` };
          } catch {
            return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
          }
        },
      };
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  insurance_capture: {
    async add(intent: IntentRecord, _rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'insurance_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { insType, carrier } = intent as { insType?: string; carrier?: string };
      // Deterministic floor — never speak a model-echoed placeholder as a carrier.
      const BAD = /^(unknown|insurance_capture|insurance|none|null|n\/a)$/i;
      const cleanCarrier = normalizeCarrier((carrier ?? '').trim());
      const cleanType = (insType ?? '').trim().toLowerCase();
      const typeOk = cleanType.length >= 2 && !BAD.test(cleanType);
      const spokenType = typeOk ? cleanType : '';

      const commit = (finalCarrier: string, finalType: string): CommitResult => {
        const insId = captureHouseholdInsurance(finalType || 'unknown', finalCarrier);
        if (!insId) {
          return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
        }
        return {
          status: 'committed',
          ack: finalType
            ? `Got it — ${finalCarrier} for your ${finalType} insurance.`
            : `Got it — ${finalCarrier} for your insurance.`,
        };
      };

      const extractCarrier = (raw: string): string | null => {
        let t = raw.trim().replace(/[.!?]+$/, '');
        t = t.replace(/^(it'?s|that'?s|they'?re|the carrier is|i'?m with|we'?re with|with)\s+/i, '');
        // A fresh capture command is not a carrier answer — let the ladder re-ask.
        if (/^(my|our)\s+\w/i.test(t)) return null;
        if (/^(do|does|did|who|what|which|is|are|can|could|would|where|when|how)\b/i.test(t)) return null;
        const candidate = normalizeCarrier(t);
        if (candidate.length < 2 || BAD.test(candidate)) return null;
        return candidate;
      };

      // Correction/collection stage (R2): the pending owns the carrier answer.
      // It never routes fresh, never crosses a boundary (Law 2, Spine §3a).
      function askCarrierStage(finalType: string, prompt: string): CommitResult {
        return {
          status: 'pending',
          prompt,
          pendingKey: 'insurance_capture',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — who's your insurance with?`,
          resume: async (reply: string): Promise<CommitResult> => {
            const c = extractCarrier(reply);
            if (!c) return { status: 'noop', ack: '' }; // → primitive re-ask ladder
            return confirmStage(c, finalType);
          },
        };
      }

      function confirmStage(finalCarrier: string, finalType: string): CommitResult {
        return {
          status: 'pending',
          prompt: finalType
            ? `Got it — ${finalCarrier} for your ${finalType} insurance, right?`
            : `Got it — ${finalCarrier} insurance, right?`,
          pendingKey: 'insurance_capture',
          kind: 'standard',
          reaskPrompt: finalType
            ? `I'm not sure I'm following — is your ${finalType} insurance with ${finalCarrier}?`
            : `I'm not sure I'm following — is your insurance with ${finalCarrier}?`,
          resume: async (reply: string): Promise<CommitResult> => {
            const trimmed = reply.trim();
            const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
            if (CONFIRM_YES_RE.test(trimmed)) return commit(finalCarrier, finalType);
            if (CONFIRM_NO_RE.test(trimmed)) {
              return askCarrierStage(finalType, `No problem — what's the correct carrier?`);
            }
            return { status: 'noop', ack: '' }; // ambiguous → re-ask ladder, NEVER implicit NO
          },
        };
      }

      const carrierOk = cleanCarrier.length >= 2 && !BAD.test(cleanCarrier);
      if (!carrierOk) {
        return askCarrierStage(spokenType, `I didn't quite catch that — who's your insurance with?`);
      }
      return confirmStage(cleanCarrier, spokenType);
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
  contact_call: {
    async add(intent: IntentRecord, _rawPhrase: string, ctx?: { resolveContact?: ResolveContactFn }): Promise<CommitResult> {
      if (intent.type !== 'contact_call') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { contact, candidates, devicePhone, deviceName, phonelessNames } = intent;
      type CallCandidate = { name: string; relationship?: string; phone: string; importance: number };

      // Identity-first: candidates are identity matches (phone may be empty).
      // Capability ('phone') is checked only after a single identity is chosen.
      const herald: CallCandidate[] = (candidates ?? []).map(c => ({
        name: c.name,
        relationship: c.relationship,
        phone: (c.phone ?? '').trim(),
        importance: c.importance,
      }));

      const handleFor = (c: CallCandidate): string =>
        c.relationship?.trim()
          ? `your ${c.relationship} ${c.name}`
          : (c.phone.replace(/\D/g, '').length >= 4
            ? `at ...${c.phone.replace(/\D/g, '').slice(-4)}`
            : c.name);

      const joinNaturally = (items: string[]): string => {
        if (items.length === 0) return '';
        if (items.length === 1) return items[0];
        if (items.length === 2) return `${items[0]} and ${items[1]}`;
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
      };

      const commitDial = (name: string, phone: string, ack?: string): CommitResult => {
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) {
          return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
        }
        return {
          status: 'committed',
          ack: ack ?? `Calling ${name}.`,
          effect: {
            kind: 'dial',
            phone: digits,
            failAck: `I couldn't open the dialer — try calling ${name} manually.`,
          },
        };
      };

      const disclosureAck = (dialName: string, dropped: string[]): string => {
        const rel = contact.trim().replace(/^(?:my|the|a)\s+/i, '');
        const relIsNameEcho = (() => {
          if (!rel) return true;
          const r = rel.toLowerCase();
          const tokensOf = (s: string) =>
            s.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          return [dialName, ...dropped].some(n => tokensOf(n).includes(r));
        })();
        const asRel = relIsNameEcho ? '' : ` as your ${rel}`;
        if (dropped.length === 1) {
          return `Calling ${dialName}. I also know ${dropped[0]}${asRel}, but I don't have a number for ${dropped[0]} yet.`;
        }
        if (dropped.length === 2) {
          return `Calling ${dialName}. I also know ${joinNaturally(dropped)}${asRel}, but I don't have their numbers yet.`;
        }
        // 3+: speak two names, then "and N others" — noise guard
        const spoken = joinNaturally(dropped.slice(0, 2));
        const others = dropped.length - 2;
        return `Calling ${dialName}. I also know ${spoken}, and ${others} other${others === 1 ? '' : 's'}, but I don't have their numbers yet.`;
      };

      const CORRECTION_STOPWORDS = new Set([
        'no', 'nope', 'not', 'yes', 'yeah', 'my', 'the', 'a', 'an', 'is', 'was',
        'it', "it's", 'its', 'that', "that's", 'thats', 'his', 'her', 'their',
        'actually', 'i', 'mean', 'think',
      ]);

      // TEMPORARY [OSA-DIAG] — log-only; never affects selection / pending / dial.
      const osaLast4 = (n?: string | null) => {
        const d = (n ?? '').replace(/\D/g, '');
        return d.length >= 4 ? d.slice(-4) : (d || null);
      };
      const osaNormName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const osaReplyTokens = (reply: string, contactLabel?: string) => {
        const labelTokens = new Set(
          (contactLabel ?? '').trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
        );
        return reply.trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
          .filter(t => !CORRECTION_STOPWORDS.has(t) && !labelTokens.has(t));
      };
      const osaCandSnapshot = (list: CallCandidate[]) => list.map(c => ({
        name: c.name,
        relationship: c.relationship ?? null,
        phoneLast4: osaLast4(c.phone),
        importance: c.importance,
        matchPool: [
          ...osaNormName(c.name).split(' ').filter(Boolean),
          ...(c.relationship ?? '').trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean),
        ],
      }));
      const osaLogPendingWrite = (
        path: string,
        contactLabel: string,
        list: CallCandidate[],
        prompt: string,
      ) => {
        console.log('[OSA-DIAG] contact_call.pendingWrite', {
          actionType: 'contact_call',
          path,
          contactLabel,
          originalQuery: contact,
          prompt,
          pendingKey: 'contact_call',
          pendingKind: 'standard',
          presentedLabels: list.map(c => c.name),
          candidateSnapshot: osaCandSnapshot(list),
          resumeMatchIdentifiers: list.map(c => ({
            name: c.name,
            nameNormalized: osaNormName(c.name),
            relationship: c.relationship ?? null,
            phoneLast4: osaLast4(c.phone),
          })),
        });
      };
      const osaLogResumeEntry = (
        path: string,
        rawReply: string,
        contactLabel: string,
        list: CallCandidate[],
      ) => {
        const normalizedReply = rawReply.trim().toLowerCase().replace(/[\s-]+/g, ' ');
        const replyTokens = osaReplyTokens(rawReply, contactLabel);
        console.log('[OSA-DIAG] contact_call.resume.entry', {
          actionType: 'contact_call',
          path,
          pendingKey: 'contact_call',
          contactLabel,
          rawReply,
          normalizedReply,
          replyTokens,
          candidateSnapshot: osaCandSnapshot(list),
          candidateCompareValues: list.map(c => ({
            name: c.name,
            nameNormalized: osaNormName(c.name),
            matchPool: [
              ...osaNormName(c.name).split(' ').filter(Boolean),
              ...(c.relationship ?? '').trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean),
            ],
          })),
        });
      };
      const osaLogResumeResult = (
        path: string,
        strategy: string,
        matched: CallCandidate | null,
        nextBranch: string,
        reason?: string,
      ) => {
        console.log('[OSA-DIAG] contact_call.resume.result', {
          path,
          matchStrategy: strategy,
          matchedName: matched?.name ?? null,
          matchedPhoneLast4: matched ? osaLast4(matched.phone) : null,
          selectedCandidate: matched ? { name: matched.name, phoneLast4: osaLast4(matched.phone) } : null,
          nextBranch,
          reason: reason ?? null,
        });
      };

      const matchCandidate = (
        reply: string,
        list: CallCandidate[],
        contactLabel?: string,
      ): CallCandidate | null => {
        const labelTokens = new Set(
          (contactLabel ?? '').trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
        );
        // Hyphen-split reply like labelTokens; rarer hyphenated surnames in replies may miss.
        const replyTokens = reply.trim().toLowerCase().replace(/[\s-]+/g, ' ').split(' ').filter(Boolean)
          .filter(t => !CORRECTION_STOPWORDS.has(t) && !labelTokens.has(t));
        if (replyTokens.length === 0) return null;
        const hits = list.filter(c => {
          const nameTokens = c.name.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          const relTokens = (c.relationship ?? '').trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
          const pool = [...nameTokens, ...relTokens];
          return replyTokens.every(t => pool.includes(t));
        });
        if (hits.length === 1) return hits[0];
        return null;
      };

      const extractPhone10 = (raw: string): string | null => {
        const m = raw.match(/([\d\s\-\(\)\+\.]{7,})/);
        if (!m) return null;
        const digits = m[1].replace(/\D/g, '');
        if (digits.length !== 10) return null;
        return digits;
      };

      function collectStage(contactLabel: string, opts?: { knownPerson?: boolean }): CommitResult {
        const known = opts?.knownPerson === true;
        const collectPrompt = known
          ? `I know ${contactLabel} but I don't have a phone number for them. What's their number?`
          : `I don't have a number for ${contactLabel} yet — what's their name, or you can give me the number?`;
        console.log('[OSA-DIAG] contact_call.pendingWrite', {
          actionType: 'contact_call',
          path: known ? 'collectStage_knownPerson' : 'collectStage',
          contactLabel,
          originalQuery: contact,
          prompt: collectPrompt,
          pendingKey: 'contact_call',
          pendingKind: 'standard',
          reason: known
            ? 'known person missing phone — number-collection path'
            : 'zero usable candidates — honest collect / number-collection path',
          candidateSnapshot: [],
        });
        return {
          status: 'pending',
          prompt: collectPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: known
            ? `I'm not sure I'm following — what's ${contactLabel}'s number?`
            : `I'm not sure I'm following — what's your ${contactLabel}'s name, or their number?`,
          resume: async (reply: string): Promise<CommitResult> => {
            osaLogResumeEntry(known ? 'collectStage_knownPerson' : 'collectStage', reply, contactLabel, []);
            const phone = extractPhone10(reply);
            if (phone) {
              osaLogResumeResult(known ? 'collectStage_knownPerson' : 'collectStage', 'extractPhone10', null, 'commitDial_bare_phone',
                'number-collection path: bare phone accepted');
              const writeResult = capturePerson({ name: contactLabel, phone, importance: 7 });
              return commitDial(
                contactLabel,
                phone,
                writeResult.ok
                  ? undefined
                  : `Calling your ${contactLabel} now. Tell me their name sometime and I'll remember them for next time.`,
              );
            }
            const replyIdentity = resolvePersonIdentity(reply);
            if (replyIdentity.status === 'single' && contactHasCapability(replyIdentity.contact, 'phone')) {
              const match = replyIdentity.contact;
              osaLogResumeResult(known ? 'collectStage_knownPerson' : 'collectStage', 'resolvePersonIdentity', {
                name: match.name, phone: match.phone!, relationship: match.relationship, importance: match.importance,
              } as CallCandidate, 'commitDial_fresh_herald');
              if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                retireRelationshipHolder(contactLabel, match.name);
                capturePerson({ name: match.name, relationship: contactLabel, phone: match.phone!, importance: 7 });
                return commitDial(match.name, match.phone!);
              }
              return commitDial(match.name, match.phone!);
            }
            // Herald doesn't know this name yet — try the OS contact book,
            // the same fallback resolveContactCallIntent already uses at
            // initial routing. Reached here because the first ask had zero
            // candidates of either kind.
            if (ctx?.resolveContact) {
              const device = await ctx.resolveContact(reply);
              if (device && device.phone) {
                osaLogResumeResult(known ? 'collectStage_knownPerson' : 'collectStage', 'resolveContact_os', {
                  name: device.name, phone: device.phone, importance: 5,
                } as CallCandidate, 'commitDial_os_single');
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                  retireRelationshipHolder(contactLabel, device.name);
                  capturePerson({ name: device.name, relationship: contactLabel, phone: device.phone, importance: 7 });
                  return commitDial(device.name, device.phone);
                }
                return commitDial(device.name, device.phone);
              }
              if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
                const osCandidates: CallCandidate[] = device.deviceCandidates.map(c => ({
                  name: c.name,
                  phone: c.phone,
                  importance: 5,
                }));
                const names = joinNaturally(osCandidates.map(c => c.name));
                const nestedPrompt = `I found a few in your contacts — ${names} — which one?`;
                osaLogPendingWrite('collectStage_nested_os_multi', contactLabel, osCandidates, nestedPrompt);
                return {
                  status: 'pending',
                  prompt: nestedPrompt,
                  pendingKey: 'contact_call',
                  kind: 'standard',
                  reaskPrompt: `I'm not sure I'm following — which one did you mean?`,
                  resume: async (pick: string): Promise<CommitResult> => {
                    osaLogResumeEntry('collectStage_nested_os_multi', pick, contactLabel, osCandidates);
                    const matched = matchCandidate(pick, osCandidates, contactLabel);
                    if (!matched) {
                      osaLogResumeResult('collectStage_nested_os_multi', 'matchCandidate', null, 'noop_reask',
                        'no unique token match against collectStage nested OS snapshot');
                      return { status: 'noop', ack: '' };
                    }
                    if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                      osaLogResumeResult('collectStage_nested_os_multi', 'matchCandidate', matched, 'commitDial_with_relationship_write');
                      retireRelationshipHolder(contactLabel, matched.name);
                      capturePerson({ name: matched.name, relationship: contactLabel, phone: matched.phone, importance: 7 });
                      return commitDial(matched.name, matched.phone);
                    }
                    osaLogResumeResult('collectStage_nested_os_multi', 'matchCandidate', matched, 'commitDial');
                    return commitDial(matched.name, matched.phone);
                  },
                };
              }
            }
            osaLogResumeResult(known ? 'collectStage_knownPerson' : 'collectStage', 'none', null, 'noop_reask',
              'number-collection path: no phone, no herald/os hit');
            return { status: 'noop', ack: '' };
          },
        };
      }

      function deviceConfirmStage(name: string, phone: string): CommitResult {
        const LOOSE_YES_RE = /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|call them|do it)\b/i;
        const LOOSE_NO_RE = /^\s*(no|nope|cancel|never mind|nevermind|don't|dont|stop)\b/i;
        const confirmPrompt = `I found ${name} in your contacts — want me to call them?`;
        const confirmSnap: CallCandidate[] = [{ name, phone, importance: 5 }];
        osaLogPendingWrite('deviceConfirmStage', name, confirmSnap, confirmPrompt);
        return {
          status: 'pending',
          prompt: confirmPrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — should I call ${name}?`,
          resume: async (reply: string): Promise<CommitResult> => {
            osaLogResumeEntry('deviceConfirmStage', reply, name, confirmSnap);
            const trimmed = reply.trim();
            if (LOOSE_YES_RE.test(trimmed)) {
              osaLogResumeResult('deviceConfirmStage', 'LOOSE_YES_RE', confirmSnap[0], 'commitDial');
              capturePerson({ name, phone, importance: 5 });
              return commitDial(name, phone);
            }
            if (LOOSE_NO_RE.test(trimmed)) {
              osaLogResumeResult('deviceConfirmStage', 'LOOSE_NO_RE', null, 'noop_redirect',
                'user declined device confirm');
              return { status: 'noop', ack: 'No problem — who were you trying to reach?' };
            }
            osaLogResumeResult('deviceConfirmStage', 'none', null, 'noop_reask',
              'device confirm: reply not recognized as YES/NO');
            return { status: 'noop', ack: '' };
          },
        };
      }

      function disambiguateStage(list: CallCandidate[], contactLabel: string): CommitResult {
        const hasRelationshipEvidence = list.some(c => c.relationship?.trim());
        if (!hasRelationshipEvidence) {
          // Relationship label + ≥2 phoneable OS/device candidates with no
          // relationship fields: name them all and ask — never top-1, never
          // write the relationship from this path. Keep the generic
          // "I don't know who your …" prompt below for zero/no-phone cases.
          const allPhoneable =
            list.length >= 2 && list.every(c => !!c.phone?.trim());
          if (RELATIONSHIP_WORDS.test(contactLabel.trim()) && allPhoneable) {
            const names = joinNaturally(list.map(c => c.name));
            const prompt = `I found a few in your contacts — ${names} — which one?`;
            osaLogPendingWrite('named_multi_no_relationship_evidence', contactLabel, list, prompt);
            return {
              status: 'pending',
              prompt,
              pendingKey: 'contact_call',
              kind: 'standard',
              reaskPrompt: `I'm not sure I'm following — which one did you mean?`,
              resume: async (pick: string): Promise<CommitResult> => {
                osaLogResumeEntry('named_multi_no_relationship_evidence', pick, contactLabel, list);
                const matched = matchCandidate(pick, list, contactLabel);
                if (!matched) {
                  osaLogResumeResult('named_multi_no_relationship_evidence', 'matchCandidate', null, 'noop_reask',
                    'no unique token match against stored candidate snapshot');
                  return { status: 'noop', ack: '' };
                }
                // Dial only — do not retire/write relationship, do not persist
                // the relationship word as a contact name.
                if (matched.phone?.trim()) {
                  osaLogResumeResult('named_multi_no_relationship_evidence', 'matchCandidate', matched, 'commitDial');
                  return commitDial(matched.name, matched.phone);
                }
                osaLogResumeResult('named_multi_no_relationship_evidence', 'matchCandidate', matched, 'collectStage',
                  'matched candidate has no usable phone');
                return collectStage(matched.name);
              },
            };
          }

          const genericPrompt = `I don't know who your ${contactLabel} is yet — what's their last name, or you can just give me the number?`;
          osaLogPendingWrite('generic_confusion_no_relationship_evidence', contactLabel, list, genericPrompt);
          console.log('[OSA-DIAG] contact_call.genericConfusionPath', {
            reason: 'no_relationship_evidence_and_not_named_multi_phoneable_exception',
            contactLabel,
            listLength: list.length,
            allPhoneable,
            hasRelationshipEvidence: false,
          });
          return {
            status: 'pending',
            prompt: genericPrompt,
            pendingKey: 'contact_call',
            kind: 'standard',
            reaskPrompt: `I'm not sure I'm following — what's your ${contactLabel}'s last name, or their number?`,
            resume: async (reply: string): Promise<CommitResult> => {
              osaLogResumeEntry('generic_confusion_no_relationship_evidence', reply, contactLabel, list);
              const phone = extractPhone10(reply);
              if (phone) {
                osaLogResumeResult('generic_confusion_no_relationship_evidence', 'extractPhone10', null, 'commitDial_bare_phone',
                  'bare phone on generic-confusion path');
                const writeResult = capturePerson({ name: contactLabel, phone, importance: 7 });
                return commitDial(
                  contactLabel,
                  phone,
                  writeResult.ok
                    ? undefined
                    : `Calling your ${contactLabel} now. Tell me their name sometime and I'll remember them for next time.`,
                );
              }
              const matched = matchCandidate(reply, list, contactLabel);
              if (matched) {
                // Persist the correction — contactLabel is only a real relationship
                // word sometimes (e.g. "father-in-law"); other times this same branch
                // fires for a plain-name lookup (e.g. "call sarah" with several device
                // matches), where contactLabel is a name, not a relationship, and must
                // NOT be written into the relationship field.
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                  // The user just explicitly confirmed matched.name holds this
                  // relationship — retire any other live holder before writing the new
                  // one, so a current-value relationship never has two active answers
                  // (Spine §6 principle 3). This is the explicit-confirmation case Spine
                  // §4a permits; writeContact's own identity-key logic stays untouched.
                  osaLogResumeResult('generic_confusion_no_relationship_evidence', 'matchCandidate', matched, 'commitDial_with_relationship_write');
                  retireRelationshipHolder(contactLabel, matched.name);
                  capturePerson({ name: matched.name, relationship: contactLabel, phone: matched.phone, importance: 7 });
                  return commitDial(matched.name, matched.phone);
                }
                osaLogResumeResult('generic_confusion_no_relationship_evidence', 'matchCandidate', matched, 'commitDial');
                return commitDial(matched.name, matched.phone);
              }
              // The reply named someone NOT in this pre-built candidate list —
              // a genuinely new name. Same fallback ladder as collectStage: try
              // Herald's own contacts fresh, then the OS contact book.
              const freshIdentity = resolvePersonIdentity(reply);
              if (freshIdentity.status === 'single' && contactHasCapability(freshIdentity.contact, 'phone')) {
                const fresh = freshIdentity.contact;
                if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                  osaLogResumeResult('generic_confusion_no_relationship_evidence', 'resolvePersonIdentity', {
                    name: fresh.name, phone: fresh.phone!, relationship: fresh.relationship, importance: fresh.importance,
                  } as CallCandidate, 'commitDial_fresh_herald');
                  retireRelationshipHolder(contactLabel, fresh.name);
                  capturePerson({ name: fresh.name, relationship: contactLabel, phone: fresh.phone!, importance: 7 });
                  return commitDial(fresh.name, fresh.phone!);
                }
                osaLogResumeResult('generic_confusion_no_relationship_evidence', 'resolvePersonIdentity', {
                  name: fresh.name, phone: fresh.phone!, relationship: fresh.relationship, importance: fresh.importance,
                } as CallCandidate, 'commitDial_fresh_herald');
                return commitDial(fresh.name, fresh.phone!);
              }
              if (ctx?.resolveContact) {
                const device = await ctx.resolveContact(reply);
                if (device && device.phone) {
                  osaLogResumeResult('generic_confusion_no_relationship_evidence', 'resolveContact_os', {
                    name: device.name, phone: device.phone, importance: 5,
                  } as CallCandidate, 'commitDial_os_single');
                  if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                    retireRelationshipHolder(contactLabel, device.name);
                    capturePerson({ name: device.name, relationship: contactLabel, phone: device.phone, importance: 7 });
                    return commitDial(device.name, device.phone);
                  }
                  return commitDial(device.name, device.phone);
                }
                if (device && !device.phone && 'deviceCandidates' in device && device.deviceCandidates.length > 0) {
                  const osCandidates: CallCandidate[] = device.deviceCandidates.map(c => ({
                    name: c.name,
                    phone: c.phone,
                    importance: 5,
                  }));
                  const names = joinNaturally(osCandidates.map(c => c.name));
                  const nestedPrompt = `I found a few in your contacts — ${names} — which one?`;
                  osaLogPendingWrite('generic_confusion_nested_os_multi', contactLabel, osCandidates, nestedPrompt);
                  return {
                    status: 'pending',
                    prompt: nestedPrompt,
                    pendingKey: 'contact_call',
                    kind: 'standard',
                    reaskPrompt: `I'm not sure I'm following — which one did you mean?`,
                    resume: async (pick: string): Promise<CommitResult> => {
                      osaLogResumeEntry('generic_confusion_nested_os_multi', pick, contactLabel, osCandidates);
                      const matchedOs = matchCandidate(pick, osCandidates, contactLabel);
                      if (!matchedOs) {
                        osaLogResumeResult('generic_confusion_nested_os_multi', 'matchCandidate', null, 'noop_reask',
                          'no unique token match against nested OS candidate snapshot');
                        return { status: 'noop', ack: '' };
                      }
                      if (RELATIONSHIP_WORDS.test(contactLabel.trim())) {
                        osaLogResumeResult('generic_confusion_nested_os_multi', 'matchCandidate', matchedOs, 'commitDial_with_relationship_write');
                        retireRelationshipHolder(contactLabel, matchedOs.name);
                        capturePerson({ name: matchedOs.name, relationship: contactLabel, phone: matchedOs.phone, importance: 7 });
                        return commitDial(matchedOs.name, matchedOs.phone);
                      }
                      osaLogResumeResult('generic_confusion_nested_os_multi', 'matchCandidate', matchedOs, 'commitDial');
                      return commitDial(matchedOs.name, matchedOs.phone);
                    },
                  };
                }
              }
              osaLogResumeResult('generic_confusion_no_relationship_evidence', 'none', null, 'noop_reask',
                'generic-confusion path: no phone, no candidate match, no fresh herald/os hit');
              return { status: 'noop', ack: '' };
            },
          };
        }

        const guess = list[0];
        const relPrefix = guess.relationship?.trim() ? `your ${guess.relationship} ` : '';
        const relEvidencePrompt = `I've got more than one ${contactLabel} — did you mean ${relPrefix}${guess.name}?`;
        osaLogPendingWrite('relationship_evidence_guess', contactLabel, list, relEvidencePrompt);
        return {
          status: 'pending',
          prompt: relEvidencePrompt,
          pendingKey: 'contact_call',
          kind: 'standard',
          reaskPrompt: `I'm not sure I'm following — which ${contactLabel} did you mean?`,
          resume: async (reply: string): Promise<CommitResult> => {
            osaLogResumeEntry('relationship_evidence_guess', reply, contactLabel, list);
            const trimmed = reply.trim();
            const { CONFIRM_YES_RE, CONFIRM_NO_RE } = await import('./conversationSession');
            const dialOrCollect = (c: CallCandidate): CommitResult =>
              c.phone?.trim() ? commitDial(c.name, c.phone) : collectStage(c.name);
            if (CONFIRM_YES_RE.test(trimmed)) {
              osaLogResumeResult('relationship_evidence_guess', 'CONFIRM_YES_RE', guess, guess.phone?.trim() ? 'commitDial' : 'collectStage');
              return dialOrCollect(guess);
            }
            if (CONFIRM_NO_RE.test(trimmed)) {
              const remaining = list.slice(1);
              if (remaining.length === 0) {
                osaLogResumeResult('relationship_evidence_guess', 'CONFIRM_NO_RE', null, 'collectStage',
                  'NO with no remaining candidates');
                return collectStage(contactLabel);
              }
              const handles = remaining.map(handleFor).join(', ');
              const altPrompt = `No problem — I've also got ${handles}. Which one?`;
              osaLogPendingWrite('relationship_evidence_alternates', contactLabel, remaining, altPrompt);
              return {
                status: 'pending',
                prompt: altPrompt,
                pendingKey: 'contact_call',
                kind: 'standard',
                reaskPrompt: `I'm not sure I'm following — which one did you mean?`,
                resume: async (pick: string): Promise<CommitResult> => {
                  osaLogResumeEntry('relationship_evidence_alternates', pick, contactLabel, remaining);
                  const matched = matchCandidate(pick, remaining, contactLabel);
                  if (!matched) {
                    osaLogResumeResult('relationship_evidence_alternates', 'matchCandidate', null, 'noop_reask',
                      'no unique token match against alternate candidate snapshot');
                    return { status: 'noop', ack: '' };
                  }
                  osaLogResumeResult('relationship_evidence_alternates', 'matchCandidate', matched,
                    matched.phone?.trim() ? 'commitDial' : 'collectStage');
                  return dialOrCollect(matched);
                },
              };
            }
            const named = matchCandidate(trimmed, list, contactLabel);
            if (named) {
              osaLogResumeResult('relationship_evidence_guess', 'matchCandidate', named,
                named.phone?.trim() ? 'commitDial' : 'collectStage');
              return dialOrCollect(named);
            }
            osaLogResumeResult('relationship_evidence_guess', 'none', null, 'noop_reask',
              'relationship-evidence path: not YES/NO and no unique name match');
            return { status: 'noop', ack: '' };
          },
        };
      }

      if (herald.length > 1) return disambiguateStage(herald, contact);
      if (herald.length === 1) {
        const only = herald[0];
        if (!only.phone?.trim()) {
          return collectStage(only.name, { knownPerson: true });
        }
        // phonelessNames retained on IntentRecord for back-compat; disclosure only
        // when resolver still supplies it (identity-first path normally does not).
        const dropped = (phonelessNames ?? []).map(n => n.trim()).filter(Boolean);
        if (dropped.length > 0) {
          return commitDial(only.name, only.phone, disclosureAck(only.name, dropped));
        }
        return commitDial(only.name, only.phone);
      }
      const phone = devicePhone?.trim();
      if (phone) {
        const name = deviceName?.trim() || contact;
        return deviceConfirmStage(name, phone);
      }
      return collectStage(contact);
    },
    async remove(_item: string): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: "I can't take that off just yet — but I've still got it, and I won't lose it." };
    },
  },
};

// allConverted: returns true when every intent in a capture decision has a
// registered writer. Gates the new dispatch path; false = legacy path runs.
export function allConverted(intents: IntentRecord[]): boolean {
  return intents.every(i => i.type in DOMAIN_WRITERS);
}

// composeAck: builds the spoken ACK from verified CommitResults only.
// v1: one result → its ack. Multiple: join committed/noop acks naturally.
// A pending result surfaces its prompt; never presents pending as committed.
export function composeAck(results: CommitResult[]): string {
  if (results.length === 0) return "I couldn't hold onto that — say it once more?";
  if (results.length === 1) return results[0].status === 'pending'
    ? results[0].prompt
    : results[0].ack;
  const pending = results.find(r => r.status === 'pending');
  const settled = results
    .filter(r => r.status !== 'pending')
    .map(r => r.ack)
    .filter(Boolean)
    .join(' ');
  if (pending && pending.status === 'pending') {
    return settled ? `${settled} ${pending.prompt}` : pending.prompt;
  }
  return settled;
}

// Law 5 (Spine §3a) fail-closed classification helper. A 'capture' decision
// that reached this point without a registered writer is PERSONAL by
// construction — it only exists because a personal-domain utterance missed
// every deterministic net. Any exception encountered while further
// classifying such an utterance must terminate locally, never reach the
// network. An explicit live-data authorization (kind: 'backend') is
// unaffected by this check.
export function isUnresolvedPersonalCapture(decision: RouteDecision): boolean {
  return decision.kind === 'capture';
}

export async function routeIntent(
  text: string,
  deps: {
    classifyQuery: (msg: string) => Promise<TierDecision>;
    classifyLLM: ((text: string) => Promise<ClassifyOutcome>) | null;
    llmReady: boolean;
    captureContext?: CaptureContext;
    resolveContact?: (nameOrRelation: string) => Promise<{phone:string;name:string;contactId?:string;source:'herald'|'device'}|{phone:null;name:string;source:'device';candidateNames:string[];deviceCandidates:{name:string;phone:string}[]}|null>;
  },
): Promise<RouteDecision> {
  const decision = await deps.classifyQuery(text);
  console.log('[classifyQuery]', JSON.stringify({ tier: decision.tier, actionIntent: decision.actionIntent, reason: decision.reason }));

  if (decision.tier === 1 && typeof decision.tier1Response === 'string') {
    return {
      kind: 'device_read',
      tier: 1,
      response: decision.tier1Response,
      isMedical: decision.isMedical,
      reason: decision.reason,
    };
  }

  if (decision.tier === 1 && decision.actionIntent) {
    const actionType = decision.actionIntent.type;
    // All medical_capture (medication, visit, advice) skips device_action and
    // flows to the capture path → DOMAIN_WRITERS. Visits/advice were previously
    // routed to dispatch's medical_capture branch; that island is retired (V4).
    const isMedicalCapture = actionType === 'medical_capture';
    // S64 D5: typeless insurance statements classify as profile_update at tier-1.
    // They are captures of a correction-prone fact (§4 confirm-before-save) and
    // must reach the insurance writer — never an unconfirmed local_profile write
    // into a table householdRead never reads. field 'provider' is NOT diverted
    // ("my provider is Dr. Smith" is not insurance). Dual-write audit: carried.
    const isInsuranceProfileUpdate =
      decision.actionIntent.type === 'profile_update' &&
      decision.actionIntent.field === 'insurance';
    if (actionType === 'call') {
      const rawContact = (decision.actionIntent as any).contact ?? '';
      const contactName = rawContact.replace(/\s+(?:at|on|using|with|via)\b.*/i, '').trim();
      if (contactName) {
        const intent = await resolveContactCallIntent(contactName, text, deps);
        return { kind: 'capture', intents: [intent], source: 'deterministic', reason: 'routeIntent:contact_call_intercept' };
      }
    }
    if (actionType !== 'list_add' && actionType !== 'todo_add' && !isMedicalCapture && !isInsuranceProfileUpdate) {
      return {
        kind: 'device_action',
        tier: 1,
        actionIntent: decision.actionIntent,
        reason: decision.reason,
      };
    }
  }

  if (decision.tier === 2) {
    return {
      kind: 'memory_probe',
      tier: 2,
      context: decision.localContext ?? { intent: 'memory_probe' },
      reason: decision.reason,
    };
  }

  // Tier-2 deterministic capture floor (spec §2.3 step 3). Reached only at tier 3
  // (tier-1/tier-2 already returned above), so the invariant holds: no LLM capture
  // is ever selected when a deterministic result exists.
  const capCtx: CaptureContext = deps.captureContext ?? { contacts: [], lists: [] };
  for (const capture of DETERMINISTIC_CAPTURERS) {
    const intents = capture(text, capCtx);
    if (intents.length > 0) {
      return { kind: 'capture', intents, source: 'deterministic', reason: 'deterministic:capture' };
    }
  }

  if (
    decision.actionIntent?.type === 'list_add' ||
    decision.actionIntent?.type === 'todo_add'
  ) {
    const medEvent = detectMedicalEvent(text);
    const intents: IntentRecord[] = [];
    if (medEvent && medEvent.type === 'medication' && medEvent.tense === 'past') {
      intents.push({ type: 'medical_capture', drug: medEvent.drug_name,
                     dosage: medEvent.dosage, raw: medEvent.raw });
    }
    intents.push(decision.actionIntent);
    return { kind: 'capture', intents, source: 'deterministic',
             reason: intents.length > 1
               ? 'tier1:list_todo_intercept+medical'
               : 'tier1:list_todo_intercept' };
  }

  if (
    decision.tier === 1 &&
    decision.actionIntent?.type === 'medical_capture' &&
    decision.actionIntent.event
  ) {
    const ev = decision.actionIntent.event;
    if (ev.type === 'medication') {
      return {
        kind: 'capture',
        intents: [{ type: 'medical_capture', drug: ev.drug_name, dosage: ev.dosage, raw: ev.raw }],
        source: 'deterministic',
        reason: 'tier1:medication_intercept',
      };
    }
    if (ev.type === 'visit' && ev.tense === 'future') {
      return {
        kind: 'capture',
        intents: [{ type: 'medical_visit_upcoming', doctor_name: ev.doctor_name, specialty: ev.specialty, raw: ev.raw }],
        source: 'deterministic',
        reason: 'tier1:visit_upcoming_intercept',
      };
    }
    // visit | advice → medical_visit (heard "Dr. X" writes; nameless asks who).
    return {
      kind: 'capture',
      intents: [{ type: 'medical_visit', doctor_name: ev.doctor_name, specialty: ev.specialty, advice: ev.advice, raw: ev.raw }],
      source: 'deterministic',
      reason: 'tier1:visit_intercept',
    };
  }

  if (deps.llmReady && deps.classifyLLM) {
    const out = await deps.classifyLLM(text);
    // A busy or absent classifier is NOT "found nothing" — it never ran. Returning
    // [] here would fall through to the backend and ship the user's raw words to
    // Railway because of a concurrency state, not because the utterance needed the
    // network. not_ready is a distinct route: honest tail, no network.
    if (out.status === 'not_ready') {
      return { kind: 'not_ready', reason: `llm:not_ready:${out.reason}` };
    }
    const llmResult = await mapCallIntents(out.intents, text, deps);
    if (llmResult.length > 0) {
      return { kind: 'capture', intents: llmResult, source: 'llm', reason: 'llm:capture' };
    }
  }

  if (decision.reason === 'live:data') {
    return { kind: 'backend', tier: 3, reason: decision.reason };
  }
  return { kind: 'needs_clarification', reason: decision.reason };
}
