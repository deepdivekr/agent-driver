import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {networkProjectPath,windowsModulePath,scanNetworkProject} from '../dist/work/network-project.js';
import {scanProject} from '../dist/work/project-scan.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {readWorkBoard,readWorkDetail} from '../dist/observability/work-view.js';

test('network project paths preserve spaces/Unicode and reject device, traversal and share roots',()=>{
 const unc='\\\\nas.local\\projects\\my bot 한글';
 assert.equal(networkProjectPath(unc),unc);
 assert.equal(networkProjectPath('//nas.local/projects/my bot 한글'),unc);
 for(const path of ['\\\\nas.local\\projects','\\\\nas.local\\projects\\..\\private','\\\\?\\C:\\private','\\\\.\\pipe\\x','\\\\nas.local\\projects\\foo:bar']){
  assert.throws(()=>networkProjectPath(path),/PROJECT_NETWORK_/u);
 }
 assert.equal(networkProjectPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\project'),null);
 assert.equal(networkProjectPath('C:\\projects\\bot'),null);
 assert.equal(windowsModulePath('/home/user/my project/dist/work/project-scan.js','Ubuntu-24.04'),'\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\my project\\dist\\work\\project-scan.js');
 assert.equal(windowsModulePath('/mnt/c/projects/dist/work/project-scan.js','Ubuntu-24.04'),'C:\\projects\\dist\\work\\project-scan.js');
 assert.throws(()=>windowsModulePath('/tmp/x','bad;command'),/WSL_REQUIRED/u);
});

async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'office-network-import-')),project=join(root,'project');await mkdir(project);
 const source='# filler comment\n'.repeat(4500)+'\ndef main():\n    service_key = "'+'private'.repeat(8)+'"\n    print("scan results")\n';
 await writeFile(join(project,'run.py'),source);
 await writeFile(join(project,'.env'),'SECRET=neverread');
 await writeFile(join(root,'outside.py'),'sendMessage("OUTSIDE_PRIVATE")');
 await symlink(join(root,'outside.py'),join(project,'linked.py'));
 const configPath=join(root,'host.json');
 await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'network-import',caller_ref:'test',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true}}));
 const config=loadHostConfig(configPath),calls=[],api=new RuntimeApi(config,{swarmModel:{async call(_purpose,_instructions,input){
  calls.push(input);const e=input.evidence.find(e=>e.signal==='entrypoint');
  return {title:'Existing collector',goal:'Collect and print results',prompt:'Keep the existing collector',steps:[{id:'scan',goal:'Collect records',depends_on:[],evidence_ids:[e.id]}],completion:[{id:'result',result:'Scan results are present',proof:'Original output receipt',evidence_ids:[e.id]}],unknowns:['Original runtime not connected'],enhancements:[{engine:'llm',title:'Explain unexpected output',baseline:'The script currently prints raw scan results.',added_value:'An optional model can explain unexpected output to the user.',fallback:'Keep original printed output on model failure.',evidence_ids:[e.id]}]};
 }}});
 t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
 return {project,api,config,calls,source};
}
test('bounded larger Python entrypoints reach analysis without secret files or linked source',async t=>{
 const x=await setup(t),scan=await scanProject(x.project);
 assert.equal(scan.files_read,1);assert.equal(scan.kind,'unknown');
 const entry=scan.evidence.find(e=>e.signal==='entrypoint');assert.ok(entry?.context);
 assert.ok(entry.line>4000);assert.match(entry.context.text,/def main/u);
 assert.doesNotMatch(JSON.stringify(scan),/neverread|OUTSIDE_PRIVATE|privateprivate/u);
 assert.equal(scan.authority.execution,false);
 const progress=[],preview=await x.api.imports.scan({path:x.project},stage=>progress.push(stage));
 assert.deepEqual(progress,['scanning','analyzing','complete']);assert.equal(x.calls.length,1);
 assert.equal(preview.preview.analysis.goal,'Collect and print results');
 assert.equal(preview.preview.analysis.enhancements.length,1);
 assert.deepEqual(preview.preview.jev_recommendations,[]);
});
test('observation import is prefilled, atomically paused and never presented as running or code improvement',async t=>{
 const x=await setup(t),scan=await x.api.imports.scan({path:x.project,scope:'Keep original runtime'});
 const saved=await x.api.imports.accept({import_id:scan.import_id,mode:'observe'});
 const work=x.api.store.intakeWork(x.config.project.id,saved.work_id);
 assert.equal(work.paused,true);assert.equal(work.spec.route.kind,'workflow');
 assert.equal(work.spec.plan.import_mode,'observe');assert.equal(work.spec.plan.import_scope,'Keep original runtime');
 assert.equal(work.spec.desired_outcome,'Collect and print results');assert.equal(work.spec.completion_checks[0].evidence,'Original output receipt');
 assert.equal(saved.execution,false);assert.equal(saved.schedule_active,false);
 assert.equal(saved.next_action,'connect_original_runtime_without_duplicate_execution');
 const detail=readWorkDetail(x.api.store,x.config,work.id);
 assert.equal(detail.imported_connection.runtime_verified,false);assert.equal(detail.work_control.can_pause,false);
 assert.equal(readWorkBoard(x.api.store,x.config).works.find(w=>w.id===work.id).status,'connection_required');
 assert.deepEqual(x.api.store.officeRuns(x.config.project.id,work.id),[]);
 assert.equal((await x.api.imports.accept({import_id:scan.import_id,mode:'observe'})).work_id,work.id);
 await assert.rejects(x.api.imports.accept({import_id:scan.import_id,mode:'migrate'}),/APPROVAL_CONFLICT/u);
 assert.equal(await readFile(join(x.project,'run.py'),'utf8'),x.source);
});
test('unreadable project does not claim analysis completion and plain Linux gets a mount hint',async()=>{
 await assert.rejects(scanProject(join(tmpdir(),'missing-project-'+Date.now())),/ENOENT/u);
 const old=process.env.WSL_DISTRO_NAME;delete process.env.WSL_DISTRO_NAME;
 try{await assert.rejects(scanNetworkProject('\\\\nas\\share\\bot'),/MOUNT_REQUIRED/u);}finally{if(old)process.env.WSL_DISTRO_NAME=old;}
});
