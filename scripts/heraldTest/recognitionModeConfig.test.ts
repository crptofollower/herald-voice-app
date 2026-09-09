// scripts/heraldTest/recognitionModeConfig.test.ts
// These tests verify only the pure recognition-mode config helper.
// They do NOT prove that start() actually receives contextualStrings,
// that Android EXTRA_BIASING_STRINGS is applied, or that STT accuracy
// changes at runtime. Those remain device-proof-only.
//
// Runner: npx tsx scripts/heraldTest/recognitionModeConfig.test.ts
// Gate:   wired from run.mjs

import { getContextualStringsForMode, CONTROL_CONFIRMATION_STRINGS, buildStartConfig } from '../../src/hooks/recognitionModeConfig.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runRecognitionModeConfigTests() {
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

  console.log(`\n${BOLD}-- Recognition Mode Config Tests -----------------------${RESET}`);

  {
    const got = getContextualStringsForMode('open');
    assert('open mode returns undefined', got, (v) => v === undefined, 'undefined');
  }

  {
    const got = getContextualStringsForMode('control_confirmation');
    assert('control_confirmation mode returns the biasing list', got,
      (v) => JSON.stringify(v) === JSON.stringify(CONTROL_CONFIRMATION_STRINGS),
      JSON.stringify(CONTROL_CONFIRMATION_STRINGS));
  }

  {
    const got = CONTROL_CONFIRMATION_STRINGS;
    assert('control_confirmation list contains yes and no', got,
      (v) => Array.isArray(v) && v.includes('yes') && v.includes('no'),
      "includes 'yes' and 'no'");
  }

  {
    const got = getContextualStringsForMode('open');
    assert('open mode never returns the control list', got,
      (v) => v !== CONTROL_CONFIRMATION_STRINGS, 'not CONTROL_CONFIRMATION_STRINGS');
  }

  {
    const open = buildStartConfig('open');
    const control = buildStartConfig('control_confirmation');
    assert('buildStartConfig never sets EXTRA_LANGUAGE_MODEL (July behavior restored)', { open, control },
      (v) => {
        const o = JSON.stringify((v as { open: unknown }).open);
        const c = JSON.stringify((v as { control: unknown }).control);
        return !o.includes('web_search') && !o.includes('androidIntentOptions')
          && !c.includes('web_search') && !c.includes('androidIntentOptions');
      },
      'no web_search, no androidIntentOptions in either mode');
  }

  // SPEECH_PROVIDER_AB_GOOGLE_TTS device-validation diagnostic (2026-09-xx):
  // both modes now explicitly select com.google.android.tts and omit
  // requiresOnDeviceRecognition (mutual exclusivity with
  // androidRecognitionServicePackage in expo-speech-recognition@56.0.0's
  // native createSpeechRecognizer() -- see features.ts/recognitionModeConfig.ts
  // comments). This extends the assertions to the new intentional shape
  // rather than weakening them -- base fields (lang/interimResults/
  // continuous) and control_confirmation's contextualStrings are still
  // checked exactly as before.
  {
    const got = buildStartConfig('open');
    assert('buildStartConfig open: base fields intact, explicit Google provider, on-device flag omitted, no contextualStrings', got,
      (v) => {
        if (!v || typeof v !== 'object') return false;
        const o = v as Record<string, unknown>;
        return o.lang === 'en-US'
          && o.interimResults === false
          && o.continuous === false
          && o.androidRecognitionServicePackage === 'com.google.android.tts'
          && ('requiresOnDeviceRecognition' in o) === false
          && ('contextualStrings' in o) === false;
      },
      "{ lang: 'en-US', interimResults: false, continuous: false, androidRecognitionServicePackage: 'com.google.android.tts' } (no requiresOnDeviceRecognition, no contextualStrings)");
  }

  {
    const got = buildStartConfig('control_confirmation');
    assert('buildStartConfig control_confirmation: contextualStrings intact alongside explicit Google provider, on-device flag omitted', got,
      (v) => {
        if (!v || typeof v !== 'object') return false;
        const o = v as Record<string, unknown>;
        return JSON.stringify(o.contextualStrings) === JSON.stringify(CONTROL_CONFIRMATION_STRINGS)
          && o.lang === 'en-US'
          && o.interimResults === false
          && o.continuous === false
          && o.androidRecognitionServicePackage === 'com.google.android.tts'
          && ('requiresOnDeviceRecognition' in o) === false;
      },
      "contextualStrings === CONTROL_CONFIRMATION_STRINGS + base config intact + androidRecognitionServicePackage: 'com.google.android.tts' (no requiresOnDeviceRecognition)");
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}RecognitionModeConfig: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('recognitionModeConfig.test.ts')) {
  runRecognitionModeConfigTests().catch(console.error);
}
