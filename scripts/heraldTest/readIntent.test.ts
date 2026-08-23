import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeServiceProvider } from '../../src/utils/householdCapture.ts';
import {
  answerHouseholdRead,
  detectHouseholdRead,
} from '../../src/utils/householdRead.ts';
import {
  dispatchReadIntents,
  parseReadIntentsFromClassifier,
  parseReadIntentsFromClassifierWithDiagnostic,
  readIntentToHousehold,
  findGroundedEntitySpansForType,
  validateReadIntent,
  type ReadIntent,
} from '../../src/routing/readIntent.ts';
import { mayInvokeBackendStream } from '../../src/utils/llmClassificationOwnership.ts';
import type { RouteDecision } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_providers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL, created_at TEXT, updated_at TEXT, removed_at TEXT);
  CREATE TABLE IF NOT EXISTS insurance_policies (id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS legal_documents (id TEXT PRIMARY KEY, type TEXT, location TEXT, created_at TEXT, updated_at TEXT, removed_at TEXT);
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db) as ReturnType<typeof makeShim> & object);
  return db;
}

function legalIntent(entity: string, utterance: string, info: ReadIntent['requested_information'] = 'EXISTENCE'): ReadIntent {
  return {
    operation: 'READ',
    domain: 'HOUSEHOLD',
    entity_type: 'legal_document',
    entity,
    requested_information: info,
    raw_phrase: utterance,
    confidence: 'high',
  };
}

function serviceIntent(entity: string, utterance: string): ReadIntent {
  return {
    operation: 'READ',
    domain: 'HOUSEHOLD',
    entity_type: 'service_provider',
    entity,
    requested_information: 'IDENTITY',
    raw_phrase: utterance,
    confidence: 'high',
  };
}

export async function runReadIntentTests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}── ReadIntent Household Slice Tests ──────────────────────${RESET}\n`);

  assert(
    'RI-A1 regex still catches who do we use for pipes',
    detectHouseholdRead('who do we use for pipes'),
    (v) => v !== null && (v as { type: string }).type === 'service_provider',
    'service_provider intent from regex',
  );
  assert(
    'RI-A2 regex still catches who is my plumber',
    detectHouseholdRead('who is my plumber'),
    (v) => v !== null,
    'non-null regex hit',
  );

  for (const phrase of [
    'Do I have a will?',
    'Who do we call for pipes?',
    'Am I on file with a plumber?',
    'Got a will stored anywhere?',
  ]) {
    assert(
      `RI-A3 semantic phrase misses regex: "${phrase}"`,
      detectHouseholdRead(phrase),
      (v) => v === null,
      'null (regex miss)',
    );
  }

  assert(
    'RI-V1 invalid domain fails validation',
    validateReadIntent({
      operation: 'READ',
      domain: 'MEDICAL' as ReadIntent['domain'],
      entity_type: 'legal_document',
      entity: 'will',
      requested_information: 'EXISTENCE',
      raw_phrase: 'Do I have a will?',
      confidence: 'high',
    }),
    (v) => v === null,
    'null',
  );

  const db1 = freshDB();
  db1.prepare("INSERT INTO legal_documents (id,type,location,created_at,updated_at) VALUES ('ld1','will','safe deposit box',datetime('now'),datetime('now'))").run();

  const willExistence = legalIntent('will', 'Do I have a will?');
  const householdWill = readIntentToHousehold(willExistence);
  assert('RI-D1 adapter maps legal will', householdWill, (v) => v?.type === 'legal_document' && v.categories[0] === 'will', 'legal_document will');

  const directAnswer = householdWill ? answerHouseholdRead(householdWill) : '';
  const dispatched = dispatchReadIntents([willExistence]);
  assert(
    'RI-D2 dispatch matches answerHouseholdRead exactly',
    dispatched.status === 'answered' && dispatched.responseText === directAnswer,
    (v) => v === true,
    'same string from deterministic reader',
  );
  assert(
    'RI-D3 existence phrasing returns stored location not model guess',
    dispatched.status === 'answered' ? dispatched.responseText : '',
    (v) => typeof v === 'string' && v.includes('safe deposit box'),
    'includes stored location',
  );

  const db2 = freshDB();
  db2.prepare("INSERT INTO legal_documents (id,type,location,created_at,updated_at) VALUES ('ld2','will','top drawer',datetime('now'),datetime('now'))").run();
  for (const [utterance, entity] of [
    ['Do I have a will?', 'will'],
    ['Got a will stored anywhere?', 'will'],
    ['Am I on file with a will?', 'will'],
  ] as const) {
    const out = dispatchReadIntents([legalIntent(entity, utterance)]);
    assert(
      `RI-D4 phrasing "${utterance}" → deterministic answer`,
      out.status === 'answered' ? out.responseText : '',
      (v) => typeof v === 'string' && v.includes('top drawer'),
      'includes top drawer',
    );
  }

  freshDB();
  writeServiceProvider('plumber', 'Rosa', '555-0100');
  const pipesOut = dispatchReadIntents([serviceIntent('pipes', 'Who do we call for pipes?')]);
  assert(
    'RI-D5 pipes semantic → Rosa from DB',
    pipesOut.status === 'answered' ? pipesOut.responseText : '',
    (v) => typeof v === 'string' && v.includes('Rosa'),
    'includes Rosa',
  );

  freshDB();
  const gapOut = dispatchReadIntents([legalIntent('will', 'Do I have a will?')]);
  assert(
    'RI-D6 empty DB honest gap',
    gapOut.status === 'answered' ? gapOut.responseText : '',
    (v) => typeof v === 'string' && (v as string).startsWith("I don't have"),
    'gap message',
  );

  const lowOut = dispatchReadIntents([{ ...willExistence, confidence: 'low' }]);
  assert(
    'RI-D7 low confidence clarifies',
    lowOut,
    (v) => (v as { status: string }).status === 'clarify' && !(v as { responseText: string }).responseText.includes('safe'),
    'clarify without fabricated fact',
  );

  const missOut = dispatchReadIntents([{
    ...willExistence,
    entity: 'nonexistent-doc-type',
    raw_phrase: 'Do I have a nonexistent-doc-type?',
  }]);
  assert('RI-D8 dispatch miss clarifies', missOut.status, (v) => v === 'clarify', 'clarify');

  assert('RI-D9 readLabeled empty → clarify', dispatchReadIntents([], { readLabeled: true }).status, (v) => v === 'clarify', 'clarify');

  const backendBlocked: RouteDecision = {
    kind: 'backend',
    tier: 3,
    reason: 'default',
    readMeta: { readIntents: [], readLabeled: true },
  };
  assert('RI-T1 readLabeled blocks backend stream', mayInvokeBackendStream(backendBlocked), (v) => v === false, 'false');
  assert('RI-T2 live:data without readLabeled may backend', mayInvokeBackendStream({ kind: 'backend', tier: 3, reason: 'live:data' }), (v) => v === true, 'true');

  const rawJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"EXISTENCE","raw_phrase":"Do I have a will?","confidence":"high"}]';
  const parsed = parseReadIntentsFromClassifier(rawJson, 'Do I have a will?');
  assert('RI-P1 parse emits readLabeled', parsed.readLabeled, (v) => v === true, 'true');
  assert('RI-P2 parse validates ReadIntent', parsed.readIntents[0]?.entity, (v) => v === 'will', 'will');
  assert(
    'RI-P3 parse drops ungrounded entity',
    parseReadIntentsFromClassifier(rawJson, 'Something else entirely').readIntents.length,
    (v) => v === 0,
    '0',
  );

  const db3 = freshDB();
  writeServiceProvider('plumber', 'Rosa', '555-0100');
  db3.prepare("INSERT INTO legal_documents (id,type,location,created_at,updated_at) VALUES ('ld3','will','desk',datetime('now'),datetime('now'))").run();
  const plural = dispatchReadIntents([
    serviceIntent('plumber', 'Who is my plumber and do I have a will?'),
    legalIntent('will', 'Who is my plumber and do I have a will?'),
  ]);
  assert(
    'RI-P4 plural ReadIntent[] answers both',
    plural.status === 'answered' ? plural.responseText : '',
    (v) => typeof v === 'string' && v.includes('Rosa') && v.includes('desk'),
    'Rosa and desk',
  );

  assert('RI-S1 ReadIntent shape has no answer slot', Object.keys(willExistence).includes('answer'), (v) => v === false, 'false');

  // F-4: requested_information is a semantic hint only — dispatch key is (domain, entity_type).
  {
    const existence = legalIntent('will', 'Do I have a will?', 'EXISTENCE');
    const location = legalIntent('will', 'Where is my will?', 'LOCATION');
    const enumeration = legalIntent('will', 'Do I have a will on file?', 'ENUMERATION');
    const hExist = readIntentToHousehold(existence);
    const hLoc = readIntentToHousehold(location);
    const hEnum = readIntentToHousehold(enumeration);
    assert(
      'RI-F4 requested_information does not change household adapter mapping',
      JSON.stringify(hExist) === JSON.stringify(hLoc) && JSON.stringify(hLoc) === JSON.stringify(hEnum),
      (v) => v === true,
      'identical HouseholdReadIntent for EXISTENCE/LOCATION/ENUMERATION',
    );
    const outExist = dispatchReadIntents([existence]);
    const outLoc = dispatchReadIntents([location]);
    assert(
      'RI-F4 differing requested_information yields same deterministic reader answer',
      outExist.status === 'answered' && outLoc.status === 'answered' && outExist.responseText === outLoc.responseText,
      (v) => v === true,
      'same answerHouseholdRead output',
    );
  }

  // F-5: verbatim surface entity → deterministic synonym resolution; classifier cannot author stored category.
  {
    const pipesIntent = serviceIntent('pipes', 'Who do we call for pipes?');
    const adapted = readIntentToHousehold(pipesIntent);
    assert(
      'RI-F5 surface entity pipes resolves to plumber categories via SERVICE_SYNONYMS',
      adapted?.categories,
      (v) => JSON.stringify(v) === JSON.stringify(['plumber']),
      '["plumber"]',
    );
    assert(
      'RI-F5 spoken remains verbatim surface word not stored category',
      adapted?.spoken,
      (v) => v === 'pipes',
      'pipes',
    );
    const bypassJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const bypassParse = parseReadIntentsFromClassifier(bypassJson, 'Who do we call for pipes?');
    assert(
      'RI-F5 classifier category plumber ignored — utterance surface pipes accepted',
      bypassParse.readIntents[0]?.entity,
      (v) => v === 'pipes',
      'pipes from utterance, not classifier plumber',
    );
    const groundedJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"pipes","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const groundedParse = parseReadIntentsFromClassifier(groundedJson, 'Who do we call for pipes?');
    assert(
      'RI-F5 grounded surface entity pipes accepted and resolves through adapter',
      groundedParse.readIntents[0]?.entity,
      (v) => v === 'pipes',
      'pipes',
    );
  }

  // TEMP diagnostic sidecar — parse outcomes must remain identical.
  {
    const utterance = 'Who do we call for pipes?';
    const groundedJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"pipes","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const plain = parseReadIntentsFromClassifier(groundedJson, utterance);
    const { meta, diagnostic } = parseReadIntentsFromClassifierWithDiagnostic(groundedJson, utterance);
    assert(
      'RI-DG1 diagnostic meta matches plain parse',
      JSON.stringify(plain) === JSON.stringify(meta),
      (v) => v === true,
      'identical ReadIntentMeta',
    );
    assert(
      'RI-DG1 diagnostic parsedCount matches readIntents.length',
      diagnostic.parsedCount,
      (v) => v === meta.readIntents.length,
      String(meta.readIntents.length),
    );

    const bypassJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const bypassDiag = parseReadIntentsFromClassifierWithDiagnostic(bypassJson, utterance);
    assert(
      'RI-DG2 utterance surface pipes accepted despite classifier plumber',
      bypassDiag.meta.readIntents[0]?.entity,
      (v) => v === 'pipes',
      'pipes',
    );
    assert(
      'RI-DG2 parsedCount 1 when utterance grounds pipes',
      bypassDiag.diagnostic.parsedCount,
      (v) => v === 1,
      '1',
    );

    const badDomainJson = '[{"type":"read","domain":"MEDICAL","entity_type":"service_provider","entity":"pipes","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const badDomainDiag = parseReadIntentsFromClassifierWithDiagnostic(badDomainJson, utterance);
    assert(
      'RI-DG3 invalid registry drop reason',
      badDomainDiag.diagnostic.dropped[0]?.reason,
      (v) => v === 'invalid_registry',
      'invalid_registry',
    );

    const lowJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"EXISTENCE","raw_phrase":"Do I have a will?","confidence":"low"}]';
    const lowPlain = parseReadIntentsFromClassifier(lowJson, 'Do I have a will?');
    assert(
      'RI-DG4 low confidence still parses (behavior unchanged)',
      lowPlain.readIntents[0]?.confidence,
      (v) => v === 'low',
      'low',
    );

    const longRaw = `[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"pipes","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]${' '.repeat(600)}`;
    const truncDiag = parseReadIntentsFromClassifierWithDiagnostic(longRaw, utterance);
    assert(
      'RI-DG5 rawJson truncated for diagnostic log',
      truncDiag.diagnostic.rawJson !== null && (truncDiag.diagnostic.rawJson as string).length <= 513,
      (v) => v === true,
      'truncated rawJson',
    );
  }

  // V1 — deterministic entity grounding: LLM slot, Herald value.
  {
    const utterance = 'Who do I call for plumbing?';
    const deviceJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"pipes","requested_information":"IDENTITY","raw_phrase":"Who do we call for pipes?","confidence":"high"}]';
    const parsed = parseReadIntentsFromClassifier(deviceJson, utterance);
    assert(
      'RI-VG1 device reproduction accepts plumbing not classifier pipes',
      parsed.readIntents[0]?.entity,
      (v) => v === 'plumbing',
      'plumbing',
    );
    assert(
      'RI-VG1 raw_phrase is original utterance',
      parsed.readIntents[0]?.raw_phrase,
      (v) => v === utterance,
      utterance,
    );
    assert(
      'RI-VG1 readLabeled with one parsed intent',
      parsed.readLabeled && parsed.readIntents.length === 1,
      (v) => v === true,
      'readLabeled true, length 1',
    );
    freshDB();
    writeServiceProvider('plumber', 'Rosa', '555-0100');
    const dispatchOut = dispatchReadIntents(parsed.readIntents);
    assert(
      'RI-VG1 plumbing maps to stored plumber via SERVICE_SYNONYMS',
      dispatchOut.status === 'answered' ? dispatchOut.responseText : '',
      (v) => typeof v === 'string' && v.includes('Rosa'),
      'includes Rosa',
    );

    const hvacUtterance = 'Who do I call for HVAC?';
    const hvacJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"heating","requested_information":"IDENTITY","raw_phrase":"Who do we call for heating?","confidence":"high"}]';
    const hvacParsed = parseReadIntentsFromClassifier(hvacJson, hvacUtterance);
    assert(
      'RI-VG2 non-plumbing service accepts uttered HVAC not classifier heating',
      hvacParsed.readIntents[0]?.entity,
      (v) => v === 'HVAC',
      'HVAC',
    );

    const willUtterance = 'Do I have a will?';
    const willJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"trust","requested_information":"EXISTENCE","raw_phrase":"Do we have a trust?","confidence":"high"}]';
    const willParsed = parseReadIntentsFromClassifier(willJson, willUtterance);
    assert(
      'RI-VG3 legal accepts uttered will not classifier trust',
      willParsed.readIntents[0]?.entity,
      (v) => v === 'will',
      'will',
    );
    assert(
      'RI-VG3 legal raw_phrase is original utterance',
      willParsed.readIntents[0]?.raw_phrase,
      (v) => v === willUtterance,
      willUtterance,
    );

    const leakJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who fixes that leak?","confidence":"high"}]';
    const leakParsed = parseReadIntentsFromClassifier(leakJson, 'Who fixes that leak?');
    assert(
      'RI-VG4 no registry span in utterance fails closed',
      leakParsed.readIntents.length,
      (v) => v === 0,
      '0 parsed',
    );
    assert(
      'RI-VG4 readLabeled still true on drop',
      leakParsed.readLabeled,
      (v) => v === true,
      'true',
    );

    const ambiguousUtterance = 'Who is my plumber and who fixes my HVAC?';
    const ambiguousJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and who fixes my HVAC?","confidence":"high"}]';
    const ambiguousParsed = parseReadIntentsFromClassifier(ambiguousJson, ambiguousUtterance);
    assert(
      'RI-VG5 one service read with two grounded spans fails closed',
      ambiguousParsed.readIntents.length,
      (v) => v === 0,
      '0 parsed',
    );
    assert(
      'RI-VG5 span inventory shows two service candidates',
      findGroundedEntitySpansForType(ambiguousUtterance, 'service_provider').length,
      (v) => v === 2,
      '2 spans',
    );

    const compoundUtterance = 'Who is my plumber and do I have a will?';
    const compoundJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and do I have a will?","confidence":"high"},{"type":"read","domain":"HOUSEHOLD","entity_type":"legal_document","entity":"will","requested_information":"EXISTENCE","raw_phrase":"Who is my plumber and do I have a will?","confidence":"high"}]';
    const compoundParsed = parseReadIntentsFromClassifier(compoundJson, compoundUtterance);
    assert(
      'RI-VG6 different-type compound parse assigns plumber and will',
      compoundParsed.readIntents.map((i) => i.entity).join(','),
      (v) => v === 'plumber,will',
      'plumber,will',
    );
    assert(
      'RI-VG6 compound raw_phrase preserved on both',
      compoundParsed.readIntents.every((i) => i.raw_phrase === compoundUtterance),
      (v) => v === true,
      'both match utterance',
    );

    const twoServiceUtterance = 'Who is my plumber and who fixes my HVAC?';
    const twoServiceJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"HVAC","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and who fixes my HVAC?","confidence":"high"},{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and who fixes my HVAC?","confidence":"high"}]';
    const reversedJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumber","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and who fixes my HVAC?","confidence":"high"},{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"HVAC","requested_information":"IDENTITY","raw_phrase":"Who is my plumber and who fixes my HVAC?","confidence":"high"}]';
    const twoServiceParsed = parseReadIntentsFromClassifier(twoServiceJson, twoServiceUtterance);
    const reversedParsed = parseReadIntentsFromClassifier(reversedJson, twoServiceUtterance);
    assert(
      'RI-VG7 two same-type service reads fail closed even when span count matches',
      twoServiceParsed.readIntents.length,
      (v) => v === 0,
      '0 parsed',
    );
    assert(
      'RI-VG7 reversed classifier order also fails closed (no order attribution)',
      reversedParsed.readIntents.length,
      (v) => v === 0,
      '0 parsed',
    );
    assert(
      'RI-VG7 readLabeled true with zero parsed same-type compound',
      twoServiceParsed.readLabeled && twoServiceParsed.readIntents.length === 0,
      (v) => v === true,
      'readLabeled true, 0 parsed',
    );
  }

  const total = passed + failures.length;
  return { passed, failed: failures.length, total, failures };
}
