import {z} from 'zod';
import {type OneLineJevDecision,type OneLineJevInput} from './typesafe-jev.js';

/**
 * Optional read-only travel hand selection, not a global browser policy.
 * Both hands may use selectors, locators, DOM references, and browser tools.
 * Choosing a decision maker does not grant execution or submission authority.
 * This helper is not yet connected to the live travel runner.
 */
export const sourceAutomationPermission=z.enum(['unreviewed','read_only_confirmed']);
export const browserSurfaceState=z.enum(['search_form','results','known_benign_popup','unknown_popup','consent','authentication','challenge','unknown']);
export const browserSurfaceObservation=z.object({
  source_id:z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  permission:sourceAutomationPermission,
  state:browserSurfaceState,
  reviewed_popup_id:z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/).optional(),
}).strict();
export type BrowserSurfaceObservation=z.infer<typeof browserSurfaceObservation>;

export type BrowserExecutionHand=
  | {kind:'hold';reason:'SOURCE_PERMISSION_UNREVIEWED'|'CONSENT_OR_AUTH_REQUIRED'|'CHALLENGE_REQUIRED'|'UNKNOWN_UI'}
  | {kind:'semantic_browser';reason:'ADAPTIVE_STEP';executor:'jev_or_llm_with_browser_tools'}
  | {kind:'reviewed_deterministic';reason:'EXECUTE_PACK_STEP'|'READ_RENDERED_RESULT'|'DISMISS_REVIEWED_POPUP';executor:'reviewed_browser_primitive';popup_id?:string};

/**
 * One hand-selection question, not a limit on Jev's role in a Task Pack.
 * Separate Pack judgments may select tools, actions, observed targets, and
 * candidate values. Execution still belongs to the browser adapter.
 */
export function browserHandJevInput(request:string,observation:BrowserSurfaceObservation):OneLineJevInput {
  const value=browserSurfaceObservation.parse(observation);
  return {
    request,
    policy_version:'browser_hand_v2',
    routes:[
      {id:'semantic_browser',description:'Use Jev or an LLM to inspect current evidence and choose the next tool, action, target, or value within the Pack scope. Browser tools may use selectors, locators, DOM references, or coordinates. An unfamiliar popup needs inspection, not automatic dismissal or automatic human handoff.'},
      {id:'reviewed_deterministic',description:'Use a validated Pack step for navigation, search-form input, a search button, result extraction, or a known popup. Selectors and browser automation are normal tools, not restricted to reading results. This read-only Pack does not authorize booking, payment, or external submission.'},
      {id:'hold',description:'Pause when the read-only Pack requires source permission, human authentication, consent, a security challenge, or evidence that cannot yet be obtained. Unfamiliar UI alone can go to the adaptive hand.'},
    ],
    fields:[],
    observed_state:{source_id:value.source_id,permission:value.permission,state:value.state,reviewed_popup_id:value.reviewed_popup_id??null,execution_authority:false},
  };
}

/**
 * Pack authority stays separate from tool choice. The authentication/consent
 * holds below belong to this read-only travel helper, not every Task Pack.
 */
export function chooseBrowserExecutionHand(observation:BrowserSurfaceObservation,jev:OneLineJevDecision):BrowserExecutionHand {
  const value=browserSurfaceObservation.parse(observation);
  if(value.permission!=='read_only_confirmed')return {kind:'hold',reason:'SOURCE_PERMISSION_UNREVIEWED'};
  if(value.state==='consent'||value.state==='authentication')return {kind:'hold',reason:'CONSENT_OR_AUTH_REQUIRED'};
  if(value.state==='challenge')return {kind:'hold',reason:'CHALLENGE_REQUIRED'};
  const adaptive:BrowserExecutionHand={kind:'semantic_browser',reason:'ADAPTIVE_STEP',executor:'jev_or_llm_with_browser_tools'};
  if(jev.status!=='PROPOSED')return adaptive;
  if(jev.route_id==='hold')return {kind:'hold',reason:'UNKNOWN_UI'};
  // Unknown UI needs fresh evidence before choosing a concrete Pack step.
  // The adaptive hand can still use selectors; this is not a tool prohibition.
  if(value.state==='unknown_popup'||value.state==='unknown')return adaptive;
  if(jev.route_id!=='reviewed_deterministic')return adaptive;
  if(value.state==='known_benign_popup'){
    if(value.reviewed_popup_id===undefined)return adaptive;
    return {kind:'reviewed_deterministic',reason:'DISMISS_REVIEWED_POPUP',executor:'reviewed_browser_primitive',popup_id:value.reviewed_popup_id};
  }
  if(value.state==='results')return {kind:'reviewed_deterministic',reason:'READ_RENDERED_RESULT',executor:'reviewed_browser_primitive'};
  return {kind:'reviewed_deterministic',reason:'EXECUTE_PACK_STEP',executor:'reviewed_browser_primitive'};
}
