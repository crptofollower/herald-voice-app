// scripts/heraldTest/contactsDB.test.ts
// findAllContactMatches contract tests (S-DISCLOSE build arc, C-1).
// Pins the multi-match resolver that feeds contact disambiguation.
//
// Runner: npx tsx scripts/heraldTest/contactsDB.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { findAllContactMatches, nameMatchesQuery, isPersonalDestination, isRelationshipTerm, writeContactRaw, writeContactValidated, stripRelationshipLead, findContactByName, resolvePersonIdentity, contactHasCapability, resolvePersonCapability, setOsPersonCapabilitySearch } from '../../src/db/contactsDB.ts';
import type { Contact } from '../../src/db/contactsDB.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    relationship TEXT,
    phone TEXT,
    address TEXT,
    email TEXT,
    birthday TEXT,
    importance INTEGER DEFAULT 5,
    entity_id TEXT,
    os_contact_id TEXT,
    notes TEXT,
    last_contact TEXT,
    is_emergency INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT
  );
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
  setDB(makeShim(db));
  return db;
}

function insertContact(
  db: Database.Database,
  row: Pick<Contact, 'id' | 'name'> & Partial<Contact> & { removed_at?: string | null },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, address, email, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.address ?? null,
    row.email ?? null,
    row.importance ?? 5,
    row.created_at ?? now,
    row.updated_at ?? now,
    row.removed_at ?? null,
  );
}

export async function runContactsDBTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- findAllContactMatches Contract Tests ------------------${RESET}\n`);

  // ── T-FACM-1: no live rows → [] ───────────────────────────────────────────
  {
    freshDB();
    assert('T-FACM-1 empty contacts table → []',
      findAllContactMatches('daughter'),
      v => Array.isArray(v) && v.length === 0,
      '[]');
  }

  // ── T-FACM-2: single relationship match ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c1', name: 'Emily', relationship: 'daughter', phone: '555-0101', importance: 8 });
    const matches = findAllContactMatches('daughter');
    assert('T-FACM-2 relationship match returns the one live contact',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c1' && v[0].name === 'Emily',
      'one match, id c1');
  }

  // ── T-FACM-3: multiple relationship matches, importance DESC ────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', importance: 3 });
    insertContact(db, { id: 'c_high', name: 'Beth', relationship: 'daughter', importance: 9 });
    const matches = findAllContactMatches('daughter');
    assert('T-FACM-3 two daughters → both returned, higher importance first',
      matches.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v[0] === 'c_high' && v[1] === 'c_low',
      '["c_high","c_low"]');
  }

  // ── T-FACM-4: name partial match (LIKE) ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_sarah', name: 'Sarah Miller', relationship: 'friend' });
    insertContact(db, { id: 'c_other', name: 'Mike', relationship: 'neighbor' });
    const matches = findAllContactMatches('sarah');
    assert('T-FACM-4 name partial match returns Sarah only',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_sarah',
      'one match Sarah Miller');
  }

  // ── T-FACM-5: removed contacts excluded ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_live', name: 'Emily', relationship: 'daughter' });
    insertContact(db, { id: 'c_gone', name: 'Kate', relationship: 'daughter', removed_at: new Date().toISOString() });
    assert('T-FACM-5 removed_at row excluded from matches',
      findAllContactMatches('daughter').map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_live',
      'only c_live');
  }

  // ── T-FACM-6: dual-predicate dedup by id ────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_dedup', name: 'My Daughter', relationship: 'daughter' });
    assert('T-FACM-6 relationship + name both match → one row, not duplicated',
      findAllContactMatches('daughter'),
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_dedup',
      'length 1, id c_dedup');
  }

  // ── T-FACM-7: trim + case-insensitive input ─────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_doc', name: 'Dr. Smith', relationship: 'doctor' });
    const matches = findAllContactMatches('  DOCTOR  ');
    assert('T-FACM-7 trimmed/case input matches relationship exactly',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_doc',
      'one match Dr. Smith');
  }

  // ── T-NMQ-1: reversed word order still matches ──────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'clevenger david');
    assert('T-NMQ-1 reversed order matches',
      result,
      v => v === true,
      'true (S_CONTACT K2 fix)');
  }

  // ── T-NMQ-2: single token still matches ──────────────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'david');
    assert('T-NMQ-2 single token matches',
      result,
      v => v === true,
      'true');
  }

  // ── T-NMQ-3: substring-of-different-word does not false-positive ────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'davidson');
    assert('T-NMQ-3 no false positive on partial word',
      result,
      v => v === false,
      'false');
  }

  // ── T-NMQ-4: null name never matches, never throws ───────────────────────────
  {
    const result = nameMatchesQuery(null, 'david');
    assert('T-NMQ-4 null name returns false',
      result,
      v => v === false,
      'false');
  }

  // ── T-NMQ-5: empty query never matches-all ───────────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', '');
    assert('T-NMQ-5 empty query returns false',
      result,
      v => v === false,
      'false');
  }

  // ── SMS / nav Herald multi-match branch predicates (dispatch.ts mirrors) ──
  // dispatch cannot be imported here (RN). These pin the same pools the arms
  // branch on: sms → findAllContactMatches.filter(phone); nav → unfiltered.
  const smsHeraldPool = (q: string) =>
    findAllContactMatches(q).filter(c => !!c.phone?.trim());
  const navHeraldPool = (q: string) => findAllContactMatches(q);

  // ── T-SMS-H1: multi-Herald-match asks ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_s1', name: 'Sarah Smith', phone: '5551112222', importance: 9 });
    insertContact(db, { id: 'c_s2', name: 'Sarah Jones', phone: '5553334444', importance: 5 });
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H1a two Sarahs both phoned → smsHeraldPool length > 1 (ask which one)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v.includes('c_s1') && v.includes('c_s2'),
      'length 2 both phoned',
    );
  }

  // ── T-SMS-H2: single Herald match executes ────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_only', name: 'Sarah Smith', phone: '5551112222', importance: 9 });
    insertContact(db, { id: 'c_other', name: 'Mike Jones', phone: '5559998888', importance: 5 });
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H2a one phoned Sarah → smsHeraldPool length === 1 (execute openURL)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_only',
      'length 1 c_only',
    );
  }

  // ── T-SMS-H3: zero phoned Herald matches → fall through ───────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_bare1', name: 'Sarah Smith', phone: null, importance: 9 });
    insertContact(db, { id: 'c_bare2', name: 'Sarah Jones', phone: null, importance: 5 });
    const nameHits = findAllContactMatches('Sarah');
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H3a two Sarahs phoneless → smsHeraldPool length 0 (fall through resolveContactPhone)',
      { nameHits: nameHits.length, phonePool: pool.length },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { nameHits: number }).nameHits === 2 &&
        (v as { phonePool: number }).phonePool === 0,
      'name hits 2, phone pool 0',
    );
  }

  // ── T-NAV-H1: plain name collision (both addressed) → ask ─────────────────
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_s1', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    insertContact(db, {
      id: 'c_s2', name: 'Sarah Jones', phone: '5553334444',
      address: '456 Pine Ave', importance: 5,
    });
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H1a two Sarahs both addressed → navHeraldPool length > 1 (ask which one)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v.includes('c_s1') && v.includes('c_s2'),
      'length 2 plain collision',
    );
  }

  // ── T-FACM-8: address completeness must NOT stand in for confirmation ─────
  // Second nav multi-ask instance: only ONE has an address. Pool stays length 2.
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_sarah_addr', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    insertContact(db, {
      id: 'c_sarah_bare', name: 'Sarah Jones', phone: '5553334444',
      address: null, importance: 5,
    });
    const matches = navHeraldPool('Sarah');
    const addressedOnly = matches.filter(c => !!c.address?.trim());
    assert(
      'T-FACM-8a two Sarahs (one addressed) → unfiltered pool length 2 (nav must ask)',
      {
        pool: matches.map(c => c.id),
        addressedTrap: addressedOnly.map(c => c.id),
      },
      v =>
        typeof v === 'object' && v !== null &&
        Array.isArray((v as { pool: string[] }).pool) &&
        (v as { pool: string[] }).pool.length === 2 &&
        (v as { pool: string[] }).pool.includes('c_sarah_addr') &&
        (v as { pool: string[] }).pool.includes('c_sarah_bare') &&
        (v as { addressedTrap: string[] }).addressedTrap.length === 1 &&
        (v as { addressedTrap: string[] }).addressedTrap[0] === 'c_sarah_addr',
      'pool both Sarahs; addressed-only trap is Sarah Smith alone',
    );
  }

  // ── T-NAV-H2: single Herald match executes ────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_only', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H2a one Sarah → navHeraldPool length === 1 (execute openOrCollectAddress)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_only',
      'length 1 c_only',
    );
  }

  // ── T-NAV-H3: zero Herald matches → fall through ──────────────────────────
  {
    freshDB();
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H3a no Sarah rows → navHeraldPool length 0 (fall through relationship/name/raw)',
      pool.length,
      v => v === 0,
      'length 0',
    );
  }

  // ── T-NAV-CLEAN: destination possessives + location fillers (dispatch mirror) ─
  // Same two replaces as navigation arm cleaned= — cannot import dispatch (RN).
  const cleanNavDestination = (raw: string) =>
    raw
      .replace(/^(my\s+|the\s+|our\s+)/i, '')
      .replace(/'s\s+(house|home|place|address)\s*$/i, '')
      .replace(/'s\s*$/i, '')
      .trim();

  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_david', name: 'David Clevenger', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    insertContact(db, {
      id: 'c_shannon', name: 'Shannon', phone: '5553334444',
      address: '456 Pine Ave', importance: 8,
    });
    insertContact(db, {
      id: 'c_plumb', name: 'Joe', relationship: 'plumber', phone: '5559990000', importance: 5,
    });

    const idsFor = (q: string) => findAllContactMatches(q).map(c => c.id).sort();

    assert(
      "T-NAV-CLEAN-1 David's house → same matches as David",
      { cleaned: cleanNavDestination("David's house"), ids: idsFor(cleanNavDestination("David's house")) },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { cleaned: string }).cleaned === 'David' &&
        JSON.stringify((v as { ids: string[] }).ids) === JSON.stringify(idsFor('David')),
      "cleaned 'David', ids match David",
    );

    assert(
      "T-NAV-CLEAN-2 Shannon's place → same matches as Shannon",
      { cleaned: cleanNavDestination("Shannon's place"), ids: idsFor(cleanNavDestination("Shannon's place")) },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { cleaned: string }).cleaned === 'Shannon' &&
        JSON.stringify((v as { ids: string[] }).ids) === JSON.stringify(idsFor('Shannon')),
      "cleaned 'Shannon', ids match Shannon",
    );

    assert(
      "T-NAV-CLEAN-3 David's (no suffix) → still strips trailing 's",
      { cleaned: cleanNavDestination("David's"), ids: idsFor(cleanNavDestination("David's")) },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { cleaned: string }).cleaned === 'David' &&
        JSON.stringify((v as { ids: string[] }).ids) === JSON.stringify(idsFor('David')),
      "cleaned 'David', ids match David",
    );

    assert(
      "T-NAV-CLEAN-4 the plumber's address → strips to plumber",
      {
        cleaned: cleanNavDestination("the plumber's address"),
        ids: idsFor(cleanNavDestination("the plumber's address")),
      },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { cleaned: string }).cleaned === 'plumber' &&
        JSON.stringify((v as { ids: string[] }).ids) === JSON.stringify(idsFor('plumber')),
      "cleaned 'plumber', ids match plumber",
    );

    assert(
      "T-NAV-CLEAN-5 my David's house → leading my + trailing 's house",
      {
        cleaned: cleanNavDestination("my David's house"),
        ids: idsFor(cleanNavDestination("my David's house")),
      },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { cleaned: string }).cleaned === 'David' &&
        JSON.stringify((v as { ids: string[] }).ids) === JSON.stringify(idsFor('David')),
      "cleaned 'David', ids match David",
    );
  }

  // ── T-PERSONAL: unresolved personal destination must never reach Maps ──────
  // Mirrors the nav arm's cleaning chain (dispatch.ts cannot be imported — RN).
  {
    const cleanNav = (raw: string) =>
      raw
        .replace(/[\u2018\u2019\u02BC\u0060]/g, "'")
        .replace(/^(my\s+|the\s+|our\s+)/i, '')
        .replace(/'s\s+(house|home|place|address)\s*$/i, '')
        .replace(/'s\s*$/i, '')
        .trim();
    const personal = (raw: string) => isPersonalDestination(raw, cleanNav(raw));

    const MUST_HONEST_FAIL = [
      "my wife's house", 'my wife', "my wife's",
      "my husband's house", 'my husband',
      "my mom's house", 'my mom',
      "my dad's house", 'my dad',
      "my son's house", 'my son',
      "my daughter's house", 'my daughter',
      "Shannon's house", "David's home", "the plumber's address",
    ];
    for (const raw of MUST_HONEST_FAIL) {
      assert(`T-PERSONAL-A "${raw}" → personal (no Maps)`,
        personal(raw), v => v === true, 'true');
    }

    const MUST_REACH_MAPS = [
      "McDonald's", "Trader Joe's", "Lowe's", "Dave's", "Wendy's",
      'Starbucks', '1600 Pennsylvania Avenue', 'the airport',
    ];
    for (const raw of MUST_REACH_MAPS) {
      assert(`T-PERSONAL-B "${raw}" → not personal (Maps unchanged)`,
        personal(raw), v => v === false, 'false');
    }

    assert('T-PERSONAL-C relationship term is case/space insensitive',
      [isRelationshipTerm('  WIFE '), isRelationshipTerm('mother-in-law'), isRelationshipTerm('Shannon')],
      v => Array.isArray(v) && v[0] === true && v[1] === true && v[2] === false,
      '[true, true, false]');
  }

  // ── T-WC: writeContact UPDATE path — write-then-read verify ───────────────
  // [Eng. Principles Rule 4 (verify by reading back), Rule 3 (ACK matches
  // commit), Rule 8 (the contract is its tests). The UPDATE branch had 9 SQL
  // placeholders and 10 bind params — every write to an EXISTING contact
  // silently no-op'd while callers spoke "Got it."]
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_wc', name: 'Shannon', relationship: 'wife',
      phone: '5551112222', importance: 7,
    });

    writeContactRaw({ name: 'Shannon', address: '7112 Lancaster Ln', importance: 6 });
    const afterAddr = findContactByName('Shannon');

    assert('T-WC-1 address written to an EXISTING contact is readable back',
      afterAddr?.address,
      v => v === '7112 Lancaster Ln',
      "'7112 Lancaster Ln'");

    assert('T-WC-2 address update does not null the existing phone',
      afterAddr?.phone,
      v => v === '5551112222',
      "'5551112222'");

    assert('T-WC-3 name-only write never reassigns relationship (BUG B)',
      afterAddr?.relationship,
      v => v === 'wife',
      "'wife'");

    writeContactRaw({ name: 'Shannon', phone: '5559998888', importance: 6 });
    assert('T-WC-4 phone written to an EXISTING contact is readable back',
      findContactByName('Shannon')?.phone,
      v => v === '5559998888',
      "'5559998888'");
  }

  // ── T-SRL: stripRelationshipLead + writeContactValidated clean-name path ──
  {
    assert('T-SRL-1 stripRelationshipLead(wife Shannon) → Shannon',
      stripRelationshipLead('wife Shannon'),
      v => v === 'Shannon',
      "'Shannon'");
    assert('T-SRL-2 stripRelationshipLead(my Hunter) → Hunter',
      stripRelationshipLead('my Hunter'),
      v => v === 'Hunter',
      "'Hunter'");
    assert('T-SRL-3 stripRelationshipLead(my) → empty',
      stripRelationshipLead('my'),
      v => v === '',
      "''");
    assert('T-SRL-4 stripRelationshipLead(wife) → empty',
      stripRelationshipLead('wife'),
      v => v === '',
      "''");
    assert('T-SRL-5 stripRelationshipLead(Shannon) unchanged',
      stripRelationshipLead('Shannon'),
      v => v === 'Shannon',
      "'Shannon'");
    assert('T-SRL-6 stripRelationshipLead(Dr. Smith) unchanged',
      stripRelationshipLead('Dr. Smith'),
      v => v === 'Dr. Smith',
      "'Dr. Smith'");

    freshDB();
    const wifeShannon = writeContactValidated({ name: 'wife Shannon', importance: 6 });
    assert('T-SRL-7 writeContactValidated(wife Shannon) stores clean Shannon',
      { ok: wifeShannon.ok, row: findContactByName('Shannon')?.name },
      v => typeof v === 'object' && v !== null
        && (v as { ok: boolean; row?: string }).ok === true
        && (v as { ok: boolean; row?: string }).row === 'Shannon',
      "{ ok: true, row: 'Shannon' }");

    const bareMy = writeContactValidated({ name: 'my', importance: 6 });
    assert("T-SRL-8 writeContactValidated(my) → missing_identity",
      bareMy,
      v => typeof v === 'object' && v !== null
        && (v as { ok: boolean; reason?: string }).ok === false
        && (v as { ok: boolean; reason?: string }).reason === 'missing_identity',
      "{ ok: false, reason: 'missing_identity' }");
  }

  // ── T-RPI: resolvePersonIdentity (identity-only) + contactHasCapability ───
  console.log(`\n${BOLD}-- resolvePersonIdentity Contract Tests -------------------${RESET}\n`);

  // ── T-RPI-1: >1 identity candidates → ambiguous (never silent top-1) ──────
  {
    const db = freshDB();
    insertContact(db, { id: 'rpi_s1', name: 'Sarah Smith', phone: '5551112222', importance: 9 });
    insertContact(db, { id: 'rpi_s2', name: 'Sarah Jones', phone: '5553334444', importance: 5 });
    const r = resolvePersonIdentity('Sarah');
    assert('T-RPI-1 two Sarahs → ambiguous with full candidates array',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'ambiguous'
        && Array.isArray((v as { candidates: Contact[] }).candidates)
        && (v as { candidates: Contact[] }).candidates.length === 2
        && (v as { candidates: Contact[] }).candidates.map(c => c.id).sort().join(',') === 'rpi_s1,rpi_s2',
      "{ status: 'ambiguous', candidates.length === 2 }");
  }

  // ── T-RPI-2: 0 identity candidates → none ─────────────────────────────────
  {
    freshDB();
    assert('T-RPI-2 unstored wife → none',
      resolvePersonIdentity('my wife'),
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'none'
        && !('contact' in (v as object)),
      "{ status: 'none' }");
  }

  // ── T-RPI-3: 1 identity candidate → single ────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'rpi_only', name: 'Emily', relationship: 'daughter', phone: '5550101', importance: 8 });
    insertContact(db, { id: 'rpi_other', name: 'Mike', phone: '5559999', importance: 5 });
    assert('T-RPI-3 my daughter → single Emily',
      resolvePersonIdentity('my daughter'),
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'single'
        && (v as { contact: Contact }).contact?.id === 'rpi_only',
      "{ status: 'single', contact.id === rpi_only }");
  }

  // ── T-RPI-4..6: identity independent of missing capability fields ─────────
  {
    const db = freshDB();
    insertContact(db, {
      id: 'rpi_bare', name: 'Shannon', relationship: 'wife',
      phone: null, address: null, email: null, importance: 9,
    });
    const r = resolvePersonIdentity('wife');
    assert('T-RPI-4 known wife with no phone → single',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'single'
        && (v as { contact: Contact }).contact?.id === 'rpi_bare'
        && !(v as { contact: Contact }).contact?.phone?.trim(),
      "{ status: 'single', phoneless }");
    assert('T-RPI-5 known wife with no address → single',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'single'
        && !(v as { contact: Contact }).contact?.address?.trim(),
      "{ status: 'single', addressless }");
    assert('T-RPI-6 known wife with no email → single',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'single'
        && !(v as { contact: Contact }).contact?.email?.trim(),
      "{ status: 'single', emailless }");
  }

  // ── T-RPI-7: contactHasCapability pure helper ─────────────────────────────
  {
    const withAll: Contact = {
      id: 'x', name: 'X', phone: '555', address: '1 Main', email: 'a@b.c',
      importance: 5, created_at: '', updated_at: '',
    };
    const empty: Contact = {
      id: 'y', name: 'Y', phone: '  ', address: '', email: undefined,
      importance: 5, created_at: '', updated_at: '',
    };
    assert('T-RPI-7a phone true only when non-empty phone',
      { with: contactHasCapability(withAll, 'phone'), empty: contactHasCapability(empty, 'phone') },
      v => typeof v === 'object' && v !== null
        && (v as { with: boolean; empty: boolean }).with === true
        && (v as { with: boolean; empty: boolean }).empty === false,
      '{ with: true, empty: false }');
    assert('T-RPI-7b address true only when non-empty address',
      { with: contactHasCapability(withAll, 'address'), empty: contactHasCapability(empty, 'address') },
      v => typeof v === 'object' && v !== null
        && (v as { with: boolean; empty: boolean }).with === true
        && (v as { with: boolean; empty: boolean }).empty === false,
      '{ with: true, empty: false }');
    assert('T-RPI-7c email true only when non-empty email',
      { with: contactHasCapability(withAll, 'email'), empty: contactHasCapability(empty, 'email') },
      v => typeof v === 'object' && v !== null
        && (v as { with: boolean; empty: boolean }).with === true
        && (v as { with: boolean; empty: boolean }).empty === false,
      '{ with: true, empty: false }');
    assert('T-RPI-7d any always true',
      { with: contactHasCapability(withAll, 'any'), empty: contactHasCapability(empty, 'any') },
      v => typeof v === 'object' && v !== null
        && (v as { with: boolean; empty: boolean }).with === true
        && (v as { with: boolean; empty: boolean }).empty === true,
      '{ with: true, empty: true }');
  }

  // ── T-CAP: resolvePersonCapability (Herald-first, identity-constrained OS) ─
  console.log(`\n${BOLD}-- resolvePersonCapability Contract Tests -----------------${RESET}\n`);

  function phonelessWife(): Contact {
    return {
      id: 'c_wife',
      name: 'Shannon',
      relationship: 'wife',
      importance: 9,
      created_at: '',
      updated_at: '',
    };
  }

  // ── T-CAP-01: Herald phone present → available/herald; OS never touched ───
  {
    setOsPersonCapabilitySearch(async () => {
      throw new Error('OS must not be called when Herald has capability');
    });
    const contact: Contact = {
      ...phonelessWife(),
      phone: '555-030-0300',
    };
    const r = await resolvePersonCapability(contact, 'phone');
    assert('T-CAP-01 Herald phone → available/herald; OS unused',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'available'
        && (v as { source?: string }).source === 'herald'
        && (v as { value?: string }).value === '555-030-0300',
      "{ status: 'available', value: '555-030-0300', source: 'herald' }");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-02: Herald missing, exactly one OS match → available/os ─────────
  {
    setOsPersonCapabilitySearch(async (identity) => {
      if (identity.name !== 'Shannon') return [];
      return [{ name: 'Shannon Martys', phone: '5551112222' }];
    });
    const r = await resolvePersonCapability(phonelessWife(), 'phone');
    assert('T-CAP-02 Herald miss + one OS → available/os',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'available'
        && (v as { source?: string }).source === 'os'
        && (v as { value?: string }).value === '5551112222',
      "{ status: 'available', value: '5551112222', source: 'os' }");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-03: Herald missing, multiple OS matches → ambiguous (no top-1) ──
  {
    setOsPersonCapabilitySearch(async () => ([
      { name: 'Shannon A', phone: '5551111111' },
      { name: 'Shannon B', phone: '5552222222' },
    ]));
    const r = await resolvePersonCapability(phonelessWife(), 'phone');
    assert('T-CAP-03 Herald miss + multi OS → ambiguous with all candidates',
      r,
      v => typeof v === 'object' && v !== null
        && (v as { status: string }).status === 'ambiguous'
        && Array.isArray((v as { candidates?: Contact[] }).candidates)
        && (v as { candidates: Contact[] }).candidates.length === 2
        && (v as { candidates: Contact[] }).candidates.map(c => c.name).sort().join('|') === 'Shannon A|Shannon B',
      "{ status: 'ambiguous', candidates: [Shannon A, Shannon B] }");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-04: Herald missing, OS none / no phones → missing ───────────────
  {
    setOsPersonCapabilitySearch(async () => ([{ name: 'Shannon', phone: '' }]));
    const r = await resolvePersonCapability(phonelessWife(), 'phone');
    assert('T-CAP-04 Herald miss + OS none with capability → missing',
      r,
      v => typeof v === 'object' && v !== null && (v as { status: string }).status === 'missing',
      "{ status: 'missing' }");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-05: OS search receives resolved identity attrs, never utterance ─
  {
    const seen: Array<{ name: string; relationship?: string }> = [];
    setOsPersonCapabilitySearch(async (identity) => {
      seen.push({ name: identity.name, relationship: identity.relationship });
      return [];
    });
    await resolvePersonCapability(phonelessWife(), 'phone');
    assert('T-CAP-05 OS constrained to contact.name/relationship (not utterance)',
      seen,
      v => Array.isArray(v) && v.length === 1
        && v[0].name === 'Shannon'
        && v[0].relationship === 'wife'
        && !JSON.stringify(v).toLowerCase().includes('my wife'),
      "[{ name: 'Shannon', relationship: 'wife' }]");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-06: Herald address present → available/herald for address ───────
  {
    let osCalls = 0;
    setOsPersonCapabilitySearch(async () => { osCalls++; return []; });
    const contact: Contact = {
      ...phonelessWife(),
      address: '123 Main St',
    };
    const r = await resolvePersonCapability(contact, 'address');
    assert('T-CAP-06 Herald address → available/herald; OS unused',
      { r, osCalls },
      v => typeof v === 'object' && v !== null
        && (v as { r: { status: string; source?: string; value?: string }; osCalls: number }).r.status === 'available'
        && (v as { r: { source?: string } }).r.source === 'herald'
        && (v as { r: { value?: string } }).r.value === '123 Main St'
        && (v as { osCalls: number }).osCalls === 0,
      "{ status: 'available', value: '123 Main St', source: 'herald' }; osCalls=0");
    setOsPersonCapabilitySearch(null);
  }

  // ── T-CAP-07: identity remains capability-agnostic (no coupling) ──────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c1', name: 'Shannon', relationship: 'wife', importance: 9 });
    setOsPersonCapabilitySearch(null);
    const identity = resolvePersonIdentity('my wife');
    const cap = await resolvePersonCapability(
      identity.status === 'single' ? identity.contact : phonelessWife(),
      'phone',
    );
    assert('T-CAP-07 identity single despite missing phone; capability missing separately',
      { identity, cap },
      v => typeof v === 'object' && v !== null
        && (v as { identity: { status: string; contact?: Contact } }).identity.status === 'single'
        && (v as { identity: { contact?: Contact } }).identity.contact?.name === 'Shannon'
        && (v as { cap: { status: string } }).cap.status === 'missing',
      "identity single Shannon + capability missing");
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ContactsDB: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('contactsDB.test.ts')) {
  runContactsDBTests().catch(console.error);
}
