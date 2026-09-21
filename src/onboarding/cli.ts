import {connectionRoot,readLocalConnection} from './connection.js';
import {startLocalConnectionScreen} from './local-screen.js';
import {requireCondition} from '../core/contracts.js';

export const onboardingHelp='  connect [--state-root PATH]  (opens a loopback-only local connection screen)\n  connection status [--state-root PATH]\n';
function rootFrom(args:readonly string[]){
  if(args.length===0)return connectionRoot();requireCondition(args.length===2&&args[0]==='--state-root'&&args[1],'INVALID_CONNECTION_OPTIONS');return args[1]!;
}
/** User-facing setup has one approval. MCP registration stays client-owned but always points at `agent-driver mcp`. */
export async function runOnboardingCli(args:readonly string[]){
  if(args[0]==='connect'){
    const screen=await startLocalConnectionScreen(rootFrom(args.slice(1)));console.log(JSON.stringify({status:'waiting_for_local_connection_approval',url:screen.url,mode:'non_interfering'}));
    const result=await screen.approved;console.log(JSON.stringify({status:'connected',mcp_command:'agent-driver mcp',runtime_config:result.paths.runtimeConfig,jev:'optional'}));await screen.close();return true;
  }
  if(args[0]==='connection'){
    requireCondition(args[1]==='status','UNKNOWN_CONNECTION_COMMAND');const state=readLocalConnection(rootFrom(args.slice(2)));console.log(JSON.stringify(state===null?{status:'not_connected'}:{status:'connected',mode:state.mode,mcp_command:state.mcp.command,jev:state.jev.status}));return true;
  }
  return false;
}
