import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';

export interface HermesTransport {
  request(method:string,params:unknown,timeoutMs?:number):Promise<any>;
  notify(method:string,params:unknown):void;
  close():Promise<void>;
}
export interface HermesTransportCallbacks {
  update(params:any):void;
  permission(params:any,respond:(result:unknown)=>void):void;
}
/** Official ACP stdio protocol. Never uses oneshot/yolo or auto-approves requests. */
export class HermesAcp implements HermesTransport {
  private child:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private buffer='';private received=0;private ended=false;
  constructor(executable:string,args:string[],cwd:string,callbacks:HermesTransportCallbacks,env?:NodeJS.ProcessEnv){
    this.child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.received+=Buffer.byteLength(chunk);this.buffer+=chunk;
      if(this.received>8*1024*1024||Buffer.byteLength(this.buffer)>1024*1024){this.fail('HERMES_OUTPUT_LIMIT');void this.close();return;}
      let boundary;while((boundary=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,boundary);this.buffer=this.buffer.slice(boundary+1);if(!line.trim())continue;
        try{
          const message=JSON.parse(line);
          if(message.method==='session/update'){callbacks.update(message.params);continue;}
          if(message.method&&message.id!==undefined){
            if(message.method==='session/request_permission')callbacks.permission(message.params,result=>this.send({jsonrpc:'2.0',id:message.id,result}));
            else this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client capability unavailable'}});
            continue;
          }
          const waiting=this.pending.get(message.id);if(!waiting)continue;
          clearTimeout(waiting.timer);this.pending.delete(message.id);
          if(message.error)waiting.reject(Error('HERMES_ACP_REQUEST_FAILED'));else waiting.resolve(message.result);
        }catch{this.fail('HERMES_PROTOCOL_INVALID');void this.close();return;}
      }
    });
    // Provider diagnostics can contain credentials. Drain without persisting raw stderr.
    this.child.stderr.on('data',()=>{});
    this.child.stdin.on('error',()=>this.fail('HERMES_TRANSPORT_CLOSED'));
    this.child.once('error',()=>this.fail('HERMES_NOT_AVAILABLE'));
    this.child.once('exit',()=>this.fail('HERMES_TRANSPORT_CLOSED'));
  }
  private send(value:unknown){if(!this.ended&&!this.child.stdin.destroyed)this.child.stdin.write(JSON.stringify(value)+'\n');}
  private fail(code:string){this.ended=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error(code));}this.pending.clear();}
  request(method:string,params:unknown,timeoutMs=30_000):Promise<any>{
    if(this.ended)return Promise.reject(Error('HERMES_TRANSPORT_CLOSED'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('HERMES_REQUEST_TIMEOUT'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({jsonrpc:'2.0',id,method,params});});
  }
  notify(method:string,params:unknown){this.send({jsonrpc:'2.0',method,params});}
  async close(){
    this.fail('HERMES_TRANSPORT_CLOSED');this.child.stdin.end();
    if(this.child.exitCode!==null||this.child.signalCode!==null)return;
    const child=this.child;
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);resolve();};
      const stop=()=>{if(child.pid&&child.exitCode===null&&child.signalCode===null){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}}};
      const timer=setTimeout(stop,1500);timer.unref();child.once('exit',finish);stop();
      const hard=setTimeout(()=>{if(child.pid&&child.exitCode===null&&child.signalCode===null){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}}finish();},4000);hard.unref();child.once('exit',()=>clearTimeout(hard));
    });
  }
}
