// Rung 5 — episode discourse continuity v1.
// Reuses ConversationalSubjectHolder: recall → establish → "When was that?" → live re-read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  ConversationalSubjectHolder,
  isReferentEpisodeTimeQuestion,
} from '../../src/routing/conversationalSubject.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import {
  listActiveEpisodes,
  softRemoveEpisode,
  writeEpisode,
} from '../../src/db/episodesWriter.ts';
import { formatSpokenDate } from '../../src/utils/parseTime.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JOURNEY = "Remember that we had dinner at Luigi's last Friday.";
const RECALL = 'What did I ask you to remember?';
const WHEN = 'When was that?';
const SPOKEN_DAY = formatSpokenDate('2026-09-18');
const DAY_ANSWER = `That was on ${SPOKEN_DAY}.`;

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
  setNow(new Date(2026, 8, 21, 12, 0, 0));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  let llmCalls = 0;
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => {
      llmCalls += 1;
      return { status: 'ok' as const, intents: [] };
    },
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) => processUtterance(text, session, deps, subject);
  return { db, session, subject, say, llmCalls: () => llmCalls };
}

function count(db: Database.Database, table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''};`).get() as { n: number };
  return row.n;
}

function seed(rawPhrase: string, occurredAt: string | null, precision: 'day' | 'month' | 'year' | 'unknown') {
  const written = writeEpisode({ rawPhrase, occurredAt, occurredPrecision: precision });
  if (!written.ok) throw new Error(`seed failed: ${rawPhrase}`);
  return written.episodeId;
}

function spoken(out: { responseText?: string; routeDecision?: { response?: string } }): string {
  if (typeof out.responseText === 'string' && out.responseText) return out.responseText;
  if (typeof out.routeDecision?.response === 'string') return out.routeDecision.response;
  return '';
}

function snapshotGraph(db: Database.Database) {
  return {
    episodes: count(db, 'episodes'),
    entities: count(db, 'entities'),
    facts: count(db, 'facts'),
    evidence: count(db, 'evidence'),
    edges: count(db, 'entity_relationships'),
  };
}

export async function runRung5EpisodeDiscourseContinuityTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 episode discourse continuity v1 --${RESET}\n`);

  try {
    const subjectSrc = fs.readFileSync(path.join(root, 'src/routing/conversationalSubject.ts'), 'utf8');
    const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
    assert('episode time realization never uses captured_at or re-parses raw_phrase',
      /captured_at/.test(subjectSrc.slice(subjectSrc.indexOf('isReferentEpisodeTimeQuestion')))
        || /parseDatePhrase/.test(subjectSrc.slice(subjectSrc.indexOf('realizeEpisodeOccurredTime'))),
      (v) => v === false, 'false');
    assert('establishment seam is episode:recall through listActiveEpisodes',
      /reason === 'episode:recall'/.test(processSrc)
        && /listActiveEpisodes\(EPISODE_RECALL_LIMIT\)/.test(processSrc)
        && /establishEpisode/.test(processSrc)
        && /isReferentEpisodeTimeQuestion/.test(processSrc),
      (v) => v === true, 'true');
    assert('bounded referent family only',
      isReferentEpisodeTimeQuestion('When was that?')
        && isReferentEpisodeTimeQuestion('When was this?')
        && isReferentEpisodeTimeQuestion('When was that again?')
        && isReferentEpisodeTimeQuestion('when was this?')
        && isReferentEpisodeTimeQuestion('When was that?'),
      (v) => v === true, 'true');
    assert('does not admit where/who/ordinal/temporal-search variants',
      isReferentEpisodeTimeQuestion('Where was that?') === false
        && isReferentEpisodeTimeQuestion('Who was with me?') === false
        && isReferentEpisodeTimeQuestion('When was that last Friday?') === false
        && isReferentEpisodeTimeQuestion('When was that in August?') === false
        && isReferentEpisodeTimeQuestion('the second one') === false,
      (v) => v === true, 'true');

    {
      const { subject, say } = await fresh();
      const id = seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      const recalled = await say(RECALL);
      const live = subject.peek();
      assert('exactly one recalled episode establishes an episode subject',
        /you had dinner at Luigi's last Friday/.test(spoken(recalled))
          && live?.domain === 'episode'
          && live.episodeId === id
          && typeof live.displayLabel === 'string'
          && typeof live.establishedAtTurn === 'number',
        (v) => v === true, 'true');
    }

    {
      const { db, subject, say, llmCalls } = await fresh();
      await say(JOURNEY);
      await say('Yes.');
      const recalled = await say(RECALL);
      const llmBeforeWhen = llmCalls();
      const before = snapshotGraph(db);
      const when = await say(WHEN);
      const after = snapshotGraph(db);
      assert('journey recall then When was that answers stored day precision',
        /You asked me to remember that you had dinner at Luigi's last Friday/.test(spoken(recalled))
          && when.responseText === DAY_ANSWER
          && when.source === 'referent_resume'
          && when.commits.length === 0
          && llmCalls() === llmBeforeWhen,
        (v) => v === true, 'true');
      assert('follow-up writes no episode/entity/fact/evidence/relationship rows',
        JSON.stringify(after) === JSON.stringify(before),
        (v) => v === true, JSON.stringify(before));
      assert('subject clears after the episode-time answer and is not renewed',
        subject.peek(), (v) => v == null, 'null');
    }

    {
      const { subject, say } = await fresh();
      seed("we went to Luigi's in August", '2026-08-01', 'month');
      await say(RECALL);
      const when = await say(WHEN);
      assert('same-year month speaks month only, never a day or weekday',
        when.responseText === 'That was in August.'
          && !/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i.test(when.responseText)
          && !/\b\d{1,2}(st|nd|rd|th)\b/.test(when.responseText)
          && !/2026/.test(when.responseText),
        (v) => v === true, 'true');
      void subject;
    }

    {
      const { say } = await fresh();
      seed("we went to Luigi's in August", '2024-08-01', 'month');
      await say(RECALL);
      const when = await say(WHEN);
      assert('different-year month includes the year and never a day',
        when.responseText === 'That was in August 2024.'
          && !/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i.test(when.responseText)
          && !/\b\d{1,2}(st|nd|rd|th)\b/.test(when.responseText),
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      seed('we traveled last year', '2024-06-15', 'year');
      await say(RECALL);
      const when = await say(WHEN);
      assert('year precision speaks the year only',
        when.responseText === 'That was in 2024.'
          && !/June/.test(when.responseText)
          && !/\b15/.test(when.responseText),
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      seed('we had dinner sometime', null, 'unknown');
      await say(RECALL);
      const when = await say(WHEN);
      assert('unknown precision is an honest miss',
        when.responseText === "You didn't say when that was."
          && when.source === 'referent_resume',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      seed("we went in August", null, 'month');
      await say(RECALL);
      const when = await say(WHEN);
      assert('NULL occurred_at is unusable even when precision is month',
        when.responseText === "You didn't say when that was.",
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      const id = seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      softRemoveEpisode(id);
      const when = await say(WHEN);
      assert('soft-removed episode fails inside continuity, not from cached metadata',
        when.responseText === "I don't have that memory anymore."
          && when.source === 'referent_resume'
          && !when.responseText.includes(SPOKEN_DAY)
          && !/Luigi/.test(when.responseText)
          && subject.peek() == null,
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      const id = seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
      const when = await say(WHEN);
      assert('missing episode is a bounded honest miss, not a downstream fabrication',
        when.responseText === "I don't have that memory anymore."
          && when.source === 'referent_resume'
          && !when.responseText.includes(SPOKEN_DAY),
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      seed('we ate first', '2026-09-01', 'day');
      setNow(new Date(2026, 8, 21, 12, 0, 1));
      seed('we ate second', '2026-09-10', 'day');
      const recalled = await say(RECALL);
      assert('two recalled episodes establish no episode subject',
        /You've asked me to remember a few things/.test(spoken(recalled))
          && subject.peek() == null,
        (v) => v === true, 'true');
      const when = await say(WHEN);
      assert('When was that after multi-result recall does not silently select an episode',
        when.responseText !== `That was on ${formatSpokenDate('2026-09-10')}.`
          && when.responseText !== `That was on ${formatSpokenDate('2026-09-01')}.`
          && when.source !== 'referent_resume',
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      seed('one', '2026-01-01', 'day');
      setNow(new Date(2026, 8, 21, 12, 0, 1));
      seed('two', '2026-02-01', 'day');
      setNow(new Date(2026, 8, 21, 12, 0, 2));
      seed('three', '2026-03-01', 'day');
      await say(RECALL);
      assert('three recalled episodes establish no episode subject',
        subject.peek(), (v) => v == null, 'null');
    }

    {
      const { subject, say } = await fresh();
      seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      const when = await say('When is my appointment?');
      const routed = await classifyQuery('When is my appointment?');
      assert('unrelated appointment when-query keeps existing authority',
        spoken(when) !== DAY_ANSWER
          && !/Luigi/.test(spoken(when))
          && routed.reason !== 'episode:recall'
          && subject.peek() == null,
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', notes: 'visit', visit_date: '2026-05-04' });
      seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      const visit = await say('When did I see Dr. Vance?');
      assert('named medical when-query remains visit-history, not episode time',
        /You last saw Dr\. Vance on/.test(spoken(visit))
          && spoken(visit) !== DAY_ANSWER
          && !/Luigi/.test(spoken(visit))
          && visit.source !== 'referent_resume',
        (v) => v === true, 'true');
      void subject;
    }

    {
      const { subject, say } = await fresh();
      writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
      await say("What's my wife's number?");
      assert('family subject establishment is unchanged',
        subject.peek()?.domain === 'family_contact',
        (v) => v === true, 'true');
    }

    {
      const { subject, say } = await fresh();
      seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      await say('Thanks.');
      assert('unused episode subject follows existing one-turn clear',
        subject.peek(), (v) => v == null, 'null');
    }

    {
      const { say } = await fresh();
      seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      await say(RECALL);
      const thisQ = await say('When was this?');
      assert('When was this is the same referent family',
        thisQ.responseText === DAY_ANSWER && thisQ.source === 'referent_resume',
        (v) => v === true, 'true');
    }
  } finally {
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5EpisodeDiscourseContinuity: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5EpisodeDiscourseContinuity.test.ts')) {
  runRung5EpisodeDiscourseContinuityTests().catch((err) => {
    resetNow();
    console.error(err);
  });
}
