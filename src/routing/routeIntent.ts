// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';
import { writeServiceProvider } from '../utils/householdCapture';
import { getDB } from '../db/schema';

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
  | { status: 'pending';   prompt: string; pendingKey: string }
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
      const isRealName = (v: string) => typeof v === 'string' && v.trim().length >= 2
        && !PLACEHOLDER_NAMES.has(v.trim().toLowerCase());
      if (!category?.trim()) {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      if (!isRealName(name)) {
        const prompt = phone
          ? `Who's your ${category} at ${phone}?`
          : `I didn't catch the name — who's your ${category}?`;
        return { status: 'pending', prompt, pendingKey: 'pendingServiceCapture' };
      }
      const spId = writeServiceProvider(category, name, phone);
      if (!spId) {
        return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
      }
      const numberPart = phone ? ` — you can reach them at ${phone}` : '';
      return { status: 'committed', ack: `Got it — ${name} is your ${category}${numberPart}.` };
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
