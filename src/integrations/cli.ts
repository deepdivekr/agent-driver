import {resolve} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {configureHermes,hermesDoctor,hermesHome} from './hermes.js';

export const hermesHelp='  hermes configure [--home PATH]  (preserves Hermes settings; never touches .env)\n  hermes doctor [--home PATH]\n';
function options(args:readonly string[]){const map=new Map<string,string>();for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];requireCondition(key==='--home'&&value&&!map.has(key),'INVALID_HERMES_OPTIONS');map.set(key,value);}return map;}
export async function runHermesCli(args:readonly string[]){
  if(args[0]!=='hermes')return false;requireCondition(['configure','doctor'].includes(args[1]??''),'UNKNOWN_HERMES_COMMAND');const parsed=options(args.slice(2)),home=parsed.get('--home')??hermesHome();
  if(args[1]==='doctor'){console.log(JSON.stringify(hermesDoctor(home)));return true;}
  const script=resolve(process.argv[1]??'');requireCondition(script.length>0,'AGENT_DRIVER_ENTRYPOINT_UNAVAILABLE');console.log(JSON.stringify(await configureHermes({home,command:process.execPath,args:[script,'mcp']})));return true;
}
