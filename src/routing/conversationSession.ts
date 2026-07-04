import type { CommitResult } from './routeIntent';

// D0 (S54 addendum): headless conversation state, owned by the routing layer.
// Commit 1 scope: single pending slot ONLY. Semantics are deliberately identical
// to the old ChatScreen pendingResumeRef (including known Hazard E behavior) —
// defect fixes land in S-CONFIRM with RED P-tests first. Do not "improve" here.
export type PendingSlot = {
  pendingKey: string;
  resume: (userText: string) => Promise<CommitResult>;
};

export class ConversationSession {
  private pending: PendingSlot | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  setPending(slot: PendingSlot): void {
    this.pending = slot;
  }

  /** Removes and returns the pending slot (old take-then-clear semantics). */
  takePending(): PendingSlot | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  clearPending(): void {
    this.pending = null;
  }
}
