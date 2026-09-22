// Rung 5 Step 5 — explicit episodic memory capture v1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { detectEpisodeCapture } from '../../src/utils/episodeCapture.ts';
import { detectPersonAssociationCapture } from '../../src/utils/personAssociationCapture.ts';
import { detectFamilyCapture } from '../../src/utils/familyCapture.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { detectPersonAssociationRead } from '../../src/db/graphRead.ts';
import { LIST_ADD_SIGNALS } from '../../src/utils/instructionSignals.ts';
import { parseCalendarWriteIntent } from '../../src/utils/parseTime.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';
import {
  EPISODE_SOURCE_USER_UTTERANCE,
  getEpisodeById,
  softRemoveEpisode,
  writeEpisode,
} from '../../src/db/episodesWriter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JOURNEY = "Remember that we had dinner at Luigi's last Friday.";
const REMAINDER = "we had dinner at Luigi's last Friday";

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
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) => processUtterance(text, session, deps);
  return { db, session, say };
}

function speechOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  return 'responseText' in outcome && typeof outcome.responseText === 'string' ? outcome.responseText : '';
}

function count(db: Database.Database, table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''};`).get() as { n: number };
  return row.n;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function activeEpisodes(db: Database.Database) {
  return db.prepare(`SELECT * FROM episodes WHERE removed_at IS NULL ORDER BY captured_at, id;`).all() as Array<Record<string, unknown>>;
}

export async function runRung5Step5EpisodeCaptureTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Step 5 episode capture v1 --${RESET}\n`);

  try {
    const writerRel = path.join('src', 'db', 'episodesWriter.ts').replace(/\\/g, '/');
    const mutationHits = walkTs(path.join(root, 'src')).flatMap((file) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (rel === writerRel) return [];
      const text = fs.readFileSync(file, 'utf8');
      return [...text.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?|UPDATE)\b[\s\S]{0,80}episodes/gi)]
        .map((m) => `${rel}:${m[0].replace(/\s+/g, ' ').slice(0, 60)}`);
    });
    const writerSrc = fs.readFileSync(path.join(root, 'src/db/episodesWriter.ts'), 'utf8');
    const captureSrc = fs.readFileSync(path.join(root, 'src/utils/episodeCapture.ts'), 'utf8');
    const graphSrc = fs.readFileSync(path.join(root, 'src/db/graphRead.ts'), 'utf8');

    assert('sole writer authority: no INSERT/UPDATE on episodes outside episodesWriter.ts',
      mutationHits, (v) => Array.isArray(v) && (v as string[]).length === 0, '[]');
    assert('writer never hard-deletes episodes',
      /\bDELETE\s+FROM\s+episodes\b/i.test(writerSrc), (v) => v === false, 'false');
    assert('capture reuses parseDatePhrase and ConversationSession confirm primitives',
      /parseDatePhrase/.test(captureSrc) && /CONFIRM_YES_RE/.test(captureSrc) && /CONFIRM_NO_RE/.test(captureSrc),
      (v) => v === true, 'true');
    assert('graphRead is untouched by episode capture',
      /episode/i.test(graphSrc), (v) => v === false, 'false');
    assert('explicit cue required: ordinary dinner sentence is not an episode',
      detectEpisodeCapture("we had dinner at Luigi's last Friday"),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
    assert('ordinary conversation is not captured',
      detectEpisodeCapture('I like pizza').length === 0
        && detectEpisodeCapture("what's tomorrow").length === 0,
      (v) => v === true, 'true');
    assert('remember that admits the first journey',
      detectEpisodeCapture(JOURNEY),
      (v) => Array.isArray(v) && (v as { type?: string; rawPhrase?: string }[])[0]?.type === 'episode_capture'
        && (v as { rawPhrase?: string }[])[0]?.rawPhrase === REMAINDER,
      'episode_capture remainder');
    assert("closed cue family also admits remember when / don't forget that / make a note that / note that",
      detectEpisodeCapture("Remember when we had dinner at Luigi's last Friday.").length === 1
        && detectEpisodeCapture("Don't forget that we had dinner at Luigi's last Friday.").length === 1
        && detectEpisodeCapture("Make a note that we had dinner at Luigi's last Friday.").length === 1
        && detectEpisodeCapture("Note that we had dinner at Luigi's last Friday.").length === 1,
      (v) => v === true, 'true');
    assert('first journey does not collide with medical/list/calendar/association/family/graph',
      detectMedicalEvent(JOURNEY) === null
        && !LIST_ADD_SIGNALS.some((p) => p.test(JOURNEY))
        && parseCalendarWriteIntent(JOURNEY) === null
        && detectPersonAssociationCapture(JOURNEY).length === 0
        && detectFamilyCapture(JOURNEY).length === 0
        && detectPersonAssociationRead(JOURNEY) === null,
      (v) => v === true, 'true');
    {
      const { say } = await fresh();
      void say;
      const decision = await classifyQuery(JOURNEY);
      assert('first journey is not stolen by note_capture',
        decision.reason !== 'action:note_capture' && decision.actionIntent?.type !== 'note_capture',
        (v) => v === true, 'true');
    }

    {
      const { db, session, say } = await fresh();
      const entitiesBefore = count(db, 'entities');
      const edgesBefore = count(db, 'entity_relationships');
      const evidenceBefore = count(db, 'evidence');
      const factsBefore = count(db, 'facts');
      const first = await say(JOURNEY);
      assert('pending confirmation writes zero episode rows',
        session.hasPending() && session.peekPendingKey() === 'episode_capture'
          && count(db, 'episodes') === 0
          && /Want me to remember that you had dinner at Luigi's last Friday/i.test(speechOf(first))
          && !/I'll remember that/i.test(speechOf(first)),
        (v) => v === true, 'true');
      const yes = await say('Yes.');
      const rows = activeEpisodes(db);
      const row = rows[0] as {
        id: string;
        raw_phrase: string;
        occurred_at: string | null;
        occurred_precision: string | null;
        category: string | null;
        domain: string | null;
        salience: number | null;
        sentiment: string | null;
        source: string;
        score: number | null;
        embedding_ref: string | null;
        removed_at: string | null;
        captured_at: string;
      } | undefined;
      assert('confirm writes exactly one active episode row',
        !session.hasPending() && rows.length === 1 && count(db, 'episodes') === 1,
        (v) => v === true, 'true');
      assert('raw_phrase is the remainder without the memory cue',
        row?.raw_phrase === REMAINDER, (v) => v === true, 'true');
      assert("source is user_utterance",
        row?.source === EPISODE_SOURCE_USER_UTTERANCE, (v) => v === true, 'true');
      assert('metadata defaults are category NULL, domain general, ranking/embedding NULL',
        row?.category == null && row?.domain === 'general'
          && row?.salience == null && row?.sentiment == null
          && row?.score == null && row?.embedding_ref == null && row?.removed_at == null,
        (v) => v === true, 'true');
      assert('last Friday resolves to day precision through parseDatePhrase',
        row?.occurred_precision === 'day' && row?.occurred_at === '2026-09-18'
          && typeof row?.captured_at === 'string' && /Z$/.test(row.captured_at),
        (v) => v === true, 'true');
      assert('ACK is spoken only after verified persistence',
        /^I'll remember that\./i.test(speechOf(yes)) && !!getEpisodeById(row!.id),
        (v) => v === true, 'true');
      assert('commit creates no event/place entity, relationship edge, evidence, or fact',
        count(db, 'entities') === entitiesBefore
          && count(db, 'entities', "type = 'event'") === 0
          && count(db, 'entity_relationships') === edgesBefore
          && count(db, 'evidence') === evidenceBefore
          && count(db, 'facts') === factsBefore,
        (v) => v === true, 'true');

      await say(JOURNEY);
      await say('Yes.');
      assert('identical raw_phrase+occurred_at stays one active row',
        activeEpisodes(db).length === 1, (v) => v === true, 'true');
    }

    {
      const { db, session, say } = await fresh();
      await say(JOURNEY);
      const declined = await say('No.');
      assert('decline writes zero rows and does not claim memory',
        !session.hasPending() && count(db, 'episodes') === 0
          && /won't remember/i.test(speechOf(declined))
          && !/I'll remember that/i.test(speechOf(declined)),
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      await say("Remember that we went to Luigi's in August.");
      await say('Yes.');
      const row = activeEpisodes(db)[0] as { occurred_at: string | null; occurred_precision: string };
      assert('bare month is month precision without inventing a day',
        row?.occurred_precision === 'month' && row?.occurred_at == null, (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      await say("Remember that we went to Luigi's last year.");
      await say('Yes.');
      const row = activeEpisodes(db)[0] as { occurred_at: string | null; occurred_precision: string };
      assert('last year is year precision without a competing parser date',
        row?.occurred_precision === 'year' && row?.occurred_at == null, (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      await say("Remember that we had dinner at Luigi's.");
      await say('Yes.');
      const row = activeEpisodes(db)[0] as { occurred_at: string | null; occurred_precision: string; raw_phrase: string };
      assert('no parseable time stores NULL occurred_at with unknown precision',
        row?.occurred_precision === 'unknown' && row?.occurred_at == null
          && row?.raw_phrase === "we had dinner at Luigi's",
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      await say(JOURNEY);
      await say('Yes.');
      await say("Remember that we had dinner at Luigi's.");
      await say('Yes.');
      assert('distinct phrase/date remains a distinct active episode',
        activeEpisodes(db).length === 2, (v) => v === true, 'true');
    }

    {
      const { db } = await fresh();
      void db;
      const written = writeEpisode({
        rawPhrase: 'direct writer row',
        occurredAt: null,
        occurredPrecision: 'unknown',
      });
      const before = getEpisodeById(written.ok ? written.episodeId : '');
      const removed = written.ok && softRemoveEpisode(written.episodeId);
      const after = written.ok ? getEpisodeById(written.episodeId) : null;
      assert('softRemoveEpisode sets removed_at and does not hard-delete',
        written.ok && removed === true && before?.removed_at == null
          && after?.removed_at != null && after.id === written.episodeId,
        (v) => v === true, 'true');
      assert('writer rejects empty provenance instead of inserting',
        writeEpisode({ rawPhrase: '  ', occurredAt: null, occurredPrecision: 'unknown' }),
        (v) => (v as { ok: boolean }).ok === false, 'not ok');
    }

    {
      const { db, session, say } = await fresh();
      await say(JOURNEY);
      db.exec('DROP TABLE episodes');
      const failed = await say('Yes.');
      assert('simulated write failure produces no false memory ACK',
        /trouble holding onto that/i.test(speechOf(failed))
          && !/I'll remember that/i.test(speechOf(failed))
          && !session.hasPending(),
        (v) => v === true, 'true');
    }
  } finally {
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Step5EpisodeCapture: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Step5EpisodeCapture.test.ts')) {
  runRung5Step5EpisodeCaptureTests().catch((err) => {
    resetNow();
    console.error(err);
  });
}
