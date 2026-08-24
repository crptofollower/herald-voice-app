// scripts/heraldTest/uxPass1.test.ts
// Source-lock: Herald MVP UX Pass 1 presentation-only changes.
//
// Runner: npx tsx scripts/heraldTest/uxPass1.test.ts

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

export async function runUxPass1Tests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}UX Pass 1 (source-lock)${RESET}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const bubbleSrc = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');

  assert(
    'UX1-1 founder TEMP DIAGNOSTIC customer UI removed from ChatScreen',
    chatSrc,
    (src) => typeof src === 'string'
      && !/TEMP DIAGNOSTIC — HANDS-FREE/.test(src)
      && !/TEMP DIAGNOSTIC — RUN LLM PROBE/.test(src)
      && !/TEMP DIAGNOSTIC: hands-free/.test(src),
    'no TEMP DIAGNOSTIC hands-free / LLM probe UI',
  );

  assert(
    'UX1-2 D1-DIAG route console.log removed',
    chatSrc,
    (src) => typeof src === 'string' && !/\[D1-DIAG\]/.test(src),
    'no [D1-DIAG] console.log in ChatScreen',
  );

  assert(
    'UX1-3 useMic exports read-only partialText',
    micSrc,
    (src) => typeof src === 'string'
      && /const \[partialText, setPartialText\]/.test(src)
      && /return \{ isRecording, startRecording, stopRecording, suspendForSpeech, partialText \}/.test(src),
    'partialText state mirrored and returned',
  );

  assert(
    'UX1-4 heard-preview ephemeral bubble in ListFooter during dwell',
    chatSrc,
    (src) => typeof src === 'string'
      && /setHeardPreviewText\(trimmed\)/.test(src)
      && /heardPreviewText/.test(src)
      && /id: "heard-preview"/.test(src)
      && /isEphemeral/.test(src)
      && /delayMs: 600/.test(src),
    'heardPreviewText set/cleared around 600ms handoff; ephemeral footer bubble',
  );

  assert(
    'UX1-5 talk control accessibility uses full AI name (not hands-free)',
    chatSrc,
    (src) => typeof src === 'string'
      && /accessibilityLabel=\{[\s\S]*?`Talk to \$\{aiName \|\| "Herald"\}`/.test(src)
      && /isRecording[\s\S]*?"Stop recording"/.test(src)
      && !/Start hands-free mode/.test(src),
    'a11y: Talk to full name / Stop recording',
  );

  assert(
    'UX1-6 MessageBubble visualWeight current vs prior',
    bubbleSrc,
    (src) => typeof src === 'string'
      && /visualWeight\?: "current" \| "prior"/.test(src)
      && /heraldTextPrior/.test(src)
      && /userTextPrior/.test(src),
    'MessageBubble supports current/prior presentation weights',
  );

  assert(
    'UX1-7 renderMessage assigns latest exchange without slicing displayMessages',
    chatSrc,
    (src) => typeof src === 'string'
      && /currentExchangeStart = Math\.max\(0, displayMessages\.length - 2\)/.test(src)
      && /visualWeight=\{index >= currentExchangeStart \? "current" : "prior"\}/.test(src)
      && !/displayMessages\.slice\(/.test(src),
    'last-two index weighting; no displayMessages slice',
  );

  assert(
    'UX1-8 talk-primary composer — talk control leads text row',
    chatSrc,
    (src) => typeof src === 'string'
      && /styles\.talkControlBtn/.test(src)
      && /styles\.composerTextRow/.test(src)
      && /styles\.textInputSecondary/.test(src)
      && /styles\.inputBar[\s\S]*?styles\.talkControlBtn[\s\S]*?styles\.composerTextRow/.test(src),
    'talk control precedes secondary text row in inputBar',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}UxPass1: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('uxPass1.test.ts')) {
  runUxPass1Tests().catch(console.error);
}
