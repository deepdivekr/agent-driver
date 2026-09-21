// Explicit diagnostic replay of a public observation, with no browser or effect.
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {join} from 'node:path';
import {compileAdaptiveRequest} from '../dist/taskpack/adaptive-decision.js';
import {correctAdaptiveStep} from '../dist/taskpack/adaptive-decision.js';
import {hashJson,adaptiveLlmFromHostEnvironment} from '../dist/taskpack/adaptive-spec.js';
import {typeSafeTransportFromHostEnvironment} from '../dist/taskpack/typesafe-jev.js';

const [root,credentialsFile,envFile]=process.argv.slice(2);
const credentials=JSON.parse(await readFile(credentialsFile,'utf8'));
const environment={TYPESAFE_API_KEY:credentials.TYPESAFE_API_KEY,OPENAI_API_KEY:parseEnv(await readFile(envFile,'utf8')).PROMPT_API_KEY};
const receipt=JSON.parse(await readFile(join(root,'source-receipt.json'),'utf8')),snapshot=JSON.parse(await readFile(join(root,'final-observation.json'),'utf8'));
snapshot.elements=snapshot.elements.map(element=>({options:[],value:'',href:'',checked:null,signature:'diagnostic-only',...element}));
const binding=hashJson({task:receipt.task,designer_version:'adaptive_readonly_v1'}),saved=JSON.parse(await readFile(`artifacts/adaptive-pack-cache/${binding}.draft.json`,'utf8'));
const {request}=compileAdaptiveRequest(receipt.task,saved.spec,snapshot,[]);
const redact=value=>Object.values(environment).filter(Boolean).reduce((s,key)=>s.replaceAll(key,'[REDACTED]'),String(value)).replace(/(?:apikey_|sk-)[A-Za-z0-9_-]{12,}/gu,'[REDACTED]').slice(0,800);
try {const raw=await typeSafeTransportFromHostEnvironment(environment).systemOne(request,{timeout:15000,retry:{maxRetries:0}});console.log(JSON.stringify({provider:'jev',status:'responded',model:raw.model,usage:raw.usage}));}
catch(error){console.log(JSON.stringify({provider:'jev',status:'failed',http_status:error.status??null,reason:redact(error.message),state_chars:JSON.stringify(request.state).length,question_count:Object.keys(request.questions).length}));}
const fetcher=async(...args)=>{const response=await fetch(...args);const raw=await response.clone().json();console.log(JSON.stringify({provider:'luna',http_status:response.status,status:raw.status,output_types:raw.output?.map(item=>item.type),content_types:raw.output?.flatMap(item=>(item.content??[]).map(part=>part.type)),text_shape:raw.output?.flatMap(item=>(item.content??[]).filter(part=>part.type==='output_text').map(part=>({length:part.text.length,prefix:redact(part.text).slice(0,300)}))),refusal:raw.output?.flatMap(item=>(item.content??[]).filter(part=>part.type==='refusal').map(part=>redact(part.refusal))),error:raw.error?redact(raw.error.message):undefined}));return response;};
const model=adaptiveLlmFromHostEnvironment(environment,fetcher);
try {await correctAdaptiveStep(model,receipt.task,saved.spec,snapshot,[],'ADAPTIVE_CHOICE_UNCERTAIN');console.log(JSON.stringify({provider:'luna',status:'parsed',calls:model.calls}));}catch{console.log(JSON.stringify({provider:'luna',status:'not_parsed',calls:model.calls}));}
