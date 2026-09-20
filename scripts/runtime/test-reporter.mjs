import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const id=`runtime-tests-${new Date().toISOString().replace(/[:.]/g,'-')}`;
export default async function* reporter(source){
 const cases=[];
 for await(const event of source)if(['test:pass','test:fail'].includes(event.type)){
  const d=event.data;cases.push({case_id:`${id}-${cases.length+1}`,evidence_level:d.name.includes('C01 CLI')?'fixture_integration':d.name.startsWith('runtime native')?'native_integration':d.name.startsWith('runtime contract')?'contract_fake':'unit',status:event.type==='test:pass'?'PASS':'FAIL',environment:`${process.platform} Node ${process.version}`,observations:{name:d.name,duration_ms:d.details?.duration_ms??'unobserved',error:d.details?.error?String(d.details.error):'unobserved'},evidence_paths:[`tests/evidence/${id}.json`]});yield `${event.type==='test:pass'?'PASS':'FAIL'} ${d.name}\n`;
 }
 mkdirSync('tests/evidence',{recursive:true});writeFileSync(`tests/evidence/${id}.json`,JSON.stringify({id,cases},null,2)+'\n');
 let report;try{report=JSON.parse(readFileSync('tests/report.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;report={schema_version:1,cases:[]};}
 report.cases.push(...cases);writeFileSync('tests/report.json',JSON.stringify(report,null,2)+'\n');yield `${cases.filter(c=>c.status==='PASS').length}/${cases.length} PASS; evidence tests/evidence/${id}.json\n`;
}
