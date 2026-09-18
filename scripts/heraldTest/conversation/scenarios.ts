export const STAGE1_SCHEMA = 'herald.conversation.stage1.v1';

export type ScenarioStatus = 'PASS' | 'FAIL' | 'UNREACHABLE';

export type TurnExpectation = {
  input: string;
  /** Exact ConversationSession pending key after the turn. */
  pending_key_after: string | null;
  pending_key_before?: string | null;
  route_source?: string | null;
  commit_statuses?: string[];
  commit_pending_keys?: Array<string | null>;
  /** Production capability / writer identifiers visible on the seam. */
  capability?: string;
  response_includes?: string[];
  response_excludes?: string[];
  zero_delta: boolean;
  lists_added?: string[];
  items_added?: Array<{ list_name: string; body: string }>;
  items_changed?: number;
  open_todos?: string[];
  open_grocery?: string[];
  open_todos_count?: number;
  open_grocery_count?: number;
};

export type EncodedScenario = {
  id: string;
  title: string;
  claimed_path: string;
  turns: TurnExpectation[];
};

export type UnreachableScenario = {
  id: string;
  title: string;
  claimed_path: string;
  probe_input: string;
  observed: string;
};

const ACCOUNTANT = 'I need to call my accountant today and tell her to file my taxes.';
const WINE_CHEESE = "Also, I need wine and cheese because I'm meeting Paul and Dina tonight for dinner.";

export const ENCODED_SCENARIOS: EncodedScenario[] = [
  {
    id: 'embedded_obligation_no_call_hijack',
    title: 'Embedded obligation without CALL hijack',
    claimed_path: 'classifyQuery action:todo_add → capture / DOMAIN_WRITERS.todo_add (not contact_call)',
    turns: [{
      input: 'Hey Herald, I went to a trade show. You worked really great. Oh shoot, I forgot. I need to call my accountant today and tell her to file my taxes. Anyway, David had a great idea.',
      pending_key_after: null,
      route_source: 'capture',
      commit_statuses: ['committed'],
      capability: 'todo_add',
      response_includes: ['to-do list'],
      response_excludes: ['number for'],
      zero_delta: false,
      lists_added: ['todos'],
      items_added: [{ list_name: 'todos', body: 'call my accountant today and tell her to file my taxes' }],
      open_todos: ['call my accountant today and tell her to file my taxes'],
      open_grocery_count: 0,
    }],
  },
  {
    id: 'temporal_obligation_ownership',
    title: 'Temporal obligation keeps TODO ownership',
    claimed_path: 'action:todo_add with temporal adverb today still writes todos via todo_add',
    turns: [{
      input: ACCOUNTANT,
      pending_key_after: null,
      route_source: 'capture',
      commit_statuses: ['committed'],
      capability: 'todo_add',
      response_includes: ['today', 'to-do list'],
      zero_delta: false,
      lists_added: ['todos'],
      items_added: [{ list_name: 'todos', body: 'call my accountant today and tell her to file my taxes.' }],
      open_todos: ['call my accountant today and tell her to file my taxes.'],
    }],
  },
  {
    id: 'todo_grocery_multi_candidate',
    title: 'TODO + grocery multi-candidate (deterministic Stage 2 re-scan)',
    claimed_path: 'primary todo_add capture + residual list_add; both DOMAIN_WRITERS commit in one turn',
    turns: [{
      input: `Hey Herald, the trade show was something else. You worked really great. Oh shoot, I forgot. ${ACCOUNTANT} Anyway, while I was at the show, I was talking to David and he had this really great suggestion. ${WINE_CHEESE}`,
      pending_key_after: null,
      route_source: 'capture',
      commit_statuses: ['committed', 'committed'],
      capability: 'todo_add+list_add',
      response_includes: ['to-do list', 'grocery list'],
      zero_delta: false,
      lists_added: ['todos', 'grocery'],
      items_added: [
        { list_name: 'todos', body: 'call my accountant today and tell her to file my taxes' },
        { list_name: 'grocery', body: 'wine' },
        { list_name: 'grocery', body: 'cheese' },
      ],
      open_todos: ['call my accountant today and tell her to file my taxes'],
      open_grocery: ['wine', 'cheese'],
    }],
  },
  {
    id: 'sequential_confirm_grocery_recovery',
    title: 'Sequential confirmation: pending grocery recovery, then yes writes only that candidate',
    claimed_path: 'deterministic_recovery list_add arms llm_confirm:list_add; first yes commits grocery only',
    turns: [
      {
        input: 'For my grocery list, we need bread and eggs.',
        pending_key_after: 'llm_confirm:list_add',
        pending_key_before: null,
        route_source: 'capture',
        commit_statuses: ['pending'],
        commit_pending_keys: ['llm_confirm:list_add'],
        capability: 'list_add',
        response_includes: ["Say yes and I'll remember that."],
        zero_delta: true,
        open_grocery_count: 0,
        open_todos_count: 0,
      },
      {
        input: 'yes',
        pending_key_after: null,
        pending_key_before: 'llm_confirm:list_add',
        route_source: 'pending_resume',
        commit_statuses: ['committed'],
        capability: 'list_add',
        response_includes: ['grocery list'],
        zero_delta: false,
        lists_added: ['grocery'],
        items_added: [
          { list_name: 'grocery', body: 'bread' },
          { list_name: 'grocery', body: 'eggs' },
        ],
        open_grocery: ['bread', 'eggs'],
        open_todos_count: 0,
      },
    ],
  },
  {
    id: 'denial_grocery_recovery_zero_write',
    title: 'Denial of grocery recovery produces zero unauthorized write',
    claimed_path: 'llm_confirm:list_add + CONFIRM_NO → noop, exact zero SQLite delta',
    turns: [
      {
        input: 'For my grocery list, we need bread and eggs.',
        pending_key_after: 'llm_confirm:list_add',
        route_source: 'capture',
        commit_statuses: ['pending'],
        commit_pending_keys: ['llm_confirm:list_add'],
        capability: 'list_add',
        zero_delta: true,
        open_grocery_count: 0,
      },
      {
        input: 'no',
        pending_key_after: null,
        pending_key_before: 'llm_confirm:list_add',
        route_source: 'pending_resume',
        commit_statuses: ['noop'],
        capability: 'list_add',
        response_includes: ["I won't remember that."],
        zero_delta: true,
        open_grocery_count: 0,
        open_todos_count: 0,
      },
    ],
  },
  {
    id: 'denial_todo_complete_zero_write',
    title: 'Denial of todo_complete leaves the open row unchanged',
    claimed_path: 'todo_complete pending key; no → noop; no checked/removed mutation',
    turns: [
      {
        input: 'I need to call the dentist.',
        pending_key_after: null,
        route_source: 'capture',
        commit_statuses: ['committed'],
        capability: 'todo_add',
        zero_delta: false,
        lists_added: ['todos'],
        items_added: [{ list_name: 'todos', body: 'call the dentist.' }],
        open_todos: ['call the dentist.'],
      },
      {
        input: 'I called the dentist.',
        pending_key_after: 'todo_complete',
        route_source: 'capture',
        commit_statuses: ['pending'],
        commit_pending_keys: ['todo_complete'],
        capability: 'todo_complete',
        zero_delta: true,
        open_todos: ['call the dentist.'],
      },
      {
        input: 'no',
        pending_key_after: null,
        pending_key_before: 'todo_complete',
        route_source: 'pending_resume',
        commit_statuses: ['noop'],
        capability: 'todo_complete',
        zero_delta: true,
        open_todos: ['call the dentist.'],
      },
    ],
  },
  {
    id: 'duplicate_todo_same_turn',
    title: 'Duplicate obligation in one turn writes a single authoritative row',
    claimed_path: 'todo_add residual suppression; one todos row',
    turns: [{
      input: `${ACCOUNTANT} ${ACCOUNTANT}`,
      pending_key_after: null,
      route_source: 'capture',
      commit_statuses: ['committed'],
      capability: 'todo_add',
      zero_delta: false,
      lists_added: ['todos'],
      items_added: [{ list_name: 'todos', body: 'call my accountant today and tell her to file my taxes' }],
      open_todos_count: 1,
    }],
  },
  {
    id: 'duplicate_todo_second_turn_noop',
    title: 'Repeat TODO utterance produces no additional authoritative row',
    claimed_path: 'todo_add writer noop; exact zero delta on turn 2',
    turns: [
      {
        input: ACCOUNTANT,
        pending_key_after: null,
        route_source: 'capture',
        commit_statuses: ['committed'],
        capability: 'todo_add',
        zero_delta: false,
        open_todos_count: 1,
      },
      {
        input: ACCOUNTANT,
        pending_key_after: null,
        route_source: 'capture',
        commit_statuses: ['noop'],
        capability: 'todo_add',
        response_includes: ['already'],
        zero_delta: true,
        open_todos_count: 1,
      },
    ],
  },
  {
    id: 'duplicate_grocery_second_turn_noop',
    title: 'Repeat grocery utterance produces no additional authoritative row',
    claimed_path: 'list_add writer noop; exact zero delta on turn 2',
    turns: [
      {
        input: 'I need eggs and milk.',
        pending_key_after: null,
        route_source: 'capture',
        commit_statuses: ['committed'],
        capability: 'list_add',
        zero_delta: false,
        lists_added: ['grocery'],
        open_grocery_count: 2,
      },
      {
        input: 'I need eggs and milk.',
        pending_key_after: null,
        route_source: 'capture',
        commit_statuses: ['noop'],
        capability: 'list_add',
        response_includes: ['already'],
        zero_delta: true,
        open_grocery_count: 2,
      },
    ],
  },
  {
    id: 'temporal_completed_zero_write',
    title: 'Completed/past temporal report does not add a TODO row',
    claimed_path: 'action:todo_complete noop on empty list; exact zero delta',
    turns: [{
      input: 'I already submitted my tax forms today.',
      pending_key_after: null,
      route_source: 'capture',
      commit_statuses: ['noop'],
      capability: 'todo_complete',
      zero_delta: true,
      open_todos_count: 0,
    }],
  },
];

export const UNREACHABLE_SCENARIOS: UnreachableScenario[] = [
  {
    id: 'heterogeneous_two_candidate_sequential_confirm',
    title: 'First confirmation affects only candidate 1, then candidate 2 becomes pending',
    claimed_path: 'chainPendingCandidates via processUtterance: llm_confirm:todo_add then llm_confirm:list_add',
    probe_input: "I need to add call my accountant to my to-do list. Also, I need wine and cheese because I'm meeting Paul and Dina tonight for dinner.",
    observed: 'Live classifyQuery + llmReady=false yields needs_clarification reason=semantic_proposal:todo_recovery_empty, pending_key=null, zero writes. The proven TODO+grocery compound instead auto-commits both writers in one turn (no pending chain). applyIntents heterogeneous pending chaining is not reachable through the journey harness without a live LLM or a production routing change.',
  },
  {
    id: 'embedded_obligation_with_unmarked_wine_pickup',
    title: 'Embedded obligation plus unmarked “pick up some wine” still captures TODO and grocery',
    claimed_path: 'action:todo_add + residual list_add',
    probe_input: "Hey Herald, I went to a trade show. You worked really great. Oh shoot, I forgot. I need to call my accountant today and tell her to file my taxes. Anyway, while I was at the show, I was talking to David and he had this really great suggestion. Oh darn it, I also need to pick up some wine because I'm meeting Paul and Dina tonight for dinner at six o'clock.",
    observed: 'classifyQuery tier 3 default; processUtterance kind=needs_clarification reason=default; zero writes. Pre-existing unmarked-acquisition whole-message guard suppresses the primary TODO as well as grocery. Not encoded.',
  },
];
