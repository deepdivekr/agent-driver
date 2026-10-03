/** Why a client's call failed. A Work stays on its client: the reason decides whether it waits, retries or stops. */
export type ClientFailureReason='auth_expired'|'quota_exhausted'|'rate_limited'|'context_exhausted'|'model_unsupported'|'schema_invalid'|'provider_unavailable'|'invalid_output';
/** The Work, run and stage a call belongs to, from validated IDs in its input. */
export function callProvenance(input:unknown){
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
  const id=(name:string)=>typeof value[name]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value[name])?value[name] as string:null;
  return {work_id:id('work_id'),run_id:id('run_id'),stage_id:id('stage_id')};
}
export function classifyClientFailure(value:unknown):ClientFailureReason{
  if(isInvalidClientOutput(value))return 'invalid_output';
  const message=typeof value==='string'?value:value instanceof Error?value.message:'';
  // A malformed app-owned response schema is not login expiry, quota pressure,
  // or a provider outage. Trying another account cannot repair the request.
  if(message==='CLIENT_OUTPUT_SCHEMA_UNSUPPORTED'||message==='CLIENT_SCHEMA_INVALID'||/\bInvalid schema for response_format\b/iu.test(message))return 'schema_invalid';
  if(message==='CLIENT_MODEL_UNSUPPORTED'||/(?:\bmodel\b[^\r\n]{0,120}\b(?:not supported|unsupported|not found|does not exist)\b|\b(?:unsupported|unknown)\s+model\b)/iu.test(message))return 'model_unsupported';
  if(/(?:auth(?:entication)?|login|session|credential|token).{0,40}(?:expired|invalid|required|failed)|(?:expired|invalid).{0,40}(?:auth|login|session|credential|token)|\b(?:401|403|unauthorized|signed.out)\b/iu.test(message))return 'auth_expired';
  if(/(?:quota|credit|balance|billing|insufficient|usage limit|weekly limit|monthly limit)/iu.test(message)||/\b402\b/u.test(message))return 'quota_exhausted';
  if(/(?:rate.limit|too many requests|retry.after|\b429\b)/iu.test(message))return 'rate_limited';
  if(/(?:context.window|context.length|context.exhausted|maximum context)/iu.test(message))return 'context_exhausted';
  return 'provider_unavailable';
}
export function isInvalidClientOutput(value:unknown){
  return value instanceof SyntaxError||value instanceof Error&&['CLIENT_STRUCTURED_OUTPUT_INVALID','MCP_SAMPLING_INVALID','MODEL_PROVIDER_RESPONSE_INVALID'].includes(value.message);
}
export function isNonRetryableClientFailure(value:unknown){
  return isInvalidClientOutput(value)||value instanceof Error&&['CLIENT_OUTPUT_SCHEMA_UNSUPPORTED','CLIENT_SCHEMA_INVALID','CLIENT_CONNECTION_CHANGED','CLIENT_SESSION_BUSY','CLIENT_SESSION_UNSAFE_STORAGE','CLIENT_SESSION_PERSIST_FAILED'].includes(value.message);
}
