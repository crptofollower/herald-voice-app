// scripts/heraldTest/classifierJsonSchema.test.ts
// Classifier JSON-schema shape — syntax envelope only; authority stays post-decode.

import {
  CLASSIFIER_INTENT_TYPES,
  CLASSIFIER_RESPONSE_FORMAT,
  CLASSIFIER_RESPONSE_JSON_SCHEMA,
  matchesClassifierResponseSchema,
} from '../../src/hooks/classifierJsonSchema.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const CAPTURE_KNOWN_TYPES = [
  'list_add', 'insurance_capture', 'medical_capture',
  'medical_visit', 'medical_visit_upcoming', 'doctor_intro_capture',
  'service_capture', 'family_capture', 'phone_capture', 'address_capture',
  'emergency_contact', 'diagnosis_capture', 'contact_call',
  'todo_add', 'pass',
];

const SCHEMA_INTENT_TYPES = [...CAPTURE_KNOWN_TYPES, 'read'];

export async function runClassifierJsonSchemaTests(): Promise<{
  passed: number;
  failed: number;
  total: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- Classifier JSON Schema Tests --------------------------${RESET}\n`);

  assert(
    'JS1 schema covers every capture + read branch',
    CLASSIFIER_INTENT_TYPES.slice().sort(),
    v => JSON.stringify(v) === JSON.stringify([...SCHEMA_INTENT_TYPES].sort()),
    'all 15 capture types + read',
  );

  assert(
    'JS2 top-level array minItems 1 maxItems 4',
    { min: CLASSIFIER_RESPONSE_JSON_SCHEMA.minItems, max: CLASSIFIER_RESPONSE_JSON_SCHEMA.maxItems },
    v => (v as { min: number; max: number }).min === 1 && (v as { min: number; max: number }).max === 4,
    '{ min: 1, max: 4 }',
  );

  assert(
    'JS3 pass schema output validates',
    matchesClassifierResponseSchema([{ type: 'pass' }]),
    v => v === true,
    'true',
  );

  assert(
    'JS4 single structured capture validates',
    matchesClassifierResponseSchema([
      { type: 'medical_capture', drug: 'metformin', raw: "I'm on metformin" },
    ]),
    v => v === true,
    'true',
  );

  assert(
    'JS5 compound 2-intent validates',
    matchesClassifierResponseSchema([
      { type: 'medical_capture', drug: 'lisinopril', dosage: '5mg', raw: 'lisinopril 5mg and apples' },
      { type: 'list_add', items: ['apples'], listName: 'grocery' },
    ]),
    v => v === true,
    'true',
  );

  assert(
    'JS6 max 4 intents validates',
    matchesClassifierResponseSchema([
      { type: 'todo_add', body: 'a' },
      { type: 'todo_add', body: 'b' },
      { type: 'todo_add', body: 'c' },
      { type: 'todo_add', body: 'd' },
    ]),
    v => v === true,
    'true',
  );

  assert(
    'JS7 fifth intent rejected by schema shape',
    matchesClassifierResponseSchema([
      { type: 'todo_add', body: 'a' },
      { type: 'todo_add', body: 'b' },
      { type: 'todo_add', body: 'c' },
      { type: 'todo_add', body: 'd' },
      { type: 'todo_add', body: 'e' },
    ]),
    v => v === false,
    'false',
  );

  assert(
    'JS8 invalid type rejected',
    matchesClassifierResponseSchema([{ type: 'list_remove', item: 'x', listName: 'todo' }]),
    v => v === false,
    'false',
  );

  assert(
    'JS9 missing required field rejected',
    matchesClassifierResponseSchema([{ type: 'list_add', items: ['apples'] }]),
    v => v === false,
    'false',
  );

  assert(
    'JS10 optional insurance agent field representable',
    matchesClassifierResponseSchema([
      { type: 'insurance_capture', insType: 'auto', carrier: 'Allstate', agent: 'Sam' },
    ]),
    v => v === true,
    'true',
  );

  assert(
    'JS11 response_format is json_schema strict',
    CLASSIFIER_RESPONSE_FORMAT,
    v => {
      const f = v as { type: string; json_schema?: { strict?: boolean } };
      return f.type === 'json_schema' && f.json_schema?.strict === true;
    },
    'json_schema strict',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ClassifierJsonSchema: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('classifierJsonSchema.test.ts')) {
  runClassifierJsonSchemaTests().catch(console.error);
}
