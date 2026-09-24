import {redact} from '../terminal/contracts.js';

/** Responses are displayed to a human, but must not turn a CLI transcript into a credential store. */
export function sanitizeCodingReply(reply:string):{text:string;redacted:boolean}{
  let text=redact(reply);
  // A credential may appear in a .env excerpt, HTTP header, JSON object, URL or plain prose.
  const credentialName=String.raw`(?:password|passwd|pwd|api[_-]?key|apiKey|access[_-]?key|accessKey|secret|client[_-]?secret|clientSecret|private[_-]?key|privateKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|session[_-]?id|sessionId|session|cookie|set-cookie|authorization)`;
  text=text.replace(new RegExp(String.raw`\b(${credentialName})\b(["']?\s*[=:]\s*["']?)([^\s,"';}]+)`,'giu'),(_all,name,separator)=>`${name}${separator}[REDACTED]`);
  text=text.replace(/\b((?:Authorization|Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/giu,'$1[REDACTED]');
  text=text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=?/giu,'Bearer [REDACTED]');
  text=text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/gu,'[REDACTED_JWT]');
  text=text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,'[REDACTED_PRIVATE_KEY]');
  text=text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,'[REDACTED_ACCESS_KEY]');
  // This conservative fallback catches opaque, high-entropy tokens from unknown providers.
  text=text.replace(/\b(?=[A-Za-z0-9_+/=-]{40,}\b)(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{40,}\b/gu,'[REDACTED_OPAQUE_TOKEN]');
  return {text,redacted:text!==reply};
}
