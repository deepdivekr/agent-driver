import {z} from 'zod';
import {TypeSafeJevDecisionLayer,type JevSystemOneTransport} from '../taskpack/typesafe-jev.js';

export const interventionSchema=z.object({
  kind:z.enum(['clarification','choice','authentication','approval']),
  intervention_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict();
export const humanChannelRouteInput=z.object({
  message:z.string().trim().min(1).max(8_000),
  pending:interventionSchema.nullable().default(null),
}).strict();
export type HumanChannelRouteInput=z.infer<typeof humanChannelRouteInput>;

export type HumanChannelRoute=
  |'task_request'
  |'intervention_response'
  |'authentication_response'
  |'non_actionable'
  |'unknown'
  |'approval_requires_trusted_elicitation';

/**
 * Classifies conversational traffic only. It cannot authorize dispatch. An
 * approval is deliberately excluded from the model's choices and is handled
 * only by the snapshot-bound MCP elicitation path.
 */
export async function routeHumanChannelMessage(raw:unknown,transport?:JevSystemOneTransport){
  const input=humanChannelRouteInput.parse(raw),message=input.message.trim();
  if(input.pending?.kind==='approval')return result('approval_requires_trusted_elicitation','code_policy',input.pending.intervention_id);
  if(/^\/task(?:\s|$)/u.test(message))return result('task_request','explicit_command');
  if(/^\/(?:status|help|stop)(?:\s|$)/u.test(message))return result('non_actionable','explicit_command');
  if(!transport)return result('unknown','jev_unavailable',input.pending?.intervention_id);
  const decider=new TypeSafeJevDecisionLayer(transport);
  const routes=input.pending===null?[
    {id:'task_request',description:'A new request asking the agent to browse, operate a computer, collect information, monitor something, or perform work.'},
    {id:'non_actionable',description:'Conversation, status question, greeting, acknowledgement, or text that does not request a new computer task.'},
  ]:[
    {id:'intervention_response',description:`A direct answer to the currently pending ${input.pending.kind} question. It does not approve any external effect.`},
    {id:'task_request',description:'A distinct new task request rather than an answer to the pending question.'},
    {id:'non_actionable',description:'Conversation or text unrelated to both the pending question and a new task.'},
  ];
  const decision=await decider.decide({request:message,routes,fields:[],observed_state:{pending:input.pending},policy_version:'telegram_v1'});
  if(decision.status!=='PROPOSED')return {...result('unknown',`jev_${decision.status.toLowerCase()}`,input.pending?.intervention_id),trace:decision.trace};
  const route=(decision.route_id==='intervention_response'&&input.pending?.kind==='authentication'?'authentication_response':decision.route_id) as HumanChannelRoute;
  return {...result(route,'typesafe_jev',input.pending?.intervention_id),trace:decision.trace};
}

function result(route:HumanChannelRoute,decidedBy:string,interventionId?:string){
  return {route,decided_by:decidedBy,dispatch_allowed:false,approval_granted:false,...(interventionId?{intervention_id:interventionId}:{})};
}
