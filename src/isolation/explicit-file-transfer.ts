import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,realpath,stat,unlink,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {requireCondition} from '../core/contracts.js';

export interface ExplicitWindowsFileTransferConfig {
  /** Private runtime artifact directory; it is fixed by the host, not a caller. */
  source_root:string;
  /** A dedicated Windows-visible output directory, mounted into the Linux host. */
  destination_root:string;
  max_file_bytes:number;
}

export interface ExplicitWindowsFileTransferRequest {
  task_id:string;
  /**
   * Source is a bounded relative path below the host-owned source root.
   * Destination is always a single filename below the fixed Windows root.
   */
  files:readonly {source_relative_path:string;destination_filename:string;sha256:string}[];
}

export interface ExplicitWindowsFileTransferReceipt {
  task_id:string;
  destination_root:string;
  files:readonly {source_relative_path:string;destination_filename:string;bytes:number;sha256:string;state:'transferred'|'already_present_verified'}[];
}

const taskId=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fileName=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.xlsx$/.test(value);
const relativeSourcePath=(value:string)=>value.length>0&&value.length<=480&&value.split('/').length<=4&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(part))&&fileName(value.split('/').at(-1)??'');
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const within=(root:string,target:string)=>{const path=relative(root,target);return path!==''&&!path.startsWith('../')&&!isAbsolute(path);};

function validateConfig(config:ExplicitWindowsFileTransferConfig){
  requireCondition(isAbsolute(config.source_root)&&isAbsolute(config.destination_root),'FILE_TRANSFER_ROOT_NOT_ABSOLUTE');
  requireCondition(resolve(config.source_root)!==resolve(config.destination_root),'FILE_TRANSFER_ROOTS_IDENTICAL');
  requireCondition(Number.isSafeInteger(config.max_file_bytes)&&config.max_file_bytes>=1&&config.max_file_bytes<=50*1024*1024,'FILE_TRANSFER_SIZE_LIMIT_INVALID');
}

async function directory(path:string,create:boolean){
  if(create)await mkdir(path,{recursive:true,mode:0o700});
  const observed=await lstat(path);
  requireCondition(observed.isDirectory()&&!observed.isSymbolicLink(),'FILE_TRANSFER_ROOT_UNSAFE');
  return realpath(path);
}

async function existing(path:string,expected:string){
  try {
    const observed=await lstat(path);
    requireCondition(observed.isFile()&&!observed.isSymbolicLink(),'FILE_TRANSFER_DESTINATION_UNSAFE');
    const content=await readFile(path);
    requireCondition(digest(content)===expected,'FILE_TRANSFER_DESTINATION_CONFLICT');
    return {bytes:content.length,sha256:expected,state:'already_present_verified' as const};
  } catch(error) {
    if(error&&typeof error==='object'&&'code' in error&&(error as {code?:string}).code==='ENOENT')return null;
    throw error;
  }
}

/**
 * Bounded, explicit WSL-to-Windows artifact transfer. It accepts only a
 * caller-predeclared list of hashes, never globbing or moving arbitrary host
 * files, and refuses overwrite unless the existing destination verifies equal.
 */
export class ExplicitWindowsFileTransferExecutor {
  constructor(readonly config:ExplicitWindowsFileTransferConfig){validateConfig(config);}

  async transfer(request:ExplicitWindowsFileTransferRequest):Promise<ExplicitWindowsFileTransferReceipt> {
    requireCondition(taskId(request.task_id),'FILE_TRANSFER_TASK_ID_INVALID');
    requireCondition(request.files.length>0&&request.files.length<=16,'FILE_TRANSFER_FILE_COUNT_INVALID');
    requireCondition(new Set(request.files.map(file=>file.source_relative_path)).size===request.files.length,'FILE_TRANSFER_DUPLICATE_SOURCE');
    requireCondition(new Set(request.files.map(file=>file.destination_filename)).size===request.files.length,'FILE_TRANSFER_DUPLICATE_DESTINATION');
    for(const file of request.files){
      requireCondition(relativeSourcePath(file.source_relative_path),'FILE_TRANSFER_SOURCE_PATH_INVALID');
      requireCondition(fileName(file.destination_filename),'FILE_TRANSFER_DESTINATION_FILENAME_INVALID');
      requireCondition(/^[a-f0-9]{64}$/.test(file.sha256),'FILE_TRANSFER_HASH_INVALID');
    }

    const sourceRoot=await directory(this.config.source_root,false),destinationRoot=await directory(this.config.destination_root,true);
    const receipts:ExplicitWindowsFileTransferReceipt['files'][number][]=[];
    for(const requested of request.files){
      const source=resolve(sourceRoot,requested.source_relative_path),destination=resolve(destinationRoot,requested.destination_filename);
      requireCondition(within(sourceRoot,source)&&within(destinationRoot,destination),'FILE_TRANSFER_PATH_ESCAPE');
      const sourceBefore=await lstat(source);
      requireCondition(sourceBefore.isFile()&&!sourceBefore.isSymbolicLink()&&sourceBefore.size>=0&&sourceBefore.size<=this.config.max_file_bytes,'FILE_TRANSFER_SOURCE_UNSAFE');
      const bytes=await readFile(source);
      const sourceAfter=await stat(source);
      requireCondition(sourceBefore.dev===sourceAfter.dev&&sourceBefore.ino===sourceAfter.ino&&sourceBefore.size===sourceAfter.size&&sourceBefore.mtimeMs===sourceAfter.mtimeMs,'FILE_TRANSFER_SOURCE_CHANGED');
      requireCondition(digest(bytes)===requested.sha256,'FILE_TRANSFER_SOURCE_HASH_MISMATCH');
      const prior=await existing(destination,requested.sha256);
      if(prior){receipts.push({source_relative_path:requested.source_relative_path,destination_filename:requested.destination_filename,...prior});continue;}

      const temporary=join(destinationRoot,`.${request.task_id}.${requested.destination_filename}.partial`);
      requireCondition(within(destinationRoot,temporary),'FILE_TRANSFER_PATH_ESCAPE');
      await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
      try {
        await chmod(temporary,0o600);
        const staged=await readFile(temporary);
        requireCondition(staged.length===bytes.length&&digest(staged)===requested.sha256,'FILE_TRANSFER_STAGE_HASH_MISMATCH');
        try {await copyFile(temporary,destination,constants.COPYFILE_EXCL);}
        catch(error) {
          const raced=await existing(destination,requested.sha256);
          if(!raced)throw error;
        }
        const copied=await readFile(destination);
        requireCondition(copied.length===bytes.length&&digest(copied)===requested.sha256,'FILE_TRANSFER_DESTINATION_HASH_MISMATCH');
        receipts.push({source_relative_path:requested.source_relative_path,destination_filename:requested.destination_filename,bytes:copied.length,sha256:requested.sha256,state:'transferred'});
      } finally {
        await unlink(temporary).catch(error=>{if(!error||typeof error!=='object'||(error as {code?:string}).code!=='ENOENT')throw error;});
      }
    }
    return Object.freeze({task_id:request.task_id,destination_root:destinationRoot,files:Object.freeze(receipts)});
  }
}
