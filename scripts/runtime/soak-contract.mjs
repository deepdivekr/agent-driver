import {z} from 'zod';
export const soakConfig=z.object({
 schema_version:z.literal(1),output_dir:z.string().min(1),
 duration_ms:z.number().int().min(1000).max(72*60*60*1000),
 interval_ms:z.number().int().min(0).max(60000).default(15000),
 max_cycles:z.number().int().min(1).max(20000).default(1000),
 max_bytes:z.number().int().min(64*1048576).max(2*1024*1048576).default(512*1048576),
 cpu_percent:z.number().int().min(25).max(100).default(100),
 memory_mb:z.number().int().min(512).max(1024).default(768),
 tasks_max:z.number().int().min(128).max(512).default(256)
}).strict();
export const schedule=['normal','claimed','normal','prepare','normal','after_save','normal','cli_resume','normal','cli_crash','normal','supervisor_restart','normal','host_restart','normal','output_load'];
export function twoHourGate(duration,elapsed,state,cycles,seen){
 if(duration<7200000)return 'NOT_RUN';
 if(state==='failed')return 'FAIL';
 if(state!=='completed')return 'NOT_RUN';
 return Number.isFinite(elapsed)&&elapsed>=7200000&&cycles>=100&&schedule.every(s=>seen.includes(s))?'PASS':'FAIL';
}
export function percentile(values,p){if(!values.length)return 'unobserved';const v=[...values].sort((a,b)=>a-b);return v[Math.max(0,Math.ceil(v.length*p)-1)];}
export function metrics(cases,samples){
 const browser=cases.filter(c=>c.workload==='browser'),cli=cases.filter(c=>c.workload==='synthetic_cli');
 const eligible=browser.filter(c=>c.expected_outcome==='succeeded'),completed=browser.filter(c=>c.observed_status==='succeeded'&&c.record_matches===true&&c.effect_count===1);
 const waits=browser.filter(c=>c.expected_outcome==='reconciliation_required');
 const recovered=cases.filter(c=>c.recovery_ms!==undefined);
 const times=kind=>{const rows=recovered.filter(c=>c.recovery_kind===kind&&c.expected_outcome!=='reconciliation_required');return {count:rows.length,p50_ms:percentile(rows.map(c=>c.recovery_ms),.5),p95_ms:percentile(rows.map(c=>c.recovery_ms),.95)};};
 const resource=key=>samples.map(s=>s[key]).filter(Number.isFinite);
 return {
  task_success:{submitted:browser.length,completed:completed.length,overall_completion_rate:browser.length?completed.length/browser.length:'unobserved',eligible:eligible.length,eligible_success_rate:eligible.length?eligible.filter(c=>c.status==='PASS').length/eligible.length:'unobserved',scope:'synthetic draft, not shopping/coding domain certification',synthetic_cli_turns:cli.length,synthetic_cli_pass:cli.filter(c=>c.status==='PASS').length,actual_cli:'NOT_RUN'},
  interference:{status:'NOT_RUN',windows_foreground:'unobserved',wrong_target:browser.filter(c=>c.account_sentinel_ok===false).length},
  false_success_and_duplicates:{false_success:browser.filter(c=>c.observed_status==='succeeded'&&(c.record_matches!==true||c.effect_count!==1)).length,duplicate_effects:browser.reduce((n,c)=>n+(Number.isFinite(c.effect_count)?Math.max(0,c.effect_count-1):0),0),duplicate_cli_receipts:cli.reduce((n,c)=>n+(Number.isFinite(c.receipt_count)?Math.max(0,c.receipt_count-1):0),0),unobserved_effects:browser.filter(c=>!Number.isFinite(c.effect_count)).length},
  recovery:{automatic_recovery:recovered.filter(c=>c.recovery_kind==='automatic'&&c.expected_outcome==='succeeded'&&c.status==='PASS').length,explicit_resume:recovered.filter(c=>c.recovery_kind==='explicit'&&c.status==='PASS').length,correct_stops:waits.filter(c=>c.status==='PASS').length,failed_cases:cases.filter(c=>c.status==='FAIL').length,harness_actions:cases.reduce((n,c)=>n+(c.harness_actions??0),0)},
  recovery_time:{count:recovered.length,p50_ms:percentile(recovered.map(c=>c.recovery_ms),.5),p95_ms:percentile(recovered.map(c=>c.recovery_ms),.95),automatic:times('automatic'),explicit:times('explicit'),definition:'Aggregate includes correct-stop latency; split recovery populations exclude correct stops. Browser starts after owned fault death and dependency clear; CLI starts before interrupt/host fault. Explicit approval delay included.'},
  interventions:{technical_manual:'unobserved',authentication:'N/A',approval:'scripted fixture only',scope:'No certification of out-of-band human activity, actual login or real orchestrator autonomy'},
  resources:{samples:samples.length,memory_peak_sample_bytes:resource('memory_current').length?Math.max(...resource('memory_current')):'unobserved',tasks_peak_sample:resource('tasks_current').length?Math.max(...resource('tasks_current')):'unobserved',data_bytes_last:samples.at(-1)?.data_bytes??'unobserved',handles:'unobserved',tabs:'unobserved',long_term_leak_free:'unverified'}
 };
}
