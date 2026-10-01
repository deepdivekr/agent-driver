import net from 'node:net';

/** Node gives each address family 250 ms before trying the next. On a network whose IPv6 route is dead (common under
 * WSL) a slower IPv4 handshake then fails with ETIMEDOUT although the host is reachable (live: api.telegram.org).
 * Importing this module once per process gives each attempt a realistic time. */
if(net.getDefaultAutoSelectFamilyAttemptTimeout()<2500)net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

/** The connection was never established, so nothing was sent. */
export function neverConnected(error:unknown):boolean{
  const codes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT']);
  for(let current:unknown=error,depth=0;current&&typeof current==='object'&&depth<4;current=(current as {cause?:unknown}).cause,depth++){
    const code=(current as {code?:unknown}).code;if(typeof code==='string'&&codes.has(code))return true;
    const errors=(current as {errors?:unknown}).errors;if(Array.isArray(errors)&&errors.length&&errors.every(item=>typeof (item as {code?:unknown})?.code==='string'&&codes.has((item as {code:string}).code)))return true;
  }
  return false;
}
