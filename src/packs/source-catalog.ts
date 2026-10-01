import {type HostConfig} from '../interface/config.js';
import {safeControlText} from '../observability/safe-text.js';
import {type Recipe,type Source} from './contracts.js';
import {type PackStore} from './store.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {PACK_ENGINE_VERSION} from './engine-version.js';

export interface DeclaredSourceContractIssue {
  source_id:string;missing_fields:string[];declared_fields:string[];registration_not_observation:true;
}

/** Check only registered projections. Files and unprojected HTTP responses
 * have no declared row schema and still require actual observations. */
export function declaredSourceContractIssues(recipe:Recipe,sources:readonly Source[]):DeclaredSourceContractIssue[]{
  if(!('sources' in recipe))return [];
  const required=new Set([...recipe.filters.map(filter=>filter.field),...recipe.deduplicate_by]);
  if('sort' in recipe&&recipe.sort)required.add(recipe.sort.field);
  if('columns' in recipe&&recipe.columns)for(const column of recipe.columns)required.add(column);
  if('numeric_columns' in recipe)for(const column of recipe.numeric_columns)required.add(column);
  if('verification' in recipe&&recipe.verification)for(const check of recipe.verification){
    required.add(check.source_field);
    required.add(check.kind==='citation'?check.claim_field:check.value_field);
    if(check.kind!=='literal_copy')required.add(check.quote_field);
  }
  if(recipe.family==='monitor.watch'){
    for(const column of recipe.comparison_fields)required.add(column);
    if(recipe.value_field)required.add(recipe.value_field);
  }
  return recipe.sources.flatMap(requested=>{
    const source=sources.find(value=>value.id===requested.id);
    const declared=source?.kind==='browser'?Object.keys(source.columns):source?.kind==='http'?source.json_fields:undefined;
    if(!declared)return [];
    const missing=[...required].filter(column=>!declared.includes(column));
    // Search intentionally ORs across fields. A source need not expose every
    // alternative; an empty query does not inspect those fields at all.
    if(recipe.family==='research.search'&&recipe.query.trim()&&!recipe.search_fields.some(column=>declared.includes(column))){
      for(const column of recipe.search_fields)if(!missing.includes(column))missing.push(column);
    }
    return missing.length?[{source_id:requested.id,missing_fields:missing,declared_fields:[...declared],registration_not_observation:true as const}]:[];
  });
}

export class DeclaredSourceContractError extends Error {
  readonly code='PACK_DECLARED_SOURCE_FIELD_MISSING';
  readonly not_dispatched=true;
  constructor(readonly issues:DeclaredSourceContractIssue[]){super('PACK_DECLARED_SOURCE_FIELD_MISSING');this.name='DeclaredSourceContractError';}
}

/** Registered source descriptors are candidates, not observations or permission.
 * No file paths, selectors, query values or account identifiers enter a model.
 */
export function connectedSourceCatalog(config:HostConfig){
  return (config.packs?.sources??[]).map(source=>{
    const declaredColumns=source.kind==='browser'?Object.keys(source.columns):source.kind==='http'?source.json_fields??[]:[];
    let publicLocation:string|null=null;
    if(source.kind!=='file'){
      try{
        const url=new URL(source.url);
        if(!url.username&&!url.password&&['https:','http:'].includes(url.protocol)){
          url.search='';url.hash='';
          publicLocation=safeControlText(url.href,400);
        }
      }catch{/* Configuration registration is not a successful source read. */}
    }
    return {id:source.id,kind:source.kind,registration:'configured' as const,observation:'not_asserted' as const,
      ...(source.kind==='file'||source.kind==='http'?{format:source.format}:{}),
      ...(source.kind!=='file'?{public_location:publicLocation,parameter_names:source.parameters}:{}),
      declared_columns:declaredColumns.filter(name=>!/(?:password|token|secret|api.?key|auth|session|cookie)/iu.test(name)).map(name=>safeControlText(name,120)),
      ...(source.numeric_columns?{numeric_columns:source.numeric_columns.filter(name=>!/(?:password|token|secret|api.?key|auth|session|cookie)/iu.test(name)).map(name=>safeControlText(name,120))}:{}),
      ...(source.kind==='browser'?{auth_required:source.auth_required}:{}),
    };
  });
}

/** Retained same-Work source schemas for an explicit replan. Names only: no
 * source values, paths or claim of current upstream freshness/whole-site scope.
 * This is context, never a seal or a replacement for actual completion proof. */
export function observedWorkSourceSchemas(store:PackStore,config:HostConfig,workId:string){
  const schemas:Array<{source_id:string;run_id:string;observed_at:string;fields:string[];scope:'saved_response_rows';freshness:'historical_only'}>=[];
  const seen=new Set<string>(),project=config.project.id;
  for(const owned of store.officeRuns(project,workId).slice(0,32)){
    if(owned.source_kind!=='pack')continue;
    try{
      const run=store.packRun(project,owned.source_id);
      if(run.project_id!==project||!['succeeded','draft_ready','watching'].includes(run.status)||!('sources' in run.recipe)||
        (store.officeWork(project,'pack',run.id) as {id:string}|null)?.id!==workId||
        run.binding!==snapshotHash({recipe:run.recipe,fingerprint:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})}))continue;
      const snapshots=store.packExecution(project,run.id)?.checkpoint.sources;
      if(!snapshots||typeof snapshots!=='object'||Array.isArray(snapshots))continue;
      for(const [index,requested] of run.recipe.sources.entries()){
        if(seen.has(requested.id)||!config.packs?.sources.some(source=>source.id===requested.id))continue;
        const saved=(snapshots as Record<string,unknown>)[String(index)] as {digest?:string;result?:{rows?:unknown[];evidence?:{source_id?:string;request_sha256?:string;rows?:number;observed_at?:string}}}|undefined;
        const result=saved?.result,evidence=result?.evidence,rows=result?.rows;
        if(!result||!Array.isArray(rows)||!rows.length||!evidence||saved?.digest!==snapshotHash(result)||evidence.source_id!==requested.id||
          evidence.request_sha256!==snapshotHash(requested)||evidence.rows!==rows.length||!evidence.observed_at||!Number.isFinite(Date.parse(evidence.observed_at))||
          rows.some(row=>row===null||typeof row!=='object'||Array.isArray(row)))continue;
        const fields=Object.keys(rows[0] as object).filter(field=>rows.every(row=>Object.hasOwn(row as object,field))&&
          field.length<=120&&!/(?:password|token|secret|api.?key|auth|session|cookie)/iu.test(field)).slice(0,128);
        if(!fields.length)continue;
        schemas.push({source_id:requested.id,run_id:run.id,observed_at:evidence.observed_at,fields,scope:'saved_response_rows',freshness:'historical_only'});
        seen.add(requested.id);if(schemas.length>=8)return schemas;
      }
    }catch{/* Missing/stale/corrupt retained context is not execution authority. */}
  }
  return schemas;
}
