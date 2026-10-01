import {type Capability,type Lease,type Observation,type Verification,requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {OwnedPersistentPage} from '../taskpack/owned-playwright.js';
import {ApprovedBrowserProtocol,type ApprovedBrowserAdapter,type BrowserPreparation,type PreparedApproval} from '../taskpack/protocol.js';
import {snapshotHash,taskPackManifest} from '../taskpack/contracts.js';
import {type PackStore} from './store.js';
import {type MutationRecipe,type Target,type Row,rowSchema} from './contracts.js';
import {join} from 'node:path';
import {MAX_BYTES} from './data.js';

/** Implementation contract, not a claim that a particular site is ready. */
export const BROWSER_DRAFT_READBACK_CONTRACT={version:1,enforced_by:'runtime_pack_run',required_observations:['verified_values_before_capture','verified_values_after_capture','capture_ref','capture_sha256'],comparison:'all_requested_control_values_before_and_after_capture',submission:'disabled',readiness:'requires_current_execution',legacy_receipts:'not_backfilled'} as const;

export function targetCapability(target:Target):Capability{return {
  id:`pack.${target.id}`,effect:'write_external',route:`pack.browser.${target.id}`,environments:['owned_headless'],hiddenVerified:false,
  requiresForeground:false,requiresOsInput:false,usesUserTarget:false,requiresClipboard:false,requiresFileDialog:false,verification:'independent_readback',
};}
/** Legacy single-readback receipts do not prove both sides of a capture. */
export function verifiedDraftBrowserReadbacks(prepared:Pick<PreparedApproval,'verified_values'|'verified_values_before_capture'|'verified_values_after_capture'|'capture_sha256'>,expected:Row){
  const before=prepared.verified_values_before_capture,after=prepared.verified_values_after_capture,legacy=prepared.verified_values;
  const matches=(observed:Record<string,unknown>|undefined)=>observed&&Object.keys(observed).length===Object.keys(expected).length&&Object.entries(expected).every(([key,value])=>observed[key]===value);
  requireCondition(matches(before)&&matches(after)&&matches(legacy)&&Object.entries(after!).every(([key,value])=>before![key]===value)&&/^[a-f0-9]{64}$/u.test(prepared.capture_sha256??''),'PACK_DRAFT_READBACK_UNVERIFIED');
  return {before:before!,after:after!};
}
export class FamilyBrowserWrite implements ApprovedBrowserAdapter<MutationRecipe>{
  readonly adapterId:string;private owned:OwnedPersistentPage|undefined;private binding:{taskId:string;lease:Lease;targetRef:string}|undefined;
  private input:MutationRecipe|undefined;private before:Row|null=null;
  constructor(readonly config:HostConfig,readonly target:Target){this.adapterId=`pack.browser.${target.id}.v1`;}
  bind(binding:{taskId:string;lease:Lease;targetRef:string}){this.binding=binding;}
  async observe():Promise<Observation>{
    requireCondition(this.binding&&this.owned,'PACK_BROWSER_NOT_BOUND');const page=this.owned.page;
    const anonymousDraft=this.target.draft_only&&!this.target.auth_required;
    const account=anonymousDraft?null:(await page.locator(this.target.account_selector).innerText()).trim();
    return {targetRef:this.binding.targetRef,targetExists:!page.isClosed(),ownerTaskId:this.binding.taskId,projectId:this.config.project.id,profileRef:this.config.project.profileRef,
      accountRef:anonymousDraft||account===this.target.account_text?this.config.project.accountRef:'unknown',origin:new URL(page.url()).origin,generation:this.binding.lease.generation,observedMonoMs:performance.now(),visibility:'visible',environment:'owned_headless'};
  }
  private async readback(){
    requireCondition(this.owned&&this.input,'PACK_BROWSER_NOT_PREPARED');requireCondition(this.target.readback_url,'PACK_READBACK_REQUIRED');const url=new URL(this.target.readback_url);
    url.searchParams.set(this.target.identity_parameter,String(this.input.values[this.target.identity_field]));
    const response=await this.owned.page.context().request.get(url.toString(),{timeout:10000,maxRedirects:0});
    requireCondition(response.ok()&&Number(response.headers()['content-length']??0)<=MAX_BYTES,'PACK_READBACK_UNAVAILABLE');
    const bytes=await response.body();requireCondition(bytes.length<=MAX_BYTES,'PACK_READBACK_TOO_LARGE');const raw:unknown=JSON.parse(bytes.toString('utf8'));
    if(raw===null)return null;const row=rowSchema.parse(raw);requireCondition(row[this.target.identity_field]===this.input.values[this.target.identity_field],'PACK_RECORD_IDENTITY_MISMATCH');return row;
  }
  async prepare(input:MutationRecipe):Promise<BrowserPreparation>{
    requireCondition(this.binding,'PACK_BROWSER_NOT_BOUND');requireCondition(input.family===this.target.family,'PACK_TARGET_FAMILY_MISMATCH');
    requireCondition(Object.keys(input.values).length>0&&Object.keys(input.values).every(k=>Object.hasOwn(this.target.fields,k)),'PACK_FIELD_NOT_DELEGATED');
    requireCondition(typeof input.values[this.target.identity_field]==='string'&&String(input.values[this.target.identity_field]).length>0,'PACK_RECORD_IDENTITY_REQUIRED');
    this.input=input;this.owned=new OwnedPersistentPage(this.config.project.profileRef,join(this.config.project.profileRef,'pack-captures'),true,{draftOnly:this.target.draft_only});
    const result=await this.owned.open(this.binding.taskId,{url:this.target.url,allowed_origins:[new URL(this.target.url).origin],logged_in:this.target.ready,
      authentication_request:this.target.auth_gate,requires_logged_in:this.target.auth_required,known_popups:this.target.known_popups,unknown_dialog:'[role="dialog"],dialog[open]',navigation_timeout_ms:15000});
    if(result.gate!=='ready')return {gate:result.gate,snapshot:{gate:result.gate},capture_ref:result.capture_ref!,detail:{gate:result.gate}};
    await this.owned.page.locator(this.target.ready).waitFor({state:'visible',timeout:10000});
    if(this.target.auth_required)requireCondition((await this.owned.page.locator(this.target.account_selector).innerText()).trim()===this.target.account_text,'PACK_ACCOUNT_MISMATCH');
    if(!this.target.draft_only||input.family==='record.update'){
      this.before=await this.readback();
      if(input.family==='record.update')requireCondition(this.before!==null&&input.expected_before_sha256===snapshotHash(this.before),'PACK_RECORD_STALE');
      else requireCondition(this.before===null&&input.expected_before_sha256===null,'PACK_RECORD_ALREADY_EXISTS');
    }else requireCondition(input.expected_before_sha256===null,'DRAFT_ONLY_RECORD_STATE_UNVERIFIED');
    const actual:Row={};
    for(const [key,value]of Object.entries(input.values)){
      const spec=this.target.fields[key]!,control=this.owned.page.locator(spec.selector);requireCondition(spec.kind==='radio'?await control.count()>=1:await control.count()===1,'PACK_FIELD_AMBIGUOUS');
      requireCondition(!['password','file'].includes((await control.first().getAttribute('type'))??''),'PACK_SECRET_FIELD_FORBIDDEN');
      if(spec.kind==='radio'){
        // The selector names the group; the value selects exactly one option.
        requireCondition(typeof value==='string','PACK_TEXT_VALUE_REQUIRED');const option=control.and(this.owned.page.locator(`[value=${JSON.stringify(value)}]`));
        requireCondition(await option.count()===1,'PACK_RADIO_OPTION_NOT_FOUND');await option.check();actual[key]=await this.radioValue(spec.selector);
      }
      else if(spec.kind==='checkbox'){requireCondition(typeof value==='boolean','PACK_CHECKBOX_VALUE_REQUIRED');await control.setChecked(value);actual[key]=await control.isChecked();}
      else {requireCondition(typeof value==='string','PACK_TEXT_VALUE_REQUIRED');if(spec.kind==='select')await control.selectOption(value);else await control.fill(value);actual[key]=await control.inputValue();}
      requireCondition(actual[key]===value,'PACK_FORM_VALUE_MISMATCH');
    }
    if(this.target.draft_only&&input.family==='record.update')requireCondition(snapshotHash(await this.readback())===snapshotHash(this.before),'PACK_DRAFT_RECORD_CHANGED');
    const captured=await this.owned.capture(this.binding.taskId);
    // The screenshot alone is not a field readback. Reobserve the same controls
    // after capture so a draft receipt can prove the staged DOM values, too.
    const after:Row={};
    for(const [key,value]of Object.entries(actual)){
      const spec=this.target.fields[key]!,control=this.owned.page.locator(spec.selector);
      const observed=spec.kind==='checkbox'?await control.isChecked():spec.kind==='radio'?await this.radioValue(spec.selector):await control.inputValue();
      requireCondition(observed===value,'PACK_FORM_VALUE_CHANGED_AFTER_CAPTURE');
      after[key]=observed;
    }
    return {gate:'ready',snapshot:{target:this.target.id,family:input.family,values:actual,before:this.before,config:this.config.fingerprint},capture_ref:captured.capture_ref,
      ...(this.target.draft_only?{verified_values:after,verified_values_before_capture:actual,verified_values_after_capture:after,capture_sha256:captured.capture_sha256}:{}),
      detail:{fields:Object.keys(actual),draft_only:this.target.draft_only,authentication_verified:this.target.auth_required,submission_enabled:!this.target.draft_only,before_sha256:this.before===null?null:snapshotHash(this.before),record_unchanged:this.target.draft_only&&input.family==='record.update'?true:null,capture_sha256:captured.capture_sha256}};
  }
  private async radioValue(selector:string){
    const checked=this.owned!.page.locator(selector).and(this.owned!.page.locator(':checked'));
    return await checked.count()===1?await checked.inputValue():'';
  }
  async execute(){
    requireCondition(!this.target.draft_only,'PACK_DRAFT_ONLY');
    requireCondition(this.owned&&this.input,'PACK_BROWSER_NOT_PREPARED');
    // Re-read both record and controls at the dispatch boundary. No cached success flags.
    requireCondition(snapshotHash(await this.readback())===snapshotHash(this.before),'PACK_RECORD_STALE');
    for(const [key,value]of Object.entries(this.input.values)){
      const spec=this.target.fields[key]!,control=this.owned.page.locator(spec.selector);
      requireCondition((spec.kind==='checkbox'?await control.isChecked():spec.kind==='radio'?await this.radioValue(spec.selector):await control.inputValue())===value,'PACK_FORM_CHANGED');
    }
    const button=this.owned.page.locator(this.target.submit);requireCondition(await button.count()===1,'PACK_SUBMIT_AMBIGUOUS');
    await button.click({timeout:5000});
  }
  async verify():Promise<Verification>{
    requireCondition(this.binding&&this.input,'PACK_BROWSER_NOT_PREPARED');
    let row:Row|null=null;const expected={...(this.before??{}),...this.input.values};
    for(let attempt=0;attempt<3;attempt++){
      row=await this.readback();if(row&&Object.entries(expected).every(([key,value])=>row![key]===value))break;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,150));
    }
    const match=row!==null&&Object.entries(expected).every(([key,value])=>row![key]===value);
    return {result:match?'MATCH':'UNKNOWN',source:'independent_record_get',accountRef:this.config.project.accountRef,targetRef:this.binding.targetRef,generation:this.binding.lease.generation,observedMonoMs:performance.now(),
      detail:{record_sha256:row===null?null:snapshotHash(row),preserved_before_fields:this.before===null?[]:Object.keys(this.before).filter(k=>!Object.hasOwn(this.input!.values,k))}};
  }
  async close(){await this.owned?.close();this.owned=undefined;}
}
export function writeProtocol(store:PackStore,config:HostConfig,recipe:MutationRecipe){
  const target=config.packs?.targets.find(t=>t.id===recipe.target);requireCondition(target,'PACK_TARGET_NOT_DELEGATED');
  const adapter=new FamilyBrowserWrite(config,target),capability=targetCapability(target);
  const manifest=taskPackManifest.parse({id:`${target.family}.${target.id}`,version:1,adapter_id:adapter.adapterId,effect:'write_external',
    input_fields:Object.keys(target.fields).map(name=>({name,required:name===target.identity_field,description:`Reviewed ${name} field`})),
    observation:{logged_in_signal:target.account_selector,independent_readback:target.readback_url??'draft-only; submission disabled'},time_constraints:[],
    popup_policy:{known_dismissible:target.known_popups.map(p=>p.id),unknown_action:'hold',security_action:'hold'},
    approval:{required:'per_external_write',binds:['task','caller','pack','adapter','normalized_input','form_snapshot','generation'],token:'single_use_expiring'}});
  return new ApprovedBrowserProtocol(store,manifest,capability,adapter);
}
