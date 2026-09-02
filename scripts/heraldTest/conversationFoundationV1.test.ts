// Conversation Foundation V1 — owner/authority corpus (not wording of Qwen).
//
// Runner: npx tsx scripts/heraldTest/conversationFoundationV1.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { composeAck } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import {
  extractListRemoveAcquisitionItem,
  extractTodoCompleteMutation,
} from '../../src/utils/instructionSignals.ts';
import {
  EPHEMERAL_CLARIFY_REPLY,
  extractBiographyInquiryName,
  mayRunGenerativeEphemeralPersonalProse,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';
import { isEligibleForEphemeralConversation as isEligible } from '../../src/utils/ephemeralConversation.ts';
import {
  buildVerifiedConversationalPacket,
  formatVerifiedConversationalPacket,
  packetHasVerifiedFactsForName,
  packetMentionsName,
} from '../../src/conversation/verifiedConversationalPacket.ts';
import { EXPERIMENTAL_QWEN_SYSTEM_PROMPT } from '../../src/conversation/experimentalQwenLlamaWorker.ts';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL,
    all_day   INTEGER DEFAULT 0,
    notes     TEXT,
    cached_at TEXT NOT NULL
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

const SEAM_READY = {
  reason: 'default' as const,
  hasPendingSession: false,
  hasContactCollectPending: false,
  rdTier: 3 as const,
  hasStructuredCaptures: false,
  isPersonalCaptureRisk: false,
  llmStatus: 'ready' as const,
  classifierBusy: false,
  ephemeralBusy: false,
};

const PAUL =
  'I talked to Paul yesterday about Herald. He thinks the memory is the part that could really make this a different product.';

export async function runConversationFoundationV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversation Foundation V1 ------------------------------${RESET}`);

  const mayPaul = mayRunGenerativeEphemeralPersonalProse({
    reason: 'default',
    text: PAUL,
    hasAuthorizedContinuation: false,
    hasPendingSession: false,
    hasContactCollectPending: false,
    isEligible: isEligible(PAUL, false),
    threadEvidence: '',
  });
  assert('CF-1 first-person Paul report is Qwen-eligible', mayPaul, (v) => v === true, 'true');

  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: PAUL,
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'That tracks with what you heard.' };
      },
    });
    assert('CF-2 Paul report is generative owner', outcome.kind, (v) => v === 'generative', 'generative');
    assert('CF-3 Paul report invokes generate', generateCalled, (v) => v === true, 'true');
    assert(
      'CF-4 Paul report is not canned clarify',
      outcome.reply,
      (v) => v !== EPHEMERAL_CLARIFY_REPLY,
      'not EPHEMERAL_CLARIFY_REPLY',
    );
  }

  freshDB();
  assert(
    'CF-5 Paul report is not a capability mutation',
    (await classifyQuery(PAUL)).actionIntent,
    (v) => v == null,
    'no actionIntent',
  );

  const follow =
    "Yeah I think he's right but I'm still worried that the conversation doesn't feel natural enough.";
  assert(
    'CF-6 follow-up concern is eligible with continuation',
    isEligible(follow, true),
    (v) => v === true,
    'true',
  );

  const advice = 'What would you do if you were me?';
  assert('CF-7 advice question is eligible without continuation', isEligible(advice, false), (v) => v === true, 'true');

  freshDB();
  for (const phrase of ['How are you?', 'How are you today?', "How's it going?"]) {
    const greet = await classifyQuery(phrase);
    assert(
      `CF-8 social check-in class "${phrase}"`,
      greet.reason,
      (v) => v === 'chit_chat:social_checkin',
      'chit_chat:social_checkin',
    );
  }

  assert(
    'CF-9 Tell me about Marcus is a biography inquiry',
    extractBiographyInquiryName('Tell me about Marcus.'),
    (v) => v === 'Marcus',
    'Marcus',
  );
  assert(
    'CF-9b What do you know about Apollo is a biography inquiry',
    extractBiographyInquiryName('What do you know about Apollo?'),
    (v) => v === 'Apollo',
    'Apollo',
  );
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'What do you know about Apollo?',
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Apollo carried anxiety for decades.' };
      },
    });
    assert('CF-10 Apollo inquiry is honest miss not Qwen invention', generateCalled, (v) => v === false, 'false');
    assert(
      'CF-11 Apollo inquiry is not canned follow-confusion',
      outcome.reply,
      (v) => typeof v === 'string' && v !== EPHEMERAL_CLARIFY_REPLY && /don't have anything stored about Apollo/i.test(v),
      'honest miss',
    );
  }
  assert(
    'CF-12 Qwen prompt forbids invented biography',
    EXPERIMENTAL_QWEN_SYSTEM_PROMPT,
    (v) =>
      /Do not invent facts about the person/i.test(String(v))
      && /USER-SUPPLIED MENTIONS/i.test(String(v)),
    'prompt contract binds attributes to packet sections',
  );

  freshDB();
  const remove = await classifyQuery('Remove eggs from my grocery list.');
  assert(
    'CF-13 explicit list_remove is structurally sufficient',
    remove.actionIntent,
    (v) => (v as { type?: string; item?: string } | undefined)?.type === 'list_remove'
      && (v as { item?: string }).item === 'eggs',
    'list_remove eggs',
  );

  freshDB();
  const addEggs = await classifyQuery('Add eggs to my grocery list.');
  assert(
    'CF-13b explicit list_add is structurally sufficient',
    addEggs.actionIntent,
    (v) => (v as { type?: string } | undefined)?.type === 'list_add',
    'list_add',
  );

  freshDB();
  const listRead = await classifyQuery("What's on my grocery list?");
  assert(
    'CF-14 grocery read is deterministic',
    listRead.reason,
    (v) => typeof v === 'string' && /list/i.test(v),
    'list read',
  );

  freshDB();
  const callMom = await classifyQuery('Call Mom.');
  assert('CF-15 Call Mom is deterministic CALL', callMom.actionIntent?.type, (v) => v === 'call', 'call');

  freshDB();
  const sms = await classifyQuery("text sarah i'm on my way");
  assert('CF-16 explicit SMS remains SMS', sms.actionIntent?.type, (v) => v === 'sms', 'sms');

  freshDB();
  const reminder = await classifyQuery('remind me to take my medication at 11:30');
  assert('CF-17 explicit reminder remains reminder', reminder.actionIntent?.type, (v) => v === 'reminder', 'reminder');

  freshDB();
  const rodney = await classifyQuery('My friend Rodney and I went to lunch yesterday.');
  assert('CF-18 Rodney lunch is not todo_complete', rodney.actionIntent?.type, (v) => v !== 'todo_complete', 'not todo_complete');
  assert('CF-18b Rodney extractTodoComplete is null', extractTodoCompleteMutation('My friend Rodney and I went to lunch yesterday.'), (v) => v == null, 'null');

  freshDB();
  const groceryTrip = await classifyQuery('My wife and I went to the grocery store yesterday.');
  assert(
    'CF-19 grocery trip narrative is not list/todo mutation',
    groceryTrip.actionIntent?.type,
    (v) => v !== 'list_remove' && v !== 'todo_complete',
    'no mutation',
  );

  freshDB();
  assert(
    'CF-20 We bought eggs yesterday is not list_remove',
    (await classifyQuery('We bought eggs yesterday.')).actionIntent?.type,
    (v) => v !== 'list_remove',
    'not list_remove',
  );
  assert(
    'CF-20b acquisition extractor rejects temporal narrative',
    extractListRemoveAcquisitionItem('We bought eggs yesterday'),
    (v) => v == null,
    'null',
  );

  freshDB();
  assert(
    'CF-21 I\'ve got no complaints is not list_remove',
    (await classifyQuery("I've got no complaints.")).actionIntent?.type,
    (v) => v !== 'list_remove',
    'not list_remove',
  );
  assert(
    'CF-21b possession got is not acquisition',
    extractListRemoveAcquisitionItem("I've got no complaints"),
    (v) => v == null,
    'null',
  );

  for (const phrase of ['I got eggs.', 'We bought milk.', 'I picked up bread.']) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(
      `CF-21c bare acquisition "${phrase}" is not list_remove`,
      d.actionIntent?.type,
      (v) => v !== 'list_remove',
      'not list_remove',
    );
    assert(
      `CF-21d bare acquisition "${phrase}" is not todo_complete`,
      d.actionIntent?.type,
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
    assert(
      `CF-21e extractor rejects "${phrase}"`,
      extractListRemoveAcquisitionItem(phrase),
      (v) => v == null,
      'null',
    );
  }

  const joke = 'I joked that the bartender diagnosed me with thirst.';
  assert('CF-22 medical-joke story is not medical capture', detectMedicalEvent(joke), (v) => v == null, 'null');
  freshDB();
  assert(
    'CF-22b medical-joke is not medical_capture intent',
    (await classifyQuery(joke)).actionIntent?.type,
    (v) => v !== 'medical_capture',
    'not medical_capture',
  );

  freshDB();
  const med = await classifyQuery("I'm on Eliquis");
  assert('CF-23 explicit medical capture remains medical', med.actionIntent?.type, (v) => v === 'medical_capture', 'medical_capture');

  freshDB();
  const finished = await classifyQuery('I finished that thing from yesterday');
  assert(
    'CF-24 ambiguous finished-anaphor stays deterministic todo_complete (no fuzzy id here)',
    finished.actionIntent?.type,
    (v) => v === 'todo_complete',
    'todo_complete',
  );

  {
    const session = new ConversationSession();
    assert('CF-25 ordinary narrative does not create session pending', session.hasPending(), (v) => v === false, 'false');
    const yes = await session.resolvePending('Yes');
    assert('CF-26 Yes with no pending is noop write', yes.status, (v) => v === 'noop', 'noop');
    assert('CF-27 Yes with no pending does not ack a write', yes.ack, (v) => !/removed|done|saved|called|sent/i.test(String(v)), 'empty/non-success');
  }

  {
    let wrote = false;
    const session = new ConversationSession();
    session.setPending({
      pendingKey: 'list_remove',
      prompt: 'Remove eggs from grocery?',
      resume: async (text) => {
        if (/^(yes|yeah)/i.test(text.trim())) {
          wrote = true;
          return { status: 'committed', ack: 'Removed eggs from your grocery list.' };
        }
        return { status: 'noop', ack: '' };
      },
    });
    const yes = await session.resolvePending('Yes');
    assert('CF-28 authorized pending Yes writes', wrote && yes.status === 'committed', (v) => v === true, 'true');
  }

  assert(
    'CF-29 composeAck requires a commit result',
    composeAck([{ status: 'committed', ack: 'Removed eggs from your grocery list.' }]),
    (v) => v === 'Removed eggs from your grocery list.',
    'verified ack',
  );
  assert(
    'CF-30 empty commits cannot claim Done',
    composeAck([]),
    (v) => !/\bDone\b/i.test(String(v)),
    'no Done',
  );
  assert(
    'CF-31 pending composeAck is prompt not success copy',
    composeAck([{ status: 'pending', prompt: 'Remove eggs?', pendingKey: 'list_remove', resume: async () => ({ status: 'noop', ack: '' }) }]),
    (v) => v === 'Remove eggs?' && !/removed/i.test(String(v)),
    'prompt',
  );

  {
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = readFileSync(join(here, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
    assert('CF-32 Qwen adapter has no setPending', worker.includes('setPending'), (v) => v === false, 'false');
    assert('CF-33 Qwen adapter has no runSync', /\brunSync\b/.test(worker), (v) => v === false, 'false');
  }

  const packet = buildVerifiedConversationalPacket({
    verifiedPersonalFacts: 'name: Mike',
    sessionEvidenceLines: [PAUL],
    pendingLabel: null,
  });
  assert('CF-34 packet keeps Paul as session evidence', packetMentionsName(packet, 'Paul'), (v) => v === true, 'true');
  assert(
    'CF-35 packet does not treat session evidence as SQLite truth label mix-up',
    formatVerifiedConversationalPacket(packet),
    (v) => /SESSION CONVERSATIONAL EVIDENCE/.test(String(v)) && /not durable memory/.test(String(v)),
    'labeled',
  );
  const emptyBio = buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: [],
    pendingLabel: null,
  });
  assert('CF-36 empty packet has no Marcus', packetMentionsName(emptyBio, 'Marcus'), (v) => v === false, 'false');
  assert(
    'CF-37 pending is labeled unconfirmed',
    formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: [],
      pendingLabel: 'A confirmation is pending for a previously authorized action. It is not committed truth.',
    })),
    (v) => /PENDING \/ UNCONFIRMED/.test(String(v)) && /not committed truth/.test(String(v)),
    'pending labeled',
  );

  const APOLLO_STORY = 'Apollo has always been anxious about flying.';
  const mayApolloStory = mayRunGenerativeEphemeralPersonalProse({
    reason: 'default',
    text: APOLLO_STORY,
    hasAuthorizedContinuation: false,
    hasPendingSession: false,
    hasContactCollectPending: false,
    isEligible: isEligible(APOLLO_STORY, false),
    threadEvidence: '',
  });
  assert('CF-38 Apollo user story is conversation-eligible', mayApolloStory, (v) => v === true, 'true');
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: APOLLO_STORY,
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'That sounds like a hard thing to live with.' };
      },
    });
    assert('CF-39 Apollo user story reaches generate', generateCalled && outcome.kind === 'generative', (v) => v === true, 'true');
  }
  {
    const storyPacket = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: [APOLLO_STORY],
      pendingLabel: null,
    });
    assert(
      'CF-40 Apollo is unverified, not SQLite truth',
      !packetHasVerifiedFactsForName(storyPacket, 'Apollo')
        && storyPacket.unverifiedPersonNames.includes('Apollo'),
      (v) => v === true,
      'unverified Apollo',
    );
    assert(
      'CF-41 anxious is session evidence only',
      formatVerifiedConversationalPacket(storyPacket),
      (v) => {
        const s = String(v);
        const verified = s.split('SESSION CONVERSATIONAL EVIDENCE')[0] ?? '';
        return !/anxious/i.test(verified)
          && /USER-SUPPLIED MENTIONS/.test(s)
          && /anxious about flying/i.test(s);
      },
      'attribute labeled as user-supplied',
    );
  }
  {
    const inquiryPacket = buildVerifiedConversationalPacket({
      verifiedPersonalFacts: '',
      sessionEvidenceLines: ['Tell me about Marcus.'],
      pendingLabel: null,
    });
    assert(
      'CF-42 Marcus inquiry supplies no verified attribute',
      !packetHasVerifiedFactsForName(inquiryPacket, 'Marcus')
        && inquiryPacket.unverifiedPersonNames.includes('Marcus'),
      (v) => v === true,
      'no verified Marcus facts',
    );
  }

  const OPENING_ORDINARY_QUESTIONS = [
    'What should we do this afternoon?',
    'Any thoughts on dinner?',
    "What's a good way to start the morning?",
    'What do you think I should focus on today?',
    "What's our plan for today?",
    "What's our plan for the weekend?",
  ];
  for (const phrase of OPENING_ORDINARY_QUESTIONS) {
    freshDB();
    const cls = await classifyQuery(phrase);
    assert(
      `CF-43 no deterministic owner "${phrase}"`,
      cls,
      (v) => {
        const d = v as { reason?: string; actionIntent?: unknown };
        return d.reason === 'default' && d.actionIntent == null;
      },
      'reason default, no actionIntent',
    );
    assert(
      `CF-44 opening interrogative eligible without continuation "${phrase}"`,
      isEligible(phrase, false),
      (v) => v === true,
      'true',
    );
    {
      let generateCalled = false;
      const outcome = await resolveEphemeralSeam({
        ...SEAM_READY,
        text: phrase,
        hasAuthorizedContinuation: false,
        threadEvidence: '',
        generate: async () => {
          generateCalled = true;
          return { status: 'ok', text: 'We could keep it light and decide as we go.' };
        },
      });
      assert(
        `CF-45 opening question not canned clarify "${phrase}"`,
        outcome.kind === 'generative' && outcome.reply !== EPHEMERAL_CLARIFY_REPLY,
        (v) => v === true,
        'generative',
      );
      assert(
        `CF-46 opening question invokes generate "${phrase}"`,
        generateCalled,
        (v) => v === true,
        'true',
      );
    }
  }

  const BENIGN_NARRATIVES = [
    'I had lunch with some friends yesterday.',
    'I went to the park this morning.',
    'I met an old friend last night.',
    'I visited my sister over the weekend.',
  ];
  for (const phrase of BENIGN_NARRATIVES) {
    freshDB();
    const cls = await classifyQuery(phrase);
    assert(
      `CF-47 benign narrative is not a write owner "${phrase}"`,
      cls,
      (v) => {
        const d = v as { actionIntent?: { type?: string } | null };
        const t = d.actionIntent?.type;
        return t !== 'list_remove' && t !== 'todo_complete' && t !== 'medical_capture'
          && t !== 'reminder' && t !== 'call' && t !== 'sms';
      },
      'no write actionIntent',
    );
    {
      let generateCalled = false;
      const outcome = await resolveEphemeralSeam({
        ...SEAM_READY,
        text: phrase,
        hasAuthorizedContinuation: false,
        threadEvidence: '',
        generate: async () => {
          generateCalled = true;
          return { status: 'ok', text: 'Sounds like a good stretch of the day.' };
        },
      });
      assert(
        `CF-48 benign narrative invokes generate "${phrase}"`,
        generateCalled && outcome.kind === 'generative',
        (v) => v === true,
        'true',
      );
      assert(
        `CF-49 benign narrative is not a terminal PEC echo "${phrase}"`,
        outcome.reply,
        (v) => v === 'Sounds like a good stretch of the day.'
          && !/^You (saw|had|went|met|visited)\b/i.test(String(v)),
        'generate reply',
      );
    }
  }

  {
    let generateCalled = false;
    const first = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'What should we do this afternoon?',
      hasAuthorizedContinuation: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'A walk and an early dinner could work.' };
      },
    });
    assert('CF-50 first hop grants continuation', first.kind === 'generative' && first.grantContinuation === true, (v) => v === true, 'true');
    generateCalled = false;
    const second = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Why did you suggest that?',
      hasAuthorizedContinuation: true,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'It keeps the day simple without locking you in.' };
      },
    });
    assert(
      'CF-51 contextual follow-up still reaches generate',
      generateCalled && second.kind === 'generative',
      (v) => v === true,
      'true',
    );
  }

  freshDB();
  const calToday = await classifyQuery("What's on my calendar today?");
  assert(
    'CF-52 calendar today remains deterministic',
    calToday,
    (v) => {
      const d = v as { reason?: string; actionIntent?: unknown };
      return d.reason !== 'default' || d.actionIntent != null;
    },
    'not residual default',
  );
  freshDB();
  const plannedToday = await classifyQuery("What's planned for today?");
  assert(
    'CF-53 planned-for-today remains calendar-owned',
    plannedToday,
    (v) => {
      const d = v as { reason?: string };
      return d.reason !== 'default';
    },
    'not default',
  );

  {
    let generateCalled = false;
    const pendingSeam = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'What should we do this afternoon?',
      hasAuthorizedContinuation: false,
      hasPendingSession: true,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'stolen' };
      },
    });
    assert(
      'CF-54 pending confirmation blocks Qwen',
      pendingSeam.kind === 'clarify' && !generateCalled,
      (v) => v === true,
      'clarify',
    );
  }
  {
    let generateCalled = false;
    const amb = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Did you get that?',
      hasAuthorizedContinuation: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'stolen' };
      },
    });
    assert(
      'CF-55 ambiguous demonstrative stays fail-closed',
      amb.kind === 'clarify' && !generateCalled && amb.reply === EPHEMERAL_CLARIFY_REPLY,
      (v) => v === true,
      'clarify',
    );
  }
  {
    let generateCalled = false;
    const marcus = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Tell me about Marcus.',
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Marcus loves flying.' };
      },
    });
    assert(
      'CF-56 Marcus biography inquiry remains honest miss',
      !generateCalled && marcus.kind === 'generative' && /don't have anything stored about Marcus/i.test(String(marcus.reply)),
      (v) => v === true,
      'honest miss',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationFoundationV1: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationFoundationV1.test.ts')) {
  runConversationFoundationV1Tests().catch(console.error);
}
