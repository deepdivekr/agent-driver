import {type IncomingMessage,type ServerResponse} from 'node:http';
import {type FileExplorer} from '../files/explorer.js';

/** Human actions in an existing Work. No standalone file page. */
export class FileExplorerRoutes {
  constructor(readonly files:FileExplorer){}
  async handle(request:IncomingMessage,response:ServerResponse,suffix:string,host:string){
    if(suffix!=='files'&&!suffix.startsWith('files/'))return false;
    const send=(status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value));};
    if(request.headers.host!==host){send(403,{error:'FILES_FORBIDDEN'});return true;}
    if(suffix==='files'){send(404,{error:'FILES_USE_WORK_DETAIL'});return true;}
    if(request.method!=='POST'){send(405,{error:'FILES_METHOD_INVALID'});return true;}
    if(request.headers.origin!=='http://'+host||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){send(403,{error:'FILES_FORBIDDEN'});return true;}
    try{let body='';for await(const chunk of request){body+=String(chunk);if(Buffer.byteLength(body)>30_000)throw Error('FILES_REQUEST_TOO_LARGE');}
      const input=JSON.parse(body),action=suffix.slice(6),files=this.files;
      if(!['grant','apply','undo','report','revoke'].includes(action)){send(404,{error:'FILES_ROUTE_UNKNOWN'});return true;}
      if(['apply','undo'].includes(action))files.workPlan({work_id:input.work_id,plan_id:input.plan_id});
      const result=action==='grant'?files.grantRequest(input):action==='revoke'?files.revokeRequest(input):action==='report'?files.report(input):files.apply({plan_id:input.plan_id},action==='undo');
      send(200,result);
    }catch(error){send(409,{error:error instanceof Error&&/^FILES_[A-Z_]+$/u.test(error.message)?error.message:'FILES_IO_FAILED'});}
    return true;
  }
}
