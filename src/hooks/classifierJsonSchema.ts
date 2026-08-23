// Syntax-only JSON schema for classifier constrained decoding.
// Post-decode authority remains parseClassifierOutput + verifyVerbatim.

/** Mirrors IntentRecord literals in llmLayers.ts — keep in sync with KNOWN_TYPES. */
export const CLASSIFIER_INTENT_TYPES = [
  'pass',
  'list_add',
  'insurance_capture',
  'medical_capture',
  'medical_visit',
  'medical_visit_upcoming',
  'doctor_intro_capture',
  'service_capture',
  'family_capture',
  'phone_capture',
  'address_capture',
  'emergency_contact',
  'diagnosis_capture',
  'contact_call',
  'todo_add',
  'read',
] as const;

export type ClassifierIntentType = typeof CLASSIFIER_INTENT_TYPES[number];

type BranchSpec = {
  type: ClassifierIntentType;
  required: string[];
  optional: string[];
  objects?: Record<string, { required: string[]; optional: string[] }>;
  arrays?: Record<string, 'string' | 'candidate'>;
};

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'phone', 'importance'],
  properties: {
    name: { type: 'string' },
    phone: { type: 'string' },
    importance: { type: 'number' },
    relationship: { type: 'string' },
  },
} as const;

const BRANCH_SPECS: BranchSpec[] = [
  { type: 'pass', required: [], optional: [] },
  { type: 'list_add', required: ['items', 'listName'], optional: [], arrays: { items: 'string' } },
  { type: 'insurance_capture', required: ['insType', 'carrier'], optional: ['agent', 'phone'] },
  { type: 'medical_capture', required: ['raw'], optional: ['drug', 'dosage', 'frequency'] },
  { type: 'medical_visit', required: ['raw'], optional: ['doctor_name', 'specialty', 'advice'] },
  { type: 'medical_visit_upcoming', required: ['raw'], optional: ['doctor_name', 'specialty'] },
  { type: 'doctor_intro_capture', required: ['name', 'specialty', 'raw'], optional: [] },
  { type: 'service_capture', required: ['category', 'name'], optional: ['phone'] },
  { type: 'family_capture', required: ['relation', 'name'], optional: ['location', 'phone'] },
  { type: 'phone_capture', required: ['name', 'phone'], optional: ['relationship'] },
  { type: 'address_capture', required: ['name', 'address'], optional: [] },
  { type: 'emergency_contact', required: ['name'], optional: ['phone'] },
  { type: 'diagnosis_capture', required: ['condition', 'raw'], optional: [] },
  {
    type: 'contact_call',
    required: ['contact', 'raw'],
    optional: ['phonelessNames', 'devicePhone', 'deviceName'],
    arrays: { phonelessNames: 'string' },
    objects: { candidates: { required: ['name', 'phone', 'importance'], optional: ['relationship'] } },
  },
  { type: 'todo_add', required: ['body'], optional: [] },
  {
    type: 'read',
    required: ['domain', 'entity_type', 'entity', 'requested_information', 'raw_phrase', 'confidence'],
    optional: [],
  },
];

function branchToJsonSchema(spec: BranchSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    type: { const: spec.type },
  };
  for (const key of spec.required) {
    if (spec.arrays?.[key] === 'string') {
      properties[key] = { type: 'array', items: { type: 'string' }, minItems: 1 };
    } else if (spec.objects?.[key]) {
      const o = spec.objects[key];
      const objProps: Record<string, unknown> = {
        name: { type: 'string' },
        phone: { type: 'string' },
        importance: { type: 'number' },
        relationship: { type: 'string' },
      };
      properties[key] = {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: o.required,
          properties: Object.fromEntries(
            [...o.required, ...o.optional].map(k => [k, objProps[k]]),
          ),
        },
      };
    } else {
      properties[key] = { type: 'string' };
    }
  }
  for (const key of spec.optional) {
    if (spec.arrays?.[key] === 'string') {
      properties[key] = { type: 'array', items: { type: 'string' } };
    } else if (spec.objects?.[key]) {
      const o = spec.objects[key];
      properties[key] = {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: o.required,
          properties: {
            name: { type: 'string' },
            phone: { type: 'string' },
            importance: { type: 'number' },
            relationship: { type: 'string' },
          },
        },
      };
    } else {
      properties[key] = { type: 'string' };
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', ...spec.required],
    properties,
  };
}

export const CLASSIFIER_RESPONSE_JSON_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  items: {
    oneOf: BRANCH_SPECS.map(branchToJsonSchema),
  },
} as const;

export const CLASSIFIER_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    strict: true,
    schema: CLASSIFIER_RESPONSE_JSON_SCHEMA,
  },
};

/** Test helper — mirrors schema shape without invoking llama.rn grammar conversion. */
export function matchesClassifierResponseSchema(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false;
  return value.every(el => matchesIntentBranch(el));
}

function matchesIntentBranch(el: unknown): boolean {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
  const rec = el as Record<string, unknown>;
  const spec = BRANCH_SPECS.find(s => s.type === rec.type);
  if (!spec) return false;
  for (const key of Object.keys(rec)) {
    if (key === 'type') continue;
    if (!spec.required.includes(key) && !spec.optional.includes(key)) return false;
  }
  for (const key of spec.required) {
    if (!(key in rec)) return false;
    if (spec.arrays?.[key] === 'string') {
      if (!Array.isArray(rec[key]) || !(rec[key] as unknown[]).every(v => typeof v === 'string')) return false;
      if ((rec[key] as unknown[]).length < 1) return false;
    } else if (spec.objects?.[key]) {
      if (!Array.isArray(rec[key])) return false;
      for (const item of rec[key] as unknown[]) {
        if (!matchesCandidate(item)) return false;
      }
    } else if (typeof rec[key] !== 'string') {
      return false;
    }
  }
  for (const key of spec.optional) {
    if (!(key in rec)) continue;
    if (spec.arrays?.[key] === 'string') {
      if (!Array.isArray(rec[key]) || !(rec[key] as unknown[]).every(v => typeof v === 'string')) return false;
    } else if (spec.objects?.[key]) {
      if (!Array.isArray(rec[key])) return false;
      for (const item of rec[key] as unknown[]) {
        if (!matchesCandidate(item)) return false;
      }
    } else if (typeof rec[key] !== 'string') {
      return false;
    }
  }
  return true;
}

function matchesCandidate(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const c = item as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.phone !== 'string' || typeof c.importance !== 'number') return false;
  if ('relationship' in c && typeof c.relationship !== 'string') return false;
  for (const key of Object.keys(c)) {
    if (!['name', 'phone', 'importance', 'relationship'].includes(key)) return false;
  }
  return true;
}

export { BRANCH_SPECS, CANDIDATE_SCHEMA };
