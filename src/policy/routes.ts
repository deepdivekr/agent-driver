import { requireCondition, type Capability, type Observation } from '../core/contracts.js';
export interface RouteCandidate { capability:Capability; health:'ready'|'unavailable'|'unknown'; verifiedForEnvironment:boolean; dependency:string; }
export function chooseRoute(candidates:readonly RouteCandidate[],capabilityId:string,observation:Observation,failedDependencies:readonly string[]=[]):Capability {
  const eligible=candidates.filter(r=>r.capability.id===capabilityId&&r.health==='ready'&&r.verifiedForEnvironment&&!failedDependencies.includes(r.dependency)&&r.capability.environments.includes(observation.environment)&&observation.environment!=='user_desktop'&&observation.visibility!=='unknown'&&(observation.visibility!=='hidden'||r.capability.hiddenVerified)&&!r.capability.requiresForeground&&!r.capability.requiresOsInput&&!r.capability.usesUserTarget&&!r.capability.requiresClipboard&&!r.capability.requiresFileDialog);
  requireCondition(eligible.length>0,'NO_VERIFIED_ROUTE');
  // Registration order is a configured preference, not a benchmark-derived universal ranking.
  return eligible[0]!.capability;
}
export function modelExecutionPermission(_proposal:unknown) {
  return {allowExecution:false as const,mode:'shadow_only' as const,reason:'domain_profile_is_not_authority'};
}
