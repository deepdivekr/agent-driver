import {type ModelCall,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {McpSamplingStructuredModel,subscriptionAwareModelFromHostEnvironment,type SubscriptionAwareModelOptions} from '../integrations/subscription-auth.js';
import {structuredModelFromEnvironment} from '../integrations/model-provider.js';
import {effectiveModelEnvironment,publicModelSettings,readModelSettings} from './model-settings.js';

/** Read at invocation start, never mutate process.env or an already-running model call. */
export class ConfiguredStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];
  sampling?:McpSamplingStructuredModel;
  constructor(readonly path:string,readonly base:NodeJS.ProcessEnv=process.env,readonly factories:{api?:(env:NodeJS.ProcessEnv)=>StructuredModel;subscription?:(options:SubscriptionAwareModelOptions)=>StructuredModel}={}){}
  environment(){return effectiveModelEnvironment(readModelSettings(this.path),this.base);}
  private resolve(){
    const saved=readModelSettings(this.path),environment=effectiveModelEnvironment(saved,this.base);
    const api=()=>this.factories.api?.(environment)??structuredModelFromEnvironment(environment);
    if(saved?.selection.mode==='api')return api();
    // Preserve legacy host configuration until the human first saves a selection.
    let fallbackModel:StructuredModel|undefined;if(!saved)try{fallbackModel=api();}catch{}
    const options={environment,...(this.sampling?{sampling:this.sampling}:{}),...(fallbackModel?{fallbackModel,fallbackKind:'api_key' as const}:{})};
    return this.factories.subscription?.(options)??subscriptionAwareModelFromHostEnvironment(options,environment);
  }
  async status(){const saved=readModelSettings(this.path);return {...publicModelSettings(saved,this.base),...await subscriptionAwareModelFromHostEnvironment({...(this.sampling?{sampling:this.sampling}:{})},this.environment()).status()};}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    const provider=this.resolve();try{return await provider.call(purpose,instructions,input,schema);}finally{this.calls.push(...provider.calls);}
  }
}
