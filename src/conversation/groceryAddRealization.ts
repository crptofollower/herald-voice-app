// src/conversation/groceryAddRealization.ts
// Conversational Response Realization V1 — Grocery, single-item add paths only.
//
// AUTHORIZED DETERMINISTIC RESULT -> BOUNDED RESPONSE ACT -> DETERMINISTIC
// REALIZATION -> existing transcript/TTS path. The list_add writer decides what
// happened and to which list; this module only says it.
//
// Pure, synchronous, local, zero imports. No LLM, no I/O, no clock, no random.
//
// GRAMMATICAL NUMBER, SOLVED STRUCTURALLY:
// The prior wording put the item in subject position — "Eggs is on your grocery
// list." — which forces a copula to agree with a noun whose grammatical number
// is unknowable at write time ("eggs" plural, "milk" singular mass, "asparagus"
// singular despite the -s). Rather than infer plurality (fragile, and wrong for
// mass nouns ending in -s), realization selects a sentence FORM that never
// requires agreement with the item at all. "Added X to your Y list." and "You
// already had X on your Y list." are correct for every X, with no lookup table,
// no suffix heuristic, and no per-item special case. Nothing here inspects the
// item string; it is concatenated verbatim.
//
// Scope is deliberately the two single-item paths that need the mechanism. The
// multi-item acks were already grammatically correct and are NOT enrolled — no
// unused 'added_many'/'already_had_many' variant is defined here for them.
//
// No conversational closer is ever appended, and neither kind ends in a
// question: an add confirmation requires nothing from the user, and silence is
// a valid ending.

export type GroceryAddResponseAct =
  | { kind: 'added_one'; item: string; listName: string }
  | { kind: 'already_had_one'; item: string; listName: string };

export function realizeGroceryAddAct(act: GroceryAddResponseAct): string {
  switch (act.kind) {
    case 'added_one':
      return `Added ${act.item} to your ${act.listName} list.`;
    case 'already_had_one':
      return `You already had ${act.item} on your ${act.listName} list.`;
  }
}
