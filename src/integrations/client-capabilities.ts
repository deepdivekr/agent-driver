/** Capabilities of this runtime's bounded decision adapters, not of the whole CLI.
 * Installation/authentication is observed separately. A contract grants neither
 * execution authority nor permission to fall back to a paid provider.
 */
export type DecisionClientId='mcp'|'codex'|'claude'|'opencode'|'cursor'|'hermes'|'api';
export interface DecisionClientCapabilities {
  version:1;
  client:DecisionClientId;
  transport:'mcp_sampling'|'official_cli'|'http_api';
  structured_judgment:'supported'|'unsupported'|'requires_negotiation';
  session_continuity:'new_bounded_turn';
  tool_authority:'none';
  model_selection:'saved_configuration'|'host_owned'|'unsupported';
  evidence:'adapter_contract';
}

export function decisionClientCapabilities(client:DecisionClientId):Readonly<DecisionClientCapabilities>{
  const unsupported=client==='cursor'||client==='hermes';
  return Object.freeze({version:1,client,transport:client==='mcp'?'mcp_sampling':client==='api'?'http_api':'official_cli',
    structured_judgment:unsupported?'unsupported':client==='mcp'?'requires_negotiation':'supported',
    session_continuity:'new_bounded_turn',tool_authority:'none',
    model_selection:unsupported?'unsupported':client==='mcp'?'host_owned':'saved_configuration',evidence:'adapter_contract'});
}

export function supportsStructuredJudgment(client:DecisionClientId,samplingAdvertised=false){
  const capability=decisionClientCapabilities(client).structured_judgment;
  return capability==='supported'||capability==='requires_negotiation'&&samplingAdvertised;
}
