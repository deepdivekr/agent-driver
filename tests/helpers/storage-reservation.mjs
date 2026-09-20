import {loadHostConfig} from '../../dist/interface/config.js';
import {TerminalStore} from '../../dist/terminal/store.js';
const config=loadHostConfig(process.argv[2]),store=new TerminalStore(config.dbPath),ledger=store.storage(config);
try {
  const id=ledger.reserve('native_child',Number(process.argv[3]));
  console.log(JSON.stringify({id,pid:process.pid,status:'reserved'}));
  process.stdin.once('data',()=>{ledger.release(id);store.close();process.exit(0);});
  setTimeout(()=>{store.close();process.exit(2);},15000).unref();
} catch(e) {console.log(JSON.stringify({status:'blocked',reason:e.message}));store.close();}
