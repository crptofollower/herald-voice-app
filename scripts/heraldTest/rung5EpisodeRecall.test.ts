// Rung 5 — deterministic episode recall v1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery, isTemporalRecallRequest } from '../../src/routing/tierRouter.ts';
import { realizeEpisodePerspective } from '../../src/utils/episodeCapture.ts';
import { detectEpisodeRecall, answerEpisodeRecall } from '../../src/db/episodeRead.ts';
import {
  listActiveEpisodes,
  softRemoveEpisode,
  writeEpisode,
} from '../../src/db/episodesWriter.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JOURNEY = "Remember that we had dinner at Luigi's last Friday.";
const RECALL = 'What did I ask you to remember?';

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

function seed(rawPhrase: string, occurredAt: string | null, precision: 'day' | 'month' | 'year' | 'unknown') {
  const written = writeEpisode({ rawPhrase, occurredAt, occurredPrecision: precision });
  if (!written.ok) throw new Error(`seed failed: ${rawPhrase}`);
  return written.episodeId;
}

export async function runRung5EpisodeRecallTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 episode recall v1 --${RESET}\n`);

  try {
    const writerRel = path.join('src', 'db', 'episodesWriter.ts').replace(/\\/g, '/');
    const readRel = path.join('src', 'db', 'episodeRead.ts').replace(/\\/g, '/');
    const episodeSqlHits = walkTs(path.join(root, 'src')).flatMap((file) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (rel === writerRel) return [];
      const text = fs.readFileSync(file, 'utf8');
      return [...text.matchAll(/\bFROM\s+episodes\b/gi)].map(() => rel);
    });
    const readSrc = fs.readFileSync(path.join(root, 'src/db/episodeRead.ts'), 'utf8');
    const captureSrc = fs.readFileSync(path.join(root, 'src/utils/episodeCapture.ts'), 'utf8');
    const graphSrc = fs.readFileSync(path.join(root, 'src/db/graphRead.ts'), 'utf8');

    assert('episode answer SQL lives only in listActiveEpisodes',
      episodeSqlHits, (v) => Array.isArray(v) && (v as string[]).length === 0, '[]');
    assert('episodeRead consumes listActiveEpisodes and does not re-spell the active predicate',
      /listActiveEpisodes/.test(readSrc) && /removed_at IS NULL/.test(readSrc) === false,
      (v) => v === true, 'true');
    assert('episodeRead reuses capture-side realizeEpisodePerspective rather than a second transform',
      /realizeEpisodePerspective/.test(readSrc)
        && /export function realizeEpisodePerspective/.test(captureSrc)
        && !/\^we\\b/.test(readSrc),
      (v) => v === true, 'true');
    assert('episodeRead does not rank by salience/sentiment/score or speak occurred_at',
      /ORDER BY[\s\S]{0,40}salience|row\.occurred_at|row\.salience|row\.sentiment|row\.score/.test(readSrc),
      (v) => v === false, 'false');
    assert('episodeRead never mutates',
      /\b(?:INSERT|UPDATE|DELETE)\b/i.test(readSrc), (v) => v === false, 'false');
    assert('graphRead is untouched',
      /episode/i.test(graphSrc), (v) => v === false, 'false');

    assert('admission matches the closed remember-request family',
      detectEpisodeRecall(RECALL)?.kind === 'what_remembered'
        && detectEpisodeRecall('What did you remember?')?.kind === 'what_remembered'
        && detectEpisodeRecall('What have I asked you to remember?')?.kind === 'what_remembered'
        && detectEpisodeRecall('What am I having you remember?')?.kind === 'what_remembered'
        && detectEpisodeRecall('What did I want you to remember?')?.kind === 'what_remembered',
      (v) => v === true, 'true');
    assert('time-filtered episode recall is not silently admitted',
      detectEpisodeRecall('What did I ask you to remember last week?') === null
        && detectEpisodeRecall('What did I ask you to remember in August?') === null,
      (v) => v === true, 'true');

    {
      const { db, say } = await fresh();
      const entitiesBefore = count(db, 'entities');
      const edgesBefore = count(db, 'entity_relationships');
      const evidenceBefore = count(db, 'evidence');
      await say(JOURNEY);
      await say('Yes.');
      const stored = listActiveEpisodes(1)[0];
      const recallIntent = detectEpisodeRecall(RECALL);
      const spoken = answerEpisodeRecall();
      const routed = await classifyQuery(RECALL);
      assert('capture→confirm→persist→recall first journey is provenance-framed',
        stored?.raw_phrase === "we had dinner at Luigi's last Friday"
          && recallIntent?.kind === 'what_remembered'
          && spoken === "You asked me to remember that you had dinner at Luigi's last Friday."
          && routed.reason === 'episode:recall' && routed.tier === 1
          && routed.tier1Response === spoken,
        (v) => v === true, 'true');
      assert('stored raw_phrase is unchanged by recall',
        stored?.raw_phrase === "we had dinner at Luigi's last Friday"
          && realizeEpisodePerspective(stored.raw_phrase) === "you had dinner at Luigi's last Friday",
        (v) => v === true, 'true');
      assert('response does not interpolate occurred_at or assert the event as independent fact',
        !/2026-09-18/.test(spoken) && /you asked me to remember that/i.test(spoken)
          && !/^you had dinner/.test(spoken),
        (v) => v === true, 'true');
      assert('recall writes no entity, relationship, or evidence rows',
        count(db, 'entities') === entitiesBefore
          && count(db, 'entity_relationships') === edgesBefore
          && count(db, 'evidence') === evidenceBefore,
        (v) => v === true, 'true');
    }

    {
      const { db } = await fresh();
      void db;
      assert('zero active episodes is an honest miss',
        answerEpisodeRecall(),
        (v) => v === "You haven't asked me to remember anything yet.",
        'honest miss');
    }

    {
      const { db } = await fresh();
      void db;
      const id = seed("we had dinner at Luigi's last Friday", '2026-09-18', 'day');
      softRemoveEpisode(id);
      assert('soft-removed episode is invisible',
        listActiveEpisodes().length === 0
          && answerEpisodeRecall() === "You haven't asked me to remember anything yet.",
        (v) => v === true, 'true');
    }

    {
      const { db } = await fresh();
      void db;
      seed("we went to Luigi's in August", null, 'month');
      const spoken = answerEpisodeRecall();
      assert('month-precision read-back keeps the user words and invents no day',
        spoken === "You asked me to remember that you went to Luigi's in August."
          && !/\b\d{1,2}(st|nd|rd|th)?\b/.test(spoken.replace(/August/g, '')),
        (v) => v === true, 'true');
    }

    {
      const { db } = await fresh();
      void db;
      seed('we ate first', null, 'unknown');
      setNow(new Date(2026, 8, 21, 12, 0, 1));
      seed('we ate second', null, 'unknown');
      setNow(new Date(2026, 8, 21, 12, 0, 2));
      seed('we ate third', null, 'unknown');
      setNow(new Date(2026, 8, 21, 12, 0, 3));
      seed('we ate fourth', null, 'unknown');
      const listed = listActiveEpisodes(3).map((r) => r.raw_phrase);
      const spoken = answerEpisodeRecall();
      assert('multiple episodes are newest-captured first and capped at 3',
        JSON.stringify(listed) === JSON.stringify(['we ate fourth', 'we ate third', 'we ate second'])
          && /you ate fourth/.test(spoken)
          && /you ate third/.test(spoken)
          && /you ate second/.test(spoken)
          && !/you ate first/.test(spoken)
          && /You've asked me to remember a few things/.test(spoken),
        (v) => v === true, 'true');
      assert('enumeration is not a salience pick',
        listed.every((phrase, i) => listActiveEpisodes()[i]?.salience == null) && !/most important/.test(spoken),
        (v) => v === true, 'true');
    }

    {
      const temporal = await classifyQuery('What did I mention earlier?');
      const episode = await classifyQuery(RECALL);
      assert('existing temporal-recall phrases still route to recall:temporal',
        isTemporalRecallRequest('What did I mention earlier?') === true
          && temporal.reason === 'recall:temporal'
          && detectEpisodeRecall('What did I mention earlier?') === null,
        (v) => v === true, 'true');
      assert('remember-request phrase routes to episode:recall not recall:temporal',
        isTemporalRecallRequest(RECALL) === false
          && episode.reason === 'episode:recall'
          && detectEpisodeRecall(RECALL)?.kind === 'what_remembered',
        (v) => v === true, 'true');
    }

    {
      const notes = await classifyQuery('what are my notes');
      assert('existing note-read remains unchanged and disjoint from episode recall',
        notes.reason === 'action:note_read' && notes.actionIntent?.type === 'note_read'
          && detectEpisodeRecall('what are my notes') === null
          && detectEpisodeRecall(RECALL) !== null,
        (v) => v === true, 'true');
    }

    {
      const filtered = await classifyQuery('What did I ask you to remember last week?');
      assert('time-filtered remember questions are not episode:recall',
        detectEpisodeRecall('What did I ask you to remember last week?') === null
          && filtered.reason !== 'episode:recall',
        (v) => v === true, 'true');
    }
  } finally {
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5EpisodeRecall: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5EpisodeRecall.test.ts')) {
  runRung5EpisodeRecallTests().catch((err) => {
    resetNow();
    console.error(err);
  });
}
