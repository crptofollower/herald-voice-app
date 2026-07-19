// scripts/heraldTest/familyContract.test.ts
// Family read contract — detectFamilyRead + answerFamilyRead against contacts.
//
// NOTE: The contacts DDL below is a hand-maintained replica of production
// schema.ts (through v17). If production adds a contacts column, this must be
// updated — otherwise tests pass while production drifts.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { detectFamilyCapture } from '../../src/utils/familyCapture.ts';
import { writeContact } from '../../src/db/contactsDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
`;
function makeShim(db) {
  return {
    getAllSync: (s, p = []) => db.prepare(s).all(...p),
    getFirstSync: (s, p = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}
function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function addContact(db, name, relationship, location = null, importance = 5) {
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, location, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'));`,
  ).run('c_' + Math.random().toString(36).slice(2), name, relationship, location, importance);
}

export async function runFamilyContractTests() {
  const failures = [];
  let passed = 0;
  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}? PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}? FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Family Contract Tests ---------------------------------${RESET}\n`);

  // F1 typed single: seed Shannon/wife → includes Shannon
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    const answer = answerFamilyRead(detectFamilyRead('who is my wife')!);
    assert('F1 typed single includes Shannon', answer, (v) => v.includes('Shannon'), 'includes "Shannon"');
  }

  // F2 typed multiple (no LIMIT 1): Hunter + Grant both sons
  {
    const db = freshDB();
    addContact(db, 'Hunter', 'son');
    addContact(db, 'Grant', 'son');
    const intent = detectFamilyRead('who are my sons');
    assert('F2a detectFamilyRead fires for sons', intent, (v) => v !== null, 'non-null intent');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F2b includes Hunter and Grant', answer, (v) => v.includes('Hunter') && v.includes('Grant'), 'includes both names');
  }

  // F3 NULL-location safe: NYC on Hunter, null on Grant — no literal "null"
  {
    const db = freshDB();
    addContact(db, 'Hunter', 'son', 'New York City');
    addContact(db, 'Grant', 'son', null);
    const intent = detectFamilyRead('who are my sons');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F3a includes New York City', answer, (v) => v.includes('New York City'), 'includes "New York City"');
    assert('F3b includes Grant', answer, (v) => v.includes('Grant'), 'includes "Grant"');
    assert('F3c no literal null', answer, (v) => !v.toLowerCase().includes('null'), 'no "null"');
  }

  // F4 de-dupe by person: Shannon/wife twice → Shannon once
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    addContact(db, 'Shannon', 'wife');
    const answer = answerFamilyRead(detectFamilyRead('who is my wife')!);
    const count = (answer.match(/Shannon/g) || []).length;
    assert('F4 Shannon appears exactly once', count, (v) => v === 1, 'count === 1');
  }

  // F5 honest miss: empty DB
  {
    freshDB();
    const intent = detectFamilyRead('who is my wife');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F5a gap message', answer, (v) => v.startsWith("I don't have"), "starts with I don't have");
    assert('F5b no fabricated name', answer, (v) => !v.includes('Shannon'), 'no "Shannon"');
  }

  // F6 D2 statement guard: declarative capture phrase → null
  {
    freshDB();
    assert('F6 statement guard returns null', detectFamilyRead('my son Grant lives in Dallas'), (v) => v === null, 'null');
  }

  // F7 typeless overview: Shannon/wife + Hunter/son
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    addContact(db, 'Hunter', 'son');
    const intent = detectFamilyRead('tell me about my family');
    assert('F7a overview relation null', intent, (v) => v !== null && v.relation === null, 'relation === null');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F7b includes Shannon and Hunter', answer, (v) => v.includes('Shannon') && v.includes('Hunter'), 'includes both names');
  }

  // F8 synonym: Barbara/mom → who is my mother
  {
    const db = freshDB();
    addContact(db, 'Barbara', 'mom');
    const answer = answerFamilyRead(detectFamilyRead('who is my mother')!);
    assert('F8 synonym mother includes Barbara', answer, (v) => v.includes('Barbara'), 'includes "Barbara"');
  }

  // ── Capture detector (Build 50 — detectFamilyCapture, single member) ──
  const capRel  = (r) => (v) => v.length === 1 && v[0].type === 'family_capture' && v[0].relation === r[0] && v[0].name === r[1];
  const capNone = (v) => Array.isArray(v) && v.length === 0;

  assert('C1 my son is Michael',        detectFamilyCapture('my son is Michael'),        capRel(['son','Michael']),      'son/Michael');
  assert('C2 my daughter is Sarah',     detectFamilyCapture('my daughter is Sarah'),     capRel(['daughter','Sarah']),   'daughter/Sarah');
  assert("C3 my mom's name is Barbara", detectFamilyCapture("my mom's name is Barbara"), capRel(['mom','Barbara']),      'mom/Barbara');
  assert('C4 my son David lives in Austin', detectFamilyCapture('my son David lives in Austin'), capRel(['son','David']), 'son/David');
  assert('C5 my wife is Shannon',       detectFamilyCapture('my wife is Shannon'),       capRel(['wife','Shannon']),     'wife/Shannon');
  assert('C6 father-in-law David lives in Little Elm Texas', detectFamilyCapture('my father-in-law David lives in Little Elm Texas'), capRel(['father-in-law','David']), 'father-in-law/David');
  assert('C7 location deferred (no location field)', detectFamilyCapture('my son David lives in Austin'), (v) => v.length === 1 && v[0].location === undefined, 'location undefined');
  assert('C8 read guard: who is my wife', detectFamilyCapture('who is my wife'),          capNone, '[]');
  assert("C9 read guard: what's my son's name", detectFamilyCapture("what's my son's name"), capNone, '[]');
  assert('C10 compound: my two sons Grant and Tyler', detectFamilyCapture('my two sons Grant and Tyler'), capNone, '[]');
  assert('C11 compound: my sons are Grant and Tyler', detectFamilyCapture('my sons are Grant and Tyler'), capNone, '[]');
  assert('C12 not family: my plumber is Joe', detectFamilyCapture('my plumber is Joe'),   capNone, '[]');
  assert('C13 grocery: add milk to my list', detectFamilyCapture('add milk to my list'),  capNone, '[]');

  assert("C14 filler name: my wife's name is also Shannon", detectFamilyCapture("my wife's name is also Shannon"), capRel(['wife','Shannon']), 'wife/Shannon (never "also")');
  assert('C15 filler name: my son is just David', detectFamilyCapture('my son is just David'), capRel(['son','David']), 'son/David (never "just")');
  assert("C16 filler-only defers (no real name)", detectFamilyCapture("my wife's name is also"), capNone, '[]');

  // ── BUG D — "I have a/another {relation} named {Name}" (ordinary 65+ speech;
  //    missed on-device S53, fell to generic fallback with zero capture) ──
  assert('C17 I have a son named Hunter', detectFamilyCapture('I have a son named Hunter'), capRel(['son','Hunter']), 'son/Hunter');
  assert('C18 I have another son named Grant', detectFamilyCapture('I have another son named Grant'), capRel(['son','Grant']), 'son/Grant');
  // Guard: the new pattern must NOT half-capture a compound (silent loss of the
  // second person is worse than deferring both — compounds are Session W territory,
  // same deferral as C10/C11).
  assert('C19 compound named-form defers', detectFamilyCapture('I have a son named Hunter and another son named Grant'), capNone, '[]');

  // Same-relation named list — both sons captured (not deferred to empty []).
  assert('C20 same-relation named list: Grant and Hunter',
    detectFamilyCapture('I have two sons, one named Grant and one named Hunter'),
    (v) => Array.isArray(v)
      && v.length === 2
      && v.every((i) => i.type === 'family_capture' && i.relation === 'son')
      && v.some((i) => i.name === 'Grant')
      && v.some((i) => i.name === 'Hunter'),
    'two family_capture records: Grant + Hunter');

  // ── Writer collision (BUG B — same name, two relationships) ──
  {
    freshDB();
    writeContact({ name: 'Shannon', relationship: 'wife', importance: 7 });
    writeContact({ name: 'Shannon', relationship: 'daughter', importance: 7 });
    const wife = answerFamilyRead(detectFamilyRead('who is my wife')!);
    const daughter = answerFamilyRead(detectFamilyRead('who is my daughter')!);
    assert('W1 wife survives same-name daughter', wife, (v) => v.includes('Shannon'), 'wife still Shannon');
    assert('W2 daughter also captured', daughter, (v) => v.includes('Shannon'), 'daughter is Shannon');
  }
  {
    freshDB();
    writeContact({ name: 'Shannon', relationship: 'wife', importance: 7 });
    writeContact({ name: 'Shannon', relationship: 'wife', importance: 7 });
    const wife = answerFamilyRead(detectFamilyRead('who is my wife')!);
    assert('W3 same rel twice = no dup', (wife.match(/Shannon/g) || []).length, (v) => v === 1, 'count === 1');
  }

  // ── Overview de-dupe (BUG C — two people sharing a name collapse in the
  //    typeless overview; reader keyed on name alone, writer keys name+rel) ──
  {
    freshDB();
    writeContact({ name: 'Shannon', relationship: 'wife', importance: 7 });
    writeContact({ name: 'Shannon', relationship: 'daughter', importance: 7 });
    const overview = answerFamilyRead(detectFamilyRead('tell me about my family')!);
    assert('F9a overview shows both relationships', overview,
      (v) => v.includes('wife') && v.includes('daughter'),
      'includes "wife" and "daughter"');
    assert('F9b overview lists Shannon twice (two people)', 
      (overview.match(/Shannon/g) || []).length,
      (v) => v === 2, 'count === 2');
  }

  // ── In-law read-back (compound must not truncate to root; overview includes) ──
  {
    const db = freshDB();
    addContact(db, 'Robert', 'father');
    addContact(db, 'David Clevenger', 'father-in-law');
    const intent = detectFamilyRead('who is my father-in-law');
    assert('F10a detect keeps father-in-law compound (not truncated to father)',
      intent,
      (v) => v !== null && v.relation === 'father-in-law',
      'relation === father-in-law');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F10b father-in-law read returns Clevenger, not plain father Robert',
      answer,
      (v) => v.includes('David Clevenger') && !v.includes('Robert'),
      'includes Clevenger, excludes Robert');
  }
  {
    const db = freshDB();
    addContact(db, 'David Clevenger', 'father-in-law');
    const overview = answerFamilyRead(detectFamilyRead('tell me about my family')!);
    assert('F11 overview includes father-in-law',
      overview,
      (v) => v.includes('David Clevenger') && /father-in-law/i.test(v),
      'names Clevenger as father-in-law');
  }
  {
    const db = freshDB();
    addContact(db, 'David Clevenger', 'father-in-law');
    const intent = detectFamilyRead('who is my father');
    assert('F12a plain father detect stays father (not father-in-law)',
      intent,
      (v) => v !== null && v.relation === 'father',
      'relation === father');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F12b plain father does not match father-in-law contact',
      answer,
      (v) => !v.includes('David Clevenger') && /don't have your father/i.test(v),
      'honest miss — FIL is a distinct relation');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('familyContract.test.mjs')) {
  runFamilyContractTests().catch(console.error);
}
