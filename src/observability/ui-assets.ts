import {readFile} from 'node:fs/promises';
import {type IncomingMessage,type ServerResponse} from 'node:http';

export const pretendardAsset='fonts/pretendard-1.3.9.woff2';
let font:Promise<Buffer>|undefined;
/** Called only behind the Control Center's host/capability check. No arbitrary paths. */
export async function serveUiAsset(request:IncomingMessage,response:ServerResponse,suffix:string){
  if(suffix!==pretendardAsset)return false;
  if(!['GET','HEAD'].includes(request.method??'')){
    response.writeHead(405,{allow:'GET, HEAD','cache-control':'no-store'});response.end();return true;
  }
  try{
    font??=readFile(new URL('../../assets/fonts/PretendardVariable.woff2',import.meta.url));
    const data=await font;
    response.writeHead(200,{'content-type':'font/woff2','content-length':data.length,'cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'});
    response.end(request.method==='HEAD'?undefined:data);
  }catch{
    font=undefined;response.writeHead(503,{'cache-control':'no-store'});response.end();
  }
  return true;
}
