import type { CommitResult } from '../routing/routeIntent';

export interface CommitEffectDeps {
  openURL: (url: string) => Promise<void>;
  handleMapsAction: (query: string) => Promise<void>;
  onEffectFailure: (failAck: string) => void;
}

// runCommitEffects: executes the device action attached to any committed
// CommitResult, if present. Pure — no writer emits .effect yet (starts in
// S_CONTACT C-3); with none doing so today, this is a guaranteed no-op.
// ACK-matches-commit holds: the memory write already happened before this
// runs. On device failure, onEffectFailure is the caller's chance to speak
// the writer's failAck as a correction — it never un-says what was
// already spoken.
export async function runCommitEffects(
  commits: CommitResult[] | undefined,
  deps: CommitEffectDeps,
): Promise<void> {
  if (!commits || commits.length === 0) return;
  for (const result of commits) {
    if (result.status !== 'committed' || !result.effect) continue;
    const effect = result.effect;
    try {
      if (effect.kind === 'dial') {
        await deps.openURL(`tel:${effect.phone.replace(/\D/g, '')}`);
      } else if (effect.kind === 'sms') {
        const url = `sms:${effect.phone.replace(/\D/g, '')}${effect.body ? `?body=${encodeURIComponent(effect.body)}` : ''}`;
        await deps.openURL(url);
      } else if (effect.kind === 'navigate') {
        await deps.handleMapsAction(effect.address);
      }
    } catch {
      deps.onEffectFailure(effect.failAck);
    }
  }
}
