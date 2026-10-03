import {type ModelCall,type ModelRole,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {dirname,join} from 'node:path';
import {McpSamplingStructuredModel,subscriptionAwareModelFromHostEnvironment,type SubscriptionAwareModelOptions} from '../integrations/subscription-auth.js';
import {structuredModelFromEnvironment} from '../integrations/model-provider.js';
import {publicModelSettings,scopedModelConfiguration,roleModelConfiguration,type ModelScope} from './model-settings.js';
import {callProvenance} from '../integrations/client-failure.js';

/** Read at invocation start, never mutate process.env or an already-running model call. */
export class ConfiguredStructuredModel implements StructuredModel{
  private log:ModelCall[]=[];
  /** Role views of one binding share its call log, so a run counts every role's calls. */
  get calls(){return this.log;}
  sampling?:McpSamplingStructuredModel;
  /** The Work's own client: Office's judgments inside the Work use it too (one client per Work). */
  private client?:{id:'codex'|'claude';model:string|null};
  constructor(readonly path:string,readonly base:NodeJS.ProcessEnv=process.env,readonly factories:{api?:(env:NodeJS.ProcessEnv)=>StructuredModel;subscription?:(options:SubscriptionAwareModelOptions)=>StructuredModel}={},readonly scope:ModelScope='global',readonly provenance?:ReturnType<typeof callProvenance>,readonly role?:ModelRole,private readonly actorId?:string){}
  private copy(model:ConfiguredStructuredModel){if(this.sampling)model.sampling=this.sampling;if(this.client)model.client=this.client;return model;}
  forScope(scope:ModelScope){return this.copy(new ConfiguredStructuredModel(this.path,this.base,this.factories,scope,this.provenance,this.role,this.actorId));}
  /** A copy whose calls are one-off reads for the run, not turns of its conversation: a page digest is one, several
   * run at once, and a shared session accepts one turn at a time (live: digests of long pages failed and fell back to
   * parts). */
  private oneOffCalls=false;
  oneOff(){const model=this.forRole(this.role??'worker');model.oneOffCalls=true;return model;}
  forRole(role:ModelRole){const model=this.copy(new ConfiguredStructuredModel(this.path,this.base,this.factories,this.scope,this.provenance,role,this.actorId));model.log=this.log;return model;}
  /** Bind all calls to the same Work/run even if a capability input omits IDs. */
  forWork(context:{work_id:string;run_id:string;stage_id?:string;actor_id?:string},scope:ModelScope=this.scope){
    const binding=callProvenance(context);
    if(binding.work_id!==context.work_id||binding.run_id!==context.run_id||context.stage_id!==undefined&&binding.stage_id!==context.stage_id)throw Error('CLIENT_CALL_CONTEXT_INVALID');
    if(context.actor_id!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(context.actor_id))throw Error('CLIENT_SESSION_ACTOR_INVALID');
    return this.copy(new ConfiguredStructuredModel(this.path,this.base,this.factories,scope,binding,this.role,context.actor_id??binding.stage_id??undefined));
  }
  /** Office's judgments for a Work pinned to a client go to that client, whatever the current default is. */
  forClient(client:'codex'|'claude',model:string|null=null){const view=this.copy(new ConfiguredStructuredModel(this.path,this.base,this.factories,this.scope,this.provenance,this.role,this.actorId));view.client={id:client,model};view.log=this.log;return view;}
  environment(){return scopedModelConfiguration(this.path,this.scope,this.base).environment;}
  private resolve(context:ReturnType<typeof scopedModelConfiguration>,role:ModelRole){
    const {saved,environment}=context;
    const api=()=>this.factories.api?.(environment)??structuredModelFromEnvironment(environment);
    if(!this.client&&(saved?.selection.mode==='api'||!saved&&environment.AGENT_DRIVER_LLM_CLIENT==='api'))return api();
    // The Work's model is used for Office's judgments too; the reasoning effort stays the owner's default, so they stay quick.
    if(this.client){environment.AGENT_DRIVER_LLM_CLIENT=this.client.id;if(this.client.model)environment[`AGENT_DRIVER_${this.client.id.toUpperCase()}_MODEL`]=this.client.model;}
    const options={environment,...this.sessionOptions(role),...(this.sampling?{sampling:this.sampling}:{})};
    return this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,environment);
  }
  private sessionOptions(role:ModelRole){
    // Verification inputs contain the complete bound evidence for that call.
    // Reusing a native conversation accumulates prior batches/judgments without
    // adding authority or evidence. Keep assignee continuity for actual work,
    // but make the independent verifier checkpoint-only on every provider.
    if(role==='verifier'||this.oneOffCalls)return {};
    const p=this.provenance;
    return p?.work_id&&p.run_id?{session:{root:join(dirname(this.path),'decision-sessions'),work_id:p.work_id,run_id:p.run_id,actor_id:this.actorId??p.stage_id??'supervisor',role}}:{};
  }
  async status(){const context=scopedModelConfiguration(this.path,this.scope,this.base);return {...publicModelSettings(context.saved,context.base),model_scope:this.scope,model_source:context.source,...await subscriptionAwareModelFromHostEnvironment({...(this.sampling?{sampling:this.sampling}:{})},context.environment).status()};}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    input=structuredClone(input);schema=structuredClone(schema);
    if(this.provenance)input=input&&typeof input==='object'&&!Array.isArray(input)?{...input,...this.provenance,stage_id:this.provenance.stage_id??callProvenance(input).stage_id}:{value:input,...this.provenance};
    const role=this.role??(purpose==='design'||purpose==='repair'?'planner':'worker');
    const provider=this.resolve(roleModelConfiguration(this.path,this.scope,this.base,role),role),start=provider.calls.length;try{return await provider.call(purpose,instructions,input,schema);}finally{this.calls.push(...provider.calls.slice(start));}
  }
}
