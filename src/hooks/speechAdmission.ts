// Slice 7 correction — a lifecycle timer may request evaluation.
// It does not decide that the human thought is finished.

export type SpeechCompletionProposal = 'complete' | 'incomplete' | 'uncertain';

export type SpeechAdmissionTrigger =
  | 'continuation_gap'
  | 'max_turn'
  | 'max_segments'
  | 'user_stop'
  | 'control_confirmation'
  | 'recognition_error';

export type SpeechAdmissionDecision = 'hold' | 'admit' | 'recover';

export function decideSpeechAdmission(input: {
  trigger: SpeechAdmissionTrigger;
  proposal: SpeechCompletionProposal | null;
  /** True when this exact committed stitch already received its one incomplete extension. */
  extensionConsumed?: boolean;
}): SpeechAdmissionDecision {
  if (
    input.trigger === 'control_confirmation'
    || input.trigger === 'user_stop'
    || input.trigger === 'recognition_error'
    || input.trigger === 'max_turn'
    || input.trigger === 'max_segments'
  ) {
    return 'admit';
  }
  if (input.proposal === 'incomplete' && !input.extensionConsumed) return 'hold';
  return 'admit';
}

export function parseSpeechCompletionProposal(raw: unknown): SpeechCompletionProposal {
  const token = String(raw ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (token === 'complete' || token === 'incomplete' || token === 'uncertain') return token;
  return 'uncertain';
}
