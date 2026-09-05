// Continuation recovery evidence — capture before unused-clear, gated adoption.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`
// (this folder's tsconfig stubs react-native / expo; a repo-root
// `npx tsx scripts/heraldTest/continuationRecoveryEvidence.test.ts` is not supported).
// Gate: wired from run.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeMedication } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import {
  adoptContinuationRecoveryCandidates,
  CONTINUATION_RECOVERY_SAFE_LABEL,
  recordContinuationRecoveryCandidate,
  type ContinuationRecoveryCandidate,
} from '../../src/conversation/continuationRecovery.ts';
import {
  buildVerifiedConversationalPacket,
  formatVerifiedConversationalPacket,
} from '../../src/conversation/verifiedConversationalPacket.ts';
import { buildEphemeralPromptMessages } from '../../src/utils/ephemeralConversation.ts';
import {
  EXPERIMENTAL_QWEN_SYSTEM_PROMPT,
  createExperimentalQwenLlamaWorker,
} from '../../src/conversation/experimentalQwenLlamaWorker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT, is_active INTEGER DEFAULT 1,
    notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT, start_ms INTEGER, end_ms INTEGER,
    all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendarPresentation = new CalendarPresentationHolder();
  const calendar = new CalendarContinuationHolder();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered, calendarPresentation, calendar);
  return { db, session, subject, medication, ordered, calendar, calendarPresentation, say };
}

export async function runContinuationRecoveryEvidenceTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean, detail = '') {
    if (cond) { console.log(`${GREEN}PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}FAIL${RESET}  ${name} ${detail}`); failures.push(name); }
  }

  const firstWins: ContinuationRecoveryCandidate[] = [];
  recordContinuationRecoveryCandidate(firstWins, 'person', 'Pat');
  recordContinuationRecoveryCandidate(firstWins, 'person', 'ShouldNotWin');
  recordContinuationRecoveryCandidate(firstWins, 'medication', CONTINUATION_RECOVERY_SAFE_LABEL.medication);
  assert('first-wins per domain, never last-wins', firstWins.length === 2 && firstWins[0].spokenReferent === 'Pat');

  const { subject, say } = fresh();
  const secretId = writeContactRaw({
    name: 'Pat',
    relationship: 'wife',
    phone: '5551112222',
    importance: 8,
  });
  subject.beginUserTurn();
  subject.establishFamily({ entityId: secretId, displayName: 'Pat', relationship: 'wife' });
  const related = await say('how is he doing today');
  assert('related fallthrough is unhandled needs_clarification/default', (
    !related.handled
    && related.routeDecision.kind === 'needs_clarification'
    && related.routeDecision.reason === 'default'
  ));
  assert('authoritative person holder cleared after unused-clear', !subject.hasLive());
  assert('person recovery candidate survives unused-clear', (
    !related.handled
    && related.continuationRecoveryCandidates.some((c) => c.domain === 'person' && c.spokenReferent === 'Pat')
  ));
  const adoptedRelated = related.handled
    ? []
    : adoptContinuationRecoveryCandidates('how is he doing today', related.continuationRecoveryCandidates);
  const relatedPacket = buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: ['how is he doing today'],
    pendingLabel: null,
    continuationRecoveryCandidates: adoptedRelated,
  });
  const relatedFmt = formatVerifiedConversationalPacket(relatedPacket);
  assert('eligible continuation receives safe display grounding', (
    adoptedRelated.length === 1
    && adoptedRelated[0].spokenReferent === 'Pat'
    && relatedFmt.includes('Pat')
    && relatedFmt.includes('CONTINUATION RECOVERY')
    && relatedFmt.includes('not action authority')
    && relatedFmt.includes('must not be used to call')
  ));
  assert('no entity ID reaches packet', !relatedFmt.includes(secretId) && !JSON.stringify(relatedPacket.continuationRecovery).includes(secretId));

  const { subject: subject2, say: say2 } = fresh();
  const secretId2 = writeContactRaw({
    name: 'Pat',
    relationship: 'wife',
    phone: '5551112222',
    importance: 8,
  });
  subject2.beginUserTurn();
  subject2.establishFamily({ entityId: secretId2, displayName: 'Pat', relationship: 'wife' });
  const unrelated = await say2('I like pizza tonight');
  assert('unrelated utterance still needs_clarification/default', (
    !unrelated.handled
    && unrelated.routeDecision.kind === 'needs_clarification'
    && unrelated.routeDecision.reason === 'default'
  ));
  assert('unrelated topic captures expiry but does not adopt for the worker', (
    !unrelated.handled
    && unrelated.continuationRecoveryCandidates.some((c) => c.domain === 'person')
    && adoptContinuationRecoveryCandidates('I like pizza tonight', unrelated.continuationRecoveryCandidates).length === 0
  ));
  const unrelatedFmt = formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: ['I like pizza tonight'],
    pendingLabel: null,
    continuationRecoveryCandidates: adoptContinuationRecoveryCandidates(
      'I like pizza tonight',
      unrelated.handled ? [] : unrelated.continuationRecoveryCandidates,
    ),
  }));
  assert('unrelated worker packet has no prior subject recovery', (
    /CONTINUATION RECOVERY[\s\S]*\(none\)/.test(unrelatedFmt)
    && !unrelatedFmt.includes('- person: Pat')
  ));

  const allDomains: ContinuationRecoveryCandidate[] = [
    { domain: 'person', spokenReferent: 'Pat', status: 'expired_this_turn' },
    { domain: 'medication', spokenReferent: CONTINUATION_RECOVERY_SAFE_LABEL.medication, status: 'expired_this_turn' },
    { domain: 'grocery', spokenReferent: CONTINUATION_RECOVERY_SAFE_LABEL.grocery, status: 'expired_this_turn' },
    { domain: 'calendar', spokenReferent: CONTINUATION_RECOVERY_SAFE_LABEL.calendar, status: 'expired_this_turn' },
  ];
  const actionFmt = formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: [],
    pendingLabel: null,
    continuationRecoveryCandidates: allDomains,
  }));
  assert('recovery evidence has no executable IDs or phones', (
    !actionFmt.includes(secretId)
    && !actionFmt.includes('5551112222')
    && !/\b[0-9a-f]{8}-[0-9a-f]{4}\b/i.test(actionFmt)
    && actionFmt.includes(CONTINUATION_RECOVERY_SAFE_LABEL.medication)
    && actionFmt.includes(CONTINUATION_RECOVERY_SAFE_LABEL.grocery)
    && actionFmt.includes(CONTINUATION_RECOVERY_SAFE_LABEL.calendar)
  ));
  assert('recovery is labeled not action/confirm/execution authority', (
    /must not be used to call, text, write, mutate, confirm, or claim execution/.test(actionFmt)
    && /authoritative SQLite/.test(actionFmt)
  ));
  const callHimAdopt = adoptContinuationRecoveryCandidates('call him', allDomains);
  assert('referent grammar may adopt person but recovery still has no mutation target', (
    callHimAdopt.every((c) => c.domain === 'person')
    && !('entityId' in callHimAdopt[0])
    && callHimAdopt[0].spokenReferent === 'Pat'
  ));

  const llama = readFileSync(join(HERE, '../../src/conversation/llamaEphemeralWorker.ts'), 'utf8');
  const qwen = readFileSync(join(HERE, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
  assert('Llama consumes formatVerifiedConversationalPacket', llama.includes('formatVerifiedConversationalPacket(request.packet)'));
  assert('Qwen consumes formatVerifiedConversationalPacket', qwen.includes('formatVerifiedConversationalPacket(request.packet)'));
  const parityPacket = buildVerifiedConversationalPacket({
    verifiedPersonalFacts: 'name: Mike',
    sessionEvidenceLines: ['hello'],
    pendingLabel: null,
    continuationRecoveryCandidates: adoptedRelated,
  });
  const formatted = formatVerifiedConversationalPacket(parityPacket);
  const llamaMsgs = buildEphemeralPromptMessages('how is he doing today', [], formatted);
  const qwenSystem = `${EXPERIMENTAL_QWEN_SYSTEM_PROMPT}\n\n${formatted}`;
  let qwenSystemFromWorker = '';
  {
    const fakeQwen = createExperimentalQwenLlamaWorker({
      getCtx: () => ({
        completion: async (opts: { messages?: { role: string; content: string }[] }) => {
          qwenSystemFromWorker = opts.messages?.[0]?.content ?? '';
          return { content: 'ok' };
        },
      }) as never,
      enabled: true,
    });
    const qwenOut = await fakeQwen.generate({
      userText: 'how is he doing today',
      hotEntries: [],
      packet: parityPacket,
    });
    assert('Qwen worker generate consumes formatVerifiedConversationalPacket output', (
      qwenOut.status === 'ok'
      && qwenSystemFromWorker.endsWith(formatted)
      && qwenSystemFromWorker.includes(formatted)
    ));
  }
  assert('Llama and Qwen consume the exact same formatted packet string', (
    llamaMsgs[0].role === 'system'
    && llamaMsgs[0].content.endsWith(formatted)
    && qwenSystem.endsWith(formatted)
    && qwenSystemFromWorker.endsWith(formatted)
    && llamaMsgs[0].content.includes(formatted)
    && qwenSystem.includes(formatted)
  ));

  const { subject: subjPhone, say: sayPhone } = fresh();
  const phoneId = writeContactRaw({
    name: 'Pat',
    relationship: 'wife',
    phone: '5551112222',
    importance: 8,
  });
  subjPhone.beginUserTurn();
  subjPhone.establishFamily({ entityId: phoneId, displayName: 'Pat', relationship: 'wife' });
  const phone = await sayPhone("what's his number");
  assert('closed person phone/referent resume stays handled:true', phone.handled === true && phone.source === 'referent_resume');

  const { medication, say: sayMed } = fresh();
  const med = writeMedication({ name: 'Eliquis', dosage: '5mg', frequency: 'twice daily' });
  medication.beginUserTurn();
  medication.establish([med.id]);
  const ordinal = await sayMed('tell me about the first one');
  assert('closed medication ordinal stays handled:true', ordinal.handled === true && ordinal.source === 'referent_resume');

  const { ordered, say: sayGroc } = fresh();
  ordered.beginUserTurn();
  ordered.establish('grocery', ['groc-secret-id']);
  const grocRead = await sayGroc('the first one');
  assert('closed grocery ordinal stays handled:true (or confusion resume)', grocRead.handled === true && grocRead.source === 'referent_resume');

  const { calendar, say: sayCal } = fresh();
  calendar.beginUserTurn();
  calendar.establish('calendar:week');
  const cal = await sayCal('what about tomorrow');
  assert('closed calendar continuation stays handled:true', cal.handled === true && cal.source === 'referent_resume');

  const { medication: med2, say: sayMed2 } = fresh();
  const medRow = writeMedication({ name: 'Eliquis', dosage: '5mg', frequency: 'twice daily' });
  med2.beginUserTurn();
  med2.establish([medRow.id]);
  const medExpire = await sayMed2('I like pizza tonight');
  assert('medication unused-clear captures generic label only', (
    !medExpire.handled
    && !med2.hasLive()
    && medExpire.continuationRecoveryCandidates.some((c) => c.domain === 'medication' && c.spokenReferent === CONTINUATION_RECOVERY_SAFE_LABEL.medication)
    && !JSON.stringify(medExpire.continuationRecoveryCandidates).includes(medRow.id)
    && adoptContinuationRecoveryCandidates('I like pizza tonight', medExpire.continuationRecoveryCandidates).length === 0
  ));

  const grocPresentedId = 'groc-secret-id';
  const { ordered: ordExpire, say: sayGrocExpire } = fresh();
  ordExpire.beginUserTurn();
  ordExpire.establish('grocery', [grocPresentedId]);
  const grocExpire = await sayGrocExpire('the first one 5 mg');
  assert('grocery unused-clear with bounded position evidence reaches default clarification', (
    !grocExpire.handled
    && grocExpire.routeDecision.kind === 'needs_clarification'
    && grocExpire.routeDecision.reason === 'default'
    && grocExpire.continuationRecoveryCandidates.some((c) => c.domain === 'grocery')
  ));
  const grocAdopted = adoptContinuationRecoveryCandidates(
    'the first one 5 mg',
    grocExpire.handled ? [] : grocExpire.continuationRecoveryCandidates,
  );
  const grocFmt = formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: ['the first one 5 mg'],
    pendingLabel: null,
    continuationRecoveryCandidates: grocAdopted,
  }));
  assert('grocery adoption is the generic label only — no presented IDs', (
    grocAdopted.length === 1
    && grocAdopted[0].domain === 'grocery'
    && grocAdopted[0].spokenReferent === CONTINUATION_RECOVERY_SAFE_LABEL.grocery
    && !JSON.stringify(grocExpire.handled ? [] : grocExpire.continuationRecoveryCandidates).includes(grocPresentedId)
    && !grocFmt.includes(grocPresentedId)
    && grocFmt.includes(CONTINUATION_RECOVERY_SAFE_LABEL.grocery)
  ));

  const chatSrc = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');
  const clarifySeam = chatSrc.match(
    /if \(outcome\.routeDecision\.kind === 'needs_clarification'\) \{[\s\S]*?speak\(reply\);/,
  )?.[0] ?? '';
  const defaultClarifySeam = clarifySeam.match(
    /if \(outcome\.routeDecision\.reason === 'default'\) \{[\s\S]*?generate: \(\) => runEphemeralGenerate\(adoptedRecovery\),/,
  )?.[0] ?? '';
  const offlineSeam = chatSrc.match(
    /resolveEphemeralSeamGateADiag\('offline_fallback', \{[\s\S]*?generate: runEphemeralGenerate,/,
  )?.[0] ?? '';
  assert('ChatScreen default clarification adopts before generate', (
    defaultClarifySeam.includes('adoptContinuationRecoveryCandidates(')
    && /adoptContinuationRecoveryCandidates\(\s*text,\s*outcome\.continuationRecoveryCandidates,/.test(defaultClarifySeam)
    && defaultClarifySeam.includes('generate: () => runEphemeralGenerate(adoptedRecovery)')
    && !defaultClarifySeam.includes('runEphemeralGenerate(outcome.continuationRecoveryCandidates)')
  ));
  assert('ChatScreen packet helper never receives raw outcome recovery candidates', (
    !/runEphemeralGenerate\(outcome\.continuationRecoveryCandidates\)/.test(chatSrc)
    && /continuationRecoveryCandidates: \[\.\.\.continuationRecoveryCandidates\]/.test(chatSrc)
    && clarifySeam.includes('const adoptedRecovery = adoptContinuationRecoveryCandidates')
  ));
  const beforeDefaultClarify = clarifySeam.split("outcome.routeDecision.reason === 'default'")[0] ?? '';
  assert('non-default clarification does not wire recovery generate', (
    clarifySeam.includes("reason === 'default'")
    && !beforeDefaultClarify.includes('adoptContinuationRecoveryCandidates')
    && !beforeDefaultClarify.includes('runEphemeralGenerate')
    && (clarifySeam.match(/runEphemeralGenerate\(/g) ?? []).length === 1
    && clarifySeam.includes('runEphemeralGenerate(adoptedRecovery)')
  ));
  assert('offline fallback generate carries no recovery', (
    offlineSeam.includes("resolveEphemeralSeamGateADiag('offline_fallback'")
    && /generate: runEphemeralGenerate,/.test(offlineSeam)
    && !offlineSeam.includes('adoptContinuationRecoveryCandidates')
    && !offlineSeam.includes('adoptedRecovery')
    && !offlineSeam.includes('continuationRecoveryCandidates')
  ));

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ContinuationRecoveryEvidence: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('continuationRecoveryEvidence.test.ts')) {
  runContinuationRecoveryEvidenceTests().catch(console.error);
}
