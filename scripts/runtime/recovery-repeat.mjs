// Sequential, finite independent Node/Chromium runs; stop on the first failure.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const count=Number(process.argv[2]??20);
if(!Number.isInteger(count)||count<1||count>100)throw Error('Expected 1..100 repetitions');
const id='recovery-repeat-'+new Date().toISOString().replace(/[:.]/g,'-'),runs=[],started=performance.now();
mkdirSync('tests/evidence',{recursive:true});
for(let i=0;i<count;i++){
  const child=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-name-pattern=prepare_only requires the exact','--test-reporter=./scripts/runtime/test-reporter.mjs','tests/runtime-supervisor.test.mjs'],{encoding:'utf8',maxBuffer:1024*1024});
  process.stdout.write(child.stdout??'');
  const path=/evidence (tests\/evidence\/runtime-tests-[^\s]+\.json)/.exec(child.stdout??'')?.[1];
  const bytes=path?readFileSync(path):null,evidence=bytes?JSON.parse(bytes):null;
  const observation=evidence?.recovery_observations?.[0];
  const pass=child.status===0&&evidence?.cases.length===2&&evidence.cases.every(c=>c.status==='PASS')&&evidence.recovery_observations.length===1&&observation.status==='succeeded'&&observation.effect_count===1&&observation.attempts===2;
  runs.push({iteration:i+1,status:pass?'PASS':'FAIL',exit_code:child.status??'unobserved',evidence:path??'unobserved',sha256:bytes?createHash('sha256').update(bytes).digest('hex'):'unobserved',duration_ms:evidence?.cases[0]?.observations.duration_ms??'unobserved',observation:observation??'unobserved'});
  writeFileSync('tests/evidence/'+id+'.json',JSON.stringify({id,requested:count,completed:runs.length,elapsed_ms:performance.now()-started,model_calls:0,runs,causal_attribution_of_issue22:'unresolved'},null,2)+'\n');
  if(!pass){process.exitCode=1;break;}
}
console.log(JSON.stringify({id,requested:count,completed:runs.length,pass:runs.filter(r=>r.status==='PASS').length}));
