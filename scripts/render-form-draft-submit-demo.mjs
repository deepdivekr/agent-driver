import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {renderFormDraftSubmitDemo} from '../dist/demo/form-draft-submit-demo.js';

const runId=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const output=resolve(process.argv[2]??join('artifacts','demos','form-draft-submit',runId));
await mkdir(output,{recursive:true,mode:0o700});
const result=await renderFormDraftSubmitDemo(output);
process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
