import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sandboxArgs} from '../../dist/terminal/verify-files.js';
import {processIdentitySync} from '../../dist/supervisor/identity.js';
const root=process.argv[2];
const child=spawn('/usr/bin/bwrap',sandboxArgs(root,['--eval',"process.stdout.write('ready');setInterval(()=>{},1000)"],10000),{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
child.stderr.on('data',b=>process.stderr.write(b));
child.stdout.once('data',()=>{
 const identities=[];function scan(pid){const identity=processIdentitySync(pid);if(typeof identity==='string')return;identities.push(identity);for(const p of readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(' ').filter(Boolean))scan(Number(p));}scan(child.pid);
 writeFileSync(join(root,'verifier-ready.json'),JSON.stringify(identities));
});
setTimeout(()=>child.kill('SIGKILL'),15000);
