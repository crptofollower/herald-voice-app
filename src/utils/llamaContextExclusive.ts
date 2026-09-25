// src/utils/llamaContextExclusive.ts
// Process-wide exclusion for callers that acquire this gate.
// Migrated semantic completion and the existing exclusive owners share one
// heldBy slot. Direct ctx.completion call sites that do not acquire this
// gate can still bypass it until a later migration slice.
// Load and canonical warmup-save nest inside an already-held classifier
// acquire — they never acquire alone.

export type LlamaContextExclusiveOwner =
  | 'classifier'
  | 'ephemeral'
  | 'probe'
  | 'session-save'
  | 'context-release'
  | 'semantic';

export type SemanticCompletionAdmission = {
  token: number;
  contextId: string;
  operation: string;
  generation: number;
};

let heldBy: LlamaContextExclusiveOwner | null = null;
let semanticAdmission: SemanticCompletionAdmission | null = null;
let semanticTokenSeq = 0;
/** When true, try-acquire fails and only context-release may wait-acquire. */
let retiring = false;
const waitQueue: Array<() => void> = [];

export function isLlamaContextBusy(): boolean {
  return heldBy !== null;
}

export function isLlamaContextRetiring(): boolean {
  return retiring;
}

/** Who currently holds the context, or null if idle. Test/diagnostics only. */
export function getLlamaContextExclusiveOwner(): LlamaContextExclusiveOwner | null {
  return heldBy;
}

function wakeWaiters(): void {
  const pending = waitQueue.splice(0);
  for (const w of pending) w();
}

function releaseHold(): void {
  heldBy = null;
  semanticAdmission = null;
  wakeWaiters();
}

/**
 * Non-queuing process-wide admission for one native completion.
 * The slot stays owned until releaseSemanticCompletion(token), not until
 * the caller stops waiting.
 */
export function tryAdmitSemanticCompletion(input: {
  contextId: string;
  operation: string;
}): { ok: true; admission: SemanticCompletionAdmission } | { ok: false; reason: 'busy' } {
  if (heldBy !== null || retiring || semanticAdmission !== null) {
    return { ok: false, reason: 'busy' };
  }
  semanticTokenSeq += 1;
  const admission: SemanticCompletionAdmission = {
    token: semanticTokenSeq,
    contextId: input.contextId,
    operation: input.operation,
    generation: semanticTokenSeq,
  };
  semanticAdmission = admission;
  heldBy = 'semantic';
  return { ok: true, admission };
}

export function getSemanticCompletionAdmission(): SemanticCompletionAdmission | null {
  return semanticAdmission;
}

/** Release only the admission identified by token. A stale token is a no-op. */
export function releaseSemanticCompletion(token: number): boolean {
  if (!semanticAdmission || semanticAdmission.token !== token) return false;
  semanticAdmission = null;
  if (heldBy === 'semantic') heldBy = null;
  wakeWaiters();
  return true;
}

export function resetSemanticCompletionAdmissionForTests(): void {
  semanticAdmission = null;
  if (heldBy === 'semantic') heldBy = null;
  wakeWaiters();
}

/**
 * Mark the live context as retiring so new try-owners cannot start.
 * Call after nulling getCtx() refs, before runExclusiveContextRelease.
 */
export function beginLlamaContextRetirement(): void {
  retiring = true;
  wakeWaiters();
}

/**
 * Wait for any current owner to finish, then run release under exclusive
 * ownership. New try work is refused while retiring. Clears retiring when done.
 */
export async function runExclusiveContextRelease(
  releaseFn: () => Promise<void>,
): Promise<void> {
  retiring = true;
  wakeWaiters();
  try {
    const gate = await withLlamaContextExclusive('context-release', 'wait', releaseFn);
    if (!gate.ok) {
      // wait mode should not return busy; still attempt release as last resort
      await releaseFn();
    }
  } finally {
    retiring = false;
    wakeWaiters();
  }
}

/**
 * Run `fn` while holding exclusive ownership of the shared LlamaContext.
 *
 * - `try`: claim synchronously or return busy (no queue). Used by user-turn
 *   classifier and ephemeral work so a user turn never waits behind another owner.
 * - `wait`: enqueue until idle (and until retirement allows this owner), then
 *   claim. Used by classifier warmup, probe, and context-release. Warmup is
 *   not a user turn.
 *
 * `heldBy` is set before any await when mode is `try`, preserving the
 * historical sync single-flight property for classify/warmup races.
 */
export async function withLlamaContextExclusive<T>(
  owner: LlamaContextExclusiveOwner,
  mode: 'try' | 'wait',
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'busy' }> {
  if (mode === 'try') {
    if (heldBy !== null || retiring) {
      return { ok: false, reason: 'busy' };
    }
    heldBy = owner;
  } else {
    while (true) {
      const mayAcquire =
        heldBy === null && (!retiring || owner === 'context-release');
      if (mayAcquire) {
        heldBy = owner;
        break;
      }
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
      });
    }
  }

  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseHold();
  }
}
