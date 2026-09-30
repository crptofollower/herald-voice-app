// Closed output contracts for the three discourse proposal roles.
// Parsing these is the authority boundary. response_format only constrains
// llama.rn generation; a completion is still rejected when it is not one
// complete value of the contract.
//
// Item cap matches the disclosed applicability card cap (8).
// Span cap matches topic-evidence text (160).

export const DISCOURSE_OUTPUT_MAX_ITEMS = 8;
export const DISCOURSE_OUTPUT_SPAN_MAX_CHARS = 160;

export const DISCOURSE_SPAN_KINDS = ['person', 'place', 'event_or_topic'] as const;
export const DISCOURSE_MARK_VALUES = ['compatible', 'incompatible', 'uncertain'] as const;

const SPAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['span', 'kind'],
  properties: {
    span: { type: 'string', maxLength: DISCOURSE_OUTPUT_SPAN_MAX_CHARS },
    kind: { type: 'string', enum: [...DISCOURSE_SPAN_KINDS] },
  },
} as const;

const MARK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['handle', 'mark'],
  properties: {
    handle: { type: 'string' },
    mark: { type: 'string', enum: [...DISCOURSE_MARK_VALUES] },
  },
} as const;

export const DISCOURSE_MENTION_JSON_SCHEMA = {
  type: 'array',
  maxItems: DISCOURSE_OUTPUT_MAX_ITEMS,
  items: SPAN_SCHEMA,
} as const;

export const DISCOURSE_APPLICABILITY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['utterance_applicable', 'marks'],
  properties: {
    utterance_applicable: { type: 'boolean' },
    reference_attempt: { type: 'boolean' },
    marks: {
      type: 'array',
      maxItems: DISCOURSE_OUTPUT_MAX_ITEMS,
      items: MARK_SCHEMA,
    },
  },
} as const;

export const DISCOURSE_CORRECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['correction_turn', 'target_marks', 'replacement_marks'],
  properties: {
    correction_turn: { type: 'boolean' },
    target_marks: {
      type: 'array',
      maxItems: DISCOURSE_OUTPUT_MAX_ITEMS,
      items: MARK_SCHEMA,
    },
    replacement_marks: {
      type: 'array',
      maxItems: DISCOURSE_OUTPUT_MAX_ITEMS,
      items: MARK_SCHEMA,
    },
    new_spans: {
      type: 'array',
      maxItems: DISCOURSE_OUTPUT_MAX_ITEMS,
      items: SPAN_SCHEMA,
    },
  },
} as const;

export type DiscourseStructuredKind = 'discourse_mention' | 'discourse_applicability' | 'discourse_correction';

export type DiscourseBoundedResponseFormat = {
  type: 'json_schema';
  json_schema: {
    strict: true;
    schema: object;
  };
};

function responseFormat(schema: object): DiscourseBoundedResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      strict: true,
      schema,
    },
  };
}

export const DISCOURSE_BOUNDED_RESPONSE_FORMATS: Record<DiscourseStructuredKind, DiscourseBoundedResponseFormat> = {
  discourse_mention: responseFormat(DISCOURSE_MENTION_JSON_SCHEMA),
  discourse_applicability: responseFormat(DISCOURSE_APPLICABILITY_JSON_SCHEMA),
  discourse_correction: responseFormat(DISCOURSE_CORRECTION_JSON_SCHEMA),
};

export function isDiscourseStructuredKind(kind: string): kind is DiscourseStructuredKind {
  return kind === 'discourse_mention' || kind === 'discourse_applicability' || kind === 'discourse_correction';
}

export function discourseBoundedResponseFormat(kind: DiscourseStructuredKind): DiscourseBoundedResponseFormat {
  return DISCOURSE_BOUNDED_RESPONSE_FORMATS[kind];
}

/** The trimmed completion must be one JSON value. A slice inside prose is not a proposal. */
export function parseClosedJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function closedRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some((key) => !allowed.includes(key))) return null;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) return null;
  return row;
}

export function isDiscourseSpanKind(value: unknown): value is (typeof DISCOURSE_SPAN_KINDS)[number] {
  return typeof value === 'string' && (DISCOURSE_SPAN_KINDS as readonly string[]).includes(value);
}

export function isDiscourseMarkValue(value: unknown): value is (typeof DISCOURSE_MARK_VALUES)[number] {
  return typeof value === 'string' && (DISCOURSE_MARK_VALUES as readonly string[]).includes(value);
}
