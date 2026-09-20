import {launchResourceUnit} from '../../dist/resources/budget.js';
const budget=JSON.parse(process.argv[2]);
const target=new URL('./resource-load.mjs',import.meta.url).pathname;
const run=await launchResourceUnit(budget,process.execPath,[target,'descendant'],{},20000);
console.log(JSON.stringify({unit:run.unit}));
run.child.stdout.pipe(process.stdout);run.child.stderr.pipe(process.stderr);process.stdin.pipe(run.child.stdin);
run.child.once('exit',code=>{process.exitCode=code??1;process.stdin.destroy();});
