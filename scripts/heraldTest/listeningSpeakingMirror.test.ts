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
    'LSM-1 redundant scanner bar removed (subtraction pass)',
    chatSrc,
    (src) => typeof src === 'string'
      && !/\bscannerTrack\b/.test(src)
      && !/\bscannerBar\b/.test(src)
      && !/\bscannerX\b/.test(src),
    'no scannerTrack/scannerBar/scannerX in ChatScreen',
  );

  assert(
    'LSM-2 talk control reflects isRecording state (no duplicate scanner cue)',
    chatSrc,
    (src) => typeof src === 'string'
      && /backgroundColor: isRecording/.test(src)
      && /borderColor: isRecording/.test(src)
      && /isRecording \? "Listening…"/.test(src),
    'talk control color/label gated on isRecording',
  );

  assert(
    'LSM-3 stop-speaking header control still mirrors isSpeaking',
    /\{isSpeaking && \([\s\S]*?accessibilityLabel="Stop speaking"/.test(chatSrc),
    (v) => v === true,
    'header stop button gated on isSpeaking',
  );

  assert(
    'LSM-4 no scanner animation effects remain',
    chatSrc,
    (src) => typeof src === 'string'
      && !/useEffect\([\s\S]*?scannerX/.test(src)
      && !/\blistenGlowAnim\b/.test(src)
      && !/\bpulseAnim\b/.test(src)
      && !/\bspeakPulseAnim\b/.test(src),
    'no scannerX effect or halo/pulse anim refs',
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

  assert(
    'LSM-7 mic onPress still gates on isSpeakingRef (sync authority read)',
    /if\s*\(\s*isStreaming\s*\|\|\s*isWaiting\s*\|\|\s*isSpeakingRef\.current\s*\)\s*return/.test(chatSrc),
    (v) => v === true,
    'mic tap block reads isSpeakingRef from useSpeech',
  );

  assert(
    'LSM-8 talk control accessibility uses full AI name (not hands-free mislabel)',
    /accessibilityLabel=\{[\s\S]*?`Talk to \$\{aiName \|\| "Herald"\}`/.test(chatSrc)
      && /isRecording[\s\S]*?"Stop recording"/.test(chatSrc),
    (v) => v === true,
    'talk control a11y: Talk to full name / Stop recording',
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
