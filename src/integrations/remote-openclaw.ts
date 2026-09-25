import {spawn} from 'node:child_process';
import {z} from 'zod';

// Registered by a human, never accepted as a command from an agent or remote page.
export const remoteTargetSchema=z.object({
  name:z.string().trim().min(1).max(80),
  host:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u),
  user:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/iu),
  port:z.number().int().min(1).max(65535).default(22),
  container:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u).optional(),
  entry:z.string().regex(/^\/[a-zA-Z0-9_./-]+\.(?:mjs|js)$/u).refine(v=>!v.split('/').includes('..')).default('/app/openclaw.mjs'),
}).strict();
export type RemoteTarget=z.infer<typeof remoteTargetSchema>;
export interface RemoteTransport {call(target:RemoteTarget,method:string,params:Record<string,unknown>):Promise<any>}
const key=z.string().min(1).max(240),uuid=z.string().uuid();
const methods:Record<string,z.ZodType>={
  'sessions.list':z.object({limit:z.number().int().min(1).max(50)}).strict(),
  'cron.list':z.object({includeDisabled:z.boolean()}).strict(),
  'cron.runs':z.object({id:key,limit:z.number().int().min(1).max(10)}).strict(),
  'chat.history':z.object({sessionKey:key,limit:z.number().int().min(1).max(20)}).strict(),
  'chat.send':z.object({sessionKey:key,sessionId:key,message:z.string().min(3).max(6000),idempotencyKey:uuid,deliver:z.literal(false)}).strict(),
  'chat.abort':z.object({sessionKey:key,runId:uuid,preserveSideRuns:z.literal(true)}).strict(),
  'agent.wait':z.object({runId:uuid,timeoutMs:z.literal(1)}).strict(),
};
export function validateRemoteCall(method:string,params:Record<string,unknown>){const schema=methods[method];if(!schema)throw Error('REMOTE_METHOD_NOT_ALLOWED');return schema.parse(params)}
const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
// Source and credentials remain remote. Payload travels on stdin, never shell interpolation.
const bridge=`const {spawnSync}=require('node:child_process');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x;if(input.length>16000)process.exit(2)});process.stdin.on('end',()=>{try{const q=JSON.parse(input);const r=spawnSync(process.execPath,[q.entry,'gateway','call',q.method,'--params',JSON.stringify(q.params),'--json','--timeout','12000'],{encoding:'utf8',timeout:18000,maxBuffer:2000000});if(r.status!==0)throw Error();const raw=r.stdout.trim();let value;try{value=JSON.parse(raw)}catch{const at=raw.indexOf('{');value=JSON.parse(raw.slice(at))}process.stdout.write(JSON.stringify({ok:true,value}));}catch{process.stdout.write(JSON.stringify({ok:false,error:'REMOTE_GATEWAY_CALL_FAILED'}));process.exitCode=1}});`;
export function remoteCommand(target:RemoteTarget){const t=remoteTargetSchema.parse(target);return (t.container?`docker exec -i ${quote(t.container)} `:'')+`node -e ${quote(bridge)}`}
export class SshOpenClaw implements RemoteTransport {
  async call(target:RemoteTarget,method:string,params:Record<string,unknown>){
    const t=remoteTargetSchema.parse(target);validateRemoteCall(method,params);
    return new Promise<any>((resolve,reject)=>{
      const args=['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','PermitLocalCommand=no','-o','ClearAllForwardings=yes','-p',String(t.port),`${t.user}@${t.host}`,remoteCommand(t)];
      const child=spawn('ssh',args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let out='',bytes=0,settled=false;const finish=(error?:string,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(Error(error));else resolve(value)};
      const timer=setTimeout(()=>{child.kill();finish('REMOTE_CONNECTION_TIMEOUT')},22000);timer.unref();
      child.stdout.setEncoding('utf8');child.stdout.on('data',(data:string)=>{bytes+=Buffer.byteLength(data);if(bytes>2_000_000){child.kill();finish('REMOTE_OUTPUT_LIMIT')}else out+=data});
      child.stderr.on('data',()=>{}); // Never persist provider or SSH diagnostics containing secrets.
      child.stdin.on('error',()=>finish('REMOTE_CONNECTION_LOST'));
      child.on('error',()=>finish('REMOTE_SSH_UNAVAILABLE'));
      child.on('close',code=>{if(code!==0){finish('REMOTE_CONNECTION_FAILED');return}try{const result=JSON.parse(out);if(result.ok!==true)throw Error();finish(undefined,result.value)}catch{finish('REMOTE_RESPONSE_INVALID')}});
      child.stdin.end(JSON.stringify({entry:t.entry,method,params}));
    });
  }
}
