import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {appendFile,chmod,mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {ServerResponse} from 'node:http';
import {z} from 'zod';
import {localConnectionPaths} from './connection.js';

const setupArea=z.enum(['setup','mcp','runtime','ai','jev']);
const setupState=z.enum(['info','running','success','warning','error']);
export const setupActivity=z.object({
  id:z.string().uuid(),at:z.string().datetime(),area:setupArea,state:setupState,message:z.string().min(1).max(240),
}).strict();
export type SetupActivity=z.infer<typeof setupActivity>;
export type SetupActivityArea=z.infer<typeof setupArea>;
export type SetupActivityState=z.infer<typeof setupState>;

const secretLike=/(?:sk-[A-Za-z0-9_-]{12,}|apikey_[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|token\s*=)/iu;
function safeMessage(value:string){
  if(/[\r\n\0]/u.test(value)||secretLike.test(value)||value.length>240)throw Error('SETUP_ACTIVITY_UNSAFE');
  return value;
}
function activityPath(root:string){return join(localConnectionPaths(root).root,'setup-activity.jsonl');}
function parseLines(text:string){
  const values:SetupActivity[]=[];
  for(const line of text.split(/\r?\n/u).filter(Boolean))try{values.push(setupActivity.parse(JSON.parse(line)));}catch{/* Corrupt historical lines are not rendered. */}
  return values.slice(-120);
}
export function readSetupActivity(root:string){const path=activityPath(root);return existsSync(path)?parseLines(readFileSync(path,'utf8')):[];}
export async function appendSetupActivity(root:string,area:SetupActivityArea,state:SetupActivityState,message:string,at=new Date()){
  const path=activityPath(root),event=setupActivity.parse({id:randomUUID(),at:at.toISOString(),area,state,message:safeMessage(message)});
  await mkdir(dirname(path),{recursive:true,mode:0o700});await appendFile(path,JSON.stringify(event)+'\n',{encoding:'utf8',mode:0o600});await chmod(path,0o600);
  const history=readSetupActivity(root);
  if(history.length>=120&&readFileSync(path,'utf8').length>96_000){const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,history.map(item=>JSON.stringify(item)).join('\n')+'\n',{mode:0o600});await rename(temporary,path);await chmod(path,0o600);}
  return event;
}

/** Local-only SSE tail. Callers only submit fixed product messages; process output and credentials never enter it. */
export class SetupActivityStream{
  private readonly responses=new Set<ServerResponse>();private readonly heartbeats=new Map<ServerResponse,NodeJS.Timeout>();
  constructor(readonly root:string){}
  async record(area:SetupActivityArea,state:SetupActivityState,message:string){const event=await appendSetupActivity(this.root,area,state,message);this.broadcast(event);return event;}
  attach(response:ServerResponse){
    response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-content-type-options':'nosniff','x-frame-options':'DENY'});
    response.write(`data: ${JSON.stringify({kind:'snapshot',events:readSetupActivity(this.root),credentials_exposed:false})}\n\n`);this.responses.add(response);
    const timer=setInterval(()=>{if(!response.destroyed)response.write(': keepalive\n\n');},15_000);timer.unref();this.heartbeats.set(response,timer);
    const remove=()=>{clearInterval(timer);this.heartbeats.delete(response);this.responses.delete(response);};response.once('close',remove);response.once('error',remove);
  }
  private broadcast(event:SetupActivity){const payload=`data: ${JSON.stringify({kind:'activity',event,credentials_exposed:false})}\n\n`;for(const response of this.responses)if(!response.destroyed)response.write(payload);}
  close(){for(const [response,timer] of this.heartbeats){clearInterval(timer);response.end();}this.heartbeats.clear();this.responses.clear();}
}
