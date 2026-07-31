// scripts/heraldTest/conversationalRepair.test.ts
// Conversational repair (S_CONVERSATIONAL_REPAIR_DESIGN_SPEC.md v2 §16)
// plus family_capture / medical_visit_outcome_confirm regression coverage.
//
// Runner: npx tsx --tsconfig ./tsconfig.json ./conversationalRepair.test.ts

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { buildVisitOutcomeAskSlot } from '../../src/routing/medicalVisitOutcomeAsk.ts';
import { writeMedicalRecord, markAppointmentSurfaced } from '../../src/db/medicalDB.ts';
import { findContactByName } from '../../src/db/contactsDB.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const BANNED_ACK = [/Got it/i, /Noted/i, /I'll remember that/i, /I've got that/i];

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT, doctor_name TEXT, facility TEXT, reason TEXT,
    diagnosis TEXT, follow_up TEXT, notes TEXT, status TEXT DEFAULT 'noted',
    surfaced_at TEXT, visit_outcome TEXT, outcome_asked_at TEXT,
    removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    body TEXT NOT NULL,
    checked INTEGER DEFAULT 0,
    removed_at TEXT,
    created_at TEXT NOT NULL
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

function contactCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NULL`).get() as { n: number }).n;
}

function readOutcome(db: Database.Database, id: string) {
  return db.prepare(`SELECT visit_outcome FROM medical_records WHERE id = ?`).get(id) as { visit_outcome: string | null };
}

async function armFamily(
  session: ConversationSession,
  opts: { name?: string; relation?: string; location?: string } = {},
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS.family_capture!.add(
    {
      type: 'family_capture',
      name: opts.name ?? 'Shannon',
      relation: opts.relation ?? 'wife',
      location: opts.location ?? 'Austin',
    },
    'my wife Shannon lives in Austin',
  );
  if (result.status !== 'pending') throw new Error(`expected family pending, got ${result.status}`);
  session.setPending({
    pendingKey: result.pendingKey,
    resume: result.resume,
    reaskPrompt: result.reaskPrompt,
    correctable: result.correctable,
  });
  return result;
}

function makeAwaitingVisit(doctorName = 'Dr. Patel', visitDate = '2020-01-01') {
  const id = writeMedicalRecord({ doctor_name: doctorName, visit_date: visitDate, status: 'noted' });
  markAppointmentSurfaced(id);
  return { id, doctorName };
}

async function armMedicalConfirm(
  session: ConversationSession,
  awaiting: { id: string; doctorName?: string },
  candidate: string,
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const slot = buildVisitOutcomeAskSlot(awaiting);
  session.setPending({
    pendingKey: slot.pendingKey,
    kind: slot.kind,
    budget: slot.budget,
    resume: slot.resume,
  });
  const stage2 = await session.resolvePending(candidate);
  if (stage2.status !== 'pending') throw new Error(`expected confirm pending, got ${stage2.status}`);
  return stage2;
}

function noBannedAck(prompt: string): boolean {
  return BANNED_ACK.every(re => !re.test(prompt));
}

export async function runConversationalRepairTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Conversational Repair (§16 + family/medical) ---------${RESET}\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Family-capture required regressions (1–4)
  // ═══════════════════════════════════════════════════════════════════════════

  // F1: plain "No" → ORIGINAL family_capture_correction sub-pending
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session);
    const result = await session.resolvePending('No');
    assert('F1a plain No → pendingKey family_capture_correction (ORIGINAL NO path)', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'family_capture_correction',
      'pending / family_capture_correction');
    assert('F1b plain No prompt asks for the correct name', result,
      v => typeof (v as any).prompt === 'string' && /correct name/i.test((v as any).prompt),
      'What\'s the correct name?');
    assert('F1c plain No writes nothing', contactCount(db), v => v === 0, '0 contacts');
  }

  // F2: "No, it's Jennifer" → correctable path (family_capture_correction_confirm)
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife', location: 'Austin' });
    const result = await session.resolvePending("No, it's Jennifer");
    assert('F2a correction → pendingKey family_capture_correction_confirm', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'family_capture_correction_confirm',
      'pending / family_capture_correction_confirm');
    assert('F2b re-confirm prompt names Jennifer + preserves relation/location (non-contested fields)', result,
      v => (v as any).prompt === 'Jennifer, your wife, in Austin — that right?',
      'Jennifer, your wife, in Austin — that right?');
    assert('F2c A1: re-confirm prompt has no committed-ACK vocabulary', (result as any).prompt,
      v => typeof v === 'string' && noBannedAck(v), 'no Got it / Noted / I\'ll remember that / I\'ve got that');
    assert('F2d no DB write yet after correction', contactCount(db), v => v === 0, '0 contacts');
    assert('F2e session still holds pending (not committed)', session.hasPending(), v => v === true, 'true');
  }

  // F3: correction → Yes → commits Jennifer via capturePerson / findContactByName
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife', location: 'Austin' });
    await session.resolvePending("No, it's Jennifer");
    const result = await session.resolvePending('yes');
    assert('F3a yes after correction → committed', result, v => (v as any).status === 'committed', 'committed');
    assert('F3b findContactByName("Jennifer") round-trip', findContactByName('Jennifer'),
      v => !!v && (v as any).name === 'Jennifer' && (v as any).relationship === 'wife',
      'Jennifer / wife');
    assert('F3c Shannon was never written', findContactByName('Shannon'), v => v == null, 'null');
    assert('F3d committed ack may use Got it (post-commit only)', result,
      v => (v as any).status === 'committed' && /Jennifer/i.test((v as any).ack) && /wife/i.test((v as any).ack),
      'ack names Jennifer/wife');
    void db;
  }

  // F4: "No thanks" → unresolved/re-ask ladder (unchanged baseline)
  {
    freshDB();
    const session = new ConversationSession();
    const armed = await armFamily(session);
    const result = await session.resolvePending('No thanks');
    assert('F4a No thanks → still pending (not correction, not reject-ack)', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'family_capture',
      'pending / family_capture');
    assert('F4b No thanks uses DEFAULT_REASK (no domain reaskPrompt on family confirm)', result,
      v => (v as any).prompt === "I'm not sure I'm following — can you say that again?",
      'DEFAULT_REASK');
    assert('F4c session still pending after No thanks', session.hasPending(), v => v === true, 'true');
    void armed;
  }

  // Spec trap phrases (S_CONVERSATIONAL_REPAIR "Tests Before Completion" items
  // covering "no, that's fine" / "no, I don't think so") — F4-depth pins.
  // S16.9 is already used for A1 marker lexicon scans → S16.13a/b.
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session);
    const result = await session.resolvePending("No, that's fine.");
    assert(
      'S16.13a "No, that\'s fine." → NOT family_capture_correction_confirm; F4-identical re-ask, no write',
      {
        status: (result as any).status,
        key: (result as any).pendingKey,
        prompt: (result as any).prompt,
        pending: session.hasPending(),
        rows: contactCount(db),
      },
      v =>
        (v as any).status === 'pending'
        && (v as any).key === 'family_capture'
        && (v as any).key !== 'family_capture_correction_confirm'
        && (v as any).prompt === "I'm not sure I'm following — can you say that again?"
        && (v as any).pending === true
        && (v as any).rows === 0,
      'pending / family_capture / DEFAULT_REASK / no write',
    );
  }
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session);
    const result = await session.resolvePending("No, I don't think so.");
    assert(
      'S16.13b "No, I don\'t think so." → NOT family_capture_correction_confirm; F4-identical re-ask, no write',
      {
        status: (result as any).status,
        key: (result as any).pendingKey,
        prompt: (result as any).prompt,
        pending: session.hasPending(),
        rows: contactCount(db),
      },
      v =>
        (v as any).status === 'pending'
        && (v as any).key === 'family_capture'
        && (v as any).key !== 'family_capture_correction_confirm'
        && (v as any).prompt === "I'm not sure I'm following — can you say that again?"
        && (v as any).pending === true
        && (v as any).rows === 0,
      'pending / family_capture / DEFAULT_REASK / no write',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Medical visit outcome — equivalent coverage
  // ═══════════════════════════════════════════════════════════════════════════

  // M1: correction replaces candidate; pendingKey stays medical_visit_outcome_confirm
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    await armMedicalConfirm(session, awaiting, 'Blood pressure was high.');
    const result = await session.resolvePending("no, it's He adjusted my meds.");
    assert('M1a correction keeps pendingKey medical_visit_outcome_confirm', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome_confirm',
      'pending / medical_visit_outcome_confirm');
    assert('M1b prompt reflects corrected candidate verbatim', result,
      v => (v as any).prompt === 'Should I remember "He adjusted my meds." from your appointment with Dr. Patel?',
      'corrected confirm prompt');
    assert('M1c A1: medical re-confirm has no committed-ACK vocabulary', (result as any).prompt,
      v => typeof v === 'string' && noBannedAck(v), 'no banned ACK');
    assert('M1d no visit_outcome write yet', readOutcome(db, awaiting.id),
      v => (v as any).visit_outcome === null, 'null');
  }

  // M2: correction → yes → commits ONLY corrected text
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    await armMedicalConfirm(session, awaiting, 'Blood pressure was high.');
    await session.resolvePending("actually He adjusted my meds.");
    const result = await session.resolvePending('yes');
    assert('M2a yes → committed', result, v => (v as any).status === 'committed', 'committed');
    assert('M2b attachVisitOutcome stored corrected text only', readOutcome(db, awaiting.id),
      v => (v as any).visit_outcome === 'He adjusted my meds.',
      'He adjusted my meds.');
  }

  // M3: "no thanks" at confirm stage → reask ladder (baseline)
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    const stage2 = await armMedicalConfirm(session, awaiting, 'Blood pressure was high.');
    const result = await session.resolvePending('no thanks');
    assert('M3a no thanks → still confirm pending', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome_confirm',
      'pending / medical_visit_outcome_confirm');
    assert('M3b no thanks uses candidate-specific reaskPrompt', result,
      v => (v as any).prompt === (stage2 as any).reaskPrompt
        || (v as any).prompt === 'Please say yes or no. Should I remember "Blood pressure was high." from your appointment with Dr. Patel?',
      'candidate-specific reask');
    assert('M3c no write on no thanks', readOutcome(db, awaiting.id),
      v => (v as any).visit_outcome === null, 'null');
  }

  // M4: double correction → yes commits newest only
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    await armMedicalConfirm(session, awaiting, 'First draft.');
    await session.resolvePending("no, it's Second draft.");
    const mid = await session.resolvePending('rather Third draft.');
    assert('M4a second correction prompt names Third draft', mid,
      v => (v as any).status === 'pending'
        && (v as any).prompt === 'Should I remember "Third draft." from your appointment with Dr. Patel?',
      'Third draft confirm');
    await session.resolvePending('yes');
    assert('M4b DB holds newest value only', readOutcome(db, awaiting.id),
      v => (v as any).visit_outcome === 'Third draft.', 'Third draft.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §16 acceptance (remaining items across domains)
  // ═══════════════════════════════════════════════════════════════════════════

  // §16.1 — only contested field replaced (location/relation preserved) — covered F2b; pin dosage-adjacent via family location
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Bob', relation: 'brother', location: 'Dallas' });
    const result = await session.resolvePending("i meant Robert");
    assert('S16.1 correction replaces name only; relation+location remain in prompt', result,
      v => (v as any).prompt === 'Robert, your brother, in Dallas — that right?',
      'Robert, your brother, in Dallas — that right?');
  }

  // §16.2 — correction does not commit before second Yes (family + medical already F2d/M1d; pin read authority)
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armFamily(session);
    await session.resolvePending("that's wrong, it's Karen");
    assert('S16.2 family read authority empty before yes', contactCount(db), v => v === 0, '0');
  }

  // §16.3 — corrected value commits verbatim (O'Brien — apostrophe preserved)
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife' });
    await session.resolvePending("no, it's O'Brien");
    const mid = await session.resolvePending('yes');
    assert('S16.3a commit status', mid, v => (v as any).status === 'committed', 'committed');
    assert('S16.3b O\'Brien apostrophe preserved verbatim', findContactByName("O'Brien"),
      v => !!v && (v as any).name === "O'Brien", "O'Brien");
  }

  // §16.4 — plain `no` rejection both domains (family F1; medical confirm NO)
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    await armMedicalConfirm(session, awaiting, 'Something happened.');
    const result = await session.resolvePending('no');
    assert('S16.4 medical plain no → noop reject ack, no write', result,
      v => (v as any).status === 'noop'
        && (v as any).ack === "Okay, I won't save that. What would you like me to do?",
      'reject noop');
    assert('S16.4b medical plain no leaves DB null', readOutcome(db, awaiting.id),
      v => (v as any).visit_outcome === null, 'null');
  }

  // §16.5 — trap phrases never become corrections
  {
    const traps = ["no thanks", "no, that's fine", "no, I don't think so"];
    for (const phrase of traps) {
      freshDB();
      const session = new ConversationSession();
      await armFamily(session);
      const result = await session.resolvePending(phrase);
      assert(`S16.5 family "${phrase}" → re-ask ladder, not correction_confirm`, result,
        v => (v as any).status === 'pending'
          && (v as any).pendingKey === 'family_capture'
          && (v as any).pendingKey !== 'family_capture_correction_confirm',
        'pending / family_capture (not correction)');
    }
    for (const phrase of traps) {
      const db = freshDB();
      const awaiting = makeAwaitingVisit();
      const session = new ConversationSession();
      await armMedicalConfirm(session, awaiting, 'Candidate text.');
      const result = await session.resolvePending(phrase);
      assert(`S16.5 medical "${phrase}" → still confirm, no write`, {
        status: (result as any).status,
        key: (result as any).pendingKey,
        outcome: readOutcome(db, awaiting.id).visit_outcome,
      },
        v => v.status === 'pending' && v.key === 'medical_visit_outcome_confirm' && v.outcome === null,
        'pending confirm, null outcome');
    }
  }

  // §16.6 — double correction family (newest wins)
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife', location: 'Austin' });
    await session.resolvePending("no, it's Jennifer");
    await session.resolvePending('rather Karen');
    await session.resolvePending('yes');
    assert('S16.6 family double-correction commits newest (Karen)', findContactByName('Karen'),
      v => !!v && (v as any).name === 'Karen', 'Karen');
    assert('S16.6b Jennifer never written', findContactByName('Jennifer'), v => v == null, 'null');
  }

  // §16.7 — multi-field pending without correctable + marker → held (MVP: no field guess)
  {
    freshDB();
    const session = new ConversationSession();
    // Synthetic two-field-ish pending: no correctable attached.
    session.setPending({
      pendingKey: 'synthetic_multi_field',
      kind: 'standard',
      budget: 2,
      resume: async () => ({ status: 'noop', ack: '' }),
      reaskPrompt: 'Help me out — the medication, or the dose?',
    });
    const result = await session.resolvePending("no, it's 10mg");
    assert('S16.7 multi-field (no correctable) stays held with clarification reask — never commits', result,
      v => (v as any).status === 'pending'
        && (v as any).pendingKey === 'synthetic_multi_field'
        && (v as any).prompt === 'Help me out — the medication, or the dose?',
      'held + bounded clarification reask');
    assert('S16.7b still pending (Law 2 — no leak)', session.hasPending(), v => v === true, 'true');
  }

  // §16.8 / user items — Unicode marker via normalizeInput; fail-safe without it
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife', location: 'Austin' });
    // Curly apostrophe in "it's" — same path ChatScreen uses (normalizeInput first).
    const curly = "no, it\u2019s Jennifer";
    const normalized = normalizeInput(curly);
    const result = await session.resolvePending(normalized);
    assert('S16.8a curly-apostrophe marker after normalizeInput → correction_confirm', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'family_capture_correction_confirm',
      'family_capture_correction_confirm');
    assert('S16.8b prompt uses Jennifer', result,
      v => (v as any).prompt === 'Jennifer, your wife, in Austin — that right?',
      'Jennifer confirm');
  }
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'wife', location: 'Austin' });
    const curly = "no, it\u2019s Jennifer";
    const result = await session.resolvePending(curly); // NOT normalized
    assert('S16.8c unnormalized curly marker → fail-safe re-ask (not crash, not false correction)', result,
      v => (v as any).status === 'pending'
        && (v as any).pendingKey === 'family_capture'
        && (v as any).pendingKey !== 'family_capture_correction_confirm',
      'DEFAULT_REASK / family_capture');
  }

  // §16.9 — A1 grep already in F2c/M1c; pin every correctable-path prompt seen in this suite via helper on family markers
  {
    freshDB();
    const session = new ConversationSession();
    await armFamily(session, { name: 'Shannon', relation: 'sister', location: 'Boston' });
    const markers = [
      "no, it's Pat",
      'actually Pat',
      "actually it's Pat",
      'i meant Pat',
      "that's wrong, it's Pat",
      'rather Pat',
    ];
    for (const m of markers) {
      const s = new ConversationSession();
      await armFamily(s, { name: 'Shannon', relation: 'sister', location: 'Boston' });
      const r = await s.resolvePending(m);
      assert(`S16.9 marker "${m}" → A1-clean re-confirm prompt`, (r as any).prompt,
        v => typeof v === 'string' && noBannedAck(v) && /Pat/.test(v as string),
        'A1-clean prompt containing Pat');
    }
    void session;
  }

  // §16.10 — no LLM / Phrase-out / Persona / Expression dependency in repair runtime files
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..');
    // features.ts documents LOCAL_LLM / Phrase-out in unrelated flag comments — exclude it.
    const files = [
      'src/routing/conversationSession.ts',
      'src/routing/medicalVisitOutcomeAsk.ts',
    ];
    const bannedImport = /^\s*import\s+.*\b(classifyWithLLM|openai|anthropic)\b/im;
    let clean = true;
    const hits: string[] = [];
    for (const rel of files) {
      const body = readFileSync(join(repoRoot, rel), 'utf8');
      if (bannedImport.test(body) || /\bPhrase-out\b/.test(body) || /\bPersona\b/.test(body) || /\bExpression\b/.test(body)) {
        clean = false;
        hits.push(rel);
      }
    }
    assert('S16.10 repair runtime files have no LLM/Phrase-out/Persona/Expression dependency', { clean, hits },
      v => (v as any).clean === true, 'no banned dependency hits');
  }

  // §16.11 — flag-off / opt-in substitutes.
  // Testing the literal runtime flag=false path would require making
  // CORRECTION_REPAIR_ENABLED injectable, which is out of scope for this
  // session (would touch conversationSession.ts's public shape again — a
  // second structural unknown). These two tests are the accepted substitute
  // and cover the guarantee that actually matters.
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..');
    const src = readFileSync(join(repoRoot, 'src/routing/conversationSession.ts'), 'utf8');
    const resolveStart = src.indexOf('async resolvePending(');
    const resolveBody = resolveStart >= 0 ? src.slice(resolveStart, resolveStart + 2500) : '';
    assert(
      'S16.11a STRUCTURAL: resolvePending gates correction on CORRECTION_REPAIR_ENABLED && slot.correctable',
      resolveBody.includes('CORRECTION_REPAIR_ENABLED && slot.correctable'),
      v => v === true,
      'literal gating condition present inside resolvePending',
    );
  }
  {
    // BEHAVIORAL: todo_add.remove pending has no correctable and never will
    // (this session's scope). A correction marker must behave identically to
    // any other unparseable reply — re-ask ladder, budget decrement, no
    // correction fires — regardless of the flag's value.
    const db = freshDB();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run('list_todos', 'todos', now);
    db.prepare(
      `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('todo_1', 'list_todos', 'buy milk', 0, now);

    const sessionMarker = new ConversationSession();
    const armedMarker = await DOMAIN_WRITERS['todo_add']!.remove('todo_1');
    if (armedMarker.status !== 'pending') throw new Error(`expected todo pending, got ${armedMarker.status}`);
    sessionMarker.setPending({
      pendingKey: armedMarker.pendingKey,
      resume: armedMarker.resume,
      kind: armedMarker.kind,
      // correctable omitted — domain never opts in
    });
    const markerResult = await sessionMarker.resolvePending("no, it's Jennifer");

    const sessionGarbage = new ConversationSession();
    const armedGarbage = await DOMAIN_WRITERS['todo_add']!.remove('todo_1');
    if (armedGarbage.status !== 'pending') throw new Error(`expected todo pending, got ${armedGarbage.status}`);
    sessionGarbage.setPending({
      pendingKey: armedGarbage.pendingKey,
      resume: armedGarbage.resume,
      kind: armedGarbage.kind,
    });
    const garbageResult = await sessionGarbage.resolvePending('what time is it');

    assert(
      'S16.11b BEHAVIORAL: correction marker on non-correctable todo pending ≡ unparseable re-ask (status/key/prompt)',
      {
        marker: {
          status: (markerResult as any).status,
          key: (markerResult as any).pendingKey,
          prompt: (markerResult as any).prompt,
        },
        garbage: {
          status: (garbageResult as any).status,
          key: (garbageResult as any).pendingKey,
          prompt: (garbageResult as any).prompt,
        },
      },
      v =>
        (v as any).marker.status === (v as any).garbage.status
        && (v as any).marker.key === (v as any).garbage.key
        && (v as any).marker.prompt === (v as any).garbage.prompt
        && (v as any).marker.status === 'pending'
        && (v as any).marker.key === armedMarker.pendingKey,
      'identical re-ask ladder; original todo pendingKey retained',
    );
    assert(
      'S16.11c BEHAVIORAL: non-opt-in domain still pending after marker (budget decremented, not released; no correction)',
      {
        stillPending: sessionMarker.hasPending(),
        checked: (db.prepare(`SELECT checked FROM list_items WHERE id = ?`).get('todo_1') as { checked: number }).checked,
      },
      v => (v as any).stillPending === true && (v as any).checked === 0,
      'still pending, item unchecked',
    );
  }

  // §16.12 device proof — manual; document as skipped gate note (not counted as fail)
  console.log(`${DIM}⊘ SKIP  S16.12 device proof (S24+ offline) — manual per spec; not a gate assert${RESET}`);

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Conversational Repair: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalRepair.test.ts')) {
  runConversationalRepairTests().catch(console.error);
}
