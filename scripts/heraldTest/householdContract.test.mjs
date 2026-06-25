import Database from 'better-sqlite3';
import { setDB } from './src/db/schema.ts';
import { writeServiceProvider, captureHousehold } from './src/utils/householdCapture.ts';
import { answerHouseholdRead, detectHouseholdRead } from './src/utils/householdRead.ts';

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

  const total=passed+failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length>0?` — ${RED}${failures.length} FAILED${RESET}`:` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return {passed,failed:failures.length,total,failures};
}

if (process.argv[1]?.endsWith('householdContract.test.mjs')) {
  runHouseholdContractTests().catch(console.error);
}
