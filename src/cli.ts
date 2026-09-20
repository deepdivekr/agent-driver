#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { RuntimeStore } from './store/runtime-store.js';
import { runFixtureDemo } from './browser/fixture-driver.js';
import { requireCondition } from './core/contracts.js';
import {runInterfaceCli,interfaceHelp} from './interface/cli.js';
import {runMaintenanceCli,maintenanceHelp} from './storage/cli.js';
const args=process.argv.slice(2),command=args[0]??'help',options=new Map<string,string>();
try {
  if(await runMaintenanceCli(args)||await runInterfaceCli(args)) { /* Shared API owns its lifecycle. */ }
  else {
  for(let i=1;i<args.length;i+=2){const key=args[i],value=args[i+1];requireCondition(typeof key==='string'&&key.startsWith('--')&&typeof value==='string'&&value.length>0&&!value.startsWith('--')&&!options.has(key),'INVALID_OPTIONS');options.set(key,value);}
  const allowed=['--db','--task','--project','--consumer','--event','--fault','--wrong-account'];for(const key of options.keys())requireCondition(allowed.includes(key),'UNKNOWN_OPTION');
  const db=resolve(options.get('--db')??'.runtime/runtime.sqlite');
  const required=(name:string)=>{const value=options.get(name);requireCondition(value,`MISSING_${name.slice(2).toUpperCase()}`);return value;};
  if(command==='help'||command==='--help')console.log('agent-driver (experimental)\n  demo [--db PATH] [--fault none|before|after] [--wrong-account true|false]\n  status --task ID [--db PATH]\n  tasks --project ID --db PATH\n  events --project ID --consumer NAME --db PATH\n  ack --project ID --consumer NAME --event ID --db PATH\n  cancel --task ID --db PATH\n  recover --task ID --db PATH\n'+interfaceHelp+maintenanceHelp);
  else if(command==='demo'){
    const fault=options.get('--fault')??'none';requireCondition(['none','before','after'].includes(fault),'INVALID_FAULT');requireCondition(['true','false'].includes(options.get('--wrong-account')??'false'),'INVALID_BOOLEAN');
    const result=await runFixtureDemo(db,dirname(db),{fault:fault as 'none'|'before'|'after',wrongAccount:options.get('--wrong-account')==='true'});console.log(JSON.stringify(result,null,2));if(result.status!=='succeeded')process.exitCode=2;
  } else {
    requireCondition(['status','tasks','events','ack','cancel','recover'].includes(command),'UNKNOWN_COMMAND');const store=new RuntimeStore(db);
    try {let result:unknown;
      if(command==='status')result=store.task(required('--task'));
      if(command==='tasks')result=store.tasks(required('--project'));
      if(command==='events')result=store.events(required('--project'),required('--consumer'));
      if(command==='ack'){store.ack(required('--project'),required('--consumer'),Number(required('--event')));result={acknowledged:true};}
      if(command==='cancel')result=store.cancel(required('--task'));
      if(command==='recover')result=store.recoverTask(required('--task'));
      console.log(JSON.stringify(result,null,2));
    } finally {store.close();}
  }
  }
} catch(error){console.error(JSON.stringify({error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_REQUEST'}));process.exitCode=1;}
