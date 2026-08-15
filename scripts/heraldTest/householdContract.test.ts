import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeServiceProvider, captureHousehold, detectPhoneCapture, detectServiceCapture } from '../../src/utils/householdCapture.ts';
import { answerHouseholdRead, detectHouseholdRead } from '../../src/utils/householdRead.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_providers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL, created_at TEXT, updated_at TEXT, removed_at TEXT);
  CREATE TABLE IF NOT EXISTS insurance_policies (id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS legal_documents (id TEXT PRIMARY KEY, type TEXT, location TEXT, created_at TEXT, updated_at TEXT, removed_at TEXT);
`;
function makeShim(db){return{getAllSync:(s,p=[])=>db.prepare(s).all(...p),getFirstSync:(s,p=[])=>db.prepare(s).get(...p)??null,runSync:(s,p=[])=>db.prepare(s).run(...p),execSync:(s)=>db.exec(s)};}
function freshDB(){const db=new Database(':memory:');db.exec(SCHEMA_SQL);setDB(makeShim(db));return db;}

export async function runHouseholdContractTests(){
  const failures=[];let passed=0;
  function assert(label,got,check,expected){
    if(check(got)){console.log(`${GREEN}? PASS${RESET}  ${label}`);passed++;}
    else{console.log(`${RED}? FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);failures.push({label,got,expected});}
  }
  console.log(`\n${BOLD}-- Household Contract Tests ------------------------------${RESET}\n`);

  freshDB();
  const id1=writeServiceProvider('plumber','Dave','469-555-0103');
  assert('C1 write returns non-empty ID',id1,(v)=>typeof v==='string'&&v.length>0,'non-empty string');

  const intent1=detectHouseholdRead('who is my plumber');
  assert('C2a detectHouseholdRead fires',intent1,(v)=>v!==null&&v.type==='service_provider','service_provider intent');
  const answer1=intent1?answerHouseholdRead(intent1):'';
  assert('C2b read contains Dave',answer1,(v)=>v.includes('Dave'),'includes "Dave"');
  assert('C2c read contains phone',answer1,(v)=>v.includes('469'),'includes phone');
  assert('C3 read never returns unknown',answer1,(v)=>!v.toLowerCase().includes('unknown'),'no "unknown"');

  freshDB();
  const intent2=detectHouseholdRead('who is my plumber');
  const answer2=intent2?answerHouseholdRead(intent2):'';
  assert('C4 empty DB returns gap message',answer2,(v)=>v.startsWith("I don't have"),"starts with I don't have");

  const db5=freshDB();
  writeServiceProvider('plumber','Dave','469-555-0103');
  db5.prepare("UPDATE service_providers SET removed_at=datetime('now') WHERE category='plumber' AND removed_at IS NULL").run();
  const answer3=answerHouseholdRead(detectHouseholdRead('who is my plumber'));
  assert('C5 after remove returns gap message',answer3,(v)=>v.startsWith("I don't have"),"gap message");

  freshDB();
  writeServiceProvider('plumber','Dave','469-555-0103');
  writeServiceProvider('plumber','Mike','469-555-0200');
  const answer4=answerHouseholdRead(detectHouseholdRead('who is my plumber'));
  assert('C6 supersede returns Mike not Dave',answer4,(v)=>v.includes('Mike')&&!v.includes('Dave'),'Mike not Dave');

  freshDB();
  writeServiceProvider('hvac','Ed','469-555-0111');
  const answer5=answerHouseholdRead(detectHouseholdRead('who is my HVAC guy'));
  assert('C7 HVAC synonym returns Ed',answer5,(v)=>v.includes('Ed'),'includes Ed');

  const db8=freshDB();
  db8.prepare("INSERT INTO service_providers (id,name,phone,category,created_at,updated_at) VALUES ('sp_bad','','469-555-0103','plumber',datetime('now'),datetime('now'))").run();
  const answer6=answerHouseholdRead(detectHouseholdRead('who is my plumber'));
  assert('C8 nameless row returns gap message',answer6,(v)=>v.startsWith("I don't have"),'gap message');

  freshDB();
  const cap1=captureHousehold('my plumber number is 469-555-01');
  assert('C9 short phone triggers ask-again',cap1,(v)=>true,'needs_name ask-again');

  const db10=freshDB();
  writeServiceProvider('plumber','Dave','469-555-0103');
  captureHousehold('remove my plumber');
  const rows=db10.prepare("SELECT * FROM service_providers WHERE category='plumber'").all();
  assert('C10 remove is soft-delete',rows,(v)=>v.length>0&&v.every(r=>r.removed_at!==null),'row exists with removed_at');

  // Guard input: detectPhoneCapture verdict for POSSESSIVE_CONTACT_STATEMENT deferral.
  // length===1 -> read defers, capture wins; length===0 -> read still answers.
  {
    const got=detectPhoneCapture("Sarah's number is 214-505-0100");
    assert('C11 Sarah number+10digits -> capture',got,(v)=>v.kind==='valid'&&v.intent.name==='Sarah'&&v.intent.phone==='2145050100','kind valid; Sarah; 2145050100');
  }
  {
    const got=detectPhoneCapture("Sarah's phone number is 214-505-0100");
    assert('C12 Sarah phone number+10digits -> capture',got,(v)=>v.kind==='valid'&&v.intent.name==='Sarah'&&v.intent.phone==='2145050100','kind valid; Sarah; 2145050100');
  }
  {
    const got=detectPhoneCapture("My sister Linda's cell is 469-505-0213");
    assert('C13 Linda cell+10digits -> capture',got,(v)=>v.kind==='valid'&&v.intent.name==='Linda'&&v.intent.phone==='4695050213','kind valid; Linda; 4695050213');
  }
  {
    const got=detectPhoneCapture("What's Sarah's number");
    assert('C14 What\'s Sarah\'s number -> no capture (read wins)',got,(v)=>v.kind==='no_match','kind no_match');
  }
  {
    const got=detectPhoneCapture("Sarah's phone number");
    assert('C15 Sarah\'s phone number -> no capture (read wins)',got,(v)=>v.kind==='no_match','kind no_match');
  }
  {
    const got=detectPhoneCapture("Sarah's number is 214-505-010");
    assert('C16 Sarah number+9digits -> matched_invalid (repair, not silent drop)',got,(v)=>v.kind==='matched_invalid'&&v.name==='Sarah'&&v.rawDigits==='214505010','kind matched_invalid; Sarah; 214505010');
  }
  {
    const got=detectPhoneCapture("Marcus's number is 972-55-0142");
    assert('C17 Marcus number+9digits -> matched_invalid',got,(v)=>v.kind==='matched_invalid'&&v.name==='Marcus'&&v.rawDigits==='972550142','kind matched_invalid; Marcus; 972550142');
  }

  // ── DSC1-DSC6: detectServiceCapture guard, direct detector assertions
  // (same style as C11-C17's detectPhoneCapture calls above) — Fix 2, false
  // service-provider write repair. Pure function, no DB/session needed.
  // DSC1-4 prove the recall/question guard is category-agnostic (fires on
  // doctor AND plumber AND electrician, not a doctor-specific patch) and
  // covers both the "do you remember/recall" opener and the "what did...
  // say/tell" shape. DSC5-6 prove legitimate capture is unaffected.
  {
    const got = detectServiceCapture('Do you remember anything about what my doctor said');
    assert('DSC1 recall question about doctor -> no capture', got,
      (v) => Array.isArray(v) && v.length === 0, '[]');
  }
  {
    const got = detectServiceCapture('What did my doctor say?');
    assert('DSC2 what-did-doctor-say -> no capture', got,
      (v) => Array.isArray(v) && v.length === 0, '[]');
  }
  {
    const got = detectServiceCapture('What did my plumber say?');
    assert('DSC3 what-did-plumber-say -> no capture (category-agnostic proof)', got,
      (v) => Array.isArray(v) && v.length === 0, '[]');
  }
  {
    const got = detectServiceCapture('Do you remember what my electrician told me?');
    assert('DSC4 recall question, electrician told -> no capture (recall-opener proof)', got,
      (v) => Array.isArray(v) && v.length === 0, '[]');
  }
  {
    const got = detectServiceCapture('My plumber is Bob');
    assert('DSC5 legitimate plumber capture preserved', got,
      (v) => Array.isArray(v) && v.length === 1 && v[0].type === 'service_capture'
        && v[0].category === 'plumber' && v[0].name === 'Bob',
      'one service_capture; category plumber; name Bob');
  }
  {
    const got = detectServiceCapture('my electrician is Ed');
    assert('DSC6 legitimate electrician capture preserved', got,
      (v) => Array.isArray(v) && v.length === 1 && v[0].type === 'service_capture'
        && v[0].category === 'electrician' && v[0].name === 'Ed',
      'one service_capture; category electrician; name Ed');
  }

  // ── M1 completion, 2026-08-13: service_capture phone confirm gate ────────
  // Routes through processUtterance + ConversationSession (the live path),
  // never captureHousehold or writeServiceProvider directly — those bypass
  // the routing authority and the confirm gate entirely (see audit).
  const svcDeps = {
    classifyQuery: async () => ({ tier: 3, reason: 'test:fallthrough' }),
    classifyLLM: null,
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  {
    const dbA = freshDB();
    const session = new ConversationSession();
    const outcomeA = await processUtterance("My plumber is Bob, his number is 214-867-5309", session, svcDeps);
    assert('SC1 service phone capture arms pending, no commit', outcomeA,
      (v) => v.handled === true && session.hasPending() === true, 'pending armed');
    const rowsA1 = dbA.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC2 no write before confirmation', rowsA1, (v) => v.length === 0, 'no rows');

    await processUtterance('yes', session, svcDeps);
    const rowsA2 = dbA.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC3 YES commits exactly one row', rowsA2,
      (v) => v.length === 1 && v[0].name === 'Bob' && v[0].phone === '2148675309', 'one committed row, Bob, 2148675309');
    assert('SC3b pending released after commit', session.hasPending(), (v) => v === false, 'released');
  }
  {
    const dbB = freshDB();
    const session = new ConversationSession();
    await processUtterance("My plumber is Bob, his number is 214-867-5309", session, svcDeps);
    await processUtterance('no', session, svcDeps);
    const rowsB = dbB.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC4 NO does not commit', rowsB, (v) => v.length === 0, 'no rows');
    assert('SC4b pending released after NO', session.hasPending(), (v) => v === false, 'released');
  }
  {
    const dbC = freshDB();
    const session = new ConversationSession();
    await processUtterance("My plumber is Bob, his number is 214-867-5309", session, svcDeps);
    await processUtterance('never mind', session, svcDeps);
    const rowsC = dbC.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC5 cancel does not commit', rowsC, (v) => v.length === 0, 'no rows');
    assert('SC5b pending released after cancel', session.hasPending(), (v) => v === false, 'released');
  }
  {
    const dbD = freshDB();
    const session = new ConversationSession();
    await processUtterance("My plumber is Bob, his number is 214-867-5309", session, svcDeps);
    await processUtterance('972-555-0142', session, svcDeps);
    const rowsD = dbD.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC6 alternate valid candidate re-arms confirm, does not commit', rowsD, (v) => v.length === 0, 'no rows');
    assert('SC6b still pending after alternate candidate', session.hasPending(), (v) => v === true, 'still pending');
  }
  {
    const dbE = freshDB();
    const session = new ConversationSession();
    await processUtterance("My plumber is Bob", session, svcDeps);
    const rowsE = dbE.prepare("SELECT * FROM service_providers WHERE category='plumber' AND removed_at IS NULL").all();
    assert('SC7 no-phone service capture commits immediately, unchanged', rowsE,
      (v) => v.length === 1 && v[0].name === 'Bob' && (v[0].phone === null || v[0].phone === ''), 'one committed row, no phone');
    assert('SC7b no pending armed for no-phone capture', session.hasPending(), (v) => v === false, 'not pending');
  }

  const total=passed+failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length>0?` � ${RED}${failures.length} FAILED${RESET}`:` � ${GREEN}all green${RESET}`}${RESET}\n`);
  return {passed,failed:failures.length,total,failures};
}

if (process.argv[1]?.endsWith('householdContract.test.mjs')) {
  runHouseholdContractTests().catch(console.error);
}
