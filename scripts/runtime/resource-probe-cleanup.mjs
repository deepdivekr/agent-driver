// One-shot cleanup for this phase's two known empty prototype groups only.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const uid=process.getuid();
for(const unit of ['apdphase21probe.slice','apdrt11111111111111111111111111111111.slice']){
  const show=execFileSync('/usr/bin/systemctl',['--user','show',unit,'-p','Description','-p','ControlGroup'],{encoding:'utf8'});
  const fields=Object.fromEntries(show.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const group=`/user.slice/user-${uid}.slice/user@${uid}.service/${unit}`;
  if(fields.Description!=='apd-phase21-owned-probe'||fields.ControlGroup!==group)throw Error('not the owned prototype');
  if(!/^populated 0$/m.test(readFileSync('/sys/fs/cgroup'+group+'/cgroup.events','utf8')))throw Error('prototype not empty');
  execFileSync('/usr/bin/systemctl',['--user','stop',unit]);
  console.log(JSON.stringify({unit,stopped:true,processes_terminated:0}));
}
