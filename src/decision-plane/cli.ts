import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {catalogHash,decisionCatalogSchema,type DecisionCatalog} from './contracts.js';
import {auditDecisionJournal,FileDecisionJournal} from './journal.js';
import {buildDecisionDataset,decisionOperationsReport} from './operations.js';
import {fitDecisionCalibration} from './calibration.js';
import {DecisionProfileRegistry,decisionProfileScope} from './registry.js';

export const decisionHelp=`Decision Plane operator commands (local shell only):
  decision status --root ABS --catalog FILE --scope fixture|production
  decision report --events FILE --labels FILE --catalog FILE --model MODEL
  decision fit --root ABS --events FILE --labels FILE --catalog FILE --model MODEL --target-precision N --min-train N --min-holdout N
  decision promote --root ABS --catalog FILE --profile SHA256 --scope fixture|production
  decision rollback --root ABS --catalog FILE --scope fixture|production
  decision label --catalog FILE --events FILE --labels FILE --event UUID --question ID --decision-id ID --correct true|false --source human|fixture|readback --evidence fixture|user_environment --split train|holdout|audit|unassigned
`;
function argsMap(args:string[]){const map=new Map<string,string>();for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key?.startsWith('--')||!value||value.startsWith('--')||map.has(key))throw Error('INVALID_OPTIONS');map.set(key,value);}return map;}
function required(map:Map<string,string>,key:string){const value=map.get(key);if(!value)throw Error(`MISSING_${key.slice(2).replaceAll('-','_').toUpperCase()}`);return value;}
function catalog(path:string):DecisionCatalog{if(statSync(path).size>1_048_576)throw Error('DECISION_CATALOG_TOO_LARGE');return decisionCatalogSchema.parse(JSON.parse(readFileSync(path,'utf8')));}
function number(map:Map<string,string>,key:string){const value=Number(required(map,key));if(!Number.isFinite(value))throw Error('INVALID_NUMBER');return value;}
function print(value:unknown){console.log(JSON.stringify(value));}

export async function runDecisionCli(args:string[]):Promise<boolean>{
  if(args[0]!=='decision')return false;const command=args[1];if(!command||command==='help'){console.log(decisionHelp);return true;}const options=argsMap(args.slice(2)),allowed:Record<string,string[]>={status:['--root','--catalog','--scope'],report:['--events','--labels','--catalog','--model'],fit:['--root','--events','--labels','--catalog','--model','--target-precision','--min-train','--min-holdout'],promote:['--root','--catalog','--profile','--scope'],rollback:['--root','--catalog','--scope'],label:['--catalog','--events','--labels','--event','--question','--decision-id','--correct','--source','--evidence','--split']};
  if(!Object.hasOwn(allowed,command)||[...options.keys()].some(key=>!allowed[command]!.includes(key)))throw Error('INVALID_OPTIONS');const definition=catalog(required(options,'--catalog'));
  if(command==='status'){const root=required(options,'--root');if(!isAbsolute(root))throw Error('DECISION_REGISTRY_ABSOLUTE_REQUIRED');print(await new DecisionProfileRegistry(root).status(definition,decisionProfileScope.parse(required(options,'--scope'))));return true;}
  if(command==='promote'){print(await new DecisionProfileRegistry(required(options,'--root')).promote(definition,required(options,'--profile'),decisionProfileScope.parse(required(options,'--scope'))));return true;}
  if(command==='rollback'){print(await new DecisionProfileRegistry(required(options,'--root')).rollback(definition,decisionProfileScope.parse(required(options,'--scope'))));return true;}
  const events=required(options,'--events'),labels=required(options,'--labels');
  if(command==='label'){
    const audit=await auditDecisionJournal(events,labels),eventId=required(options,'--event'),question=required(options,'--question'),decisionId=required(options,'--decision-id');if(!audit.events.some(event=>event.event_id===eventId&&event.catalog_sha256===catalogHash(definition)&&event.judgments.some(item=>item.question_id===question&&item.decision_id===decisionId)))throw Error('DECISION_LABEL_TARGET_NOT_FOUND');
    const correct=required(options,'--correct');if(!['true','false'].includes(correct))throw Error('INVALID_BOOLEAN');const source=required(options,'--source'),evidence=required(options,'--evidence'),split=required(options,'--split');if(!['human','fixture','readback'].includes(source)||!['fixture','user_environment'].includes(evidence)||!['train','holdout','audit','unassigned'].includes(split))throw Error('INVALID_LABEL');
    await new FileDecisionJournal(events,labels).label(eventId,{question_id:question,decision_id:decisionId,correct:correct==='true',source:source as 'human'|'fixture'|'readback',evidence_level:evidence as 'fixture'|'user_environment',split:split as 'train'|'holdout'|'audit'|'unassigned'});print({labeled:true,event_id:eventId,question_id:question,decision_id:decisionId});return true;
  }
  const model=required(options,'--model'),audit=await auditDecisionJournal(events,labels),report=decisionOperationsReport(definition,model,audit);
  if(command==='report'){print(report);return true;}
  if(audit.errors.length)throw Error('DECISION_JOURNAL_AUDIT_FAILED');const dataset=buildDecisionDataset(definition,model,audit);if(dataset.dataset_evidence==='none')throw Error('DECISION_CALIBRATION_DATASET_EMPTY');
  const fit=fitDecisionCalibration(definition,model,dataset.examples.filter(item=>item.split==='train'),dataset.examples.filter(item=>item.split==='holdout'),{target_precision:number(options,'--target-precision'),min_train:number(options,'--min-train'),min_holdout:number(options,'--min-holdout'),evidence_level:dataset.dataset_evidence,dataset_sha256:dataset.dataset_sha256}),installed=await new DecisionProfileRegistry(required(options,'--root')).install(definition,fit.profile,{fit:fit.report,operations:report});print({candidate:true,profile_sha256:installed.profile_sha256,profile_status:fit.profile.status,evidence_level:fit.profile.evidence_level,report:fit.report});return true;
}
