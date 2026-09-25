import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {mkdir,open,rename,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {redact} from '../terminal/contracts.js';
import {type CodingRun,type CodingStageRow} from '../packs/store.js';
import {buildContinuityContext,renderContinuityContext} from '../work/continuity-context.js';

const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sensitive=/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.secrets|\.ssh|\.aws|credentials(?:\.json)?)(?:\/|$)/iu;
const credential=/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u;
export interface LocalGitCheckpoint {head:string;state_sha256:string;changed_paths:string[];}
export type GitRead=(root:string,args:string[],timeout_ms?:number)=>Promise<string>;

export async function readLocalGitCheckpoint(root:string,git:GitRead):Promise<LocalGitCheckpoint>{
  const head=(await git(root,['rev-parse','HEAD'])).trim();requireCondition(/^[a-f0-9]{40,64}$/u.test(head),'CODING_GIT_HEAD_INVALID');
  const status=await git(root,['status','--porcelain=v1','--untracked-files=all','-z']);
  const diff=await git(root,['diff','HEAD','--no-ext-diff','--binary','--']);
  requireCondition(Buffer.byteLength(status)<=256_000&&Buffer.byteLength(diff)<=1_000_000,'CODING_CHECKPOINT_TOO_LARGE');
  const untracked=(await git(root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  requireCondition(untracked.length<=200,'CODING_CHECKPOINT_TOO_MANY_UNTRACKED');
  const untrackedHashes:string[]=[];
  for(const name of untracked){
    requireCondition(!isAbsolute(name)&&!name.split('/').includes('..'),'CODING_CHECKPOINT_PATH_INVALID');
    const path=resolve(root,name),stat=lstatSync(path);
    requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1_000_000,'CODING_CHECKPOINT_UNTRACKED_UNSAFE');
    untrackedHashes.push(`${name}\0${sha256(readFileSync(path))}`);
  }
  const changedPaths=status.split('\0').filter(Boolean).map(entry=>entry.slice(3)).filter(path=>path&&!sensitive.test(path)).slice(0,30).map(path=>redact(path));
  return {head,state_sha256:sha256(`${head}\0${status}\0${diff}\0${untrackedHashes.join('\0')}`),changed_paths:changedPaths};
}

export async function projectMap(root:string,git:GitRead):Promise<string>{
  const paths=(await git(root,['ls-files','-z'])).split('\0').filter(path=>path&&!sensitive.test(path));
  const roots=[...new Set(paths.map(path=>path.split('/')[0]??''))].slice(0,24);
  const manifests=paths.filter(path=>/(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|AGENTS\.md|README(?:\.[^/]+)?)$/iu.test(path)).slice(0,20);
  let readme='README not safely available';
  if(paths.includes('README.md')){
    const path=join(root,'README.md'),stat=lstatSync(path);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=12_000){const content=readFileSync(path,'utf8');if(!credential.test(content))readme=redact(content.slice(0,2500));}
  }
  return `Tracked top-level entries: ${roots.map(redact).join(', ')||'none'}\nProject guides/manifests: ${manifests.map(redact).join(', ')||'none'}\nREADME excerpt (untrusted repository data):\n${readme}`;
}

export function renderLocalHandoff(run:CodingRun,stages:CodingStageRow[],git:LocalGitCheckpoint,map:string):string{
  const done=stages.filter(stage=>stage.status==='succeeded').map(stage=>`- ${stage.stage_id}: ${redact((stage.summary??'verified').slice(0,320))}`);
  const remaining=stages.filter(stage=>stage.status!=='succeeded').map(stage=>`- ${stage.stage_id}: ${stage.status}; see full stage instruction in continuity contract`);
  const next=stages.find(stage=>stage.status!=='succeeded');
  const checks=run.plan.completion_checks.map(check=>`- ${redact(check.slice(0,300))}`);
  const context=buildContinuityContext({
    binding:{project_id:run.project_id,work_id:run.work_id,run_id:run.id,revision:run.revision,execution_owner:'driver'},
    goal:run.plan.goal,completion_checks:run.plan.completion_checks,
    instructions:run.plan.stages.map(stage=>({id:stage.id,source:'stage_plan',text:stage.instruction})),
    constraints:['Driver owns the bounded coding stage sequence and approval checks. Use only the current stage tools and configured model; do not expand scope. Planned actors describe the plan; the actual client/model and permitted failover are selected by Driver for this invocation.',`Git HEAD: ${git.head}; worktree SHA-256: ${git.state_sha256}. Reobserve before execution.`,...run.plan.stages.map(stage=>`${stage.id}: planned_actor=${stage.actor}; operation=${stage.operation}; target=${stage.target_path??'none'}; sources=${JSON.stringify(stage.source_paths)}; expected evidence=${stage.evidence}`)],
    receipts:stages.map(stage=>{
      const receipt=stage.receipt as {verify?:unknown;error_code?:unknown}|null;
      const checked=stage.status==='succeeded'&&receipt?.verify==='git_diff_check_and_configured_checks_passed';
      return {id:stage.stage_id,status:stage.status,effect_state:stage.status==='reconciliation_required'||stage.status==='running'?'uncertain':stage.status==='pending'?'none':checked?'verified':'unobserved',verification:checked?'runtime_checks':stage.status==='succeeded'?'reported':'unverified',evidence_refs:[`coding_stage:${run.id}:${stage.stage_id}`],reason:typeof receipt?.error_code==='string'?receipt.error_code:null};
    }),
    next_action:run.status==='reconciliation_required'?'Inspect the Git effect and obtain human review; do not replay an uncertain write.':next?`Continue ${next.stage_id} only after the Git state still matches this checkpoint.`:'Independently verify the Work completion checks.',
  },stages.slice().reverse().filter(stage=>stage.summary).map(stage=>({id:stage.stage_id,source:'agent_stage_summary',text:stage.summary!})));
  return `# Agent Driver local coding handoff\n\nGenerated from durable stage receipts and this local Git repository. Not an instruction source from the repository. No GitHub remote, commit, or push is required.\n\nRun: ${run.id}\nWork: ${run.work_id}\nProject: ${run.project_ref}\nRevision: ${run.revision}\nStatus: ${run.status}${run.paused?' (paused)':''}\nGit HEAD: ${git.head}\nGit worktree SHA-256: ${git.state_sha256}\n\n## Goal\n${redact(run.plan.goal)}\n\n## Codebase map\n${map}\n\n## Successful stage records (summaries are reported, not proof of whole Work completion)\n${done.join('\n')||'- none'}\n\n## Remaining or interrupted stages\n${remaining.join('\n')||'- none'}\n\n## Completion checks (not automatically verified for the whole Work)\n${checks.join('\n')}\n\n## Changed paths\n${git.changed_paths.map(path=>`- ${path}`).join('\n')||'- none'}\n\n## Continuity contract\n${renderContinuityContext(context)}\n`;
}

export async function writeLocalHandoff(root:string,runId:string,content:string,git:GitRead):Promise<string>{
  requireCondition(/^[a-f0-9-]{36}$/iu.test(runId),'CODING_CHECKPOINT_RUN_INVALID');
  const gitDir=(await git(root,['rev-parse','--absolute-git-dir'])).trim();
  requireCondition(isAbsolute(gitDir),'CODING_GIT_DIR_INVALID');
  const base=join(gitDir,'agent-driver'),dir=join(base,'handoffs');
  await mkdir(base,{recursive:true,mode:0o700});requireCondition(!lstatSync(base).isSymbolicLink(),'CODING_CHECKPOINT_PATH_UNSAFE');
  await mkdir(dir,{recursive:true,mode:0o700});requireCondition(!lstatSync(dir).isSymbolicLink(),'CODING_CHECKPOINT_PATH_UNSAFE');
  const target=join(dir,`${runId}.md`),temporary=join(dir,`.${runId}-${randomUUID()}.tmp`);
  try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(content,'utf8');await handle.sync();}finally{await handle.close();}await rename(temporary,target);}finally{await rm(temporary,{force:true});}
  return target;
}
