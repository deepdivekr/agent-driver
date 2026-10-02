import {randomBytes} from 'node:crypto';
import {type IncomingMessage,type ServerResponse} from 'node:http';
import {dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {type HostConfig,workModelDataApproved} from '../interface/config.js';
import {SubscriptionAuthFlowController,type SubscriptionClientConnection} from '../integrations/subscription-auth.js';
import {probeStructuredModel} from '../integrations/model-provider.js';
import {approveNonInterferingConnection,localConnectionPaths,readLocalConnection,setWorkModelDataApproval} from '../onboarding/connection.js';
import {ClientBootstrapController} from '../onboarding/client-bootstrap.js';
import {ClientMaintenanceController} from '../onboarding/client-maintenance.js';
import {McpRegistrationController,type McpRegistrationClient} from '../onboarding/mcp-registration.js';
import {effectiveModelEnvironment,modelSettingsFingerprint,modelSettingsPath,previewModelSettings,publicModelSettings,readModelSettings,saveModelSettings,modelScopeBase,scopedModelSettingsPath,type ModelScope,type ModelSettings,type ApiVerification} from '../onboarding/model-settings.js';
import {apiModelCatalog,claudeModelCatalog,codexModelCatalog,opencodeModelCatalog} from '../onboarding/model-catalog.js';
import {SetupActivityStream} from '../onboarding/setup-activity.js';
import {settingsHtml} from './settings-ui.js';
import {BrowserSetupController} from '../onboarding/browser-setup.js';
import {workAutonomy} from '../interface/config.js';
import {clientEnvironment,clientEnvironmentSummary,type ClientEnvironment} from '../integrations/client-environment.js';

async function readBody(request:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>20_000)throw Error('SETTINGS_INPUT_TOO_LARGE');chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
/** Only a real service process asks the apps ahead of time; a test or a library use never starts them unasked. */
let connectionWarmup=false;
export function enableConnectionWarmup(){connectionWarmup=true;}
export class ControlSettings{
  readonly path:string;private busy=false;private providerProbe:{token:string;fingerprint:string;verification:ApiVerification;expires_at:number}|null=null;
  readonly maintenance:Pick<ClientMaintenanceController,'view'|'save'|'runDue'|'runNow'|'close'>;
  maintenanceBusy:()=>boolean=()=>false;
  private maintenanceOperation=false;private maintenanceOwnRequest=false;
  constructor(readonly config:HostConfig,readonly auth:Pick<SubscriptionAuthFlowController,'connections'|'view'|'start'|'close'>=new SubscriptionAuthFlowController(),readonly environment:NodeJS.ProcessEnv=process.env,readonly fetcher:typeof fetch=fetch,readonly mcp=new McpRegistrationController(dirname(config.path),environment),readonly activity=new SetupActivityStream(dirname(config.path)),readonly bootstrap=new ClientBootstrapController(environment,undefined,fetcher),readonly browsers=new BrowserSetupController(config,{environment}),maintenance?:Pick<ClientMaintenanceController,'view'|'save'|'runDue'|'runNow'|'close'>){
    this.path=modelSettingsPath(config);
    this.maintenance=maintenance??new ClientMaintenanceController({statePath:join(dirname(this.path),'cli-maintenance.json'),environment,fixture:config.environment==='fixture',isBusy:()=>this.maintenanceBusy()||this.busy&&!this.maintenanceOwnRequest||this.authenticationBusy()});
  }
  private authenticationBusy(){return (['codex','claude','opencode','cursor','hermes'] as const).some(id=>['starting','waiting'].includes(this.auth.view(id).state));}
  get maintenanceRunning(){return this.maintenanceOperation;}
  get maintenanceHumanAction(){return this.maintenanceOwnRequest;}
  get reloadBlockedReason(){if(this.maintenanceRunning)return 'CLI_UPDATE_IN_PROGRESS';if(this.busy)return 'SETTINGS_ACTION_IN_PROGRESS';return this.authenticationBusy()?'AUTHENTICATION_IN_PROGRESS':null;}
  async tickMaintenance(trigger:'startup'|'tick'='tick'){
    // Merely starting a host or viewing settings cannot authorize package writes.
    // The UI persists this preference when the user saves their connection settings.
    if(this.config.environment==='fixture'||!existsSync(join(dirname(this.path),'cli-maintenance.json'))||this.connection().kind==='local'&&!this.connection().connected||this.maintenanceRunning)return;
    let view:ReturnType<ClientMaintenanceController['view']>;
    try{view=this.maintenance.view();}catch{await this.activity.record('setup','warning','CLI 업데이트 상태를 확인하지 못했습니다. 설정을 확인해 주세요.').catch(()=>{});throw Error('CLIENT_MAINTENANCE_STATE_INVALID');}
    if(!view.enabled||view.next_due_at&&Date.parse(view.next_due_at)>Date.now())return;
    await this.performMaintenance(false,trigger);
  }
  private async performMaintenance(forced:boolean,trigger:'startup'|'tick'='tick'){
    if(this.maintenanceOperation)throw Error('CLIENT_MAINTENANCE_BUSY');
    this.maintenanceOperation=true;
    try{
      await this.activity.record('setup','running','CLI 업데이트를 확인하는 중입니다.');
      const result=await (forced?this.maintenance.runNow():this.maintenance.runDue(trigger));
      for(const id of result.updated_ids){const name={codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'}[id];await this.activity.record('setup','success',`${name}: CLI 업데이트 확인 완료`);}
      const failed=result.skipped.some(item=>item.reason==='update_failed');
      await this.activity.record('setup',result.state==='deferred_busy'||failed?'warning':'success',result.state==='deferred_busy'?'진행 중인 업무나 CLI가 있어 업데이트를 미뤘습니다.':failed?'일부 CLI 업데이트를 완료하지 못했습니다. 나중에 다시 확인합니다.':result.attempted_ids.length?'CLI 업데이트 확인을 마쳤습니다. 모델 목록을 새로고침하세요.':'자동으로 업데이트할 수 있는 설치된 CLI가 없습니다.');
      return result;
    }catch{await this.activity.record('setup','warning','CLI 업데이트 확인에 실패했습니다. 다시 시도해 주세요.').catch(()=>{});throw Error('CLIENT_MAINTENANCE_CHECK_FAILED');}
    finally{this.maintenanceOperation=false;}
  }
  private connection(){const root=dirname(this.config.path);return resolve(this.config.path)===localConnectionPaths(root).runtimeConfig?{kind:'local' as const,connected:readLocalConnection(root)!==null}: {kind:'host_configured' as const,connected:true};}
  private async recordClientChecks(clients:SubscriptionClientConnection[],registrations?:Awaited<ReturnType<McpRegistrationController['view']>>['clients']){
    const names={codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'};
    for(const client of clients){
      const registration=registrations?.find(row=>row.id===client.id),missing=registration?.installed===false||client.reason==='wsl_native_client_not_found'||client.reason==='client_not_available';
      const result=missing?'설치 필요':client.status==='signed_out'?'로그인 필요':client.status==='expired'?'다시 로그인 필요':client.status==='ready'?'로그인 확인됨':client.status==='unavailable'?'사용할 수 없음':'확인되지 않음';
      const registered=registration?.registration,detail=registration&&!missing?' · '+(registered==='registered'?'MCP 등록됨':registered==='not_registered'?'MCP 등록 필요':registered==='conflict'?'설정 검토 필요':'MCP 등록 미확인'):'';
      await this.activity.record(registrations?'mcp':'ai',client.status==='ready'&&!missing&&(!registration||registered==='registered')?'success':'warning',names[client.id]+': '+result+detail);
    }
  }
  /** A connected app is not a fresh installation: the owner already has skills, MCP servers and plugins set up in
   * it. The check reads where they are and what they are called (never their values) and shows them, and it looks
   * for the Aside the owner already installed instead of waiting for a click on another screen (live: a new
   * installation asked the owner to set everything up again and did not find the installed Aside). */
  /** Asking an AI app about itself starts its command-line program and takes seconds (live: 4 to 7 s each for the
   * sign-in check, the model list and the install check, so the settings page stayed locked for 6 to 18 s on every
   * visit). The last answer is kept for a short time and shown at once; an explicit check, a sign-in, an install or
   * a save asks again. */
  private readonly remembered=new Map<string,{at:number;value:Promise<unknown>}>();
  private recall<T>(key:string,maxAgeMs:number,load:()=>Promise<T>,fresh=false):Promise<T>{
    const known=this.remembered.get(key);
    if(!fresh&&known&&Date.now()-known.at<maxAgeMs)return known.value as Promise<T>;
    const value=load();this.remembered.set(key,{at:Date.now(),value});
    value.catch(()=>{if(this.remembered.get(key)?.value===value)this.remembered.delete(key);});
    return value;
  }
  private connections(fresh=false){return this.recall('connections',120_000,()=>this.auth.connections(),fresh);}
  private async existingEnvironment(clients:SubscriptionClientConnection[],fresh=true){
    const names={codex:'Codex',claude:'Claude Code'} as const,found=new Map<string,ClientEnvironment>();
    for(const client of clients)if((client.id==='codex'||client.id==='claude')&&client.status==='ready'){
      const environment=clientEnvironment(client.id,this.environment);if(!environment.found)continue;
      found.set(client.id,environment);if(fresh)await this.activity.record('ai','info',names[client.id]+': '+clientEnvironmentSummary(environment));
    }
    if(!fresh)return found;
    try{
      // Probing and registering the owner's foreground browser needs the owner's consent. The standing delegation
      // gives it; without it the owner connects Aside from the Browsers & sign-in tab as before.
      // Aside is always looked for; Neo only when one of the owner's apps already has it as an MCP server.
      const engines=['aside',...([...found.values()].some(environment=>environment.browser_hints.includes('neo'))?['neo'] as const:[])] as const;
      if(workAutonomy(this.config)==='delegated')for(const engine of engines){
        if(this.browsers.view().rows.find(row=>row.engine===engine)?.registered)continue;
        const checked=await this.browsers.check(engine);
        if(checked.rows.find(row=>row.engine===engine)?.health==='ready'){this.browsers.register(engine,checked.revision,true);await this.activity.record('runtime','success',engine==='aside'?'설치된 Aside를 찾아 실행 도구로 등록했어요 · 새 연결부터 적용':'사용 중인 Neo를 찾아 실행 도구로 등록했어요 · 새 연결부터 적용');}
      }
    }catch{/* Looking for an optional browser never fails the connection check. */}
    return found;
  }
  private status(scope:ModelScope='global'){
    const saved=readModelSettings(scopedModelSettingsPath(this.path,scope)),global=publicModelSettings(readModelSettings(this.path),this.environment),base=modelScopeBase(this.path,scope,saved?.selection,this.environment);
    const settings=publicModelSettings(saved,base);
    return {...settings,...(scope==='coding'&&!saved?{selection:global.selection}:{}),...(scope==='coding'?{applies_to:'next_planner_call_stage_or_new_dialog',attached_dialog_models:'pinned'}:{}),scope,inherit_global:scope==='coding'?(!saved||Boolean(saved.inherit_global)):false,computer:this.connection(),runtime_platform:process.platform,site_login_configured:Boolean(this.config.swarm?.visual.owned_vm),work_model_data:{approved:workModelDataApproved(this.config),editable:this.connection().kind==='local'},execution_approval_unchanged:true};
  }
  private warmed=false;
  private models(fresh=false){return this.recall('models:global',600_000,async()=>{const [codex,opencode]=await Promise.all([codexModelCatalog(),opencodeModelCatalog(this.environment)]);return {codex,claude:claudeModelCatalog(),opencode};},fresh);}
  async handle(request:IncomingMessage,response:ServerResponse,suffix:string,host:string){
    // The first page the owner opens (any page) starts the slow questions to the apps in the background, so the
    // settings page finds the answers ready (live: its first visit after a start still took 8 s).
    if(connectionWarmup&&!this.warmed){this.warmed=true;void this.connections().catch(()=>{});void this.models().catch(()=>{});}
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
        else if(suffix==='settings/bootstrap')send(200,{...this.bootstrap.view(),connections:await this.connections()});
        else if(suffix==='settings/browsers')send(200,this.browsers.view());
        else if(suffix==='settings/maintenance/status')send(200,this.maintenance.view());
        else if(suffix==='settings/models')send(200,await this.models());
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
        // Anything the owner changes may change what the apps report.
        if(suffix!=='settings/refresh'&&suffix!=='settings/provider-probe')this.remembered.clear();
        if(suffix==='settings/maintenance/settings'){
          const value=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:{};
          if(Object.keys(value).some(key=>!['revision','enabled'].includes(key))||!Number.isSafeInteger(value.revision)||typeof value.enabled!=='boolean')throw Error('CLIENT_MAINTENANCE_SETTINGS_INVALID');
          const result=await this.maintenance.save({revision:value.revision as number,enabled:value.enabled});
          await this.activity.record('setup','success',result.enabled?'CLI 자동 업데이트를 켰습니다.':'CLI 자동 업데이트를 껐습니다.');send(200,result);return true;
        }
        if(suffix==='settings/maintenance/update-now'){
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw Error('CLIENT_MAINTENANCE_SETTINGS_INVALID');
          this.maintenanceOwnRequest=true;
          try{send(200,await this.performMaintenance(true));}finally{this.maintenanceOwnRequest=false;}
          return true;
        }
        if(suffix.startsWith('settings/browsers/')){
          const value=body as {engine?:unknown;revision?:unknown;consent?:unknown};
          if(!value||!['playwright','aside','neo'].includes(String(value.engine))){send(400,{error:'BROWSER_SETUP_ENGINE_INVALID'});return true;}
          const engine=value.engine as 'playwright'|'aside'|'neo',label=engine==='playwright'?'Playwright':engine==='aside'?'Aside':'Neo',started=Date.now();
          let result:ReturnType<BrowserSetupController['view']>;
          try{
            if(suffix==='settings/browsers/check'){
              await this.activity.record('runtime','running',`${label} 연결 점검 시작`);result=await this.browsers.check(engine);
            }else if(suffix==='settings/browsers/install'&&engine==='playwright'){
              await this.activity.record('runtime','running','Playwright 전용 Chromium 다운로드 시작');result=await this.browsers.installPlaywright();
            }else if(suffix==='settings/browsers/register'&&engine!=='playwright'&&typeof value.revision==='string'){
              result=this.browsers.register(engine,value.revision,value.consent===true);await this.activity.record('runtime','success',`${label} 실행기 등록 완료 · 새 MCP 연결부터 적용`);send(200,result);return true;
            }else{send(400,{error:'BROWSER_SETUP_ACTION_INVALID'});return true;}
            const row=result.rows.find(row=>row.engine===engine),ready=row?.health==='ready',outcome=ready?(row.registered?'연결됨':'연결 확인됨 · 사용 허용 필요'):row?.reason==='cli_missing'?'CLI 설치 필요':'연결 실패 · 앱 실행과 연결 설정을 확인하세요';
            await this.activity.record('runtime',ready?'success':'warning',`${label}: ${outcome} · ${((Date.now()-started)/1000).toFixed(1)}초`);send(200,result);
          }catch(error){await this.activity.record('runtime','error',`${label} 준비를 완료하지 못했습니다. 설치·실행 상태를 확인하세요.`);throw error;}
          return true;
        }
        if(suffix==='settings/mcp/check'){
          await this.activity.record('mcp','running','앱 설치·로그인·MCP 연결을 확인하는 중입니다.');
          const [mcp,connections]=await Promise.all([this.mcp.view(),this.auth.connections()]);
          const bootstrap={...this.bootstrap.view(),connections};
          await this.recordClientChecks(connections,mcp.clients);
          for(const client of bootstrap.clients.filter(client=>!connections.some(row=>row.id===client.id)))await this.activity.record('mcp','warning',client.label+': '+(client.installed?'로그인 미확인':'설치 필요'));
          await this.activity.record('mcp','info','앱 연결 확인을 마쳤습니다. 클라이언트별 결과를 확인하세요.');
          send(200,{mcp,bootstrap});
        }else if(suffix==='settings/models'){
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
        else if(suffix==='settings/refresh'){
          // Opening the tab shows the last check; pressing the check button (force) or having none yet asks the apps.
          const fresh=(body as {force?:unknown}|null)?.force===true||!this.remembered.has('connections');
          if(fresh){this.remembered.delete('models:global');await this.activity.record('ai','running','로그인된 AI 클라이언트를 확인하는 중입니다.');}
          const clients=await this.connections(fresh);if(fresh)await this.recordClientChecks(clients);const found=await this.existingEnvironment(clients,fresh);if(fresh)await this.activity.record('ai','info','AI 클라이언트 상태 확인을 마쳤습니다.');
          send(200,{clients:clients.map(client=>found.has(client.id)?{...client,environment:found.get(client.id)}:client),checked:fresh?'now':'remembered'});}
        else if(suffix==='settings/login'){
          const value=body as {client?:unknown;flow?:unknown};
          if(!value||!['codex','claude','opencode','cursor','hermes'].includes(String(value.client))||!['device','browser'].includes(String(value.flow))){send(400,{error:'INVALID_CLIENT_FLOW'});return true;}
          await this.activity.record('ai','running','공식 AI 로그인 절차를 시작했습니다.');send(202,await this.auth.start(value.client as McpRegistrationClient,value.flow as 'device'|'browser'));
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
          await this.activity.record('setup','success',`${name} 설치 확인 완료 · ${((Date.now()-started)/1000).toFixed(1)}초`);
          const connection=(await this.auth.connections()).find(item=>item.id===client);
          const flow=connection?.supported_login_flows.includes('device')?'device':connection?.supported_login_flows[0];
          const login=connection?.status==='ready'?{client_id:client,flow:flow??null,state:'completed',reason:'existing_session_reused',credentials_exposed:false}:
            flow?await this.auth.start(client,flow):{client_id:client,flow:null,state:'unavailable',reason:connection?.reason??'login_contract_unavailable',credentials_exposed:false};
          await this.activity.record('ai',login.state==='completed'?'success':login.state==='unavailable'||login.state==='failed'?'warning':'running',`${name} ${login.state==='completed'?'기존 로그인 확인됨':login.state==='unavailable'||login.state==='failed'?'설치됨 · 로그인 재확인 필요':'공식 로그인 시작 · 브라우저에서 승인하세요'}`);
          send(200,{...result,login});
        }else if(suffix==='settings/mcp/register'){
          const value=body as {client?:unknown};if(!value||!['codex','claude','opencode','cursor','hermes'].includes(String(value.client))){send(400,{error:'MCP_CLIENT_INVALID'});return true;}
          const name=({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'} as const)[value.client as McpRegistrationClient];
          await this.activity.record('mcp','running',`${name}에 agent-office mcp 등록 요청`);
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
    }catch(error){if(suffix==='settings/mcp/check'||suffix==='settings/refresh'||suffix==='settings/provider-probe')await this.activity.record(suffix==='settings/mcp/check'?'mcp':'ai','error','연결 상태를 확인하지 못했습니다. 다시 확인해 주세요.');const message=error instanceof Error&&/^(?:BROWSER_SETUP|MODEL_SETTINGS|MODEL_KEY|MODEL_PROVIDER|JEV_CREDENTIAL|SETTINGS_INPUT|MCP_CLIENT|MCP_REGISTRATION|CURSOR_MCP_CONFIG|OPENCODE_MCP_CONFIG|CLIENT_INSTALL|CLIENT_MAINTENANCE)_[A-Z_]+$/u.test(error.message)?error.message:'SETTINGS_REQUEST_INVALID';if(suffix==='settings/mcp/register')await this.activity.record('mcp','error','MCP 등록을 마치지 못했습니다. 클라이언트 상태를 확인해 주세요.');if(suffix==='settings/client/install')await this.activity.record('setup','error',message.startsWith('CLIENT_INSTALL_DOWNLOAD')?'설치 파일 다운로드 실패 · 네트워크를 확인한 뒤 설치를 다시 누르세요.':'설치 완료를 확인하지 못했습니다. 연결 작업 기록과 설치 상태를 다시 확인하세요.');send(message.includes('CONFLICT')||message.includes('BUSY')||message.includes('LOCKED')?409:message.includes('TOO_LARGE')?413:400,{error:message});}
    return true;
  }
  async close(){this.auth.close();try{await this.maintenance.close();}catch{await this.activity.record('setup','warning','CLI 업데이트를 마무리하지 못했습니다. 실행 로그에서 실패 내용을 확인해 주세요.').catch(()=>{});}finally{this.activity.close();}}
}
