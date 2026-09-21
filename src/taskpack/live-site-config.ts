import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type KnownPopup,type OwnedNavigationPlan} from './owned-playwright.js';

const selector=z.string().min(1).max(500).refine(value=>!/[\r\n]/u.test(value),'selector must be one line');
const observedSelector=z.object({status:z.literal('observed'),selector}).strict();
const unobserved=z.object({status:z.literal('unobserved')}).strict();
const selectorObservation=z.union([observedSelector,unobserved]);
const observedRoute=z.object({status:z.literal('observed'),url:z.string().url(),selector}).strict();
const routeObservation=z.union([observedRoute,unobserved]);
const nexacroId=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u);
const nexacroAssetPath=z.string().regex(/^\/Stack\/[A-Za-z0-9_/-]{1,200}\.xfdl\.js$/u);
const observedNexacroOperationDraft=z.object({
  status:z.literal('observed'),
  portal_url:z.string().url(),
  menu:z.object({id:nexacroId,label:z.string().min(1).max(128),asset_path:nexacroAssetPath}).strict(),
  draft:z.object({popup_id:nexacroId,asset_path:nexacroAssetPath,new_button_id:nexacroId,submit_button_id:nexacroId,target_dataset_id:nexacroId}).strict(),
  /** Exact app-owned notices that were observed and whose close action was reviewed. */
  known_popups:z.array(z.object({id:nexacroId,action:z.literal('close'),basis:z.literal('observed')}).strict()).max(32),
}).strict();
const nexacroOperationDraftObservation=z.union([observedNexacroOperationDraft,unobserved]);
const browserSavedPasswordLogin=z.object({
  /** This policy is set by an explicit account owner; it is never model-derived. */
  status:z.literal('user_authorized'),
  password_selector:selector,
  login_selector:selector,
  suggestion:z.object({anchor_x_ratio:z.number().min(.2).max(.8),row_offset_y_css_px:z.number().int().min(24).max(100),popover_wait_ms:z.number().int().min(50).max(1_000),hover_probe_offsets_y_css_px:z.array(z.number().int().min(8).max(120)).min(1).max(8)}).strict(),
}).strict();
const manualAuthenticationRequest=z.object({
  /** Exact, live-observed control. This is never discovered or selected by a model. */
  selector,
  pathname:z.string().regex(/^\/[A-Za-z0-9_./-]{1,500}$/u),
  selector_status:z.literal('observed'),
  /** Exact visible state that means the automatic phone request is already active. */
  automatic_request_pending:observedSelector,
  action_basis:z.literal('user_authorized'),
  /** One bounded wait for the site to start its automatic request first. */
  after_automatic_wait_ms:z.number().int().min(500).max(10_000),
  /** A fallback must never re-send an authentication request. */
  max_clicks:z.literal(1),
}).strict();
const authenticationChallenge=z.object({
  dispatch:z.enum(['automatic_after_login','automatic_then_manual_request','manual_control','unobserved']),
  basis:z.enum(['observed','user_reported','unobserved']),
  manual_request:manualAuthenticationRequest.optional(),
}).strict().superRefine((challenge,context)=>{
  const needsManual=challenge.dispatch==='automatic_then_manual_request';
  if(needsManual&&!challenge.manual_request)context.addIssue({code:z.ZodIssueCode.custom,message:'manual_request required for automatic_then_manual_request'});
  if(!needsManual&&challenge.manual_request)context.addIssue({code:z.ZodIssueCode.custom,message:'manual_request is only permitted for automatic_then_manual_request'});
});

/**
 * Portable, reviewable site facts.  A Task Pack is intentionally unable to
 * upgrade an unobserved form or readback route into a write-capable adapter.
 */
export const liveSiteAdapterConfig=z.object({
  id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  version:z.number().int().positive(),
  adapter_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  entry:z.object({url:z.string().url(),allowed_origins:z.array(z.string().url()).min(1).max(16)}).strict(),
  observation:z.object({capture_policy:z.enum(['always','on_state_change_or_hold'])}).strict(),
  authentication:z.object({
    login_gate:observedSelector,
    /** Human-supplied workflow hints never count as observed completion. */
    challenge:authenticationChallenge,
    /** Optional VM-local browser-chrome action; never available to arbitrary pages or models. */
    browser_saved_password_login:browserSavedPasswordLogin.optional(),
    login_completion:selectorObservation,
    post_auth:z.object({main:selectorObservation,password_rotation_modal:selectorObservation}).strict(),
  }).strict(),
  routes:z.object({form:routeObservation,independent_readback:routeObservation,nexacro_operation_draft:nexacroOperationDraftObservation}).strict(),
  popup_policy:z.object({
    known_dismissible:z.array(z.object({id:z.string().min(1).max(128),dialog:selector,dismiss:selector}).strict()).max(32),
    known_javascript_dialogs:z.array(z.object({id:z.string().min(1).max(128),pathname:z.string().regex(/^\/.+/u),action:z.literal('dismiss'),basis:z.enum(['observed','user_reported'])}).strict()).max(32),
    unknown_dialog:selector,
    unknown_action:z.literal('hold'),
    security_action:z.literal('hold'),
  }).strict(),
}).strict();
export type LiveSiteAdapterConfig=z.infer<typeof liveSiteAdapterConfig>;

export function parseLiveSiteAdapterConfig(value:unknown):LiveSiteAdapterConfig {
  const config=liveSiteAdapterConfig.parse(value);
  requireCondition(config.entry.allowed_origins.includes(new URL(config.entry.url).origin),'LIVE_PACK_ENTRY_ORIGIN_UNDELEGATED');
  if(config.authentication.challenge.dispatch==='automatic_then_manual_request'){
    const request=config.authentication.challenge.manual_request!;
    requireCondition(request.pathname.startsWith('/'),'LIVE_PACK_MANUAL_AUTH_PATH_UNDELEGATED');
  }
  for(const route of [config.routes.form,config.routes.independent_readback]){
    if(route.status==='observed')requireCondition(config.entry.allowed_origins.includes(new URL(route.url).origin),'LIVE_PACK_ROUTE_ORIGIN_UNDELEGATED');
  }
  return config;
}

/** The only plan available before form and readback routes are independently observed. */
export function readOnlyNavigationPlan(config:LiveSiteAdapterConfig):OwnedNavigationPlan {
  return {
    url:config.entry.url,
    allowed_origins:config.entry.allowed_origins,
    logged_in:config.authentication.login_completion.status==='observed'?config.authentication.login_completion.selector:'[data-agent-driver-login-completion-unobserved]',
    authentication_request:config.authentication.login_gate.selector,
    known_popups:config.popup_policy.known_dismissible satisfies readonly KnownPopup[],
    unknown_dialog:config.popup_policy.unknown_dialog,
    capture_policy:config.observation.capture_policy,
  };
}

/** A caller must perform live, read-only mapping before a write adapter exists. */
export function requireLiveWriteAdapterReady(config:LiveSiteAdapterConfig){
  requireCondition(config.authentication.login_completion.status==='observed','LIVE_PACK_LOGIN_COMPLETION_UNOBSERVED');
  requireCondition(config.authentication.post_auth.main.status==='observed','LIVE_PACK_POST_AUTH_MAIN_UNOBSERVED');
  requireCondition(config.authentication.post_auth.password_rotation_modal.status==='observed','LIVE_PACK_POST_AUTH_PASSWORD_MODAL_UNOBSERVED');
  requireCondition(config.routes.form.status==='observed','LIVE_PACK_FORM_ROUTE_UNOBSERVED');
  requireCondition(config.routes.independent_readback.status==='observed','LIVE_PACK_READBACK_ROUTE_UNOBSERVED');
  return {login_completion:config.authentication.login_completion,form:config.routes.form,independent_readback:config.routes.independent_readback};
}

/**
 * Exposes only observed Nexacro routing/component identities from a reviewed
 * Pack.  It does not enable a write path: independent readback and approval
 * remain mandatory at the protocol boundary.
 */
export function requireObservedNexacroOperationDraft(config:LiveSiteAdapterConfig){
  const route=config.routes.nexacro_operation_draft;
  requireCondition(route.status==='observed','LIVE_PACK_NEXACRO_DRAFT_UNOBSERVED');
  requireCondition(config.entry.allowed_origins.includes(new URL(route.portal_url).origin),'LIVE_PACK_NEXACRO_PORTAL_ORIGIN_UNDELEGATED');
  return route;
}
