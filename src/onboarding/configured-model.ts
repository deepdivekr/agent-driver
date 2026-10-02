import {type ModelCall,type ModelRole,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {dirname,join} from 'node:path';
import {McpSamplingStructuredModel,subscriptionAwareModelFromHostEnvironment,type SubscriptionAwareModelOptions} from '../integrations/subscription-auth.js';
import {structuredModelFromEnvironment} from '../integrations/model-provider.js';
import {publicModelSettings,scopedModelConfiguration,roleModelConfiguration,roleModelMode,type ModelScope} from './model-settings.js';
import {subscriptionTaskModelCandidates,type TaskModelCandidate,type TaskModelBinding} from './task-models.js';
import {classifyClientFailure,handoffContext,isNonRetryableClientFailure,recordClientRoute,type ClientRouteEvent,type HandoffReason} from '../integrations/client-handoff.js';
import {hashJson} from '../taskpack/adaptive-spec.js';

/** Read at invocation start, never mutate process.env or an already-running model call. */
export class ConfiguredStructuredModel implements StructuredModel{
  private log:ModelCall[]=[];
  /** Role views of one binding share its call log, so a run counts every role's calls. */
  get calls(){return this.log;}
  sampling?:McpSamplingStructuredModel;
  constructor(readonly path:string,readonly base:NodeJS.ProcessEnv=process.env,readonly factories:{api?:(env:NodeJS.ProcessEnv)=>StructuredModel;subscription?:(options:SubscriptionAwareModelOptions)=>StructuredModel;taskCandidates?:(env:NodeJS.ProcessEnv)=>Promise<TaskModelCandidate[]>}={},readonly onHandoff?:(event:ClientRouteEvent)=>void,readonly scope:ModelScope='global',readonly provenance?:ReturnType<typeof handoffContext>,readonly role?:ModelRole,private readonly taskModels?:TaskModelBinding,private readonly actorId?:string){}
  forScope(scope:ModelScope){const model=new ConfiguredStructuredModel(this.path,this.base,this.factories,this.onHandoff,scope,this.provenance,this.role,this.taskModels,this.actorId);if(this.sampling)model.sampling=this.sampling;return model;}
  forRole(role:ModelRole){const model=new ConfiguredStructuredModel(this.path,this.base,this.factories,this.onHandoff,this.scope,this.provenance,role,this.taskModels,this.actorId);model.log=this.log;if(this.sampling)model.sampling=this.sampling;return model;}
  /** Bind all successor calls to the same Work/run even if a capability input omits IDs. */
  forWork(context:{work_id:string;run_id:string;stage_id?:string;actor_id?:string},scope:ModelScope=this.scope){
    const binding=handoffContext(context);
    if(binding.work_id!==context.work_id||binding.run_id!==context.run_id||context.stage_id!==undefined&&binding.stage_id!==context.stage_id)throw Error('CLIENT_HANDOFF_CONTEXT_INVALID');
    if(context.actor_id!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(context.actor_id))throw Error('CLIENT_SESSION_ACTOR_INVALID');
    const sink=this.onHandoff?(event:ClientRouteEvent)=>this.onHandoff!({...event,...binding,stage_id:binding.stage_id??event.stage_id}):undefined;
    const model=new ConfiguredStructuredModel(this.path,this.base,this.factories,sink,scope,binding,this.role,this.taskModels,context.actor_id??binding.stage_id??undefined);if(this.sampling)model.sampling=this.sampling;return model;
  }
  taskModelContext(){
    const context=scopedModelConfiguration(this.path,this.scope,this.base);
    if(context.source!=='global'||context.saved?.selection.mode!=='subscription'||roleModelMode(context.saved.selection)!=='auto')return null;
    const env=context.environment;
    return {settings_binding:hashJson({revision:context.saved.revision,selection:context.saved.selection,client:env.AGENT_DRIVER_LLM_CLIENT??null,models:[env.AGENT_DRIVER_CODEX_MODEL??null,env.AGENT_DRIVER_CLAUDE_MODEL??null,env.AGENT_DRIVER_OPENCODE_MODEL??null],effort:env.AGENT_DRIVER_CODEX_REASONING_EFFORT??null,host:[env.HOME??null,env.USERPROFILE??null,env.CODEX_HOME??null,env.PATH??null]}),environment:env};
  }
  async taskModelCandidates(){const context=this.taskModelContext();return context?(this.factories.taskCandidates??subscriptionTaskModelCandidates)(context.environment):[];}
  withTaskModels(binding:TaskModelBinding){
    if(binding.work_id!==this.provenance?.work_id)throw Error('TASK_MODEL_WORK_MISMATCH');
    const model=new ConfiguredStructuredModel(this.path,this.base,this.factories,this.onHandoff,this.scope,this.provenance,this.role,structuredClone(binding),this.actorId);if(this.sampling)model.sampling=this.sampling;return model;
  }
  environment(){return scopedModelConfiguration(this.path,this.scope,this.base).environment;}
  private resolve(context:ReturnType<typeof scopedModelConfiguration>,role:ModelRole){
    const {saved,environment}=context;
    const api=()=>this.factories.api?.(environment)??structuredModelFromEnvironment(environment);
    if(saved?.selection.mode==='api'||!saved&&environment.AGENT_DRIVER_LLM_CLIENT==='api')return api();
    // An ambient key is not permission to switch subscription work to paid API calls.
    const options={environment,...(this.taskModelContext()?{subscriptionOnly:true}:{}),...this.sessionOptions(role),...(this.sampling?{sampling:this.sampling}:{}),...(this.onHandoff?{onHandoff:this.onHandoff}:{})};
    return this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,environment);
  }
  private sessionOptions(role:ModelRole){
    // Verification inputs contain the complete bound evidence for that call.
    // Reusing a native conversation accumulates prior batches/judgments without
    // adding authority or evidence. Keep assignee continuity for actual work,
    // but make the independent verifier checkpoint-only on every provider.
    if(role==='verifier')return {};
    const p=this.provenance;
    return p?.work_id&&p.run_id?{session:{root:join(dirname(this.path),'decision-sessions'),work_id:p.work_id,run_id:p.run_id,actor_id:this.actorId??p.stage_id??'supervisor',role}}:{};
  }
  async status(){const context=scopedModelConfiguration(this.path,this.scope,this.base);return {...publicModelSettings(context.saved,context.base),model_scope:this.scope,model_source:context.source,...await subscriptionAwareModelFromHostEnvironment({...(this.sampling?{sampling:this.sampling}:{})},context.environment).status()};}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    input=structuredClone(input);schema=structuredClone(schema);
    if(this.provenance)input=input&&typeof input==='object'&&!Array.isArray(input)?{...input,...this.provenance,stage_id:this.provenance.stage_id??handoffContext(input).stage_id}:{value:input,...this.provenance};
    const role=this.role??(purpose==='design'||purpose==='repair'?'planner':'worker');
    const context=roleModelConfiguration(this.path,this.scope,this.base,role),{saved}=context;
    const auto=this.taskModelContext(),allocation=this.taskModels;
    if(auto&&allocation&&allocation.work_id===this.provenance?.work_id&&allocation.settings_binding===auto.settings_binding){
      const selected=allocation.assignments.find(item=>item.role===role);
      if(selected?.client&&selected.model){
        context.environment[`AGENT_DRIVER_${selected.client.toUpperCase()}_MODEL`]=selected.model;
        const chain=context.environment.AGENT_DRIVER_LLM_CLIENT?.split(',')??[];
        context.environment.AGENT_DRIVER_LLM_CLIENT=[selected.client,...chain.filter(client=>client!==selected.client)].join(',');
      }
    }
    if(saved?.selection.mode==='api'&&saved.selection.api_to_subscription){
      const env=context.environment,api=this.factories.api?.(env)??structuredModelFromEnvironment(env),apiStart=api.calls.length;
      try{return await api.call(purpose,instructions,input,schema);}catch(error){
        const call=api.calls.slice(apiStart).at(-1),status=call?.http_status;
        if(isNonRetryableClientFailure(error)||call?.failure_kind==='invalid_output'||call?.failure_kind==='json_decode'||call?.failure_kind==='refusal'||status!==undefined&&status>=400&&status<500&&![401,402,403,429].includes(status))throw error;
        const reason:HandoffReason=status===401||status===403?'auth_expired':status===402?'quota_exhausted':status===429?'rate_limited':classifyClientFailure(error);
        const connected=['mcp','codex','claude','opencode'];
        const subscribed={...env,AGENT_DRIVER_LLM_CLIENT:saved.selection.client==='auto'?connected.join(','):[saved.selection.client,...connected.filter(client=>client!==saved.selection.client)].join(',')};
        const onHandoff=(event:ClientRouteEvent)=>this.onHandoff?.(event);
        const options={environment:subscribed,subscriptionOnly:true,...this.sessionOptions(role),...(this.sampling?{sampling:this.sampling}:{}),onHandoff};
        const alternative=this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,subscribed),alternativeStart=alternative.calls.length;
        let value:unknown;
        try{value=await alternative.call(purpose,instructions,input,schema);
        }catch(fallbackError){if(!isNonRetryableClientFailure(fallbackError))recordClientRoute(this.onHandoff,{...handoffContext(input),source:'api',target:null,source_model:call?.model??saved.selection.api_model,target_model:null,reason,effect_state:'none',status:'no_candidate',input_sha256:hashJson({instructions,input,schema})});throw fallbackError;
        }finally{this.calls.push(...alternative.calls.slice(alternativeStart));}
        const target=alternative.calls.slice(alternativeStart).findLast(item=>item.status==='accepted');
        if(!target||!['mcp_sampling','codex','claude','opencode','cursor'].includes(target.provider??''))throw Error('CLIENT_HANDOFF_RECEIPT_MISSING');
        recordClientRoute(this.onHandoff,{...handoffContext(input),source:'api',target:target.provider==='mcp_sampling'?'mcp':target.provider as ClientRouteEvent['target'],source_model:call?.model??saved.selection.api_model,target_model:target.model,reason,effect_state:'none',status:'transferred',input_sha256:hashJson({instructions,input,schema})});
        return value;
      }finally{this.calls.push(...api.calls.slice(apiStart));}
    }
    const provider=this.resolve(context,role),start=provider.calls.length;try{return await provider.call(purpose,instructions,input,schema);}finally{this.calls.push(...provider.calls.slice(start));}
  }
}
