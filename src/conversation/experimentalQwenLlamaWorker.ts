// Independent Qwen ConversationalWorker adapter.
// Vendor/runtime types stay here. Does not read LOCAL_LLM_ENABLED (retired
// classifier flag stays false; this engine owns its own ctx).
// Zero memory/write/action API. Presentation sanitation stays in this adapter.

import type { LlamaContext } from 'llama.rn';
import { CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED } from '../constants/features';
import type { HotRingEntry } from '../utils/hotNarrativeRing';
import type {
  ConversationalWorker,
  ConversationRequest,
  ConversationResponse,
} from './conversationalWorker';
import { sanitizeConversationalPresentation } from './conversationalPresentation';

/** Snapshot of Herald ephemeral persona — copied, not imported, so this
 *  adapter cannot drag production generation into the engine. */
export const EXPERIMENTAL_QWEN_SYSTEM_PROMPT = `You are Herald, a warm and knowledgeable personal companion -- a friend, not a professional.
Respond naturally and briefly to what the person says, usually in one or two sentences.
Be interested without being needy -- do not ask a question after every statement. Sometimes simple acknowledgment is enough.
Do not invent facts about the person. Do not claim to remember, save, or have stored anything -- you have no memory authority here.
Do not claim to have performed an action, made a call, sent a message, or changed anything.
Do not diagnose medical conditions, provide financial recommendations, or claim professional (medical, mental-health, financial, legal) authority. If the person asks for that kind of judgment directly, state the limit naturally in one sentence and keep the conversation going -- never end the exchange with a disclaimer alone.`;

export const EXPERIMENTAL_QWEN_GENERATION = {
  n_predict: 128,
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  jinja: true,
  enable_thinking: false,
  thinking_forced_open: false,
  reasoning_format: 'none' as const,
  chat_template_kwargs: { enable_thinking: false },
};

export const EXPERIMENTAL_QWEN_INIT = {
  n_ctx: 2048,
  n_gpu_layers: 0,
};

function buildMessages(
  userText: string,
  hotEntries: HotRingEntry[],
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: EXPERIMENTAL_QWEN_SYSTEM_PROMPT },
  ];
  for (const e of hotEntries) {
    messages.push({ role: 'user', content: e.user });
    if (e.assistantHotPolicy === 'include') {
      messages.push({ role: 'assistant', content: e.assistant });
    }
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

export function createExperimentalQwenLlamaWorker(deps: {
  getCtx: () => LlamaContext | null;
  /** Test seam — production omits this and uses the feature flag. */
  enabled?: boolean;
}): ConversationalWorker {
  const enabled = () => deps.enabled ?? CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED;
  return {
    id: 'experimental-on-device-conversation',
    isAvailable(): boolean {
      if (!enabled()) return false;
      return deps.getCtx() != null;
    },
    async generate(request: ConversationRequest): Promise<ConversationResponse> {
      if (!enabled()) return { status: 'unavailable', reason: 'no-ctx' };
      const ctx = deps.getCtx();
      if (!ctx) return { status: 'unavailable', reason: 'no-ctx' };

      try {
        const result = await ctx.completion(
          {
            messages: buildMessages(request.userText, request.hotEntries),
            ...EXPERIMENTAL_QWEN_GENERATION,
          },
          (data) => {
            const d = data as {
              accumulated_text?: string;
              content?: string;
              token?: string;
            };
            const accumulated =
              (typeof d.accumulated_text === 'string' && d.accumulated_text) ||
              (typeof d.content === 'string' && d.content) ||
              (typeof d.token === 'string' && d.token) ||
              '';
            if (!accumulated.trim()) return;
            request.onPartial?.(sanitizeConversationalPresentation(accumulated).text);
          },
        );
        const raw = (result?.content || result?.text || '').trim();
        const presented = sanitizeConversationalPresentation(raw);
        if (!presented.text) return { status: 'unavailable', reason: 'empty-output' };
        return { status: 'ok', replyText: presented.text };
      } catch {
        return { status: 'unavailable', reason: 'error' };
      }
    },
  };
}
