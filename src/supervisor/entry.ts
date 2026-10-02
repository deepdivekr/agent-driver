import {enableOwnerEnvironment} from '../integrations/client-environment.js';
import {loadHostConfig} from '../interface/config.js';
import {Supervisor} from './supervisor.js';
// A service process works for the owner of this computer: their standing AI instructions and skills come along.
enableOwnerEnvironment();
try{await new Supervisor(loadHostConfig(process.argv[2]!)).run();}
catch{process.exitCode=1;} // No upstream content, credentials or task payload in process logs.
