import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
for(const path of process.argv.slice(2)){
  const root=resolve(path),summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
  console.log(JSON.stringify({root,runs:summary.receipts.map(receipt=>{
    const r=receipt.result,sum=(items,key)=>items.reduce((total,item)=>total+(typeof item[key]==='number'?item[key]:0),0);
    return {source:receipt.target.source,status:r.status,reason:r.reason,elapsed_ms:receipt.elapsed_ms,loop_ms:r.total_ms,design_ms:r.design_ms,cache_hit:r.cache_hit,steps:r.steps?.map(s=>({operation:s.operation,target:s.target_label,decider:s.decider,result:s.result})),jev_calls:r.jev_calls?.length,jev_ms:sum(r.jev_calls??[],'elapsed_ms'),jev_errors:r.jev_calls?.filter(call=>call.status!=='accepted'),llm_calls:r.llm_calls?.length,llm_ms:sum(r.llm_calls??[],'elapsed_ms'),llm_errors:r.llm_calls?.filter(call=>call.status!=='accepted'),verification:r.verification,navigation:receipt.navigation??'unobserved'};
  })},null,2));
}
