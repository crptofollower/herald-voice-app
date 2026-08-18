// scripts/heraldTest/classifierParse.test.ts
// Classifier parse / verbatim / vocab contract — pure functions only.
// No llama.rn, no live model, no DB writes. WALL-1 style counters.
//
import {
  extractJsonArray,
  buildClassifierVocab,
  verifyVerbatim,
  parseClassifierOutput,
  type IntentRecord,
} from '../../src/hooks/llmLayers.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

export async function runClassifierParseTests() {
  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    if (cond) passed++;
    else failures.push(label);
  };

  const vocab = buildClassifierVocab(['grocery', 'todo', 'costco']);

  // ── extractJsonArray ──────────────────────────────────────────────────────
  check('1. array literal returns array string',
    extractJsonArray('[{"type":"pass"}]') === '[{"type":"pass"}]');
  check('2. bare object wrapped as array',
    extractJsonArray('{"type":"pass"}') === '[{"type":"pass"}]');
  check('3. no json → null', extractJsonArray('no json here') === null);
  check('4. prose around array → array portion',
    extractJsonArray('Sure! [{"type":"pass"}] hope that helps') === '[{"type":"pass"}]');

  // ── parseClassifierOutput structure ───────────────────────────────────────
  {
    const out = parseClassifierOutput(
      '{"type":"list_add","items":["apples"],"listName":"grocery"}',
      'I need apples',
      vocab,
    );
    check('5. legacy single list_add → 1 record',
      out.length === 1 && out[0].type === 'list_add'
      && out[0].type === 'list_add' && out[0].items[0].toLowerCase().includes('apple'));
  }
  {
    const raw = JSON.stringify([
      { type: 'medical_capture', drug: 'lisinopril', dosage: '5mg', raw: "I'm taking lisinopril 5mg and I need apples" },
      { type: 'list_add', items: ['apples'], listName: 'grocery' },
    ]);
    const out = parseClassifierOutput(raw, "I'm taking lisinopril 5mg and I need apples", vocab);
    check('6. two-element array → 2 records order preserved',
      out.length === 2 && out[0].type === 'medical_capture' && out[1].type === 'list_add');
  }
  {
    const six = Array.from({ length: 6 }, (_, i) => ({
      type: 'list_add' as const,
      items: [`item${i}`],
      listName: 'grocery',
    }));
    const utterance = six.map(s => s.items[0]).join(' and ');
    const out = parseClassifierOutput(JSON.stringify(six), `I need ${utterance}`, vocab);
    check('7. six list_add → cap 4 (W2c)', out.length === 4);
  }
  {
    const raw = JSON.stringify([
      { type: 'not_a_real_type', foo: 1 },
      { type: 'list_add', items: ['apples'], listName: 'grocery' },
    ]);
    const out = parseClassifierOutput(raw, 'I need apples', vocab);
    check('8. unknown type dropped, sibling list_add survives',
      out.length === 1 && out[0].type === 'list_add');
  }
  check('9. pass-only array → []',
    parseClassifierOutput('[{"type":"pass"}]', 'hello', vocab).length === 0);
  check('10. incomplete medical_capture (no drug) dropped',
    parseClassifierOutput(
      '{"type":"medical_capture","dosage":"5mg","raw":"I take 5mg"}',
      'I take 5mg',
      vocab,
    ).length === 0);
  check('11. every element invalid → []',
    parseClassifierOutput(
      '[{"type":"pass"},{"type":"medical_capture","raw":"x"}]',
      'x',
      vocab,
    ).length === 0);

  // ── verbatim table (verifyVerbatim) ───────────────────────────────────────
  const vv = (rec: IntentRecord, utt: string) => verifyVerbatim(rec, utt);

  check('12. drug PASS', !!vv({ type: 'medical_capture', drug: 'lisinopril', raw: 'I take lisinopril' }, 'I take lisinopril'));
  check('13. drug FABRICATION', vv({ type: 'medical_capture', drug: 'ibuprofen', raw: 'I take lisinopril' }, 'I take lisinopril') === null);

  check('14. dosage PASS', !!vv({ type: 'medical_capture', drug: 'lisinopril', dosage: '5mg', raw: 'lisinopril 5mg' }, 'lisinopril 5mg'));
  check('15. dosage FABRICATION', vv({ type: 'medical_capture', drug: 'lisinopril', dosage: '10mg', raw: 'lisinopril 5mg' }, 'lisinopril 5mg') === null);

  check('16. frequency PASS', !!vv({ type: 'medical_capture', drug: 'metformin', frequency: 'daily', raw: 'metformin daily' }, 'metformin daily'));
  check('17. frequency FABRICATION', vv({ type: 'medical_capture', drug: 'metformin', frequency: 'weekly', raw: 'metformin daily' }, 'metformin daily') === null);

  check('18. name PASS', !!vv({ type: 'phone_capture', name: 'Joe', phone: '555-0100' }, 'Joe 555-0100'));
  check('19. name FABRICATION', vv({ type: 'phone_capture', name: 'Bob', phone: '555-0100' }, 'Joe 555-0100') === null);

  check('20. phone PASS', !!vv({ type: 'phone_capture', name: 'Joe', phone: '555-0100' }, 'Joe at 555-0100'));
  check('21. phone FABRICATION', vv({ type: 'phone_capture', name: 'Joe', phone: '555-9999' }, 'Joe at 555-0100') === null);

  check('22. address PASS', !!vv({ type: 'address_capture', name: 'Joe', address: 'Main Street' }, 'Joe lives on Main Street'));
  check('23. address FABRICATION', vv({ type: 'address_capture', name: 'Joe', address: 'Oak Avenue' }, 'Joe lives on Main Street') === null);

  // ── P4c (LLM_LIVE 2026-07-07): list_remove / todo_complete not classifier vocabulary ──
  check('24. P4c list_remove JSON dropped by parseClassifierOutput',
    parseClassifierOutput(
      '{"type":"list_remove","item":"milk","listName":"grocery"}',
      'I got the milk',
      vocab,
    ).length === 0);
  check('25. P4c todo_complete JSON dropped by parseClassifierOutput',
    parseClassifierOutput(
      '{"type":"todo_complete","hint":"called dentist"}',
      'I called the dentist',
      vocab,
    ).length === 0);
  check('26. P4c compound array drops list_remove, sibling list_add survives', (() => {
    const out = parseClassifierOutput(
      '[{"type":"list_remove","item":"tonight","listName":"todo"},{"type":"list_add","items":["milk"],"listName":"grocery"}]',
      'I got milk tonight',
      vocab,
    );
    return out.length === 1 && out[0]?.type === 'list_add';
  })());

  check('27. items[] PASS', !!vv({ type: 'list_add', items: ['apples', 'oranges'], listName: 'grocery' }, 'I need apples and oranges'));
  check('28. items[] FABRICATION', vv({ type: 'list_add', items: ['apples', 'bananas'], listName: 'grocery' }, 'I need apples and oranges') === null);

  check('29. body PASS', !!vv({ type: 'todo_add', body: 'call the dentist' }, 'remind me to call the dentist'));
  check('30. body FABRICATION', vv({ type: 'todo_add', body: 'call the bank' }, 'remind me to call the dentist') === null);

  check('31. carrier PASS', !!vv({ type: 'insurance_capture', insType: 'auto', carrier: 'Allstate' }, 'my auto insurance is Allstate'));
  check('32. carrier FABRICATION', vv({ type: 'insurance_capture', insType: 'auto', carrier: 'Geico' }, 'my auto insurance is Allstate') === null);

  check('33. condition PASS', !!vv({ type: 'diagnosis_capture', condition: 'diabetes', raw: 'I have diabetes' }, 'I have diabetes'));
  check('34. condition FABRICATION', vv({ type: 'diagnosis_capture', condition: 'asthma', raw: 'I have diabetes' }, 'I have diabetes') === null);

  check('35. doctor_name PASS', !!vv({ type: 'medical_visit', doctor_name: 'Dr. Reyes', raw: 'I saw Dr. Reyes' }, 'I saw Dr. Reyes'));
  check('36. doctor_name FABRICATION', vv({ type: 'medical_visit', doctor_name: 'Dr. Smith', raw: 'I saw Dr. Reyes' }, 'I saw Dr. Reyes') === null);

  check('37. advice PASS', !!vv({ type: 'medical_visit', specialty: 'doctor', advice: 'cut salt', raw: 'cut salt' }, 'my doctor said cut salt'));
  check('38. advice FABRICATION', vv({ type: 'medical_visit', specialty: 'doctor', advice: 'exercise more', raw: 'cut salt' }, 'my doctor said cut salt') === null);

  check('39. location PASS', !!vv({ type: 'family_capture', relation: 'son', name: 'Michael', location: 'Austin' }, 'my son Michael lives in Austin'));
  check('40. location FABRICATION', vv({ type: 'family_capture', relation: 'son', name: 'Michael', location: 'Dallas' }, 'my son Michael lives in Austin') === null);

  check('41. raw PASS', !!vv({ type: 'medical_capture', drug: 'metformin', raw: 'I take metformin' }, 'I take metformin'));

  {
    const got = vv({ type: 'medical_capture', drug: 'Lisinopril', dosage: '5mg', raw: 'i take lisinopril 5mg' }, 'i take lisinopril 5mg');
    check('42. casing rewrite — drug span is lowercase from utterance',
      !!got && got.type === 'medical_capture' && got.drug === 'lisinopril');
  }
  {
    const got = vv({ type: 'medical_capture', drug: 'lisinopril', dosage: '10mg', raw: 'lisinopril 10 mg' }, 'lisinopril 10 mg');
    check('43. whitespace collapse — stored dosage is raw span "10 mg"',
      !!got && got.type === 'medical_capture' && got.dosage === '10 mg');
  }
  {
    const ok = vv({ type: 'phone_capture', name: 'Joe', phone: '5550100' }, 'call Joe at 555-0100');
    const bad = vv({ type: 'phone_capture', name: 'Joe', phone: '5550100' }, 'call Joe please');
    check('44. phone digits-only match / lack of digits drops',
      !!ok && ok.type === 'phone_capture' && bad === null);
  }
  check('45. one fabricated items[] element drops entire list_add',
    vv({ type: 'list_add', items: ['apples', 'unicorn dust'], listName: 'grocery' }, 'I need apples') === null);

  // ── routing vocab ─────────────────────────────────────────────────────────
  check('46. category hvac accepted',
    parseClassifierOutput(
      '{"type":"service_capture","category":"hvac","name":"Ed"}',
      'my hvac guy is Ed',
      vocab,
    ).length === 1);
  check('47. category astronaut dropped',
    parseClassifierOutput(
      '{"type":"service_capture","category":"astronaut","name":"Ed"}',
      'my astronaut guy is Ed',
      vocab,
    ).length === 0);
  check('48. insType auto accepted',
    parseClassifierOutput(
      '{"type":"insurance_capture","insType":"auto","carrier":"Geico"}',
      'my auto insurance is Geico',
      vocab,
    ).length === 1);
  check('49. insType boat dropped',
    parseClassifierOutput(
      '{"type":"insurance_capture","insType":"boat","carrier":"Geico"}',
      'my boat insurance is Geico',
      vocab,
    ).length === 0);
  check('50. relation father-in-law accepted',
    parseClassifierOutput(
      '{"type":"family_capture","relation":"father-in-law","name":"David"}',
      'David is my father-in-law',
      vocab,
    ).length === 1);
  check('51. relation stepson accepted (step forms)',
    parseClassifierOutput(
      '{"type":"family_capture","relation":"stepson","name":"Sam"}',
      'Sam is my stepson',
      vocab,
    ).length === 1);
  check('52. relation roommate dropped',
    parseClassifierOutput(
      '{"type":"family_capture","relation":"roommate","name":"Sam"}',
      'Sam is my roommate',
      vocab,
    ).length === 0);
  check('53. same-relation split: two sons',
    parseClassifierOutput(
      '[{"type":"family_capture","relation":"son","name":"Grant"},{"type":"family_capture","relation":"son","name":"Hunter"}]',
      'I have two sons, one named Grant and one named Hunter',
      vocab,
    ).length === 2);
  check('54. listName costco (known) accepted',
    parseClassifierOutput(
      '{"type":"list_add","items":["milk"],"listName":"costco"}',
      'add milk to costco',
      vocab,
    ).length === 1);
  check('55. listName medications dropped (finding-5)',
    parseClassifierOutput(
      '{"type":"list_add","items":["metformin"],"listName":"medications"}',
      'add metformin to medications',
      vocab,
    ).length === 0);
  {
    const out = parseClassifierOutput(
      JSON.stringify([
        { type: 'list_add', items: [123], listName: 'grocery' },
        { type: 'list_add', items: ['apples'], listName: 'grocery' },
      ]),
      'I need apples',
      vocab,
    );
    check('56. malformed element throws → dropped, sibling survives',
      out.length === 1 && out[0].type === 'list_add' && out[0].items[0] === 'apples');
  }
  {
    const got = vv(
      { type: 'medical_capture', drug: 'lisinopril', dosage: '10 mg', raw: 'I take Lisinopril 10mg.' },
      'i take lisinopril 10 mg',
    );
    check('57. raw grounded to utterance, not model echo (W3d)',
      !!got && got.type === 'medical_capture'
      && got.raw === 'i take lisinopril 10 mg'
      && got.drug === 'lisinopril');
  }

  // ── P4c: deterministic tier-1 controls unchanged (ActionIntent, not classifier) ──
  {
    const listRm = await classifyQuery('remove oranges from my grocery list');
    check('58. P4c deterministic tier-1 list_remove unchanged',
      listRm.tier === 1
      && listRm.actionIntent?.type === 'list_remove'
      && listRm.reason === 'action:list_remove');
  }
  {
    const todoDone = await classifyQuery('I already called the dentist');
    check('59. P4c deterministic tier-1 todo_complete unchanged',
      todoDone.tier === 1
      && todoDone.actionIntent?.type === 'todo_complete'
      && todoDone.reason === 'action:todo_complete');
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ classifierParse: ${failures.length} failed\x1b[0m`);
    for (const f of failures) console.log(`   \x1b[31m✗ ${f}\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ classifierParse: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}
