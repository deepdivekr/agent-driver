import {type HostConfig} from '../interface/config.js';
import {safeControlText} from '../observability/safe-text.js';

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
      ...(source.kind==='browser'?{auth_required:source.auth_required}:{}),
    };
  });
}
