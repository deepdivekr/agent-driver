import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {TRAVEL_PRICE_WATCH_DEMO_TARGETS,renderTravelPriceWatchDemo} from '../dist/taskpacks/travel-price-watch.js';

const source=process.argv[2]??'both';
if(!['google_flights','booking','both'].includes(source))throw Error('Usage: npm run demo:travel -- [google_flights|booking|both]');
const runId=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const output=resolve(join('artifacts','demos','travel-price-watch',runId));await mkdir(output,{recursive:true,mode:0o700});
const targets=source==='both'?TRAVEL_PRICE_WATCH_DEMO_TARGETS:TRAVEL_PRICE_WATCH_DEMO_TARGETS.filter(target=>target.source===source),receipt=await renderTravelPriceWatchDemo(output,targets,{recordVideo:process.env.AGENT_DRIVER_TRAVEL_NO_VIDEO!=='1'});
await writeFile(join(output,'receipt.json'),`${JSON.stringify(receipt,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({output,receipt},null,2)}\n`);
