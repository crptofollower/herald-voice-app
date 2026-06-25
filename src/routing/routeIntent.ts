// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';
import { writeServiceProvider } from '../utils/householdCapture';
import { getDB } from '../db/schema';
import { capturePerson } from '../db/capturePerson';
import { findContactByName } from '../db/contactsDB';

type ActionIntent = NonNullable<TierDecision['actionIntent']>;

export type RouteDecision =
  | { kind: 'device_read'; tier: 1; response: string; llmWrap?: boolean; isMedical?: boolean; reason: string }
  | { kind: 'device_action'; tier: 1; actionIntent: ActionIntent; reason: string }
  | { kind: 'capture'; intents: IntentRecord[]; source: 'deterministic' | 'llm'; reason: string }
  | { kind: 'memory_probe'; tier: 2; context: LocalContext; reason: string }
  | { kind: 'backend'; tier: 3; reason: string }
  | { kind: 'needs_clarification'; guess?: string; reason: string }
  | { kind: 'passthrough'; reason: string }; // TEMPORARY — deleted when all domains converted

// ─── Routing authority scaffolding (Commit 1) ────────────────────────────────
// CommitResult: the only gate for ACK strings. A string is never spoken for a
// write that was not verified. Added here; wired to domains one commit at a time.

export type CommitResult =
  | { status: 'committed'; ack: string }
  | { status: 'pending';   prompt: string; pendingKey: string;
      resume: (userText: string) => Promise<CommitResult> }
  | { status: 'noop';      ack: string }
  | { status: 'failed';    ack: string };

export interface DomainWriter {
  add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult>;
  remove(item: string): Promise<CommitResult>;
  clear(): Promise<CommitResult>;
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
        'somebody','that','this','it','he','she','they','him','her','them']);
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
        const numberPart = phone ? ` — you can reach them at ${phone}` : '';
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
      return { status: 'noop', ack: `Noted.` };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: `Noted.` };
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
      if (!list) {
        const listId = `list_${Date.now()}`;
        db.runSync(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`, [listId, listName, new Date().toISOString()]);
        list = { id: listId };
      }
      const now = new Date().toISOString();
      let addedCount = 0;
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
      if (addedCount === 0) {
        return { status: 'noop', ack: `${itemList.length === 1 ? `${itemList[0]} was` : 'Those were'} already on your ${listName} list.` };
      }
      if (addedCount === 1) {
        return { status: 'committed', ack: `Got it — ${itemList[0]} is on your ${listName} list.` };
      }
      return { status: 'committed', ack: `Got it — added ${addedCount} items to your ${listName} list.` };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
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
      return { status: 'noop', ack: 'Noted.' };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
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
        return { status: 'committed', ack: `Got it — ${name}${relPart} at ${phone}.` };
      } catch {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
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
      return { status: 'noop', ack: 'Noted.' };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: 'Noted.' };
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
  if (pending) return pending.prompt;
  return results.map(r => r.status !== 'pending' ? r.ack : '').filter(Boolean).join(' ');
}

// passthrough: temporary variant added to RouteDecision during rollout.
// Unconverted domains return this; legacy islands handle them as today.
// Deleted in the final cleanup commit when DOMAIN_WRITERS is complete.
// ─────────────────────────────────────────────────────────────────────────────

export async function routeIntent(
  text: string,
  deps: {
    classifyQuery: (msg: string) => Promise<TierDecision>;
    classifyLLM: ((text: string) => Promise<IntentRecord[]>) | null;
    llmReady: boolean;
  },
): Promise<RouteDecision> {
  const decision = await deps.classifyQuery(text);

  if (decision.tier === 1 && typeof decision.tier1Response === 'string') {
    return {
      kind: 'device_read',
      tier: 1,
      response: decision.tier1Response,
      llmWrap: decision.llmWrap,
      isMedical: decision.isMedical,
      reason: decision.reason,
    };
  }

  if (decision.tier === 1 && decision.actionIntent) {
    return {
      kind: 'device_action',
      tier: 1,
      actionIntent: decision.actionIntent,
      reason: decision.reason,
    };
  }

  if (decision.tier === 2) {
    return {
      kind: 'memory_probe',
      tier: 2,
      context: decision.localContext ?? { intent: 'memory_probe' },
      reason: decision.reason,
    };
  }

  if (deps.llmReady && deps.classifyLLM) {
    const llmResult = await deps.classifyLLM(text);
    if (llmResult.length > 0) {
      return { kind: 'capture', intents: llmResult, source: 'llm', reason: 'llm:capture' };
    }
  }

  return { kind: 'backend', tier: 3, reason: decision.reason };
}
