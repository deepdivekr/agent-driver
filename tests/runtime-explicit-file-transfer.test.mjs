import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExplicitWindowsFileTransferExecutor} from '../dist/isolation/explicit-file-transfer.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'agent-driver-explicit-transfer-'));
  const sourceRoot=join(root,'outputs'),destinationRoot=join(root,'windows-downloads');
  const sourceRelativePath='received-data/sample-measurements.xlsx';
  const destinationFilename='sample-measurements-monthly.xlsx';
  const bytes=Buffer.from('private workbook fixture');
  await mkdir(join(sourceRoot,'received-data'),{recursive:true});
  await writeFile(join(sourceRoot,sourceRelativePath),bytes,{mode:0o600});
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  return {sourceRoot,destinationRoot,sourceRelativePath,destinationFilename,bytes,hash:sha256(bytes)};
}

test('explicit Windows file transfer copies only hash-bound files below fixed roots and is idempotent',async t=>{
  const x=await fixture(t),executor=new ExplicitWindowsFileTransferExecutor({source_root:x.sourceRoot,destination_root:x.destinationRoot,max_file_bytes:1024});
  const request={task_id:'sample-download-2026-09-21',files:[{source_relative_path:x.sourceRelativePath,destination_filename:x.destinationFilename,sha256:x.hash}]};
  const first=await executor.transfer(request);
  assert.equal(first.files[0]?.state,'transferred');
  assert.deepEqual(await readFile(join(x.destinationRoot,x.destinationFilename)),x.bytes);
  const second=await executor.transfer(request);
  assert.equal(second.files[0]?.state,'already_present_verified');
});

test('explicit Windows file transfer rejects path escape, destination conflicts, and hash drift',async t=>{
  const x=await fixture(t),executor=new ExplicitWindowsFileTransferExecutor({source_root:x.sourceRoot,destination_root:x.destinationRoot,max_file_bytes:1024});
  await assert.rejects(executor.transfer({task_id:'transfer',files:[{source_relative_path:'../secret.xlsx',destination_filename:x.destinationFilename,sha256:x.hash}]}),/FILE_TRANSFER_SOURCE_PATH_INVALID/);
  await mkdir(x.destinationRoot,{recursive:true});
  await writeFile(join(x.destinationRoot,x.destinationFilename),'different');
  await assert.rejects(executor.transfer({task_id:'transfer',files:[{source_relative_path:x.sourceRelativePath,destination_filename:x.destinationFilename,sha256:x.hash}]}),/FILE_TRANSFER_DESTINATION_CONFLICT/);
  await assert.rejects(executor.transfer({task_id:'transfer',files:[{source_relative_path:x.sourceRelativePath,destination_filename:'another.xlsx',sha256:'0'.repeat(64)}]}),/FILE_TRANSFER_SOURCE_HASH_MISMATCH/);
});
