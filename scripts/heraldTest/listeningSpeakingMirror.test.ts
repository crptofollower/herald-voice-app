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
    'LSM-1 listening presence halo gated on isRecording',
    /\{isRecording\s*&&[\s\S]*?presenceHalo/.test(chatSrc),
    (v) => v === true,
    'isRecording conditional wraps presenceHalo',
  );

  assert(
    'LSM-2 listening pulse animation effect depends on isRecording',
    effectBodyWithMarker(chatSrc, 'isRecording', 'listenGlowAnim'),
    (body) => typeof body === 'string' && body.includes('pulseAnim'),
    'isRecording effect drives pulseAnim + listenGlowAnim',
  );

  assert(
    'LSM-3 speaking presence halo gated on isSpeaking',
    /\{isSpeaking\s*&&[\s\S]*?presenceHalo/.test(chatSrc),
    (v) => v === true,
    'isSpeaking conditional wraps presenceHalo',
  );

  assert(
    'LSM-4 speaking pulse animation effect depends on isSpeaking',
    effectBodyWithMarker(chatSrc, 'isSpeaking', 'speakPulseAnim'),
    (body) => typeof body === 'string' && !/\b(startRecording|stopRecording|speak|enqueueSentence)\s*\(/.test(body),
    'isSpeaking presence effect drives speakPulseAnim only',
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

  const recordingEffect = effectBodyWithMarker(chatSrc, 'isRecording', 'listenGlowAnim') ?? '';
  const speakingEffect = effectBodyWithMarker(chatSrc, 'isSpeaking', 'speakPulseAnim') ?? '';
  assert(
    'LSM-7 presentation animation effects do not invoke STT/TTS',
    [recordingEffect, speakingEffect].every(
      (body) => !/\b(startRecording|stopRecording|speak|enqueueSentence)\s*\(/.test(body),
    ),
    (v) => v === true,
    'no startRecording/stopRecording/speak/enqueueSentence in presence effects',
  );

  assert(
    'LSM-8 mic onPress still gates on isSpeakingRef (sync authority read)',
    /if\s*\(\s*isStreaming\s*\|\|\s*isWaiting\s*\|\|\s*isSpeakingRef\.current\s*\)\s*return/.test(chatSrc),
    (v) => v === true,
    'mic tap block reads isSpeakingRef from useSpeech',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}ListeningSpeakingMirror: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('listeningSpeakingMirror.test.ts')) {
  runListeningSpeakingMirrorTests().catch(console.error);
}
