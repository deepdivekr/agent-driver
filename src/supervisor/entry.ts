import {loadHostConfig} from '../interface/config.js';
import {Supervisor} from './supervisor.js';
try{await new Supervisor(loadHostConfig(process.argv[2]!)).run();}
catch{process.exitCode=1;} // No upstream content, credentials or task payload in process logs.
