// Natural Speech Turn Boundary V1 — pure machine. Not Android provider timing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  OPEN_SPEECH_CONTINUATION_GAP_MS,
  OPEN_SPEECH_MAX_SEGMENTS,
  OPEN_SPEECH_MAX_TURN_MS,
  applyReopenedNativeSession,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  resetOpenSpeechTurnIdsForTests,
  stitchOpenSpeechSegments,
  type OpenSpeechEffect,
  type OpenSpeechEvent,
  type OpenSpeechTurnState,
} from '../../src/hooks/openSpeechTurnBoundary.ts';
import { buildStartConfig } from '../../src/hooks/recognitionModeConfig.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseProductionUseMic(): { parseErrorCount: number; messages: string[] } {
  const fileName = path.join(root, 'src/hooks/useMic.ts');
  const text = fs.readFileSync(fileName, 'utf8');
  const result = ts.transpileModule(text, {
    fileName: 'useMic.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const diags = result.diagnostics ?? [];
  return {
    parseErrorCount: diags.length,
    messages: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  };
}

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function drive(events: OpenSpeechEvent[]): {
  state: OpenSpeechTurnState;
  deliveries: string[];
  effects: OpenSpeechEffect[];
  reopenCount: number;
} {
  let state = createIdleOpenSpeechTurnState();
  const deliveries: string[] = [];
  const effects: OpenSpeechEffect[] = [];
  let reopenCount = 0;
  for (const event of events) {
    const out = reduceOpenSpeechTurn(state, event);
    state = out.state;
    for (const fx of out.effects) {
      effects.push(fx);
      if (fx.type === 'deliver') deliveries.push(fx.utterance);
      if (fx.type === 'reopen_native') {
        reopenCount += 1;
        const nextId = state.nativeSessionId + 1;
        state = applyReopenedNativeSession(state, nextId);
      }
    }
  }
  return { state, deliveries, effects, reopenCount };
}

function completeAdmission(text: string, trigger: 'continuation_gap' | 'max_turn' | 'max_segments' = 'continuation_gap'): OpenSpeechEvent {
  return { type: 'admission_evaluated', trigger, proposal: 'complete', text };
}

export async function runOpenSpeechTurnBoundaryV1Tests() {
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

  console.log(`\n${BOLD}-- Natural Speech Turn Boundary V1 --------------------------${RESET}\n`);
  resetOpenSpeechTurnIdsForTests();

  assert('named continuation gap / max turn / max segments are explicit and provisional',
    OPEN_SPEECH_CONTINUATION_GAP_MS === 1200
      && OPEN_SPEECH_MAX_TURN_MS === 20_000
      && OPEN_SPEECH_MAX_SEGMENTS === 5,
    (v) => v === true, '1200ms / 20000ms / 5');

  assert('provider start config remains continuous:false',
    buildStartConfig('open').continuous === false
      && buildStartConfig('control_confirmation').continuous === false,
    (v) => v === true, 'continuous:false both modes');

  assert('stitch joins segments without rewriting content',
    stitchOpenSpeechSegments(['When I was a kid', 'we spent summers at the lake.'])
      === 'When I was a kid we spent summers at the lake.',
    (v) => v === true, 'space-join only');

  {
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Hello there.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 400 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 450 },
      { type: 'continuation_gap_elapsed', generation: 1 },
      completeAdmission('Hello there.'),
    ]);
    assert('open: one short utterance → one final delivery',
      run.deliveries.length === 1
        && run.deliveries[0] === 'Hello there.'
        && run.state.delivered === true
        && run.state.phase === 'finalized'
        && run.effects.some((e) => e.type === 'evaluate_admission'),
      (v) => v === true, 'one delivery after complete admission');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid,' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 300 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 320 },
      { type: 'native_result_final', nativeSessionId: 2, text: 'we spent summers at the lake.' },
      { type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: '', nowMs: 900 },
      { type: 'native_listening_ready', nativeSessionId: 3, nowMs: 920 },
      { type: 'continuation_gap_elapsed', generation: 2 },
      completeAdmission('When I was a kid, we spent summers at the lake.'),
    ]);
    assert('open: clause → native end → continuation clause → one stitched delivery',
      run.deliveries.length === 1
        && run.deliveries[0] === 'When I was a kid, we spent summers at the lake.'
        && run.reopenCount === 2,
      (v) => v === true, 'one stitch');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'One' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 100 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 110 },
      { type: 'native_result_final', nativeSessionId: 2, text: 'two' },
      { type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'native_listening_ready', nativeSessionId: 3, nowMs: 210 },
      { type: 'native_result_final', nativeSessionId: 3, text: 'three' },
      { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 300 },
      { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 310 },
      { type: 'continuation_gap_elapsed', generation: 3 },
      completeAdmission('One two three'),
    ]);
    assert('open: three segments → one delivery',
      run.deliveries.length === 1 && run.deliveries[0] === 'One two three',
      (v) => v === true, 'One two three');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'There was a lake.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'native_end', nativeSessionId: 2, speechStarted: false, partial: '', nowMs: 500 },
    ]);
    assert('segment → provider end → reopen → empty continuation end while budget remains → zero delivery',
      run.deliveries.length === 0
        && run.reopenCount === 2
        && !run.effects.some((e) => e.type === 'deliver')
        && run.state.phase !== 'finalized',
      (v) => v === true, 'empty continuation does not finalize');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'There was a lake.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'native_end', nativeSessionId: 2, speechStarted: false, partial: '', nowMs: 500 },
      { type: 'native_listening_ready', nativeSessionId: 3, nowMs: 520 },
      { type: 'native_result_final', nativeSessionId: 3, text: 'We packed sandwiches.' },
      { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 900 },
      { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 920 },
      { type: 'continuation_gap_elapsed', generation: 2 },
      completeAdmission('There was a lake. We packed sandwiches.'),
    ]);
    assert('empty continuation then speech resumes → eventual one stitched delivery',
      run.deliveries.length === 1
        && run.deliveries[0] === 'There was a lake. We packed sandwiches.',
      (v) => v === true, 'resume stitch');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'We packed sandwiches.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 220 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('open: provisional end → continuation gap does not admit',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'evaluate_admission' && e.trigger === 'continuation_gap')
        && run.state.phase !== 'finalized',
      (v) => v === true, 'gap evaluates, does not deliver');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'control_confirmation', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'No.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 80 },
    ]);
    assert('control_confirmation "No." → immediate existing behavior',
      run.deliveries.length === 1
        && run.deliveries[0] === 'No.'
        && run.reopenCount === 0
        && !run.effects.some((e) => e.type === 'arm_continuation_gap'),
      (v) => v === true, 'immediate, no stitch window');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'control_confirmation', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Mom.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 90 },
    ]);
    assert('control_confirmation short name/value → existing behavior',
      run.deliveries.length === 1
        && run.deliveries[0] === 'Mom.'
        && run.reopenCount === 0,
      (v) => v === true, 'Mom. immediate');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'user_stop' },
      { type: 'native_result_final', nativeSessionId: 2, text: 'stale after cancel' },
      { type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: '', nowMs: 800 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('cancel during continuation → no stale second delivery',
      run.deliveries.length === 1 && run.deliveries[0] === 'When I was a kid',
      (v) => v === true, 'exactly one after cancel');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'There was a lake' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'tts_preempt' },
      { type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: 'ignored', nowMs: 400 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('TTS preemption → no stale second delivery',
      run.deliveries.length === 0 && run.state.phase === 'abandoned',
      (v) => v === true, 'abandon, zero deliver');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'We packed sandwiches' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'recognition_error', nativeSessionId: 2 },
      { type: 'native_end', nativeSessionId: 2, speechStarted: false, partial: '', nowMs: 250 },
    ]);
    assert('continuation error → deterministic safe terminal behavior',
      run.deliveries.length === 1
        && run.deliveries[0] === 'We packed sandwiches'
        && run.effects.some((e) => e.type === 'deliver' && e.source === 'continuation_error'),
      (v) => v === true, 'finalize existing stitch on error');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const events: OpenSpeechEvent[] = [
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    ];
    for (let i = 0; i < OPEN_SPEECH_MAX_SEGMENTS; i++) {
      const sid = i + 1;
      events.push({ type: 'native_result_final', nativeSessionId: sid, text: `seg${sid}` });
      events.push({ type: 'native_end', nativeSessionId: sid, speechStarted: true, partial: '', nowMs: 100 * (i + 1) });
    }
    const run = drive(events);
    assert('max-segment cap → exactly one delivery',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'evaluate_admission' && e.trigger === 'max_segments')
        && run.reopenCount === OPEN_SPEECH_MAX_SEGMENTS - 1,
      (v) => v === true, 'cap requests admission');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Long story' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: OPEN_SPEECH_MAX_TURN_MS },
    ]);
    assert('max-turn cap → exactly one delivery',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'evaluate_admission' && e.trigger === 'max_turn'),
      (v) => v === true, 'max turn requests admission');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Keep this' },
      { type: 'native_result_final', nativeSessionId: 99, text: 'STALE CONTAMINATION' },
      { type: 'native_end', nativeSessionId: 99, speechStarted: true, partial: 'also stale', nowMs: 100 },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 220 },
      { type: 'continuation_gap_elapsed', generation: 1 },
      completeAdmission('Keep this'),
    ]);
    assert('stale callback from prior native session cannot contaminate the current Herald turn',
      run.deliveries.length === 1
        && run.deliveries[0] === 'Keep this'
        && !run.deliveries[0].includes('STALE'),
      (v) => v === true, 'stale ignored');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const first = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'First turn' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 100 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 120 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    const second = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 5000 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Second turn' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 5200 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 5220 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('never stitch across genuinely separate Herald turns',
      first.deliveries.length === 0
        && second.deliveries.length === 0
        && first.state.segments.join(' ') === 'First turn'
        && second.state.segments.join(' ') === 'Second turn'
        && first.state.heraldTurnId !== second.state.heraldTurnId,
      (v) => v === true, 'separate turns');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_end', nativeSessionId: 1, speechStarted: false, partial: '', nowMs: 50 },
    ]);
    assert('native end empty with no segments → no invented transcript',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'no_recognizable_speech' && e.reason === 'silence'),
      (v) => v === true, 'silence');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'user_stop' },
    ]);
    assert('explicit user stop + existing segment → exactly one delivery',
      run.deliveries.length === 1
        && run.deliveries[0] === 'When I was a kid'
        && run.effects.some((e) => e.type === 'deliver' && e.source === 'user_stop'),
      (v) => v === true, 'user_stop finalizes once');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'automated_teardown' },
    ]);
    assert('automated empty-session recovery + existing segment → zero delivery',
      run.deliveries.length === 0
        && run.state.phase === 'abandoned'
        && !run.effects.some((e) => e.type === 'deliver'),
      (v) => v === true, 'automated_teardown abandons');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'automated_teardown' },
      { type: 'native_result_final', nativeSessionId: 2, text: 'must not submit' },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('automated safety timeout + existing segment → zero delivery',
      run.deliveries.length === 0 && run.state.phase === 'abandoned',
      (v) => v === true, 'safety timeout abandons');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    let state = createIdleOpenSpeechTurnState();
    const deliveries: string[] = [];
    const apply = (event: OpenSpeechEvent) => {
      const out = reduceOpenSpeechTurn(state, event);
      state = out.state;
      for (const fx of out.effects) {
        if (fx.type === 'deliver') deliveries.push(fx.utterance);
        if (fx.type === 'reopen_native') {
          state = applyReopenedNativeSession(state, state.nativeSessionId + 1);
        }
      }
      return out.effects;
    };
    apply({ type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 });
    apply({ type: 'native_result_final', nativeSessionId: 1, text: 'When I was a kid,' });
    const afterEnd = apply({ type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 300 });
    const afterReady = apply({ type: 'native_listening_ready', nativeSessionId: 2, nowMs: 320 });
    const armedGen = afterReady.find((e) => e.type === 'arm_continuation_gap')?.generation;
    apply({ type: 'speechstart', nativeSessionId: 2 });
    const staleGapEffects = apply({ type: 'continuation_gap_elapsed', generation: armedGen ?? 1 });
    assert('continuation speechstart invalidates/neutralizes the old continuation-gap terminal path',
      deliveries.length === 0
        && !afterEnd.some((e) => e.type === 'arm_continuation_gap')
        && !staleGapEffects.some((e) => e.type === 'deliver')
        && !staleGapEffects.some((e) => e.type === 'abort_native')
        && state.phase === 'listening'
        && state.speechInProgress === true
        && armedGen === 1,
      (v) => v === true, 'stale gap no-op while speaking');

    apply({ type: 'native_result_final', nativeSessionId: 2, text: 'we spent summers at the lake.' });
    apply({ type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: '', nowMs: 900 });
    apply({ type: 'native_listening_ready', nativeSessionId: 3, nowMs: 920 });
    apply({ type: 'continuation_gap_elapsed', generation: state.continuationGeneration });
    apply(completeAdmission('When I was a kid, we spent summers at the lake.'));
    assert('continuation native end later produces exactly one stitched delivery',
      deliveries.length === 1
        && deliveries[0] === 'When I was a kid, we spent summers at the lake.',
      (v) => v === true, 'one stitch after live continuation ends');
  }

  {
    const parsed = parseProductionUseMic();
    const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
    const errorIdx = micSrc.indexOf("useSpeechRecognitionEvent('error'");
    const endIdx = micSrc.indexOf("useSpeechRecognitionEvent('end'");
    const errorBlock = errorIdx >= 0 && endIdx > errorIdx ? micSrc.slice(errorIdx, endIdx) : '';
    assert('production useMic.ts parses/compiles through an appropriate real source check',
      parsed.parseErrorCount === 0
        && errorBlock.includes("useSpeechRecognitionEvent('error'")
        && /\}\);\s*$/.test(errorBlock.trim())
        && endIdx > errorIdx,
      (v) => v === true,
      parsed.parseErrorCount === 0
        ? 'parse ok and error handler closed before end'
        : parsed.messages.join('; '));
  }

  {
    const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
    const stopBlock = micSrc.match(/const stopRecording = useCallback\(async \(\) => \{[\s\S]*?\}, \[onTranscript\]\);/)?.[0] ?? '';
    const emptyFired = micSrc.slice(
      micSrc.indexOf("log('EMPTY_SESSION_RECOVERY_FIRED')"),
      micSrc.indexOf("log('EMPTY_SESSION_RECOVERY_FIRED')") + 180,
    );
    assert('useMic wiring: Talk user_stop vs automated teardown call sites',
      stopBlock.includes("type: 'user_stop'")
        && !stopBlock.includes("type: 'automated_teardown'")
        && /abandonRecordingForAutomatedTeardown\(\)/.test(emptyFired)
        && micSrc.includes('setTimeout(() => abandonRecordingForAutomatedTeardown(), 30000)')
        && /const abandonRecordingForAutomatedTeardown = \(\) => \{[\s\S]*type: 'automated_teardown'/.test(micSrc)
        && !/EMPTY_SESSION_RECOVERY_FIRED[\s\S]{0,80}stopRecording\(\)/.test(micSrc)
        && !/setTimeout\(\(\) => stopRecording\(\), 30000\)/.test(micSrc),
      (v) => v === true, 'user_stop vs automated_teardown wired');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'There was a lake.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
      { type: 'no_speech_error', nativeSessionId: 2 },
    ]);
    assert('continuation no-speech while budget remains → zero delivery',
      run.deliveries.length === 0 && run.state.delivered === false,
      (v) => v === true, 'no_speech does not finalize continuation');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    let state = createIdleOpenSpeechTurnState();
    const apply = (event: OpenSpeechEvent) => {
      const out = reduceOpenSpeechTurn(state, event);
      state = out.state;
      for (const fx of out.effects) {
        if (fx.type === 'reopen_native') {
          state = applyReopenedNativeSession(state, state.nativeSessionId + 1);
        }
      }
      return out.effects;
    };
    apply({ type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 });
    apply({ type: 'native_result_final', nativeSessionId: 1, text: 'Hello there.' });
    const endFx = apply({ type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 100 });
    const readyFx = apply({ type: 'native_listening_ready', nativeSessionId: 2, nowMs: 800 });
    assert('continuation budget starts from listening-ready, not previous native end',
      endFx.some((e) => e.type === 'reopen_native')
        && !endFx.some((e) => e.type === 'arm_continuation_gap')
        && readyFx.some((e) => e.type === 'arm_continuation_gap' && e.generation === 1),
      (v) => v === true, 'arm gap only on ready');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Hello there.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 0 },
      { type: 'continuation_gap_elapsed', generation: 1 },
      { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 5000 },
      { type: 'continuation_gap_elapsed', generation: 1 },
    ]);
    assert('delayed native-ready does not consume the user 1200ms continuation opportunity',
      run.deliveries.length === 0
        && run.effects.filter((e) => e.type === 'evaluate_admission').length === 1,
      (v) => v === true, 'pre-ready gap is a no-op; post-ready gap evaluates once');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const events: OpenSpeechEvent[] = [
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Hello there.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 50 },
    ];
    for (let i = 0; i < OPEN_SPEECH_MAX_SEGMENTS; i++) {
      events.push({
        type: 'native_end',
        nativeSessionId: i + 2,
        speechStarted: false,
        partial: '',
        nowMs: 100 * (i + 1),
      });
    }
    const run = drive(events);
    assert('max-segment cap bounds repeated empty continuation sessions',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'evaluate_admission' && e.trigger === 'max_segments' && e.text === 'Hello there.'),
      (v) => v === true, 'empty loop capped');
  }

  {
    resetOpenSpeechTurnIdsForTests();
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Hello there.' },
      { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 10 },
      { type: 'native_end', nativeSessionId: 2, speechStarted: false, partial: '', nowMs: OPEN_SPEECH_MAX_TURN_MS },
    ]);
    assert('max-turn cap bounds repeated empty continuation sessions',
      run.deliveries.length === 0
        && run.effects.some((e) => e.type === 'evaluate_admission' && e.trigger === 'max_turn' && e.text === 'Hello there.'),
      (v) => v === true, 'empty loop max-turn');
  }

  {
    const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
    const invSrc = fs.readFileSync(path.join(root, 'src/hooks/speechLifecycleInvariants.ts'), 'utf8');
    const hostSrc = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');
    assert('device evidence is bounded diagnostic peek without transcripts',
      invSrc.includes('peekOpenSpeechTurnDeviceEvidence')
        && invSrc.includes('noteOpenSpeechTurnDeviceEvidence')
        && !/noteOpenSpeechTurnDeviceEvidence[\s\S]{0,400}transcript/.test(invSrc)
        && micSrc.includes('OPEN_SPEECH_NATIVE_END')
        && micSrc.includes('native_listening_ready')
        && hostSrc.includes('openSpeechTurn: peekOpenSpeechTurnDeviceEvidence()'),
      (v) => v === true, 'journey peek + ring events, no transcript store');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}OpenSpeechTurnBoundaryV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && process.argv[1].includes('openSpeechTurnBoundary')) {
  runOpenSpeechTurnBoundaryV1Tests().then((r) => process.exit(r.failed ? 1 : 0));
}
