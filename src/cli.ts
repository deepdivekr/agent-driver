#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { requireCondition } from './core/contracts.js';
const args=process.argv.slice(2),command=args[0]??'help',options=new Map<string,string>();
// Default stdio is only a bridge to the shared service. Explicit-config stdio
// remains a bounded compatibility path; neither preloads unrelated commands.
async function dispatch():Promise<boolean>{
  if(command==='mcp'&&args.length===1){const {approvedMcpConfigPath}=await import('./onboarding/connection.js');await (await import('./interface/mcp-proxy.js')).serveMcpProxy(approvedMcpConfigPath());return true;}
  if(command==='mcp-service'){
    requireCondition(args.length===4&&['start','stop','status','headers'].includes(args[1]??'')&&args[2]==='--config'&&args[3],'INVALID_OPTIONS');
    const manager=await import('./interface/mcp-service-manager.js');
    if(args[1]==='stop'){console.log(JSON.stringify(await manager.stopMcpService(args[3])));return true;}
    const record=args[1]==='status'?await manager.readMcpService(args[3]):await manager.ensureMcpService(args[3]);
    requireCondition(record,'MCP_SERVICE_NOT_STARTED');
    // Explicit local HTTP auth-helper mode only. Never log this output: the MCP
    // client consumes it privately, just like an environment bearer credential.
    if(args[1]==='headers'){console.log(JSON.stringify({Authorization:'Bearer '+record.token}));return true;}
    console.log(JSON.stringify({...(await manager.mcpServiceHealth(record)),version:record.version??'unknown',url:record.url,transport:'streamable-http'}));return true;
  }
  if(command==='mcp'){
    const lease=await(await import('./interface/mcp-process.js')).acquireMcpProcess();
    try{return await(await import('./interface/cli.js')).runInterfaceCli(args,()=>lease.release());}catch(error){await lease.release();throw error;}
  }
  if(command==='compatibility')return (await import('./integrations/workflow-upgrade.js')).runWorkflowCompatibilityCli(args);
  if(command==='decision')return (await import('./decision-plane/cli.js')).runDecisionCli(args);
  if(command==='hermes')return (await import('./integrations/cli.js')).runHermesCli(args);
  if(['connect','connection'].includes(command))return (await import('./onboarding/cli.js')).runOnboardingCli(args);
  if(command==='vm')return (await import('./isolation/cli.js')).runVmCli(args);
  if(command==='soak')return (await import('./soak/cli.js')).runSoakCli(args);
  if(command==='maintenance')return (await import('./storage/cli.js')).runMaintenanceCli(args);
  return (await import('./interface/cli.js')).runInterfaceCli(args);
}
try {
  if(await dispatch()) { /* Shared API owns its lifecycle. */ }
  else {
  for(let i=1;i<args.length;i+=2){const key=args[i],value=args[i+1];requireCondition(typeof key==='string'&&key.startsWith('--')&&typeof value==='string'&&value.length>0&&!value.startsWith('--')&&!options.has(key),'INVALID_OPTIONS');options.set(key,value);}
  const allowed=['--db','--task','--project','--consumer','--event','--fault','--wrong-account'];for(const key of options.keys())requireCondition(allowed.includes(key),'UNKNOWN_OPTION');
  const db=resolve(options.get('--db')??'.runtime/runtime.sqlite');
  const required=(name:string)=>{const value=options.get(name);requireCondition(value,`MISSING_${name.slice(2).toUpperCase()}`);return value;};
  if(command==='help'||command==='--help')console.log('No real-site or user-browser effects are performed by demo mode.');
  if(command==='help'||command==='--help'){
    const [{onboardingHelp},{hermesHelp},{decisionHelp},{workflowCompatibilityHelp},{interfaceHelp},{maintenanceHelp},{soakHelp},{vmHelp}]=await Promise.all([import('./onboarding/cli.js'),import('./integrations/cli.js'),import('./decision-plane/cli.js'),import('./integrations/workflow-upgrade.js'),import('./interface/cli.js'),import('./storage/cli.js'),import('./soak/cli.js'),import('./isolation/cli.js')]);
    console.log('agent-driver\n  demo [--db PATH] [--fault none|before|after] [--wrong-account true|false]\n  status --task ID [--db PATH]\n  tasks --project ID --db PATH\n  events --project ID --consumer NAME --event ID --db PATH\n  ack --project ID --consumer NAME --event ID --db PATH\n  cancel --task ID --db PATH\n  recover --task ID --db PATH\n'+onboardingHelp+hermesHelp+decisionHelp+workflowCompatibilityHelp+interfaceHelp+maintenanceHelp+soakHelp+vmHelp);
  }
  else if(command==='demo'){
    const {runFixtureDemo}=await import('./browser/fixture-driver.js');
    const fault=options.get('--fault')??'none';requireCondition(['none','before','after'].includes(fault),'INVALID_FAULT');requireCondition(['true','false'].includes(options.get('--wrong-account')??'false'),'INVALID_BOOLEAN');
    const result=await runFixtureDemo(db,dirname(db),{fault:fault as 'none'|'before'|'after',wrongAccount:options.get('--wrong-account')==='true'});console.log(JSON.stringify(result,null,2));if(result.status!=='succeeded')process.exitCode=2;
  } else {
    requireCondition(['status','tasks','events','ack','cancel','recover'].includes(command),'UNKNOWN_COMMAND');const {RuntimeStore}=await import('./store/runtime-store.js');const store=new RuntimeStore(db);
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
