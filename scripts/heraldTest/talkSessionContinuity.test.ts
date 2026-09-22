// TalkSession Continuity V1 — Phase A. Deterministic lifecycle + ChatScreen source-lock.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTalkSession,
  TALK_SESSION_FOLLOWUP_DELAY_MS,
} from '../../src/hooks/talkSession.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTalkSessionContinuityV1Tests() {
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

  console.log(`\n${BOLD}-- TalkSession Continuity V1 Phase A ---------------------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const talkSrc = fs.readFileSync(path.join(root, 'src/hooks/talkSession.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');

  {
    const s = createTalkSession();
    assert('manual entry activates TalkSession',
      s.activateFromManualTap() >= 1 && s.phase === 'active',
      (v) => v === true, 'active after manual tap');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const first = s.noteTtsTerminal();
    const second = s.noteTtsTerminal();
    assert('completed Kit response schedules exactly one follow-up',
      first.schedule === true && second.schedule === false && s.pendingFollowupGeneration === first.generation,
      (v) => v === true, 'one pending follow-up');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const { generation } = s.noteTtsTerminal();
    const fire = s.evaluateFollowupFire(generation, { ttsSpeaking: false, streaming: false, appActive: true });
    assert('automatic follow-up is eligible to start after valid fire',
      fire.shouldStart === true && s.phase === 'followup',
      (v) => v === true, 'shouldStart');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const g1 = s.noteTtsTerminal().generation;
    s.evaluateFollowupFire(g1, { ttsSpeaking: false, streaming: false, appActive: true });
    s.noteContentfulUtterance();
    const again = s.noteTtsTerminal();
    assert('contentful reply permits another conversational follow-up',
      s.phase === 'followup' && again.schedule === true,
      (v) => v === true, 'second follow-up scheduled');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const g1 = s.noteTtsTerminal().generation;
    s.evaluateFollowupFire(g1, { ttsSpeaking: false, streaming: false, appActive: true });
    const ended = s.noteFollowupSilence();
    const rearm = s.noteTtsTerminal();
    assert('follow-up silence terminates without rearming',
      ended.ended === true && s.phase === 'idle' && rearm.schedule === false,
      (v) => v === true, 'idle, no rearm');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const stale = s.noteTtsTerminal().generation;
    s.activateFromManualTap();
    const fire = s.evaluateFollowupFire(stale, { ttsSpeaking: false, streaming: false, appActive: true });
    assert('stale generation cannot reopen listening',
      fire.shouldStart === false,
      (v) => v === true, 'stale token rejected');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const scheduled = s.noteTtsTerminal().generation;
    s.activateFromManualTap();
    const fire = s.evaluateFollowupFire(scheduled, { ttsSpeaking: false, streaming: false, appActive: true });
    assert('manual tap invalidates scheduled automatic follow-up',
      fire.shouldStart === false && s.phase === 'active',
      (v) => v === true, 'tap wins');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const g = s.noteTtsTerminal().generation;
    const fire = s.evaluateFollowupFire(g, { ttsSpeaking: false, streaming: false, appActive: false });
    assert('background/inactive terminates and prevents follow-up',
      fire.shouldStart === false && s.phase === 'idle',
      (v) => v === true, 'idle on inactive');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const g = s.noteTtsTerminal().generation;
    const fire = s.evaluateFollowupFire(g, { ttsSpeaking: true, streaming: false, appActive: true });
    assert('TTS-active condition prevents premature STT',
      fire.shouldStart === false && s.pendingFollowupGeneration === g,
      (v) => v === true, 'blocked while TTS speaking, still pending');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const g = s.noteTtsTerminal().generation;
    s.terminate();
    const fire = s.evaluateFollowupFire(g, { ttsSpeaking: false, streaming: false, appActive: true });
    assert('teardown invalidates scheduled automatic follow-up',
      fire.shouldStart === false && s.phase === 'idle',
      (v) => v === true, 'idle after terminate');
  }

  {
    const s = createTalkSession();
    s.activateFromManualTap();
    const a = s.noteTtsTerminal();
    s.evaluateFollowupFire(a.generation, { ttsSpeaking: false, streaming: false, appActive: true });
    s.noteContentfulUtterance();
    const b = s.noteTtsTerminal();
    assert('repeated successful turns keep a single pending follow-up slot',
      a.schedule && b.schedule && s.pendingFollowupGeneration === b.generation,
      (v) => v === true, 'one pending after second turn');
  }

  assert('TalkSession does not instantiate a second recognizer',
    !/ExpoSpeechRecognitionModule/.test(talkSrc)
      && !/startRecording/.test(talkSrc)
      && !/from ['"].*conversationSession/.test(talkSrc)
      && !/new ConversationSession/.test(talkSrc),
    (v) => v === true, 'no STT/ConversationSession in talkSession.ts');

  assert('follow-up delay remains the existing 1400ms evidence value',
    TALK_SESSION_FOLLOWUP_DELAY_MS === 1400,
    (v) => v === true, '1400');

  assert('ChatScreen follow-up uses startRecording post_tts_handoff only after TalkSession fire',
    chatSrc.includes("startRecording('post_tts_handoff')")
      && chatSrc.includes('evaluateFollowupFire')
      && chatSrc.includes('createTalkSession')
      && chatSrc.includes('activateFromManualTap')
      && /if \(shouldStart\) \{[\s\S]*?startRecording\('post_tts_handoff'\)/.test(chatSrc),
    (v) => v === true, 'token-gated post_tts_handoff');

  assert('manual tap still uses startRecording manual_button and invalidates follow-up',
    chatSrc.includes("startRecording('manual_button', micMode)")
      && chatSrc.includes('activateFromManualTap')
      && /if \(isRecording\) \{[\s\S]*?terminateTalkSession\(\)[\s\S]*?stopRecording\(\)/.test(chatSrc)
      && /if \(isStreaming \|\| isWaiting \|\| isSpeakingRef\.current\) return/.test(chatSrc),
    (v) => v === true, 'manual path + stop terminates');

  assert('handsFreeMode user-mode is replaced by TalkSession',
    !/\bhandsFreeMode\b/.test(chatSrc)
      && !/\bsetHandsFreeMode\b/.test(chatSrc)
      && !/\bhandsFreeRef\b/.test(chatSrc),
    (v) => v === true, 'no handsFreeMode');

  assert('useRaiseToWake remains disabled',
    /useRaiseToWake\(\{[\s\S]*?enabled:\s*false/.test(chatSrc),
    (v) => v === true, 'enabled: false');

  assert('useMic remains the sole Expo start authority',
    (micSrc.match(/ExpoSpeechRecognitionModule\.start/g) || []).length === 1
      && !chatSrc.includes('ExpoSpeechRecognitionModule.start'),
    (v) => v === true, 'single native start in useMic');

  assert('AppState background/inactive terminates TalkSession',
    chatSrc.includes("nextState === \"background\" || nextState === \"inactive\"")
      && chatSrc.includes('terminateTalkSessionRef.current()'),
    (v) => v === true, 'AppState terminate');

  assert('journey host still binds production startRecording without a second STT path',
    hostSrc.includes('startRecording')
      && hostSrc.includes("'post_tts_handoff'")
      && !hostSrc.includes('ExpoSpeechRecognitionModule.start'),
    (v) => v === true, 'journey uses runtime startRecording');

  assert('no Phase A farewell phrase handling',
    !/that's all|i'm good|never mind|thanks,?\s*kit/i.test(talkSrc),
    (v) => v === true, 'no farewell regex');

  const total = passed + failures.length;
  console.log(`\n${BOLD}TalkSessionContinuityV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('talkSessionContinuity')) {
  runTalkSessionContinuityV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
