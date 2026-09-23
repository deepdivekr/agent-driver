import {z} from 'zod';
import {FIXTURE_DRAFT} from '../browser/fixture-capability.js';
import {terminalStart,terminalSubmit,terminalBound,terminalList,terminalHistory,terminalOutput,terminalHandoff,terminalVerify} from '../terminal/contracts.js';
import {packTools} from '../packs/contracts.js';
import {humanChannelRouteInput} from '../integrations/human-channel.js';
import {swarmTools} from '../swarm/contracts.js';
import {observabilityTools} from '../observability/contracts.js';
export const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const draftInput=z.object({name:z.string().min(1).max(200),note:z.string().min(1).max(4000)}).strict();
export const startRequest=z.object({request_id:id,capability:z.literal('fixture.draft.save'),account_ref:id,input:draftInput,deadline_ms:z.number().int().min(1000).max(120000).default(30000)}).strict();
const task=z.object({task_id:id}).strict(),empty=z.object({}).strict();
const notImplemented={implemented:false,readOnly:false};
export const tools={
  ...packTools,
  ...swarmTools,
  ...observabilityTools,
  runtime_channel_route:{schema:humanChannelRouteInput,implemented:true,readOnly:true},
  runtime_decision_status:{schema:empty,implemented:true,readOnly:true},
  runtime_health:{schema:empty,implemented:true,readOnly:true},
  runtime_storage_status:{schema:empty,implemented:true,readOnly:true},
  runtime_storage_plan:{schema:empty,implemented:true,readOnly:true},
  runtime_storage_prune:{schema:z.object({plan_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),implemented:true,readOnly:false},
  runtime_storage_recover_reservations:{schema:empty,implemented:true,readOnly:false},
  runtime_capabilities_list:{schema:empty,implemented:true,readOnly:true},
  runtime_capability_describe:{schema:z.object({capability:id}).strict(),implemented:true,readOnly:true},
  runtime_task_start:{schema:startRequest,implemented:true,readOnly:false},
  runtime_task_status:{schema:task,implemented:true,readOnly:true},
  runtime_task_cancel:{schema:task,implemented:true,readOnly:false},
  runtime_task_resume:{schema:z.object({task_id:id,expected_recovery_generation:z.number().int().nonnegative()}).strict(),implemented:true,readOnly:false},
  runtime_recovery_status:{schema:empty,implemented:true,readOnly:true},
  runtime_recovery_prepare:{schema:z.object({task_id:id,expected_recovery_generation:z.number().int().nonnegative()}).strict(),implemented:true,readOnly:true},
  runtime_artifacts_list:{schema:task,implemented:true,readOnly:true},
  runtime_events_read:{schema:z.object({consumer_id:id,limit:z.number().int().min(1).max(1000).default(100)}).strict(),implemented:true,readOnly:true},
  runtime_events_ack:{schema:z.object({consumer_id:id,event_id:z.number().int().positive()}).strict(),implemented:true,readOnly:false},
  runtime_terminal_start:{schema:terminalStart,implemented:true,readOnly:false},
  runtime_terminal_status:{schema:z.object({session_ref:id}).strict(),implemented:true,readOnly:true},
  runtime_terminal_sessions_list:{schema:terminalList,implemented:true,readOnly:true},
  runtime_terminal_history:{schema:terminalHistory,implemented:true,readOnly:true},
  runtime_terminal_output_read:{schema:terminalOutput,implemented:true,readOnly:true},
  runtime_terminal_handoff:{schema:terminalHandoff,implemented:true,readOnly:false},
  runtime_terminal_verify:{schema:terminalVerify,implemented:true,readOnly:false},
  runtime_terminal_reconcile_files:{schema:terminalBound,implemented:true,readOnly:false},
  runtime_terminal_submit_prompt:{schema:terminalSubmit,implemented:true,readOnly:false},
  runtime_terminal_resume:{schema:terminalBound,implemented:true,readOnly:false},
  runtime_terminal_interrupt:{schema:terminalBound,implemented:true,readOnly:false},
  runtime_browser_session_open:{schema:z.object({request_id:id}).strict(),...notImplemented},
  runtime_browser_session_status:{schema:z.object({session_ref:id}).strict(),...notImplemented},
} as const;
export const draftManifest={id:FIXTURE_DRAFT.id,version:1,input_schema:z.toJSONSchema(draftInput),effect:'write_external',
  constraints:{allow_user_target:false,allow_foreground:false,allow_os_input:false,environment:'fixture'},
  routes:[FIXTURE_DRAFT.route],verification:{type:'independent_readback',account_required:true},recovery:{mode:'reconcile_no_blind_retry'},
  status:'test_only',verified_for_environment:'owned_headless_fixture'};
export type StartRequest=z.infer<typeof startRequest>;
export const terminalManifest={id:'coding.session',version:2,input_schema:z.toJSONSchema(terminalSubmit),effect:'model_prompt',constraints:{allow_user_target:false,allow_foreground:false,allow_os_input:false,raw_terminal_write:false,native_tools_enabled:false,file_tools:'explicit_host_delegation_only',platform:'linux'},routes:['claude.structured'],verification:{turn:'official_user_replay_and_result',files:'broker_journal_and_readback',tests:'optional_isolated_node_stdio_cases',project:'external_orchestrator_required'},recovery:{mode:'explicit_finished_session_only'},status:'experimental_scoped_files',verified_for_environment:false};
