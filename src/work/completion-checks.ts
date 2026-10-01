import {z} from 'zod';

const column=z.string().min(1).max(120).refine(value=>!['__proto__','constructor','prototype'].includes(value));
const columns=z.array(column).max(100).refine(values=>new Set(values).size===values.length,'Duplicate native completion column');

/** Explicit saved technical expectations. These are not a description of the
 * user's complete business goal; the original-request gate remains separate. */
const nativeOutputPredicateSchema=z.object({
  version:z.literal(1),kind:z.literal('native_pack_output'),
  family:z.enum(['portal.collect','file.pipeline']),format:z.enum(['csv','json']),
  columns,output_rows:z.union([z.number().int().min(0),z.literal('observed_source_rows')]),
  numeric_columns:columns,sort:z.object({field:column,direction:z.enum(['asc','desc'])}).strict().nullable(),
}).strict().superRefine((value,context)=>{
  if(value.format==='csv'&&value.columns.length===0)context.addIssue({code:'custom',path:['columns'],message:'CSV native completion requires columns'});
  if(value.family==='portal.collect'&&(value.numeric_columns.length>0||value.sort!==null))context.addIssue({code:'custom',message:'Portal native completion cannot declare file transformations'});
  if(value.numeric_columns.some(field=>!value.columns.includes(field)))context.addIssue({code:'custom',path:['numeric_columns'],message:'Numeric columns must be output columns'});
});
const nativeWatchPredicateSchema=z.object({
  version:z.literal(1),kind:z.literal('native_watch_observations'),family:z.literal('monitor.watch'),
  mode:z.enum(['any_change','minimum_decreases']),comparison_fields:columns.refine(fields=>fields.length>0&&fields.length<=20),
  value_field:column.nullable(),expected_change:z.enum(['changed','unchanged']),
  minimum_elapsed_seconds:z.number().int().min(0).max(2592000),
}).strict().superRefine((value,context)=>{
  if(value.mode==='minimum_decreases'&&(value.value_field===null||value.comparison_fields.includes(value.value_field)))context.addIssue({code:'custom',path:['value_field'],message:'Minimum-decrease watch requires a separate numeric value field'});
});
export const nativeCompletionPredicateSchema=z.discriminatedUnion('kind',[nativeOutputPredicateSchema,nativeWatchPredicateSchema]);
export type NativeCompletionPredicate=z.infer<typeof nativeCompletionPredicateSchema>;
export type NativeWatchCompletionPredicate=Extract<NativeCompletionPredicate,{kind:'native_watch_observations'}>;

// Fixed host-rendered text cannot attach native authority to arbitrary model
// prose. The exact expectations remain visible in the typed native_check.
export const NATIVE_COMPLETION_RESULT='The saved native Pack output matches the declared family, format, exact columns and output row count, including the declared numeric columns and sort. This verifies saved observations and local artifact bytes only.';
export const NATIVE_COMPLETION_EVIDENCE='A fresh host certificate for the same Work-bound Pack run, reconstructed from bound source checkpoints and checked against exact local artifact bytes. User-goal semantics and remote-source freshness are not asserted.';
export const NATIVE_SOURCE_ROWS_COMPLETION_RESULT='The saved native Pack output matches the declared family, format and exact columns, and its output row count equals the actual observed source row count for this execution, including the declared numeric columns and sort. This verifies saved observations and local artifact bytes only.';
export const NATIVE_WATCH_COMPLETION_RESULT='Two saved source observations of the same Work-bound watch match the declared comparison fields, mode, value field, minimum elapsed time and change result. The host recomputes the comparison and checks any corresponding local change event.';
export const NATIVE_WATCH_COMPLETION_EVIDENCE='The bound baseline source checkpoints and a committed current-cycle watch observation, linked to its observed tick receipt and matching local event when changed. This does not prove external-notification absence or current remote freshness.';
export function nativeCompletionCheck(id:string,predicate:NativeCompletionPredicate){
  const parsed=nativeCompletionPredicateSchema.parse(predicate),watch=parsed.kind==='native_watch_observations';
  const result=parsed.kind==='native_watch_observations'?NATIVE_WATCH_COMPLETION_RESULT:parsed.output_rows==='observed_source_rows'?NATIVE_SOURCE_ROWS_COMPLETION_RESULT:NATIVE_COMPLETION_RESULT;
  return {id,result,evidence:watch?NATIVE_WATCH_COMPLETION_EVIDENCE:NATIVE_COMPLETION_EVIDENCE,native_check:parsed};
}
export function nativeCompletionTextIsCanonical(check:{result:string;evidence:string;native_check?:NativeCompletionPredicate|undefined}){
  if(!check.native_check)return true;
  const predicate=check.native_check,watch=predicate.kind==='native_watch_observations';
  const result=predicate.kind==='native_watch_observations'?NATIVE_WATCH_COMPLETION_RESULT:predicate.output_rows==='observed_source_rows'?NATIVE_SOURCE_ROWS_COMPLETION_RESULT:NATIVE_COMPLETION_RESULT;
  return check.result===result&&check.evidence===(watch?NATIVE_WATCH_COMPLETION_EVIDENCE:NATIVE_COMPLETION_EVIDENCE);
}
