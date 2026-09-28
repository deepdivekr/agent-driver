import {constants,type Stats} from 'node:fs';
import {lstat,open} from 'node:fs/promises';

/** O_NOFOLLOW is not portable to Windows. Check the leaf before and after
 * opening, and bind the open handle to that same singly-linked regular file.
 * The containing directory must still be owned by the runtime: this is not a
 * substitute for OS access control against an adversarial directory owner.
 */
export async function openDecisionAppend(path:string,bytes:number,unsafe:string){
  const regular=(stat:Stats)=>{
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size+bytes>67_108_864)throw Error(unsafe);
  };
  try{regular(await lstat(path));}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
  const handle=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
    const descriptor=await handle.stat(),leaf=await lstat(path);regular(descriptor);regular(leaf);
    if(descriptor.dev!==leaf.dev||descriptor.ino!==leaf.ino)throw Error(unsafe);
    return handle;
  }catch(error){await handle.close();throw error;}
}
