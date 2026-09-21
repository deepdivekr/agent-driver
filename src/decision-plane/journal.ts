import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';
import {decisionEventSchema,type DecisionEvent,stableJson} from './contracts.js';

const decisionId=z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u),eventId=z.string().uuid();
export const decisionLabelSplit=z.enum(['unassigned','train','holdout','audit']);
export const decisionLabelSchema=z.object({
  format:z.literal(1),event_id:eventId,question_id:z.string().min(1).max(160),decision_id:decisionId,
  correct:z.boolean(),expected:z.union([z.string().max(512),z.number().finite(),z.boolean(),z.null()]).optional(),
  source:z.enum(['readback','human','fixture']),evidence_level:z.enum(['fixture','user_environment']),split:decisionLabelSplit,labeled_at:z.string().datetime({offset:true}),
}).strict();
export type DecisionLabel=z.infer<typeof decisionLabelSchema>;
export type DecisionLabelInput=Pick<DecisionLabel,'question_id'|'decision_id'|'correct'|'source'|'evidence_level'> & Partial<Pick<DecisionLabel,'expected'|'split'>>;
export interface DecisionJournal {append(event:DecisionEvent):Promise<void>;label(eventId:string,label:DecisionLabelInput):Promise<void>;}

function makeLabel(rawId:string,label:DecisionLabelInput):DecisionLabel{return decisionLabelSchema.parse({format:1,event_id:eventId.parse(rawId),...label,split:label.split??'unassigned',labeled_at:new Date().toISOString()});}
export class MemoryDecisionJournal implements DecisionJournal {
  readonly events:DecisionEvent[]=[];readonly labels:DecisionLabel[]=[];
  async append(event:DecisionEvent){this.events.push(structuredClone(decisionEventSchema.parse(event)));}
  async label(rawId:string,label:DecisionLabelInput){this.labels.push(makeLabel(rawId,label));}
}
export class FileDecisionJournal implements DecisionJournal {
  constructor(readonly eventsPath:string,readonly labelsPath=eventsPath.replace(/\.jsonl$/u,'.labels.jsonl')){}
  private async write(path:string,value:unknown){
    await mkdir(dirname(path),{recursive:true,mode:0o700});const line=stableJson(value)+'\n',handle=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size+Buffer.byteLength(line)>67_108_864)throw Error('DECISION_JOURNAL_UNSAFE');await handle.write(line);await handle.sync();}finally{await handle.close();}
  }
  async append(event:DecisionEvent){await this.write(this.eventsPath,decisionEventSchema.parse(event));}
  async label(rawId:string,label:DecisionLabelInput){await this.write(this.labelsPath,makeLabel(rawId,label));}
}
export class CompositeDecisionJournal implements DecisionJournal {
  constructor(readonly journals:DecisionJournal[]){if(journals.length<1)throw Error('DECISION_JOURNAL_REQUIRED');}
  async append(event:DecisionEvent){for(const journal of this.journals)await journal.append(event);}
  async label(eventId:string,label:DecisionLabelInput){for(const journal of this.journals)await journal.label(eventId,label);}
}

async function lines(path:string,maxBytes:number){
  try{
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maxBytes)throw Error('DECISION_JOURNAL_UNSAFE');
    const text=await readFile(path,'utf8');if(text.length>maxBytes)throw Error('DECISION_JOURNAL_UNSAFE');
    const rows=text.split('\n').filter(Boolean);if(rows.some(row=>Buffer.byteLength(row)>1_048_576))throw Error('DECISION_JOURNAL_LINE_TOO_LARGE');return rows;
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return [];throw error;}
}
export interface DecisionJournalAudit {events:DecisionEvent[];labels:DecisionLabel[];valid_labels:DecisionLabel[];errors:{code:string;key:string}[];}
/** Reads only bounded, singly-linked regular files. Invalid or ambiguous labels are retained as errors but never enter valid_labels. */
export async function auditDecisionJournal(eventsPath:string,labelsPath=eventsPath.replace(/\.jsonl$/u,'.labels.jsonl'),maxBytes=67_108_864):Promise<DecisionJournalAudit>{
  const eventRows=await lines(eventsPath,maxBytes),labelRows=await lines(labelsPath,maxBytes),events:DecisionEvent[]=[],labels:DecisionLabel[]=[],errors:DecisionJournalAudit['errors']=[];
  const byEvent=new Map<string,DecisionEvent>();
  for(const [index,row] of eventRows.entries())try{const event=decisionEventSchema.parse(JSON.parse(row));if(byEvent.has(event.event_id)){errors.push({code:'DUPLICATE_EVENT',key:event.event_id});continue;}byEvent.set(event.event_id,event);events.push(event);}catch{errors.push({code:'INVALID_EVENT',key:String(index+1)});}
  const candidates=new Map<string,DecisionLabel[]>();
  for(const [index,row] of labelRows.entries())try{
    const label=decisionLabelSchema.parse(JSON.parse(row));labels.push(label);const event=byEvent.get(label.event_id),judgment=event?.judgments.find(item=>item.question_id===label.question_id&&item.decision_id===label.decision_id);
    if(!event){errors.push({code:'ORPHAN_LABEL',key:label.event_id});continue;}if(!judgment){errors.push({code:'LABEL_BINDING_MISMATCH',key:`${label.event_id}:${label.question_id}`});continue;}
    const key=`${label.event_id}:${label.question_id}:${label.split}`,group=candidates.get(key)??[];group.push(label);candidates.set(key,group);
  }catch{errors.push({code:'INVALID_LABEL',key:String(index+1)});}
  const valid_labels:DecisionLabel[]=[];
  for(const [key,group] of candidates){if(group.length!==1){errors.push({code:group.some(a=>group.some(b=>a.correct!==b.correct||a.expected!==b.expected))?'CONFLICTING_LABEL':'DUPLICATE_LABEL',key});continue;}valid_labels.push(group[0]!);}
  return {events,labels,valid_labels,errors};
}
