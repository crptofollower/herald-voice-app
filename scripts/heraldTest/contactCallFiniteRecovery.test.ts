// CALL finite OS-set recovery inside contact_call (J1).
// Does not change how the initial candidate set is assembled.

import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  CAPTURE_FIRST_MISS,
  CAPTURE_SECOND_MISS,
  CALL_TEXT_RECOVERY_KEY,
  SMS_OS_DISAMBIGUATE_KEY,
} from '../../src/routing/callTextReadiness.ts';
import { LOCAL_LLM_ENABLED } from '../../src/constants/features.ts';
import { classifyEmergencyCallReply } from '../../src/utils/emergencyCallConfirm.ts';
import { releaseOverlappingContactCollect } from '../../src/screens/chat/dispatch.ts';
import { setDB } from '../../src/db/schema.ts';
import Database from 'better-sqlite3';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    address TEXT, email TEXT, birthday TEXT, importance INTEGER DEFAULT 5,
    entity_id TEXT, os_contact_id TEXT, notes TEXT, last_contact TEXT,
    is_emergency INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT
  );
`;

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

function dialPhone(result: CommitResult): string | undefined {
  return result.status === 'committed' && result.effect?.kind === 'dial' ? result.effect.phone : undefined;
}

const OS_PAULS = [
  { name: 'Paul Cioffre', phone: '18178468607' },
  { name: 'Paul Smith', phone: '5551112222' },
  { name: 'Paul Jones', phone: '5553334444' },
];
const OS_LABELS = OS_PAULS.map(c => c.name);

function finiteIntent(): IntentRecord {
  return {
    type: 'contact_call',
    contact: 'Paul',
    candidates: OS_PAULS.map(c => ({ name: c.name, phone: c.phone, importance: 5 })),
    raw: 'call Paul',
  };
}

async function armFinite(): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['contact_call']!.add(finiteIntent(), '');
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  return result;
}

export async function runContactCallFiniteRecoveryTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- contact_call Finite Recovery (J1) -----------------------${RESET}\n`);

  const lookups: string[] = [];
  const collectingResolve = async (q: string) => {
    lookups.push(q.trim().toLowerCase());
    const n = q.trim().toLowerCase();
    if (n.includes('show') || n === 'paul show') return null;
    if (n === 'paul') {
      return {
        phone: null as null,
        name: 'Paul',
        source: 'device' as const,
        candidateNames: OS_LABELS,
        deviceCandidates: OS_PAULS,
      };
    }
    return null;
  };

  // Proven sequence: collect "Paul show" → "Paul" obtains finite OS set.
  {
    freshDB();
    lookups.length = 0;
    const collect = await DOMAIN_WRITERS['contact_call']!.add(
      { type: 'contact_call', contact: 'Paul show', raw: 'Call Paul show free' },
      'Call Paul show free',
      { resolveContact: collectingResolve },
    );
    if (collect.status !== 'pending') throw new Error('expected collect pending');
    const armed = await collect.resume('Paul');
    assert('J1-A finite OS set retained after Paul; no SMS pending key',
      { armed, lookups: [...lookups] },
      v => v.armed.status === 'pending'
        && v.armed.pendingKey === 'contact_call'
        && v.armed.pendingKey !== SMS_OS_DISAMBIGUATE_KEY
        && v.armed.pendingKey !== CALL_TEXT_RECOVERY_KEY
        && /I found a few in your contacts/i.test(v.armed.prompt)
        && OS_LABELS.every(n => v.armed.status === 'pending' && v.armed.prompt.includes(n)),
      'contact_call owns OS Paul set');
    const afterAcquire = lookups.length;
    if (armed.status !== 'pending') throw new Error('expected finite pending');
    const shared = await armed.resume('Paul');
    assert('J1-B shared first name Paul does not dial; no further OS lookup',
      { shared, dial: dialPhone(shared), lookups: lookups.length, afterAcquire },
      v => v.shared.status === 'pending'
        && !v.dial
        && v.lookups === v.afterAcquire,
      'constrained to retained set');
  }

  {
    freshDB();
    const pending = await armFinite();
    const result = await pending.resume('Cioffre');
    assert('J1-C exact surname Cioffre dials CALL tel, not SMS',
      { phone: dialPhone(result), key: pending.pendingKey, sms: result.status === 'pending' ? result.pendingKey : null },
      v => v.phone === '18178468607' && v.key === 'contact_call' && v.sms !== SMS_OS_DISAMBIGUATE_KEY,
      'tel: Paul Cioffre');
  }

  {
    freshDB();
    const pending = await armFinite();
    const first = await pending.resume('Shaffery');
    assert('J1-D Shaffery first miss retains set; does not guess',
      first,
      v => v.status === 'pending'
        && v.pendingKey === 'contact_call'
        && v.prompt === CAPTURE_FIRST_MISS
        && !dialPhone(v),
      'CAPTURE_FIRST_MISS');
    if (first.status !== 'pending') throw new Error('expected first miss pending');
    const second = await first.resume('zzzz-not-a-person');
    assert('J1-E second miss exposes say/type/tap choices from retained set only',
      second,
      v => v.status === 'pending'
        && v.prompt === CAPTURE_SECOND_MISS
        && Array.isArray(v.recoveryChoices)
        && v.recoveryChoices.length === OS_LABELS.length
        && v.recoveryChoices.every(n => OS_LABELS.includes(n))
        && !v.recoveryChoices.some(n => n === 'Shaffery'),
      'recoveryChoices are OS Pauls');
    if (second.status !== 'pending') throw new Error('expected second miss pending');
    const typed = await second.resume('Cioffre');
    assert('J1-F typing Cioffre after misses completes original CALL',
      { phone: dialPhone(typed), ack: typed.status === 'committed' ? typed.ack : '' },
      v => v.phone === '18178468607' && /Calling Paul Cioffre/i.test(v.ack),
      'dial retained OS phone');
  }

  {
    freshDB();
    const pending = await armFinite();
    const yes = await pending.resume('Yes');
    assert('J1-G ungrounded Yes does not dial',
      { yes, phone: dialPhone(yes) },
      v => v.yes.status === 'pending' && !v.phone && v.yes.pendingKey === 'contact_call',
      'yes inert without proposal');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const pending = await armFinite();
    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: pending.kind ?? 'standard',
      reaskPrompt: pending.reaskPrompt,
      releasePrompt: pending.releasePrompt,
      budget: pending.budget,
    });
    const cancel = await session.resolvePending('never mind');
    assert('J1-H cancel releases contact_call',
      { cancel, live: session.hasPending() },
      v => v.cancel.status === 'noop' && /won't do that/i.test(v.cancel.ack) && v.live === false,
      'session cancel');
  }

  {
    freshDB();
    const result = await DOMAIN_WRITERS['contact_call']!.add({
      type: 'contact_call',
      contact: 'Mickey',
      candidates: [{ name: 'Mickey', phone: '5550100100', importance: 7 }],
      raw: 'Call Mickey.',
    }, 'Call Mickey.');
    assert('J1-I unique Call Mickey still dials immediately',
      { phone: dialPhone(result), pending: result.status },
      v => v.phone === '5550100100' && v.pending === 'committed',
      'no recovery pending');
  }

  {
    assert('J1-J 911 yes still classifies as emergency confirm yes',
      classifyEmergencyCallReply('Yes'),
      v => v === 'yes',
      'classifyEmergencyCallReply unchanged');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'stale' } };
    const pending = await armFinite();
    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: 'standard',
      reaskPrompt: pending.reaskPrompt,
      releasePrompt: pending.releasePrompt,
      budget: pending.budget,
    });
    releaseOverlappingContactCollect(leftover, session);
    assert('J1-K DD-2 leftover collect-ref yields; contact_call remains sole owner',
      { leftover: leftover.current, key: session.peekPendingKey() },
      v => v.leftover === null && v.key === 'contact_call',
      'single pending owner');
  }

  {
    assert('J1-L LOCAL_LLM_ENABLED remains false',
      LOCAL_LLM_ENABLED,
      v => v === false,
      'classifier kill trigger intact');
  }

  {
    freshDB();
    const mixed = {
      type: 'contact_call' as const,
      contact: 'Paul',
      candidates: [
        { name: 'Paul Cioffre', phone: '18178468607', importance: 5 },
        { name: 'Paul Smith', phone: '', importance: 5 },
      ],
      raw: 'call Paul',
    };
    const pending = await DOMAIN_WRITERS['contact_call']!.add(mixed, 'call Paul');
    const confirmed = pending.status === 'pending' ? await pending.resume('Yes') : pending;
    const session = new ConversationSession();
    const again = await DOMAIN_WRITERS['contact_call']!.add(mixed, 'call Paul');
    if (again.status === 'pending') {
      session.setPending({
        pendingKey: again.pendingKey,
        resume: again.resume,
        kind: again.kind ?? 'standard',
        reaskPrompt: again.reaskPrompt,
        releasePrompt: again.releasePrompt,
        budget: again.budget,
      });
    }
    const cancel = await session.resolvePending('cancel');
    assert('J1-M two identities / one phoneable requires grounded confirm; never auto-dial',
      {
        pending,
        confirmedPhone: dialPhone(confirmed),
        cancel,
        live: session.hasPending(),
      },
      v => v.pending.status === 'pending'
        && v.pending.pendingKey === 'contact_call'
        && /more than one Paul/i.test(v.pending.prompt)
        && /only have a number for Paul Cioffre/i.test(v.pending.prompt)
        && /Did you mean Paul Cioffre/i.test(v.pending.prompt)
        && !dialPhone(v.pending)
        && v.confirmedPhone === '18178468607'
        && v.cancel.status === 'noop'
        && /won't do that/i.test(v.cancel.ack)
        && v.live === false,
      'identity ambiguity; Yes dials proposed; cancel clears with no tel:');
  }

  {
    freshDB();
    const pending = await armFinite();
    const spelled = await pending.resume('c i o f f r e');
    assert('J1-N structural spelling proposes CALL; does not dial',
      spelled,
      v => v.status === 'pending'
        && v.pendingKey === 'contact_call'
        && v.prompt === 'Did you mean Paul Cioffre?'
        && !dialPhone(v),
      'proposal only');
    if (spelled.status !== 'pending') throw new Error('expected spelling proposal');
    const no = await spelled.resume('no');
    assert('J1-O CALL NO after spelling proposal does not auto-dial',
      { no, phone: dialPhone(no) },
      v => v.no.status === 'pending' && !v.phone,
      'NO clears proposal');
    if (no.status !== 'pending') throw new Error('expected pending after NO');
    const miss3 = await no.resume('zzzz-not-a-person');
    const miss4 = miss3.status === 'pending' ? await miss3.resume('yyyy-also-wrong') : miss3;
    assert('J1-P CALL non-advance holds type/tap instead of start-over',
      { miss3, miss4 },
      v => v.miss3.status === 'pending'
        && v.miss4.status === 'pending'
        && v.miss4.status === 'pending'
        && v.miss4.prompt === CAPTURE_SECOND_MISS
        && Array.isArray(v.miss4.recoveryChoices)
        && !dialPhone(v.miss4)
        && !/start that one over/i.test(v.miss4.status === 'pending' ? v.miss4.prompt : ''),
      'resumable contact_call');
    if (miss4.status !== 'pending') throw new Error('expected type/tap hold');
    const typed = await miss4.resume('Cioffre');
    assert('J1-Q typed fragment after CALL chips completes original CALL',
      { phone: dialPhone(typed), ack: typed.status === 'committed' ? typed.ack : '' },
      v => v.phone === '18178468607' && /Calling Paul Cioffre/i.test(v.ack),
      'tel after type/tap hold');
  }

  {
    freshDB();
    const mixed = {
      type: 'contact_call' as const,
      contact: 'Paul',
      candidates: [
        { name: 'Paul Cioffre', phone: '18178468607', importance: 5 },
        { name: 'Paul Smith', phone: '', importance: 5 },
      ],
      raw: 'call Paul',
    };
    const pending = await DOMAIN_WRITERS['contact_call']!.add(mixed, 'call Paul');
    const no = pending.status === 'pending' ? await pending.resume('No') : pending;
    assert('J1-R byName.size===1 among 2 identities: NO does not auto-dial the phoneable row',
      { pending, no, phone: dialPhone(no) },
      v => v.pending.status === 'pending'
        && /Did you mean Paul Cioffre/i.test(v.pending.status === 'pending' ? v.pending.prompt : '')
        && v.no.status === 'pending'
        && !v.phone,
      'wrong-recipient-adjacent: confirm required; NO is not authority');
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}
