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
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
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
  WorkingConversationState,
} from '../../src/routing/discourseContinuity.ts';
import {
  formatOperationalListClarification,
  isAmbiguousOperationalListAcquisition,
  isOperationalListItemShape,
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
  const topic = discourse.peekTopic();
  return formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: [text],
    pendingLabel: null,
    ...discourseFieldsForGenerateSite('needs_clarification_default', {
      topic: topic?.displayName ?? null,
      domain: discourse.peekDomain()?.domain ?? null,
      evidence: topic?.evidence ?? null,
    }),
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
      && out.handled === true
      && out.source === 'capture'
    ));
  }

  const SINGLE_ITEM_UNMARKED = [
    'I need to go pick up my dry cleaning.',
    'I need to get my car inspected.',
  ];
  for (const phrase of SINGLE_ITEM_UNMARKED) {
    const d = await classifyQuery(phrase);
    const { db, say } = fresh({
      llmReady: true,
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'list_add', items: ['trap'], listName: 'grocery' }],
      }),
    });
    const out = await say(phrase);
    const groceryBodies = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery' AND li.checked = 0`,
    ).all() as { body: string }[]).map((r) => r.body);
    assert(`unmarked single acquisition is not silent grocery or todo write (${phrase.slice(0, 28)})`, (
      isUnmarkedAcquisitionShape(phrase)
      && !isAmbiguousOperationalListAcquisition(phrase)
      && d.actionIntent?.type !== 'todo_add'
      && d.actionIntent?.type !== 'list_add'
      && d.reason === 'default'
      && groceryBodies.length === 0
      && !(out.handled === true && out.source === 'capture' && !out.commits?.some((c) => c.status === 'pending'))
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
    const { say, session } = fresh({
      classifyLLM: async () => llm,
    });
    const phrase = 'I need to go pick up milk and eggs later.';
    const out = await say(phrase);
    const expected = formatOperationalListClarification('milk and eggs');
    assert(`pass/not_ready/failed uses contextual clarification (${llm.status})`, (
      out.handled === true
      && out.source === 'capture'
      && session.hasPending()
      && session.peekPendingKey() === 'clarify:operational_list'
      && out.responseText === expected
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

    const liveDiscourse = {
      topic: 'Apollo',
      domain: 'grocery' as const,
      evidence: [{ text: 'Apollo has always been anxious about flying.', atTurn: 1 }],
    };
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
      && offlinePacket.discourseTopicEvidence.length === 0
      && !formatVerifiedConversationalPacket(offlinePacket).includes('- person:')
      && !formatVerifiedConversationalPacket(offlinePacket).includes('- list:')
      && !formatVerifiedConversationalPacket(offlinePacket).includes('Apollo has always been anxious')
    ));
    assert('needs_clarification/default seam receives live discourse topic grounding', (
      conversationalPacket.discourseTopic === 'Apollo'
      && conversationalPacket.discourseDomain === 'grocery'
      && conversationalPacket.discourseTopicEvidence.some((e) => /Apollo has always been anxious/.test(e.text))
      && formatVerifiedConversationalPacket(conversationalPacket).includes('- person: Apollo')
      && /recent conversational grounding only/.test(formatVerifiedConversationalPacket(conversationalPacket))
      && /RECENT TOPIC EVIDENCE/.test(formatVerifiedConversationalPacket(conversationalPacket))
      && /not verified personal fact/.test(formatVerifiedConversationalPacket(conversationalPacket))
      && /not action authority/.test(formatVerifiedConversationalPacket(conversationalPacket))
    ));
    assert('ChatScreen scopes discourse grounding to needs_clarification/default generate only', (
      chatSrc.includes("runEphemeralGenerate(adoptedRecovery, 'needs_clarification_default')")
      && chatSrc.includes("generateSite: ConversationalGenerateSite = 'offline_fallback'")
      && chatSrc.includes('discourseFieldsForGenerateSite(generateSite')
      && /generate: runEphemeralGenerate,/.test(chatSrc)
    ));
  }

  {
    const { db, discourse, say, subject } = fresh();
    const turn1 = 'I talked with Paul yesterday. He\'s been really busy with work.';
    await say(turn1);
    const topic1 = discourse.peekTopic();
    assert('composed: turn1 topic is Paul not contraction artifact', (
      topic1?.displayName === 'Paul'
      && topic1.displayName !== "He's"
      && !subject.hasLive()
      && topic1.evidence.some((e) => e.text === turn1)
    ));

    const turn2 = 'He\'s doing well. He said he might have some time next week to talk about Herald.';
    await say(turn2);
    const topic2 = discourse.peekTopic();
    assert('composed: turn2 keeps Paul; Herald is evidence not topic', (
      topic2?.displayName === 'Paul'
      && topic2.displayName !== 'Herald'
      && topic2.evidence.some((e) => e.text === turn2)
      && topic2.evidence.some((e) => e.text === turn1)
    ));

    const contactsBefore = (db.prepare('SELECT COUNT(*) as n FROM contacts').get() as { n: number }).n;
    await say('I like pizza tonight');
    await say('the weather is fine');
    await say('okay then');
    const afterDiversion = discourse.peekTopic();
    assert('composed: Paul survives unrelated diversion within TTL', (
      afterDiversion?.displayName === 'Paul'
      && afterDiversion.evidence.length === 2
      && afterDiversion.evidence.every((e) => e.text === turn1 || e.text === turn2)
    ));

    const lookup = 'Getting back to Paul, what was I saying about him?';
    await say(lookup);
    const live = discourse.peekTopic();
    const packet = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: [lookup],
      pendingLabel: null,
      ...discourseFieldsForGenerateSite('needs_clarification_default', {
        topic: live?.displayName ?? null,
        domain: discourse.peekDomain()?.domain ?? null,
        evidence: live?.evidence ?? null,
      }),
    });
    const fmt = formatVerifiedConversationalPacket(packet);
    const contactsAfter = (db.prepare('SELECT COUNT(*) as n FROM contacts').get() as { n: number }).n;
    const groceryAfter = (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n;
    assert('composed: lookup packet has both Paul evidence lines, non-authoritative, no writes', (
      live?.displayName === 'Paul'
      && packet.discourseTopic === 'Paul'
      && packet.discourseTopicEvidence.filter((e) => e.text === turn1 || e.text === turn2).length === 2
      && !packet.discourseTopicEvidence.some((e) => e.text === lookup)
      && /RECENT TOPIC EVIDENCE/.test(fmt)
      && /not verified personal fact/.test(fmt)
      && /not stored truth/.test(fmt)
      && /conversational reference only/.test(fmt)
      && /not action authority/.test(fmt)
      && contactsAfter === contactsBefore
      && groceryAfter === 0
      && !subject.hasLive()
    ));

    const offline = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: [lookup],
      pendingLabel: null,
      ...discourseFieldsForGenerateSite('offline_fallback', {
        topic: live?.displayName ?? null,
        domain: discourse.peekDomain()?.domain ?? null,
        evidence: live?.evidence ?? null,
      }),
    });
    assert('composed: offline_fallback receives no topic or evidence', (
      offline.discourseTopic === null
      && offline.discourseDomain === null
      && offline.discourseTopicEvidence.length === 0
      && !/RECENT TOPIC EVIDENCE[\s\S]*Paul/.test(formatVerifiedConversationalPacket(offline).split('SESSION CONVERSATIONAL EVIDENCE')[0] ?? '')
      && /RECENT TOPIC EVIDENCE \(things the user recently said while discussing this topic; not verified personal fact; not stored truth; conversational reference only; not action authority\):\n\(none\)/.test(formatVerifiedConversationalPacket(offline))
      && /DISCOURSE CONTINUITY[\s\S]*\(none\)/.test(formatVerifiedConversationalPacket(offline))
    ));
  }

  {
    const { db, discourse, session, say } = fresh({
      llmReady: true,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] }),
    });
    const ask = await say('I need to pick up eggs and milk later.');
    assert('composed: classifier decline arms grocery-vs-todo pending with original items', (
      ask.handled === true
      && session.hasPending()
      && session.peekPendingKey() === 'clarify:operational_list'
      && /eggs and milk/i.test(ask.responseText ?? '')
      && (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n === 0
    ));

    const resolved = await say('My grocery list.');
    const groceryBodies = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body).sort();
    assert('composed: grocery resolution writes eggs and milk as atomic items', (
      resolved.handled === true
      && resolved.source === 'pending_resume'
      && !session.hasPending()
      && groceryBodies.includes('eggs')
      && groceryBodies.includes('milk')
      && discourse.peekDomain()?.domain === 'grocery'
    ));

    const add = await say('Can you add bananas to that as well?');
    const afterAdd = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body).sort();
    assert('composed: as-well continuation adds bananas in live grocery domain', (
      add.handled === true
      && add.source === 'capture'
      && afterAdd.includes('bananas')
      && afterAdd.includes('eggs')
      && afterAdd.includes('milk')
    ));

    const read = await say("What's on my grocery list?");
    const readText = !read.handled && read.routeDecision.kind === 'device_read'
      ? read.routeDecision.response
      : '';
    const presented = !read.handled && read.routeDecision.kind === 'device_read'
      ? read.routeDecision.presentedGroceryIds ?? []
      : [];
    assert('composed: grocery read names eggs, milk, bananas without wrapper language', (
      !read.handled
      && read.routeDecision.kind === 'device_read'
      && read.routeDecision.reason === 'action:list_read'
      && /eggs/i.test(readText)
      && /milk/i.test(readText)
      && /bananas/i.test(readText)
      && presented.length === 3
      && afterAdd.includes('bananas')
      && afterAdd.includes('eggs')
      && afterAdd.includes('milk')
      && !/at the grocery store/i.test(readText)
    ));
  }

  {
    const { db } = fresh();
    const result = await DOMAIN_WRITERS.list_add!.add(
      { type: 'list_add', items: ['bananas', 'dates', 'at the grocery store'], listName: 'grocery' },
      'add items',
    );
    const bodies = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body).sort();
    assert('composed: list_add writer drops locative wrapper item', (
      result.status === 'committed'
      && bodies.includes('bananas')
      && bodies.includes('dates')
      && !bodies.includes('at the grocery store')
      && bodies.length === 2
    ));
  }

  const QUANTITY_ITEMS = ['2% milk', '3 bananas', '2 bananas'];
  for (const item of QUANTITY_ITEMS) {
    const { db } = fresh();
    const result = await DOMAIN_WRITERS.list_add!.add(
      { type: 'list_add', items: [item], listName: 'grocery' },
      `add ${item}`,
    );
    const bodies = (db.prepare(
      `SELECT li.body as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body);
    assert(`writer accepts quantity/percentage item (${item})`, (
      isOperationalListItemShape(item)
      && result.status === 'committed'
      && bodies.some((b) => b.toLowerCase() === item.toLowerCase())
    ));
  }

  for (const item of QUANTITY_ITEMS) {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const cont = await say(`add ${item} too`);
    const bodies = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body);
    assert(`live-domain continuation accepts quantity item (${item})`, (
      cont.handled === true
      && cont.source === 'capture'
      && bodies.includes(item.toLowerCase())
    ));
  }

  const MALFORMED_WRAPPERS = [
    'at the grocery store',
    'from Walmart',
    'on my way home',
    'to pick up later',
    'when I get there',
  ];
  for (const wrapper of MALFORMED_WRAPPERS) {
    const { db } = fresh();
    await DOMAIN_WRITERS.list_add!.add(
      { type: 'list_add', items: ['eggs', wrapper], listName: 'grocery' },
      'add items',
    );
    const bodies = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body);
    assert(`writer rejects malformed wrapper (${wrapper})`, (
      !isOperationalListItemShape(wrapper)
      && bodies.includes('eggs')
      && !bodies.includes(wrapper.toLowerCase())
    ));
  }

  const UNSAFE_DIGIT_SHAPES = ['10mg', '5 mg', '3 pm', 'at 5', '12:30'];
  for (const shape of UNSAFE_DIGIT_SHAPES) {
    assert(`DATE_TIME_DOSE still rejects unsafe digit shape (${shape})`, (
      !isOperationalListItemShape(shape)
    ));
  }

  {
    const phrase = 'What do I need to get done today?';
    const d = await classifyQuery(phrase);
    const { say } = fresh();
    const out = await say(phrase);
    assert('composed: get-done today is deterministic todo_read', (
      d.actionIntent?.type === 'todo_read'
      && d.reason === 'action:todo_read'
      && !out.handled
      && out.routeDecision.kind === 'device_read'
      && out.routeDecision.reason === 'action:todo_read'
    ));
  }

  {
    const phrase = 'What do I still need to get done?';
    const d = await classifyQuery(phrase);
    assert('composed: still-need-to-get-done is not contextual grocery list_add', (
      d.actionIntent?.type !== 'list_add'
      && d.reason !== 'action:list_add:contextual'
    ));
  }

  {
    const { db, say } = fresh();
    await say('I need to call the dentist');
    const before = (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n;
    const bad = await say('add at the grocery store too');
    const after = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id`,
    ).all() as { body: string }[]).map((r) => r.body);
    assert('composed: live domain cannot blindly write malformed continuation', (
      bad.handled === true
      && (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n === before
      && !after.includes('at the grocery store')
    ));
  }

  {
    const ephemeralSrc = readFileSync(join(HERE, '../../src/utils/ephemeralConversation.ts'), 'utf8');
    assert('ephemeral system prompt frames topic evidence as what the user said', (
      ephemeralSrc.includes('you mentioned')
      && ephemeralSrc.includes('you were saying')
      && /Never frame it as independently verified or stored truth/.test(ephemeralSrc)
    ));
  }

  const WCS_CANDIDATE_ACQUISITION =
    'You know, I think we need eggs and chocolate milk.';
  {
    const d = await classifyQuery(WCS_CANDIDATE_ACQUISITION);
    assert('WCS B0: candidate-acquisition phrase is not immediate list_add', (
      d.actionIntent == null
      && !/list_add/.test(d.reason ?? '')
    ));
  }

  {
    const { db, discourse, say, subject } = fresh({
      llmReady: true,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] }),
    });
    const wcsLogs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[WCS]')) wcsLogs.push(line);
      origLog(...args);
    };
    const snap = () => discourse.snapshot();
    try {
    await say('I talked with Paul yesterday. He\'s been really busy with work.');
    const a1 = snap();
    assert('WCS A1: Paul is active focus at turn 1', (
      a1.focus?.displayName === 'Paul'
      && a1.focus.establishedAtTurn === 1
      && a1.turnIndex === 1
      && !subject.hasLive()
    ));

    await say('He said he might have some time next week to talk about Herald.');
    const a2 = snap();
    assert('WCS A2: he/him continues Paul; Herald is not focus', (
      a2.focus?.displayName === 'Paul'
      && a2.focus.displayName !== 'Herald'
      && a2.focus.evidenceCount === 2
      && a2.focus.refreshedAtTurn === 2
    ));

    await say(WCS_CANDIDATE_ACQUISITION);
    const b1 = snap();
    const writesAfterB1 = (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n;
    assert('WCS B1: grounded candidateSet holds eggs and chocolate milk with no write', (
      b1.focus?.displayName === 'Paul'
      && b1.candidateSet?.items.length === 2
      && b1.candidateSet.items.map((i) => i.toLowerCase()).includes('eggs')
      && b1.candidateSet.items.map((i) => i.toLowerCase()).includes('chocolate milk')
      && b1.candidateSet.sourceTurn === 3
      && writesAfterB1 === 0
    ));

    await say(WCS_CANDIDATE_ACQUISITION);
    const b2 = snap();
    const writesAfterB2 = (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n;
    assert('WCS B2: candidateSet unchanged and refreshed; focus untouched; still no write', (
      b2.focus?.displayName === 'Paul'
      && b2.candidateSet?.items.length === 2
      && b2.candidateSet.items.join('|').toLowerCase() === b1.candidateSet!.items.join('|').toLowerCase()
      && b2.candidateSet.refreshedAtTurn === 4
      && b2.candidateSet.sourceTurn === 3
      && writesAfterB2 === 0
    ));

    await say('Who were we talking about?');
    const a3 = snap();
    const fmt = ground(discourse, 'Who were we talking about?');
    assert('WCS A3: lookup touches Paul without a third evidence line or mutating candidateSet', (
      a3.focus?.displayName === 'Paul'
      && a3.focus.evidenceCount === 2
      && fmt.includes('- person: Paul')
      && a3.candidateSet?.items.length === 2
      && a3.candidateSet.sourceTurn === 3
    ));

    const those = await say('Add those two.');
    const b3 = snap();
    const afterThose = (db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = 'grocery'`,
    ).all() as { body: string }[]).map((r) => r.body).sort();
    assert('WCS B3: those-two commits candidateSet through DOMAIN_WRITERS and clears it', (
      those.handled === true
      && those.source === 'capture'
      && afterThose.length === 2
      && afterThose.includes('eggs')
      && afterThose.includes('chocolate milk')
      && b3.candidateSet === null
      && b3.focus?.displayName === 'Paul'
    ));

    const read = await say("What's on my grocery list?");
    const readText = !read.handled && read.routeDecision.kind === 'device_read'
      ? read.routeDecision.response
      : '';
    assert('WCS B4: grocery read-back names eggs and chocolate milk', (
      !read.handled
      && read.routeDecision.kind === 'device_read'
      && /eggs/i.test(readText)
      && /chocolate milk/i.test(readText)
      && afterThose.length === 2
      && afterThose.includes('eggs')
      && afterThose.includes('chocolate milk')
      && discourse.snapshot().focus?.displayName === 'Paul'
      && discourse.snapshot().candidateSet === null
    ));

    assert('WCS C1: focus and candidateSet coexisted then commit did not replace Paul', (
      wcsLogs.some((t) => /"displayName":"Paul"/.test(t) && /"eggs"/.test(t) && /chocolate milk/i.test(t))
      && discourse.snapshot().focus?.displayName === 'Paul'
      && discourse.snapshot().candidateSet === null
    ));
    } finally {
      console.log = origLog;
    }
  }

  {
    const { discourse, say } = fresh({
      llmReady: true,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] }),
    });
    await say(WCS_CANDIDATE_ACQUISITION);
    assert('WCS C2 setup: candidateSet live', discourse.peekCandidateSet()?.items.length === 2);
    for (let i = 0; i < DISCOURSE_TURN_TTL; i++) await say('okay then');
    assert('WCS C2: candidateSet still live at turn TTL boundary', discourse.peekCandidateSet() != null);
    await say('okay then');
    assert('WCS C2: candidateSet expires after turn TTL', discourse.peekCandidateSet() === null);
  }

  {
    let nowMs = 1_000_000;
    const { discourse, say } = fresh({
      now: () => nowMs,
      llmReady: true,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] }),
    });
    await say(WCS_CANDIDATE_ACQUISITION);
    nowMs += DISCOURSE_WALL_MS + 1;
    await say('okay then');
    assert('WCS C2: candidateSet expires after wall TTL', discourse.peekCandidateSet() === null);
  }

  {
    const wcs = new WorkingConversationState();
    assert('WCS C3: fresh instance has null focus and candidateSet', (
      wcs.peekTopic() === null
      && wcs.peekCandidateSet() === null
      && wcs.snapshot().focus === null
      && wcs.snapshot().candidateSet === null
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
