// Diagnostic preload for the existing owned-browser tests. No new browser,
// credentials, connection or alternative runtime is introduced. The optional
// page-first probe is experimental, never the default product close behavior.
import {appendFileSync,mkdirSync} from 'node:fs';
import {OwnedPersistentPage} from '../../dist/taskpack/owned-playwright.js';

const path=`tests/evidence/owned-browser-trace-${process.pid}.jsonl`;
let sequence=0;
const sessions=new WeakMap();
function record(value){mkdirSync('tests/evidence',{recursive:true});const entry={at:new Date().toISOString(),pid:process.pid,...value};appendFileSync(path,JSON.stringify(entry)+'\n');console.error('owned-browser-timing: '+JSON.stringify(entry));}
for(const method of ['open','capture','close']){
  const original=OwnedPersistentPage.prototype[method];
  OwnedPersistentPage.prototype[method]=async function(...args){
    if(!sessions.has(this))sessions.set(this,++sequence);
    const session=sessions.get(this),started=performance.now();record({session,method,event:'begin'});
    if(method==='close'&&process.env.AGENT_DRIVER_PROBE_PAGE_FIRST==='1'){
      const closing=performance.now();await this.page.close();record({session,method:'close_page_probe',event:'complete',elapsed_ms:Math.round(performance.now()-closing)});
    }
    try{const result=await original.apply(this,args);record({session,method,event:'complete',elapsed_ms:Math.round(performance.now()-started),...(method==='open'?{gate:result.gate,timing:result.timing,capture_disposition:result.capture_disposition}:{})});return result;}
    catch(error){record({session,method,event:'failed',elapsed_ms:Math.round(performance.now()-started),error_name:error?.name??'unknown'});throw error;}
  };
}
