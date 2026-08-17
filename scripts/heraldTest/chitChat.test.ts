// scripts/heraldTest/chitChat.test.ts
// Chit-chat contract — 2026-08-05 hybrid session.
// Locks the four narrow deterministic conversational categories added to
// classifyQuery immediately before "Default: Tier 3" (tierRouter.ts). Each
// category is anchored (^...$, optional trailing punctuation) and fixed —
// no rotation, no LLM phrasing, no new RouteDecision kind. "What's up" is
// deliberately NOT a category — it's routed through the existing greeting
// mechanism (isGreeting) per session directive.
//
// Runner: npx tsx scripts/heraldTest/chitChat.test.ts
// Gate:   wired from run.mjs — must be green before this closes.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Same minimal replica greeting.test.ts uses — classifyQuery's greeting
// branch (which our WHATS_UP addition runs through) reads ai_name
// unconditionally via getProfileField on every message.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

const IDENTITY_RESPONSE = "I'm Kit, your personal memory companion. I help you remember what matters and find it when you need it.";
const SOCIAL_RESPONSE = "I'm here and ready. How are you doing?";
const AVAILABILITY_RESPONSE = "That's okay. We can just talk.";
const CAPABILITY_RESPONSE = "You can just talk to me. I can remember useful things you tell me about your family, doctors, and medications, help with lists, and call or text people for you. If you're not sure where to start, just tell me what's going on.";

export async function runChitChatTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }

  console.log(`\n${BOLD}-- Chit-Chat Contract Tests ---------------------------------${RESET}\n`);

  // ── Category 1: social check-in ──
  const SOCIAL_PHRASES = ['How are you?', "How's it going?", 'How are you doing?', 'How you doing?'];
  for (const [i, phrase] of SOCIAL_PHRASES.entries()) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`CC-social-${i + 1} "${phrase}" → chit_chat:social_checkin`, d.reason,
      (v) => v === 'chit_chat:social_checkin', 'chit_chat:social_checkin');
    assert(`CC-social-${i + 1} "${phrase}" → exact response`, d.tier1Response,
      (v) => v === SOCIAL_RESPONSE, SOCIAL_RESPONSE);
  }

  // ── Category 2: conversational availability ──
  const AVAILABILITY_PHRASES = [
    'I just wanted to chat.',
    'I just wanted to talk.',
    "I'm just talking.",
    'I was just talking to you.',
    "I thought I'd have a conversation with you.",
  ];
  for (const [i, phrase] of AVAILABILITY_PHRASES.entries()) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`CC-avail-${i + 1} "${phrase}" → chit_chat:availability`, d.reason,
      (v) => v === 'chit_chat:availability', 'chit_chat:availability');
    assert(`CC-avail-${i + 1} "${phrase}" → exact response`, d.tier1Response,
      (v) => v === AVAILABILITY_RESPONSE, AVAILABILITY_RESPONSE);
  }

  // ── Category 3: Kit identity ──
  const IDENTITY_PHRASES = [
    'Who are you?',
    'What are you?',
    'Tell me about yourself.',
    'What do you know about yourself?',
    'What is your purpose?',
  ];
  for (const [i, phrase] of IDENTITY_PHRASES.entries()) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`CC-identity-${i + 1} "${phrase}" → chit_chat:identity`, d.reason,
      (v) => v === 'chit_chat:identity', 'chit_chat:identity');
    assert(`CC-identity-${i + 1} "${phrase}" → exact response`, d.tier1Response,
      (v) => v === IDENTITY_RESPONSE, IDENTITY_RESPONSE);
  }

  // ── Category 4: casual greeting ("what's up") routes through isGreeting,
  // NOT a chit_chat reason — a fourth response authority was deliberately
  // not created ──
  for (const phrase of ["What's up?", 'What is up?']) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`CC-whatsup "${phrase}" → reason is greeting (not a new authority)`, d.reason,
      (v) => v === 'greeting', 'greeting');
    assert(`CC-whatsup "${phrase}" → tier 1`, d.tier,
      (v) => v === 1, '1');
  }

  // ── Category 5: capability discovery (Sub-arc 7a, 2026-08-17) ──
  const CAPABILITY_PHRASES = [
    'What can you do?',
    'What can I ask you?',
    'Can you help me?',
    'Can you help me with my phone?',
    "I don't know what to ask.",
    "I don't know what to do.",
    "I don't know what to do with this.",
  ];
  for (const [i, phrase] of CAPABILITY_PHRASES.entries()) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`CC-capability-${i + 1} "${phrase}" → chit_chat:capability`, d.reason,
      (v) => v === 'chit_chat:capability', 'chit_chat:capability');
    assert(`CC-capability-${i + 1} "${phrase}" → exact response`, d.tier1Response,
      (v) => v === CAPABILITY_RESPONSE, CAPABILITY_RESPONSE);
  }

  // ── Negative / collision guards — the exact traps named in the session
  // spec. Each must NOT match the identity or social_checkin category. ──
  {
    freshDB();
    const d = await classifyQuery('What are you doing?');
    assert('CC-neg-1 "What are you doing?" does NOT match identity', d.reason,
      (v) => v !== 'chit_chat:identity', 'not chit_chat:identity');
  }
  {
    freshDB();
    const d = await classifyQuery('What are you searching for?');
    assert('CC-neg-2 "What are you searching for?" does NOT match identity', d.reason,
      (v) => v !== 'chit_chat:identity', 'not chit_chat:identity');
  }
  {
    freshDB();
    const d = await classifyQuery('What are you able to remember?');
    assert('CC-neg-3 "What are you able to remember?" does NOT match identity', d.reason,
      (v) => v !== 'chit_chat:identity', 'not chit_chat:identity');
  }
  {
    freshDB();
    const d = await classifyQuery('How are you getting the weather?');
    assert('CC-neg-4 "How are you getting the weather?" hits the TIER3 weather signal first, not social_checkin', d.reason,
      (v) => v === 'live:data', 'live:data');
  }

  {
    freshDB();
    const d = await classifyQuery('Can you help me call my daughter?');
    assert('CC-neg-5 "Can you help me call my daughter?" routes to call action, not capability', d.actionIntent?.type,
      (v) => v === 'call', 'call');
  }
  {
    freshDB();
    const d = await classifyQuery('Can you help me text my son?');
    assert('CC-neg-6 "Can you help me text my son?" routes to sms action, not capability', d.actionIntent?.type,
      (v) => v === 'sms', 'sms');
  }
  {
    freshDB();
    const d = await classifyQuery('Can you help me set an alarm?');
    assert('CC-neg-7 "Can you help me set an alarm?" does NOT become capability chit-chat', d.reason,
      (v) => v !== 'chit_chat:capability', 'not chit_chat:capability');
  }

  // ── Retained-route spot checks (existing categories, adjacent to the new
  // code — the full 943+ test gate covers these exhaustively; these are a
  // fast local guard specifically against the new chit-chat block stealing
  // a signal it shouldn't) ──
  {
    freshDB();
    const d = await classifyQuery("what's the weather today");
    assert('CC-retain-weather still routes live:data', d.reason, (v) => v === 'live:data', 'live:data');
  }
  {
    freshDB();
    const d = await classifyQuery('what is the latest news');
    assert('CC-retain-news still routes tier 3', d.tier, (v) => v === 3, '3');
  }
  {
    freshDB();
    const d = await classifyQuery('what is the price of bitcoin');
    assert('CC-retain-stocks still routes tier 3', d.tier, (v) => v === 3, '3');
  }
  {
    freshDB();
    const d = await classifyQuery('what medications am i on');
    assert('CC-retain-medical still routes medical:summary', d.reason, (v) => v === 'medical:summary', 'medical:summary');
  }
  {
    freshDB();
    const d = await classifyQuery("what's my name");
    assert('CC-retain-profile still routes profile:lookup', d.reason, (v) => v === 'profile:lookup', 'profile:lookup');
  }
  {
    freshDB();
    const d = await classifyQuery('call hunter');
    assert('CC-retain-call still routes device action', d.actionIntent?.type, (v) => v === 'call', 'call');
  }
  {
    freshDB();
    const d = await classifyQuery('set a timer for 20 minutes');
    assert('CC-retain-timer still routes device action', d.actionIntent?.type, (v) => v === 'timer', 'timer');
  }
  {
    freshDB();
    const d = await classifyQuery('open youtube');
    assert('CC-retain-appopen still routes device action', d.actionIntent?.type, (v) => v === 'app_open', 'app_open');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Chit-Chat: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('chitChat.test.ts')) {
  runChitChatTests().catch(console.error);
}
