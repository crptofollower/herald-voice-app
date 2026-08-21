// scripts/heraldTest/conversationalSubject.test.ts
// Flow C — one-turn conversational subject + pronoun-phone re-read by id.
//
// Runner: npx tsx scripts/heraldTest/conversationalSubject.test.ts
// Gate:   wired from run.mjs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeServiceProvider } from '../../src/utils/householdCapture.ts';
import { writeMedicalRecord, attachVisitOutcome, getMedicalRecords } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  ConversationalSubjectHolder,
  isReferentPhoneQuestion,
  isReferentVisitDateQuestion,
  isReferentVisitOutcomeQuestion,
} from '../../src/routing/conversationalSubject.ts';
import { formatSpokenDate } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

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
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS service_providers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS insurance_policies (
    id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT,
    is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS legal_documents (
    id TEXT PRIMARY KEY, type TEXT, location TEXT, created_at TEXT, updated_at TEXT, removed_at TEXT
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshFlow() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text: string) => processUtterance(text, session, deps, subject);
  return { db, session, subject, say };
}

function seedTwoDoctorOutcomes() {
  const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
  attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
  const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
  attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
}

const SMITH_OUTCOME = 'Smith said to continue the current dose.';
const PATEL_OUTCOME = 'Patel said the labs were unremarkable.';
const FOSTER_OUTCOME = 'Your blood pressure reading was elevated, follow up in a month.';
const VISIT_OUTCOME_MISS = "I don't have anything from your last visit yet.";

function spokenPhone(digits: string): string {
  const d = digits.replace(/\D/g, '');
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export async function runConversationalSubjectTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: any) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Flow C Conversational Subject Tests -------------------${RESET}\n`);

  // ── Speech-act parser (closed form; not entity-specific phrases) ──
  assert('P-her-phone', isReferentPhoneQuestion("What's her phone number?"), v => v === true, 'true');
  assert('P-her-number', isReferentPhoneQuestion("What's her number?"), v => v === true, 'true');
  assert('P-his-phone', isReferentPhoneQuestion("What's his phone number?"), v => v === true, 'true');
  assert('P-his-number', isReferentPhoneQuestion("What's his number?"), v => v === true, 'true');
  assert('P-what-is-her', isReferentPhoneQuestion('What is her number?'), v => v === true, 'true');
  assert('P-they-out', isReferentPhoneQuestion("What's their number?"), v => v === false, 'false');
  assert('P-who-is-she-out', isReferentPhoneQuestion('Who is she?'), v => v === false, 'false');
  assert('P-josh-explicit-out', isReferentPhoneQuestion("What's Josh's number?"), v => v === false, 'false');
  assert('P-what-about-her-out', isReferentPhoneQuestion('What about her?'), v => v === false, 'false');
  assert('P-address-out', isReferentPhoneQuestion("What's her address?"), v => v === false, 'false');
  assert('P-last-name-out', isReferentPhoneQuestion("What's her last name?"), v => v === false, 'false');

  // ── A. FAMILY POSITIVE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t1 = await say('Who is my wife?');
    assert('A1 wife identity read names Shannon', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read' && v.routeDecision.response.includes('Shannon'),
      'device_read Shannon');
    const established = subject.peek();
    assert('A2 exactly-one wife establishes family subject by id', established,
      v => v?.domain === 'family_contact' && v.displayName === 'Shannon' && typeof v.entityId === 'string' && v.entityId.length > 0 && !('gender' in v),
      'family_contact Shannon, stable id, no gender field');
    const t2 = await say("What's her phone number?");
    assert('A3 pronoun phone is Flow C current Shannon number', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon')
        && !/wife/i.test(v.responseText),
      "Shannon's number is 214-555-0100, no cached wife copy");
    assert('A4 subject clears after consume', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── B. FAMILY NO PHONE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say("What's her number?");
    assert('B1 honest miss, no fabricated phone', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && /don't have a number/i.test(v.responseText)
        && !/\d{3}/.test(v.responseText),
      'honest miss, no digits');
    assert('B2 subject clears after miss', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── C. EXPLICIT OVERRIDE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    writeContactRaw({ name: 'Josh', relationship: 'son', phone: '9725550199', importance: 7 });
    await say('Who is my wife?');
    const t2 = await say("What's Josh's number?");
    assert('C1 Josh explicit reader, not Shannon hijack', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'contact:phone_lookup'
        && v.routeDecision.response.includes('Josh')
        && v.routeDecision.response.includes('972')
        && v.routeDecision.response.includes('555-0199')
        && !v.routeDecision.response.includes('214'),
      'Josh lookup, Shannon phone absent');
    assert('C2 unused next turn clears Shannon subject', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── D. NO CONTEXT ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t1 = await say("What's her phone number?");
    assert('D1 no subject → Flow C does not resolve', t1,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    const text = t1.handled && 'responseText' in t1 ? t1.responseText : (t1.handled === false ? t1.routeDecision.kind === 'device_read' ? t1.routeDecision.response : '' : '');
    assert('D2 no guessed person', { text, live: subject.hasLive() },
      v => !/Shannon/i.test(v.text) && v.live === false,
      'no Shannon, no subject');
  }

  // ── E. ONE-TURN EXPIRY ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say('Open YouTube');
    assert('E1 unused unrelated turn is not Flow C', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    assert('E2 subject gone after unused turn', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say("What's her number?");
    assert('E3 later pronoun fail-closed', t3,
      v => !(v.handled === true && v.source === 'referent_resume')
        && !(v.handled === true && 'responseText' in v && v.responseText.includes(spokenPhone('2145550100'))),
      'no old Shannon resolution');
  }

  // ── F. MULTI-ENTITY ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Hunter', relationship: 'son', phone: '2145550111', importance: 7 });
    writeContactRaw({ name: 'Grant', relationship: 'son', phone: '2145550222', importance: 7 });
    const t1 = await say('Who are my sons?');
    assert('F1 multi-son identity read does not establish', { t1, live: subject.hasLive(), peek: subject.peek() },
      v => v.t1.handled === false && v.live === false && v.peek === null,
      'no subject');
    const t2 = await say("What's his number?");
    assert('F2 pronoun does not pick a son', t2,
      v => !(v.handled === true && v.source === 'referent_resume')
        && !(v.handled === true && 'responseText' in v && (v.responseText.includes('214-555-0111') || v.responseText.includes('214-555-0222'))),
      'no pick');
  }

  // ── G. PENDING PRECEDENCE ──
  {
    const { say, session, subject } = freshFlow();
    const shannonId = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    seedTwoDoctorOutcomes();
    await say('Who is my wife?');
    const arm = await say('What did my doctor tell me?');
    assert('G1 medical pending arms', { arm, pending: session.hasPending() },
      v => v.arm.handled === true && v.arm.source === 'capture' && v.pending === true,
      'pending armed');
    subject.establishFamily({ entityId: shannonId, displayName: 'Shannon', relationship: 'wife' });
    assert('G2 holder prepared with live subject while pending', subject.hasLive(), v => v === true, 'live');
    const t3 = await say("What's her number?");
    assert('G3 PendingSlot owns the utterance', t3,
      v => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes(spokenPhone('2145550100'))
        && !/Shannon/i.test(v.responseText),
      'pending_resume, no Shannon phone');
    assert('G4 Flow C resolver was not evaluated', subject.didEvaluateReferent(), v => v === false, 'not evaluated');
    assert('G5 subject cleared when pending owned the turn', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── H. HOUSEHOLD ──
  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    const t1 = await say('Who is my plumber?');
    assert('H1 plumber identity read names Bob', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_action'
        && v.routeDecision.actionIntent.type === 'household_read',
      'household_read');
    const established = subject.peek();
    assert('H2 exactly-one plumber establishes household subject', established,
      v => v?.domain === 'household_provider' && v.displayName === 'Bob' && typeof v.entityId === 'string' && v.entityId.length > 0,
      'household_provider Bob');
    const t2 = await say("What's his number?");
    assert('H3 pronoun phone is Flow C current Bob number', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550103'))
        && v.responseText.includes('Bob')
        && !/plumber/i.test(v.responseText),
      "Bob's number, no cached plumber copy");
    assert('H4 subject clears after consume', subject.hasLive(), v => v === false, 'cleared');
  }

  // Insurance/legal household reads do not establish
  {
    const { say, subject, db } = freshFlow();
    db.prepare(
      `INSERT INTO insurance_policies (id, type, carrier, is_active, created_at, updated_at)
       VALUES ('ins1', 'home', 'State Farm', 1, datetime('now'), datetime('now'))`
    ).run();
    await say("Who's my home insurance with?");
    assert('H5 insurance read does not establish subject', subject.hasLive(), v => v === false, 'no subject');
  }

  // ── I. RESTART ──
  {
    const a = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await a.say('Who is my wife?');
    assert('I1 holder A has subject', a.subject.hasLive(), v => v === true, 'live');
    const b = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t = await b.say("What's her number?");
    assert('I2 new holder/session does not resolve old subject', t,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'no resolution');
  }

  // ── J. STALE PHONE ──
  {
    const { say, subject, db } = freshFlow();
    const id = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE contacts SET phone = ? WHERE id = ?`).run('4695550999', entityId);
    const t2 = await say("What's her phone number?");
    assert('J1 re-read returns NEW phone', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550999'))
        && !v.responseText.includes(spokenPhone('2145550100')),
      'new phone, not old');
  }

  // ── K. SECOND PRONOUN AFTER CONSUME ──
  {
    const { say } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say("What's her number?");
    assert('K1 first pronoun consumes', t2, v => v.handled === true && v.source === 'referent_resume', 'referent_resume');
    const t3 = await say("What's her number?");
    assert('K2 second pronoun has no old-subject resolution', t3,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'no old-subject resolution');
  }

  // ── L. RELATIONSHIP / CATEGORY STALENESS ──
  {
    const { say, subject, db } = freshFlow();
    const id = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE contacts SET relationship = ? WHERE id = ?`).run('sister', entityId);
    const t2 = await say("What's her number?");
    assert('L1 phone from current row, not stale wife copy', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && !/wife/i.test(v.responseText)
        && !/sister/i.test(v.responseText),
      'current phone, no relationship spoken');
  }
  {
    const { say, subject, db } = freshFlow();
    const id = writeServiceProvider('plumber', 'Bob', '469-555-0103');
    await say('Who is my plumber?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE service_providers SET category = ? WHERE id = ?`).run('electrician', entityId);
    const t2 = await say("What's his number?");
    assert('L2 phone from current provider row, not stale plumber copy', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550103'))
        && !/plumber/i.test(v.responseText)
        && !/electrician/i.test(v.responseText),
      'current phone, no category spoken');
  }

  // ── M. PRONOUN GENDER MISMATCH ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const id = subject.peek()?.entityId;
    assert('M1 no gender field on established subject', subject.peek(),
      v => v != null && !('gender' in v) && !('pronoun' in v),
      'no gender/pronoun field');
    const tHis = await say("What's his number?");
    assert('M2 opposite pronoun his binds the one subject', tHis,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon'),
      'same Shannon phone');
    void id;
  }
  {
    const { say } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const tHer = await say("What's her number?");
    assert('M3 matching pronoun her binds the same id authority', tHer,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon'),
      'same Shannon phone');
  }

  // Nameless provider: no subject
  {
    const { say, subject, db } = freshFlow();
    db.prepare(
      `INSERT INTO service_providers (id, name, phone, category, created_at, updated_at)
       VALUES ('sp_bad', '', '4695550103', 'plumber', datetime('now'), datetime('now'))`
    ).run();
    await say('Who is my plumber?');
    assert('N-nameless provider does not establish', subject.hasLive(), v => v === false, 'no subject');
  }

  // Law 0 clears a live subject
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t = await say('I need help');
    assert('L0a Law 0 owns the turn', t, v => v.handled === true && v.source === 'emergency', 'emergency');
    assert('L0b Law 0 clears subject', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── Continuity Step 3 — doctor subject + visit-date referent ───────────────
  assert('V-him', isReferentVisitDateQuestion('When did I see him?'), v => v === true, 'true');
  assert('V-last-her', isReferentVisitDateQuestion('When did I last see her?'), v => v === true, 'true');
  assert('V-patel-out', isReferentVisitDateQuestion('When did I see Dr. Patel?'), v => v === false, 'false');
  assert('V-phone-out', isReferentVisitDateQuestion("What's his number?"), v => v === false, 'false');

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const before = getMedicalRecords().length;
    const t1 = await say('Who was the last doctor I saw?');
    assert('S3-1a Variant A still visit_history_read (no pronoun, unhinted global ok)', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_read'
        && v.routeDecision.response.includes('Dr. Smith'),
      'device_read / visit_history_read / Smith');
    const established = subject.peek();
    assert('S3-1 doctor read establishes medical_doctor with the latest name', established,
      v => v?.domain === 'medical_doctor' && v.entityId === 'Dr. Smith' && v.displayName === 'Dr. Smith',
      'medical_doctor Dr. Smith');
    assert('S3-10 establishment does not write medical_records', getMedicalRecords().length,
      v => v === before, String(before));
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Patel?');
    assert('S3-4 named Patel remains visit_history_read', subject.peek(),
      v => v?.domain === 'medical_doctor' && v.entityId === 'Dr. Patel',
      'established Patel');
    const tNamed = await (async () => {
      const { say: say2 } = freshFlow();
      seedTwoDoctorOutcomes();
      const t = await say2('When did I see Dr. Patel?');
      return t;
    })();
    assert('S3-4b reason unchanged for named doctor', tNamed,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_read',
      'medical:visit_history_read');
    const t2 = await say('When did I see him?');
    const patelSpoken = formatSpokenDate('2026-05-01');
    const smithSpoken = formatSpokenDate('2026-07-20');
    assert('S3-2 live doctor + when-did-I-see-him is referent_resume from storage', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes('Dr. Patel')
        && v.responseText.includes(patelSpoken)
        && !v.responseText.includes('Dr. Smith')
        && !v.responseText.includes(smithSpoken),
      `referent_resume Patel on ${patelSpoken}, not Smith`);
    assert('S3-2b subject clears after visit-date consume', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const t1 = await say('When did I see him?');
    assert('S3-3a pronoun with no subject is unresolved_referent', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent'
        && v.routeDecision.response === "I'm not sure who you mean — which doctor?"
        && !/Smith|Patel|You last saw/i.test(v.routeDecision.response),
      'unresolved_referent clarification, no global visit data');
    assert('S3-3c no subject established', subject.hasLive(), v => v === false, 'no subject');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const t2 = await say('Open YouTube');
    assert('S3-5a unused turn is not Flow C', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    assert('S3-5b subject gone after unused turn', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say('When did I see him?');
    assert('S3-5c later pronoun fail-closed', t3,
      v => v.handled === false
        && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent'
        && !/Smith|Patel|You last saw/i.test(v.routeDecision.response),
      'unresolved_referent, no global visit data');
  }

  {
    const { say, session, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const arm = await say('What did my doctor tell me?');
    assert('S3-6a medical pending arms', { arm, pending: session.hasPending() },
      v => v.arm.handled === true && v.arm.source === 'capture' && v.pending === true,
      'pending armed');
    assert('S3-6b pending clears subject before next turn', subject.hasLive(), v => v === false, 'cleared by pending arm');
    subject.establishMedical({ entityId: 'Dr. Smith', displayName: 'Dr. Smith' });
    const t3 = await say('When did I see him?');
    assert('S3-6c PendingSlot owns the visit-date pronoun', t3,
      v => v.handled === true && v.source === 'pending_resume'
        && !/You last saw/i.test(v.responseText),
      'pending_resume, not a visit-history read');
    assert('S3-6d Flow C resolver was not evaluated', subject.didEvaluateReferent(), v => v === false, 'not evaluated');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const t = await say('I need help');
    assert('S3-7a Law 0 owns the turn', t, v => v.handled === true && v.source === 'emergency', 'emergency');
    assert('S3-7b Law 0 clears doctor subject', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    seedTwoDoctorOutcomes();
    await say('Who is my plumber?');
    assert('S3-H live household subject', subject.peek()?.domain, v => v === 'household_provider', 'household_provider');
    const t2 = await say('When did I see him?');
    assert('S3-H no cross-domain visit answer', t2,
      v => !(v.handled === true && v.source === 'referent_resume' && typeof v.responseText === 'string' && /last saw/i.test(v.responseText)),
      'not a visit-date referent_resume');
    assert('S3-H falls through to unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent',
      'medical:visit_history_unresolved_referent');
  }

  // ── Continuity Step 3b — doctor subject + visit-outcome referent ───────────
  console.log(`\n${BOLD}  Visit-outcome referent (Flow C + tierRouter guard)${RESET}\n`);

  assert('O-P-he', isReferentVisitOutcomeQuestion('What did he tell me?'), v => v === true, 'true');
  assert('O-P-she', isReferentVisitOutcomeQuestion('What did she tell me?'), v => v === true, 'true');
  assert('O-P-they', isReferentVisitOutcomeQuestion('What did they tell me?'), v => v === true, 'true');
  assert('O-P-patel-out', isReferentVisitOutcomeQuestion('What did Dr. Patel tell me?'), v => v === false, 'false');
  assert('O-P-him-out', isReferentVisitOutcomeQuestion('What did him tell me?'), v => v === false, 'false');

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    assert('O1a Smith established', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did he tell me?');
    assert('O1b referent_resume with Smith outcome', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(PATEL_OUTCOME),
      'referent_resume / Smith outcome');
    assert('O1c subject cleared after consume', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    await say('When did I see Dr. Smith?');
    assert('O2a Smith subject locked', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did he tell me?');
    assert('O2b returns Smith outcome, not newer Foster', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes('elevated')
        && !v.responseText.includes(FOSTER_OUTCOME),
      'Smith only');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const t1 = await say('What did he tell me?');
    assert('O3a no-subject → visit_outcome_unresolved_referent', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
    assert('O3b clarify copy', t1,
      v => v.handled === false && v.routeDecision.response === "I'm not sure who you mean — which doctor?",
      "I'm not sure who you mean — which doctor?");
    assert('O3c never global latest outcome', t1,
      v => v.handled === false
        && !v.routeDecision.response.includes(SMITH_OUTCOME)
        && !v.routeDecision.response.includes(PATEL_OUTCOME)
        && v.routeDecision.tier === 1,
      'tier-1 clarify, no Smith/Patel leak');
    assert('O3d no subject established', subject.hasLive(), v => v === false, 'no subject');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    assert('O4a stale Smith subject live', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did Dr. Patel tell me?');
    assert('O4b explicit Patel wins over stale subject', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_outcome_read'
        && v.routeDecision.response.includes(PATEL_OUTCOME)
        && !v.routeDecision.response.includes(SMITH_OUTCOME),
      'Patel outcome via named read');
    assert('O4c not referent_resume hijack', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
  }

  {
    const { say, subject } = freshFlow();
    writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20', status: 'noted' });
    await say('When did I see Dr. Smith?');
    const t2 = await say('What did he tell me?');
    assert('O5a no stored outcome → exact miss string', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText === VISIT_OUTCOME_MISS,
      VISIT_OUTCOME_MISS);
    assert('O5b subject cleared after miss consume', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    seedTwoDoctorOutcomes();
    await say('Who is my wife?');
    assert('O6a family subject live', subject.peek()?.domain, v => v === 'family_contact', 'family_contact');
    const t2 = await say('What did he tell me?');
    assert('O6b no medical cross-resolution from family subject', t2,
      v => !(v.handled === true && v.source === 'referent_resume'
        && typeof v.responseText === 'string'
        && (v.responseText.includes(SMITH_OUTCOME) || v.responseText.includes(PATEL_OUTCOME))),
      'no medical outcome via family subject');
    assert('O6c fail-closed to visit_outcome_unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
  }

  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    seedTwoDoctorOutcomes();
    await say('Who is my plumber?');
    assert('O6d household subject live', subject.peek()?.domain, v => v === 'household_provider', 'household_provider');
    const t2 = await say('What did he tell me?');
    assert('O6e no medical cross-resolution from household subject', t2,
      v => !(v.handled === true && v.source === 'referent_resume'
        && typeof v.responseText === 'string'
        && (v.responseText.includes(SMITH_OUTCOME) || v.responseText.includes(PATEL_OUTCOME))),
      'no medical outcome via household subject');
    assert('O6f fail-closed to visit_outcome_unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    const tShe = await say('What did she tell me?');
    assert('O7a she pronoun referent_resume Smith outcome', tShe,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME),
      'she → Smith outcome');
    assert('O7b she consume clears subject', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    const tThey = await say('What did they tell me?');
    assert('O7c they pronoun referent_resume Smith outcome', tThey,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME),
      'they → Smith outcome');
    assert('O7d they consume clears subject', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    await say('When did I see him?');
    assert('O8a visit-date consume cleared subject', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say('What did he tell me?');
    assert('O8b subsequent outcome pronoun fail-closed', t3,
      v => v.handled === false
        && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent'
        && !v.routeDecision.response.includes(SMITH_OUTCOME)
        && !v.routeDecision.response.includes(PATEL_OUTCOME),
      'unresolved_referent, no lifetime expansion');
  }

  {
    const procPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/processUtterance.ts');
    const src = fs.readFileSync(procPath, 'utf8');
    const liveStart = src.indexOf('if (subject?.hasLive())');
    const liveEnd = src.indexOf('// 2) The single routing authority');
    const liveBlock = src.slice(liveStart, liveEnd);
    const outcomeIdx = liveBlock.indexOf('isReferentVisitOutcomeQuestion(text)');
    const trailingClearIdx = liveBlock.lastIndexOf('subject.clear();');
    assert('O-SL outcome block precedes trailing unused-subject clear', { outcomeIdx, trailingClearIdx },
      v => (v as { outcomeIdx: number; trailingClearIdx: number }).outcomeIdx > 0
        && (v as { outcomeIdx: number; trailingClearIdx: number }).outcomeIdx
          < (v as { outcomeIdx: number; trailingClearIdx: number }).trailingClearIdx,
      'outcome before trailing clear');
    assert('O-SL outcome block follows visit-date block', liveBlock,
      v => (v as string).indexOf('isReferentVisitDateQuestion(text)')
        < (v as string).indexOf('isReferentVisitOutcomeQuestion(text)'),
      'visit-date before outcome');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('conversationalSubject.test')) {
  runConversationalSubjectTests().catch(console.error);
}
