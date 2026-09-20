import {openSync, closeSync, fstatSync, readSync, constants} from 'node:fs';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {redact, type TerminalOutput} from './contracts.js';
import {type TerminalStore} from './store.js';

export function readTerminalOutput(store: TerminalStore, config: HostConfig, request: TerminalOutput) {
  requireCondition(process.platform === 'linux', 'TERMINAL_PLATFORM_UNVERIFIED');
  const page=store.outputPage(config.project.id,request),segments=store.spoolSegments(page.session.id);
  const frames:Array<Record<string,unknown>>=[];
  let used=0,dir:number|null=null;
  try {
    for(const row of page.rows.slice(0,request.limit)){
      const {bytes,spool_offset:end,sha256}=row.data;
      requireCondition(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=524288&&Number.isSafeInteger(end)&&end>=bytes&&end<=page.session.spool_bytes,'CLI_SPOOL_INVALID_OFFSET');
      if(frames.length&&used+bytes>524288)break;
      const segment=segments.find(s=>s.start_offset<=end-bytes&&s.start_offset+s.bytes>=end);
      requireCondition(segment,'CLI_SPOOL_SEGMENT_GAP');
      if(segment.state==='pruned'||segment.state==='pruning'){
        frames.push({event_id:row.id,end_offset:end,availability:segment.state==='pruned'?'retention_expired':'retention_pruning',integrity:'unobserved',frame:null});used+=bytes;continue;
      }
      requireCondition(segment.filename===page.session.id+'.jsonl'||segment.filename===page.session.id+'-'+segment.start_offset+'.jsonl','CLI_SPOOL_INVALID_SEGMENT');
      if(dir===null)dir=openSync(join(dirname(config.dbPath),'terminal-spool'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const fd=openSync('/proc/self/fd/'+dir+'/'+segment.filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.nlink===1&&stat.size===segment.bytes,'CLI_SPOOL_DURABILITY_GAP');
        const buffer=Buffer.alloc(bytes);let read=0;
        while(read<bytes){const n=readSync(fd,buffer,read,bytes-read,end-bytes-segment.start_offset+read);requireCondition(n>0,'CLI_SPOOL_DURABILITY_GAP');read+=n;}
        if(sha256)requireCondition(createHash('sha256').update(buffer).digest('hex')===sha256,'CLI_SPOOL_HASH_MISMATCH');
        requireCondition(buffer.at(-1)===10,'CLI_SPOOL_INVALID_FRAME');
        const data=JSON.parse(buffer.toString('utf8')) as Record<string,unknown>;
        requireCondition(data.session_id===page.session.cli_session_id&&data.type===row.data.event_type,'CLI_SPOOL_FRAME_MISMATCH');
        const frame={type:data.type,subtype:typeof data.subtype==='string'?redact(data.subtype):null,uuid:typeof data.uuid==='string'?redact(data.uuid):null,
          session_id:page.session.cli_session_id,model:typeof data.model==='string'?redact(data.model):null,result:typeof data.result==='string'?redact(data.result):null};
        frames.push({event_id:row.id,end_offset:end,integrity:sha256?'sha256_matches_durable_event':'unobserved_legacy',frame});used+=bytes;
      }finally{closeSync(fd);}
    }
  }finally{if(dir!==null)closeSync(dir);}
  requireCondition(store.revision(page.session.id)===page.revision,'HISTORY_CHANGED_RESTART_PAGE');
  return {session_ref:page.session.id,session_generation:page.session.generation,revision:page.revision,committed_bytes:page.session.spool_bytes,frames,
    next_cursor:page.rows.length>frames.length?{revision:page.revision,after_event_id:Number(frames.at(-1)!.event_id)}:null,
    content_trust:'untrusted_data',output_kind:'normalized_event_metadata_and_result',assistant_stream_complete:false};
}
