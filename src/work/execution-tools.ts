import {z} from 'zod';
import {type RuntimeApi} from '../interface/api.js';
import {tools} from '../interface/catalog.js';
import {type HostConfig} from '../interface/config.js';
import {RoutedBrowser,browserCatalog,browserTargets,eligibleBrowserTargets,assertBrowserUrl,validateBrowserCheckpoint,browserCheckpointBinding,publicBrowserRecovery,unusualSearchTraffic,type BrowserRouteOptions} from '../browser/executor-routing.js';
import {browserHostCompatible,browserObservationSchema,type BrowserTarget,type BrowserPreference} from '../browser/executor-contracts.js';
import {type PackStore} from '../packs/store.js';
import {workActivity} from './activity.js';
import {type WorkProposal} from './contracts.js';
import {requireCondition} from '../core/contracts.js';
import {hashJson,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {WorkClientToolInputError,type WorkClientTool,type WorkClientToolReceipt} from './client-executor.js';
import {readScopedFile,sha} from '../packs/data.js';
import {dirname,join,resolve} from 'node:path';
import {mkdir,open,realpath,stat} from 'node:fs/promises';
import {nativeProcessRunner} from '../integrations/subscription-auth.js';
import {readLocalGitCheckpoint} from '../coding/local-checkpoint.js';
import {safeControlText} from '../observability/safe-text.js';
import {knownLoginSites,readyAuthTargets,detectAuthGate} from '../swarm/browser-auth.js';

/** Potential effect, not a claim that a particular call performed a write.
 * Drafts also have durable state and must not be replayed after a lost reply.
 * Approval/grant, shell, raw UI actions and cross-Work coding resume are absent.
 */
const effects={
  runtime_pack_catalog:'read_only',runtime_pack_plan:'read_only',runtime_pack_run:'local_write',runtime_pack_status:'read_only',runtime_pack_execute_approved:'external_write',
  runtime_files_roots:'read_only',runtime_files_request:'draft_only',runtime_files_scan:'draft_only',runtime_files_inspect:'read_only',runtime_files_classify:'draft_only',runtime_files_propose:'draft_only',runtime_files_report:'read_only',
  runtime_windows_catalog:'read_only',runtime_windows_design:'draft_only',runtime_windows_start:'draft_only',runtime_windows_step:'external_write',runtime_windows_status:'read_only',
  runtime_work_context:'read_only',runtime_coding_projects:'read_only',runtime_coding_start:'local_write',runtime_coding_step:'local_write',runtime_coding_status:'read_only',runtime_coding_pause:'draft_only',runtime_coding_reconcile:'read_only',office_web_search:'read_only',office_social_search:'read_only',office_browser_read:'read_only',office_browser_links:'read_only',office_result_draft:'local_write',office_result_read:'read_only',
} as const satisfies Record<string,WorkClientTool['effect']>;
type ExecutionToolName=keyof typeof effects;
const injectWork=new Set(['runtime_pack_plan','runtime_pack_run','runtime_files_request','runtime_files_scan','runtime_files_propose','runtime_files_report','runtime_windows_design','runtime_windows_start','runtime_work_context','runtime_coding_start']);
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const browserInput=z.object({url:z.string().url().max(4096)}).strict();
const browserLinksInput=z.object({offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(40).default(20),snapshot_id:z.string().regex(/^[a-f0-9]{64}$/u).optional()}).strict();
const privateHostname=(value:string)=>/^(?:localhost$|.*\.localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)|\.(?:local|lan|internal)$/iu.test(value);
function safeSearchQuery(value:string){
  if(/(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bapikey_[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._-]{16,}|\b[A-Za-z0-9_]*(?:token|password|secret|api.?key|auth|session|cookie)[A-Za-z0-9_]*\s*[=:]\s*\S+)/iu.test(value))return false;
  for(const raw of value.match(/https?:\/\/[^\s<>"'`]+/gu)??[]){try{const url=new URL(raw.replace(/[),.;]+$/u,''));if(url.username||url.password||privateHostname(url.hostname)||Array.from(url.searchParams.keys()).some(key=>/password|token|secret|api.?key|auth|session|cookie/iu.test(key))||/(?:password|token|secret|api.?key|auth|session|cookie)[^=]*=/iu.test(url.hash))return false;}catch{return false;}}
  return true;
}
const searchProvider=z.enum(['google','bing','duckduckgo']);
const searchArguments={query:z.string().trim().min(1).max(512),provider:searchProvider.default('google')};
const searchInput=z.object({...searchArguments,query:searchArguments.query.refine(safeSearchQuery,'WORK_SEARCH_CREDENTIAL_OR_PRIVATE_INPUT')}).strict();
const socialSearchInput=z.object({site:z.enum(['x.com','reddit.com','stocktwits.com']),query:z.string().trim().min(1).max(512).refine(safeSearchQuery,'WORK_SEARCH_CREDENTIAL_OR_PRIVATE_INPUT')}).strict();
type SocialSearchRequest=z.infer<typeof socialSearchInput>;
const socialSearchEntries:Record<SocialSearchRequest['site'],string>={'x.com':'https://x.com/search','reddit.com':'https://www.reddit.com/search/','stocktwits.com':'https://stocktwits.com/search'};
function socialSearchEntry(input:SocialSearchRequest){const url=new URL(socialSearchEntries[input.site]);url.searchParams.set('q',input.query);return url.href;}
/** A ticker plus a news/research request is a source cue, not a site grant.
 * Work definition must also remain a research task; generic acronym articles
 * do not silently acquire signed-in social sources. */
function socialIntent(prompt:string,spec:WorkProposal){
  const direct=/\b(?:ticker|stocks?|shares?|equity|market|sentiment|stocktwits|reddit)\b|주식|종목|티커|증시|투자|소셜/iu;
  if(direct.test(prompt))return true;
  const research=/\b(?:news|research|articles?|reports?|updates?)\b|기사|리서치|조사|뉴스|소식|최근/iu;
  const ticker=/\$[A-Z][A-Z0-9.]{0,5}\b|\b(?!AI\b|API\b|LLM\b|CEO\b|URL\b)[A-Z]{2,5}\b/u;
  const defined=[spec.title,spec.desired_outcome,...spec.completion_checks.map(check=>check.result)].join(' ');
  return research.test(prompt)&&ticker.test(prompt)&&research.test(defined)&&(spec.route.kind==='swarm'||spec.route.kind==='pack'&&spec.route.pack_family==='research.search');
}
type SearchRequest=z.infer<typeof searchInput>;
function searchEntry(input:SearchRequest){
  const entry=new URL(({google:'https://www.google.com/search',bing:'https://www.bing.com/search',duckduckgo:'https://duckduckgo.com/'} as const)[input.provider]);
  entry.searchParams.set('q',input.query);
  if(input.provider==='google')entry.searchParams.set('num','10');else if(input.provider==='bing')entry.searchParams.set('count','10');else entry.searchParams.set('ia','web');
  return entry.href;
}
const searchKey=(input:SearchRequest)=>hashJson({provider:input.provider,query:input.query});
/** Classify an already delegated URL; this grants no navigation authority and
 * never rewrites the user's href. Aliases share the same challenge fence. */
function searchFromUrl(raw:string):SearchRequest|null{
  try{
    const url=new URL(raw),host=url.hostname.replace(/^www\./u,''),provider=({ 'google.com':'google','bing.com':'bing','duckduckgo.com':'duckduckgo' } as const)[host as 'google.com'|'bing.com'|'duckduckgo.com'];
    if(!provider||url.protocol!=='https:'||url.port||url.username||url.password)return null;
    if(provider==='duckduckgo'?!/^\/(?:html\/?|lite\/?)?$/u.test(url.pathname):url.pathname!=='/search')return null;
    const input=searchInput.safeParse({provider,query:url.searchParams.get('q')});return input.success?input.data:null;
  }catch{return null;}
}
/** Strong page observations only. No match means unclassified DOM, not proof
 * that results or authentication succeeded. Never solve or route a challenge.
 */
function observedSearchChallenge(input:SearchRequest,page:z.infer<typeof browserObservationSchema>){
  const url=new URL(page.url),entry=new URL(searchEntry(input));if(url.protocol!=='https:'||url.port||url.hostname.replace(/^www\./u,'')!==entry.hostname.replace(/^www\./u,''))return false;
  if(input.provider==='google'&&/^\/sorry(?:\/|$)/u.test(url.pathname))return true;
  if(input.provider==='bing'&&/^\/turing\/(?:captcha|challenge)(?:\/|$)/u.test(url.pathname))return true;
  return /^(?:captcha|human verification|verify (?:you are|that you are) human|access denied)\b/iu.test(page.title.trim())||
    input.provider==='google'&&/our systems have detected unusual traffic from your computer network/iu.test(page.text)||
    input.provider==='duckduckgo'&&/unfortunately, bots use duckduckgo too/iu.test(page.text);
}
const resultInput=z.object({text:z.string().trim().min(1).max(16000),label:z.string().trim().min(1).max(120).optional()}).strict();
const resultReadInput=z.object({request_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u)}).strict();
const sourceIntegritySchema=z.array(z.object({
  source_id:z.string().min(1).max(80),before_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),after_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  before_observed_at:z.string().datetime().nullable(),after_observed_at:z.string().datetime().nullable(),unchanged:z.union([z.boolean(),z.literal('unknown')]),
}).strict()).max(24);
type SourceIntegrity=z.infer<typeof sourceIntegritySchema>;
type FileSnapshot={source_id:string;sha256:string|null;observed_at:string|null};

/** Host executes typed capabilities. Project/source text never becomes shell code. */
export class WorkExecutionTools {
  private browsers=new Map<string,RoutedBrowser>();
  private allowedUrls=new Set<string>();
  private blockedSearches=new Set<string>();
  private recoverableSearches=new Map<string,string>();
  private recoverableSearchOrigins=new Map<string,BrowserPreference>();
  private environmentBlockedQueries=new Set<string>();
  private blockedSocial=new Set<string>();
  private resultReceipts=new Map<string,{tool_name:'office_result_draft'|'runtime_pack_run';value:Record<string,unknown>}>();
  private packIntegrity=new Map<string,{run_id:string;result_sha256:string;sources:SourceIntegrity}>();
  private dispatched=new Map<string,{name:string;input:Record<string,unknown>;coding_stage?:{id:string;attempts:number};reused_coding_run?:string}>();
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly api:RuntimeApi,readonly workId:string,readonly runId:string,readonly spec:WorkProposal,readonly prompt:string,readonly guard:()=>void,readonly model:StructuredModel,readonly options:{browserFactory?:BrowserRouteOptions['factory']}={}){
    for(const raw of prompt.match(/https?:\/\/[^\s<>"'`]+/gu)??[]){try{this.allowedUrls.add(new URL(raw.replace(/[),.;]+$/u,'')).href);}catch{}}
    this.restoreObservedUrls();
  }
  /** Same-run host receipts are evidence, never model-proposed URLs or a grant.
   * Restore only completed, dispatched DOM reads; pending/uncertain receipts,
   * foreign checkpoint identities and credential/private links stay excluded.
   */
  private restoreObservedUrls(){
    if(!this.table('office_supervisor'))return;
    const row=this.store.desktopState.prepare('SELECT checkpoint FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(this.config.project.id,this.workId,this.runId);
    let checkpoint:Record<string,unknown>|null;try{checkpoint=typeof row?.checkpoint==='string'?object(JSON.parse(row.checkpoint)):null;}catch{return;}
    if(checkpoint?.work_id!==this.workId||checkpoint.run_id!==this.runId||!Array.isArray(checkpoint.observations))return;
    const add=(raw:string)=>{try{const parsed=new URL(raw);assertBrowserUrl(raw,[parsed.origin],this.config.environment==='fixture');if(Array.from(parsed.searchParams.keys()).some(key=>/auth|session|cookie/iu.test(key)))return;if(!privateHostname(parsed.hostname)||this.config.environment==='fixture'&&parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1')this.allowedUrls.add(parsed.href);}catch{/* Invalid observation is not new navigation authority. */}};
    for(const raw of checkpoint.observations){const observed=object(raw),invocation=object(observed?.invocation),receipt=object(observed?.receipt),value=object(receipt?.value);
      if(!['office_browser_read','office_web_search','office_social_search'].includes(String(invocation?.tool_name))||invocation?.dispatched!==true||invocation.effect!=='read_only'||!['succeeded','retryable_failure'].includes(String(receipt?.status))||receipt?.effect_state!=='none'||value?.provenance!=='live_browser_dom'||value.effect!=='read_only')continue;
      if(receipt.status==='retryable_failure'&&value.social_access==='not_verified'&&typeof value.social_site==='string'&&Object.hasOwn(knownLoginSites,value.social_site)){this.blockedSocial.add(value.social_site);continue;}
      const parsed=browserObservationSchema.safeParse({url:value.url,title:value.title,text:value.text,links:value.links,observed_at:value.observed_at});if(!parsed.success)continue;
      const input=invocation?.tool_name==='office_web_search'?searchInput.safeParse(invocation.arguments):null;
      const requested=invocation?.tool_name==='office_browser_read'&&typeof object(invocation.arguments)?.url==='string'?String(object(invocation.arguments)!.url):null;
      const search=input?.success?input.data:requested?searchFromUrl(requested):null,entry=input?.success?searchEntry(input.data):requested;
      if(search&&entry&&value.requested_url===entry&&observedSearchChallenge(search,parsed.data)){
        const key=searchKey(search),previous=browserTargets(this.config).find(t=>t.id===value.executor),aside=eligibleBrowserTargets(this.config,{environment:'host_foreground',preferred_engine:'aside'})[0];
        if(unusualSearchTraffic(entry,parsed.data))this.environmentBlockedQueries.add(search.query);
        const explicitAside=this.spec.browser?.environment==='host_foreground'&&this.spec.browser.preferred_engine==='aside';
        if(!this.blockedSearches.has(key)&&aside&&previous&&previous.engine==='playwright'&&['owned_headless','ubuntu_vm'].includes(previous.environment)&&(publicBrowserRecovery(this.spec.browser).length||explicitAside)&&unusualSearchTraffic(entry,parsed.data)){
          this.recoverableSearches.set(key,aside.id);this.recoverableSearchOrigins.set(key,{environment:previous.environment});
        }else {this.blockedSearches.add(key);this.recoverableSearches.delete(key);this.recoverableSearchOrigins.delete(key);}
        this.allowedUrls.delete(new URL(entry).href);this.allowedUrls.delete(new URL(parsed.data.url).href);continue;
      }
      if(receipt.status!=='succeeded')continue;
      add(parsed.data.url);for(const link of parsed.data.links)add(link.url);
    }
  }
  catalog():WorkClientTool[]{
    const coding=this.spec.route.kind==='pack'&&this.spec.route.pack_family==='coding.orchestrate';
    const names=Object.keys(effects).filter(name=>!name.startsWith('office_')&&(!name.startsWith('runtime_coding_')||name==='runtime_coding_projects'||coding)) as ExecutionToolName[];
    const descriptors=names.flatMap(name=>{const tool=(tools as Record<string,{schema:z.ZodType;implemented:boolean;readOnly:boolean}>)[name];if(!tool?.implemented)return [];
      return [{name,description:`Agent Office ${name}. Scope: this Work only. ${name==='runtime_pack_catalog'?'Its models field is the optional Pack semantic/Jev policy. models=off does not disable the configured Work LLM or office_web_search; use the capabilities supplied in this Work instead of inferring missing configuration. ':''}${name==='runtime_files_roots'?'Only folders explicitly granted to this Work are returned. ':''}${name==='runtime_files_request'?'Creates a permission request, never grants access. ':''}${name==='runtime_files_propose'?'Creates a move preview, never moves files. ':''}${name==='runtime_pack_execute_approved'?'Requires an existing human-approved, unconsumed proposal; cannot approve it. ':''}${name==='runtime_windows_step'?'May change an application or send externally; native host approval and postcondition receipts are mandatory. ':''}${name==='runtime_coding_start'?'Choose one registered project_ref. Creates a bounded Codex/Claude CLI stage plan and local Git handoff for this Work. The host supplies Work/request identity. Reuses this Work existing coding run; never resumes an unrelated session. Model-data consent and registered project policy remain mandatory. ':''}${name==='runtime_coding_step'?'Send only the next prepared stage instruction to the configured Codex/Claude CLI, read its actual response, and verify its Git/check receipts. Only same-run saved CLI session IDs may resume; no --last. Repository writes require this Work write delegation and registered policy. Imported plans/stages retain human approval. ':''}${name==='runtime_coding_status'?'Read actual stage progress, exact CLI replies and verification receipts of this Work coding run; completed stages are not proof of whole Work completion. ':''}${name==='runtime_coding_reconcile'?'Inspect uncertain coding effects without replay or automatic acceptance; report required user review. ':''}Only configured executors and approved connections can run. Unknown effects are fenced, not replayed.`,input_schema:z.toJSONSchema(tool.schema),effect:effects[name]}];});
    descriptors.push({name:'office_browser_read',description:'Open and read a URL explicitly supplied by the user, or a link in an already observed page. Returns live text, links, timestamp and executor. Read-only; never submits or signs in. Independent same-environment executor fallback is automatic.',input_schema:z.toJSONSchema(z.object({url:z.string().url().max(4096)}).strict()),effect:'read_only'});
    descriptors.push({name:'office_web_search',description:'Search the public web when the user supplied a topic but no source URL. Choose google (default), bing or duckduckgo; the host constructs its fixed public search URL from query text (maximum 512 characters). Returns actual DOM text and observed links only, with timestamps and executor; no generated search results. For observed Google unusual traffic in headless or the managed Playwright guest, the host hands the identical Google query directly to registered Aside once, skipping the guest retry. Never replace that query with Bing or DuckDuckGo. If environment_block=true is returned, follow next_action for Aside connection or user confirmation; no repeat or profile cycling. For another public-provider challenge, an independent source within scope may be used. Never solve CAPTCHA, sign in or bypass access controls. Credentials and private-host query URLs are rejected. Follow only actually observed links. Pack models=off does not disable this tool or the configured Work LLM.',input_schema:z.toJSONSchema(z.object(searchArguments).strict(),{io:'input'}),effect:'read_only'});
    const socialSites=this.socialSites();
    if(socialSites.length)descriptors.push({name:'office_social_search',description:`Read current ticker/social discussion from one historically ready, registered browser profile only. Offered sites: ${socialSites.join(', ')}. The host constructs a bounded search entry URL, reobserves the live page and checks the signed-in marker. A prior ready observation is not proof of current access or of source quality. No cross-profile fallback, login, challenge bypass, post or message. Use actual DOM URLs/timestamps as unverified source observations, not as verified news claims.`,input_schema:z.toJSONSchema(socialSearchInput,{io:'input'}),effect:'read_only'});
    descriptors.push({name:'office_browser_links',description:'List a bounded page of exact user-supplied and observed URLs plus configured browser environments. Defaults: offset=0, limit=20 (maximum 40); byte limits may return fewer complete URLs. If has_more, request next_offset with the returned snapshot_id. A changed snapshot requires restarting at offset=0. Never infer an omitted or unobserved URL; this tool does not open pages or grant access.',input_schema:z.toJSONSchema(browserLinksInput,{io:'input'}),effect:'read_only'});
    descriptors.push({name:'office_result_draft',description:'Save the Work result/report for the user in this Office. Write the requested final text using observed source evidence and requested language/format, without invented facts. The host independently rereads the file and verifies exact bytes and SHA-256 before issuing a verified receipt. Returns text, artifact metadata and request_id. Use office_result_read with that request_id if additional readback is required; runtime_files_report is for user folders, not Office results. Creates only an Office-owned file, never sends a message or changes an external service.',input_schema:z.toJSONSchema(resultInput),effect:'local_write'});
    descriptors.push({name:'office_result_read',description:'Read the actual text of an Office-created output using the exact host invocation request_id from a successful verified office_result_draft or runtime_pack_run receipt, not an ID proposed in tool arguments. Supports local TXT/JSON/CSV artifacts up to 16KB. Rechecks bytes and SHA-256; Pack outputs also require a task-free successful run bound to this Work. Only current Work/run receipts may be read, including persisted receipts after resume. A known failed source-quality output is not readable: correct its grounded recipe and obtain a successful verified receipt first. Arbitrary paths, binary files and other Work files are unavailable. Use this tool to inspect saved Pack rows before computing or summarizing them.',input_schema:z.toJSONSchema(resultReadInput),effect:'read_only'});
    return descriptors;
  }
  private table(name:string){return Boolean(this.store.desktopState.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
  private fileRecord(kind:string,id:string){
    requireCondition(this.table('file_explorer_record'),'WORK_TOOL_FILE_SCOPE_MISMATCH');
    const row=this.store.desktopState.prepare('SELECT body FROM file_explorer_record WHERE project=? AND kind=? AND id=?').get(this.config.project.id,kind,id);
    requireCondition(row,'WORK_TOOL_FILE_SCOPE_MISMATCH');return object(JSON.parse(String(row.body)))!;
  }
  private folderGranted(rootId:string){
    return this.table('file_explorer_record')&&Boolean(this.store.desktopState.prepare("SELECT 1 FROM file_explorer_record a JOIN file_explorer_record r ON r.project=a.project AND r.kind='root' AND r.id=json_extract(a.body,'$.root_id') WHERE a.project=? AND a.kind='access' AND json_extract(a.body,'$.work_id')=? AND r.id=? LIMIT 1").get(this.config.project.id,this.workId,rootId));
  }
  private ownScan(scanId:string){
    const scan=this.fileRecord('scan',scanId),rootId=String(scan.root_id);
    requireCondition(this.folderGranted(rootId)&&Boolean(this.store.desktopState.prepare("SELECT 1 FROM file_explorer_record WHERE project=? AND kind='observation' AND json_extract(body,'$.work_id')=? AND json_extract(body,'$.scan_id')=? LIMIT 1").get(this.config.project.id,this.workId,scanId)),'WORK_TOOL_FILE_SCOPE_MISMATCH');return scan;
  }
  private ownWindows(runId:string){
    requireCondition(this.table('windows_workflow_run'),'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const row=this.store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE project_id=? AND work_id=? AND id=?').get(this.config.project.id,this.workId,runId);
    requireCondition(row,'WORK_TOOL_RUN_SCOPE_MISMATCH');return object(JSON.parse(String(row.body)))!;
  }
  private ownPack(runId:string){
    requireCondition(this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_kind==='pack'&&r.source_id===runId),'WORK_TOOL_RUN_SCOPE_MISMATCH');return this.store.packRun(this.config.project.id,runId);
  }
  private ownCoding(runId:string){
    requireCondition(this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_kind==='coding'&&r.source_id===runId),'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const run=this.store.codingRun(this.config.project.id,runId);requireCondition(run.work_id===this.workId,'WORK_TOOL_RUN_SCOPE_MISMATCH');return run;
  }
  private codingApproval(runId?:string,projectRef?:string){
    if(this.store.workImportForWork(this.config.project.id,this.workId)?.kind!=='project')return true;
    const row=this.store.desktopState.prepare('SELECT * FROM office_import_coding_approval WHERE project_id=? AND work_id=?').get(this.config.project.id,this.workId);
    if(!runId)return Boolean(row&&row.project_ref===projectRef&&row.plan_approved_at);
    const run=this.ownCoding(runId),stage=this.store.codingStages(this.config.project.id,runId).find(item=>item.status==='pending');
    return Boolean(row&&stage&&row.project_ref===run.project_ref&&row.stage_run_id===runId&&row.stage_id===stage.stage_id&&row.stage_revision===run.revision&&row.stage_approved_at);
  }
  private async codingGitVerified(runId:string){
    const run=this.ownCoding(runId),project=this.config.coding?.projects.find(item=>item.id===run.project_ref),expected=this.store.codingCheckpoint(this.config.project.id,runId);
    requireCondition(project&&expected&&run.project_root===project.root&&run.config_fingerprint===this.config.fingerprint&&await realpath(project.root)===project.root,'WORK_CODING_CHECKPOINT_SCOPE_MISMATCH');
    const observed=await readLocalGitCheckpoint(project.root,async(root,args,timeout_ms)=>{const result=await nativeProcessRunner.run({executable:process.platform==='win32'?'git.exe':'/usr/bin/git',args:['-C',root,...args],cwd:root,timeout_ms:timeout_ms??10_000});requireCondition(result.code===0,'WORK_CODING_GIT_CHECK_FAILED');return result.stdout;});
    return expected.head===observed.head&&expected.state_sha256===observed.state_sha256;
  }
  private resultPath(requestId:string){
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.workId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.runId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId),'WORK_RESULT_ID_INVALID');
    return join(dirname(this.config.dbPath),'work-artifacts',this.workId,this.runId,`report-${hashJson(requestId).slice(0,32)}.txt`);
  }
  /** A Work already has a family and the typed tool catalog in its context.
   * Preserve authoritative plan/connection fields; reference only duplicated
   * descriptions rather than embedding every family/schema/example again.
   * The public MCP Pack planning response is unchanged.
   */
  private packPlanView(value:unknown):unknown{
    const data=object(value);if(!data||this.spec.route.kind!=='pack'||!this.spec.route.pack_family)return value;
    const family=this.spec.route.pack_family;
    if(data.requested_family!==undefined)requireCondition(data.requested_family===family,'WORK_TOOL_PACK_FAMILY_MISMATCH');
    const view:Record<string,unknown>={...data,plan_view:{kind:'work_family',family,work_id:this.workId,run_id:this.runId,unscoped_sha256:hashJson(data),unscoped_bytes:Buffer.byteLength(JSON.stringify(data))}};
    const supplied=object(data.recipe_schema);
    if(supplied){
      const advertised=object(object(this.catalog().find(tool=>tool.name==='runtime_pack_run')?.input_schema.properties)?.recipe);
      const equivalent={...supplied};delete equivalent.$schema;
      requireCondition(advertised&&hashJson(equivalent)===hashJson(advertised),'WORK_TOOL_PLAN_SCHEMA_MISMATCH');
      view.recipe_schema={catalog_tool:'runtime_pack_run',input_schema_pointer:'/properties/recipe',sha256:hashJson(advertised),bytes:Buffer.byteLength(JSON.stringify(advertised)),response_sha256:hashJson(supplied),response_bytes:Buffer.byteLength(JSON.stringify(supplied)),reuse:'Use this exact recipe schema from the supplied tool catalog; no schema or permission was relaxed.'};
    }
    if(Array.isArray(data.families)){
      view.families=data.families.filter(item=>object(item)?.id===family);
      view.families_catalog_ref={catalog_tool:'runtime_pack_catalog',pointer:'/families',ids:data.families.flatMap(item=>typeof object(item)?.id==='string'?[object(item)!.id]:[]),sha256:hashJson(data.families),bytes:Buffer.byteLength(JSON.stringify(data.families))};
    }
    if(Array.isArray(data.windows_profiles))view.windows_profiles={catalog_tool:'runtime_windows_catalog',pointer:'/profiles',projection:['id','title','family','example'],ids:data.windows_profiles.flatMap(item=>typeof object(item)?.id==='string'?[object(item)!.id]:[]),sha256:hashJson(data.windows_profiles),bytes:Buffer.byteLength(JSON.stringify(data.windows_profiles)),reuse:'Optional examples are available from the catalog; they are not an allowlist or execution authority.'};
    return view;
  }
  private resultObservations():unknown[]{
    if(!this.table('office_supervisor'))return [];
    const row=this.store.desktopState.prepare('SELECT checkpoint FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(this.config.project.id,this.workId,this.runId);
    const checkpoint=row?.checkpoint?object(JSON.parse(String(row.checkpoint))):null;
    return Array.isArray(checkpoint?.observations)?checkpoint.observations:[];
  }
  private async fileSnapshots(recipe:Record<string,unknown>):Promise<FileSnapshot[]>{
    const requested=Array.isArray(recipe.sources)?recipe.sources:[],ids=[...new Set(requested.flatMap(item=>typeof object(item)?.id==='string'?[String(object(item)!.id)]:[]))];
    const snapshots:FileSnapshot[]=[];
    for(const id of ids){
      const source=this.config.packs?.sources.find(item=>item.id===id);if(source?.kind!=='file')continue;
      // Registered source policy and the same no-follow, size and concurrent-
      // change checks as the Pack reader apply. Never return source contents.
      try{const bytes=await readScopedFile(source.path);snapshots.push({source_id:id,sha256:sha(bytes),observed_at:new Date().toISOString()});}
      catch{snapshots.push({source_id:id,sha256:null,observed_at:null});}
    }
    return snapshots;
  }
  private trustedSourceIntegrity(data:Record<string,unknown>,requestId:string|undefined):SourceIntegrity|null{
    if(!requestId||typeof data.run_id!=='string')return null;
    try{
      const run=this.ownPack(data.run_id);
      if(run.request_id!==requestId||run.status!==data.status||hashJson(run.result)!==hashJson(data.result))return null;
      const memory=this.packIntegrity.get(requestId);let raw:unknown=null;
      if(memory?.run_id===run.id&&memory.result_sha256===hashJson(run.result))raw=memory.sources;
      else{
        const saved=this.resultObservations().find(item=>{const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt),value=object(receipt?.value);return invocation?.tool_name==='runtime_pack_run'&&invocation.request_id===requestId&&receipt?.effect_state==='verified'&&['succeeded','retryable_failure'].includes(String(receipt.status))&&value?.run_id===run.id&&hashJson(value.result)===hashJson(run.result);});
        raw=object(object(object(saved)?.receipt)?.value)?.source_integrity??null;
      }
      const parsed=sourceIntegritySchema.safeParse(raw);if(!parsed.success||!parsed.data.length)return null;
      const requested=object(run.recipe)?.sources,ids=Array.isArray(requested)?requested.flatMap(item=>typeof object(item)?.id==='string'?[String(object(item)!.id)]:[]):[];
      const fileIds=[...new Set(ids.filter(id=>this.config.packs?.sources.some(source=>source.id===id&&source.kind==='file')))];
      if(parsed.data.length!==fileIds.length||new Set(parsed.data.map(item=>item.source_id)).size!==fileIds.length||parsed.data.some(item=>!fileIds.includes(item.source_id)||item.unchanged!==(item.before_sha256&&item.after_sha256?item.before_sha256===item.after_sha256:'unknown')||Boolean(item.before_sha256)!==Boolean(item.before_observed_at)||Boolean(item.after_sha256)!==Boolean(item.after_observed_at)))return null;
      return structuredClone(parsed.data);
    }catch{return null;}
  }
  /** A rejected quality read may be corrected, but never grants result access.
   * Only a known invocation of this exact Work/run can supply this feedback.
   * Recheck its durable Pack ownership, canonical request ID, result and bytes.
   */
  private async validateResultRead(args:Record<string,unknown>){
    const input=resultReadInput.parse(args),observations=this.resultObservations();
    if(this.resultReceipts.has(input.request_id)||observations.some(item=>{const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt);return invocation?.request_id===input.request_id&&receipt?.status==='succeeded'&&receipt.effect_state==='verified';}))return input;
    const candidates=observations.filter(item=>{
      const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt),correction=object(object(receipt?.value)?.correction);
      // A persisted model alias only selects feedback, never a file or a grant.
      return invocation?.tool_name==='runtime_pack_run'&&invocation.dispatched===true&&(invocation.request_id===input.request_id||object(invocation.arguments)?.request_id===input.request_id)&&receipt?.status==='retryable_failure'&&receipt.effect_state!=='uncertain'&&correction?.kind==='data_quality';
    });
    if(candidates.length!==1)return input;
    const record=object(candidates[0])!,invocation=object(record.invocation)!,receipt=object(record.receipt)!,value=object(receipt.value),canonical=invocation.request_id;
    if(!value||typeof value.run_id!=='string'||typeof canonical!=='string')return input;
    const run=this.ownPack(value.run_id);
    requireCondition(run.request_id===canonical,'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const current=await this.receipt('runtime_pack_run',value,canonical),correction=object(object(current.value)?.correction);
    if(current.status==='retryable_failure'&&current.effect_state!=='uncertain'&&correction?.kind==='data_quality'){
      throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED',`No result was read. This Pack output failed source-quality checks; its host request_id is ${canonical}. Correct only grounded recipe fields using the preserved verification receipts, then obtain a successful verified Pack receipt before office_result_read. Do not weaken checks or treat rejected data as completed.`);
    }
    return input;
  }
  private normalizedInput(name:string,args:Record<string,unknown>,requestId:string){
    const input={...args};
    if('work_id' in input)requireCondition(input.work_id===this.workId,'WORK_TOOL_SCOPE_MISMATCH');
    if(injectWork.has(name))input.work_id=this.workId;
    if(name==='runtime_pack_run'||name==='runtime_windows_start'||name==='runtime_coding_start')input.request_id=requestId;
    if(name==='runtime_work_context'&&typeof input.run_id==='string'){
      requireCondition(input.run_id===this.runId||this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_id===input.run_id),'WORK_TOOL_RUN_SCOPE_MISMATCH');
      if(input.run_id===this.runId)delete input.run_id;
    }
    return input;
  }
  /** Pre-dispatch schema checking: no API, grants, model calls or filesystem effects. */
  private searchRequest(raw:unknown){const input=searchInput.parse(raw);if(this.environmentBlockedQueries.has(input.query)&&input.provider!=='google')throw new WorkClientToolInputError('WORK_SEARCH_ENVIRONMENT_BLOCKED','Unusual traffic is an environment block. Keep the same provider and use the registered Aside recovery, or request Aside connection/user confirmation. Do not substitute Bing or DuckDuckGo.');if(this.blockedSearches.has(searchKey(input)))throw new WorkClientToolInputError('WORK_SEARCH_PROVIDER_BLOCKED','This provider returned an observed access challenge for the same query. If environment_block is true, request the indicated Aside connection or user confirmation; do not substitute the provider. Otherwise another independent source within the user scope may be used. Never repeat or bypass a challenge.');return input;}
  private socialSites(){return socialIntent(this.prompt,this.spec)?(Object.keys(knownLoginSites) as SocialSearchRequest['site'][]).filter(site=>this.socialTarget(site)!==null):[];}
  private socialTarget(site:SocialSearchRequest['site']):BrowserTarget|null{
    if(this.blockedSocial.has(site))return null;
    const preference=this.spec.browser;
    // A public-search placement does not force its optional social sources into
    // that headless profile. Prefer the user's connected Aside profile; a
    // named engine/foreground/guest preference still constrains selection.
    const publicDefault=preference?.environment==='owned_headless'&&!preference.preferred_engine;
    return readyAuthTargets(this.store,this.config,site).filter(target=>browserHostCompatible(target)&&(!preference||publicDefault||target.environment===preference.environment)&&(!preference?.preferred_engine||target.engine===preference.preferred_engine)).sort((a,b)=>Number(b.engine==='aside'&&b.environment==='host_foreground')-Number(a.engine==='aside'&&a.environment==='host_foreground')||b.priority-a.priority||a.id.localeCompare(b.id))[0]??null;
  }
  private socialRequest(raw:unknown){const input=socialSearchInput.parse(raw);requireCondition(socialIntent(this.prompt,this.spec)&&this.socialTarget(input.site),'WORK_SOCIAL_PROFILE_NOT_READY');return input;}
  private browserRequest(raw:unknown){const input=browserInput.parse(raw),search=searchFromUrl(input.url);if(search)this.searchRequest(search);return input;}
  private browserLinksPage(raw:unknown){
    const input=browserLinksInput.parse(raw),urls=[...this.allowedUrls].filter(url=>{const search=searchFromUrl(url);return !search||!this.blockedSearches.has(searchKey(search));}),executors=browserCatalog(this.config),snapshot_id=hashJson({urls,executors});
    if(input.snapshot_id&&input.snapshot_id!==snapshot_id)throw new WorkClientToolInputError('WORK_BROWSER_LINKS_SNAPSHOT_CHANGED','The observed URL list changed. Restart at offset=0, then use the returned snapshot_id with next_offset. No page was opened.');
    const page={urls:[] as string[],executors,total_urls:urls.length,offset:input.offset,next_offset:null as number|null,has_more:false,snapshot_id};
    // Preserve each href verbatim. Pagination happens BEFORE generic tool-value
    // compaction so it can never truncate URLs into different navigation targets.
    for(const url of urls.slice(input.offset,input.offset+input.limit)){
      const next=[...page.urls,url],nextOffset=input.offset+next.length,hasMore=nextOffset<urls.length;
      if(Buffer.byteLength(JSON.stringify(next))>10000||Buffer.byteLength(JSON.stringify({...page,urls:next,next_offset:hasMore?nextOffset:null,has_more:hasMore}))>15000){
        if(!page.urls.length)throw new WorkClientToolInputError('WORK_BROWSER_LINKS_VALUE_TOO_LARGE','One observed URL exceeds this tool response budget. It was not truncated or opened. Choose another exact observed source.');
        break;
      }
      page.urls=next;
    }
    const nextOffset=input.offset+page.urls.length;page.has_more=nextOffset<urls.length;page.next_offset=page.has_more?nextOffset:null;
    return page;
  }
  validate(name:string,args:Record<string,unknown>,requestId:string){
    requireCondition(this.catalog().some(t=>t.name===name),'WORK_TOOL_NOT_AVAILABLE');
    if(name==='office_browser_read')return this.browserRequest(args);
    if(name==='office_web_search')return this.searchRequest(args);
    if(name==='office_social_search')return this.socialRequest(args);
    if(name==='office_browser_links'){this.browserLinksPage(args);return browserLinksInput.parse(args);}
    if(name==='office_result_draft')return resultInput.parse(args);
    if(name==='office_result_read')return this.validateResultRead(args);
    const input=(tools as Record<string,{schema:z.ZodType}>)[name]!.schema.parse(this.normalizedInput(name,args,requestId)) as Record<string,unknown>;
    if(name==='runtime_pack_run'){
      const policy=this.config.packs,recipe=object(input.recipe)!;
      if(!policy)throw new WorkClientToolInputError('WORK_PACK_CONNECTION_REQUIRED','No Pack source/target policy is connected. Nothing was executed. For public research use office_web_search, office_browser_read and office_result_draft; do not invent registered sources.');
      if(this.spec.route.kind!=='pack'||recipe.family!==this.spec.route.pack_family)throw new WorkClientToolInputError('WORK_TOOL_PACK_FAMILY_MISMATCH','The recipe must use the family already selected for this Work. Nothing was executed.');
      if(Array.isArray(recipe.sources)&&recipe.sources.some(source=>!policy.sources.some(registered=>registered.id===object(source)?.id)))throw new WorkClientToolInputError('WORK_PACK_SOURCE_NOT_CONNECTED','Choose only a source ID returned by runtime_pack_plan. For unregistered public URLs use the office browser tools. Nothing was executed.');
      if(typeof recipe.target==='string'&&!policy.targets.some(target=>target.id===recipe.target&&target.family===recipe.family))throw new WorkClientToolInputError('WORK_PACK_TARGET_NOT_CONNECTED','The target must already be registered for this recipe family. Nothing was executed.');
    }
    return input;
  }
  async execute(name:string,args:Record<string,unknown>,requestId:string){
    this.guard();this.store.intakeWork(this.config.project.id,this.workId);
    if(name==='office_browser_links')return this.browserLinksPage(args);
    if(name==='office_result_read'){
      const {request_id}=resultReadInput.parse(args);let source=this.resultReceipts.get(request_id);
      if(!source){
        const item=this.resultObservations().find(value=>{const record=object(value),invocation=object(record?.invocation),receipt=object(record?.receipt);return (invocation?.tool_name==='office_result_draft'||invocation?.tool_name==='runtime_pack_run')&&invocation.request_id===request_id&&receipt?.status==='succeeded'&&receipt.effect_state==='verified';});
        const found=object(item),invocation=object(found?.invocation),value=object(object(found?.receipt)?.value);
        if(value&&invocation)source={tool_name:invocation.tool_name as 'office_result_draft'|'runtime_pack_run',value};
      }
      requireCondition(source,'WORK_RESULT_RECEIPT_NOT_FOUND');const value=source.value;
      let artifact:Record<string,unknown>|null,path:string,sourceRunId:string|null=null;
      if(source.tool_name==='office_result_draft'){
        artifact=object(value.artifact);path=this.resultPath(request_id);
        requireCondition(value.work_id===this.workId&&value.run_id===this.runId&&artifact?.path===path,'WORK_RESULT_RECEIPT_NOT_FOUND');
      }else{
        requireCondition(value.status==='succeeded'&&value.task_id===null&&typeof value.run_id==='string','WORK_RESULT_RECEIPT_NOT_FOUND');
        const run=this.ownPack(value.run_id);requireCondition(run.status==='succeeded'&&run.task_id===null&&hashJson(run.result)===hashJson(value.result),'WORK_RESULT_RECEIPT_NOT_FOUND');
        artifact=object(object(run.result)?.artifact);requireCondition(typeof artifact?.path==='string'&&resolve(dirname(artifact.path))===resolve(join(dirname(this.config.dbPath),'pack-artifacts')),'WORK_ARTIFACT_SCOPE_MISMATCH');
        path=artifact.path;sourceRunId=run.id;
      }
      requireCondition(artifact&&['txt','json','csv'].includes(String(artifact.format)),'WORK_RESULT_UNSUPPORTED_FORMAT');
      requireCondition(Number.isInteger(artifact.bytes)&&Number(artifact.bytes)<=16000&&Number(artifact.bytes)>=0&&(await stat(path)).size<=16000,'WORK_RESULT_READBACK_TOO_LARGE');
      const bytes=await readScopedFile(path);requireCondition(sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes,'WORK_RESULT_READBACK_MISMATCH');
      requireCondition(!bytes.includes(0),'WORK_RESULT_UNSUPPORTED_FORMAT');let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('WORK_RESULT_UNSUPPORTED_FORMAT');}
      return {status:'succeeded',work_id:this.workId,run_id:this.runId,request_id,source_tool:source.tool_name,source_run_id:sourceRunId,title:value.title??this.spec.title,text:source.tool_name==='office_result_draft'?text.replace(/\n$/u,''):text,artifact,verified_by:'independent_sha256_and_bytes_readback',external_delivery:false};
    }
    if(name==='office_result_draft'){
      const input=resultInput.parse(args),path=this.resultPath(requestId),root=join(dirname(this.config.dbPath),'work-artifacts'),directory=dirname(path),bytes=Buffer.from(input.text+'\n','utf8');
      for(const part of [root,join(root,this.workId),directory]){await mkdir(part,{recursive:true,mode:0o700});requireCondition(await realpath(part)===resolve(part),'WORK_ARTIFACT_SCOPE_MISMATCH');}
      let deduplicated=false;
      try{const handle=await open(path,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;deduplicated=true;}
      const saved=await readScopedFile(path);requireCondition(saved.equals(bytes),'WORK_RESULT_REQUEST_ID_CONFLICT');
      workActivity(this.store,this.config.project.id,this.workId,'result.saved',`Result saved: ${input.label??this.spec.title} · ${saved.length} bytes`);
      return {status:'succeeded',work_id:this.workId,run_id:this.runId,request_id:requestId,title:input.label??this.spec.title,text:input.text,artifact:{path,sha256:sha(saved),bytes:saved.length,format:'txt'},deduplicated,external_delivery:false};
    }
    if(name==='office_browser_read'||name==='office_web_search'||name==='office_social_search'){
      const explicit=name==='office_browser_read'?this.browserRequest(args):null,social=name==='office_social_search'?this.socialRequest(args):null,search=name==='office_web_search'?this.searchRequest(args):explicit?searchFromUrl(explicit.url):null,url=explicit?explicit.url:social?socialSearchEntry(social):searchEntry(search!);
      if(search)workActivity(this.store,this.config.project.id,this.workId,'search.started','Searching the public web through the configured browser executor.',{tool_name:name,status:'running'});
      const parsed=new URL(url);
      requireCondition(name==='office_web_search'||name==='office_social_search'||this.allowedUrls.has(parsed.href),'BROWSER_URL_NOT_OBSERVED');
      assertBrowserUrl(url,[parsed.origin],this.config.environment==='fixture');
      const origin=parsed.origin,journal=this.store.browserExecutors();
      const socialSite=(social?.site??(Object.hasOwn(knownLoginSites,parsed.hostname.toLowerCase().replace(/^www\./u,''))?parsed.hostname.toLowerCase().replace(/^www\./u,'') as SocialSearchRequest['site']:null));
      const authTarget=socialSite?this.socialTarget(socialSite):null;
      if(socialSite)requireCondition(authTarget,'WORK_SOCIAL_PROFILE_NOT_READY');
      const preference=authTarget?{environment:authTarget.environment,preferred_engine:authTarget.engine}:this.spec.browser??{environment:'owned_headless' as const};
      const recoveryKey=search?searchKey(search):null,explicitAside=!authTarget&&preference.environment==='host_foreground'&&preference.preferred_engine==='aside',explicitAsideRecovery=explicitAside&&Boolean(recoveryKey&&this.recoverableSearches.has(recoveryKey));
      const key=authTarget?`${origin}:${authTarget.id}`:origin,legacyKey=`work:${this.runId}:${origin}`,originalCheckpointKey=`${legacyKey}:${hashJson({entry_url:url})}`,checkpointKey=`${legacyKey}:${hashJson(authTarget?{entry_url:url,profile:authTarget.id}:explicitAside?{entry_url:url,recovery:preference}:{entry_url:url})}`;
      // A broken read-only browser transport may move to another registered
      // environment. Login/challenge pages never take this route: each profile
      // has independent authentication and a site's access decision is final.
      const socialLogin=Boolean(socialSite);
      // These three capabilities only read. A Work that also saves its report
      // locally still gets the same safe read recovery; its write capabilities
      // retain their independent delegation, approval and uncertainty fences.
      const fallback_preferences=!socialLogin?publicBrowserRecovery(preference):[];
      let browser=this.browsers.get(key);
      if(!browser){
        const routeConfig=authTarget?{...this.config,browserExecutors:{targets:[authTarget]}}:this.config;
        browser=new RoutedBrowser(routeConfig,{profile_key:`work-${this.workId}`,context_id:this.runId,request:this.prompt,preference,fallback_preferences,...(!explicitAsideRecovery&&search&&this.recoverableSearches.has(searchKey(search))?{recover_from_unusual_traffic:this.recoverableSearches.get(searchKey(search))}:{}),ephemeral:true,restore_navigation:'entry_url',guard:this.guard,providers:{llm:this.model},...(this.options.browserFactory?{factory:this.options.browserFactory}:{}),checkpoint:{load:()=>{
          // A user revision may explicitly select the one permitted recovery
          // destination. Keep the old read-only checkpoint intact and validate
          // its original authority/effect fence before starting that new scope.
          const exact=journal.checkpoint(this.config.project.id,checkpointKey);
          if(explicitAside){
            const prior=journal.checkpoint(this.config.project.id,originalCheckpointKey)??journal.checkpoint(this.config.project.id,legacyKey);
            if(prior){
              if(explicitAsideRecovery||!exact){
                let originalPreference=explicitAsideRecovery?this.recoverableSearchOrigins.get(recoveryKey!):preference;
                // Historical plans sometimes pinned Playwright explicitly. Match
                // its exact binding, without relaxing request/config/effect fences.
                if(explicitAsideRecovery&&originalPreference){
                  const pinned={...originalPreference,preferred_engine:'playwright' as const};
                  if(prior.binding===browserCheckpointBinding(this.config,{preference:pinned,request:this.prompt}))originalPreference=pinned;
                }
                validateBrowserCheckpoint(this.config,{preference:originalPreference,request:this.prompt},[origin],prior);
              }
              else{
                // The current bound checkpoint outlives the bounded Work trace.
                // Never restore the obsolete cursor or ignore its effect fence.
                requireCondition(prior.version===1,'BROWSER_CHECKPOINT_BINDING_CHANGED');requireCondition(prior.effect_state==='none','BROWSER_RECONCILIATION_REQUIRED');
                assertBrowserUrl(prior.entry_url,[origin],this.config.environment==='fixture');assertBrowserUrl(prior.url,[origin],this.config.environment==='fixture');
              }
            }
          }
          if(exact)return exact;
          if(authTarget||explicitAside)return null;
          const legacy=journal.checkpoint(this.config.project.id,legacyKey);if(!legacy)return null;
          validateBrowserCheckpoint(this.config,{preference,request:this.prompt},[origin],legacy);
          // Keep the legacy bytes intact. Different entry URLs start a fresh
          // read; matching entries restore bindings without opening saved.url.
          return legacy.entry_url===url?legacy:null;
        },save:cp=>journal.saveCheckpoint(this.config.project.id,checkpointKey,cp)},event:event=>{journal.append(this.config.project.id,this.runId,event);workActivity(this.store,this.config.project.id,this.workId,`browser.${event.kind}`,`${event.engine} / ${event.environment}${event.from?' ← '+event.from:''}${event.reason?' · '+event.reason:''}`,{status:event.kind,executor:event.target_id,engine:event.engine,environment:event.environment,...(event.reason?{reason:event.reason}:{})});}},[origin]);
        try{await browser.open(url);this.browsers.set(key,browser);}catch(error){await browser.close();throw error;}
      }else await browser.navigate(url);
      const observed=browserObservationSchema.parse(await browser.observe());this.guard();assertBrowserUrl(observed.url,[origin],this.config.environment==='fixture');
      if(socialSite){
        const known=knownLoginSites[socialSite],gate=detectAuthGate(observed.url,observed.title,observed.text);
        const signedIn=!gate&&await browser.extract({ready:known.signed_in,auth_gate:'input[type="password"]',auth_required:false,account_selector:'',account_text:'',rows:known.signed_in,columns:{},max_rows:1}).then(rows=>rows.length>0).catch(()=>false);
        this.guard();
        if(!signedIn){
          this.blockedSocial.add(socialSite);
          workActivity(this.store,this.config.project.id,this.workId,'search.blocked','The registered social browser did not show a current signed-in page. No other profile was tried.',{tool_name:name,status:'retryable_failure',reason:gate==='challenge'?'WORK_SOCIAL_CHALLENGE':'WORK_SOCIAL_AUTH_NOT_VERIFIED',...(browser.target?{executor:browser.target.id,engine:browser.target.engine,environment:browser.target.environment}:{})});
          return {status:'retryable_failure',reason:gate==='challenge'?'WORK_SOCIAL_CHALLENGE':gate==='login_limited'?'WORK_SOCIAL_LOGIN_LIMITED':'WORK_SOCIAL_AUTH_NOT_VERIFIED',requested_url:url,observed_at:observed.observed_at,social_site:socialSite,provenance:'live_browser_dom',executor:browser.target?.id,effect:'read_only',social_access:'not_verified',text:'',links:[]};
        }
      }
      const links=observed.links.filter(link=>{try{const next=new URL(link.url);return !next.username&&!next.password&&!Array.from(next.searchParams.keys()).some(k=>/token|password|secret|api.?key|auth|session|cookie/iu.test(k));}catch{return false;}});
      if(search&&observedSearchChallenge(search,observed)){
        this.blockedSearches.add(searchKey(search));
        if(unusualSearchTraffic(url,observed))this.environmentBlockedQueries.add(search.query);
        this.allowedUrls.delete(url);this.allowedUrls.delete(new URL(observed.url).href);
        workActivity(this.store,this.config.project.id,this.workId,'search.blocked','The public search provider returned an observed access challenge. No login, challenge bypass or browser replay was attempted.',{tool_name:name,status:'retryable_failure',reason:'WORK_SEARCH_PROVIDER_CHALLENGE',...(browser.target?{executor:browser.target.id,engine:browser.target.engine,environment:browser.target.environment}:{}),source:{url:safeControlText(observed.url,2048),title:safeControlText(observed.title,200),observed_at:observed.observed_at}});
        return {...observed,links,omitted_sensitive_links:observed.links.length-links.length,requested_url:url,provenance:'live_browser_dom',executor:browser.target?.id,effect:'read_only',search_provider:search.provider,search_access:'challenge_observed',status:'retryable_failure',reason:'WORK_SEARCH_PROVIDER_CHALLENGE',...(unusualSearchTraffic(url,observed)?{next_action:browser.target?.engine==='aside'?'user_browser_confirmation':'connect_aside',environment_block:true,provider_change_allowed:false}:{})};
      }
      this.allowedUrls.add(new URL(observed.url).href);
      for(const link of links){try{const next=assertBrowserUrl(link.url,[new URL(link.url).origin],this.config.environment==='fixture');if(this.allowedUrls.has(next.href)||next.origin===origin||next.protocol==='https:'&&!privateHostname(next.hostname))this.allowedUrls.add(next.href);}catch{}}
      workActivity(this.store,this.config.project.id,this.workId,'source.observed',`${observed.title} · ${observed.url}`,{tool_name:name,status:'succeeded',...(browser.target?{executor:browser.target.id,engine:browser.target.engine,environment:browser.target.environment}:{}),source:{url:safeControlText(observed.url,2048),title:safeControlText(observed.title,200),observed_at:observed.observed_at}});
      // Never rewrite observed hrefs or fill absent links with model guesses.
      return {...observed,links,omitted_sensitive_links:observed.links.length-links.length,requested_url:url,provenance:'live_browser_dom',executor:browser.target?.id,effect:'read_only',...(socialSite?{social_site:socialSite,social_access:'signed_in_marker_observed'}:{}),...(search?{search_provider:search.provider,search_access:'unclassified_dom'}:{})};
    }
    requireCondition(this.catalog().some(t=>t.name===name),'WORK_TOOL_NOT_AVAILABLE');
    const input=this.normalizedInput(name,args,requestId);
    const schema=(tools as Record<string,{schema:z.ZodType}>)[name]!.schema;schema.parse(input);
    if(name.startsWith('runtime_pack_')&&typeof input.run_id==='string')this.ownPack(input.run_id);
    if(name.startsWith('runtime_windows_')&&typeof input.run_id==='string')this.ownWindows(input.run_id);
    if(name.startsWith('runtime_coding_')&&typeof input.run_id==='string')this.ownCoding(input.run_id);
    if(name==='runtime_files_roots'){
      const roots=await this.api.call(name,input);requireCondition(Array.isArray(roots),'WORK_TOOL_FILE_SCOPE_MISMATCH');return roots.filter(root=>typeof object(root)?.id==='string'&&this.folderGranted(String(object(root)!.id)));
    }
    if(name==='runtime_files_scan')requireCondition(this.folderGranted(String(input.root_id)),'WORK_TOOL_FILE_SCOPE_MISMATCH');
    if(name.startsWith('runtime_files_')&&typeof input.scan_id==='string')this.ownScan(input.scan_id);
    if(name==='runtime_pack_run'){
      const recipe=object(input.recipe)!;requireCondition(this.spec.route.kind==='pack'&&recipe.family===this.spec.route.pack_family,'WORK_TOOL_PACK_FAMILY_MISMATCH');
      if(recipe.browser&&this.spec.browser)requireCondition(object(recipe.browser)?.environment===this.spec.browser.environment,'BROWSER_WORK_ENVIRONMENT_CONFLICT');
    }
    if(name==='runtime_pack_execute_approved'){
      const run=this.ownPack(String(input.run_id));requireCondition(run.task_id,'PACK_WRITE_NOT_PREPARED');
      const task=this.store.task(run.task_id),proposal=this.store.proposal(run.task_id);
      if(task.status==='succeeded')return {run_id:run.id,status:'succeeded',result:run.result,task_id:run.task_id,reconciled_from_durable_task:true};
      if(proposal.state==='consumed'||task.effect_state==='unknown'||task.status==='reconciliation_required')return {run_id:run.id,status:'reconciliation_required',reason:'PACK_PRIOR_EFFECT_UNCERTAIN',write_replayed:false};
      if(proposal.state!=='approved')return {run_id:run.id,status:'waiting_approval',reason:'HUMAN_APPROVAL_REQUIRED',next_action:'review_exact_proposal_in_control_center',approval_created:false};
    }
    let codingStage:{id:string;attempts:number}|undefined;
    if(name==='runtime_coding_start'){
      if(!this.config.coding?.model_data_approved)return {status:'waiting_approval',reason:'CODING_MODEL_DATA_APPROVAL_REQUIRED',next_action:'configure_coding_connection_in_control_center',approval_created:false};
      requireCondition(this.config.coding.projects.some(item=>item.id===input.project_ref),'CODING_PROJECT_NOT_REGISTERED');
      const prior=this.store.officeRuns(this.config.project.id,this.workId).find(item=>item.source_kind==='coding'||item.source_kind==='coding_dialog');
      if(prior?.source_kind==='coding_dialog')return {status:'waiting_approval',reason:'CODING_DIALOG_USE_USER_CONTROL',next_action:'choose_next_instruction_in_work_detail',approval_created:false};
      if(prior){const run=this.ownCoding(prior.source_id);requireCondition(run.project_ref===input.project_ref,'WORK_CODING_PROJECT_ALREADY_BOUND');this.dispatched.set(requestId,{name,input,reused_coding_run:run.id});return {...object(await this.api.call('runtime_coding_status',{run_id:run.id})),deduplicated:true,reused_existing:true};}
      if(!this.codingApproval(undefined,String(input.project_ref)))return {status:'waiting_approval',reason:'WORK_IMPORT_CODING_PLAN_APPROVAL_REQUIRED',next_action:'approve_imported_coding_plan_in_work_detail',approval_created:false};
    }
    if(name==='runtime_coding_step'){
      const run=this.ownCoding(String(input.run_id)),stage=this.store.codingStages(this.config.project.id,run.id).find(item=>item.status==='pending'),operation=stage?run.plan.stages[stage.ordinal]?.operation:null;
      if(operation&&['implement','document','commit_readme'].includes(operation)&&!['local_file_write','external_effect_requested'].includes(this.spec.requested_effect))return {run_id:run.id,status:'waiting_approval',reason:'WORK_CODING_WRITE_NOT_DELEGATED',next_action:'revise_work_write_scope_in_work_detail',approval_created:false};
      if(!this.codingApproval(run.id))return {run_id:run.id,status:'waiting_approval',reason:'WORK_IMPORT_CODING_STAGE_APPROVAL_REQUIRED',next_action:'approve_exact_imported_coding_stage_in_work_detail',approval_created:false};
      if(stage)codingStage={id:stage.stage_id,attempts:stage.attempts};
    }
    const before=name==='runtime_pack_run'?await this.fileSnapshots(object(input.recipe)!):[];
    if(name==='runtime_pack_run')this.guard();
    if(name==='runtime_pack_run'){const recipe=object(input.recipe)!,sources=Array.isArray(recipe.sources)?recipe.sources.flatMap(source=>typeof object(source)?.id==='string'?[String(object(source)!.id)]:[]):[];workActivity(this.store,this.config.project.id,this.workId,'pack.sources_selected',`Selected configured Pack sources: ${sources.slice(0,24).join(', ')}`,{tool_name:name,pack_family:String(recipe.family),status:'planned'});}
    this.dispatched.set(requestId,{name,input,...(codingStage?{coding_stage:codingStage}:{})});
    // Once dispatched, return the authoritative receipt even if pause/revision
    // changes during the effect. The bounded executor checkpoints it first and
    // applies the live guard before admitting its next operation.
    const value=await this.api.call(name,input);
    if(name==='runtime_pack_plan')return this.packPlanView(value);
    if(name==='runtime_pack_run'&&typeof object(value)?.run_id==='string'){
      const data=object(value)!,run=this.ownPack(String(data.run_id));
      if(data.deduplicated!==true&&before.length){
        const after=await this.fileSnapshots(object(input.recipe)!),sources=before.map(item=>{const last=after.find(observed=>observed.source_id===item.source_id);return {source_id:item.source_id,before_sha256:item.sha256,after_sha256:last?.sha256??null,before_observed_at:item.observed_at,after_observed_at:last?.observed_at??null,unchanged:item.sha256&&last?.sha256?item.sha256===last.sha256:'unknown' as const};});
        this.packIntegrity.set(requestId,{run_id:run.id,result_sha256:hashJson(run.result),sources});
      }
      // A deduplicated old run cannot gain new before/after execution evidence.
      return {...data,source_integrity:this.trustedSourceIntegrity(data,requestId)};
    }
    if(name==='runtime_windows_start'&&typeof object(value)?.run_id==='string')this.ownWindows(String(object(value)!.run_id));
    if(name==='runtime_coding_start'&&typeof object(value)?.run_id==='string')this.ownCoding(String(object(value)!.run_id));
    return value;
  }
  /** Host-owned receipt normalization. A model/API status alone never verifies a write. */
  async receipt(name:string,value:unknown,requestId?:string):Promise<WorkClientToolReceipt>{
    const effect=effects[name as ExecutionToolName];requireCondition(effect,'WORK_TOOL_NOT_AVAILABLE');
    const data=object(value),readOnly=effect==='read_only';
    let state=String(data?.status??data?.run_status??'succeeded'),status:WorkClientToolReceipt['status']='succeeded';
    const challengedSearch=['office_web_search','office_browser_read'].includes(name)&&data?.provenance==='live_browser_dom'&&data.effect==='read_only'&&data.search_access==='challenge_observed'&&state==='retryable_failure';
    const socialBlocked=['office_social_search','office_browser_read'].includes(name)&&data?.provenance==='live_browser_dom'&&data.effect==='read_only'&&data.social_access==='not_verified'&&state==='retryable_failure';
    if(challengedSearch||socialBlocked)status='retryable_failure';
    if(!readOnly){
      if(name==='runtime_files_request'&&!data?.root_id)state='waiting_approval';
      if(name==='runtime_files_propose'&&data?.state==='preview')state='waiting_approval';
      if(['waiting_auth','waiting_approval','retryable_failure','failed','reconciliation_required'].includes(state))status=state as WorkClientToolReceipt['status'];
      else if(['needs_human','approval_required','needs_approval','needs_review','needs_replan','paused_work','paused_config','cancelled'].includes(state))status='waiting_approval';
      else if(['waiting_connection','waiting_observation','running'].includes(state))status='retryable_failure';
    }
    let effectState:WorkClientToolReceipt['effect_state']=status==='reconciliation_required'?'uncertain':'none',correctableQuality=false;
    if((name==='runtime_pack_run'||name==='runtime_pack_execute_approved')&&typeof data?.run_id==='string'){
      try{const run=this.ownPack(data.run_id);if(run.task_id&&(this.store.task(run.task_id).effect_state==='unknown'||this.store.proposal(run.task_id).state==='consumed'&&this.store.task(run.task_id).status!=='succeeded')){status='reconciliation_required';effectState='uncertain';}}catch{status='reconciliation_required';effectState='uncertain';}
    }
    // A source/field verification error is not a permission request. Only the
    // durable, task-free collection families can expose this correction path;
    // unknown effects, approval tasks and other review states still stop.
    if(name==='runtime_pack_run'&&state==='needs_review'&&data?.task_id===null&&status!=='reconciliation_required'&&typeof data.run_id==='string'){
      try{
        const run=this.ownPack(data.run_id),report=object(object(run.result)?.verification);
        correctableQuality=run.task_id===null&&run.status==='needs_review'&&['research.search','portal.collect','file.pipeline'].includes(run.recipe.family)&&hashJson(run.result)===hashJson(data.result)&&report?.scope==='supplied_source_snapshot'&&report.all_checks_passed===false&&report.originals_modified===false&&Array.isArray(report.receipts);
        if(correctableQuality)status='retryable_failure';
      }catch{/* Missing provenance is never grounds to bypass user review. */}
    }
    if((status==='succeeded'||correctableQuality)&&(effect==='local_write'||effect==='external_write')){
      let verified=false;
      try{
        if(name==='office_result_draft'&&requestId){
          const artifact=object(data?.artifact);requireCondition(data?.work_id===this.workId&&data?.run_id===this.runId&&typeof data?.text==='string'&&artifact?.path===this.resultPath(requestId),'WORK_ARTIFACT_SCOPE_MISMATCH');
          const bytes=await readScopedFile(String(artifact.path));verified=sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes&&bytes.equals(Buffer.from(data.text+'\n','utf8'));
          if(verified)this.resultReceipts.set(requestId,{tool_name:'office_result_draft',value:data});
        }else if(name==='runtime_pack_run'&&typeof data?.run_id==='string'){
          const run=this.ownPack(data.run_id);verified=run.status===data.status&&hashJson(run.result)===hashJson(data.result);
          if(run.task_id)verified=verified&&this.store.task(run.task_id).effect_state==='none'&&this.store.proposal(run.task_id).state!=='consumed';
          const artifact=object(object(run.result)?.artifact);
          if(artifact){
            requireCondition(typeof artifact.path==='string'&&resolve(dirname(artifact.path))===resolve(join(dirname(this.config.dbPath),'pack-artifacts')),'WORK_ARTIFACT_SCOPE_MISMATCH');
            const bytes=await readScopedFile(artifact.path);verified=verified&&sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes;
          }
          if(verified&&status==='succeeded'&&run.task_id===null&&artifact&&requestId)this.resultReceipts.set(requestId,{tool_name:'runtime_pack_run',value:data});
        }else if(name==='runtime_pack_execute_approved'&&typeof data?.run_id==='string'){
          const run=this.ownPack(data.run_id);if(run.task_id){const task=this.store.task(run.task_id);verified=task.project_id===this.config.project.id&&task.status==='succeeded'&&task.effect_state==='observed';}
        }else if(name==='runtime_windows_step'&&typeof data?.run_id==='string'){
          const run=this.ownWindows(data.run_id),receipt=object(Array.isArray(run.receipts)?run.receipts.at(-1):null),input=requestId?this.dispatched.get(requestId)?.input:null;
          verified=Boolean(input&&input.run_id===data.run_id&&typeof input.expected_revision==='number'&&typeof run.revision==='number'&&run.revision>input.expected_revision&&data.revision===run.revision&&run.reason==='POSTCONDITION_VERIFIED'&&receipt?.capture_id&&Array.isArray(receipt.evidence_refs)&&receipt.evidence_refs.length>0&&hashJson(data.receipts)===hashJson(run.receipts));
        }else if((name==='runtime_coding_start'||name==='runtime_coding_step')&&typeof data?.run_id==='string'&&requestId){
          const run=this.ownCoding(data.run_id),invocation=this.dispatched.get(requestId),stages=this.store.codingStages(this.config.project.id,run.id),stage=stages.find(item=>item.stage_id===invocation?.coding_stage?.id);
          const common=invocation?.name===name&&data.work_id===this.workId&&data.project_ref===run.project_ref&&data.revision===run.revision&&data.status===run.status&&hashJson(data.plan)===hashJson(run.plan)&&hashJson(data.stages)===hashJson(stages);
          if(name==='runtime_coding_start')verified=Boolean(common&&invocation.input.project_ref===run.project_ref&&(run.request_id===requestId||invocation.reused_coding_run===run.id)&&await this.codingGitVerified(run.id));
          else verified=Boolean(common&&invocation.input.run_id===run.id&&typeof invocation.input.expected_revision==='number'&&run.revision>invocation.input.expected_revision&&stage?.status==='succeeded'&&stage.attempts===(invocation.coding_stage?.attempts??-1)+1&&stage.receipt&&await this.codingGitVerified(run.id));
        }
      }catch{/* Keep unverified effects visible; do not replay on an exception. */}
      effectState=verified?(correctableQuality&&!object(object(data?.result)?.artifact)?'none':'verified'):'uncertain';if(!verified)status='reconciliation_required';
    }
    const id=requestId&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId)?requestId:null;
    const scopedValue=name==='runtime_pack_run'&&data?{...data,source_integrity:effectState==='verified'?this.trustedSourceIntegrity(data,requestId):null}:value;
    const receiptValue=correctableQuality&&status==='retryable_failure'?{...object(scopedValue),correction:{kind:'data_quality',reason:'PACK_SOURCE_EVIDENCE_VERIFICATION_FAILED',automatic_correction_allowed:true,user_confirmation_required:false,quality_checks_passed:false,next_action:'Inspect preserved source records and verification receipts; correct only grounded recipe fields or collect missing evidence, then retry a validated recipe. Do not invent evidence, weaken requested checks or mark unverified data complete.'}}:scopedValue;
    return {status,value:receiptValue,evidence_ids:status==='succeeded'&&id?[id]:[],effect_state:effectState,retry_safe:!challengedSearch&&!socialBlocked&&effectState==='none'&&(readOnly||status!=='succeeded')};
  }
  async close(){await Promise.allSettled([...this.browsers.values()].map(b=>b.close()));this.browsers.clear();}
}
