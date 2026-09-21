// scripts/heraldTest/activeTurnPresence.test.ts
// Active Turn Presence V1 — pure presentation derivation + never-blank invariant.

import {
  assertActiveTurnNeverBlank,
  deriveActiveTurnPhase,
  deriveActiveTurnPresentation,
  formerBlankFailureFacts,
  isActiveTurnVisuallyPresent,
  shouldShowProcessingIndicator,
  type ActiveTurnPresenceFacts,
} from '../../src/presentation/activeTurnPresence.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

type Case = { name: string; run: () => void };

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function base(overrides: Partial<ActiveTurnPresenceFacts> = {}): ActiveTurnPresenceFacts {
  return {
    activeTurnId: 1,
    activeUserUtterance: 'Who was I talking with?',
    turnInFlight: true,
    isWaiting: false,
    isStreaming: false,
    streamingContent: '',
    isSpeaking: false,
    userUtteranceCommittedInTranscript: false,
    assistantResponseText: null,
    terminalOutcome: 'none',
    capabilitySurfaceActive: false,
    ...overrides,
  };
}

const CASES: Case[] = [
  {
    name: 'former blank failure shape is never blank',
    run: () => {
      const facts = formerBlankFailureFacts();
      const p = assertActiveTurnNeverBlank(facts, { elapsedMs: 5000 });
      expect(p.phase === 'interpreting', `phase=${p.phase}`);
      expect(p.showUserUtterance, 'user utterance required');
      expect(isActiveTurnVisuallyPresent(p), 'visually present');
      const early = deriveActiveTurnPresentation(facts, { elapsedMs: 0, processingIndicatorThresholdMs: 200 });
      expect(early.showUserUtterance, 'utterance at elapsed 0');
      expect(!early.showProcessingIndicator, 'indicator delayed at 0');
    },
  },
  {
    name: 'slow local interpretation (no isWaiting, no stream)',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: true,
        isWaiting: false,
        isStreaming: false,
        streamingContent: '',
      }), { elapsedMs: 1000 });
      expect(p.phase === 'interpreting', `phase=${p.phase}`);
      expect(p.showUserUtterance && p.showProcessingIndicator, 'user+processing');
    },
  },
  {
    name: 'ephemeral stream before first token',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: true,
        isWaiting: false,
        isStreaming: true,
        streamingContent: '',
      }), { elapsedMs: 1000 });
      expect(p.phase === 'interpreting', `phase=${p.phase}`);
      expect(p.showUserUtterance, 'user');
      expect(p.showProcessingIndicator, 'processing');
      expect(!p.showResponseContent, 'no response yet');
    },
  },
  {
    name: 'ephemeral stream after first token',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: true,
        isWaiting: false,
        isStreaming: true,
        streamingContent: 'That sounds frustrating.',
      }));
      expect(p.phase === 'responding', `phase=${p.phase}`);
      expect(p.showResponseContent, 'response');
      expect(p.showUserUtterance, 'same exchange user still visible');
      expect(!p.showProcessingIndicator, 'no processing once content exists');
    },
  },
  {
    name: 'fast deterministic response',
    run: () => {
      const interpreting = deriveActiveTurnPresentation(base({
        turnInFlight: true,
        assistantResponseText: null,
      }), { elapsedMs: 0, processingIndicatorThresholdMs: 200 });
      expect(interpreting.phase === 'interpreting' || interpreting.phase === 'final_captured', 'pre-response phase');
      expect(interpreting.showUserUtterance, 'utterance during fast path');
      expect(!interpreting.showProcessingIndicator, 'no flicker indicator');

      const done = assertActiveTurnNeverBlank(base({
        turnInFlight: false,
        assistantResponseText: 'You were talking about Mickey.',
        userUtteranceCommittedInTranscript: true,
        terminalOutcome: 'completed',
      }));
      expect(done.phase === 'completed', `phase=${done.phase}`);
    },
  },
  {
    name: 'speaking phase when response + isSpeaking',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: true,
        assistantResponseText: 'You were talking about Mickey.',
        isSpeaking: true,
      }));
      expect(p.phase === 'speaking', `phase=${p.phase}`);
      expect(p.showResponseContent && p.showUserUtterance, 'exchange visible while speaking');
    },
  },
  {
    name: 'clarification terminal',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: false,
        assistantResponseText: "I'm not sure I'm following you — can you help me understand?",
        terminalOutcome: 'clarification',
      }));
      expect(p.phase === 'clarification', `phase=${p.phase}`);
      expect(p.showUserUtterance && p.showResponseContent, 'clarify exchange present');
    },
  },
  {
    name: 'failure terminal',
    run: () => {
      const p = assertActiveTurnNeverBlank(base({
        turnInFlight: false,
        assistantResponseText: 'Sorry — something went wrong on my end. Try that again?',
        terminalOutcome: 'failure',
      }));
      expect(p.phase === 'failure', `phase=${p.phase}`);
      expect(isActiveTurnVisuallyPresent(p), 'failure present');
    },
  },
  {
    name: 'capability card active simultaneously still never blank',
    run: () => {
      const p = assertActiveTurnNeverBlank(formerBlankFailureFacts({
        capabilitySurfaceActive: true,
      }), { elapsedMs: 800 });
      expect(p.capabilitySurfaceActive, 'card flag');
      expect(p.showUserUtterance, 'conversation presence beside card');
      expect(isActiveTurnVisuallyPresent(p), 'never blank with card');
    },
  },
  {
    name: 'consecutive turns — newer owns current',
    run: () => {
      const turn1 = deriveActiveTurnPresentation(base({
        activeTurnId: 1,
        activeUserUtterance: 'first',
        turnInFlight: false,
        terminalOutcome: 'completed',
      }));
      expect(turn1.phase === 'completed', 'turn1 completed');

      const turn2 = assertActiveTurnNeverBlank(base({
        activeTurnId: 2,
        activeUserUtterance: 'second',
        turnInFlight: true,
        isWaiting: false,
        streamingContent: '',
      }), { elapsedMs: 500 });
      expect(turn2.activeTurnId === 2, 'turn2 current');
      expect(turn2.userUtterance === 'second', 'turn2 utterance');
      expect(turn1.activeTurnId !== turn2.activeTurnId, 'ids differ');
    },
  },
  {
    name: 'stale previous turn cannot become current after newer begins',
    run: () => {
      const newer = deriveActiveTurnPhase(base({
        activeTurnId: 5,
        activeUserUtterance: 'new turn',
        turnInFlight: true,
      }));
      expect(newer === 'interpreting', 'newer interpreting');

      // Stale facts for turn 4 with released ownership must not paint as open current
      // when caller has moved activeTurnId to 5 — derivation is facts-scoped.
      const staleReleased = deriveActiveTurnPresentation(base({
        activeTurnId: null,
        activeUserUtterance: null,
        turnInFlight: false,
        terminalOutcome: 'none',
      }));
      expect(staleReleased.phase === 'idle', 'released stale is idle');
      expect(!staleReleased.showUserUtterance && !staleReleased.showProcessingIndicator, 'stale not current');
    },
  },
  {
    name: 'completed turn releases active ownership',
    run: () => {
      const p = deriveActiveTurnPresentation(base({
        turnInFlight: false,
        isWaiting: false,
        isStreaming: false,
        isSpeaking: false,
        assistantResponseText: 'Done.',
        terminalOutcome: 'completed',
      }));
      expect(p.phase === 'completed', `phase=${p.phase}`);
      expect(!p.showUserUtterance, 'utterance released for fade');
      expect(!p.showProcessingIndicator, 'no processing');
      expect(isActiveTurnVisuallyPresent(p), 'completed allowed to fade');
    },
  },
  {
    name: 'processing indicator threshold',
    run: () => {
      expect(!shouldShowProcessingIndicator('interpreting', 0, 200), 'delay');
      expect(shouldShowProcessingIndicator('interpreting', 200, 200), 'at threshold');
      expect(!shouldShowProcessingIndicator('responding', 999, 200), 'not interpreting');
    },
  },
  {
    name: 'never-blank invariant suite over key combinations',
    run: () => {
      const shapes: ActiveTurnPresenceFacts[] = [
        formerBlankFailureFacts(),
        formerBlankFailureFacts({ isStreaming: true }),
        formerBlankFailureFacts({ isWaiting: true, turnInFlight: false }),
        base({ assistantResponseText: 'Hello', turnInFlight: true }),
        base({ streamingContent: 'Hi', isStreaming: true, isWaiting: false }),
        base({ terminalOutcome: 'clarification', assistantResponseText: 'Clarify?', turnInFlight: false }),
        base({ terminalOutcome: 'failure', assistantResponseText: 'Fail', turnInFlight: false }),
        base({ capabilitySurfaceActive: true, turnInFlight: true }),
      ];
      for (const facts of shapes) {
        assertActiveTurnNeverBlank(facts, { elapsedMs: 0 });
        assertActiveTurnNeverBlank(facts, { elapsedMs: 5000 });
      }
    },
  },
];

export async function runActiveTurnPresenceTests(): Promise<{ passed: number; failed: number; total: number }> {
  let passed = 0;
  let failed = 0;
  const total = CASES.length;
  console.log(`\n${BOLD}Active Turn Presence V1${RESET}`);
  for (const c of CASES) {
    try {
      c.run();
      passed += 1;
      console.log(`${GREEN}PASS${RESET} ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`${RED}FAIL${RESET} ${c.name}`);
      console.log(`${DIM}${e instanceof Error ? e.message : String(e)}${RESET}`);
    }
  }
  console.log(`${DIM}${passed} passed, ${failed} failed${RESET}`);
  return { passed, failed, total };
}

