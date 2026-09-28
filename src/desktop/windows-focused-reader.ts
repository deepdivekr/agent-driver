import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type WindowsCuaConfig} from './cua-contracts.js';
import {type FocusedLocator} from './windows-procedure.js';
import {WINDOWS_FOCUSED_SCRIPT} from './windows-focused-script.js';

export const focusedResultSchema=z.object({
  pid:z.number().int().positive(),window_id:z.number().int().positive(),app_name:z.string(),window_title:z.string(),process_started_ticks:z.string().regex(/^\d+$/u),
  field:z.object({label:z.string(),automation_id:z.string(),class_name:z.string(),role:z.literal('Edit'),runtime_id:z.string().min(1),value:z.string().max(8000).nullable(),enabled:z.boolean(),visible:z.boolean(),
    frame:z.object({x:z.number(),y:z.number(),w:z.number(),h:z.number()})}),
  window_bounds:z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}),
});
export type FocusedResult=z.infer<typeof focusedResultSchema>;
export type ReviewedCuaField=WindowsCuaConfig['fields'][number];
export interface WindowsFocusedReader {
  read(field:ReviewedCuaField,locator?:FocusedLocator):Promise<FocusedResult>;
  close():Promise<void>;
}
/** One lazy read-only child per owning executor, not a resident service. */
export class OwnedWindowsFocusedReader implements WindowsFocusedReader {
  private child:ChildProcessWithoutNullStreams|null=null;
  private stopped=false;
  private opening:Promise<void>|null=null;
  private pending:{id:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void}|null=null;
  readonly timings:Array<{operation:string;elapsed_ms:number;status:'ok'|'failed'}>=[];
  constructor(readonly config:WindowsCuaConfig){}
  get pid(){return this.child?.pid??null;}
  private start(){
    if(this.opening)return this.opening;
    requireCondition(process.platform==='win32'&&!this.stopped,'WINDOWS_FOCUSED_READER_UNAVAILABLE');
    this.opening=new Promise<void>((resolve,reject)=>{
      const started=performance.now(),system=process.env.SystemRoot??'C:\\Windows';
      this.child=spawn(join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_FOCUSED_SCRIPT,'utf16le').toString('base64')],{
        windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:system,WINDIR:system,TEMP:process.env.TEMP??join(system,'Temp'),PATH:join(system,'System32')},
      });
      let buffer='',ready=false;
      const timer=setTimeout(()=>{reject(Error('WINDOWS_FOCUSED_START_TIMEOUT'));void this.close();},10_000);
      this.child.stdout.setEncoding('utf8');this.child.stderr.resume();
      this.child.on('error',()=>{clearTimeout(timer);reject(Error('WINDOWS_FOCUSED_START_FAILED'));void this.close();});
      this.child.on('exit',()=>{this.stopped=true;this.child=null;clearTimeout(timer);reject(Error('WINDOWS_FOCUSED_EXITED'));this.pending?.reject(Error('WINDOWS_FOCUSED_EXITED'));this.pending=null;});
      this.child.stdout.on('data',(chunk:string)=>{
        buffer+=chunk;if(Buffer.byteLength(buffer)>128_000){reject(Error('WINDOWS_FOCUSED_OUTPUT_LIMIT'));void this.close();return;}
        let newline:number;
        while((newline=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue;
          try{const message=JSON.parse(line) as {ready?:boolean;id?:string};
            if(!ready&&message.ready===true){ready=true;clearTimeout(timer);this.timings.push({operation:'start',elapsed_ms:Math.round(performance.now()-started),status:'ok'});resolve();}
            else if(this.pending&&message.id===this.pending.id){const current=this.pending;this.pending=null;current.resolve(message);}
            else {this.pending?.reject(Error('WINDOWS_FOCUSED_PROTOCOL'));void this.close();}
          }catch{this.pending?.reject(Error('WINDOWS_FOCUSED_PROTOCOL'));void this.close();}
        }
      });
    });
    return this.opening;
  }
  async read(field:ReviewedCuaField,locator?:FocusedLocator){
    requireCondition(this.config.fields.some(allowed=>allowed.work_id===field.work_id&&allowed.pid===field.pid&&allowed.window_id===field.window_id&&allowed.label===field.label&&allowed.grant_id===field.grant_id),'WINDOWS_FOCUSED_SCOPE_REQUIRED');
    requireCondition(field.expires_at_ms>Date.now(),'CUA_SCOPE_EXPIRED');
    await this.start();requireCondition(!this.stopped&&this.child&&!this.pending,'WINDOWS_FOCUSED_BUSY_OR_CLOSED');
    const started=performance.now(),id=randomUUID();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const raw=await new Promise<unknown>((resolve,reject)=>{
        this.pending={id,resolve,reject};timer=setTimeout(()=>{reject(Error('WINDOWS_FOCUSED_READ_TIMEOUT'));void this.close();},5000);
        this.child!.stdin.write(JSON.stringify({id,op:'read',pid:field.pid,window_id:field.window_id,app_name:field.app_name,window_title:field.window_title,label:field.label,...(locator?{automation_id:locator.automation_id,class_name:locator.class_name}:{})})+'\n','utf8',error=>{if(error){reject(Error('WINDOWS_FOCUSED_WRITE_FAILED'));void this.close();}});
      });
      const envelope=z.object({ok:z.boolean(),code:z.string().optional()}).parse(raw);
      requireCondition(envelope.ok,'WINDOWS_FOCUSED_'+(envelope.code&&/^[A-Z_]{1,50}$/u.test(envelope.code)?envelope.code:'UNAVAILABLE'));
      const result=focusedResultSchema.parse(raw);
      requireCondition(result.pid===field.pid&&result.window_id===field.window_id&&result.app_name.toLowerCase()===field.app_name.toLowerCase()&&result.window_title===field.window_title&&result.field.label===field.label,'WINDOWS_FOCUSED_IDENTITY_MISMATCH');
      this.timings.push({operation:'read',elapsed_ms:Math.round(performance.now()-started),status:'ok'});return result;
    }catch(error){this.timings.push({operation:'read',elapsed_ms:Math.round(performance.now()-started),status:'failed'});throw error;}
    finally{if(timer)clearTimeout(timer);if(this.timings.length>100)this.timings.splice(0,this.timings.length-100);}
  }
  async close(){
    if(this.stopped&&!this.child)return;this.stopped=true;this.pending?.reject(Error('WINDOWS_FOCUSED_CLOSED'));this.pending=null;
    const child=this.child;if(!child)return;
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill();},500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();if(child.exitCode!==null){clearTimeout(timer);resolve();}});
  }
}
