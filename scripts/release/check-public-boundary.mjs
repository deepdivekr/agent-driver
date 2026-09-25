import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function checkPublicBoundary(root=resolve(import.meta.dirname,'../..')){
  const paths=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
  const forbidden=/^(?:src\/workflows\/|scripts\/(?:stacksky-|local-)|tests\/runtime-(?:personal-build|workflow)\.test|docs\/local-personal-runtime\.md|\.env(?:\.|$)|\.secrets\/)|\.(?:sqlite(?:-wal|-shm)?|log)$/u;
  const patterns=[
    ['typesafe_key',/apikey_[a-f0-9]{32}_[a-f0-9]{32,}/u],
    ['openai_key',/sk-proj-[A-Za-z0-9_-]{60,}/u],
    ['telegram_token',/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/u],
    ['private_key',/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----$/mu],
  ];
  const findings=[];
  for(const path of paths){
    if(forbidden.test(path))findings.push({path,rule:'private_file'});
    if(!existsSync(resolve(root,path)))continue;
    const bytes=readFileSync(resolve(root,path));if(bytes.includes(0))continue;
    const text=bytes.toString('utf8');
    for(const [rule,pattern] of patterns)if(pattern.test(text))findings.push({path,rule});
  }
  return {status:findings.length?'FAIL':'PASS',files_checked:paths.length,findings,scope:'Tracked and new non-ignored product files; patterns do not guarantee complete secret detection.'};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const result=checkPublicBoundary();console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;}
