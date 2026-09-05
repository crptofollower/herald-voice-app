// Smooth MVP Conversation Foundation — discourse continuity + unmarked acquisition deferral.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`
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
  DISCOURSE_TURN_TTL,
  DISCOURSE_WALL_MS,
  DiscourseContinuityHolder,
} from '../../src/routing/discourseContinuity.ts';
import {
  formatOperationalListClarification,
  isAmbiguousOperationalListAcquisition,
  isUnmarkedAcquisitionShape,
} from '../../src/routing/operationalListContinuity.ts';
import {
  buildVerifiedConversationalPacket,
  discourseFieldsForGenerateSite,
  formatVerifiedConversationalPacket,
} from '../../src/conversation/verifiedConversationalPacket.ts';
import { shouldRefuseLlmCaptureProposal } from '../../src/routing/speechActAuthority.ts';
import { EPHEMERAL_CLARIFY_REPLY } from '../../src/utils/ephemeralSeam.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const HERE = dirname(fileURLToPath(import.meta.url));

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
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL
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

function fresh(opts?: {
  now?: () => number;
  llmReady?: boolean;
  classifyLLM?: (t: string) => Promise<{ status: 'ok' | 'not_ready' | 'failed'; intents?: IntentRecord[]; reason?: string }>;
}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendarPresentation = new CalendarPresentationHolder();
  const calendar = new CalendarContinuationHolder();
  const discourse = new DiscourseContinuityHolder(opts?.now);
  let classifyCalls = 0;
  let classifyLlmCalls = 0;
  const innerLlm = opts?.classifyLLM ?? (async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }));
  const deps = {
    classifyQuery: async (t: string) => {
      classifyCalls++;
      return classifyQuery(t);
    },
    classifyLLM: async (t: string) => {
      classifyLlmCalls++;
      return innerLlm(t);
    },
    llmReady: opts?.llmReady ?? !!opts?.classifyLLM,
    captureContext: { contacts: [] as string[], lists: ['grocery'] as string[] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered, calendarPresentation, calendar, discourse);
  return {
    db, session, subject, medication, ordered, calendar, calendarPresentation, discourse, say,
    getClassifyCalls: () => classifyCalls,
    getClassifyLlmCalls: () => classifyLlmCalls,
  };
}

function ground(discourse: DiscourseContinuityHolder, text: string) {
  return formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: [text],
    pendingLabel: null,
    discourseTopic: discourse.peekTopic()?.displayName ?? null,
    discourseDomain: discourse.peekDomain()?.domain ?? null,
  }));
}

export async function runConversationFoundationSmoothMvpTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean, detail = '') {
    if (cond) { console.log(`${GREEN}PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}FAIL${RESET}  ${name} ${detail}`); failures.push(name); }
  }

  const NARRATIVE_PERSON = [
    'Apollo has always been anxious about flying.',
    'Marcus told me about the concert yesterday.',
  ];
  for (const line of NARRATIVE_PERSON) {
    const { discourse, say, subject } = fresh();
    await say(line);
    const name = line.startsWith('Apollo') ? 'Apollo' : 'Marcus';
    assert(`narrative person mention establishes non-authoritative topic (${name})`, (
      discourse.peekTopic()?.kind === 'person_mention'
      && discourse.peekTopic()?.displayName === name
      && !subject.hasLive()
    ));
  }

  {
    const { discourse, say } = fresh();
    await say('Apollo has always been anxious about flying.');
    await say('how is he doing today');
    const fmt = ground(discourse, 'how is he doing today');
    assert('pronoun continuation receives topic grounding', (
      /DISCOURSE CONTINUITY/.test(fmt)
      && /recent conversational grounding only/.test(fmt)
      && /not stored personal truth/.test(fmt)
      && /not action authority/.test(fmt)
      && fmt.includes('- person: Apollo')
    ));
  }

  {
    const { discourse, say } = fresh();
    await say('Marcus told me about the concert yesterday.');
    await say('Who was I talking about?');
    const fmt = ground(discourse, 'Who was I talking about?');
    assert('topic lookup receives person grounding', fmt.includes('- person: Marcus'));
  }

  {
    const { discourse, say } = fresh();
    await say('Apollo has always been anxious about flying.');
    await say('I like pizza tonight');
    await say('the weather is fine');
    assert('topic survives bounded unrelated intervening turns', discourse.peekTopic()?.displayName === 'Apollo');
  }

  {
    const { discourse, say } = fresh();
    await say('Apollo has always been anxious about flying.');
    for (let i = 0; i < DISCOURSE_TURN_TTL; i++) await say('okay then');
    assert('topic still live at turn TTL boundary', discourse.peekTopic()?.displayName === 'Apollo');
    await say('okay then');
    assert('topic expires after turn TTL', discourse.peekTopic() === null);
  }

  {
    let now = 1_000_000;
    const { discourse, say } = fresh({ now: () => now });
    await say('Apollo has always been anxious about flying.');
    now += DISCOURSE_WALL_MS + 1;
    await say('okay then');
    assert('topic expires after wall-clock TTL', discourse.peekTopic() === null);
  }

  {
    const { discourse, say } = fresh();
    await say('Apollo has always been anxious about flying.');
    await say('Marcus told me about the concert yesterday.');
    assert('new person supersedes old person', discourse.peekTopic()?.displayName === 'Marcus');
  }

  {
    const { discourse, say } = fresh();
    const secretId = writeContactRaw({ name: 'Pat', relationship: 'wife', phone: '5551112222', importance: 8 });
    await say('Pat has always been anxious about flying.');
    const slot = JSON.stringify(discourse.peekTopic());
    const fmt = ground(discourse, 'how is he doing today');
    assert('topic state has no IDs/phones/addresses/action authority', (
      discourse.peekTopic()?.displayName === 'Pat'
      && !slot.includes(secretId)
      && !slot.includes('5551112222')
      && !fmt.includes(secretId)
      && !fmt.includes('5551112222')
      && /not action authority/.test(fmt)
    ));
  }

  {
    const { discourse, say } = fresh();
    const groc = await say('add milk to my grocery list');
    assert('successful grocery write establishes grocery domain', (
      groc.handled === true
      && groc.source === 'capture'
      && discourse.peekDomain()?.domain === 'grocery'
      && !('itemId' in (discourse.peekDomain() ?? {}))
    ));
  }

  {
    const { discourse, say } = fresh();
    const todo = await say('I need to call the dentist');
    assert('successful todo write establishes todo domain', (
      todo.handled === true
      && todo.source === 'capture'
      && discourse.peekDomain()?.domain === 'todo'
    ));
  }

  {
    const { discourse, say } = fresh();
    await say('add milk to my grocery list');
    await say('I need to call the dentist');
    assert('new operational domain supersedes old', discourse.peekDomain()?.domain === 'todo');
  }

  const CONTINUATION_ITEMS = ['bananas', 'paper towels'];
  for (const item of CONTINUATION_ITEMS) {
    const { discourse, say, getClassifyCalls } = fresh();
    await say('add milk to my grocery list');
    const before = getClassifyCalls();
    const cont = await say(`add ${item} too`);
    assert(`add ${item} too binds to live grocery domain without extra classifier`, (
      cont.handled === true
      && cont.source === 'capture'
      && /grocery list/i.test(cont.responseText)
      && discourse.peekDomain()?.domain === 'grocery'
      && getClassifyCalls() === before
    ));
  }

  {
    const { say } = fresh();
    const none = await say('add bananas too');
    assert('no live domain → continuation does not guess', (
      !none.handled
      && none.routeDecision.kind === 'needs_clarification'
    ));
  }

  {
    const { discourse, say } = fresh();
    await say('I need to call the dentist');
    await new Promise((r) => setTimeout(r, 5));
    const cont = await say('add bananas too');
    assert('cross-domain non-bleed: todo domain does not grocery-write continuation', (
      cont.handled === true
      && /to-do/i.test(cont.responseText)
      && discourse.peekDomain()?.domain === 'todo'
    ));
  }

  const UNMARKED_ACQUISITION = [
    'I need to go pick up milk and eggs later.',
    'I have to pick up oats and yogurt this evening.',
  ];
  for (const phrase of UNMARKED_ACQUISITION) {
    const d = await classifyQuery(phrase);
    assert(`unmarked 2+ NP acquisition reaches classifier rather than auto-commit (${phrase.slice(0, 24)})`, (
      d.tier === 3
      && d.reason === 'ambiguous_operational_list'
      && d.actionIntent == null
      && isAmbiguousOperationalListAcquisition(phrase)
      && isUnmarkedAcquisitionShape(phrase)
    ));
  }

  {
    const phrase = 'I need to go pick up milk and eggs later.';
    const { say, getClassifyLlmCalls } = fresh({
      llmReady: true,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] }),
    });
    const out = await say(phrase);
    assert('qualifying 2+ simple-segment acquisition calls classifyLLM once', (
      getClassifyLlmCalls() === 1
      && !out.handled
      && out.routeDecision.reason === 'ambiguous_operational_list'
    ));
  }

  const SINGLE_ITEM_TODO = [
    'I need to go pick up my dry cleaning.',
    'I need to get my car inspected.',
  ];
  for (const phrase of SINGLE_ITEM_TODO) {
    const d = await classifyQuery(phrase);
    const { say, getClassifyLlmCalls } = fresh({
      llmReady: true,
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'list_add', items: ['trap'], listName: 'grocery' }],
      }),
    });
    const out = await say(phrase);
    assert(`single-item unmarked acquisition is deterministic todo with zero classifyLLM (${phrase.slice(0, 28)})`, (
      !isAmbiguousOperationalListAcquisition(phrase)
      && d.actionIntent?.type === 'todo_add'
      && d.reason === 'action:todo_add'
      && out.handled === true
      && out.source === 'capture'
      && getClassifyLlmCalls() === 0
    ));
  }

  const SHAPE_ALONE = [
    'I need to go pick up Hunter and Grant later.',
    'I need to pick up my dry cleaning and prescription.',
  ];
  for (const phrase of SHAPE_ALONE) {
    const d = await classifyQuery(phrase);
    assert(`shape alone never determines grocery (${phrase.slice(0, 28)})`, (
      d.actionIntent?.type !== 'list_add'
      && d.reason === 'ambiguous_operational_list'
      && isAmbiguousOperationalListAcquisition(phrase)
    ));
  }

  {
    const phrase = 'I need to call Paul and send Mickey the document.';
    const d = await classifyQuery(phrase);
    assert('call-Paul/send-Mickey stays action/todo, not grocery inference', (
      !isUnmarkedAcquisitionShape(phrase)
      && d.actionIntent?.type === 'todo_add'
      && d.actionIntent.type !== 'list_add'
    ));
  }

  {
    const { db, say } = fresh({
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
      }),
    });
    const out = await say('I need to go pick up milk and eggs later.');
    const rows = db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number };
    assert('structured LLM list proposal cannot write before confirmation', (
      out.handled === true
      && out.source === 'capture'
      && /Say yes and I'll remember that/i.test(out.responseText)
      && rows.n === 0
    ));
  }

  {
    const narration = 'I bought milk yesterday.';
    const proposal: IntentRecord[] = [{ type: 'list_add', items: ['milk'], listName: 'grocery' }];
    assert('existing refusal fence still applies to list_add proposals', shouldRefuseLlmCaptureProposal(narration, proposal) === true);
    const { say } = fresh({
      classifyLLM: async () => ({ status: 'ok', intents: proposal }),
    });
    const out = await say(narration);
    assert('refused LLM list_add does not capture', (
      !out.handled
      && out.routeDecision.kind === 'needs_clarification'
    ));
  }

  const CLARIFY_SHAPES = [
    { status: 'ok' as const, intents: [{ type: 'pass' as const }] },
    { status: 'not_ready' as const, reason: 'in-flight' as const },
    { status: 'failed' as const, reason: 'completion_error' as const },
  ];
  for (const llm of CLARIFY_SHAPES) {
    const { say } = fresh({
      classifyLLM: async () => llm,
    });
    const phrase = 'I need to go pick up milk and eggs later.';
    const out = await say(phrase);
    const expected = formatOperationalListClarification('milk and eggs');
    assert(`pass/not_ready/failed uses contextual clarification (${llm.status})`, (
      !out.handled
      && out.routeDecision.kind === 'needs_clarification'
      && out.routeDecision.reason === 'ambiguous_operational_list'
      && formatOperationalListClarification(out.routeDecision.guess ?? '') === expected
      && expected !== EPHEMERAL_CLARIFY_REPLY
    ));
  }

  {
    const { session, say } = fresh({
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
      }),
    });
    await say('I need to go pick up milk and eggs later.');
    const declined = await say('no');
    assert('declining ambiguous LLM proposal keeps contextual clarification', (
      declined.handled === true
      && declined.source === 'pending_resume'
      && /grocery list, or as a to-do/i.test(declined.responseText)
      && !/won't remember that/i.test(declined.responseText)
      && !session.hasPending()
    ));
  }

  {
    const { say } = fresh();
    const med = await say('I started taking lisinopril 10mg yesterday');
    assert('medical/narrative capture remains unaffected', (
      med.handled === true
      && med.source === 'capture'
    ));
  }

  {
    const { medication, say } = fresh();
    const med = writeMedication({ name: 'Eliquis', dosage: '5mg', frequency: 'twice daily' });
    medication.beginUserTurn();
    medication.establish([med.id]);
    const ordinal = await say('tell me about the first one');
    assert('existing medication continuation remains unchanged', ordinal.handled === true && ordinal.source === 'referent_resume');
  }

  {
    const { calendar, say } = fresh();
    calendar.beginUserTurn();
    calendar.establish('calendar:week');
    const cal = await say('what about tomorrow');
    assert('existing calendar continuation remains unchanged', cal.handled === true && cal.source === 'referent_resume');
  }

  {
    const chatSrc = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');
    const clarifySeam = chatSrc.match(
      /if \(outcome\.routeDecision\.kind === 'needs_clarification'\) \{[\s\S]*?speak\(reply\);/,
    )?.[0] ?? '';
    assert('ChatScreen uses contextual operational-list clarification, not generic dead-end', (
      clarifySeam.includes("reason === 'ambiguous_operational_list'")
      && clarifySeam.includes('formatOperationalListClarification')
      && /reason === 'ambiguous_operational_list'[\s\S]*reason === 'default'/.test(clarifySeam)
    ));

    const liveDiscourse = { topic: 'Apollo', domain: 'grocery' as const };
    const offlinePacket = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: ['how is he doing today'],
      pendingLabel: null,
      ...discourseFieldsForGenerateSite('offline_fallback', liveDiscourse),
    });
    const conversationalPacket = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: ['how is he doing today'],
      pendingLabel: null,
      ...discourseFieldsForGenerateSite('needs_clarification_default', liveDiscourse),
    });
    assert('offline_fallback packet contains no discourseTopic/discourseDomain', (
      offlinePacket.discourseTopic === null
      && offlinePacket.discourseDomain === null
      && !formatVerifiedConversationalPacket(offlinePacket).includes('- person:')
      && !formatVerifiedConversationalPacket(offlinePacket).includes('- list:')
    ));
    assert('needs_clarification/default seam receives live discourse topic grounding', (
      conversationalPacket.discourseTopic === 'Apollo'
      && conversationalPacket.discourseDomain === 'grocery'
      && formatVerifiedConversationalPacket(conversationalPacket).includes('- person: Apollo')
      && /recent conversational grounding only/.test(formatVerifiedConversationalPacket(conversationalPacket))
    ));
    assert('ChatScreen scopes discourse grounding to needs_clarification/default generate only', (
      chatSrc.includes("runEphemeralGenerate(adoptedRecovery, 'needs_clarification_default')")
      && chatSrc.includes("generateSite: ConversationalGenerateSite = 'offline_fallback'")
      && chatSrc.includes('discourseFieldsForGenerateSite(generateSite')
      && /generate: runEphemeralGenerate,/.test(chatSrc)
    ));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationFoundationSmoothMvp: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationFoundationSmoothMvp.test.ts')) {
  runConversationFoundationSmoothMvpTests().catch(console.error);
}
