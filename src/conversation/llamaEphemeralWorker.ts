// Llama.rn adapter for the ConversationalWorker socket.
// Vendor/runtime types stay in this file. Herald-facing code imports
// ConversationalWorker, not LlamaContext, for conversation.

import type { LlamaContext } from 'llama.rn';
import { LOCAL_LLM_ENABLED } from '../constants/features';
import { generateEphemeralConversation } from '../utils/ephemeralConversation';
import { formatVerifiedConversationalPacket } from './verifiedConversationalPacket';
import type {
  ConversationalWorker,
  ConversationRequest,
  ConversationResponse,
} from './conversationalWorker';

export function createLlamaEphemeralWorker(deps: {
  getCtx: () => LlamaContext | null;
}): ConversationalWorker {
  return {
    id: 'on-device-conversation',
    isAvailable(): boolean {
      if (!LOCAL_LLM_ENABLED) return false;
      return deps.getCtx() != null;
    },
    async generate(request: ConversationRequest): Promise<ConversationResponse> {
      if (!LOCAL_LLM_ENABLED) {
        return { status: 'unavailable', reason: 'no-ctx' };
      }
      const packetText = request.packet
        ? formatVerifiedConversationalPacket(request.packet)
        : undefined;
      const result = await generateEphemeralConversation(
        request.userText,
        deps.getCtx(),
        request.hotEntries,
        request.onPartial,
        packetText,
      );
      if (result.status === 'ok') {
        return { status: 'ok', replyText: result.text };
      }
      return { status: 'unavailable', reason: result.reason };
    },
  };
}
