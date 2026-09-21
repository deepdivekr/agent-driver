import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEnv} from 'node:util';

const credentialFile='.secrets/model-credentials.json',directory=await stat('.secrets'),file=await stat(credentialFile);
const values=JSON.parse(await readFile(credentialFile,'utf8')),keys=[values.TYPESAFE_API_KEY];
if(process.argv[2])keys.push(parseEnv(await readFile(process.argv[2],'utf8')).PROMPT_API_KEY);
if(keys.some(key=>typeof key!=='string'||key.length<16))throw Error('MISSING_CREDENTIAL');
if(process.platform!=='win32'&&((directory.mode&0o077)!==0||(file.mode&0o077)!==0))throw Error('CREDENTIAL_PERMISSIONS');
if(!(await readFile('.gitignore','utf8')).split(/\r?\n/u).includes('.secrets/'))throw Error('CREDENTIAL_IGNORE_RULE_MISSING');
let scanned=0;const leaks=[];
async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||['profile','node_modules','video'].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())await scan(path);else if(/\.(?:ts|mjs|json|jsonl|md|txt)$/u.test(path)){const text=await readFile(path,'utf8');scanned++;if(keys.some(key=>text.includes(key)))leaks.push(path);}}}
for(const root of ['src','scripts','docs','tests','artifacts/demos/adaptive-travel','artifacts/adaptive-pack-cache'])await scan(root);
console.log(JSON.stringify({private_file_permissions:'PASS',gitignore_rule:'PASS',scanned,credential_value_leaks:leaks.length,paths:leaks}));
if(leaks.length)process.exitCode=1;
