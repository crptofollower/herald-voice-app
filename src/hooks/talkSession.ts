// TalkSession Continuity V1 — Phase A.
// Answers only: are Mike and Kit in an active conversational exchange?
// Does not own STT, TTS, interpretation, routing, or memory.

export const TALK_SESSION_FOLLOWUP_DELAY_MS = 1400;

export type TalkSessionPhase = 'idle' | 'active' | 'followup';

export type TalkSessionFollowupFireContext = {
  ttsSpeaking: boolean;
  streaming: boolean;
  appActive: boolean;
};

export type TalkSession = {
  readonly generation: number;
  readonly phase: TalkSessionPhase;
  readonly pendingFollowupGeneration: number | null;
  activateFromManualTap: () => number;
  terminate: () => number;
  noteTtsTerminal: () => { schedule: boolean; generation: number };
  evaluateFollowupFire: (
    token: number,
    ctx: TalkSessionFollowupFireContext,
  ) => { shouldStart: boolean };
  noteContentfulUtterance: () => void;
  noteFollowupSilence: () => { ended: boolean };
};

export function createTalkSession(): TalkSession {
  let generation = 0;
  let phase: TalkSessionPhase = 'idle';
  let pendingFollowupGeneration: number | null = null;
  let followupListenArmed = false;

  function bumpGeneration() {
    generation += 1;
    pendingFollowupGeneration = null;
    followupListenArmed = false;
  }

  const session: TalkSession = {
    get generation() {
      return generation;
    },
    get phase() {
      return phase;
    },
    get pendingFollowupGeneration() {
      return pendingFollowupGeneration;
    },
    activateFromManualTap() {
      bumpGeneration();
      phase = 'active';
      return generation;
    },
    terminate() {
      bumpGeneration();
      phase = 'idle';
      return generation;
    },
    noteTtsTerminal() {
      if (phase !== 'active') return { schedule: false, generation };
      if (pendingFollowupGeneration !== null) return { schedule: false, generation };
      pendingFollowupGeneration = generation;
      phase = 'followup';
      return { schedule: true, generation };
    },
    evaluateFollowupFire(token, ctx) {
      if (token !== generation || pendingFollowupGeneration !== token || phase !== 'followup') {
        return { shouldStart: false };
      }
      if (!ctx.appActive) {
        bumpGeneration();
        phase = 'idle';
        return { shouldStart: false };
      }
      if (ctx.ttsSpeaking || ctx.streaming) {
        return { shouldStart: false };
      }
      pendingFollowupGeneration = null;
      followupListenArmed = true;
      return { shouldStart: true };
    },
    noteContentfulUtterance() {
      if (phase === 'idle') return;
      followupListenArmed = false;
      pendingFollowupGeneration = null;
      phase = 'active';
    },
    noteFollowupSilence() {
      if (phase !== 'followup' && !followupListenArmed) return { ended: false };
      bumpGeneration();
      phase = 'idle';
      return { ended: true };
    },
  };
  return session;
}
