import {mock} from 'node:test';
import {loadHostConfig} from '../../dist/interface/config.js';
import {TerminalStore} from '../../dist/terminal/store.js';
const [path,stage,now]=process.argv.slice(2);
if(!['journaled','quarantined','unlinked'].includes(stage))throw Error('invalid owned test cut');
mock.timers.enable({apis:['Date'],now:Number(now)});
const config=loadHostConfig(path),store=new TerminalStore(config.dbPath),retention=store.retention(config);
retention.execute(retention.plan().plan_sha256,point=>{if(point===stage)process.kill(process.pid,'SIGKILL');});
throw Error('cut not reached');
