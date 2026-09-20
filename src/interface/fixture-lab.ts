import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startFixture} from '../evaluation-v2/fixture.js';
import {makeCase} from '../evaluation-v2/oracle.js';

// Explicit host-only lab setup, not an MCP tool or real account onboarding.
export async function serveFixtureLab(directory:string){
  const root=resolve(directory);await mkdir(dirname(root),{recursive:true,mode:0o700});
  await mkdir(root,{mode:0o700}); // Never overwrite a previous lab's configuration/history.
  const fixture=await startFixture();
  try{
    const url=fixture.create(makeCase('draft','S02',17,'normal')),path=join(root,'host.json');
    const config={schema_version:1,project_id:`lab-${randomUUID()}`,caller_ref:'local-agent',account_ref:'account-a',worktree:process.cwd(),data_dir:root,environment:'fixture',fixture_url:url};
    await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
    let closing=false;
    const close=()=>{if(!closing){closing=true;void fixture.close().catch(()=>{process.exitCode=1;});}};
    process.once('SIGINT',close);process.once('SIGTERM',close);
    console.log(JSON.stringify({config_file:path,fixture_url:url,environment:'synthetic_only',persistent_business_data:false,next_action:'connect_cli_or_mcp_using_config_file'}));
  }catch(error){await fixture.close();throw error;}
}
