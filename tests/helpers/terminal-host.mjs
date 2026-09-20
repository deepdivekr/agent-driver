import {loadHostConfig} from '../../dist/interface/config.js';
import {TerminalHost} from '../../dist/terminal/host.js';
import {fixtureLaunch} from './terminal-launcher.mjs';
await new TerminalHost(loadHostConfig(process.argv[2]), fixtureLaunch, async () => {}).run();
