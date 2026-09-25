import {readFileSync,existsSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const ledger=readFileSync('docs/task-ledger.md','utf8');
const prompt=readdirSync('prompts').filter(name=>/^phase-\d+-.*\.md$/u.test(name)).map(name=>readFileSync('prompts/'+name,'utf8')).join('\n');
const status=JSON.parse(readFileSync('docs/status.json','utf8'));
const ids=[...new Set([...prompt.matchAll(/RQ-\d{3}/gu)].map(m=>m[0]))];
assert.ok(ids.length>0,'No phase requirements found');
for(const id of ids){const item=status[id];assert.ok(ledger.includes(id),id+' missing from ledger');assert.ok(item,id+' missing status');assert.ok(['done','partial','blocked_env','not_run'].includes(item.status));if(item.status==='done'){assert.ok(item.evidence?.length);for(const path of item.evidence)assert.ok(existsSync(path),id+' missing evidence '+path)}else assert.ok(item.note?.trim(),id+' requires reason and resume condition')}
console.log(`ledger:verify OK — ${ids.length} RQ recorded`);
