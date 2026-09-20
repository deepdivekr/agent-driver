import {z} from 'zod';
import {FIXTURE_DRAFT} from '../browser/fixture-driver.js';
export const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const draftInput=z.object({name:z.string().min(1).max(200),note:z.string().min(1).max(4000)}).strict();
export const startRequest=z.object({request_id:id,capability:z.literal('fixture.draft.save'),account_ref:id,input:draftInput,deadline_ms:z.number().int().min(1000).max(120000).default(30000)}).strict();
const task=z.object({task_id:id}).strict(),empty=z.object({}).strict();
const notImplemented={implemented:false,readOnly:false};
export const tools={
  runtime_health:{schema:empty,implemented:true,readOnly:true},
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
  runtime_terminal_start:{schema:z.object({request_id:id}).strict(),...notImplemented},
  runtime_terminal_status:{schema:z.object({session_ref:id}).strict(),...notImplemented},
  runtime_terminal_submit_prompt:{schema:z.object({request_id:id,session_ref:id,expected_generation:z.number().int().positive(),expected_previous_turn_id:id,prompt:z.string().max(8000)}).strict(),...notImplemented},
  runtime_terminal_resume:{schema:z.object({session_ref:id,expected_generation:z.number().int().positive()}).strict(),...notImplemented},
  runtime_terminal_interrupt:{schema:z.object({session_ref:id,expected_generation:z.number().int().positive()}).strict(),...notImplemented},
  runtime_browser_session_open:{schema:z.object({request_id:id}).strict(),...notImplemented},
  runtime_browser_session_status:{schema:z.object({session_ref:id}).strict(),...notImplemented},
} as const;
export const draftManifest={id:FIXTURE_DRAFT.id,version:1,input_schema:z.toJSONSchema(draftInput),effect:'write_external',
  constraints:{allow_user_target:false,allow_foreground:false,allow_os_input:false,environment:'fixture'},
  routes:[FIXTURE_DRAFT.route],verification:{type:'independent_readback',account_required:true},recovery:{mode:'reconcile_no_blind_retry'},
  status:'test_only',verified_for_environment:'owned_headless_fixture'};
export type StartRequest=z.infer<typeof startRequest>;
