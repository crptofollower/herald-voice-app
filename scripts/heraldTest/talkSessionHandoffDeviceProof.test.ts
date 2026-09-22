// TalkSession automatic handoff device-proof contract (Node).
// Does not execute Firebase. Locks observation-only journey instrumentation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetSpeechLifecycleRing,
  snapshotSpeechLifecycleRing,
  speechLifecycleLog,
} from '../../src/hooks/speechLifecycleInvariants.ts';
import { TALK_SESSION_FOLLOWUP_DELAY_MS } from '../../src/hooks/talkSession.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTalkSessionHandoffDeviceProofTests() {
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

  console.log(`\n${BOLD}-- TalkSession Handoff Device Proof contract ---------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const hostSrc = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const talkSrc = fs.readFileSync(path.join(root, 'src/hooks/talkSession.ts'), 'utf8');
  const bridgeSrc = fs.readFileSync(
    path.join(root, 'android/app/src/journey/java/ai/apexempire/herald/journey/HeraldJourneyBridge.kt'),
    'utf8',
  );
  const androidTestSrc = fs.readFileSync(
    path.join(root, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldTalkSessionHandoffV1Test.kt'),
    'utf8',
  );
  const probeStart = hostSrc.indexOf('async function runTalkSessionHandoffProbe');
  const probeEnd = hostSrc.indexOf('function runReset', probeStart);
  const probeSrc = probeStart >= 0 && probeEnd > probeStart ? hostSrc.slice(probeStart, probeEnd) : '';

  resetSpeechLifecycleRing();
  speechLifecycleLog('RECOGNITION_REQUESTED', { entryPoint: 'manual_button', session: 1 });
  speechLifecycleLog('TALKSESSION_FOLLOWUP_FIRE', { generation: 2 });
  const ring = snapshotSpeechLifecycleRing();
  assert('speech lifecycle ring is queryable for journey observation',
    ring.length === 2 && ring[0].event === 'RECOGNITION_REQUESTED' && ring[1].event === 'TALKSESSION_FOLLOWUP_FIRE',
    (v) => v === true, 'ring captures ordered events');

  assert('useMic RECOGNITION_REQUESTED records entryPoint',
    micSrc.includes("speechLifecycleLog('RECOGNITION_REQUESTED'")
      && /entryPoint/.test(micSrc.slice(micSrc.indexOf("speechLifecycleLog('RECOGNITION_REQUESTED'"), micSrc.indexOf("speechLifecycleLog('RECOGNITION_REQUESTED'") + 220)),
    (v) => v === true, 'entryPoint on RECOGNITION_REQUESTED');

  assert('TalkSession fire is logged then production startRecording post_tts_handoff',
    /TALKSESSION_FOLLOWUP_FIRE[\s\S]*startRecording\('post_tts_handoff'\)/.test(chatSrc),
    (v) => v === true, 'fire then post_tts_handoff');

  assert('journey beginManualConversation uses production tap authority',
    chatSrc.includes('beginManualConversation:')
      && /beginManualConversation: \(\) => \{[\s\S]*activateFromManualTap\(\)[\s\S]*startRecording\('manual_button', micMode\)/.test(chatSrc),
    (v) => v === true, 'activate + manual_button');

  assert('journey injectHeardTranscript uses production handleTranscript',
    /injectHeardTranscript: \(text: string\) => \{[\s\S]*handleTranscript\(text\)/.test(chatSrc),
    (v) => v === true, 'handleTranscript seam');

  assert('journey can peek TalkSession without owning it',
    chatSrc.includes('peekTalkSession:') && chatSrc.includes('talkSessionRef.current.phase'),
    (v) => v === true, 'peek only');

  assert('handoff probe never calls startRecording',
    probeSrc.includes('beginManualConversation')
      && probeSrc.includes('injectHeardTranscript')
      && !probeSrc.includes('startRecording(')
      && !probeSrc.includes("startRecording('post_tts_handoff')")
      && !probeSrc.includes("startRecording('manual_button')"),
    (v) => v === true, 'no harness STT start in probe');

  assert('handoff probe waits for production TALKSESSION_FOLLOWUP_FIRE before second inject',
    probeSrc.includes("e.event === 'TALKSESSION_FOLLOWUP_FIRE'")
      && probeSrc.indexOf('automatic_post_tts_handoff_missing') < probeSrc.indexOf("injectHeard('what time is it')"),
    (v) => v === true, 'second inject after automatic listen');

  assert('handoff probe emits durable talk_session_handoff.v1 artifact',
    probeSrc.includes("schema: 'herald.journey.talk_session_handoff.v1'")
      && probeSrc.includes('harnessStartRecordingCalls: 0')
      && probeSrc.includes('rearmAfterIdle'),
    (v) => v === true, 'durable schema');

  assert('native bridge exposes probeTalkSessionHandoff without a second recognizer',
    bridgeSrc.includes('fun probeTalkSessionHandoff')
      && bridgeSrc.includes('DebugJourneyTalkSessionHandoff')
      && !bridgeSrc.includes('SpeechRecognizer'),
    (v) => v === true, 'bridge observe-only');

  assert('Android test observes production follow-up and does not start STT',
    androidTestSrc.includes('probeTalkSessionHandoff')
      && !androidTestSrc.includes('startRecording')
      && !androidTestSrc.includes('probeSpeechLifecycle')
      && androidTestSrc.includes('post_tts_handoff'),
    (v) => v === true, 'FTL test observes only');

  assert('existing speech probe remains a distinct manual-rearm path',
    hostSrc.includes('async function runSpeechLifecycleProbe')
      && hostSrc.includes("await startRecording('manual_button', 'open')"),
    (v) => v === true, 'legacy probe unchanged');

  assert('TalkSession still does not own a recognizer',
    !/ExpoSpeechRecognitionModule/.test(talkSrc) && !/startRecording/.test(talkSrc),
    (v) => v === true, 'no STT in talkSession.ts');

  assert('useMic remains the sole Expo start authority',
    (micSrc.match(/ExpoSpeechRecognitionModule\.start/g) || []).length === 1
      && !chatSrc.includes('ExpoSpeechRecognitionModule.start'),
    (v) => v === true, 'single native start');

  assert('follow-up delay is not retuned for Firebase',
    TALK_SESSION_FOLLOWUP_DELAY_MS === 1400
      && chatSrc.includes('TALK_SESSION_FOLLOWUP_DELAY_MS'),
    (v) => v === true, '1400ms');

  assert('manual tap path remains first-class beside the journey seam',
    chatSrc.includes("startRecording('manual_button', micMode)")
      && /if \(isStreaming \|\| isWaiting \|\| isSpeakingRef\.current\) return/.test(chatSrc),
    (v) => v === true, 'tap intact');

  const total = passed + failures.length;
  console.log(`\n${BOLD}TalkSessionHandoffDeviceProof: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('talkSessionHandoffDeviceProof')) {
  runTalkSessionHandoffDeviceProofTests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
