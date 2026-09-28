import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {evidenceInputs,changedInputs} from './evidence-inputs.mjs';
import {testOutcome} from './test-outcome.mjs';
const id=`runtime-tests-${new Date().toISOString().replace(/[:.]/g,'-')}`;
export default async function* reporter(source){
 const cases=[],recovery_observations=[],inputs=evidenceInputs();
 for await(const event of source){
 if(event.type==='test:diagnostic'&&event.data.message.startsWith('recovery-observation:')){
   recovery_observations.push(JSON.parse(event.data.message.slice('recovery-observation:'.length)));
 }
 if(['test:pass','test:fail'].includes(event.type)){
  const d=event.data,outcome=testOutcome(event);cases.push({case_id:`${id}-${cases.length+1}`,evidence_level:d.name.includes('C01 CLI')||d.name.startsWith('runtime fixture')?'fixture_integration':d.name.startsWith('runtime native')?'native_integration':d.name.startsWith('runtime contract')?'contract_fake':'unit',status:outcome.status,environment:`${process.platform} Node ${process.version}`,observations:{name:d.name,duration_ms:d.details?.duration_ms??'unobserved',error:d.details?.error?String(d.details.error):'unobserved',...(outcome.reason?{reason:outcome.reason}:{})},evidence_paths:[`tests/evidence/${id}.json`]});yield `${outcome.status} ${d.name}\n`;
 }}
 const changed=changedInputs(inputs,evidenceInputs());
 cases.push({case_id:`${id}-input-integrity`,evidence_level:'native_integration',status:changed.length?'FAIL':'PASS',environment:`${process.platform} Node ${process.version}`,observations:{name:'test input fingerprint stability',changed_paths:changed},evidence_paths:[`tests/evidence/${id}.json`]});
 if(changed.length)process.exitCode=1;
 mkdirSync('tests/evidence',{recursive:true});writeFileSync(`tests/evidence/${id}.json`,JSON.stringify({id,inputs,cases,recovery_observations},null,2)+'\n');
 let report;try{report=JSON.parse(readFileSync('tests/report.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;report={schema_version:1,cases:[]};}
 report.cases.push(...cases);writeFileSync('tests/report.json',JSON.stringify(report,null,2)+'\n');yield `${cases.filter(c=>c.status==='PASS').length}/${cases.length} PASS; ${cases.filter(c=>c.status==='BLOCKED_ENV').length} BLOCKED_ENV; ${cases.filter(c=>c.status==='NOT_RUN').length} NOT_RUN; evidence tests/evidence/${id}.json\n`;
}
