// Speech Lifecycle Invariants V1 — listening-ready vs requested, TTS gen-gated failsafe, Talk re-arm.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LISTENING_READY_TIMEOUT_MS,
  TTS_TERMINAL_FAILSAFE_MS,
  applyExpoSpeechTerminal,
  applyListeningReadyTimeout,
  applyTtsTerminalFailsafe,
  claimsListeningReady,
  talkAttemptAdmission,
} from '../../src/hooks/speechLifecycleInvariants.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runSpeechLifecycleInvariantsV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Speech Lifecycle Invariants V1 ---------------------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const speechSrc = fs.readFileSync(path.join(root, 'src/hooks/useSpeech.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(root, 'android/app/src/journey/java/ai/apexempire/herald/journey/HeraldJourneyBridge.kt'), 'utf8');
  const startHandler = micSrc.includes("useSpeechRecognitionEvent('start'")
    ? micSrc.slice(micSrc.indexOf("useSpeechRecognitionEvent('start'"))
    : '';
  const startRecording = micSrc.match(/const startRecording = useCallback\(async \([\s\S]*?\}, \[stopRecording\]\);/)?.[0] ?? '';
  const drain = speechSrc.match(/const drainExpoQueue = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
  const fallback = speechSrc.match(/const onFallbackTerminal = \(\) => \{[\s\S]*?ExpoSpeech\.speak\(clean, \{[\s\S]*?\}\);/)?.[0] ?? '';

  assert('SLI-1 native Expo start is the only listening-ready claim',
    claimsListeningReady('native_start'), v => v === true, 'true');
  assert('SLI-2 JS start() return is not listening-ready',
    claimsListeningReady('js_start_return'), v => v === false, 'false');
  assert('SLI-3 start() call is not listening-ready',
    claimsListeningReady('start_called'), v => v === false, 'false');
  assert('SLI-4 audiostart is not listening-ready',
    claimsListeningReady('audiostart'), v => v === false, 'false');
  assert('SLI-5 speechstart is not listening-ready',
    claimsListeningReady('speechstart'), v => v === false, 'false');
  assert('SLI-6 STATE_AFTER_START is not listening-ready',
    claimsListeningReady('state_after_start'), v => v === false, 'false');

  assert('SLI-7 readiness timeout fails closed when requested and not native-ready',
    applyListeningReadyTimeout({ timeoutSession: 1, currentSession: 1, requested: true, nativeReady: false }),
    v => v === 'fail_closed', 'fail_closed');
  assert('SLI-8 stale readiness timeout does not fail-close a newer session',
    applyListeningReadyTimeout({ timeoutSession: 1, currentSession: 2, requested: true, nativeReady: false }),
    v => v === 'stale', 'stale');
  assert('SLI-9 readiness timeout is a no-op after native-ready',
    applyListeningReadyTimeout({ timeoutSession: 1, currentSession: 1, requested: true, nativeReady: true }),
    v => v === 'already_ready', 'already_ready');

  let speaking = true;
  let idle = false;
  const live = applyExpoSpeechTerminal({
    callbackGen: 7,
    currentGen: 7,
    markNativeIdle: () => { idle = true; },
    continueDrain: () => { speaking = false; },
  });
  assert('SLI-10 ordinary TTS terminal clears current speaking generation',
    { live, speaking, idle },
    v => (v as { live: string; speaking: boolean; idle: boolean }).live === 'applied'
      && !(v as { speaking: boolean }).speaking
      && (v as { idle: boolean }).idle,
    'applied + idle + speaking false');

  speaking = true;
  idle = false;
  const missing = applyTtsTerminalFailsafe({
    failsafeGen: 8,
    currentGen: 8,
    markNativeIdle: () => { idle = true; },
    releaseSpeaking: () => { speaking = false; },
  });
  assert('SLI-11 missing TTS terminal failsafe revokes through the same gate',
    { missing, speaking, idle },
    v => (v as { missing: string }).missing === 'applied' && !(v as { speaking: boolean }).speaking,
    'applied + speaking false');

  speaking = true;
  idle = false;
  const staleWatch = applyTtsTerminalFailsafe({
    failsafeGen: 9,
    currentGen: 10,
    markNativeIdle: () => { idle = true; },
    releaseSpeaking: () => { speaking = false; },
  });
  assert('SLI-12 stale watchdog for generation N cannot clear N+1',
    { staleWatch, speaking, idle },
    v => (v as { staleWatch: string }).staleWatch === 'stale'
      && (v as { speaking: boolean }).speaking
      && !(v as { idle: boolean }).idle,
    'stale; speaking remains true');

  speaking = true;
  idle = false;
  const staleNative = applyExpoSpeechTerminal({
    callbackGen: 3,
    currentGen: 4,
    markNativeIdle: () => { idle = true; },
    continueDrain: () => { speaking = false; },
  });
  assert('SLI-13 stale native terminal for N cannot clear N+1',
    { staleNative, speaking, idle },
    v => (v as { staleNative: string }).staleNative === 'stale'
      && (v as { speaking: boolean }).speaking
      && !(v as { idle: boolean }).idle,
    'stale; speaking remains true');

  speaking = false;
  assert('SLI-14 after failsafe/terminal, Talk is not blocked by stale isSpeaking',
    talkAttemptAdmission({ isStreaming: false, isWaiting: false, isSpeaking: speaking }),
    v => (v as { admitted: boolean }).admitted === true,
    'admitted');
  assert('SLI-15 Talk remains blocked while current TTS generation is active',
    talkAttemptAdmission({ isStreaming: false, isWaiting: false, isSpeaking: true }),
    v => (v as { admitted?: boolean; reason?: string }).admitted === false
      && (v as { reason?: string }).reason === 'ttsActive',
    'blocked ttsActive');

  assert('SLI-16 listening-ready UI is authorized only in the Expo start handler',
    { startHandler, trueCount: (micSrc.match(/setIsRecording\(true\)/g) || []).length },
    v => {
      const o = v as { startHandler: string; trueCount: number };
      const startBlock = o.startHandler.slice(0, o.startHandler.indexOf("useSpeechRecognitionEvent('speechstart'"));
      return o.trueCount === 1
        && startBlock.includes('setIsRecording(true)')
        && startBlock.includes('RECOGNITION_NATIVE_READY')
        && startBlock.includes("log('NATIVE_START_EVENT')");
    },
    'single setIsRecording(true) inside start event');
  assert('SLI-17 start() request does not set listening-ready',
    startRecording,
    v => typeof v === 'string'
      && v.includes('RECOGNITION_REQUESTED')
      && v.includes('ExpoSpeechRecognitionModule.start')
      && !v.includes('setIsRecording(true)')
      && v.includes('applyListeningReadyTimeout')
      && v.includes('LISTENING_READY_TIMEOUT_MS'),
    'request + timeout, no setIsRecording(true)');
  assert('SLI-18 bounded constants',
    { LISTENING_READY_TIMEOUT_MS, TTS_TERMINAL_FAILSAFE_MS },
    v => (v as { LISTENING_READY_TIMEOUT_MS: number }).LISTENING_READY_TIMEOUT_MS === 4000
      && (v as { TTS_TERMINAL_FAILSAFE_MS: number }).TTS_TERMINAL_FAILSAFE_MS === 12000,
    '4s ready / 12s TTS failsafe');
  assert('SLI-19 failsafe is generation-scoped through applyTtsTerminalFailsafe',
    speechSrc,
    v => typeof v === 'string'
      && /applyTtsTerminalFailsafe\(\{[\s\S]*failsafeGen: gen[\s\S]*currentGen: genRef\.current/.test(v)
      && /TTS_TERMINAL_FAILSAFE_MS/.test(v)
      && /reason: 'failsafe'/.test(v),
    'watchdog uses existing terminal gate');
  assert('SLI-20 fallback ExpoSpeech terminal is gen-gated',
    fallback,
    v => typeof v === 'string' && v.includes('applyExpoSpeechTerminal') && v.includes('callbackGen: gen') && v.includes('currentGen: genRef.current'),
    'fallback through applyExpoSpeechTerminal');
  assert('SLI-21 ordinary ExpoSpeech path still registers native terminals',
    drain,
    v => typeof v === 'string'
      && v.includes('onDone: onTerminal')
      && v.includes('onError: onTerminal')
      && v.includes('onStopped: onTerminal')
      && v.includes('applyExpoSpeechTerminal'),
    'onDone/onError/onStopped → applyExpoSpeechTerminal');
  assert('SLI-22 Talk half-duplex gate remains the production if-return',
    chatSrc,
    v => typeof v === 'string'
      && /if \(isStreaming \|\| isWaiting \|\| isSpeakingRef\.current\) return/.test(v)
      && /TALK_BLOCKED/.test(v)
      && /TALK_ADMITTED/.test(v)
      && /talkAttemptAdmission/.test(v),
    'existing Talk gate + breadcrumbs');
  assert('SLI-23 journey host can later exercise production startRecording',
    { hostSrc, bridgeSrc, chatSrc },
    v => {
      const o = v as { hostSrc: string; bridgeSrc: string; chatSrc: string };
      return o.hostSrc.includes('DebugJourneySpeechProbe')
        && o.hostSrc.includes('runSpeechLifecycleProbe')
        && o.hostSrc.includes('startRecording')
        && o.bridgeSrc.includes('probeSpeechLifecycle')
        && o.chatSrc.includes('startRecording:')
        && o.chatSrc.includes('peekSpeaking:');
    },
    'speech probe bound to production ownership');

  console.log(`\n${BOLD}Speech Lifecycle Invariants V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('speechLifecycleInvariants');
if (isDirect) {
  runSpeechLifecycleInvariantsV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
