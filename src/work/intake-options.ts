import {type PackStore} from '../packs/store.js';
import {requireCondition} from '../core/contracts.js';

export interface WorkIntakeOptions {completion_condition:string|null;delivery_target_ids:string[]|null;}
function init(store:PackStore){store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_intake_options(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,body TEXT NOT NULL);`);}
/** User input is saved separately from model-generated plans and never grants tool authority. */
export function bindWorkIntakeOptions(store:PackStore,project:string,workId:string,input:WorkIntakeOptions){
  init(store);store.officeWorkById(project,workId);
  const body=JSON.stringify(input),prior=store.hermesState.prepare('SELECT body FROM office_intake_options WHERE project_id=? AND work_id=?').get(project,workId);
  if(prior){requireCondition(prior.body===body,'WORK_REQUEST_ID_CONFLICT');return;}
  store.hermesState.prepare('INSERT INTO office_intake_options VALUES(?,?,?)').run(workId,project,body);
}
export function readWorkIntakeOptions(store:PackStore,project:string,workId:string):WorkIntakeOptions{
  const exists=store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_intake_options'").get();
  const row=exists?store.hermesState.prepare('SELECT body FROM office_intake_options WHERE project_id=? AND work_id=?').get(project,workId):null;
  return row?JSON.parse(String(row.body)) as WorkIntakeOptions:{completion_condition:null,delivery_target_ids:null};
}
