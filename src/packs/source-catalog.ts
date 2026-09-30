import {type HostConfig} from '../interface/config.js';
import {safeControlText} from '../observability/safe-text.js';
import {type Recipe,type Source} from './contracts.js';

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
