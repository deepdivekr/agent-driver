import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,delimiter,dirname,extname,isAbsolute,join,relative} from 'node:path';
import {type PackStore} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {hashJson} from '../taskpack/adaptive-spec.js';
import {classifyClientFailure} from '../integrations/client-failure.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable,type SafeProcessRunner} from '../integrations/subscription-auth.js';
import {sanitizeCodingReply} from '../coding/reply-safety.js';
import {ownerMcpEnabled,windowsClientServers,type ClientRunMcpServer} from '../integrations/owner-mcp.js';
import {ownerEnvironmentContext} from '../integrations/client-environment.js';
import {type WorkActivityMetadata} from './activity.js';
import {workClientChoiceSchema,type WorkClientChoice} from './contracts.js';
import {type ModelSettings} from '../onboarding/model-settings.js';
import {customPackWorkBinding} from './custom-pack-repeat.js';
import {workImportExecutionOwner} from './import-authority.js';
import {WORK_COMPLETION_REPAIR_BUDGET,boundWorkToolValue,type WorkClientCheckpoint,type WorkClientResult,type WorkClientToolReceipt} from './client-executor.js';

/**
 * The client's own agent runs a Work: Codex (`exec --json`) or Claude Code (`-p`, stream-json), with the owner's own
 * settings, skills, plugins and MCP servers, in an Office-owned Work folder. Office streams its events to the timeline,
 * keeps the session to resume it, takes the files it made as the result, and verifies that result. One client per
 * Work: nothing here moves a Work or a session to another client.
 */
export type RunClient='codex'|'claude';
type Check={id:string;result:string;evidence:string};
type Verify=(checks:Check[],observations:WorkClientCheckpoint['observations'],claim:{action:'complete';stage_id:null;tool_name:null;arguments_json:null;summary:string;wait_reason:null;completed_checks:Array<{id:string;evidence_ids:string[]}>})=>Promise<boolean|{verified:false;repair:{check_id:string;reason?:string|undefined}}>;

// The owner's Windows-side MCP servers (Aside, their main browser, lives there) go to the client only in a process where the
// owner's own MCP servers may be used: a service process, never a test reading the developer's home.
const ownerServers=async(client:RunClient):Promise<ClientRunMcpServer[]>=>ownerMcpEnabled()?windowsClientServers(client):[];
let enabled=false,runner:SafeProcessRunner=nativeProcessRunner,executable:(client:RunClient)=>string=client=>resolveSubscriptionClientExecutable(client),servers=ownerServers;
/** Service entries make the client's own agent the Work executor; AGENT_OFFICE_CLIENT_RUN=off keeps the host-tool loop. */
export function enableClientRun(options:{runner?:SafeProcessRunner;executable?:(client:RunClient)=>string;servers?:(client:RunClient)=>Promise<ClientRunMcpServer[]>}={}){
  enabled=process.env.AGENT_OFFICE_CLIENT_RUN!=='off';
  if(options.runner)runner=options.runner;if(options.executable)executable=options.executable;if(options.servers)servers=options.servers;
}
export function disableClientRun(){enabled=false;runner=nativeProcessRunner;executable=client=>resolveSubscriptionClientExecutable(client);servers=ownerServers;}
export const clientRunEnabled=()=>enabled;

// On Linux the resolver already checked the program; elsewhere it returns a bare name, installed when it is on PATH.
const onPath=(command:string)=>isAbsolute(command)||(process.env.PATH??'').split(delimiter).filter(Boolean).some(directory=>['','.exe','.cmd'].some(extension=>existsSync(join(directory,command+extension))));
const migrated=new WeakSet<object>();
function pinTable(store:PackStore){
  const db=store.hermesState;if(migrated.has(db))return db;
  db.exec('CREATE TABLE IF NOT EXISTS office_work_client(project_id TEXT NOT NULL,work_id TEXT NOT NULL,client TEXT NOT NULL,pinned_at TEXT NOT NULL,model TEXT,effort TEXT,PRIMARY KEY(project_id,work_id))');
  // The first version of this table held the client only.
  for(const column of ['model','effort'])try{db.exec(`ALTER TABLE office_work_client ADD COLUMN ${column} TEXT`);}catch{/* already there */}
  migrated.add(db);return db;
}
/** The Work's client, model and reasoning effort, or null when none is pinned (an OpenCode default keeps the host-tool loop). */
export function workClientChoice(store:PackStore,project:string,workId:string):WorkClientChoice|null{
  const row=pinTable(store).prepare('SELECT client,model,effort FROM office_work_client WHERE project_id=? AND work_id=?').get(project,workId) as {client:string;model:string|null;effort:string|null}|undefined;
  if(!row)return null;const parsed=workClientChoiceSchema.safeParse({id:row.client,model:row.model??null,effort:row.effort??null});
  return parsed.success?parsed.data:{id:row.client==='claude'?'claude':'codex',model:null,effort:null};
}
/** The client, model and effort a Work gets when the owner does not choose: the owner's default client (the other one when
 * only that is installed) with its saved model and effort. An OpenCode default gets none and keeps the host-tool loop. */
export function defaultWorkClient(settings:ModelSettings|null):WorkClientChoice|null{
  const installed=(client:RunClient)=>{try{return onPath(executable(client));}catch{return false;}};
  const preferred=settings?.selection.client??process.env.AGENT_DRIVER_LLM_CLIENT?.split(',')[0]?.trim();
  const client=preferred==='opencode'?null:(preferred==='claude'?['claude','codex'] as const:['codex','claude'] as const).find(installed)??null;
  return client?{id:client,model:settings?.selection.client_models[client]??null,effort:client==='codex'?settings?.selection.codex_reasoning_effort??null:null}:null;
}
/** Pin the Work's client once: the owner's choice at intake, or, when none was given, the owner's defaults (the
 * default client, or the other one when only that is installed). Later runs and settings changes never switch it. */
export function pinWorkClient(store:PackStore,project:string,workId:string,choice:WorkClientChoice|undefined,settings:ModelSettings|null):WorkClientChoice|null{
  const pinned=workClientChoice(store,project,workId);if(pinned)return pinned;
  const value=choice??defaultWorkClient(settings);if(!value)return null;
  pinTable(store).prepare('INSERT OR IGNORE INTO office_work_client(project_id,work_id,client,pinned_at,model,effort) VALUES(?,?,?,?,?,?)').run(project,workId,value.id,new Date().toISOString(),value.model,value.effort);
  return workClientChoice(store,project,workId);
}
export const workFolder=(config:Pick<HostConfig,'dbPath'>,workId:string)=>join(dirname(config.dbPath),'work-folders',workId);

// API keys would move a subscription client onto paid API billing; Office's own and the calling session's variables are not the owner's.
const withheld=/^(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AZURE_OPENAI_API_KEY|OPENROUTER_API_KEY|TYPESAFE_API_KEY|AGENT_DRIVER_\w+|AGENT_OFFICE_\w+|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CODEX_SANDBOX\w*|CODEX_THREAD_ID)$/u;
export function clientRunEnvironment(base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  return Object.fromEntries(Object.entries(base).filter(([key,value])=>value!==undefined&&!withheld.test(key)));
}
// A Work's run must not start, run or change Works through Office's own MCP server, which the owner's clients have registered.
const OFFICE_CONTROL_TOOLS=['runtime_work_start','runtime_work_execute','runtime_work_control'];
const codexHasOffice=()=>{try{return /^\[mcp_servers\.(?:agent-driver|"agent-driver")\]/mu.test(readFileSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'config.toml'),'utf8'));}catch{return false;}};
/** Everything allowed, as when the owner uses the client app: no sandbox and no approval prompts. */
export function clientRunArgs(choice:Pick<WorkClientChoice,'id'|'model'|'effort'>,folder:string,session:{id:string;resume:boolean}|null,officeRegistered=codexHasOffice(),extra:ClientRunMcpServer[]=[]){
  const {model,effort}=choice;
  if(choice.id==='codex')return ['-C',folder,...(model?['-m',model]:[]),'--dangerously-bypass-approvals-and-sandbox',...(effort?['-c',`model_reasoning_effort=${effort}`]:[]),
    ...extra.flatMap(server=>[...(server.command?['-c',`mcp_servers.${server.id}.command=${JSON.stringify(server.command)}`,'-c',`mcp_servers.${server.id}.args=${JSON.stringify(server.args??[])}`]:['-c',`mcp_servers.${server.id}.url=${JSON.stringify(server.url)}`]),
      ...(server.startup_timeout_sec?['-c',`mcp_servers.${server.id}.startup_timeout_sec=${server.startup_timeout_sec}`]:[]),...(server.tool_timeout_sec?['-c',`mcp_servers.${server.id}.tool_timeout_sec=${server.tool_timeout_sec}`]:[])]),
    ...(officeRegistered?['-c',`mcp_servers.agent-driver.disabled_tools=${JSON.stringify(OFFICE_CONTROL_TOOLS)}`]:[]),'exec',...(session?.resume?['resume','--json','--skip-git-repo-check',session.id,'-']:['--json','--skip-git-repo-check','-'])];
  return ['-p','--output-format','stream-json','--verbose','--dangerously-skip-permissions',...(model?['--model',model]:[]),...(effort?['--effort',effort]:[]),
    ...(extra.length?['--mcp-config',JSON.stringify({mcpServers:Object.fromEntries(extra.map(server=>[server.id,server.command?{type:'stdio',command:server.command,args:server.args??[]}:{type:'http',url:server.url}]))})]:[]),'--disallowedTools',OFFICE_CONTROL_TOOLS.map(tool=>`mcp__agent-driver__${tool}`).join(','),...(session?[session.resume?'--resume':'--session-id',session.id]:[])];
}
/** Works whose completion Office proves in code (sealed collections, native checks), whose writes go through Office's
 * approved Pack execution, coding Works (their own project), custom Pack repeats and Works another runtime still owns
 * keep the host's own path. A pasted Work that Office accepted as its own is run like any other (live 2026-10-03: the
 * owner's imported derivatives Work was kept on the host path and met its wait again). */
export function clientRunEligible(store:PackStore,project:string,workId:string,spec:{route:{pack_family:string|null};collection_contract?:unknown;completion_checks:Array<{native_check?:unknown}>}){
  return !['coding.orchestrate','form.draft-submit','record.update','choose.stage'].includes(spec.route.pack_family??'')&&!spec.collection_contract&&!spec.completion_checks.some(check=>check.native_check)
    &&!customPackWorkBinding(store,project,workId)&&workImportExecutionOwner(store,project,workId)!=='original_runtime';
}

export interface ClientRunEvent {kind:'tool.started'|'tool.result'|'model.result';tool_name:string;summary:string;status:'running'|'succeeded'|'failed';}
interface RunState {session:string|null;final:string;done:boolean;turnFailed:boolean;failure:string;tools:Map<string,string>;counts:{commands:number;file_changes:number;tool_calls:number;web:number};}
type Json=Record<string,unknown>;
const object=(value:unknown):Json=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};
const text=(value:unknown)=>typeof value==='string'?value:'';
const brief=(value:string,limit=300)=>{const clean=sanitizeCodingReply(value).text.replace(/\s+/gu,' ').trim();return clean.length>limit?`${clean.slice(0,limit-1)}…`:clean;};
// Codex wraps every command in a login shell; the inner command is what the owner wants to see.
const shellCommand=(command:string)=>command.match(/^\S*bash -lc (['"])([\s\S]*)\1$/u)?.[2]??command;
function count(state:RunState,tool:string){if(tool==='shell')state.counts.commands++;else if(tool==='file_change')state.counts.file_changes++;else if(tool==='web_search'||tool==='web_fetch')state.counts.web++;else state.counts.tool_calls++;}

function codexEvent(event:Json,state:RunState):ClientRunEvent[]{
  if(event.type==='thread.started'&&text(event.thread_id)){state.session=text(event.thread_id);return [];}
  if(event.type==='turn.completed'){state.done=true;return [];}
  if(event.type==='turn.failed'){state.turnFailed=true;state.failure=text(object(event.error).message)||'turn failed';return [];}
  if(event.type==='error'){state.failure=text(event.message)||state.failure;return [];}
  if(event.type!=='item.started'&&event.type!=='item.completed')return [];
  const item=object(event.item),started=event.type==='item.started';
  if(item.type==='command_execution'){
    const command=shellCommand(text(item.command));if(started)return [{kind:'tool.started',tool_name:'shell',summary:command,status:'running'}];
    count(state,'shell');return [{kind:'tool.result',tool_name:'shell',summary:`exit ${typeof item.exit_code==='number'?item.exit_code:'?'} · ${command}`,status:item.status==='completed'&&item.exit_code===0?'succeeded':'failed'}];
  }
  if(item.type==='mcp_tool_call'){
    const name=`${text(item.server)}.${text(item.tool)}`;if(started)return [{kind:'tool.started',tool_name:name,summary:name,status:'running'}];
    count(state,name);return [{kind:'tool.result',tool_name:name,summary:text(object(item.error).message)||name,status:item.status==='completed'?'succeeded':'failed'}];
  }
  if(started)return [];
  if(item.type==='file_change'){count(state,'file_change');return [{kind:'tool.result',tool_name:'file_change',summary:(Array.isArray(item.changes)?item.changes:[]).map(change=>`${text(object(change).kind)} ${basename(text(object(change).path))}`).join(', '),status:item.status==='completed'?'succeeded':'failed'}];}
  if(item.type==='web_search'){count(state,'web_search');return [{kind:'tool.result',tool_name:'web_search',summary:text(item.query),status:'succeeded'}];}
  if(item.type==='agent_message'&&text(item.text)){state.final=text(item.text);return [{kind:'model.result',tool_name:'message',summary:text(item.text),status:'succeeded'}];}
  if(item.type==='error')return [{kind:'model.result',tool_name:'client_error',summary:text(item.message),status:'failed'}];
  return [];
}
const claudeTool=(name:string)=>name==='Bash'?'shell':['Write','Edit','MultiEdit','NotebookEdit'].includes(name)?'file_change':name==='WebSearch'?'web_search':name==='WebFetch'?'web_fetch':name.startsWith('mcp__')?name.slice(5).replace('__','.'):name;
function claudeEvent(event:Json,state:RunState):ClientRunEvent[]{
  if(event.type==='system'&&event.subtype==='init'&&text(event.session_id)){state.session=text(event.session_id);return [];}
  const content=Array.isArray(object(event.message).content)?object(event.message).content as unknown[]:[];
  if(event.type==='assistant')return content.map(object).flatMap((block):ClientRunEvent[]=>{
    if(block.type==='tool_use'){
      const tool=claudeTool(text(block.name)),input=object(block.input);state.tools.set(text(block.id),tool);count(state,tool);
      return [{kind:'tool.started',tool_name:tool,summary:text(input.command)||text(input.file_path)||text(input.url)||text(input.query)||text(input.description)||text(input.prompt)||tool,status:'running'}];
    }
    return block.type==='text'&&text(block.text).trim()?[{kind:'model.result',tool_name:'message',summary:text(block.text),status:'succeeded'}]:[];
  });
  if(event.type==='user')return content.map(object).filter(block=>block.type==='tool_result').map(block=>({kind:'tool.result',tool_name:state.tools.get(text(block.tool_use_id))??'tool',summary:typeof block.content==='string'?block.content:Array.isArray(block.content)?block.content.map(part=>text(object(part).text)).join(' '):'',status:block.is_error===true?'failed':'succeeded'}));
  if(event.type==='result'){
    state.done=event.subtype==='success'&&event.is_error!==true;if(text(event.result))state.final=text(event.result);
    if(!state.done){state.turnFailed=true;state.failure=text(event.result)||text(event.subtype);}
    if(text(event.session_id))state.session=text(event.session_id);
  }
  return [];
}

export interface ClientRunOutcome {session_id:string|null;final_message:string;completed:boolean;reason:string|null;counts:RunState['counts'];}
/** One run of the client's own agent until its turn ends. Unknown events are tolerated: both clients update themselves. */
export async function runClient(request:{client:RunClient;model:string|null;effort:WorkClientChoice['effort'];servers?:ClientRunMcpServer[];folder:string;prompt:string;session:{id:string;resume:boolean}|null;signal:AbortSignal;timeout_ms?:number;onSession:(id:string)=>void;onEvent:(event:ClientRunEvent)=>void}):Promise<ClientRunOutcome>{
  // A new Claude session's pre-assigned ID is confirmed only when the client reports it.
  const state:RunState={session:request.session?.resume?request.session.id:null,final:'',done:false,turnFailed:false,failure:'',tools:new Map(),counts:{commands:0,file_changes:0,tool_calls:0,web:0}};
  let pending='';
  const observe=(chunk:string)=>{
    pending+=chunk;
    for(;;){
      const at=pending.indexOf('\n');if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line.trim())continue;
      let event:Json;try{event=object(JSON.parse(line));}catch{continue;}
      const before=state.session,events=request.client==='codex'?codexEvent(event,state):claudeEvent(event,state);
      // Both clients use UUID session IDs; anything else is not kept as a session to resume.
      if(state.session&&state.session!==before&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(state.session))request.onSession(state.session);
      for(const item of events)request.onEvent({...item,summary:brief(item.summary)});
    }
    if(pending.length>8_388_608)throw Error('CLIENT_EVENT_TOO_LARGE');
  };
  mkdirSync(request.folder,{recursive:true});
  const result=await runner.run({executable:executable(request.client),args:clientRunArgs({id:request.client,model:request.model,effort:request.effort},request.folder,request.session,codexHasOffice(),request.servers),cwd:request.folder,stdin:request.prompt,timeout_ms:request.timeout_ms??7_200_000,signal:request.signal,env:clientRunEnvironment(),keep_stdout:false,output_limit_bytes:8_388_608,onStdout:observe});
  observe('\n');
  const completed=result.code===0&&state.done&&!state.turnFailed;
  return {session_id:state.session,final_message:state.final,completed,reason:completed?null:`CLIENT_${classifyClientFailure(`${state.failure}\n${result.stderr.slice(-4000)}`).toUpperCase()}`,counts:state.counts};
}

const mediaTypes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.html':'text/html','.mp4':'video/mp4','.mp3':'audio/mpeg','.zip':'application/zip','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
export interface ProducedFile {path:string;name:string;sha256:string|null;bytes:number;media_type:string;}
// Office offers a result file for download up to 16 MB (WorkResults.readArtifact); a larger one stays in the run folder.
const DOWNLOAD_BYTES=16*1024*1024;
/** The files in this run's own folder: what the run produced, whatever their timestamps (a downloaded or unpacked file
 * keeps its original one). Hidden folders are the client's own. */
export function producedFiles(folder:string):ProducedFile[]{
  const found:ProducedFile[]=[];
  // Breadth first: the files the client put at the top come before an unpacked archive's contents.
  const queue:Array<[string,number]>=[[folder,0]];
  for(let next=queue.shift();next&&found.length<200;next=queue.shift()){
    const [directory,depth]=next;let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch{continue;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(found.length>=200||entry.name.startsWith('.')||entry.name==='node_modules')continue;
      const path=join(directory,entry.name);
      if(entry.isDirectory()){if(depth<4)queue.push([path,depth+1]);continue;}
      if(!entry.isFile())continue;
      const stat=lstatSync(path);
      found.push({path,name:relative(folder,path),sha256:stat.size<=DOWNLOAD_BYTES?createHash('sha256').update(readFileSync(path)).digest('hex'):null,bytes:stat.size,media_type:mediaTypes[extname(entry.name).toLowerCase()]??'application/octet-stream'});
    }
  }
  return found;
}
/** The saved result: the client's final reply, the files it made, and the text of small text files, within 16000 characters. */
export function clientResultText(finalMessage:string,files:ProducedFile[]){
  const list=files.length?`\n\nFiles made in this run (Work folder):\n${files.map(file=>`- ${file.name} (${file.media_type}, ${file.bytes} bytes${file.sha256?'':', too large to download from Office; it stays in the run folder'})`).join('\n')}`:'\n\nNo file was made in the Work folder in this run.';
  let body=`${sanitizeCodingReply(finalMessage.trim()).text.slice(0,6000)||'(no final reply)'}${list}`;
  // Smaller files first, so each one that fits is complete (live: a long JSON cut mid-way left the checks on it undecided).
  for(const file of files.filter(item=>/^text\/|^application\/json$/u.test(item.media_type)&&item.bytes<=65_536).sort((a,b)=>a.bytes-b.bytes)){
    const room=15_800-body.length;if(room<400)break;
    body+=`\n\n── ${file.name} ──\n${sanitizeCodingReply(readFileSync(file.path,'utf8')).text.slice(0,room-file.name.length-10)}`;
  }
  return body.slice(0,16000);
}

export interface ClientRunInput {
  client:RunClient;model:string|null;effort:WorkClientChoice['effort'];work_id:string;run_id:string;folder:string;title:string;prompt:string;checks:Check[];
  /** What intake settled with the owner: answers, agreed scope, collection window, the host schedule. */
  context:Json;directions:Array<{instruction:string;created_at:string}>;
  checkpoint:WorkClientCheckpoint|null;signal:AbortSignal;guard:()=>void;save:(checkpoint:WorkClientCheckpoint)=>void;
  /** The owner resumed or retried this run. */
  resumed:boolean;
  activity:(kind:string,summary:string,metadata?:WorkActivityMetadata)=>void;
  draft:(text:string,label:string,requestId:string)=>Promise<WorkClientToolReceipt>;verify:Verify;
  /** Office reads its saved result back (office_result_read of the draft), which a check that the result is saved and
   * readable rests on (live: without it the verifier could not decide "saved and readable"). */
  readback?:(requestId:string,args:Record<string,unknown>)=>Promise<WorkClientToolReceipt>;
  /** A recurring Work: Office's own schedule record, which a check about future runs rests on (Office runs the schedule, not the client). */
  schedule?:(requestId:string,args:Record<string,unknown>)=>Promise<WorkClientToolReceipt>;
  /** Office's own delivery selection, which a check about where the result goes rests on (live: a Work asked that its
   * Telegram chat be set as the target; intake had not recorded it, so nothing in the run could show it). */
  delivery?:(requestId:string,args:Record<string,unknown>)=>Promise<WorkClientToolReceipt>;
}
const clientName=(client:RunClient)=>client==='codex'?'Codex':'Claude Code';
// Live (2026-10-03): told that a schedule condition was not met, Codex went looking through Office's MCP tools and database to
// enable the schedule itself. The schedule and delivery are Office's; the client's part is the result in its folder.
const OFFICE_OWNS='Office delivers the result to the owner after checking it and runs any schedule itself. Do not send the result anywhere, do not set up schedules, and do not look into or change Agent Office, its data or its Work records.';
/** The owner's instruction file for this client on the Windows side; the local one the client loads itself. */
const windowsInstructions=(client:RunClient)=>(ownerEnvironmentContext().owner_environment?.instructions??[]).filter(item=>item.app===client&&item.file.endsWith('(Windows)'));
function initialPrompt(input:ClientRunInput){
  return [`Agent Office hands you this Work. Do it yourself, with your own tools, skills and settings, until the result is finished.`,
    `Work folder: ${input.folder}. It is your working directory for this run. Save every deliverable here as files (images, documents, data). Folders of this Work's earlier runs, if any, are next to it.`,
    `Request from the owner:\n${input.prompt}`,
    ...(input.directions.length?[`Later directions from the owner (newest last; they change the request where they differ):\n${input.directions.map(item=>`- ${item.instruction}`).join('\n')}`]:[]),
    `Completion conditions Office will check against the files you leave and your final reply:\n${input.checks.map(check=>`- ${check.id}: ${check.result}`).join('\n')}`,
    ...(Object.keys(input.context).length?[`What Office already settled with the owner:\n${JSON.stringify(input.context,null,1)}`]:[]),
    ...windowsInstructions(input.client).map(item=>`The owner's standing instructions for ${clientName(input.client)} on the Windows side of this computer (${item.file}); this run does not load them by itself. Follow them where they apply:\n${item.text}`),
    'Nobody answers questions during the run. If only the owner can unblock something (a sign-in, a payment, a decision), stop and say exactly what is needed.',
    OFFICE_OWNS,
    'Finish with a short reply in the language of the request: what you made, each file name, and how each completion condition is met.'].join('\n\n');
}

/** Run the Work on its pinned client: start or resume its session, save what it made, verify, and send a denial back to the same session. */
export async function executeClientRun(input:ClientRunInput):Promise<WorkClientResult>{
  const {client,work_id,run_id}=input,latest=input.directions.at(-1)?.created_at??null;
  let cp:WorkClientCheckpoint=input.checkpoint?.client_session?input.checkpoint:{format:1,work_id,run_id,binding:hashJson({work_id,run_id,client}),turn:0,pending:null,observations:[],summary:'',
    client_session:{client,session_id:client==='claude'?randomUUID():null,confirmed:false,started_ms:Date.now(),finished:false,direction_at:latest,repairs:0}};
  const session=()=>cp.client_session!;
  const update=(changes:Partial<NonNullable<WorkClientCheckpoint['client_session']>>)=>{cp={...cp,client_session:{...session(),...changes}};input.save(cp);};
  const fresh=input.directions.filter(item=>!session().direction_at||item.created_at>session().direction_at!);
  // A new direction starts a new round of corrections, and so does the owner's resume or retry after they ran out.
  if(session().repairs&&(fresh.length||input.resumed&&session().repairs>=WORK_COMPLETION_REPAIR_BUDGET))update({repairs:0});
  let next:string|null=!session().confirmed?initialPrompt(input)
    :fresh.length?`The owner changed the instruction for this Work:\n${fresh.map(item=>`- ${item.instruction}`).join('\n')}\n\nContinue in the same folder with this change. Finish with the same kind of short reply.`
    :!session().finished?'The run was interrupted. Continue the Work where you stopped, in the same folder, and finish with the short reply.':null;
  const meta=(extra:WorkActivityMetadata={}):WorkActivityMetadata=>({run_id,stage_id:'execution',model_provider:client,executor:client,...extra});
  // The owner's Windows-side servers are looked at only when the client actually runs.
  let extra:ClientRunMcpServer[]|null=null;
  for(;;){
    if(next){
      input.guard();update({finished:false,direction_at:latest});extra??=await servers(client).catch(()=>[]);
      input.activity('supervisor.client_run',`${clientName(client)} · ${session().confirmed?'같은 세션을 이어서 실행합니다.':'사용자 설정 그대로 업무 폴더에서 실행을 시작합니다.'}`,meta({status:'running',model_continuity:session().confirmed?'resumed_session':'new_session'}));
      if(extra.length)input.activity('tool.result',`windows_mcp · ${extra.map(server=>server.id).join(', ')}`,meta({tool_name:'windows_mcp',status:'succeeded'}));
      // Live (2026-10-03): given Aside, Codex still read Reddit and X with a headless browser and met their challenges.
      const browser=extra.find(server=>/aside/iu.test(server.id)),serverNote=extra.length?`\n\nMCP servers from the owner's Windows side of this computer are connected to this run: ${extra.map(server=>server.id).join(', ')}.${browser?` "${browser.id}" is an MCP server, not a shell command: its tools drive the owner's own signed-in browser. Read X, Reddit and every other site that blocks automated browsers or needs a sign-in through those tools, not with a headless browser, a web search or a shell command.`:''}`:'';
      // The owner's pause or direction change aborts the run; the guard turns a lost lease or a changed Work into a stop.
      const stop=new AbortController(),abort=()=>stop.abort();input.signal.addEventListener('abort',abort,{once:true});
      let guardFailure:unknown=null;const watch=setInterval(()=>{try{input.guard();}catch(error){guardFailure=error;stop.abort();}},5_000);watch.unref();
      let outcome:ClientRunOutcome;
      try{
        outcome=await runClient({client,model:input.model,effort:input.effort,servers:extra,folder:input.folder,prompt:next+serverNote,session:session().session_id?{id:session().session_id!,resume:session().confirmed}:null,signal:stop.signal,
          onSession:id=>update({session_id:id,confirmed:true}),onEvent:event=>input.activity(event.kind,`${event.tool_name} · ${event.summary}`,meta({tool_name:event.tool_name,status:event.status}))});
      }catch(error){
        if(stop.signal.aborted){if(guardFailure)throw guardFailure;input.guard();throw Error('WORK_PAUSED');}
        // A run that went past the time limit is resumed in the same session later, like an outage.
        if(error instanceof Error&&error.message==='CLIENT_TIMEOUT'){input.activity('supervisor.client_run',`${clientName(client)} · 실행이 끝나지 않았습니다: CLIENT_TIMEOUT`,meta({status:'failed',reason:'CLIENT_TIMEOUT'}));return {status:'waiting_model',summary:'',reason:'CLIENT_TIMEOUT',completion_verified:false,checkpoint:cp,model_calls:[]};}
        throw error;
      }finally{clearInterval(watch);input.signal.removeEventListener('abort',abort);}
      if(!outcome.completed){
        const reason=outcome.reason??'CLIENT_PROVIDER_UNAVAILABLE';
        input.activity('supervisor.client_run',`${clientName(client)} · 실행이 끝나지 않았습니다: ${reason}`,meta({status:'failed',reason}));
        // An outage of the client's provider is waited for with backoff, as the host path waits for a model.
        return {status:reason==='CLIENT_AUTH_EXPIRED'?'waiting_auth':['CLIENT_QUOTA_EXHAUSTED','CLIENT_RATE_LIMITED','CLIENT_PROVIDER_UNAVAILABLE','CLIENT_TIMEOUT'].includes(reason)?'waiting_model':['CLIENT_CONTEXT_EXHAUSTED','CLIENT_MODEL_UNSUPPORTED'].includes(reason)?'failed':'retryable_failure',summary:sanitizeCodingReply(outcome.final_message).text.slice(0,4000),reason,completion_verified:false,checkpoint:cp,model_calls:[]};
      }
      input.guard();
      const files=producedFiles(input.folder),resultText=clientResultText(outcome.final_message,files),observedAt=new Date().toISOString();
      const runEvidence=`client-run-${hashJson({run_id,session:outcome.session_id,final:outcome.final_message,files}).slice(0,24)}`;
      const runValue=boundWorkToolValue({client,session_id:outcome.session_id,folder:input.folder,final_message:sanitizeCodingReply(outcome.final_message).text.slice(0,4000),files:files.filter(file=>file.sha256).slice(0,20).map(({name:_name,...file})=>file),file_count:files.length,observed_by_host:'Files are the ones Office found in the Work folder after the run, with their SHA-256; the counts are the events the client reported. What the client did outside this folder ran under the owner\'s own permissions and is not an Office receipt.',counts:outcome.counts});
      const draftId=`client-output-${hashJson({run_id,text:resultText}).slice(0,24)}`,draft=await input.draft(resultText,input.title.slice(0,120),draftId);
      cp={...cp,turn:2,summary:sanitizeCodingReply(outcome.final_message).text.slice(0,4000),observations:[
        {invocation:{request_id:runEvidence,turn:0,stage_id:'execution',tool_name:'office_client_run',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:runValue,evidence_ids:[runEvidence],effect_state:'verified',retry_safe:false},observed_at:observedAt},
        {invocation:{request_id:draftId,turn:1,stage_id:'execution',tool_name:'office_result_draft',arguments:{},effect:'local_write',dispatched:true},receipt:{...draft,value:boundWorkToolValue(draft.value)},observed_at:new Date().toISOString()}]};
      // Office's own records the checks may rest on; the client neither sets up the schedule nor sends the result.
      for(const [tool,read,args] of [['office_result_read',input.readback,{request_id:draftId}],['office_schedule_status',input.schedule,{}],['office_delivery_status',input.delivery,{}]] as const){
        if(!read)continue;
        const requestId=`client-${tool.slice('office_'.length).replace(/_status$/u,'')}-${hashJson({run_id,observed_at:observedAt}).slice(0,24)}`,receipt=await read(requestId,args);
        cp={...cp,turn:cp.turn+1,observations:[...cp.observations,{invocation:{request_id:requestId,turn:cp.turn,stage_id:'execution',tool_name:tool,arguments:args,effect:'read_only',dispatched:true},receipt:{...receipt,value:boundWorkToolValue(receipt.value)},observed_at:new Date().toISOString()}]};
      }
      update({finished:true});
      input.activity('supervisor.client_run',`${clientName(client)} · 실행을 마쳤습니다. 만든 파일 ${files.length}개를 결과로 저장했습니다.`,meta({status:'succeeded'}));
    }
    input.guard();
    let verified:Awaited<ReturnType<Verify>>;
    try{verified=await input.verify(input.checks,cp.observations,{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:cp.summary,wait_reason:null,completed_checks:input.checks.map(check=>({id:check.id,evidence_ids:cp.observations.map(item=>item.invocation.request_id)}))});}
    catch(error){
      const reason=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'WORK_CLIENT_VERIFICATION_TRANSIENT';
      if(['WORK_PAUSED','WORK_EXECUTION_LEASE_LOST','WORK_REVISION_CONFLICT','CONFIG_CHANGED','MODEL_SETTINGS_CHANGED'].includes(reason))throw error;
      // The client's result is saved: a verifier that is briefly unavailable is waited for (with backoff), never a failed run.
      return {status:reason==='CLIENT_AUTH_EXPIRED'?'waiting_auth':['CLIENT_QUOTA_EXHAUSTED','CLIENT_RATE_LIMITED','STRUCTURED_MODEL_UNAVAILABLE','STRUCTURED_MODEL_TIMEOUT','CLIENT_TIMEOUT','MODEL_PROVIDER_UNAVAILABLE'].includes(reason)?'waiting_model':'retryable_failure',summary:cp.summary,reason,completion_verified:false,checkpoint:cp,model_calls:[]};
    }
    if(verified===true)return {status:'succeeded',summary:cp.summary,reason:null,completion_verified:true,checkpoint:cp,model_calls:[]};
    if(verified&&typeof verified==='object'&&session().repairs<WORK_COMPLETION_REPAIR_BUDGET){
      const check=input.checks.find(item=>item.id===verified.repair.check_id);
      update({repairs:session().repairs+1});
      // The owner sees what the client was asked to fix (live: the reason reached only the client).
      input.activity('supervisor.client_run',`${clientName(client)} · 검증에서 거절된 조건 ${verified.repair.check_id}의 수정을 같은 세션에 요청합니다 (${session().repairs}/${WORK_COMPLETION_REPAIR_BUDGET})${verified.repair.reason?`: ${brief(verified.repair.reason,400)}`:''}`,meta({status:'running',reason:verified.repair.check_id}));
      next=`Office checked your result against the completion conditions. Not met: ${verified.repair.check_id}${check?` (${check.result})`:''}.${verified.repair.reason?` Reason: ${verified.repair.reason}`:''}\n\nFix this in the same folder, then finish with the updated short reply. If the condition is about the schedule or the delivery, it is Office's part: change nothing and say so.\n\n${OFFICE_OWNS}`;
      continue;
    }
    return {status:'awaiting_review',summary:cp.summary,reason:'WORK_CLIENT_COMPLETION_REQUIRES_VERIFICATION',completion_verified:false,checkpoint:cp,model_calls:[]};
  }
}
