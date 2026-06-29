import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeServiceProvider } from '../../src/utils/householdCapture.ts';
import { answerHouseholdRead } from '../../src/utils/householdRead.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_providers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL, created_at TEXT, updated_at TEXT, removed_at TEXT);
  CREATE TABLE IF NOT EXISTS insurance_policies (id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS legal_documents (id TEXT PRIMARY KEY, type TEXT, location TEXT, created_at TEXT, updated_at TEXT, removed_at TEXT);
`;
function makeShim(db){return{getAllSync:(s,p=[])=>db.prepare(s).all(...p),getFirstSync:(s,p=[])=>db.prepare(s).get(...p)??null,runSync:(s,p=[])=>db.prepare(s).run(...p),execSync:(s)=>db.exec(s)};}
function freshDB(){const db=new Database(':memory:');db.exec(SCHEMA_SQL);setDB(makeShim(db));return db;}

export async function runDispatchContractTests() {
  const failures=[]; let passed=0;
  function assert(label,got,check,expected){
    if(check(got)){console.log(`${GREEN}✓ PASS${RESET}  ${label}`);passed++;}
    else{console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);failures.push({label,got,expected});}
  }
  console.log(`\n${BOLD}-- Dispatch Contract Tests -------------------------------${RESET}\n`);

  // D1: service provider with phone — name and phone exact match
  freshDB();
  writeServiceProvider('plumber','Dave Hernandez','5551234567');
  const r1 = answerHouseholdRead({ type:'service_provider', categories:['plumber'], spoken:'plumber' });
  assert('D1a name exact match', r1, v=>v.includes('Dave Hernandez'), 'includes Dave Hernandez');
  assert('D1b phone formatted', r1, v=>v.includes('555-123-4567'), 'includes 555-123-4567');
  assert('D1c no fabrication', r1, v=>!v.includes('unknown'), 'no unknown');

  // D2: service provider without phone — name only, no invented phone
  freshDB();
  writeServiceProvider('lawn','Green Cut Lawn Care', null);
  const r2 = answerHouseholdRead({ type:'service_provider', categories:['lawn','landscaper'], spoken:'lawn' });
  assert('D2a name returned', r2, v=>v.includes('Green Cut Lawn Care'), 'includes Green Cut');
  assert('D2b no phone invented', r2, v=>!v.includes('reach them at'), 'no phone line');

  // D3: soft-deleted row not returned
  const db3 = freshDB();
  writeServiceProvider('roofer','Tom Roof Co','5550001111');
  db3.prepare("UPDATE service_providers SET removed_at=datetime('now') WHERE category='roofer' AND removed_at IS NULL").run();
  const r3 = answerHouseholdRead({ type:'service_provider', categories:['roofer'], spoken:'roofer' });
  assert('D3a soft-delete returns gap message', r3, v=>v.startsWith("I don't have"), "gap message");
  assert('D3b deleted name not returned', r3, v=>!v.includes('Tom Roof'), 'no Tom Roof');

  // D4: no row stored — honest gap message contains spoken word
  freshDB();
  const r4 = answerHouseholdRead({ type:'service_provider', categories:['mechanic'], spoken:'mechanic' });
  assert('D4a gap message', r4, v=>v.startsWith("I don't have"), "gap message");
  assert('D4b spoken word in gap', r4, v=>v.includes('mechanic'), 'includes mechanic');

  // D5: synonym expansion — hvac categories all resolve to same row
  freshDB();
  writeServiceProvider('hvac','CoolAir Services','5559876543');
  const r5 = answerHouseholdRead({ type:'service_provider', categories:['hvac','ac','air conditioning'], spoken:'ac' });
  assert('D5a hvac synonym returns name', r5, v=>v.includes('CoolAir Services'), 'includes CoolAir');
  assert('D5b hvac phone formatted', r5, v=>v.includes('555-987-6543'), 'includes 555-987-6543');

  // D6: insurance typed query — carrier and agent returned
  const db6 = freshDB();
  db6.prepare("INSERT INTO insurance_policies (id,type,carrier,agent_name,agent_phone,is_active,created_at,updated_at) VALUES ('ins1','home','State Farm','Janet Moore','5550001111',1,datetime('now'),datetime('now'))").run();
  const r6 = answerHouseholdRead({ type:'insurance', categories:['home','homeowners','homeowner','house'], spoken:'home' });
  assert('D6a carrier returned', r6, v=>v.includes('State Farm'), 'includes State Farm');
  assert('D6b agent name returned', r6, v=>v.includes('Janet Moore'), 'includes Janet Moore');
  assert('D6c spoken type in response', r6, v=>v.includes('home'), 'includes home');

  // D7: insurance typeless query — all active policies listed
  const db7 = freshDB();
  db7.prepare("INSERT INTO insurance_policies (id,type,carrier,agent_name,agent_phone,is_active,created_at,updated_at) VALUES ('ins1','home','State Farm',NULL,NULL,1,datetime('now'),datetime('now'))").run();
  db7.prepare("INSERT INTO insurance_policies (id,type,carrier,agent_name,agent_phone,is_active,created_at,updated_at) VALUES ('ins2','car','Geico',NULL,NULL,1,datetime('now'),datetime('now'))").run();
  const r7 = answerHouseholdRead({ type:'insurance', categories:[], spoken:'insurance' });
  assert('D7a typeless lists State Farm', r7, v=>v.includes('State Farm'), 'includes State Farm');
  assert('D7b typeless lists Geico', r7, v=>v.includes('Geico'), 'includes Geico');

  // D8: insurance no row — honest gap message
  freshDB();
  const r8 = answerHouseholdRead({ type:'insurance', categories:['life'], spoken:'life' });
  assert('D8a insurance gap message', r8, v=>v.includes("don't have"), "gap message");

  // D9: legal document — location returned verbatim
  const db9 = freshDB();
  db9.prepare("INSERT INTO legal_documents (id,type,location,created_at,updated_at) VALUES ('ld1','will','Law Office of Smith',datetime('now'),datetime('now'))").run();
  const r9 = answerHouseholdRead({ type:'legal_document', categories:['will'], spoken:'will' });
  assert('D9a legal location returned', r9, v=>v.includes('Law Office of Smith'), 'includes location');

  // D10: legal document no row — honest gap message
  freshDB();
  const r10 = answerHouseholdRead({ type:'legal_document', categories:['trust'], spoken:'trust' });
  assert('D10a legal gap message', r10, v=>v.includes("don't have"), "gap message");

  // D11: nameless row in DB — gap message, never invents name
  const db11 = freshDB();
  db11.prepare("INSERT INTO service_providers (id,name,phone,category,created_at,updated_at) VALUES ('sp_bad','','5550001111','electrician',datetime('now'),datetime('now'))").run();
  const r11 = answerHouseholdRead({ type:'service_provider', categories:['electrician'], spoken:'electrician' });
  assert('D11a nameless row returns gap', r11, v=>v.startsWith("I don't have"), 'gap message');
  assert('D11b no name invented', r11, v=>!v.toLowerCase().includes('unknown'), 'no unknown');

  const total = passed + failures.length;
  console.log(`\n${BOLD}Dispatch contract: ${passed}/${total} passed${failures.length>0?` — ${RED}${failures.length} FAILED${RESET}`:` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('dispatchContract.test.mjs')) {
  runDispatchContractTests().catch(console.error);
}
