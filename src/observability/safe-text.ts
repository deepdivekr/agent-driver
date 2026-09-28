import {redact} from '../terminal/contracts.js';
import {sanitizeSwarmEndpoint} from '../swarm/dashboard.js';

// Kept separate so log sanitization does not load the HTTP server and UI bundle.
export const safeControlText=(value:string,max=240)=>{const safe=redact(value).replace(/https?:\/\/[^\s<>"']+/giu,url=>sanitizeSwarmEndpoint(url)??'[REDACTED_URL]').replace(/((?:token|secret|password|api.?key)\s*[:=]\s*)\S+/giu,'$1[REDACTED]');return safe.length<=max?safe:`${safe.slice(0,max-1)}…`;};
