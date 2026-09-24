import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {normalizeCompatibleBaseUrl,type ApiProvider} from '../integrations/model-provider.js';
import {FAST_MODEL_DEFAULTS,selectedFastModel} from '../integrations/fast-models.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable,type SafeProcessRunner} from '../integrations/subscription-auth.js';

export interface ModelOption {id:string;label:string;}
export interface ModelCatalog {source:string;status:'available'|'unavailable';models:ModelOption[];fetched_at:string|null;selected?:string;}
const valid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\s\x00-\x1f]/u.test(value)&&!/^(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})$/u.test(value);
const validKey=(value:unknown):value is string=>typeof value==='string'&&value.length>=16&&value.length<=4_096&&!/[\s\x00-\x1f]/u.test(value);
const catalog=(source:string,models:ModelOption[]):ModelCatalog=>({source,status:models.length?'available':'unavailable',models,fetched_at:models.length?new Date().toISOString():null});
const unavailable=(source:string):ModelCatalog=>catalog(source,[]);

/** The connected Codex installation, not a bundled list, supplies picker-visible models. */
export async function codexModelCatalog(executable?:string,timeoutMs=8_000):Promise<ModelCatalog>{
  let command:string;try{command=executable??resolveSubscriptionClientExecutable('codex');}catch{return unavailable('codex_app_server');}
  return new Promise(resolve=>{
    const child=spawn(command,['app-server','--stdio'],{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const lines=createInterface({input:child.stdout}),models:ModelOption[]=[];let settled=false;
    const finish=(result:ModelCatalog)=>{if(settled)return;settled=true;clearTimeout(timer);lines.close();child.kill();resolve(result);};
    const timer=setTimeout(()=>finish(unavailable('codex_app_server')),timeoutMs);timer.unref();
    child.once('error',()=>finish(unavailable('codex_app_server')));child.once('close',()=>finish(unavailable('codex_app_server')));
    lines.on('line',line=>{if(line.length>300_000)return;let value:{id?:unknown;result?:{data?:unknown;nextCursor?:unknown};error?:unknown};try{value=JSON.parse(line);}catch{return;}
      if(value.id===0){if(value.error){finish(unavailable('codex_app_server'));return;}
        child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
        child.stdin.write(JSON.stringify({method:'model/list',id:1,params:{limit:150,includeHidden:false}})+'\n');
        return;
      }
      if(value.id===1){if(value.error||!Array.isArray(value.result?.data)){finish(unavailable('codex_app_server'));return;}
        for(const item of value.result.data){if(!item||typeof item!=='object')continue;const row=item as {model?:unknown;id?:unknown;displayName?:unknown;hidden?:unknown};const id=row.model??row.id;if(valid(id)&&row.hidden!==true)models.push({id,label:typeof row.displayName==='string'&&row.displayName.length<=120?row.displayName:id});}
        finish(catalog('codex_app_server',models.slice(0,150)));}
    });
    child.stdin.write(JSON.stringify({method:'initialize',id:0,params:{clientInfo:{name:'agent_driver_model_picker',title:'Agent Driver',version:'0.1.0'}}})+'\n');
  });
}

/** Claude's stable aliases follow its current client release; arbitrary IDs remain editable in settings. */
export function claudeModelCatalog():ModelCatalog{return catalog('claude_cli_aliases',[{id:'sonnet',label:'Sonnet (latest)'},{id:'opus',label:'Opus (latest)'},{id:'haiku',label:'Haiku (latest)'}]);}
export async function opencodeModelCatalog(environment:NodeJS.ProcessEnv=process.env,runner:SafeProcessRunner=nativeProcessRunner):Promise<ModelCatalog>{
  let executable:string;try{executable=resolveSubscriptionClientExecutable('opencode',environment);}catch{return unavailable('opencode_cli');}
  try{const result=await runner.run({executable,args:['models'],timeout_ms:8_000});if(result.code!==0)return unavailable('opencode_cli');
    return catalog('opencode_cli',[...new Set(result.stdout.split(/\r?\n/u).map(value=>value.trim()).filter(valid))].slice(0,300).map(id=>({id,label:id})));
  }catch{return unavailable('opencode_cli');}
}

/** Live provider list plus the luna-class selection; without a key the pinned fast default is offered so the picker never keeps another provider's model. */
export async function apiModelCatalog(provider:ApiProvider,key:string,baseUrl:string='',fetcher:typeof fetch=fetch,current=''):Promise<ModelCatalog>{
  const live=await liveApiModelCatalog(provider,key,baseUrl,fetcher),ids=live.models.map(model=>model.id);
  if(live.status==='available')return {...live,selected:selectedFastModel(provider,ids,current)};
  const fallback=FAST_MODEL_DEFAULTS[provider];
  return {...live,models:fallback?[{id:fallback,label:fallback}]:[],selected:fallback||current};
}
async function liveApiModelCatalog(provider:ApiProvider,key:string,baseUrl:string,fetcher:typeof fetch):Promise<ModelCatalog>{
  if(!validKey(key))return unavailable(`${provider}_api`);
  const url=provider==='openai'?'https://api.openai.com/v1/models':provider==='anthropic'?'https://api.anthropic.com/v1/models?limit=1000':provider==='openrouter'?'https://openrouter.ai/api/v1/models':new URL('models',normalizeCompatibleBaseUrl(baseUrl)).href;
  const headers=provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:`Bearer ${key}`};
  try{const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(8_000)});if(!response.ok)return unavailable(`${provider}_api`);
    const raw=await response.text();if(raw.length>3_000_000)return unavailable(`${provider}_api`);
    const body=JSON.parse(raw) as {data?:unknown};if(!Array.isArray(body.data))return unavailable(`${provider}_api`);
    const models=body.data.flatMap(item=>{if(!item||typeof item!=='object')return [];const row=item as {id?:unknown;name?:unknown;display_name?:unknown};if(!valid(row.id))return [];return [{id:row.id,label:typeof (row.name??row.display_name)==='string'?String(row.name??row.display_name).slice(0,120):row.id}];});
    return catalog(`${provider}_api`,models.slice(0,1_000));
  }catch{return unavailable(`${provider}_api`);}
}
