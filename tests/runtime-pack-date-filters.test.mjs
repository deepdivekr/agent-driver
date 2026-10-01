import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {filterSchema,parsePackDate} from '../dist/packs/contracts.js';
import {applyFilters} from '../dist/packs/data.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';

const rows=[
  {id:'before',when:'2024-02-28T14:59:59.999Z'},
  {id:'kst-boundary',when:'2024-02-28T15:00:00Z'},
  {id:'date-only',when:'2024-02-29'},
  {id:'day-end',when:'2024-02-29T23:59:59.999Z'},
  {id:'next-day',when:'2024-03-01T00:00:00Z'},
];
const filter=(op,value)=>({field:'when',op,value});
const ids=filters=>applyFilters(rows,filters).map(row=>row.id);

test('date filters compare exact UTC calendar days or explicit-offset instants, including leap day end',()=>{
  assert.deepEqual(ids([filter('date_gte','2024-02-29')]),['date-only','day-end','next-day']);
  assert.deepEqual(ids([filter('date_lt','2024-03-01')]),['before','kst-boundary','date-only','day-end']);
  assert.deepEqual(ids([filter('date_lte','2024-02-29')]),['before','kst-boundary','date-only','day-end']);
  assert.deepEqual(ids([filter('date_gte','2024-02-29T00:00:00+09:00')]),['kst-boundary','date-only','day-end','next-day']);
  assert.deepEqual(ids([filter('date_lt','2024-02-29T00:00:00+09:00')]),['before']);
  assert.deepEqual(ids([filter('date_lte','2024-02-28T15:00:00.000Z')]),['before','kst-boundary']);
  assert.deepEqual(applyFilters([{n:2},{n:10}],[{field:'n',op:'gte',value:3}]),[{n:10}],'existing numeric filtering remains unchanged');
  assert.deepEqual(parsePackDate('2024-02-29'),{epoch_ms:Date.UTC(2024,1,29),date_only:true});
});

test('invalid calendar dates, ambiguous local times and numeric epoch guesses are rejected by schema and execution',()=>{
  for(const value of ['2023-02-29','2024-02-30','2024-13-01','0000-01-01','2024-02-29T00:00:00','2024-02-29T24:00:00Z','2024-02-29T00:60:00Z','2024-02-29T00:00:60Z','2024-02-29T00:00:00+24:00','2024-02-29T00:00:00-00:00','2024-02-29T00:00:00.1234Z',1709164800000]){
    assert.equal(filterSchema.safeParse(filter('date_gte',value)).success,false,String(value));
    assert.equal(parsePackDate(value),null,String(value));
  }
  assert.throws(()=>applyFilters([{when:'2024-02-30'}],[filter('date_lt','2024-03-01')]),/SOURCE_DATE_VALUE_INVALID/u);
  assert.throws(()=>applyFilters([{when:1709164800000}],[filter('date_lt','2024-03-01')]),/SOURCE_DATE_VALUE_INVALID/u);
  assert.throws(()=>applyFilters([{id:'missing'}],[filter('date_lt','2024-03-01')]),/SOURCE_DATE_FIELD_MISSING/u);
  assert.throws(()=>applyFilters(rows,[filter('date_gte','2024-02-30')]),/FILTER_DATE_BOUND_INVALID/u);
});

test('actual file Pack and fresh native certificate reuse the same strict date filter result without a model call',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pack-date-filter-')),source=join(root,'rows.json'),host=join(root,'host.json');
  await writeFile(source,JSON.stringify(rows));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'pack-date-filter-test',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'dated',kind:'file',path:source,format:'json'}],targets:[]}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);initWorkExecution(api.store);
  const prompt='Save source rows from the UTC leap day inclusive through the end of that day.';
  const spec={title:'UTC date filter',desired_outcome:prompt,completion_checks:[{id:'date_rows',result:'Two observed rows from UTC leap day',evidence:'Pack artifact readback'}],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write')};
  const started=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,started.work.id),saved=api.store.finishWorkDefinition(config.project.id,started.work.id,owner,spec,[],'ready');
  const toolkit=new WorkExecutionTools(api.store,config,api,saved.id,randomUUID(),spec,prompt,()=>{},{async call(){assert.fail('Date filtering must not call a model.');}});
  t.after(async()=>{await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const recipe={version:1,family:'file.pipeline',request:prompt,sources:[{id:'dated',parameters:{}}],filters:[filter('date_gte','2024-02-29'),filter('date_lte','2024-02-29')],deduplicate_by:['id'],columns:['id','when'],numeric_columns:[],sort:{field:'when',direction:'asc'},format:'json'};
  const run=await toolkit.execute('runtime_pack_run',{recipe},'date-pack-run');assert.equal(run.status,'succeeded');
  assert.deepEqual(JSON.parse(await readFile(run.result.artifact.path,'utf8')).map(row=>row.id),['date-only','day-end']);
  const value=await toolkit.execute('runtime_pack_status',{run_id:run.run_id},'date-pack-status'),receipt=await toolkit.receipt('runtime_pack_status',value,'date-pack-status');
  assert.equal(receipt.value.native_output_certificate?.exact_native_bytes_match,true);
  assert.equal(receipt.value.native_output_certificate.observed_source_rows,5);
  assert.equal(receipt.value.native_output_certificate.filtered_rows,2);
  assert.equal(receipt.value.saved_source_readback.source_rows_complete,true);
  assert.equal(receipt.value.saved_source_readback.user_goal_verified,'not_asserted','technical date filtering does not decide the original user goal');
});
