// scripts/heraldTest/uxPass1b.test.ts
// Source-lock: Herald MVP UX Pass 1B presentation-only changes.
//
// Runner: npx tsx scripts/heraldTest/uxPass1b.test.ts

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

export async function runUxPass1bTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}UX Pass 1B (source-lock)${RESET}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const bubbleSrc = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(root, 'src/components/PersonaBackground.tsx'), 'utf8');
  const personaSrc = fs.readFileSync(path.join(root, 'src/constants/personas.ts'), 'utf8');

  assert(
    'UX1B-1 talk control uses aiName state (not hardcoded Kit)',
    chatSrc,
    (src) => typeof src === 'string'
      && /Talk to \$\{aiName \|\| "Herald"\}/.test(src)
      && !/Talk to Kit/.test(src)
      && !/hardcoded.*Kit/i.test(src),
    'Talk to ${aiName || "Herald"} in visible label',
  );

  assert(
    'UX1B-2 compact voice zone — accessibility keeps full AI name',
    chatSrc,
    (src) => typeof src === 'string'
      && /accessibilityLabel=\{[\s\S]*?`Talk to \$\{aiName \|\| "Herald"\}`/.test(src)
      && /isRecording[\s\S]*?"Stop recording"/.test(src)
      && !/Talk to Kit/.test(src),
    'a11y: Talk to full name / Stop recording in voice zone',
  );

  assert(
    'UX1B-3 talk control accessibility keeps full AI name',
    chatSrc,
    (src) => typeof src === 'string'
      && /accessibilityLabel=\{[\s\S]*?`Talk to \$\{aiName \|\| "Herald"\}`/.test(src)
      && /isRecording[\s\S]*?"Stop recording"/.test(src),
    'a11y: Talk to full name / Stop recording',
  );

  assert(
    'UX1B-4 voice tap behavior unchanged (start/stop recording)',
    chatSrc,
    (src) => typeof src === 'string'
      && /if \(isRecording\) \{[\s\S]*?stopRecording\(\)/.test(src)
      && /startRecording\('manual_button', micMode\)/.test(src)
      && /if \(isStreaming \|\| isWaiting \|\| isSpeakingRef\.current\) return/.test(src),
    'onPress gates + stopRecording/startRecording intact',
  );

  assert(
    'UX1B-5 text path in unified composer — Talk to AI + send via handleSend',
    chatSrc,
    (src) => typeof src === 'string'
      && /placeholder=\{`Talk to \$\{aiName \|\| "Herald"\}`\}/.test(src)
      && /accessibilityLabel="Message input"/.test(src)
      && /accessibilityLabel="Send message"/.test(src)
      && /onPress=\{handleSend\}/.test(src)
      && /styles\.inputBar[\s\S]*?<TextInput[\s\S]*?handleSend/.test(src)
      && !/styles\.composerTextRow/.test(src),
    'TextInput + handleSend in same inputBar; no detached secondary row',
  );

  assert(
    'UX1B-6 transcript auto-follow refs intact',
    chatSrc,
    (src) => typeof src === 'string'
      && /\bisAtBottomRef\b/.test(src)
      && /\bfollowTranscriptRef\b/.test(src)
      && /\bscrollTranscriptToEnd\b/.test(src)
      && !/displayMessages\.slice\(/.test(src),
    'isAtBottomRef/followTranscriptRef/scrollTranscriptToEnd present',
  );

  assert(
    'UX1B-7 selected look — persona tokens consumed in composer/surfaces',
    [chatSrc, bubbleSrc, bgSrc, personaSrc].join('\n'),
    (src) => typeof src === 'string'
      && /persona\.surfaceTint/.test(src)
      && /PersonaBackground/.test(src)
      && /surfaceTint/.test(personaSrc)
      && /PERSONAS\[personaKey\]/.test(chatSrc),
    'surfaceTint + PersonaBackground + personaKey selection',
  );

  assert(
    'UX1B-8 identity talk control — no emoji mic',
    chatSrc,
    (src) => typeof src === 'string'
      && /styles\.talkControlBtn/.test(src)
      && /styles\.talkAvatar/.test(src)
      && /Ionicons/.test(src)
      && !/🎤/.test(src)
      && !/⏹/.test(src),
    'talkControlBtn + avatar; no emoji mic/stop',
  );

  assert(
    'UX1B-9 continuous canvas — no hard black composer seam',
    chatSrc,
    (src) => typeof src === 'string'
      && /styles\.composerCanvas/.test(src)
      && /LinearGradient/.test(src)
      && !/backgroundColor: "rgba\(0,0,0,0\.75\)"/.test(src)
      && !/borderTopWidth/.test(src),
    'composer gradient scrim; no rgba(0,0,0,0.75) bar',
  );

  assert(
    'UX1B-10 restrained user surfaces — no bright userBubble fill',
    bubbleSrc,
    (src) => typeof src === 'string'
      && /persona\.surfaceTint/.test(src)
      && !/persona\.colors\.userBubble/.test(src)
      && /borderRightColor: persona\.colors\.accent/.test(src),
    'surfaceTint user chip + accent edge; no userBubble',
  );

  assert(
    'UX1B-11 no TEMP DIAGNOSTIC / scanner regression',
    chatSrc,
    (src) => typeof src === 'string'
      && !/TEMP DIAGNOSTIC/.test(src)
      && !/\bscannerTrack\b/.test(src)
      && !/\bscannerBar\b/.test(src),
    'no TEMP DIAGNOSTIC or scanner UI',
  );

  assert(
    'UX1B-12 responsive — flex/minWidth, no device-specific widths',
    [chatSrc, bubbleSrc].join('\n'),
    (src) => {
      if (typeof src !== 'string') return false;
      const noComments = src.replace(/\/\/[^\n]*/g, '');
      return /minWidth: 0/.test(noComments)
        && /allowFontScaling/.test(noComments)
        && !/S24|Samsung|\bwidth:\s*360\b|\bwidth:\s*390\b|\bwidth:\s*412\b/.test(noComments);
    },
    'flex/minWidth/allowFontScaling; no S24/Samsung fixed widths',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}UxPass1b: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('uxPass1b.test.ts')) {
  runUxPass1bTests().catch(console.error);
}
