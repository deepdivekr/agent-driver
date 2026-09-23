import {connectionRoot,readLocalConnection} from './connection.js';
import {ensureControlService,openControlUrl} from './control-service.js';
import {requireCondition} from '../core/contracts.js';
import {appendSetupActivity} from './setup-activity.js';

export const onboardingHelp='  connect [--state-root PATH]  (opens a loopback-only local connection screen)\n  connection status [--state-root PATH]\n';
function rootFrom(args:readonly string[]){
  if(args.length===0)return connectionRoot();requireCondition(args.length===2&&args[0]==='--state-root'&&args[1],'INVALID_CONNECTION_OPTIONS');return args[1]!;
}
/** The installed CLI opens onboarding and preserves the bootstrap trail for the local setup screen. */
export async function runOnboardingCli(args:readonly string[]){
  if(args[0]==='connect'){
    const root=rootFrom(args.slice(1));await appendSetupActivity(root,'setup','running','$ agent-driver connect');
    await appendSetupActivity(root,'setup','success','WSL/Linux 실행 환경과 Agent Driver 설치를 확인했습니다.');
    const service=await ensureControlService(root);await appendSetupActivity(root,'setup','success',service.reused?'기존 관제센터에 다시 연결했습니다.':'로컬 관제센터를 시작했습니다.');
    const opened=await openControlUrl(service.url);
    console.log(JSON.stringify({status:'control_center_ready',url:service.url+'settings',browser_opened:opened,pid:service.pid,reused:service.reused,mcp_command:'agent-driver mcp',connection:readLocalConnection(rootFrom(args.slice(1)))?'connected':'awaiting_local_approval'}));return true;
  }
  if(args[0]==='connection'){
    requireCondition(args[1]==='status','UNKNOWN_CONNECTION_COMMAND');const state=readLocalConnection(rootFrom(args.slice(2)));console.log(JSON.stringify(state===null?{status:'not_connected'}:{status:'connected',mode:state.mode,mcp_command:state.mcp.command,jev:state.jev.status}));return true;
  }
  return false;
}
