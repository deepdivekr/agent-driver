import {constants,openSync,closeSync,readFileSync,writeSync,fsyncSync,renameSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {soakConfig} from './soak-contract.mjs';
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function check(ok,code){if(!ok)throw Error(code);}
export function readJson(path,max=1048576){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=fstatSync(fd);check(s.isFile()&&s.nlink===1&&s.size<=max&&s.uid===process.getuid(),'SOAK_UNSAFE_FILE');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
export function atomicJson(root,name,value){
 check(/^[a-z-]+\.json$/.test(name),'SOAK_INVALID_FILE');
 const temporary=join(root,'.write-'+randomUUID()),fd=openSync(temporary,'wx',0o600);
 try{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let n=0;while(n<bytes.length)n+=writeSync(fd,bytes,n,bytes.length-n);fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temporary,join(root,name));const dir=openSync(root,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
export function journal(root,value){
 const fd=openSync(join(root,'journal.jsonl'),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{const s=fstatSync(fd);check(s.isFile()&&s.nlink===1&&s.uid===process.getuid(),'SOAK_UNSAFE_JOURNAL');const b=Buffer.from(JSON.stringify(value)+'\n');let n=0;while(n<b.length)n+=writeSync(fd,b,n,b.length-n);fsyncSync(fd);}finally{closeSync(fd);}
}
export function manifestAt(input){
 const root=resolve(input),s=lstatSync(root);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&realpathSync(root)===root,'SOAK_ROOT_UNSAFE');
 const manifest=readJson(join(root,'manifest.json'));
 check(/^[a-f0-9]{32}$/.test(manifest.id)&&manifest.root===root&&manifest.device===s.dev&&manifest.inode===s.ino&&manifest.budget.domain==='soak-'+manifest.id&&hash(manifest.config)===manifest.config_hash,'SOAK_MANIFEST_CHANGED');
 const config=soakConfig.parse(manifest.config);
 check(manifest.schema_version===1&&['cpu_percent','memory_mb','tasks_max'].every(k=>config[k]===manifest.budget[k])&&Object.keys(manifest.budget).sort().join(',')==='cpu_percent,domain,memory_mb,tasks_max','SOAK_MANIFEST_CHANGED');
 return {root,manifest};
}
