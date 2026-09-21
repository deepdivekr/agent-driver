// Explicit opt-in, synthetic-only native CLI contract probe. No automatic retries.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
const executable=process.argv[2];if(!executable||process.argv[3]!=='--run')throw Error('EXPLICIT_EXECUTABLE_AND_RUN_REQUIRED');
const version=execFileSync(executable,['--version'],{encoding:'utf8',timeout:10000}).trim();
if(version!=='2.1.126 (Claude Code)')throw Error('CLI_VERSION_NOT_PINNED');
const id=randomUUID(),root=resolve('.runtime',`cli-probe-${id}`);await mkdir(root,{recursive:true,mode:0o700});
const receipt={session_id:id,version,worktree:root,auth:'existing_cli_subscription',prompts_sent:0,api_inference_count:'unobserved',turns:[],events:[],status:'RUNNING'};
const save=()=>writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});await save();
const env=Object.fromEntries(['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]]]));
env.DISABLE_AUTOUPDATER='1';
const prompts=['기억해: 식별어는 수달-318. 정확히 준비완료라고 답해.','방금 기억한 식별어만 답해.','현재 세션 식별어 뒤에 -끝을 붙여 한 줄로 답해.'];
const expected=['준비완료','수달-318','수달-318-끝'];
async function run(resume,inputs,answers){
  const args=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--replay-user-messages',resume?'--resume':'--session-id',id,'--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--system-prompt','This is a synthetic runtime protocol test. Follow the requested exact text. No tools or external actions.'];
  const child=spawn(executable,args,{cwd:root,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let index=0,buffer='',stderrBytes=0,failed=false;const decoder=new StringDecoder('utf8');
  const deadline=setTimeout(()=>{failed=true;child.kill('SIGTERM');},150000);
  const fail=()=>{failed=true;child.kill('SIGTERM');};
  child.stderr.on('data',b=>{stderrBytes+=b.length;});
  const send=()=>{receipt.prompts_sent++;const uuid=randomUUID();receipt.events.push({type:'probe.sent',uuid,resume});child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:inputs[index]},parent_tool_use_id:null,session_id:id,uuid})+'\n');};
  child.once('spawn',send);child.stdin.on('error',fail);
  child.stdout.on('data',chunk=>{
    buffer+=decoder.write(chunk);if(buffer.length>1024*1024){fail();return;}
    while(buffer.includes('\n')){
      const split=buffer.indexOf('\n'),line=buffer.slice(0,split);buffer=buffer.slice(split+1);if(!line)continue;
      try{
        const e=JSON.parse(line);receipt.events.push({type:e.type,subtype:e.subtype??null,session_id:e.session_id??null,uuid:e.uuid??null,parent_tool_use_id:e.parent_tool_use_id??null,...(e.type==='system'&&e.subtype==='init'?{tools:e.tools,model:e.model,permissionMode:e.permissionMode}:{}),...(e.type==='user'?{message_role:e.message?.role,content_kind:typeof e.message?.content}:{}),...(e.type==='result'?{is_error:e.is_error,permission_denials_count:Array.isArray(e.permission_denials)?e.permission_denials.length:'unobserved'}:{})});
        if(e.type==='result'){
          const text=typeof e.result==='string'?e.result.trim():null,ok=e.session_id===id&&e.subtype==='success'&&e.is_error===false&&text===answers[index];
          receipt.turns.push({resume,index,status:ok?'PASS':'FAIL',result:text,expected:answers[index],session_matches:e.session_id===id});console.log(JSON.stringify({turn:receipt.turns.length,resume,status:ok?'PASS':'FAIL'}));
          index++;if(!ok){fail();return;}if(index<inputs.length)send();else child.stdin.end();
        }
      }catch{fail();return;}
    }
  });
  const code=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve);});clearTimeout(deadline);
  receipt.events.push({type:'probe.process_exit',code,stderr_bytes:stderrBytes,resume});await save();
  if(failed||code!==0||index!==inputs.length)throw Error('NATIVE_CLI_PROBE_FAILED');
}
try{await run(false,prompts,expected);await run(true,['이 세션에서 기억한 식별어만 다시 답해.'],['수달-318']);receipt.status='PASS';}
catch(error){receipt.status='FAIL';receipt.error=error.message;process.exitCode=1;}
finally{await save();console.log(JSON.stringify({status:receipt.status,prompts_sent:receipt.prompts_sent,receipt:join(root,'receipt.json')}));}
