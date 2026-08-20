// scripts/heraldTest/transcriptAutoVisibility.test.ts
// Source-lock: ChatScreen transcript auto-visibility is presentation-only —
// followTranscriptRef + scrollTranscriptToEnd, no conversation authority.
//
// Runner: npx tsx scripts/heraldTest/transcriptAutoVisibility.test.ts

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

function scrollTranscriptToEndBody(src: string): string {
  const m = src.match(/const scrollTranscriptToEnd = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/);
  return m?.[1] ?? '';
}

function flatListScrollHandlerBlock(src: string): string {
  const m = src.match(
    /onScrollBeginDrag=\{\(\) => \{[\s\S]*?onContentSizeChange=\{\(\) => \{[\s\S]*?\}\}\s*\n\s*ListFooterComponent/,
  );
  return m?.[0] ?? '';
}

export async function runTranscriptAutoVisibilityTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}Transcript Auto-Visibility (source-lock)${RESET}`);

  const chatPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/screens/ChatScreen.tsx',
  );
  const chatSrc = fs.readFileSync(chatPath, 'utf8');
  const scrollBody = scrollTranscriptToEndBody(chatSrc);
  const flatListScroll = flatListScrollHandlerBlock(chatSrc);

  assert(
    'TAV-1 presentation-only transcript-follow ref exists',
    /\bfollowTranscriptRef\b/.test(chatSrc) && /const followTranscriptRef = useRef\(true\)/.test(chatSrc),
    (v) => v === true,
    'followTranscriptRef declared as presentation ref',
  );

  assert(
    'TAV-2 programmatic scrollToEnd for active-response following is animated:false',
    /scrollTranscriptToEnd/.test(chatSrc)
      && /scrollToEnd\(\{ animated: false \}\)/.test(chatSrc)
      && !/scrollToEnd\(\{ animated: true \}\)/.test(chatSrc),
    (v) => v === true,
    'scrollTranscriptToEnd uses scrollToEnd animated:false; no animated:true',
  );

  assert(
    'TAV-3 onContentSizeChange / growth auto-follow guarded by bottom OR active follow',
    /followTranscriptRef\.current/.test(scrollBody)
      && /isAtBottomRef\.current/.test(scrollBody)
      && /onContentSizeChange=\{\(\) => \{[\s\S]*?scrollTranscriptToEnd/.test(chatSrc),
    (v) => v === true,
    'scrollTranscriptToEnd checks isAtBottomRef || followTranscriptRef; onContentSizeChange calls it',
  );

  assert(
    'TAV-4 user drag — not generic onScroll alone — can disable active following',
    /onScrollBeginDrag=\{\(\) => \{[\s\S]*?userDraggingTranscriptRef\.current = true/.test(chatSrc)
      && /if \(userDraggingTranscriptRef\.current\) \{[\s\S]*?followTranscriptRef\.current = distFromBottom < 80/.test(chatSrc),
    (v) => v === true,
    'onScrollBeginDrag arms drag ref; followTranscriptRef toggles only during user drag',
  );

  assert(
    'TAV-5 viewport mechanism contains no conversation authority calls',
    scrollBody.length > 0
      && flatListScroll.length > 0
      && !/\b(addMessage|setMessages|startRecording|stopRecording|speak|enqueueSentence)\s*\(/.test(scrollBody + flatListScroll),
    (v) => v === true,
    'scrollTranscriptToEnd + FlatList scroll handlers do not invoke authority',
  );

  const scannerSlotJsx = chatSrc.indexOf('style={styles.scannerSlot}');
  const inputBarJsx = chatSrc.search(/style=\{\[\s*styles\.inputBar/);
  const inputBarToTextInput = chatSrc.slice(
    inputBarJsx >= 0 ? inputBarJsx : 0,
    chatSrc.indexOf('<TextInput', inputBarJsx >= 0 ? inputBarJsx : 0) + 10,
  );

  assert(
    'TAV-6 scanner slot always mounted above inputBar; track/bar remain isRecording||isSpeaking gated',
    scannerSlotJsx >= 0
      && inputBarJsx > scannerSlotJsx
      && /onLayout=\{\(e\) => setScannerTrackWidth/.test(chatSrc.slice(scannerSlotJsx, inputBarJsx))
      && !/\{\(isRecording\s*\|\|\s*isSpeaking\)\s*&&[\s\S]*?styles\.scannerSlot/.test(chatSrc)
      && /\{\(isRecording\s*\|\|\s*isSpeaking\)\s*&&[\s\S]*?styles\.scannerTrack/.test(chatSrc)
      && /\{\(isRecording\s*\|\|\s*isSpeaking\)\s*&&[\s\S]*?styles\.scannerBar/.test(chatSrc)
      && /styles\.inputBar[\s\S]*?>\s*<TextInput/.test(inputBarToTextInput)
      && !/styles\.scannerSlot/.test(inputBarToTextInput),
    (v) => v === true,
    'scannerSlot always mounted as sibling above inputBar; track/bar gated; inputBar first child is TextInput',
  );

  const total = passed + failures.length;
  console.log(`\n${BOLD}TranscriptAutoVisibility: ${passed}/${total} passed${failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('transcriptAutoVisibility.test.ts')) {
  runTranscriptAutoVisibilityTests().catch(console.error);
}
