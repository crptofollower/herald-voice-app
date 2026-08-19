// scripts/heraldTest/listeningSpeakingMirror.test.ts
// Source-lock: ChatScreen Listening + Speaking presence cues are pure mirrors
// of useMic.isRecording and useSpeech.isSpeaking — not new authorities.
//
// Runner: npx tsx scripts/heraldTest/listeningSpeakingMirror.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0;
const failures: string[] = [];

function assert(label: string, got: unknown, pred: (v: unknown) => boolean, expected: string) {
  if (pred(got)) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
  } else {
    failures.push(label);
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}expected ${expected} got ${JSON.stringify(got)}${RESET}`);
  }
}

function effectBodyWithMarker(src: string, depIncludes: string, bodyMarker: string): string | null {
  const effects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]+)\]\)/g)];
  for (const m of effects) {
    if (m[2].includes(depIncludes) && m[1].includes(bodyMarker)) return m[1];
  }
  return null;
}

export async function runListeningSpeakingMirrorTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}Listening + Speaking Mirror (source-lock)${RESET}`);

  const chatPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/screens/ChatScreen.tsx',
  );
  const chatSrc = fs.readFileSync(chatPath, 'utf8');

  assert(
    'LSM-1 scanner track gated on isRecording or isSpeaking',
    /\{\(isRecording\s*\|\|\s*isSpeaking\)\s*&&[\s\S]*?scannerTrack/.test(chatSrc),
    (v) => v === true,
    '(isRecording || isSpeaking) conditional wraps scannerTrack',
  );

  assert(
    'LSM-2 scanner animation effect depends on isRecording; halo refs absent',
    {
      body: effectBodyWithMarker(chatSrc, 'isRecording', 'scannerX'),
      noHaloRefs: !/\blistenGlowAnim\b/.test(chatSrc) && !/\bpulseAnim\b/.test(chatSrc),
    },
    (v) => {
      const { body, noHaloRefs } = v as { body: string | null; noHaloRefs: boolean };
      return typeof body === 'string' && body.includes('Animated.loop') && noHaloRefs;
    },
    'isRecording effect drives scannerX loop; listenGlowAnim/pulseAnim removed',
  );

  assert(
    'LSM-3 scanner track reflects isSpeaking authority',
    /\{\(isRecording\s*\|\|\s*isSpeaking\)\s*&&[\s\S]*?scannerBar/.test(chatSrc),
    (v) => v === true,
    'isSpeaking participates in scanner visibility gate',
  );

  assert(
    'LSM-4 speaking scanner animation effect depends on isSpeaking',
    effectBodyWithMarker(chatSrc, 'isSpeaking', 'scannerX'),
    (body) => typeof body === 'string'
      && !/\b(startRecording|stopRecording|speak|enqueueSentence)\s*\(/.test(body)
      && !/\bspeakPulseAnim\b/.test(chatSrc),
    'isSpeaking presence effect drives scannerX only; speakPulseAnim removed',
  );

  assert(
    'LSM-5 no new listening/speaking useState ownership',
    [
      /\[\s*isListening\s*,\s*setIsListening\s*\]/.test(chatSrc),
      /\[\s*showListening\s*,/.test(chatSrc),
      /\[\s*showSpeaking\s*,/.test(chatSrc),
      /\[\s*heraldSpeaking\s*,/.test(chatSrc),
    ].some(Boolean),
    (v) => v === false,
    'no isListening/showListening/showSpeaking/heraldSpeaking useState',
  );

  assert(
    'LSM-6 isRecording/isSpeaking still sourced from hooks (not reassigned)',
    /useMic\(/.test(chatSrc) && /isSpeaking,\s*isSpeakingRef\s*\}\s*=\s*useSpeech/.test(chatSrc),
    (v) => v === true,
    'useMic + useSpeech destructuring intact',
  );

  const scannerEffect = effectBodyWithMarker(chatSrc, 'scannerX', 'Animated.loop') ?? '';
  assert(
    'LSM-7 presentation animation effects do not invoke STT/TTS',
    !/\b(startRecording|stopRecording|speak|enqueueSentence)\s*\(/.test(scannerEffect),
    (v) => v === true,
    'no startRecording/stopRecording/speak/enqueueSentence in scanner presence effect',
  );

  assert(
    'LSM-8 mic onPress still gates on isSpeakingRef (sync authority read)',
    /if\s*\(\s*isStreaming\s*\|\|\s*isWaiting\s*\|\|\s*isSpeakingRef\.current\s*\)\s*return/.test(chatSrc),
    (v) => v === true,
    'mic tap block reads isSpeakingRef from useSpeech',
  );

  const forbiddenCaptionHit = [
    /['"]LISTENING['"]/i,
    /['"]SPEAKING['"]/i,
    /['"]THINKING['"]/i,
    /['"]STANDING BY['"]/i,
    /['"]YOUR MOVE['"]/i,
    />\s*LISTENING\s*</i,
    />\s*SPEAKING\s*</i,
    />\s*THINKING\s*</i,
    />\s*STANDING BY\s*</i,
    />\s*YOUR MOVE\s*</i,
    /IS SPEAKING/i,
  ].some((p) => p.test(chatSrc));

  assert(
    'LSM-9 no forbidden status caption strings in ChatScreen',
    forbiddenCaptionHit,
    (v) => v === false,
    'no LISTENING/SPEAKING/THINKING/STANDING BY/YOUR MOVE UI captions',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}ListeningSpeakingMirror: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('listeningSpeakingMirror.test.ts')) {
  runListeningSpeakingMirrorTests().catch(console.error);
}
