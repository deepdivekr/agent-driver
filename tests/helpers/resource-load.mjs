import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const mode=process.argv[2];
const info=()=>({pid:process.pid,cgroup:readFileSync('/proc/self/cgroup','utf8').trim()});
const input=createInterface({input:process.stdin}),lines=input[Symbol.asyncIterator]();
console.log(JSON.stringify(info()));
await lines.next(); // Parent independently checks membership before any finite load.
if(mode==='hold'){
  input.close();process.stdin.destroy();setTimeout(()=>{},12000);
} else if(mode==='cpu'){
  input.close();process.stdin.destroy();const until=performance.now()+2500;while(performance.now()<until)Math.sqrt(Math.random());
} else if(mode==='memory'){
  input.close();process.stdin.destroy();
  // Finite 192 MiB allocation under the independently pre-checked 128 MiB domain.
  const buffers=[];for(let i=0;i<24;i++)buffers.push(Buffer.alloc(8*1048576,0x51));
  setTimeout(()=>console.log(buffers.length),1000);
} else if(mode==='descendant'){
  input.close();process.stdin.destroy();
  const child=spawn('/usr/bin/sleep',['20'],{stdio:'ignore'});
  child.once('spawn',()=>console.log(JSON.stringify({descendant:child.pid})));
  setTimeout(()=>{},15000);
} else if(mode==='pids'){
  const children=[];let denied=0,started=0,settled=0;
  for(let i=0;i<70;i++){
    const child=spawn('/usr/bin/sleep',['8'],{stdio:'ignore'});children.push(child);
    child.once('spawn',()=>{started++;settled++;});
    child.once('error',e=>{if(e.code==='EAGAIN')denied++;settled++;});
  }
  const check=setInterval(()=>{if(settled===70){
    clearInterval(check);console.log(JSON.stringify({started,denied}));
    void lines.next().then(()=>{input.close();process.stdin.destroy();for(const child of children)if(child.pid)child.kill('SIGTERM');});
  }},20);
} else throw Error('unknown resource fixture mode');
