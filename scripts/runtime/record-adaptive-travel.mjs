import {readFile,writeFile} from 'node:fs/promises';
import {basename,resolve,relative,join} from 'node:path';

const root=resolve(process.argv[2]??'');
if(!root.startsWith(resolve('artifacts/demos/adaptive-travel')+'/'))throw Error('ADAPTIVE_RUN_PATH_REQUIRED');
const summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
const report=JSON.parse(await readFile('tests/report.json','utf8'));
const cases=summary.receipts.map((receipt,index)=>{
  const result=receipt.result,dir=join(root,`${receipt.target.source}-${summary.receipts.slice(0,index+1).filter(item=>item.target.source===receipt.target.source).length}`);
  const success=result.status==='succeeded'&&result.verification?.status==='MATCH';
  return {case_id:`adaptive-live-${basename(root)}-${index+1}`,evidence_level:'native_integration',status:success?'PASS':result.status==='NOT_RUN'?'NOT_RUN':'FAIL',environment:`${process.platform} Node ${process.version}; owned Chromium; real public source and providers unless probe=true`,observations:{name:`adaptive ${receipt.target.source}`,probe:receipt.probe,status:result.status,reason:result.reason,elapsed_ms:receipt.elapsed_ms,cache_hit:result.cache_hit??'unobserved',jev_calls:result.jev_calls?.length??0,llm_calls:result.llm_calls?.length??0,verification:result.verification??result.independent_readback??'unobserved',booking_or_payment_authorized:false},evidence_paths:[relative(process.cwd(),join(dir,'source-receipt.json')),relative(process.cwd(),join(dir,'final.png'))]};
});
const ids=new Set(report.cases.map(item=>item.case_id));report.cases.push(...cases.filter(item=>!ids.has(item.case_id)));
// A model-only gate classification is not verified environment-block evidence.
for(const entry of cases){const existing=report.cases.find(item=>item.case_id===entry.case_id);if(existing.status==='BLOCKED_ENV'&&existing.observations.reason==='ADAPTIVE_HUMAN_GATE'){existing.status='FAIL';existing.observations.classification_correction='Previously BLOCKED_ENV; the model classification alone does not establish an actual human gate. Source receipt preserved.';}}
await writeFile('tests/report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({recorded:cases.filter(item=>!ids.has(item.case_id)).length,cases:cases.map(({case_id,status})=>({case_id,status}))}));
