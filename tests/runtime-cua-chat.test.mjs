import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {CuaChatSession} from '../dist/desktop/cua-chat-session.js';
import {OwnedCuaConnection} from '../dist/desktop/cua-connection.js';
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const scope={request_id:randomUUID(),work_id:randomUUID(),pid:123,window_id:456,room:'Reviewed room',message:'test',expires_at_ms:Date.now()+600000};
 const state={value:'메시지 입력\r',n:0,writes:0,clicks:0,throwWrite:false,throwSend:false,change:null,calls:[]};
 const port={async call(name,args){state.calls.push({name,args});if(name==='get_window_state'){
  const id='s'+(++state.n).toString(16).padStart(8,'0');
  const raw={pid:123,window_id:456,app_name:'KakaoTalk.exe',window_title:scope.room,snapshot_id:id,truncated:false,window_bounds:{x:50,y:30,width:760,height:1410},
   ...(args.include_screenshot?{capture_id:'capture'+state.n,screenshot_width:758,screenshot_height:1408}:{}),
   elements:[{element_token:id+':0',role:'Document',label:'RichEdit Control',enabled:true,value:state.value,actions:['set_value','text']}]};
  state.change?.(raw);return raw;
 }if(name==='set_value'){state.writes++;assert.equal(args.element_token,'s'+state.n.toString(16).padStart(8,'0')+':0');if(state.throwWrite)throw Error('lost');state.value=args.value+'\r';return {effect:'unverifiable'};}
 if(name==='click'){state.clicks++;if(state.throwSend)throw Error('lost');return {effect:'unverifiable'};}
 throw Error('unsupported');}};
 const chat=new CuaChatSession(scope,db,port);return {db,scope,state,port,chat};
}
async function approved(x){x.state.value='test\r';const o=await x.chat.observe(true);x.chat.confirmSend(o.capture_id,{source:'human_action_time',room:x.scope.room,message:'test',received_at_ms:Date.now()});return o;}
test('runtime contract chat exact replacement avoids placeholder append and needs independent readback',async t=>{
 const x=setup(t),o=await x.chat.observe(true);await x.chat.draft(o.capture_id,true);
 assert.equal(x.state.value,'test\r');assert.equal(x.chat.status()[0].status,'dispatched_unverified');
 const after=await x.chat.observe(false);x.chat.verifyDraft(after.capture_id);assert.equal(x.chat.status()[0].status,'readback_verified');
 assert.deepEqual(x.state.calls.map(c=>c.name),['get_window_state','get_window_state','set_value','get_window_state']);assert.equal(x.state.calls[1].args.include_screenshot,false);
});
for(const kind of ['title','pid','window','app','missing_value','disabled','duplicate','role','stale','truncated'])test('runtime contract chat refuses '+kind+' mismatch',async t=>{
 const x=setup(t);x.state.change=raw=>{if(kind==='title')raw.window_title='Other';if(kind==='pid')raw.pid=555;if(kind==='window')raw.window_id=777;if(kind==='app')raw.app_name='Other.exe';if(kind==='missing_value')delete raw.elements[0].value;if(kind==='disabled')raw.elements[0].enabled=false;if(kind==='duplicate')raw.elements.push({...raw.elements[0]});if(kind==='role')raw.elements[0].role='Edit';if(kind==='stale')raw.elements[0].element_token='sffffffff:0';if(kind==='truncated')raw.truncated=true;};
 await assert.rejects(x.chat.observe(true));assert.equal(x.state.writes+x.state.clicks,0);
});
test('runtime contract chat preserves an existing draft and does not infer placeholder from prefix',async t=>{
 const x=setup(t);for(const value of ['existing\r','메시지 입력\rtest\r','test \r']){x.state.value=value;const o=await x.chat.observe(true);await assert.rejects(x.chat.draft(o.capture_id,true),/NONEMPTY/);}assert.equal(x.state.writes,0);
});
test('runtime contract chat checks native value again just before input',async t=>{
 const x=setup(t),o=await x.chat.observe(true);x.state.value='human edit\r';await assert.rejects(x.chat.draft(o.capture_id,true),/STATE_CHANGED/);assert.equal(x.state.writes,0);assert.deepEqual(x.chat.status(),[]);
});
test('runtime contract chat consumes uncertain draft once across restarts',async t=>{
 const x=setup(t),o=await x.chat.observe(true);x.state.throwWrite=true;await assert.rejects(x.chat.draft(o.capture_id,true),/lost/);
 const restarted=new CuaChatSession(x.scope,x.db,x.port),next=await restarted.observe(true);await assert.rejects(restarted.draft(next.capture_id,true),/ALREADY_CLAIMED/);assert.equal(x.state.writes,1);assert.equal(restarted.status()[0].status,'unknown');
});
test('runtime contract chat no send before action-time confirmation; no newline injection',async t=>{
 const x=setup(t);x.state.value='test\r';const o=await x.chat.observe(true);await assert.rejects(x.chat.send(o.capture_id,{x:650,y:1360}),/CONFIRMATION/);assert.equal(x.state.clicks,0);
 assert.throws(()=>new CuaChatSession({...x.scope,message:'test\n'},x.db,x.port));
});
test('runtime contract chat action-time confirmation binds room message and fresh visual',async t=>{
 const x=setup(t);x.state.value='test\r';let o=await x.chat.observe(true);
 for(const change of [{room:'Other'},{message:'changed'},{source:'model'},{received_at_ms:Date.now()-120000},{received_at_ms:Date.now()+60000}])assert.throws(()=>x.chat.confirmSend(o.capture_id,{source:'human_action_time',room:x.scope.room,message:'test',received_at_ms:Date.now(),...change}),/CONFIRMATION/);
 o=await x.chat.observe(false);assert.throws(()=>x.chat.confirmSend(o.capture_id,{source:'human_action_time',room:x.scope.room,message:'test',received_at_ms:Date.now()}),/CONFIRMATION/);assert.equal(x.state.clicks,0);
});
test('runtime contract chat later observation invalidates send confirmation',async t=>{
 const x=setup(t);await approved(x);const o=await x.chat.observe(true);await assert.rejects(x.chat.send(o.capture_id,{x:650,y:1360}),/CONFIRMATION/);assert.equal(x.state.clicks,0);
});
test('runtime contract chat changed title or message after approval blocks send',async t=>{
 const x=setup(t),o=await approved(x);x.state.value='changed\r';await assert.rejects(x.chat.send(o.capture_id,{x:650,y:1360}),/STATE_CHANGED/);assert.equal(x.state.clicks,0);assert.deepEqual(x.chat.status(),[]);
});
test('runtime contract chat send is claimed before dispatch and never replayed or marked delivered',async t=>{
 const x=setup(t),o=await approved(x);x.state.throwSend=true;await assert.rejects(x.chat.send(o.capture_id,{x:650,y:1360}),/lost/);assert.equal(x.state.clicks,1);
 x.chat=new CuaChatSession(x.scope,x.db,x.port);const second=await approved(x);await assert.rejects(x.chat.send(second.capture_id,{x:650,y:1360}),/ALREADY_CLAIMED/);assert.equal(x.state.clicks,1);assert.equal(x.chat.status()[0].status,'unknown');
});
test('runtime contract chat successful dispatch remains unverified and existing matching draft is not proof of sending',async t=>{
 const x=setup(t),o=await approved(x);await x.chat.send(o.capture_id,{x:650,y:1360});assert.equal(x.chat.status()[0].status,'dispatched_unverified');assert.equal(x.state.clicks,1);
});
test('runtime contract chat rejects stale or consumed observation and expired scope',async t=>{
 const x=setup(t),o=await x.chat.observe(true);await assert.rejects(x.chat.draft('other',true),/FRESH/);await x.chat.draft(o.capture_id,true);await assert.rejects(x.chat.draft(o.capture_id,true),/FRESH/);
 const expired=new CuaChatSession({...x.scope,expires_at_ms:Date.now()-1},x.db,x.port);await assert.rejects(expired.observe(),/EXPIRED/);
});
test('runtime contract chat coordinates cannot leave the reviewed capture',async t=>{
 const x=setup(t),o=await approved(x);for(const p of [{x:-1,y:1300},{x:900,y:1300},{x:650,y:1500},{x:NaN,y:1300}])await assert.rejects(x.chat.send(o.capture_id,p),/OUTSIDE/);assert.equal(x.state.clicks,0);
});
test('runtime contract extended CUA transport leaves default field tools restricted',async()=>{
 const config={};const field=new OwnedCuaConnection(config),chat=new OwnedCuaConnection(config,'reviewed_chat');
 for(const name of ['click','scroll','type_text','press_key','launch_app'])await assert.rejects(field.call(name,{}),/FORBIDDEN/);
 for(const name of ['type_text','press_key','launch_app'])await assert.rejects(chat.call(name,{pid:123,window_id:456}),/FORBIDDEN/);
 await assert.rejects(chat.call('click',{pid:123}),/WINDOW/);await assert.rejects(chat.call('click',{pid:123,window_id:456,scope:'desktop'}),/DESKTOP/);
 await field.close();await chat.close();
});
