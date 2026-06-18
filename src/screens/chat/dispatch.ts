// src/screens/chat/dispatch.ts
//
// Dispatch layer for Herald's send path. Extracted from ChatScreen.tsx so the
// per-intent read/action handlers live in one testable module instead of inside
// a 3700-line component. Handlers receive their dependencies explicitly via
// DispatchDeps — no component-scope closure capture, no temporal-dead-zone hazard.
//
// Stage 1.2: skeleton only. Signatures defined, bodies not yet moved. Nothing
// imports this file yet. Subsequent stages (1.3 reads, 1.4 actions) fill the bodies.

import type { MutableRefObject } from 'react';
import type { Message } from '../../api/herald';
import type { TierDecision } from '../../routing/tierRouter';
import { phraseWithLLM } from '../../hooks/llmLayers';

// Pending-confirmation refs the dispatch handlers set so the NEXT user turn can
// resolve them (collect a phone number, confirm a medication, etc.).
export interface DispatchPendingRefs {
  pendingContactCollectRef: MutableRefObject<{ action: 'call' | 'navigate' | 'text' | 'confirm_phone'; name: string; body?: string } | null>;
  pendingMedConfirmRef: MutableRefObject<{ category: 'medication' | 'medical' | 'visit'; value: string; guessedName: string } | null>;
  pendingMedClearRef: MutableRefObject<{ count: number } | null>;
  pendingTodoCompleteRef: MutableRefObject<{ id: string; body: string } | null>;
}

// Everything the dispatch handlers need from the component, passed explicitly.
export interface DispatchDeps extends DispatchPendingRefs {
  addMessage: (m: Message) => void;
  speak: (text: string, opts?: { rate?: number }) => void;
  setInputText: (s: string) => void;
  sendingRef: MutableRefObject<boolean>;
  generateId: (prefix: string) => string;
  llmStatus: string;
  getCtx: () => string;
  inferLocal: (prompt: string, maxTokens: number) => Promise<string | null>;
  phraseWithLLM: typeof phraseWithLLM;
  resolveContactPhone: (nameOrRelation: string) => Promise<{ phone: string; name: string; contactId?: string } | null>;
  handleCalendarAction: (value: string) => Promise<void>;
  handleMapsAction: (query: string) => Promise<void>;
  launchAndroidTimer: (seconds: number) => Promise<boolean>;
  handleLaunchActionRef: MutableRefObject<((appName: string) => Promise<void>) | null>;
}

// Tier-1 READ dispatch (calendar/medical/family/profile). Filled in Stage 1.3.
// isMedical reads are spoken verbatim — NEVER wrapped by the LLM (CLAUDE.md).
export async function dispatchRead(
  _response: string,
  _llmWrap: boolean,
  _isMedical: boolean,
  _text: string,
  _deps: DispatchDeps,
): Promise<void> {
  throw new Error('dispatchRead not yet implemented (Stage 1.3)');
}

// Tier-1 ACTION dispatch (alarm/timer/sms/calendar/medical/call/nav/reminder/
// note/list/todo/...). Filled in Stage 1.4.
export async function dispatchAction(
  _actionIntent: NonNullable<TierDecision['actionIntent']>,
  _text: string,
  _deps: DispatchDeps,
): Promise<void> {
  throw new Error('dispatchAction not yet implemented (Stage 1.4)');
}
