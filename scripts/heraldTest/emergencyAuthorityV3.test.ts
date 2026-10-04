// Emergency Authority V3. Stage B proposes. Only a clean yes, after Stage C, becomes emergency.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processUtterance } from '../../src/routing/processUtterance';
import { ConversationSession } from '../../src/routing/conversationSession';
import { detectDirectEmergencyService, detectEmergency } from '../../src/routing/emergencySignals';
import { proposeEmergency } from '../../src/routing/emergencyProposal';
import { classifyEmergencyCallReply } from '../../src/utils/emergencyCallConfirm';
import {
  EMERGENCY_CLARIFY_KEY,
  EMERGENCY_CLARIFY_QUESTION,
  EMERGENCY_CLARIFY_REASK,
  EMERGENCY_CLARIFY_RELEASE,
  EMERGENCY_CLARIFY_TTL_MS,
  readEmergencyClarification,
} from '../../src/routing/hardPendingBoundary';
import { setDB } from '../../src/db/schema';

setDB({
  getAllSync: () => [],
  getFirstSync: () => null,
  runSync: () => ({ changes: 0, lastInsertRowId: 0 }),
  execSync: () => {},
} as unknown as Parameters<typeof setDB>[0]);

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function runEmergencyAuthorityV3Tests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) {
      passed++;
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
    } else {
      failures.push(label);
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
    }
  };

  const makeDeps = () => {
    const spy = { classify: 0, llm: 0 };
    const deps = {
      classifyQuery: async () => {
        spy.classify += 1;
        return { tier: 3 as const, reason: 'default' };
      },
      classifyLLM: async () => {
        spy.llm += 1;
        return { status: 'ok' as const, intents: [] };
      },
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    };
    return { deps, spy };
  };

  const outcomeSource = (outcome: Awaited<ReturnType<typeof processUtterance>>): string | undefined => (
    'source' in outcome ? outcome.source : undefined
  );

  const project = (outcome: Awaited<ReturnType<typeof processUtterance>>, session: ConversationSession) => {
    if (outcome.handled) {
      return JSON.stringify({
        handled: true,
        source: outcome.source,
        response: 'responseText' in outcome ? outcome.responseText : null,
        pending: session.peekPendingKey(),
      });
    }
    return JSON.stringify({
      handled: false,
      kind: outcome.routeDecision.kind,
      reason: 'reason' in outcome.routeDecision ? outcome.routeDecision.reason : null,
      pending: session.peekPendingKey(),
    });
  };

  console.log(`\n${BOLD}-- Emergency Authority V3 ---${RESET}\n`);

  const directTrue = [
    'call 911',
    'please call 911',
    'can you call 911',
    'Herald, call 911',
    'help me call 911',
    'Help me, call 911',
    'call an ambulance',
    'please call the ambulance',
    'can you call emergency services',
    'I need you to call 911',
    'will you call 911',
    'call nine one one',
    'could you please call 911',
  ];
  const directFalse = [
    'Help me',
    'Can you help me?',
    'call my daughter',
    'what is 911',
    'I called 911 yesterday',
    "don't call 911",
    'I need help',
    'should I call 911?',
    'when should someone call an ambulance?',
    'she said call 911',
    'he told me to call 911',
    'add 911 to my contacts',
    'put 911 in my note',
    'schedule an ambulance drill',
    'she said, call 911',
    'should I call an ambulance?',
    'he asked me to call emergency services',
  ];
  for (const text of directTrue) check(`direct service true: ${text}`, detectDirectEmergencyService(text) === true);
  for (const text of directFalse) check(`direct service false: ${text}`, detectDirectEmergencyService(text) === false);

  const heraldEmergencyTrue = ['Herald, emergency', 'Herald emergency', 'Hey Herald, emergency'];
  const heraldEmergencyFalse = [
    "Herald, this isn't an emergency",
    'Herald, my emergency contact is Shannon',
    'Herald, tell me about my emergency contacts',
    'I told Herald about the emergency yesterday',
    'Does Herald know my emergency contact?',
    'Herald, this is not an emergency',
    'I told Herald, emergency',
  ];
  for (const text of heraldEmergencyTrue) check(`Herald emergency hard true: ${text}`, detectEmergency(text) === true);
  for (const text of heraldEmergencyFalse) check(`Herald emergency hard false: ${text}`, detectEmergency(text) === false);
  const explicitEmergencyTrue = [
    'this is an emergency',
    'This is an emergency.',
    'Herald, this is an emergency',
    "I'm having an emergency",
  ];
  const explicitEmergencyFalse = [
    'this is not an emergency',
    "this isn't an emergency",
    "I don't think this is an emergency",
    'is this an emergency?',
    'what is an emergency?',
    'my emergency contact is Shannon',
    'I told Herald about the emergency yesterday',
  ];
  for (const text of explicitEmergencyTrue) check(`E1 explicit declaration true: ${text}`, detectEmergency(text) === true);
  for (const text of explicitEmergencyFalse) check(`E1 explicit declaration false: ${text}`, detectEmergency(text) === false);
  const reportedDeclaration = [
    'she said, this is an emergency',
    'this is an emergency, she said',
    'he told me this is an emergency',
    'I heard someone say this is an emergency',
    'she yelled, "this is an emergency"',
  ];
  for (const text of reportedDeclaration) {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance(text, session, deps);
    check(
      `reported declaration is not hard Stage A: ${text}`,
      detectEmergency(text) === false
        && outcome.handled === true
        && outcome.source === 'emergency_clarify'
        && spy.classify === 0
        && spy.llm === 0
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY,
    );
  }

  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const dispatchStart = chat.indexOf('const dispatchEmergency = useCallback');
  const sendStart = chat.indexOf('const sendMessage = useCallback');
  const dispatchBody = chat.slice(dispatchStart, sendStart);
  const directAt = chat.indexOf('if (detectDirectEmergencyService(text))');
  const stageAAt = chat.indexOf('if (detectEmergency(text))');
  const directBlock = chat.slice(directAt, stageAAt);
  const utteranceAt = chat.indexOf('processUtterance(');
  const silenceAt = chat.indexOf("processUtterance('', sessionRef.current");
  const sendEnd = chat.indexOf('const handleSend = useCallback');
  check('direct-service block precedes Stage A', directAt > sendStart && directAt < stageAAt);
  check(
    'contentful user path reaches processUtterance only after direct-service and Stage A',
    sendStart < directAt && directAt < stageAAt && stageAAt < utteranceAt && utteranceAt < sendEnd && silenceAt > sendEnd,
  );
  check('no-recognizable-speech calls processUtterance with an empty string', chat.includes("processUtterance('', sessionRef.current"));
  check('direct-service arms the existing 911 confirm_call payload', directBlock.includes("{ action: 'confirm_call', name: '911', phone: '911' }"));
  check('direct-service block does not dispatch, link, or clear Law 0 holders', !directBlock.includes('dispatchEmergency') && !directBlock.includes('Linking') && !directBlock.includes('subjectRef') && !directBlock.includes('hotRingRef'));
  check('dispatchEmergency body is unchanged by the direct-service block', !dispatchBody.includes('detectDirectEmergencyService') && dispatchBody.includes("action: 'confirm_call', name: '911', phone: '911'") && dispatchBody.includes('Herald alert: I may need help.'));
  check('content-bearing yes is not a clean dial yes', classifyEmergencyCallReply('yes please') !== 'yes' && classifyEmergencyCallReply('yes, I need help scheduling my appointment') !== 'yes' && classifyEmergencyCallReply('yeah call them') !== 'yes');

  const recall = [
    "I can't breathe",
    "I'm choking",
    'my chest hurts',
    'my heart hurts',
    "I'm bleeding",
    'I fell',
    "I've fallen",
    "I'm on the floor",
    'I might pass out',
    'I feel dizzy',
    'I think this is a stroke',
    "I'm having a seizure",
    'it hurts',
    "I'm in pain",
    'I have an injury',
    "I'm scared",
    "I'm afraid",
    'it might be an emergency',
    'the number 911',
    'we saw an ambulance',
    "I can't stand up",
    'I cannot get up',
    'can not walk',
    "I couldn't rise",
    'unable to get off the floor',
    'not able to get out of the chair',
    "my legs won't let me stand",
    "I'm stuck",
    'my legs are giving out',
    'my knees are not working',
    'i cant breathe',
    'i cant get up',
    'passout',
    'I passed out',
    'I cant get myself up',
    "I can't get out",
    'Can you help me get up?',
    "I'm passing out",
    'I passedout',
    'help me get up',
    'could you help me get out',
    'i cant get myself up',
  ];
  const standRecall = [
    'Can you help me stand up?',
    'can you help me stand up',
    'help me stand up',
    'Can you help me stand?',
    'CAN YOU HELP ME STAND UP',
    'help me stand',
  ];
  const infinitiveRecall = [
    'Help me to stand up',
    'Can you help me to stand?',
    'help me to get up',
    'can you help me to get out',
    'help me to get off the floor',
  ];
  for (const text of recall) {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance(text, session, deps);
    check(
      `recall reaches clarification: ${text}`,
      outcome.handled === true
        && outcome.source === 'emergency_clarify'
        && outcome.responseText === EMERGENCY_CLARIFY_QUESTION
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && spy.classify === 0
        && spy.llm === 0
        && proposeEmergency(text)?.source === 'recall_trigger',
    );
  }
  for (const text of standRecall) {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance(text, session, deps);
    check(
      `stand recall asks only: ${text}`,
      detectEmergency(text) === false
        && detectDirectEmergencyService(text) === false
        && outcome.handled === true
        && outcome.source === 'emergency_clarify'
        && outcome.responseText === EMERGENCY_CLARIFY_QUESTION
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && spy.classify === 0
        && spy.llm === 0,
    );
  }
  for (const text of infinitiveRecall) {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance(text, session, deps);
    check(
      `infinitive recall asks only: ${text}`,
      detectEmergency(text) === false
        && detectDirectEmergencyService(text) === false
        && outcome.handled === true
        && outcome.source === 'emergency_clarify'
        && outcome.responseText === EMERGENCY_CLARIFY_QUESTION
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && spy.classify === 0
        && spy.llm === 0,
    );
  }

  {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance("We're going to Italy this fall.", session, deps);
    check('false proposal asks and does not act', outcome.handled === true && outcome.source === 'emergency_clarify' && spy.classify === 0 && spy.llm === 0 && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
  }

  {
    const original = "I can't breathe";
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const asked = await processUtterance(original, session, deps);
    check('proposal has zero emergency side effects', asked.handled === true && asked.source === 'emergency_clarify' && spy.classify === 0 && spy.llm === 0);
    const promoted = await processUtterance('yes', session, deps);
    check('clean yes promotes to emergency', promoted.handled === true && promoted.source === 'emergency' && session.hasPending() === false);
  }

  {
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance("I can't breathe", session, deps);
    const contentYes = await processUtterance('yes please', session, deps);
    check('content-bearing yes does not promote', contentYes.handled === true && contentYes.source === 'emergency_clarify' && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
  }

  {
    const original = "I can't breathe";
    const controlSession = new ConversationSession();
    const liveSession = new ConversationSession();
    const controlDeps = makeDeps();
    const liveDeps = makeDeps();
    const control = await processUtterance(original, controlSession, controlDeps.deps, null, null, null, null, null, null, null, null, null, null, { suppressEmergencyProposal: true });
    await processUtterance(original, liveSession, liveDeps.deps);
    const replay = await processUtterance('no', liveSession, liveDeps.deps);
    check('no replays the original exactly once', replay.replayOf === original && outcomeSource(replay) !== 'emergency_clarify' && liveSession.peekPendingKey() !== EMERGENCY_CLARIFY_KEY);
    check('replay durable delta equals the control ordinary turn', project(replay, liveSession) === project(control, controlSession));
    const second = await processUtterance('no', liveSession, liveDeps.deps);
    check('replay does not loop back into a proposal', second.replayOf === undefined && outcomeSource(second) !== 'emergency');
  }

  {
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance('I fell', session, deps);
    const first = await processUtterance('maybe tomorrow', session, deps);
    check('first unresolved re-asks yes or no', first.handled === true && first.source === 'emergency_clarify' && first.responseText === EMERGENCY_CLARIFY_REASK && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
    const second = await processUtterance('still maybe', session, deps);
    check('second unresolved releases with no action', second.handled === true && second.source === 'emergency_clarify' && second.responseText === EMERGENCY_CLARIFY_RELEASE && session.hasPending() === false);
  }

  {
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance('I passed out', session, deps);
    const before = readEmergencyClarification(session);
    const silent = await processUtterance('', session, deps);
    const after = readEmergencyClarification(session);
    check(
      'silence does not consume the clarification',
      silent.handled === true
        && silent.source === 'emergency_clarify'
        && silent.responseText !== EMERGENCY_CLARIFY_REASK
        && silent.responseText !== EMERGENCY_CLARIFY_RELEASE
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && after?.askCount === 0
        && after?.original === before?.original
        && after?.establishedAt === before?.establishedAt,
    );
    await processUtterance('   ', session, deps);
    check('blank transcript does not consume the clarification', readEmergencyClarification(session)?.askCount === 0 && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
    for (const noise of ['.', '...', '?', '!', ' ?! ', '---']) {
      const ignored = await processUtterance(noise, session, deps);
      const record = readEmergencyClarification(session);
      check(
        `no lexical content does not consume: ${JSON.stringify(noise)}`,
        outcomeSource(ignored) === 'emergency_clarify'
          && record?.askCount === 0
          && record?.original === before?.original
          && record?.establishedAt === before?.establishedAt
          && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY,
      );
    }
    const unresolved = await processUtterance('maybe tomorrow', session, deps);
    check('silence does not advance the ask into a release', unresolved.handled === true && unresolved.source === 'emergency_clarify' && unresolved.responseText === EMERGENCY_CLARIFY_REASK && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
    const promoted = await processUtterance('yes', session, deps);
    check('a real yes after silence still promotes', promoted.handled === true && promoted.source === 'emergency' && session.hasPending() === false);
  }

  {
    const original = "I can't breathe";
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance(original, session, deps);
    await processUtterance('...', session, deps);
    await processUtterance('?', session, deps);
    const declined = await processUtterance('no', session, deps);
    check(
      'a real no after punctuation-only input still replays',
      declined.replayOf === original && outcomeSource(declined) !== 'emergency_clarify' && session.peekPendingKey() !== EMERGENCY_CLARIFY_KEY,
    );
  }

  const realNow = Date.now;
  try {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const held = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance('I feel dizzy', held, deps);
    now += EMERGENCY_CLARIFY_TTL_MS;
    const atBoundary = await processUtterance('pumpkin', held, deps);
    check('TTL at 120 seconds still owns the clarification', atBoundary.handled === true && atBoundary.source === 'emergency_clarify' && held.peekPendingKey() === EMERGENCY_CLARIFY_KEY);
    const expiredSession = new ConversationSession();
    now = 1_700_000_000_000;
    await processUtterance('I feel dizzy', expiredSession, deps);
    now += EMERGENCY_CLARIFY_TTL_MS + 1;
    const expired = await processUtterance('pumpkin', expiredSession, deps);
    check('TTL past 120 seconds releases and processes the new turn', outcomeSource(expired) !== 'emergency_clarify' && expiredSession.peekPendingKey() !== EMERGENCY_CLARIFY_KEY);
  } finally {
    Date.now = realNow;
  }

  try {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance('I feel dizzy', session, deps);
    now += EMERGENCY_CLARIFY_TTL_MS + 1;
    const silent = await processUtterance('', session, deps);
    check(
      'silence past the deadline does not expire the clarification',
      outcomeSource(silent) === 'emergency_clarify'
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && readEmergencyClarification(session)?.askCount === 0,
    );
    const punctuation = await processUtterance('...', session, deps);
    check(
      'punctuation past the deadline does not expire the clarification',
      outcomeSource(punctuation) === 'emergency_clarify'
        && session.peekPendingKey() === EMERGENCY_CLARIFY_KEY
        && readEmergencyClarification(session)?.askCount === 0
        && readEmergencyClarification(session)?.establishedAt === 1_700_000_000_000,
    );
    const expired = await processUtterance('pumpkin', session, deps);
    check('a later real turn still expires after the deadline', outcomeSource(expired) !== 'emergency_clarify' && session.peekPendingKey() !== EMERGENCY_CLARIFY_KEY);
  } finally {
    Date.now = realNow;
  }

  {
    const established = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance('I fell', established, deps);
    const restarted = new ConversationSession();
    check('restart has no emergency clarification', restarted.hasPending() === false && restarted.peekPendingKey() !== EMERGENCY_CLARIFY_KEY);
  }

  {
    const session = new ConversationSession();
    const { deps } = makeDeps();
    await processUtterance("I'm scared", session, deps);
    const preempt = await processUtterance('Help me', session, deps);
    check('Stage A during clarification preempts', preempt.handled === true && preempt.source === 'emergency' && session.hasPending() === false);
  }

  {
    const session = new ConversationSession();
    const { deps } = makeDeps();
    let resumeCalls = 0;
    session.setPending({
      pendingKey: 'medical_capture',
      kind: 'standard',
      budget: 2,
      resume: async () => {
        resumeCalls += 1;
        return { status: 'noop', ack: '' };
      },
    });
    const distress = await processUtterance("I can't breathe", session, deps);
    check('KNOWN-V3-LIMITATION unrelated pending is not replaced by distress', outcomeSource(distress) !== 'emergency_clarify' && session.peekPendingKey() === 'medical_capture' && resumeCalls === 1);
    const stageA = await processUtterance('Help me', session, deps);
    check('Stage A still preempts an unrelated pending', stageA.handled === true && stageA.source === 'emergency' && session.hasPending() === false);
    check('call 911 remains a direct-service preemption, not Stage B', detectDirectEmergencyService('call 911') === true && proposeEmergency('call 911')?.possibleEmergency === true && detectEmergency('call 911') === false);
  }

  const proposalSrc = fs.readFileSync(path.join(root, 'src/routing/emergencyProposal.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
  const confirmSrc = fs.readFileSync(path.join(root, 'src/utils/emergencyCallConfirm.ts'), 'utf8');
  check('proposal module has no action path', !/dispatchEmergency|Linking|tel:|confirm_call|setPending|classifyQuery|semanticProvider|establishHardPending/.test(proposalSrc));
  check('processUtterance does not dial from a proposal', !processSrc.includes('Linking') && !processSrc.includes('tel:') && !processSrc.includes('dispatchEmergency'));
  check('classifier file is untouched by V3 markers', !confirmSrc.includes('emergency_clarify') && !confirmSrc.includes('proposeEmergency'));
  check('Stage C yes is the only promotion beside Stage A', (processSrc.match(/source: 'emergency'/g) ?? []).length === 3);

  const total = passed + failures.length;
  console.log(`\n${BOLD}EmergencyAuthorityV3: ${passed}/${total}${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('emergencyAuthorityV3.test.ts')) {
  runEmergencyAuthorityV3Tests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
