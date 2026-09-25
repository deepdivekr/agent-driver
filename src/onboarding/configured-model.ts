import {type ModelCall,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {McpSamplingStructuredModel,subscriptionAwareModelFromHostEnvironment,type SubscriptionAwareModelOptions} from '../integrations/subscription-auth.js';
import {structuredModelFromEnvironment} from '../integrations/model-provider.js';
import {effectiveModelEnvironment,publicModelSettings,readModelSettings} from './model-settings.js';
import {classifyClientFailure,handoffContext,type ClientRouteEvent,type HandoffReason} from '../integrations/client-handoff.js';
import {hashJson} from '../taskpack/adaptive-spec.js';

/** Read at invocation start, never mutate process.env or an already-running model call. */
export class ConfiguredStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];
  sampling?:McpSamplingStructuredModel;
  constructor(readonly path:string,readonly base:NodeJS.ProcessEnv=process.env,readonly factories:{api?:(env:NodeJS.ProcessEnv)=>StructuredModel;subscription?:(options:SubscriptionAwareModelOptions)=>StructuredModel}={},readonly onHandoff?:(event:ClientRouteEvent)=>void){}
  environment(){return effectiveModelEnvironment(readModelSettings(this.path),this.base);}
  private resolve(){
    const saved=readModelSettings(this.path),environment=effectiveModelEnvironment(saved,this.base);
    const api=()=>this.factories.api?.(environment)??structuredModelFromEnvironment(environment);
    if(saved?.selection.mode==='api'||!saved&&environment.AGENT_DRIVER_LLM_CLIENT==='api')return api();
    // An ambient key is not permission to switch subscription work to paid API calls.
    const options={environment,...(this.sampling?{sampling:this.sampling}:{}),...(this.onHandoff?{onHandoff:this.onHandoff}:{})};
    return this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,environment);
  }
  async status(){const saved=readModelSettings(this.path);return {...publicModelSettings(saved,this.base),...await subscriptionAwareModelFromHostEnvironment({...(this.sampling?{sampling:this.sampling}:{})},this.environment()).status()};}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    const saved=readModelSettings(this.path);
    if(saved?.selection.mode==='api'&&saved.selection.api_to_subscription){
      const env=effectiveModelEnvironment(saved,this.base),api=this.factories.api?.(env)??structuredModelFromEnvironment(env);
      try{return await api.call(purpose,instructions,input,schema);}catch(error){
        const call=api.calls.at(-1),status=call?.http_status;
        if(error instanceof Error&&error.message==='MODEL_PROVIDER_RESPONSE_INVALID'||status!==undefined&&status>=400&&status<500&&![401,402,403,429].includes(status))throw error;
        const reason:HandoffReason=status===401||status===403?'auth_expired':status===402?'quota_exhausted':status===429?'rate_limited':classifyClientFailure(error);
        const connected=['mcp','codex','claude','opencode'];
        const subscribed={...env,AGENT_DRIVER_LLM_CLIENT:saved.selection.client==='auto'?connected.join(','):[saved.selection.client,...connected.filter(client=>client!==saved.selection.client)].join(',')};
        const onHandoff=(event:ClientRouteEvent)=>this.onHandoff?.(event);
        const options={environment:subscribed,subscriptionOnly:true,...(this.sampling?{sampling:this.sampling}:{}),onHandoff};
        const alternative=this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,subscribed);
        try{const value=await alternative.call(purpose,instructions,input,schema),target=alternative.calls.findLast(item=>item.status==='accepted');
          if(target&&['mcp_sampling','codex','claude','opencode','cursor'].includes(target.provider??''))this.onHandoff?.({...handoffContext(input),source:'api',target:target.provider==='mcp_sampling'?'mcp':target.provider as ClientRouteEvent['target'],source_model:call?.model??saved.selection.api_model,target_model:target.model,reason,effect_state:'none',status:'transferred',input_sha256:hashJson({instructions,input,schema})});
          return value;
        }catch(fallbackError){this.onHandoff?.({...handoffContext(input),source:'api',target:null,source_model:call?.model??saved.selection.api_model,target_model:null,reason,effect_state:'none',status:'no_candidate',input_sha256:hashJson({instructions,input,schema})});throw fallbackError;
        }finally{this.calls.push(...alternative.calls);}
      }finally{this.calls.push(...api.calls);}
    }
    const provider=this.resolve();try{return await provider.call(purpose,instructions,input,schema);}finally{this.calls.push(...provider.calls);}
  }
}
