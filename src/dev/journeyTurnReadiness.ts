// Diagnostic only. Observes the production send gates. Does not clear them.

export const PRODUCTION_SEND_DEBOUNCE_MS = 1000;
export const JOURNEY_TURN_READINESS_TIMEOUT_MS = 5000;
export const JOURNEY_TURN_READINESS_POLL_MS = 50;

export type JourneyTurnReadiness = {
  schema: 'herald.journey.turn_readiness.v1';
  sendInFlight: boolean;
  debounceRemainingMs: number;
  readyForJourneyTurn: boolean;
};

export function classifyJourneyTurnReadiness(input: {
  nowMs: number;
  lastSentAtMs: number;
  sendInFlight: boolean;
}): JourneyTurnReadiness {
  const debounceRemainingMs = input.lastSentAtMs <= 0
    ? 0
    : Math.max(0, PRODUCTION_SEND_DEBOUNCE_MS - (input.nowMs - input.lastSentAtMs));
  const sendInFlight = input.sendInFlight === true;
  return {
    schema: 'herald.journey.turn_readiness.v1',
    sendInFlight,
    debounceRemainingMs,
    readyForJourneyTurn: !sendInFlight && debounceRemainingMs === 0,
  };
}

export async function pollUntilJourneyTurnReady(input: {
  peek: () => JourneyTurnReadiness;
  timeoutMs?: number;
  pollMs?: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ ready: boolean; attempts: number }> {
  const timeoutMs = input.timeoutMs ?? JOURNEY_TURN_READINESS_TIMEOUT_MS;
  const pollMs = input.pollMs ?? JOURNEY_TURN_READINESS_POLL_MS;
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const ready = input.peek().readyForJourneyTurn === true;
    if (ready) return { ready: true, attempts };
    if (Date.now() - started >= timeoutMs) return { ready: false, attempts };
    await input.sleep(pollMs);
  }
}

type Invocation = {
  operation?: string;
  status?: string;
  proposedCapability?: string | null;
  identifiesEntity?: boolean;
  packet?: {
    groundedPeople?: boolean;
    groundedPresentedMaterial?: boolean;
    includesPhones?: boolean;
    includesNames?: boolean;
    includesMedicationData?: boolean;
  };
};

type Admission = { decision?: string | null; mechanism?: string | null };

export function semanticProofTurnFailure(input: {
  scenarioId: string | null;
  turnIndex: number | null;
  status: string | null;
  failReason: string | null;
  semantic: { invocations?: Invocation[]; admissions?: Admission[]; execution?: { externalActionArmed?: boolean } | null } | null;
}): string | null {
  if (!input.status) return 'TURN_OUTCOME_MISSING';
  if (input.failReason === 'exited_before_router' || input.status !== 'PASS') {
    return input.failReason || 'TURN_STATUS';
  }
  if (input.failReason) return input.failReason;
  const need = requiredSemanticProof(input.scenarioId, input.turnIndex);
  if (!need) return null;
  if (!input.semantic) return 'PROOF_MISSING';
  const invocations = input.semantic.invocations ?? [];
  if (need.operation) {
    const hit = invocations.find((row) => row.operation === need.operation && matchesPacket(row, need));
    if (!hit) return 'SEMANTIC_PATH_MISSING';
    if (need.proposedCapability && hit.proposedCapability !== need.proposedCapability) return 'SEMANTIC_PATH_MISSING';
    if (need.forbidCapability && hit.proposedCapability === need.forbidCapability) return 'SEMANTIC_PATH_MISSING';
  }
  if (need.admissionDecision) {
    const admitted = (input.semantic.admissions ?? []).some((row) => row.decision === need.admissionDecision);
    if (!admitted) return 'SEMANTIC_ADMISSION_MISSING';
  }
  if (need.noExternalAction && input.semantic.execution?.externalActionArmed === true) return 'EXTERNAL_ACTION_ARMED';
  return null;
}

function matchesPacket(row: Invocation, need: { groundedPeople?: boolean; groundedPresentedMaterial?: boolean }): boolean {
  if (need.groundedPeople === true && row.packet?.groundedPeople !== true) return false;
  if (need.groundedPresentedMaterial === true && row.packet?.groundedPresentedMaterial !== true) return false;
  return true;
}

function requiredSemanticProof(scenarioId: string | null, turnIndex: number | null): {
  operation?: 'reference_continuation' | 'capability';
  proposedCapability?: string;
  groundedPeople?: boolean;
  groundedPresentedMaterial?: boolean;
  admissionDecision?: string;
  noExternalAction?: boolean;
  forbidCapability?: string;
} | null {
  if (scenarioId === 'semantic_c' && turnIndex === 3) return { operation: 'reference_continuation' };
  if (scenarioId === 'semantic_f' && turnIndex === 2) {
    return { operation: 'reference_continuation', groundedPresentedMaterial: true };
  }
  if (scenarioId === 'semantic_h' && turnIndex === 2) {
    return { operation: 'reference_continuation', groundedPeople: true };
  }
  if (scenarioId === 'semantic_e' && turnIndex === 1) {
    return { operation: 'capability', proposedCapability: 'medication.read_summary', admissionDecision: 'ADMIT_READ' };
  }
  if (scenarioId === 'semantic_e' && turnIndex === 2) {
    return { operation: 'capability', proposedCapability: 'calendar.read' };
  }
  if (scenarioId === 'semantic_e' && turnIndex === 3) {
    return { operation: 'capability', forbidCapability: 'contact.call', noExternalAction: true };
  }
  if (scenarioId === 'semantic_negative' && turnIndex === 2) {
    return { operation: 'reference_continuation', groundedPresentedMaterial: true };
  }
  if (scenarioId === 'semantic_negative' && turnIndex === 4) {
    return { operation: 'reference_continuation', groundedPeople: true };
  }
  if (scenarioId === 'semantic_negative' && turnIndex === 5) return { operation: 'reference_continuation' };
  return null;
}
