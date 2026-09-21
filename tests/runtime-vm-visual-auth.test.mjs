import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {acceptHighlightedSavedPasswordSuggestionOverLoopbackRfb,dismissHumanConfirmedJavaScriptDialogOverLoopbackRfb,focusSavedPasswordFieldOverLoopbackRfb,highlightFirstSavedPasswordSuggestionOverLoopbackRfb,hoverSavedPasswordSuggestionOverLoopbackRfb,loopbackRfbObservationFingerprint,savedPasswordFieldTarget,savedPasswordSuggestionProbeTarget,savedPasswordSuggestionTarget,selectSavedPasswordOverLoopbackRfb} from '../dist/taskpack/vm-visual-auth.js';

test('runtime contract VM saved-password target derives only an in-window guest coordinate',()=>{
  const metrics={screen_x:0,screen_y:0,outer_width:1440,outer_height:1024,inner_width:1440,inner_height:900,screen_width:1440,screen_height:1024,device_pixel_ratio:1};
  assert.deepEqual(savedPasswordFieldTarget(metrics,{x:1000,y:300,width:400,height:70}),{x:1200,y:459});
  const policy={anchor_x_ratio:.5,row_offset_y_css_px:48,popover_wait_ms:150,hover_probe_offsets_y_css_px:[16,32,48,64,80,96]};
  assert.deepEqual(savedPasswordSuggestionTarget(metrics,{x:1000,y:300,width:400,height:70},policy),{x:1200,y:542});
  assert.deepEqual(savedPasswordSuggestionProbeTarget(metrics,{x:1000,y:300,width:400,height:70},policy,16),{x:1200,y:510});
  assert.throws(()=>savedPasswordSuggestionTarget({...metrics,device_pixel_ratio:2},{x:1000,y:300,width:400,height:70},policy),/VM_VISUAL_AUTH_SCALE_UNSUPPORTED/);
  assert.throws(()=>savedPasswordSuggestionTarget(metrics,{x:1000,y:800,width:400,height:70},{...policy,row_offset_y_css_px:100}),/VM_SAVED_PASSWORD_SUGGESTION_OUTSIDE_WINDOW/);
  assert.deepEqual(savedPasswordFieldTarget({...metrics,screen_width:1050,screen_height:747},{x:697,y:247,width:278,height:45},{width:1440,height:1024}),{x:1147,y:539});
  const scaled={screen_x:8,screen_y:20,outer_width:1050,outer_height:999,inner_width:1312,inner_height:1140,screen_width:1440,screen_height:1024,device_pixel_ratio:.8};
  assert.deepEqual(savedPasswordFieldTarget(scaled,{x:501,y:744,width:279,height:45},{width:1440,height:1024}),{x:520,y:720});
  assert.deepEqual(savedPasswordSuggestionTarget(scaled,{x:501,y:744,width:279,height:45},policy,{width:1440,height:1024}),{x:520,y:777});
});
test('runtime contract VM saved-password selector speaks only loopback RFB none-security and emits one click',async t=>{
  const acceptOneClick=async invoke=>{
    let received=Buffer.alloc(0),stage='version',resolveFrames,frames=new Promise(resolve=>{resolveFrames=resolve;});
  const server=createServer(socket=>{
    socket.write(Buffer.from('RFB 003.008\n','ascii'));
    socket.on('data',bytes=>{
      received=Buffer.concat([received,bytes]);
      while(true){
        if(stage==='version'&&received.length>=12){assert.equal(received.subarray(0,12).toString('ascii'),'RFB 003.008\n');received=received.subarray(12);socket.write(Buffer.from([1,1]));stage='security';continue;}
        if(stage==='security'&&received.length>=1){assert.equal(received[0],1);received=received.subarray(1);socket.write(Buffer.alloc(4));stage='client_init';continue;}
        if(stage==='client_init'&&received.length>=1){assert.equal(received[0],1);received=received.subarray(1);const init=Buffer.alloc(24);init.writeUInt16BE(1440,0);init.writeUInt16BE(1024,2);init[4]=32;init[5]=24;init[7]=1;init.writeUInt32BE(4,20);socket.write(Buffer.concat([init,Buffer.from('x11v','ascii')]));stage='pointer';continue;}
        if(stage==='pointer'&&received.length>=18){resolveFrames([...received.subarray(0,18)]);return;}
        return;
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
    const address=server.address();assert.equal(typeof address,'object');await invoke(address.port);
    return await frames;
  };
  assert.deepEqual((await acceptOneClick(port=>focusSavedPasswordFieldOverLoopbackRfb(port,{x:1200,y:459}))).slice(0,18),[5,0,4,176,1,203,5,1,4,176,1,203,5,0,4,176,1,203]);
  assert.deepEqual((await acceptOneClick(port=>selectSavedPasswordOverLoopbackRfb(port,{x:1200,y:542}))).slice(0,18),[5,0,4,176,2,30,5,1,4,176,2,30,5,0,4,176,2,30]);
});
test('runtime contract VM keyboard surface emits only reviewed selection keys or human-confirmed dialog cancel',async t=>{
  const acceptOneKey=async invoke=>{
    let received=Buffer.alloc(0),stage='version',resolveKeys,keys=new Promise(resolve=>{resolveKeys=resolve;});
    const server=createServer(socket=>{
      socket.write(Buffer.from('RFB 003.008\n','ascii'));
      socket.on('data',bytes=>{
        received=Buffer.concat([received,bytes]);
        while(true){
          if(stage==='version'&&received.length>=12){received=received.subarray(12);socket.write(Buffer.from([1,1]));stage='security';continue;}
          if(stage==='security'&&received.length>=1){received=received.subarray(1);socket.write(Buffer.alloc(4));stage='client_init';continue;}
          if(stage==='client_init'&&received.length>=1){received=received.subarray(1);const init=Buffer.alloc(24);init.writeUInt16BE(1440,0);init.writeUInt16BE(1024,2);init[4]=32;init[5]=24;init[7]=1;init.writeUInt32BE(4,20);socket.write(Buffer.concat([init,Buffer.from('x11v','ascii')]));stage='keys';continue;}
          if(stage==='keys'&&received.length>=16){resolveKeys([...received.subarray(0,16)]);return;}
          return;
        }
      });
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const address=server.address();assert.equal(typeof address,'object');await invoke(address.port);return await keys;
  };
  assert.deepEqual(await acceptOneKey(port=>highlightFirstSavedPasswordSuggestionOverLoopbackRfb(port)),[4,1,0,0,0,0,255,84,4,0,0,0,0,0,255,84]);
  assert.deepEqual(await acceptOneKey(port=>acceptHighlightedSavedPasswordSuggestionOverLoopbackRfb(port)),[4,1,0,0,0,0,255,13,4,0,0,0,0,0,255,13]);
  assert.deepEqual(await acceptOneKey(port=>dismissHumanConfirmedJavaScriptDialogOverLoopbackRfb(port)),[4,1,0,0,0,0,255,27,4,0,0,0,0,0,255,27]);
});
test('runtime contract VM saved-password hover emits no button press',async t=>{
  let received=Buffer.alloc(0),stage='version',resolveMove,move=new Promise(resolve=>{resolveMove=resolve;});
  const server=createServer(socket=>{
    socket.write(Buffer.from('RFB 003.008\n','ascii'));
    socket.on('data',bytes=>{
      received=Buffer.concat([received,bytes]);
      while(true){
        if(stage==='version'&&received.length>=12){received=received.subarray(12);socket.write(Buffer.from([1,1]));stage='security';continue;}
        if(stage==='security'&&received.length>=1){received=received.subarray(1);socket.write(Buffer.alloc(4));stage='client_init';continue;}
        if(stage==='client_init'&&received.length>=1){received=received.subarray(1);const init=Buffer.alloc(24);init.writeUInt16BE(1440,0);init.writeUInt16BE(1024,2);init[4]=32;init[5]=24;init[7]=1;init.writeUInt32BE(4,20);socket.write(Buffer.concat([init,Buffer.from('x11v','ascii')]));stage='move';continue;}
        if(stage==='move'&&received.length>=6){resolveMove([...received.subarray(0,6)]);return;}
        return;
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const address=server.address();assert.equal(typeof address,'object');await hoverSavedPasswordSuggestionOverLoopbackRfb(address.port,{x:1200,y:510});assert.deepEqual(await move,[5,0,4,176,1,254]);
});
test('runtime contract VM popup observation retains only a framebuffer fingerprint',async t=>{
  let received=Buffer.alloc(0),stage='version';
  const server=createServer(socket=>{
    socket.write(Buffer.from('RFB 003.008\n','ascii'));
    socket.on('data',bytes=>{
      received=Buffer.concat([received,bytes]);
      while(true){
        if(stage==='version'&&received.length>=12){received=received.subarray(12);socket.write(Buffer.from([1,1]));stage='security';continue;}
        if(stage==='security'&&received.length>=1){received=received.subarray(1);socket.write(Buffer.alloc(4));stage='client_init';continue;}
        if(stage==='client_init'&&received.length>=1){received=received.subarray(1);const init=Buffer.alloc(24);init.writeUInt16BE(1440,0);init.writeUInt16BE(1024,2);init[4]=32;init[5]=24;init[7]=1;init.writeUInt32BE(4,20);socket.write(Buffer.concat([init,Buffer.from('x11v','ascii')]));stage='observation';continue;}
        if(stage==='observation'&&received.length>=18){assert.equal(received[0],2);assert.equal(received.readUInt16BE(2),1);assert.equal(received.readInt32BE(4),0);assert.equal(received[8],3);assert.equal(received.readUInt16BE(10),100);assert.equal(received.readUInt16BE(12),200);assert.equal(received.readUInt16BE(14),24);assert.equal(received.readUInt16BE(16),24);const update=Buffer.alloc(16);update[0]=0;update.writeUInt16BE(1,2);update.writeUInt16BE(100,4);update.writeUInt16BE(200,6);update.writeUInt16BE(24,8);update.writeUInt16BE(24,10);update.writeInt32BE(0,12);socket.write(Buffer.concat([update,Buffer.alloc(24*24*4,7)]));return;}
        return;
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const address=server.address();assert.equal(typeof address,'object');const fingerprint=await loopbackRfbObservationFingerprint(address.port,{x:100,y:200,width:24,height:24});assert.match(fingerprint,/^[a-f0-9]{64}$/);
});
