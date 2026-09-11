// Engine-neutral conversational capability socket.
// Herald conversation talks to ConversationalWorker, never to a vendor runtime.
// Adapters (llama.rn, future native engines) live outside this module.
// Zero memory / write / read / action authority — generate text only.

import type { HotRingEntry } from '../utils/hotNarrativeRing';
import type { EphemeralResult } from '../utils/ephemeralConversation';
import type { VerifiedConversationalPacket } from './verifiedConversationalPacket';
import {
  logConversationInferenceEnd,
  logConversationInferenceStart,
  mono as latMono,
} from '../utils/latencyInstrument';

export type ConversationUnavailableReason =
  | 'no-ctx'
  | 'busy'
  | 'empty-output'
  | 'error';

export type ConversationRequest = {
  userText: string;
  hotEntries: HotRingEntry[];
  onPartial?: (accumulatedText: string) => void;
  /** Per-turn labeled facts/evidence. Generation-only; never a write source. */
  packet?: VerifiedConversationalPacket;
};

export type ConversationResponse =
  | { status: 'ok'; replyText: string; completionResult?: unknown }
  | { status: 'unavailable'; reason: ConversationUnavailableReason; completionResult?: unknown };

export type ConversationalWorker = {
  /** Stable engine-neutral capability id — not a vendor/runtime name. */
  id: string;
  isAvailable(): boolean;
  generate(request: ConversationRequest): Promise<ConversationResponse>;
};

/** First available worker in registration order. None qualifying → null. */
export function selectConversationalWorker(
  workers: ConversationalWorker[],
): ConversationalWorker | null {
  for (const worker of workers) {
    if (worker.isAvailable()) return worker;
  }
  return null;
}

export function workerResponseToEphemeralResult(
  response: ConversationResponse,
): EphemeralResult {
  if (response.status === 'ok') {
    return { status: 'ok', text: response.replyText };
  }
  return { status: 'unavailable', reason: response.reason };
}

export async function generateViaSelectedWorker(
  worker: ConversationalWorker | null,
  request: ConversationRequest,
): Promise<EphemeralResult> {
  if (!worker) return { status: 'unavailable', reason: 'no-ctx' };
  const t0 = latMono();
  logConversationInferenceStart(worker.id);
  try {
    const response = await worker.generate(request);
    logConversationInferenceEnd(
      latMono() - t0,
      response.completionResult,
      response.status === 'ok' ? 'ok' : 'unavailable',
      worker.id,
    );
    return workerResponseToEphemeralResult(response);
  } catch (e) {
    logConversationInferenceEnd(latMono() - t0, undefined, 'error', worker.id);
    throw e;
  }
}
