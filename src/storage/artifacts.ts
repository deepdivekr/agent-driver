import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';

export interface ArtifactManifest {directory:'terminal-spool'|'terminal-handoffs';filename:string;root_identity:string;directory_identity:string;file_identity:string;bytes:number;sha256:string}
export const fileIdentity=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`;
const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
export function withArtifactDirectory<T>(database:string,directory:ArtifactManifest['directory'],fn:(fd:number,rootIdentity:string,directoryIdentity:string)=>T):T {
  requireCondition(['terminal-spool','terminal-handoffs'].includes(directory),'STORAGE_ARTIFACT_SCOPE');
  const path=resolve(dirname(database));requireCondition(realpathSync(path)===path,'STORAGE_ROOT_REDIRECTED');
  const root=openSync(path,flags);
  try {
    const rootIdentity=fileIdentity(fstatSync(root,{bigint:true})),dir=openSync(`/proc/self/fd/${root}/${directory}`,flags);
    try {
      const result=fn(dir,rootIdentity,fileIdentity(fstatSync(dir,{bigint:true})));
      requireCondition(fileIdentity(lstatSync(path,{bigint:true}))===rootIdentity,'STORAGE_ROOT_CHANGED');
      return result;
    }finally{closeSync(dir);}
  }finally{closeSync(root);}
}
export function captureArtifact(fd:number,directory:ArtifactManifest['directory'],filename:string,rootIdentity:string,directoryIdentity:string):ArtifactManifest {
  requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,200}$/.test(filename),'STORAGE_ARTIFACT_SCOPE');
  const before=fstatSync(fd,{bigint:true});requireCondition(before.isFile()&&before.nlink===1n&&before.size<=16777216n,'STORAGE_ARTIFACT_UNSAFE');
  // fd must be opened for read at position zero by the caller.
  const content=readFileSync(fd),after=fstatSync(fd,{bigint:true});
  requireCondition(content.length===Number(before.size)&&before.size===after.size&&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs,'STORAGE_ARTIFACT_CHANGED');
  return {directory,filename,root_identity:rootIdentity,directory_identity:directoryIdentity,file_identity:fileIdentity(before),bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};
}
export function observeArtifact(database:string,directory:ArtifactManifest['directory'],filename:string) {
  return withArtifactDirectory(database,directory,(dir,rootIdentity,directoryIdentity)=>{
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,200}$/.test(filename),'STORAGE_ARTIFACT_SCOPE');
    const fd=openSync(`/proc/self/fd/${dir}/${filename}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{return captureArtifact(fd,directory,filename,rootIdentity,directoryIdentity);}finally{closeSync(fd);}
  });
}
