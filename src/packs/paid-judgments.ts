import {type PackStore} from './store.js';

/** Calls to the paid judgment API (Jev) per local day, shared by every place that asks it. */
const day=()=>{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;};
const init=(store:PackStore)=>store.hermesState.exec('CREATE TABLE IF NOT EXISTS office_paid_judgment(project_id TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(project_id,day))');
export function paidJudgmentsToday(store:PackStore,project:string):number{
  init(store);return Number((store.hermesState.prepare('SELECT calls FROM office_paid_judgment WHERE project_id=? AND day=?').get(project,day()) as {calls:number}|undefined)?.calls??0);
}
export function countPaidJudgment(store:PackStore,project:string,calls=1):void{
  init(store);store.hermesState.prepare('INSERT INTO office_paid_judgment(project_id,day,calls) VALUES(?,?,?) ON CONFLICT(project_id,day) DO UPDATE SET calls=calls+excluded.calls').run(project,day(),calls);
}
