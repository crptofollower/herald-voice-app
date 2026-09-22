// Natural Recollection Authority Wall V1 — Slice 1 proof.
// Track R write/read wall + deletion substrate. Not the final classifier.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { listActiveEvidence, persistEvidence, softRemoveEvidence } from '../../src/db/evidenceDB.ts';
import { answerLiveReminiscenceRecall } from '../../src/db/recollectionRead.ts';
import { resetReminiscenceAdmissionState } from '../../src/db/reminiscenceWrite.ts';
import {
  detectDontSaveReminiscence,
  detectReminiscenceAdmission,
  detectReminiscenceRecall,
} from '../../src/utils/reminiscenceAdmission.ts';
import { realizeRecollectionTold } from '../../src/conversation/recollectionRealization.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHILDHOOD = 'When I was a kid, we spent summers at the lake.';
const UNCERTAIN = 'When I was a kid, I think we moved around 1978, maybe 1979.';
const WORLD = 'When I was a kid, 1957 was the hottest summer on record.';
const RECALL = 'What did I say about when I was a kid?';
const PREFIX = 'You told me';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function fresh() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  resetReminiscenceAdmissionState();
  setNow(new Date(2026, 8, 22, 12, 0, 0));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) => processUtterance(text, session, deps, subject);
  return { db, session, subject, say };
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number };
  return row.n;
}

function snapshotT(db: Database.Database) {
  return {
    medical: count(db, 'medical_records'),
    facts: count(db, 'facts'),
    contacts: count(db, 'contacts'),
    entities: count(db, 'entities'),
    edges: count(db, 'entity_relationships'),
    episodes: count(db, 'episodes'),
    medications: count(db, 'medications'),
  };
}

function spoken(out: { responseText?: string; routeDecision?: { response?: string } }): string {
  if (typeof out.responseText === 'string' && out.responseText) return out.responseText;
  if (typeof out.routeDecision?.response === 'string') return out.routeDecision.response;
  return '';
}

export async function runNaturalRecollectionAuthorityWallV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Natural Recollection Authority Wall v1 (Slice 1) --${RESET}\n`);

  try {
    const srcRoot = path.join(root, 'src');
    function walk(dir: string, acc: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dev') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
      }
      return acc;
    }
    const trackTReaders = [
      'src/db/medicalDB.ts',
      'src/db/contactsDB.ts',
      'src/db/graphRead.ts',
      'src/utils/familyRead.ts',
    ].map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
    const calendarRead = fs.readFileSync(path.join(root, 'src/db/calendarEvidenceDoctorRead.ts'), 'utf8');
    const realization = fs.readFileSync(path.join(root, 'src/conversation/recollectionRealization.ts'), 'utf8');
    const reader = fs.readFileSync(path.join(root, 'src/db/recollectionRead.ts'), 'utf8');

    assert('SCHEMA_VERSION is 25', SCHEMA_VERSION, (v) => v === 25, '25');
    assert('Track T readers do not query evidence as truth',
      /FROM evidence/i.test(trackTReaders), (v) => v === false, 'false');
    assert('calendar evidence reader is scoped to external_source/calendar',
      /sourceKind: "calendar"/.test(calendarRead) && /sourceClass: "external_source"/.test(calendarRead),
      (v) => v === true, 'true');
    assert('recollection prefix is module-private and not a caller parameter',
      /const RECOLLECTION_PREFIX = 'You told me'/.test(realization)
        && !/framed\s*:/.test(realization)
        && /realizeRecollectionTold\(/.test(reader),
      (v) => v === true, 'true');
    assert('Slice-1 admission is the single childhood shape',
      detectReminiscenceAdmission(CHILDHOOD) === CHILDHOOD
        && detectReminiscenceAdmission('We spent summers at the lake.') === null
        && detectReminiscenceAdmission('Remember that when I was a kid, we spent summers at the lake.') === null,
      (v) => v === true, 'true');
    assert('Slice-1 recall and don\'t-save are closed',
      detectReminiscenceRecall(RECALL)
        && detectDontSaveReminiscence("Don't remember that.")
        && detectDontSaveReminiscence("Don't save that")
        && detectReminiscenceRecall('What have I told you?') === false,
      (v) => v === true, 'true');

    {
      const { db, say } = await fresh();
      const before = snapshotT(db);
      const ack = await say(CHILDHOOD);
      const after = snapshotT(db);
      const live = listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
      assert('admission persists user_explicit reminiscence verbatim',
        ack.responseText === 'Okay.'
          && ack.source === 'recollection'
          && live.length === 1
          && live[0].rawText === CHILDHOOD
          && live[0].sourceClass === 'user_explicit'
          && live[0].sourceKind === 'reminiscence'
          && live[0].eventAt == null,
        (v) => v === true, 'true');
      assert('R write causes zero Track T / entity / edge / episode deltas',
        JSON.stringify(after) === JSON.stringify(before),
        (v) => v === true, JSON.stringify(before));
    }

    {
      const { say } = await fresh();
      await say(CHILDHOOD);
      const recalled = await say(RECALL);
      assert('reader emits mandatory provenance framing of the verbatim row',
        recalled.responseText === `${PREFIX} ${CHILDHOOD}`
          && recalled.responseText.startsWith(PREFIX)
          && recalled.responseText.includes(CHILDHOOD)
          && recalled.source === 'recollection',
        (v) => v === true, 'true');
      assert('reader does not invent unsupported details (R12)',
        !/brother|Friday|1982|because/.test(recalled.responseText ?? ''),
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say(WORLD);
      const recalled = await say(RECALL);
      assert('external-world proposition remains recollection-only (R11)',
        recalled.responseText === `${PREFIX} ${WORLD}`
          && recalled.responseText !== '1957 was the hottest summer on record.',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say(UNCERTAIN);
      const recalled = await say(RECALL);
      const live = listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
      assert('uncertainty remains verbatim; structure stays unset (R5)',
        live[0]?.eventAt == null
          && recalled.responseText === `${PREFIX} ${UNCERTAIN}`
          && /maybe 1979/.test(recalled.responseText ?? '')
          && !/That was in 1978/.test(recalled.responseText ?? ''),
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      await say(CHILDHOOD);
      const id = listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' })[0].id;
      softRemoveEvidence(id);
      const recalled = await say(RECALL);
      assert('deleted R is unavailable to retrieval (R7)',
        listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' }).length === 0
          && recalled.responseText === "You haven't told me that kind of thing yet."
          && count(db, 'evidence') === 1,
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say(CHILDHOOD);
      const suppressed = await say("Don't remember that.");
      const recalled = await say(RECALL);
      assert('explicit don\'t-remember suppresses the just-shared row (R8)',
        suppressed.responseText === "Okay — I won't keep that."
          && recalled.responseText === "You haven't told me that kind of thing yet."
          && listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' }).length === 0,
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      const before = snapshotT(db);
      const health = await say('When I was a kid, I took insulin every morning.');
      const finance = await say('When I was a kid, the bank held our mortgage.');
      const secret = await say('When I was a kid, my password was hunter2.');
      assert('sensitive Slice-1 examples fail closed with no R row',
        listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' }).length === 0
          && detectReminiscenceAdmission('When I was a kid, I took insulin every morning.') === null
          && health.source !== 'recollection'
          && finance.source !== 'recollection'
          && secret.source !== 'recollection'
          && JSON.stringify(snapshotT(db)) === JSON.stringify(before),
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      const before = count(db, 'episodes');
      const pending = await say("Remember that we had dinner at Luigi's last Friday.");
      assert('explicit Episode Capture is unchanged (R9)',
        /Want me to remember that you had dinner at Luigi's last Friday/.test(spoken(pending))
          && pending.source === 'capture'
          && count(db, 'episodes') === before
          && listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' }).length === 0,
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
      await say("What's my wife's number?");
      assert('family/contact authority is unchanged (R10)',
        subject.peek()?.domain === 'family_contact',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', notes: 'visit', visit_date: '2026-05-04' });
      const visit = await say('When did I see Dr. Vance?');
      assert('medical visit-history authority is unchanged (R10)',
        /You last saw Dr\. Vance on/.test(spoken(visit))
          && visit.source !== 'recollection',
        (v) => v === true, 'true');
    }

    {
      const probe = await classifyQuery('what have i told you');
      assert('existing TIER2 memory probe remains owned by memory:probe',
        probe.tier === 2 && probe.reason === 'memory:probe',
        (v) => v === true, 'true');
    }

    {
      const { db } = await fresh();
      void db;
      persistEvidence({
        sourceClass: 'user_explicit',
        sourceKind: 'remember',
        rawText: 'Remember the guy named Frank.',
      });
      assert('recollection reader does not speak other user_explicit kinds',
        answerLiveReminiscenceRecall() === "You haven't told me that kind of thing yet.",
        (v) => v === true, 'true');
    }

    assert('realizeRecollectionTold cannot omit the prefix',
      realizeRecollectionTold(CHILDHOOD).startsWith(PREFIX + ' '),
      (v) => v === true, 'true');

    const evidenceSqlHits = walk(srcRoot).flatMap((file) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (rel === 'src/db/evidenceDB.ts' || rel === 'src/dev/androidJourneyHost.ts') return [];
      const text = fs.readFileSync(file, 'utf8');
      return [...text.matchAll(/\bFROM\s+evidence\b/gi)].map(() => rel);
    });
    assert('only evidenceDB (and inspect host) issue FROM evidence SQL',
      evidenceSqlHits, (v) => Array.isArray(v) && (v as string[]).length === 0, '[]');
  } finally {
    resetNow();
    resetReminiscenceAdmissionState();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NaturalRecollectionAuthorityWall: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('naturalRecollectionAuthorityWall.test.ts')) {
  runNaturalRecollectionAuthorityWallV1Tests().catch((err) => {
    resetNow();
    console.error(err);
  });
}
