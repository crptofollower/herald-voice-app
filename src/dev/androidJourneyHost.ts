/**
 * Journey-only JS host for the Android instrumentation bridge.
 * sendMessage remains the application front door.
 */
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { initDB, isDBReady } from '../db/useDeviceDB';
import { getDB } from '../db/schema';
import { setProfileField } from '../db/profileDB';
import { useStore } from '../store/useStore';
import { normalizeInput } from '../utils/normalizeInput';

type SendMessageFn = (text: string, inputSource?: 'typed' | 'speech') => Promise<void>;
type StartRecordingFn = (
  entryPoint?: 'manual_button' | 'post_tts_handoff' | 'unknown_entry',
  mode?: 'open' | 'control_confirmation',
) => Promise<void> | void;
type JourneyRuntime = {
  sendMessage: SendMessageFn;
  peekPendingKey: () => string | null;
  resetConversation: () => void;
  startRecording?: StartRecordingFn;
  peekSpeaking?: () => boolean;
};

type NativeBridge = {
  completeTurn: (json: string) => void;
  hostReady: () => void;
};

type ListRow = { id: string; name: string };
type ListItemRow = {
  id: string;
  list_id: string;
  list_name: string;
  body: string;
  checked: number;
  removed_at: string | null;
};
type MedRow = { id: string; name: string; is_active: number };
type RecordRow = { id: string; notes: string | null; status: string | null };

type AuthoritativeSnapshot = {
  ok: boolean;
  ready: boolean;
  lists: ListRow[];
  list_items: ListItemRow[];
  medications: MedRow[];
  medical_records: RecordRow[];
};

export type JourneyTurnResult = {
  schema: 'herald.journey.turn.v1';
  turnId: string;
  scenarioId: string | null;
  turnIndex: number | null;
  submittedText: string;
  inputNormalized: string;
  inputSource: 'typed';
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  failReason: string | null;
  sendMessageInvoked: boolean;
  sendMessageReturned: boolean;
  response: string | null;
  routing: {
    handled: boolean | null;
    capture: boolean | null;
    capability: string | null;
    pendingKey: string | null;
    pending_key_before: string | null;
    pending_key_after: string | null;
    route_source: string | null;
    route_kind: string | null;
    route_reason: string | null;
    commit_statuses: string[];
    commit_pending_keys: Array<string | null>;
    committed: boolean | null;
  };
  sqlite: {
    before: AuthoritativeSnapshot & { items: ListItemRow[] };
    after: AuthoritativeSnapshot & { items: ListItemRow[] };
    delta: {
      groceryAddedIds: string[];
      groceryRemovedIds: string[];
      groceryStatusChangedIds: string[];
      lists_added: string[];
      lists_removed: string[];
      list_items_added: Array<{ list_name: string; body: string }>;
      list_items_removed: Array<{ list_name: string; body: string }>;
      list_items_changed: Array<{ id: string; list_name: string }>;
      medications_added: number;
      medications_removed: number;
      medications_changed: number;
      medical_records_added: number;
      medical_records_removed: number;
      medical_records_changed: number;
      exact_zero_delta: boolean;
    };
  };
};

const SUBMIT_EVENT = 'DebugJourneySubmitTurn';
const RESET_EVENT = 'DebugJourneyResetScenario';
const TEARDOWN_EVENT = 'DebugJourneyTeardown';
const SPEECH_PROBE_EVENT = 'DebugJourneySpeechProbe';
const NATIVE_NAME = 'DebugJourneyBridge';

let runtime: JourneyRuntime | null = null;
let native: NativeBridge | null = null;
let subscription: { remove: () => void } | null = null;
let resetSubscription: { remove: () => void } | null = null;
let teardownSubscription: { remove: () => void } | null = null;
let speechProbeSubscription: { remove: () => void } | null = null;
let inFlightTurnId: string | null = null;
let lastReportedOutcome: unknown = undefined;
let lastReportedPendingKey: string | null = null;
const seenTurnIds = new Set<string>();

export function reportJourneyTurnOutcome(outcome: unknown, pendingKey: string | null): void {
  lastReportedOutcome = outcome;
  lastReportedPendingKey = pendingKey;
}

function nativeModule(): NativeBridge | null {
  if (Platform.OS !== 'android') return null;
  const mods = NativeModules as Record<string, NativeBridge | undefined>;
  return mods[NATIVE_NAME] ?? null;
}

function emptySnapshot(ok = false): AuthoritativeSnapshot {
  return { ok, ready: isDBReady(), lists: [], list_items: [], medications: [], medical_records: [] };
}

function snapshotAuthoritative(): AuthoritativeSnapshot {
  try {
    if (!isDBReady()) return emptySnapshot(false);
    const db = getDB();
    const lists = db.getAllSync<ListRow>(`SELECT id, name FROM lists;`);
    const list_items = db.getAllSync<ListItemRow>(
      `SELECT li.id AS id, li.list_id AS list_id, l.name AS list_name, li.body AS body,
              li.checked AS checked, li.removed_at AS removed_at
         FROM list_items li
         JOIN lists l ON l.id = li.list_id;`,
    );
    let medications: MedRow[] = [];
    let medical_records: RecordRow[] = [];
    try {
      medications = db.getAllSync<MedRow>(`SELECT id, name, is_active FROM medications;`);
    } catch { /* table may be absent on a partial open */ }
    try {
      medical_records = db.getAllSync<RecordRow>(`SELECT id, notes, status FROM medical_records;`);
    } catch { /* optional */ }
    return { ok: true, ready: true, lists, list_items, medications, medical_records };
  } catch {
    return emptySnapshot(false);
  }
}

function diffSnapshots(before: AuthoritativeSnapshot, after: AuthoritativeSnapshot) {
  const beforeLists = new Map(before.lists.map((l) => [l.id, l]));
  const afterLists = new Map(after.lists.map((l) => [l.id, l]));
  const lists_added = after.lists.filter((l) => !beforeLists.has(l.id)).map((l) => l.name);
  const lists_removed = before.lists.filter((l) => !afterLists.has(l.id)).map((l) => l.name);
  const beforeItems = new Map(before.list_items.map((i) => [i.id, i]));
  const afterItems = new Map(after.list_items.map((i) => [i.id, i]));
  const list_items_added = after.list_items
    .filter((i) => !beforeItems.has(i.id))
    .map((i) => ({ list_name: i.list_name, body: i.body }));
  const list_items_removed = before.list_items
    .filter((i) => !afterItems.has(i.id))
    .map((i) => ({ list_name: i.list_name, body: i.body }));
  const list_items_changed = after.list_items
    .filter((i) => {
      const prev = beforeItems.get(i.id);
      return !!prev && (prev.checked !== i.checked || prev.removed_at !== i.removed_at || prev.body !== i.body);
    })
    .map((i) => ({ id: i.id, list_name: i.list_name }));
  const groceryAddedIds = after.list_items
    .filter((i) => i.list_name === 'grocery' && !beforeItems.has(i.id))
    .map((i) => i.id);
  const groceryRemovedIds = before.list_items
    .filter((i) => i.list_name === 'grocery' && !afterItems.has(i.id))
    .map((i) => i.id);
  const groceryStatusChangedIds = after.list_items
    .filter((i) => {
      const prev = beforeItems.get(i.id);
      return i.list_name === 'grocery' && !!prev && (prev.checked !== i.checked || prev.removed_at !== i.removed_at);
    })
    .map((i) => i.id);
  const medBefore = new Map(before.medications.map((m) => [m.id, m]));
  const medAfter = new Map(after.medications.map((m) => [m.id, m]));
  const recBefore = new Map(before.medical_records.map((m) => [m.id, m]));
  const recAfter = new Map(after.medical_records.map((m) => [m.id, m]));
  const medications_added = after.medications.filter((m) => !medBefore.has(m.id)).length;
  const medications_removed = before.medications.filter((m) => !medAfter.has(m.id)).length;
  const medications_changed = after.medications.filter((m) => {
    const prev = medBefore.get(m.id);
    return !!prev && JSON.stringify(prev) !== JSON.stringify(m);
  }).length;
  const medical_records_added = after.medical_records.filter((m) => !recBefore.has(m.id)).length;
  const medical_records_removed = before.medical_records.filter((m) => !recAfter.has(m.id)).length;
  const medical_records_changed = after.medical_records.filter((m) => {
    const prev = recBefore.get(m.id);
    return !!prev && JSON.stringify(prev) !== JSON.stringify(m);
  }).length;
  const exact_zero_delta =
    lists_added.length === 0 &&
    lists_removed.length === 0 &&
    list_items_added.length === 0 &&
    list_items_removed.length === 0 &&
    list_items_changed.length === 0 &&
    medications_added === 0 &&
    medications_removed === 0 &&
    medications_changed === 0 &&
    medical_records_added === 0 &&
    medical_records_removed === 0 &&
    medical_records_changed === 0;
  return {
    groceryAddedIds,
    groceryRemovedIds,
    groceryStatusChangedIds,
    lists_added,
    lists_removed,
    list_items_added,
    list_items_removed,
    list_items_changed,
    medications_added,
    medications_removed,
    medications_changed,
    medical_records_added,
    medical_records_removed,
    medical_records_changed,
    exact_zero_delta,
  };
}

function describeRouting(
  outcome: unknown,
  pendingBefore: string | null,
  pendingAfter: string | null,
  delta: ReturnType<typeof diffSnapshots>,
  after: AuthoritativeSnapshot,
) {
  const empty = {
    handled: null as boolean | null,
    capture: null as boolean | null,
    capability: null as string | null,
    pendingKey: pendingAfter,
    pending_key_before: pendingBefore,
    pending_key_after: pendingAfter,
    route_source: null as string | null,
    route_kind: null as string | null,
    route_reason: null as string | null,
    commit_statuses: [] as string[],
    commit_pending_keys: [] as Array<string | null>,
    committed: null as boolean | null,
  };
  if (!outcome || typeof outcome !== 'object') return empty;
  const o = outcome as Record<string, unknown>;
  const handled = typeof o.handled === 'boolean' ? o.handled : null;
  const source = typeof o.source === 'string' ? o.source : null;
  let commit_statuses: string[] = [];
  let commit_pending_keys: Array<string | null> = [];
  if (Array.isArray(o.commits)) {
    const commits = o.commits as Array<Record<string, unknown>>;
    commit_statuses = commits.map((c) => String(c.status ?? ''));
    commit_pending_keys = commits.map((c) => (c.status === 'pending' && typeof c.pendingKey === 'string' ? c.pendingKey : null));
  }
  let route_source = source;
  let route_kind = source;
  let route_reason = source;
  let response: string | null = typeof o.responseText === 'string' ? o.responseText : null;
  if (o.routeDecision && typeof o.routeDecision === 'object') {
    const rd = o.routeDecision as Record<string, unknown>;
    const kind = typeof rd.kind === 'string' ? rd.kind : null;
    if (kind === 'device_read') {
      route_kind = 'device_read';
      route_source = 'device_read';
      route_reason = 'reason' in rd ? String(rd.reason ?? '') : route_reason;
      if (typeof rd.response === 'string') response = rd.response;
    } else if (kind === 'needs_clarification' && !source) {
      route_kind = 'needs_clarification';
      route_reason = 'reason' in rd ? String(rd.reason ?? '') : route_reason;
    } else if (kind === 'referent_resume') {
      route_kind = 'referent_resume';
      route_source = 'referent_resume';
      route_reason = 'reason' in rd ? String(rd.reason ?? '') : route_reason;
      if (!response && typeof rd.response === 'string') response = rd.response;
    } else if (handled === false && kind) {
      route_kind = kind;
      route_reason = 'reason' in rd ? String(rd.reason ?? '') : route_reason;
    }
  }
  const pendingCommit = commit_pending_keys.find((k) => !!k) ?? null;
  if (pendingCommit) route_reason = pendingCommit;
  const capability = deriveCapability(
    pendingBefore,
    pendingAfter,
    commit_statuses,
    commit_pending_keys,
    delta,
    typeof o.capabilitySurface === 'string' ? o.capabilitySurface : null,
    after,
  );
  return {
    handled,
    capture: source === 'capture',
    capability,
    pendingKey: pendingAfter,
    pending_key_before: pendingBefore,
    pending_key_after: pendingAfter,
    route_source,
    route_kind,
    route_reason,
    commit_statuses,
    commit_pending_keys,
    committed: commit_statuses.includes('committed'),
    response,
  };
}

function deriveCapability(
  pendingBefore: string | null,
  pendingAfter: string | null,
  commitStatuses: string[],
  commitPending: Array<string | null>,
  delta: ReturnType<typeof diffSnapshots>,
  surface: string | null,
  after: AuthoritativeSnapshot,
): string | null {
  const writers = new Set<string>();
  if (pendingAfter === 'todo_complete' || commitPending.includes('todo_complete')) {
    writers.add('todo_complete');
  }
  if (pendingAfter === 'llm_confirm:list_add' || commitPending.includes('llm_confirm:list_add')) {
    writers.add('list_add');
  }
  if (pendingAfter === 'medical_capture' || commitPending.includes('medical_capture')) {
    writers.add('medical_capture');
  }
  if (pendingAfter === 'medical_visit' || commitPending.includes('medical_visit')) {
    writers.add('medical_visit');
  }
  if (pendingAfter === 'contact_call' || commitPending.includes('contact_call')) {
    writers.add('contact_call');
  }
  if (delta.medications_added > 0) writers.add('medical_capture');
  if (delta.medical_records_added > 0) writers.add('medical_visit');
  for (const row of delta.list_items_added) {
    if (row.list_name === 'todos') writers.add('todo_add');
    if (row.list_name === 'grocery') writers.add('list_add');
  }
  for (const row of delta.list_items_changed) {
    if (row.list_name === 'todos') writers.add('todo_complete');
  }
  if (writers.size === 0 && commitStatuses.includes('noop')) {
    if (pendingBefore === 'todo_complete') writers.add('todo_complete');
    else if (pendingBefore === 'llm_confirm:list_add') writers.add('list_add');
    else if (pendingBefore === 'medical_capture') writers.add('medical_capture');
    else if (pendingBefore === 'medical_visit') writers.add('medical_visit');
    else if (pendingBefore === 'contact_call') writers.add('contact_call');
    else {
      const openTodos = after.list_items.filter((i) => i.list_name === 'todos' && i.checked === 0 && !i.removed_at);
      const openGrocery = after.list_items.filter((i) => i.list_name === 'grocery' && i.checked === 0 && !i.removed_at);
      if (openTodos.length === 0 && openGrocery.length === 0) writers.add('todo_complete');
      else if (openGrocery.length > 0 && openTodos.length === 0) writers.add('list_add');
      else if (openTodos.length > 0 && openGrocery.length === 0) writers.add('todo_add');
      else if (surface === 'grocery') writers.add('list_add');
      else writers.add('todo_add');
    }
  }
  if (writers.size === 0 && surface === 'grocery') writers.add('list_add');
  if (writers.size === 0 && surface === 'todo') writers.add('todo_add');
  if (writers.has('todo_add') && writers.has('list_add')) return 'todo_add+list_add';
  if (writers.size === 1) return [...writers][0];
  if (writers.size > 1) return [...writers].sort().join('+');
  return surface;
}

function emitComplete(result: object): void {
  if (!native) return;
  try {
    native.completeTurn(JSON.stringify(result));
  } catch {
    /* native may have torn down */
  }
}

function failEnvelope(
  turnId: string,
  text: string,
  failReason: string,
  extra?: Record<string, unknown>,
): JourneyTurnResult {
  const snap = emptySnapshot(false);
  return {
    schema: 'herald.journey.turn.v1',
    turnId,
    scenarioId: null,
    turnIndex: null,
    submittedText: text,
    inputNormalized: normalizeInput(text),
    inputSource: 'typed',
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    durationMs: 0,
    status: 'FAIL',
    failReason,
    sendMessageInvoked: false,
    sendMessageReturned: false,
    response: null,
    routing: describeRouting(undefined, null, null, diffSnapshots(snap, snap), snap),
    sqlite: {
      before: { ...snap, items: [] },
      after: { ...snap, items: [] },
      delta: diffSnapshots(snap, snap),
    },
    ...extra,
  };
}

function resetAuthoritativeLists(): void {
  if (!isDBReady()) return;
  const db = getDB();
  db.execSync('DELETE FROM list_items;');
  db.execSync('DELETE FROM lists;');
  try { db.execSync('DELETE FROM medications;'); } catch { /* optional */ }
  try { db.execSync('DELETE FROM medical_records;'); } catch { /* optional */ }
}

async function runTurn(payload: {
  turnId?: string;
  text?: string;
  scenarioId?: string;
  turnIndex?: number;
}): Promise<void> {
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  const startedAtMs = Date.now();
  if (!turnId || !text) {
    emitComplete(failEnvelope(turnId, text, 'invalid_payload'));
    return;
  }
  if (seenTurnIds.has(turnId)) {
    emitComplete(failEnvelope(turnId, text, 'duplicate_turn_id'));
    return;
  }
  if (inFlightTurnId) {
    emitComplete(failEnvelope(turnId, text, 'duplicate_or_in_flight'));
    return;
  }
  if (!runtime?.sendMessage) {
    emitComplete(failEnvelope(turnId, text, 'send_message_unbound'));
    return;
  }

  seenTurnIds.add(turnId);
  inFlightTurnId = turnId;
  lastReportedOutcome = undefined;
  lastReportedPendingKey = null;
  try {
    if (!isDBReady()) await initDB();
    prepareInstrumentationSession();
    const pendingBefore = runtime.peekPendingKey();
    const before = snapshotAuthoritative();
    await runtime.sendMessage(text, 'typed');
    const after = snapshotAuthoritative();
    const delta = diffSnapshots(before, after);
    const pendingAfter = lastReportedPendingKey ?? runtime.peekPendingKey();
    const routingPlus = describeRouting(lastReportedOutcome, pendingBefore, pendingAfter, delta, after);
    const { response, ...routing } = routingPlus;
    const missingRouter = lastReportedOutcome === undefined;
    emitComplete({
      schema: 'herald.journey.turn.v1',
      turnId,
      scenarioId: typeof payload.scenarioId === 'string' ? payload.scenarioId : null,
      turnIndex: typeof payload.turnIndex === 'number' ? payload.turnIndex : null,
      submittedText: text,
      inputNormalized: normalizeInput(text),
      inputSource: 'typed',
      startedAtMs,
      finishedAtMs: Date.now(),
      durationMs: Date.now() - startedAtMs,
      status: missingRouter ? 'FAIL' : 'PASS',
      failReason: missingRouter ? 'exited_before_router' : null,
      sendMessageInvoked: true,
      sendMessageReturned: true,
      response,
      routing,
      sqlite: {
        before: { ...before, items: before.list_items.filter((i) => i.list_name === 'grocery') },
        after: { ...after, items: after.list_items.filter((i) => i.list_name === 'grocery') },
        delta,
      },
    });
  } catch (e) {
    emitComplete(
      failEnvelope(turnId, text, e instanceof Error ? e.message : 'send_message_threw', {
        sendMessageInvoked: true,
        sendMessageReturned: false,
      }),
    );
  } finally {
    inFlightTurnId = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<{ met: boolean; waitedMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return { met: true, waitedMs: Date.now() - t0 };
    await sleep(50);
  }
  return { met: pred(), waitedMs: Date.now() - t0 };
}

async function runSpeechLifecycleProbe(): Promise<void> {
  const startRecording = runtime?.startRecording;
  if (!startRecording) {
    emitComplete({
      schema: 'herald.journey.speech_lifecycle.v1',
      status: 'FAIL',
      failReason: 'start_recording_unbound',
    });
    return;
  }
  await startRecording('manual_button', 'open');
  await sleep(8000);
  let sendMessageInvoked = false;
  let sendMessageReturned = false;
  if (runtime?.sendMessage) {
    sendMessageInvoked = true;
    try {
      await runtime.sendMessage('hello', 'typed');
      sendMessageReturned = true;
    } catch (e) {
      emitComplete({
        schema: 'herald.journey.speech_lifecycle.v1',
        status: 'FAIL',
        failReason: e instanceof Error ? e.message : 'send_message_threw',
        sendMessageInvoked,
        sendMessageReturned,
      });
      return;
    }
  }
  const speakingNow = () => !!runtime?.peekSpeaking?.();
  const ttsAssert = await waitFor(speakingNow, 15000);
  const ttsClear = ttsAssert.met ? await waitFor(() => !speakingNow(), 20000) : { met: false, waitedMs: 0 };
  const rearmBlocked = speakingNow();
  if (!rearmBlocked) {
    await startRecording('manual_button', 'open');
  }
  emitComplete({
    schema: 'herald.journey.speech_lifecycle.v1',
    status: 'PASS',
    failReason: null,
    sendMessageInvoked,
    sendMessageReturned,
    speakingBecameTrue: ttsAssert.met,
    speakingCleared: ttsClear.met,
    rearmBlocked,
    ttsAssertWaitMs: ttsAssert.waitedMs,
    ttsClearWaitMs: ttsClear.waitedMs,
  });
}

function runReset(): void {
  try {
    if (!isDBReady()) {
      emitComplete({ schema: 'herald.journey.reset.v1', status: 'FAIL', failReason: 'db_not_ready' });
      return;
    }
    resetAuthoritativeLists();
    runtime?.resetConversation();
    seenTurnIds.clear();
    inFlightTurnId = null;
    lastReportedOutcome = undefined;
    lastReportedPendingKey = null;
    emitComplete({ schema: 'herald.journey.reset.v1', status: 'PASS', failReason: null });
  } catch (e) {
    emitComplete({
      schema: 'herald.journey.reset.v1',
      status: 'FAIL',
      failReason: e instanceof Error ? e.message : 'reset_threw',
    });
  }
}

export function bindJourneySendMessage(fn: SendMessageFn): void {
  runtime = {
    sendMessage: fn,
    peekPendingKey: runtime?.peekPendingKey ?? (() => lastReportedPendingKey),
    resetConversation: runtime?.resetConversation ?? (() => {}),
    startRecording: runtime?.startRecording,
    peekSpeaking: runtime?.peekSpeaking,
  };
  if (native) {
    try { native.hostReady(); } catch { /* ignore */ }
  }
}

export function bindJourneyRuntime(next: JourneyRuntime): void {
  runtime = next;
  if (native) {
    try { native.hostReady(); } catch { /* ignore */ }
  }
}

export function prepareInstrumentationSession(): void {
  if (!nativeModule()) return;
  const state = useStore.getState();
  const name = state.name && state.name.trim() ? state.name : 'Spike';
  useStore.setState({ name, onboardingComplete: true });
  try {
    if (isDBReady()) {
      setProfileField('onboarding_complete', 'true');
      setProfileField('name', name);
      if (state.userId) setProfileField('user_id', state.userId);
    }
  } catch { /* profile table may not exist yet */ }
}

export function onboardAndroidJourneyHost(): void {
  if (subscription) return;
  native = nativeModule();
  if (!native) return;
  prepareInstrumentationSession();
  subscription = DeviceEventEmitter.addListener(SUBMIT_EVENT, (payload) => {
    void runTurn(payload ?? {});
  });
  resetSubscription = DeviceEventEmitter.addListener(RESET_EVENT, () => {
    runReset();
  });
  teardownSubscription = DeviceEventEmitter.addListener(TEARDOWN_EVENT, () => {
    teardownAndroidJourneyHost();
  });
  speechProbeSubscription = DeviceEventEmitter.addListener(SPEECH_PROBE_EVENT, () => {
    void runSpeechLifecycleProbe();
  });
}

export function teardownAndroidJourneyHost(): void {
  subscription?.remove();
  subscription = null;
  resetSubscription?.remove();
  resetSubscription = null;
  teardownSubscription?.remove();
  teardownSubscription = null;
  speechProbeSubscription?.remove();
  speechProbeSubscription = null;
  runtime = null;
  native = null;
  inFlightTurnId = null;
  lastReportedOutcome = undefined;
  lastReportedPendingKey = null;
  seenTurnIds.clear();
}
