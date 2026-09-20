import {serveFileBroker} from './file-broker.js';
const [, , config, session, generation, host] = process.argv;
if (!config || !session || !generation || !host || !/^\d+$/.test(generation)) throw Error('BROKER_BINDING_REQUIRED');
await serveFileBroker(config, session, Number(generation), host);
