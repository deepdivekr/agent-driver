import {constants,mkdirSync,openSync,closeSync,fstatSync,writeSync,fsyncSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
export interface SpoolSegment {session_id:string;start_offset:number;bytes:number;filename:string;state:'open'|'sealed'|'pruning'|'pruned'}
export function writeSpoolSegment(database:string,segment:SpoolSegment,line:Buffer,created:boolean) {
  requireCondition(segment.filename === `${segment.session_id}.jsonl` || segment.filename === `${segment.session_id}-${segment.start_offset}.jsonl`,'CLI_SPOOL_INVALID_SEGMENT');
  requireCondition(!segment.filename.includes('/')&&!segment.filename.includes('\\'),'CLI_SPOOL_INVALID_SEGMENT');
  const directory=join(dirname(database),'terminal-spool');mkdirSync(directory,{recursive:true,mode:0o700});
  const dir=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const fd=openSync(`/proc/self/fd/${dir}/${segment.filename}`,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK|(created?constants.O_CREAT|constants.O_EXCL:0),0o600);
    try {
      const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.nlink===1&&stat.size===segment.bytes,'CLI_SPOOL_DURABILITY_GAP');
      let written=0;while(written<line.length){const n=writeSync(fd,line,written);requireCondition(n>0,'CLI_SPOOL_WRITE_FAILED');written+=n;}fsyncSync(fd);
    } finally {closeSync(fd);}
    // Append changes file contents/size, already fsynced above. Only creation
    // changes the directory entry; syncing it for every frame adds no durability.
    if(created)fsyncSync(dir);
  } finally {closeSync(dir);}
}
