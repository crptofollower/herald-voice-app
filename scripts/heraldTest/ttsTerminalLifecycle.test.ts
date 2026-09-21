// ExpoSpeech terminal lifecycle: onDone / onError / onStopped share one
// generation-gated drain. Source-contract + helper-body lock (no RN import).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTtsTerminalLifecycleTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- TTS Terminal Lifecycle ----------------------------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const speechSrc = fs.readFileSync(path.join(root, 'src/hooks/useSpeech.ts'), 'utf8');
  const invSrc = fs.readFileSync(path.join(root, 'src/hooks/speechLifecycleInvariants.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const helper = invSrc.match(/export function applyExpoSpeechTerminal[\s\S]*?return 'applied';\r?\n\}/)?.[0] ?? '';
  const drain = speechSrc.match(/const drainExpoQueue = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
  const stop = speechSrc.match(/const stop = useCallback\(async \(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';

  assert('TTL-A live generation applies idle then drain',
    helper,
    v => typeof v === 'string'
      && /if \(opts\.callbackGen !== opts\.currentGen\) return 'stale';/.test(v)
      && /opts\.markNativeIdle\(\);/.test(v)
      && /opts\.continueDrain\(\);/.test(v)
      && /return 'applied';/.test(v)
      && v.indexOf("return 'stale'") < v.indexOf('opts.markNativeIdle()'),
    'stale-check before idle/drain; applied path continues drain');

  assert('TTL-B/C drain registers onDone, onError, and onStopped on the same handler',
    drain,
    v => typeof v === 'string'
      && v.includes('onDone: onTerminal')
      && v.includes('onError: onTerminal')
      && v.includes('onStopped: onTerminal')
      && /const onTerminal = \(\) => \{[\s\S]*applyExpoSpeechTerminal\(/.test(v)
      && /callbackGen: utteranceGen/.test(v)
      && /currentGen: genRef\.current/.test(v)
      && /expoSpeakingRef\.current = false/.test(v)
      && /continueDrain: drainExpoQueue/.test(v),
    'shared onTerminal → applyExpoSpeechTerminal');

  assert('TTL-D stale native terminal does not mutate active generation',
    helper,
    v => typeof v === 'string'
      && /if \(opts\.callbackGen !== opts\.currentGen\) return 'stale';/.test(v)
      && !/markNativeIdle\(\)[\s\S]*callbackGen/.test(v),
    'mismatched gen returns stale before any lifecycle mutation');

  assert('TTL-E explicit stop still clears speaking and native speech',
    stop,
    v => typeof v === 'string'
      && /genRef\.current \+= 1/.test(v)
      && /setSpeaking\(false\)/.test(v)
      && /ExpoSpeech\.stop\(\)/.test(v)
      && /turnStartGateRef\.current\.reset\(\)/.test(v)
      && /expoSpeakingRef\.current = false/.test(v)
      && /expoQueueRef\.current = \[\]/.test(v)
      && v.indexOf('genRef.current += 1') < v.indexOf('ExpoSpeech.stop()'),
    'gen bump before native stop; speaking false; gate reset');

  assert('TTL-F header speaking control still mirrors isSpeaking and calls stop',
    chatSrc,
    v => typeof v === 'string'
      && /\{isSpeaking && \([\s\S]*?accessibilityLabel="Stop speaking"/.test(v)
      && /onPress=\{stop\}/.test(v)
      && /isSpeaking,\s*isSpeakingRef\s*\}\s*=\s*useSpeech/.test(v),
    'LSM speaking mirror intact');

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('ttsTerminalLifecycle');
if (isDirect) {
  runTtsTerminalLifecycleTests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
