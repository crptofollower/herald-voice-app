// Closed Track-R admission dispositions. Labels only — never facts.

export const REMINISCENCE_DISPOSITIONS = [
  'AUTOBIOGRAPHICAL',
  'CONTINUE_ARC',
  'TRANSIENT',
  'SENSITIVE',
  'THIRD_PARTY',
  'UNCERTAIN',
] as const;

export type ReminiscenceDisposition = (typeof REMINISCENCE_DISPOSITIONS)[number];

export type ReminiscenceNominationContext = {
  arcOpen: boolean;
};

export type ReminiscenceNominator = (
  text: string,
  ctx: ReminiscenceNominationContext,
) => ReminiscenceDisposition;
