// Final speech through the same realization decision ChatScreen uses.
// Legal semantic stubs. The generator stub is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { answerActiveSubjectReference } from '../../src/routing/activeSubjectReference.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import { deterministicAcknowledgementSpeech, projectRealization } from '../../src/routing/responseAct.ts';
import {
  DISCOURSE_APPLICABILITY_PROMPT,
  DISCOURSE_CORRECTION_PROMPT,
  DISCOURSE_MENTION_PROPOSAL_PROMPT,
} from '../../src/routing/semanticProvider.ts';
import { buildEphemeralPromptMessages } from '../../src/utils/ephemeralConversation.ts';
import {
  EPHEMERAL_CLARIFY_REPLY,
  resolveEphemeralSeam,
  withholdAssistantBiography,
} from '../../src/utils/ephemeralSeam.ts';
import { EXPERIMENTAL_QWEN_SYSTEM_PROMPT } from '../../src/conversation/experimentalQwenLlamaWorker.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

type Span = { span: string; kind: 'person' | 'place' | 'event_or_topic' };
type SurfaceMark = { surface: string; kind: string };
type TurnScript = {
  text: string;
  mentions?: Span[];
  marks?: 'suppress' | { compatible: SurfaceMark[] };
  correction?: {
    target: SurfaceMark;
    replacementSurfaces?: SurfaceMark[];
    newSpans?: Span[];
  };
};
type Card = { handle: string; kind: string; surfaceSpan: string };
type Outcome = Awaited<ReturnType<typeof processUtterance>>;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`${RED}❌ FAIL${RESET}  ${name}\n      ${detail}`);
  }
}

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function packet(prompt: string): { candidates: Card[] } {
  const nl = prompt.indexOf('\n');
  const raw = nl >= 0 ? prompt.slice(nl + 1) : '';
  return JSON.parse(raw) as { candidates: Card[] };
}

function completionFor(turn: TurnScript) {
  return async (params: { prompt?: string }) => {
    const prompt = params.prompt ?? '';
    if (prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)) {
      if (!turn.correction) {
        return { text: JSON.stringify({ correction_turn: false, target_marks: [], replacement_marks: [] }) };
      }
      const cards = packet(prompt).candidates ?? [];
      const target_marks = cards.map((card) => ({
        handle: card.handle,
        mark: card.surfaceSpan === turn.correction!.target.surface && card.kind === turn.correction!.target.kind
          ? 'compatible'
          : 'incompatible',
      }));
      const replacement_marks = cards.map((card) => ({
        handle: card.handle,
        mark: (turn.correction!.replacementSurfaces ?? []).some((mark) => mark.surface === card.surfaceSpan && mark.kind === card.kind)
          ? 'compatible'
          : 'incompatible',
      }));
      const body: Record<string, unknown> = { correction_turn: true, target_marks, replacement_marks };
      if (turn.correction.newSpans) body.new_spans = turn.correction.newSpans;
      return { text: JSON.stringify(body) };
    }
    if (prompt.startsWith(DISCOURSE_APPLICABILITY_PROMPT)) {
      if (!turn.marks || turn.marks === 'suppress') {
        return { text: JSON.stringify({ utterance_applicable: false, reference_attempt: false, marks: [] }) };
      }
      const cards = packet(prompt).candidates ?? [];
      const marks = cards.map((card) => ({
        handle: card.handle,
        mark: turn.marks !== 'suppress' && turn.marks.compatible.some((mark) => mark.surface === card.surfaceSpan && mark.kind === card.kind)
          ? 'compatible'
          : 'incompatible',
      }));
      return { text: JSON.stringify({ utterance_applicable: true, reference_attempt: true, marks }) };
    }
    if (prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) {
      return { text: JSON.stringify(turn.mentions ?? []) };
    }
    return { text: '[]' };
  };
}

async function openDb() {
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  return db;
}

async function produce(discourse: DiscourseContinuityHolder, session: ConversationSession, script: TurnScript) {
  return processUtterance(script.text, session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    getMedicationSemanticInterpreterCtx: () => ({ completion: completionFor(script) }),
  }, null, null, null, null, null, discourse);
}

/** ChatScreen order: handled speech, then recap, identity, acknowledgement, then the seam. */
async function finalSpeech(
  discourse: DiscourseContinuityHolder,
  session: ConversationSession,
  outcome: Outcome,
  text: string,
  generated: string,
): Promise<{ speech: string; generationRan: boolean }> {
  if (outcome.handled) {
    return {
      speech: projectRealization(outcome.responseAct, outcome.responseText).speech,
      generationRan: false,
    };
  }
  if (outcome.routeDecision.kind !== 'needs_clarification') {
    return { speech: outcome.responseText, generationRan: false };
  }
  const recap = await answerImmediateSemanticRecap(text, { ledgerEntries: [] });
  if (recap.handled) return { speech: recap.reply, generationRan: false };
  const subject = await answerActiveSubjectReference(text, {
    ledgerEntries: [],
    discourseMentions: discourse.peekDiscourseMentions(),
  });
  if (subject.handled) return { speech: subject.reply, generationRan: false };
  if (outcome.routeDecision.reason !== 'default') {
    return { speech: outcome.responseText, generationRan: false };
  }
  const admitted = deterministicAcknowledgementSpeech(outcome.responseAct);
  if (admitted) return { speech: admitted, generationRan: false };
  let generationRan = false;
  const seam = await resolveEphemeralSeam({
    text,
    reason: 'default',
    hasAuthorizedContinuation: false,
    hasPendingSession: session.hasPending(),
    hasContactCollectPending: false,
    rdTier: 3,
    hasStructuredCaptures: false,
    isPersonalCaptureRisk: false,
    llmStatus: 'ready',
    classifierBusy: false,
    ephemeralBusy: false,
    threadEvidence: '',
    generate: async () => {
      generationRan = true;
      return { status: 'ok', text: generated };
    },
  });
  return { speech: seam.reply, generationRan };
}

function active(discourse: DiscourseContinuityHolder, surface: string): boolean {
  return discourse.peekDiscourseMentions().some((mention) => mention.status === 'active' && mention.surfaceSpan === surface);
}

export async function runFinalSpokenCompositionV1Tests() {
  console.log(`\n${BOLD}Final Spoken Composition V1${RESET}`);

  const lived = "That's interesting. I caught up with Alina yesterday as well. What did you talk about?";
  check(
    'mixed generator reply drops the lived clause',
    withholdAssistantBiography(lived) === "That's interesting. What did you talk about?",
    withholdAssistantBiography(lived),
  );
  check('first-person trip is withheld', withholdAssistantBiography('I went there too.') === '');
  check('family possession is withheld', withholdAssistantBiography('My wife is visiting.') === '');
  check('past life is withheld', withholdAssistantBiography('When I was younger I lived abroad.') === '');
  check('shared experience is withheld', withholdAssistantBiography('I had the same experience.') === '');
  check(
    'system-state limit is kept',
    withholdAssistantBiography("I don't have anything stored about Alina.") === "I don't have anything stored about Alina.",
  );
  check('third-person reply is kept', withholdAssistantBiography('The light is flat today.') === 'The light is flat today.');
  check(
    'a suggestion is not a lived history',
    withholdAssistantBiography('We could keep it light and decide as we go.') === 'We could keep it light and decide as we go.',
  );

  const prompt = buildEphemeralPromptMessages('hello', [])[0]?.content ?? '';
  check('ephemeral contract forbids personal history', prompt.includes('You have no personal history.'));
  check('qwen contract forbids personal history', EXPERIMENTAL_QWEN_SYSTEM_PROMPT.includes('You have no personal history.'));

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const handledAt = chat.indexOf('if (outcome.handled) {');
  const ackAt = chat.indexOf('deterministicAcknowledgementSpeech(outcome.responseAct)');
  const seamAt = chat.indexOf("resolveEphemeralSeamGateADiag('needs_clarification'");
  check('acknowledgement owns the turn before the seam', handledAt >= 0 && ackAt > handledAt && seamAt > ackAt, `${handledAt} ${ackAt} ${seamAt}`);
  const seamSrc = fs.readFileSync(path.join(root, 'src/utils/ephemeralSeam.ts'), 'utf8');
  const okAt = seamSrc.indexOf("if (ephemeral.status === 'ok')");
  check(
    'model text is published through the biography withhold',
    seamSrc.slice(okAt, okAt + 160).includes('publishGenerativeReply')
      && seamSrc.includes('withholdAssistantBiography'),
  );

  const db = await openDb();
  const discourse = new DiscourseContinuityHolder();
  const session = new ConversationSession();

  const turn1 = { text: 'I caught up with Alina yesterday.', mentions: [{ span: 'Alina', kind: 'person' as const }], marks: 'suppress' as const };
  const out1 = await produce(discourse, session, turn1);
  const fin1 = await finalSpeech(discourse, session, out1, turn1.text, lived);
  check('A speech is the grounded acknowledgement', fin1.speech === 'Got it — Alina.', fin1.speech);
  check('A does not run the generator', fin1.generationRan === false);
  check('A Alina is active', active(discourse, 'Alina'));
  check('A act is acknowledgement', out1.responseAct?.kind === 'ACKNOWLEDGE', out1.responseAct?.kind);
  check('A route is the default miss', out1.routeDecision.kind === 'needs_clarification' && out1.routeDecision.reason === 'default');
  check('A speech does not narrate a life', !/\b(I|my|we|our)\b/.test(fin1.speech), fin1.speech);

  const turn2 = {
    text: 'she brought up Ireland',
    mentions: [{ span: 'Ireland', kind: 'place' as const }],
    marks: { compatible: [{ surface: 'Alina', kind: 'person' }] },
  };
  const out2 = await produce(discourse, session, turn2);
  const fin2 = await finalSpeech(discourse, session, out2, turn2.text, lived);
  check('B speech is the frozen Alina reflection', fin2.speech.startsWith('We were talking about Alina.'), fin2.speech);
  check('B is not the canned miss', fin2.speech !== EPHEMERAL_CLARIFY_REPLY, fin2.speech);
  check('B does not run the generator', fin2.generationRan === false);
  check('B Ireland is admitted after the freeze', active(discourse, 'Ireland'));
  check('B Alina stays active', active(discourse, 'Alina'));
  check('B does not add a second acknowledgement', !fin2.speech.includes('Got it'), fin2.speech);
  check('B owner is the reflection', out2.handled === true && out2.source === 'discourse_reflection', out2.handled ? out2.source : 'unhandled');

  const skyDiscourse = new DiscourseContinuityHolder();
  const skySession = new ConversationSession();
  const sky = { text: 'The sky looks grey today.', marks: 'suppress' as const };
  const skyOut = await produce(skyDiscourse, skySession, sky);
  const skyFin = await finalSpeech(skyDiscourse, skySession, skyOut, sky.text, 'The light is flat today.');
  check('C safe generator speech is spoken', skyFin.speech === 'The light is flat today.', skyFin.speech);
  check('C safe turn does run the generator', skyFin.generationRan === true);

  const autoFin = await finalSpeech(skyDiscourse, skySession, skyOut, sky.text, lived);
  check(
    'C autobiography is stripped before speech',
    autoFin.speech === "That's interesting. What did you talk about?",
    autoFin.speech,
  );
  check('C autobiography still reached the generator', autoFin.generationRan === true);
  const pureFin = await finalSpeech(skyDiscourse, skySession, skyOut, sky.text, 'I went there too.');
  check('C pure autobiography becomes the canned clarification', pureFin.speech === EPHEMERAL_CLARIFY_REPLY, pureFin.speech);
  const limitFin = await finalSpeech(skyDiscourse, skySession, skyOut, sky.text, "I don't have anything stored about that.");
  check('C system-state generator speech is kept', limitFin.speech === "I don't have anything stored about that.", limitFin.speech);

  const bareDiscourse = new DiscourseContinuityHolder();
  const bareSession = new ConversationSession();
  const bare = { text: 'maybe later', marks: 'suppress' as const };
  const bareOut = await produce(bareDiscourse, bareSession, bare);
  let bareGenerate = false;
  const bareFin = await finalSpeech(bareDiscourse, bareSession, bareOut, bare.text, 'I went there too.');
  bareGenerate = bareFin.generationRan;
  check('D unresolved fragment uses the canned clarification', bareFin.speech === EPHEMERAL_CLARIFY_REPLY, bareFin.speech);
  check('D unresolved fragment does not generate', bareGenerate === false);

  const prior: Array<{ script: TurnScript; includes: string }> = [
    { script: { text: 'I caught up with Elena yesterday.', mentions: [{ span: 'Elena', kind: 'person' }], marks: 'suppress' }, includes: 'Got it — Elena.' },
    { script: { text: 'A reunion came up with her.', mentions: [{ span: 'reunion', kind: 'event_or_topic' }], marks: 'suppress' }, includes: 'Got it — reunion.' },
    { script: { text: 'She brought up Ireland.', mentions: [{ span: 'Ireland', kind: 'place' }], marks: 'suppress' }, includes: 'Got it — Ireland.' },
    { script: { text: 'What about Ireland?', marks: 'suppress' }, includes: 'Ireland' },
    { script: { text: 'Add rye to my grocery list.', marks: 'suppress' }, includes: 'rye' },
    { script: { text: 'What about Elena?', marks: 'suppress' }, includes: 'Elena' },
    {
      script: {
        text: 'No, I meant Portugal.',
        correction: { target: { surface: 'Ireland', kind: 'place' }, newSpans: [{ span: 'Portugal', kind: 'place' }] },
      },
      includes: 'Portugal',
    },
    { script: { text: 'What about Portugal?', marks: 'suppress' }, includes: 'Portugal' },
    {
      script: {
        text: 'Can we pick that back up?',
        marks: { compatible: [{ surface: 'reunion', kind: 'event_or_topic' }, { surface: 'Portugal', kind: 'place' }] },
      },
      includes: 'reunion',
    },
    { script: { text: 'The reunion.', marks: 'suppress' }, includes: 'reunion' },
    { script: { text: 'What else about the reunion?', marks: 'suppress' }, includes: 'reunion' },
    { script: { text: 'And Elena is still who I meant.', marks: 'suppress' }, includes: 'Elena' },
  ];
  const priorDiscourse = new DiscourseContinuityHolder();
  const priorSession = new ConversationSession();
  for (const [index, turn] of prior.entries()) {
    const outcome = await produce(priorDiscourse, priorSession, turn.script);
    const spoken = await finalSpeech(priorDiscourse, priorSession, outcome, turn.script.text, lived);
    const ok = spoken.speech.includes(turn.includes)
      && spoken.speech !== EPHEMERAL_CLARIFY_REPLY
      && spoken.generationRan === false;
    check(`E${index + 1} final speech`, ok, spoken.speech);
  }
  const contacts = Number((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n);
  check('prior conversation writes no contact', contacts === 0, String(contacts));

  console.log(`\n${BOLD}Final Spoken Composition V1: ${passed} passed / ${failed} failed / ${passed + failed} total${RESET}`);
  if (failed > 0) {
    for (const failure of failures) console.log(`${RED}  • ${failure}${RESET}`);
  }
  return { passed, failed, total: passed + failed, failures: failures.slice() };
}

const isDirect = process.argv[1]?.includes('finalSpokenCompositionV1');
if (isDirect) {
  runFinalSpokenCompositionV1Tests().then((result) => {
    if (result.failed > 0) process.exit(1);
  });
}
