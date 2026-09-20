import {loadHostConfig} from '../interface/config.js';
import {TerminalHost} from './host.js';
try {await new TerminalHost(loadHostConfig(process.argv[2]!)).run();}
catch {process.exitCode = 1;} // Private upstream content must not reach process logs.
