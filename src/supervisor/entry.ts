import {enableOwnerMcp} from '../integrations/owner-mcp.js';
import {enableOwnerEnvironment} from '../integrations/client-environment.js';
import {enableClientRun} from '../work/client-run.js';
import {loadHostConfig} from '../interface/config.js';
import {Supervisor} from './supervisor.js';
// A service process works for the owner of this computer: their standing AI instructions and skills come along.
enableOwnerEnvironment();
// The owner's own MCP servers may be used; they are first looked at when a delegated Work needs them.
enableOwnerMcp();
// Works run on the client's own agent (Codex or Claude Code) with the owner's settings.
enableClientRun();
try{await new Supervisor(loadHostConfig(process.argv[2]!)).run();}
catch{process.exitCode=1;} // No upstream content, credentials or task payload in process logs.
