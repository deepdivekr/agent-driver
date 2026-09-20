import {readFileSync,statSync} from 'node:fs';
import {RuntimeApi} from './api.js';
import {loadHostConfig} from './config.js';
import {serveMcp} from './mcp.js';
import {requireCondition} from '../core/contracts.js';
import {serveFixtureLab} from './fixture-lab.js';
export const interfaceHelp=`
Host-configured agent interface (JSON output):
  doctor --config PATH --json
  capabilities list --config PATH --json
  project register --config-file PATH
  task start --config PATH --request-file PATH --json
  task status|cancel TASK_ID --config PATH --json
  task resume TASK_ID --config PATH (not implemented)
  recovery status --config PATH --json
  recovery prepare TASK_ID --config PATH (not implemented)
  events read --config PATH --consumer NAME --json
  events ack --config PATH --consumer NAME --event ID --json
  intake --config PATH --prompt TEXT
  intake --config PATH --request-file PATH
  call --config PATH --tool NAME --request-file PATH
  mcp --config PATH
  fixture serve --data-dir NEW_DIRECTORY (synthetic lab only)
  terminal submit --config PATH --request-file PATH (not implemented)
  verify --suite fixture|windows (not implemented; use npm test)
  soak start --config-file PATH (not implemented)
  ops status --config PATH (not implemented)
No real-site/CLI session or model automation yet. Fixture execution requires explicit host test configuration.
`;
function options(args:string[]){
  const values=new Map<string,string>();const positional:string[]=[];
  for(let i=0;i<args.length;i++){
    const key=args[i]!;
    if(!key.startsWith('--')){positional.push(key);continue;}
    requireCondition(!values.has(key),'DUPLICATE_OPTION');
    if(key==='--json'){values.set(key,'true');continue;}
    const value=args[++i];requireCondition(value&&!value.startsWith('--'),'INVALID_OPTIONS');values.set(key,value);
  }
  return {values,positional};
}
function jsonFile(path:string){requireCondition(statSync(path).size<=65536,'REQUEST_TOO_LARGE');return JSON.parse(readFileSync(path,'utf8')) as unknown;}
export async function runInterfaceCli(args:string[]):Promise<boolean>{
  const command=args[0]!,sub=args[1];
  if(command==='fixture'){
    requireCondition(sub==='serve'&&args.length===4&&args[2]==='--data-dir'&&args[3],'INVALID_OPTIONS');
    await serveFixtureLab(args[3]);return true;
  }
  if(!['doctor','capabilities','project','task','recovery','intake','call','mcp','terminal','verify','soak','ops'].includes(command)&&!(command==='events'&&['read','ack'].includes(sub??'')))return false;
  if(['verify','soak','ops'].includes(command))throw Error('NOT_IMPLEMENTED');
  const grouped=['capabilities','project','task','recovery','events','terminal'].includes(command);
  const parsed=options(args.slice(grouped?2:1)),o=parsed.values;
  const extras=command==='call'?['--request-file','--tool']:command==='intake'?['--request-file','--prompt']:command==='task'&&sub==='start'?['--request-file']:command==='terminal'?['--request-file']:command==='events'?(sub==='ack'?['--consumer','--event']:['--consumer']):command==='project'?['--config-file']:[];
  const allowed=new Set(['--config',...(command==='mcp'?[]:['--json']),...extras]);
  for(const key of o.keys())requireCondition(allowed.has(key),'UNKNOWN_OPTION');
  requireCondition(!(o.has('--config')&&o.has('--config-file')),'AMBIGUOUS_CONFIG');
  const configPath=o.get('--config')??(command==='project'?o.get('--config-file'):undefined);requireCondition(configPath,'CONFIG_REQUIRED');
  const api=new RuntimeApi(loadHostConfig(configPath));
  if(command==='mcp'){requireCondition(parsed.positional.length===0&&[...o.keys()].every(k=>k==='--config'),'INVALID_OPTIONS');await serveMcp(api);return true;}
  try{
    let tool:string,body:unknown={};
    const requestFile=()=>{const path=o.get('--request-file');requireCondition(path,'REQUEST_FILE_REQUIRED');return jsonFile(path);};
    const target=()=>{requireCondition(parsed.positional.length===1,'TASK_ID_REQUIRED');return parsed.positional[0]!;};
    if(command==='project'){requireCondition(sub==='register'&&parsed.positional.length===0,'UNKNOWN_COMMAND');console.log(JSON.stringify({registered:true,project_id:api.config.project.id,environment:api.config.environment}));return true;}
    if(command==='doctor')tool='runtime_health';
    else if(command==='capabilities'){requireCondition(sub==='list','UNKNOWN_COMMAND');tool='runtime_capabilities_list';}
    else if(command==='task'){
      requireCondition(['start','status','cancel','resume'].includes(sub??''),'UNKNOWN_COMMAND');tool=`runtime_task_${sub}`;body=sub==='start'?requestFile():{task_id:target()};
      if(sub==='resume')throw Error('NOT_IMPLEMENTED');
    }else if(command==='recovery'){
      requireCondition(['status','prepare'].includes(sub??''),'UNKNOWN_COMMAND');tool=`runtime_recovery_${sub}`;body=sub==='prepare'?{task_id:target()}:{};
    }else if(command==='events'){
      requireCondition(o.get('--consumer'),'CONSUMER_REQUIRED');tool=`runtime_events_${sub}`;body=sub==='ack'?{consumer_id:o.get('--consumer'),event_id:Number(o.get('--event'))}:{consumer_id:o.get('--consumer')};
    }else if(command==='terminal'){requireCondition(sub==='submit','UNKNOWN_COMMAND');throw Error('NOT_IMPLEMENTED');}
    else if(command==='intake'){tool='runtime_task_intake';requireCondition(!(o.has('--prompt')&&o.has('--request-file')),'AMBIGUOUS_INPUT');body=o.has('--prompt')?{prompt:o.get('--prompt')}:requestFile();}
    else {requireCondition(command==='call'&&o.get('--tool'),'TOOL_REQUIRED');tool=o.get('--tool')!;body=requestFile();}
    if(!((command==='task'&&sub!=='start')||(command==='recovery'&&sub==='prepare')))requireCondition(parsed.positional.length===0,'UNEXPECTED_ARGUMENT');
    console.log(JSON.stringify(await api.call(tool,body)));return true;
  }finally{api.close();}
}
