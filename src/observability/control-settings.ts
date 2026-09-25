import {randomBytes} from 'node:crypto';
import {type IncomingMessage,type ServerResponse} from 'node:http';
import {dirname,resolve} from 'node:path';
import {type HostConfig,workModelDataApproved} from '../interface/config.js';
import {SubscriptionAuthFlowController} from '../integrations/subscription-auth.js';
import {probeStructuredModel} from '../integrations/model-provider.js';
import {approveNonInterferingConnection,localConnectionPaths,readLocalConnection,setWorkModelDataApproval} from '../onboarding/connection.js';
import {ClientBootstrapController} from '../onboarding/client-bootstrap.js';
import {McpRegistrationController,type McpRegistrationClient} from '../onboarding/mcp-registration.js';
import {effectiveModelEnvironment,modelSettingsFingerprint,modelSettingsPath,previewModelSettings,publicModelSettings,readModelSettings,saveModelSettings,modelScopeBase,scopedModelSettingsPath,type ModelScope,type ModelSettings,type ApiVerification} from '../onboarding/model-settings.js';
import {apiModelCatalog,claudeModelCatalog,codexModelCatalog,opencodeModelCatalog} from '../onboarding/model-catalog.js';
import {SetupActivityStream} from '../onboarding/setup-activity.js';
import {settingsHtml} from './settings-ui.js';

async function readBody(request:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>20_000)throw Error('SETTINGS_INPUT_TOO_LARGE');chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
export class ControlSettings{
  readonly path:string;private busy=false;private providerProbe:{token:string;fingerprint:string;verification:ApiVerification;expires_at:number}|null=null;
  constructor(readonly config:HostConfig,readonly auth:Pick<SubscriptionAuthFlowController,'connections'|'view'|'start'|'close'>=new SubscriptionAuthFlowController(),readonly environment:NodeJS.ProcessEnv=process.env,readonly fetcher:typeof fetch=fetch,readonly mcp=new McpRegistrationController(dirname(config.path),environment),readonly activity=new SetupActivityStream(dirname(config.path)),readonly bootstrap=new ClientBootstrapController(environment,undefined,fetcher)){this.path=modelSettingsPath(config);}
  private connection(){const root=dirname(this.config.path);return resolve(this.config.path)===localConnectionPaths(root).runtimeConfig?{kind:'local' as const,connected:readLocalConnection(root)!==null}: {kind:'host_configured' as const,connected:true};}
  private status(scope:ModelScope='global'){
    const saved=readModelSettings(scopedModelSettingsPath(this.path,scope)),global=publicModelSettings(readModelSettings(this.path),this.environment),base=modelScopeBase(this.path,scope,saved?.selection,this.environment);
    const settings=publicModelSettings(saved,base);
    return {...settings,...(scope==='coding'&&!saved?{selection:global.selection}:{}),...(scope==='coding'?{applies_to:'next_planner_call_stage_or_new_dialog',attached_dialog_models:'pinned'}:{}),scope,inherit_global:scope==='coding'?(!saved||Boolean(saved.inherit_global)):false,computer:this.connection(),runtime_platform:process.platform,site_login_configured:Boolean(this.config.swarm?.visual.owned_vm),work_model_data:{approved:workModelDataApproved(this.config),editable:this.connection().kind==='local'},execution_approval_unchanged:true};
  }
  async handle(request:IncomingMessage,response:ServerResponse,suffix:string,host:string){
    if(suffix!=='settings'&&!suffix.startsWith('settings/'))return false;
    const scope:ModelScope=suffix.startsWith('settings/coding/')?'coding':'global',path=scopedModelSettingsPath(this.path,scope);
    if(scope==='coding'){suffix=suffix.replace('settings/coding/','settings/');if(!['settings/status','settings/models','settings/provider-probe','settings/save'].includes(suffix)){response.writeHead(404);response.end();return true;}}
    const nonce=randomBytes(18).toString('base64url');
    const send=(status:number,body:unknown,html=false)=>{response.writeHead(status,{'content-type':html?'text/html; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':`default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});response.end(html?String(body):JSON.stringify(body));};
    try{
      if(request.method==='GET'){
        if(suffix==='settings')send(200,settingsHtml(nonce),true);
        else if(suffix==='settings/status')send(200,this.status(scope));
        else if(suffix==='settings/mcp')send(200,await this.mcp.view());
        else if(suffix==='settings/bootstrap')send(200,{...this.bootstrap.view(),connections:await this.auth.connections()});
        else if(suffix==='settings/models'){const [codex,opencode]=await Promise.all([codexModelCatalog(),opencodeModelCatalog(this.environment)]);send(200,{codex,claude:claudeModelCatalog(),opencode});}
        else if(suffix==='settings/activity'){this.activity.attach(response);return true;}
        else if(suffix==='settings/flows')send(200,{flows:['codex','claude','opencode','cursor','hermes'].map(id=>this.auth.view(id as 'codex'|'claude'|'opencode'|'cursor'|'hermes'))});
        else send(404,{error:'NOT_FOUND'});return true;
      }
      if(request.method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return true;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-settings'||request.headers['sec-fetch-site']==='cross-site'||request.headers['content-type']?.split(';')[0]!=='application/json'){send(403,{error:'LOCAL_USER_ACTION_REQUIRED'});return true;}
      if(this.busy){send(409,{error:'SETTINGS_ACTION_IN_PROGRESS'});return true;}
      this.busy=true;
      try{
        const body=await readBody(request);
        if(suffix==='settings/models'){
          const value=body&&typeof body==='object'?body as Record<string,unknown>:{};
          if(!['openai','anthropic','openrouter','openai_compatible'].includes(String(value.provider))){send(400,{error:'MODEL_PROVIDER_INVALID'});return true;}
          const saved=readModelSettings(path),provider=value.provider as 'openai'|'anthropic'|'openrouter'|'openai_compatible';
          const inputKey=typeof value.api_key==='string'?value.api_key:null;
          const base=provider==='openai_compatible'&&typeof value.api_base_url==='string'?value.api_base_url:saved?.selection.api_base_url??'';
          const selection={...this.status(scope).selection,api_provider:provider,api_base_url:base} as ModelSettings['selection'],environment=modelScopeBase(this.path,scope,selection,this.environment);
          const same=saved?.selection.api_provider===provider&&(provider!=='openai_compatible'||saved.selection.api_base_url===base);
          const key=inputKey??(same?effectiveModelEnvironment(saved,environment).AGENT_DRIVER_API_KEY:scope==='coding'?environment.AGENT_DRIVER_API_KEY:undefined)??'';
          const current=typeof value.current==='string'&&value.current.length<=200?value.current:'';
          send(200,await apiModelCatalog(provider,key,base,this.fetcher,current));
        }else if(suffix==='settings/provider-probe'){
          await this.activity.record('ai','running','API 공급자 연결을 확인하는 중입니다.');
          const input=body&&typeof body==='object'?{...(body as Record<string,unknown>)}:{};delete input.setup_area;
          if(scope==='global'&&input.inherit_global!==undefined)throw Error('MODEL_SETTINGS_SCOPE_INVALID');
          const environment=modelScopeBase(this.path,scope,input.selection as ModelSettings['selection'],this.environment),proposed=previewModelSettings(path,input,environment);if(proposed.inherit_global||proposed.selection.mode!=='api'){send(400,{error:'MODEL_PROVIDER_PROBE_NOT_APPLICABLE'});return true;}
          const result=await probeStructuredModel(effectiveModelEnvironment(proposed,environment),this.fetcher),fingerprint=modelSettingsFingerprint(proposed,environment),token=randomBytes(24).toString('base64url');
          const verification:ApiVerification={fingerprint,provider:proposed.selection.api_provider,model:proposed.selection.api_model,verified_at:new Date().toISOString()};this.providerProbe={token,fingerprint,verification,expires_at:Date.now()+5*60_000};
          await this.activity.record('ai','success','API 공급자 연결을 확인했습니다.');send(200,{...result,probe_token:token,expires_in_seconds:300});
        }else if(suffix==='settings/save'){
          const value=body&&typeof body==='object'?body as Record<string,unknown>:{};const token=typeof value.api_probe_token==='string'?value.api_probe_token:null;const clean={...value};delete clean.api_probe_token;
          const setupArea=clean.setup_area;delete clean.setup_area;
          if(scope==='global'&&clean.inherit_global!==undefined)throw Error('MODEL_SETTINGS_SCOPE_INVALID');
          const environment=modelScopeBase(this.path,scope,clean.selection as ModelSettings['selection'],this.environment),proposed=previewModelSettings(path,clean,environment);let verified:ApiVerification|undefined;
          if(!proposed.inherit_global&&proposed.selection.mode==='api'){
            const probe=this.providerProbe,fingerprint=modelSettingsFingerprint(proposed,environment),prior=readModelSettings(path);
            if(prior?.api_verification?.fingerprint===fingerprint)verified=prior.api_verification;
            else {if(!probe||token!==probe.token||probe.expires_at<Date.now()||probe.fingerprint!==fingerprint){send(400,{error:'MODEL_PROVIDER_PROBE_REQUIRED'});return true;}verified=probe.verification;}
          }
          const saved=saveModelSettings(path,clean,environment,verified);if(verified)this.providerProbe=null;
          const proposedBody=clean as {selection?:{mode?:unknown;jev?:unknown}};
          if(scope==='coding')await this.activity.record('ai','success',proposed.inherit_global?'코딩 업무가 전역 AI 설정을 사용하도록 저장했습니다.':'코딩 전용 AI 설정을 저장했습니다. 전역 설정보다 우선합니다.');
          else if(setupArea==='jev')await this.activity.record('jev','success',proposedBody.selection?.jev==='on'?'Jev 연결 설정을 저장했습니다.':'Jev 없이 LLM 판단으로 진행하도록 저장했습니다.');
          else await this.activity.record('ai','success',proposedBody.selection?.mode==='api'?'API 모델 설정을 저장했습니다.':'구독 AI 설정을 저장했습니다.');
          send(200,scope==='coding'?this.status(scope):saved);
        }
        else if(suffix==='settings/refresh'){await this.activity.record('ai','running','로그인된 AI 클라이언트를 확인하는 중입니다.');const clients=await this.auth.connections();await this.activity.record('ai','success','AI 클라이언트 상태 확인을 마쳤습니다.');send(200,{clients});}
        else if(suffix==='settings/login'){
          const value=body as {client?:unknown;flow?:unknown};
          if(!value||!['codex','claude','opencode','cursor','hermes'].includes(String(value.client))||!['device','browser'].includes(String(value.flow))){send(400,{error:'INVALID_CLIENT_FLOW'});return true;}
          await this.activity.record('ai','running','공식 AI 로그인 절차를 시작했습니다.');send(202,await this.auth.start(value.client as 'codex'|'claude'|'hermes',value.flow as 'device'|'browser'));
        }else if(suffix==='settings/client/install'){
          const value=body as {client?:unknown};if(!value||!['codex','claude','opencode','cursor','hermes'].includes(String(value.client))){send(400,{error:'CLIENT_INSTALL_TARGET_INVALID'});return true;}
          const client=value.client as McpRegistrationClient,name=({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor CLI',hermes:'Hermes'} as const)[client];
          const started=Date.now();
          const result=await this.bootstrap.install(client,async(stage,observation)=>{
            const message=stage==='downloading'?`${name} 공식 설치 프로그램 다운로드 시작`
              :stage==='downloaded'?`${name} 설치 파일 검증 완료 · ${observation?.byte_count??'미관측'}바이트`
              :stage==='running'?`${name} 설치 프로그램 실행 시작`
              :stage==='installer_exited'?`${name} 설치 프로그램 종료 코드 ${observation?.exit_code??'미관측'} · ${observation?.elapsed_ms===undefined?'시간 미관측':((observation.elapsed_ms)/1000).toFixed(1)+'초'}`
              :`${name} 실행 파일 탐지 중`;
            await this.activity.record('setup',stage==='installer_exited'&&observation?.exit_code!==0?'error':stage==='downloaded'||stage==='installer_exited'?'success':'running',message);
          });
          await this.activity.record('setup','success',`${name} 설치 확인 완료 · ${((Date.now()-started)/1000).toFixed(1)}초`);send(200,result);
        }else if(suffix==='settings/mcp/register'){
          const value=body as {client?:unknown};if(!value||!['codex','claude','opencode','cursor','hermes'].includes(String(value.client))){send(400,{error:'MCP_CLIENT_INVALID'});return true;}
          const name=({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'} as const)[value.client as McpRegistrationClient];
          await this.activity.record('mcp','running',`${name}에 agent-driver mcp 등록 요청`);
          const started=Date.now(),result=await this.mcp.register(value.client as McpRegistrationClient);await this.activity.record('mcp','success',`${name} MCP 등록 완료 · ${((Date.now()-started)/1000).toFixed(1)}초`);send(200,result);
        }else if(suffix==='settings/work-data'){
          const approved=body&&typeof body==='object'?(body as {approved?:unknown}).approved:undefined;
          if(this.connection().kind!=='local'||typeof approved!=='boolean'){send(400,{error:'WORK_DATA_APPROVAL_INVALID'});return true;}
          await setWorkModelDataApproval(this.config.path,approved);await this.activity.record('ai','success',approved?'업무 내용을 선택한 AI로 보내 정의하도록 허용했습니다.':'업무 내용의 AI 전송 허용을 해제했습니다.');send(200,this.status());
        }else if(suffix==='settings/computer'){
          if(this.connection().kind!=='local'||!body||typeof body!=='object'||(body as {mode?:unknown}).mode!=='non_interfering'){send(400,{error:'INVALID_COMPUTER_CONNECTION'});return true;}
          await this.activity.record('runtime','running','전용 작업 폴더와 로컬 실행 권한을 준비하는 중입니다.');await approveNonInterferingConnection(dirname(this.config.path));await this.activity.record('runtime','success','로컬 실행 연결을 승인했습니다.');send(200,this.status());
        }else send(404,{error:'NOT_FOUND'});
      }finally{this.busy=false;}
    }catch(error){const message=error instanceof Error&&/^(?:MODEL_SETTINGS|MODEL_KEY|MODEL_PROVIDER|JEV_CREDENTIAL|SETTINGS_INPUT|MCP_CLIENT|MCP_REGISTRATION|CURSOR_MCP_CONFIG|CLIENT_INSTALL)_[A-Z_]+$/u.test(error.message)?error.message:'SETTINGS_REQUEST_INVALID';if(suffix==='settings/mcp/register')await this.activity.record('mcp','error','MCP 등록을 마치지 못했습니다. 클라이언트 상태를 확인해 주세요.');if(suffix==='settings/client/install')await this.activity.record('setup','error','클라이언트 설치를 마치지 못했습니다. 공식 안내를 확인해 주세요.');send(message.includes('CONFLICT')||message.includes('BUSY')?409:message.includes('TOO_LARGE')?413:400,{error:message});}
    return true;
  }
  close(){this.auth.close();this.activity.close();}
}
