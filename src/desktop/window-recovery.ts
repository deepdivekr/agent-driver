/** Shared recovery vocabulary. Unknown visibility is not a hidden window and
 * a capture failure is not proof that an application is hung. */
export const WINDOW_OBSERVATION_ERRORS=new Set([
  'CUA_VISUAL_WINDOW_MINIMIZED','CUA_VISUAL_CAPTURE_UNAVAILABLE','CUA_VISUAL_CAPTURE_DEGRADED',
  'CUA_WINDOW_RESTORE_UNVERIFIED','CUA_WINDOW_RESTORE_OBSERVATION_UNAVAILABLE',
  'CUA_WINDOW_ACTIVATION_REQUIRED','CUA_WINDOW_RECOVERY_EXHAUSTED','CUA_TARGET_WINDOW_MISSING',
  'CUA_WINDOW_CHANGED','CUA_WINDOW_UNRESPONSIVE','CUA_WINDOW_RECOVERY_UNVERIFIED',
]);
export function windowRecoveryNextAction(reason:string){
  if(reason==='CUA_TARGET_WINDOW_MISSING')return 'reconnect_requested_application';
  if(reason==='CUA_WINDOW_CHANGED')return 'reconfirm_window_identity';
  if(reason==='CUA_WINDOW_UNRESPONSIVE')return 'check_application_responsiveness';
  if(reason==='CUA_VISUAL_WINDOW_MINIMIZED')return 'restore_authorized_window_then_retry';
  if(reason==='CUA_WINDOW_ACTIVATION_REQUIRED')return 'approve_foreground_or_choose_background_executor';
  if(reason==='CUA_WINDOW_RECOVERY_EXHAUSTED')return 'inspect_window_recovery_no_blind_retry';
  return 'check_window_capture_then_retry';
}
export function captureRecoveryError(reason:string){return ['CUA_VISUAL_WINDOW_MINIMIZED','CUA_VISUAL_CAPTURE_UNAVAILABLE','CUA_VISUAL_CAPTURE_DEGRADED'].includes(reason);}
