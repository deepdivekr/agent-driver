import {appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {RuntimeStore} from '../../dist/store/runtime-store.js';
import {browserResource} from '../../dist/policy/dispatch-guard.js';
import {FIXTURE_DRAFT} from '../../dist/browser/fixture-driver.js';
const [path,external,cut]=process.argv.slice(2),store=new RuntimeStore(path),p={id:'crash',callerRef:'owner',worktree:'.',profileRef:'owned',accountRef:'a',allowedOrigins:['http://127.0.0.1:9000'],capabilities:[FIXTURE_DRAFT.id]};
store.registerProject(p);const task=store.createTask(p.id,FIXTURE_DRAFT.id),lease=store.acquire(task.id,browserResource(p),'owned-target');
store.begin(lease,FIXTURE_DRAFT.id,'write_external',{value:'synthetic'},FIXTURE_DRAFT.route);
if(cut==='after_effect'){appendFileSync(external,'effect\n');const fd=openSync(external,'r');fsyncSync(fd);closeSync(fd);}
process.send({ready:true,taskId:task.id,cut});setInterval(()=>{},1000);
