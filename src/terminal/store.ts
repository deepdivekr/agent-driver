import {createHash, randomUUID} from 'node:crypto';
import {RecoveryStore} from '../supervisor/store.js';
import {requireCondition} from '../core/contracts.js';
import {bootClock, processIdentitySync, type ProcessIdentity} from '../supervisor/identity.js';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {type FileAuthority, type FileIntent, type FileWrite, brokerTools} from './file-contracts.js';
import {sha256, type FileObservation} from './scoped-files.js';
import {writeSpoolSegment,type SpoolSegment} from './spool.js';
import {observeArtifact,type ArtifactManifest} from '../storage/artifacts.js';
import {StorageRetention} from '../storage/retention.js';
import {redact, type TerminalList, type TerminalHistory, type TerminalOutput, type TerminalHostRecord, type TerminalSession, type TerminalSubmit, type TerminalTurn, type TurnResult} from './contracts.js';

export class TerminalStore extends RecoveryStore {
  retention(config:HostConfig){return new StorageRetention(this.connection,fn=>this.transaction(fn),this,config);}
  noteStorage(id:string,kind:string,data:Record<string,unknown>){this.event(this.session(id).task_id,kind,data);}
  registerArtifact(id:string,generation:number,kind:'spool'|'handoff',manifest:ArtifactManifest) {
    const session=this.session(id),key=createHash('sha256').update(`${id}:${manifest.directory}:${manifest.filename}`).digest('hex');
    const old=this.connection.prepare('SELECT state,manifest_json FROM storage_artifact WHERE id=?').get(key);
    requireCondition(!old||old.state==='retained','STORAGE_ARTIFACT_EXPIRED');
    if(old){const before=JSON.parse(String(old.manifest_json)) as ArtifactManifest;requireCondition(before.file_identity===manifest.file_identity&&before.root_identity===manifest.root_identity&&before.directory_identity===manifest.directory_identity,'STORAGE_ARTIFACT_REPLACED');}
    this.connection.prepare("INSERT INTO storage_artifact(id,project_id,session_id,generation,kind,manifest_json,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,manifest_json=excluded.manifest_json,created_at=excluded.created_at").run(key,session.project_id,id,generation,kind,JSON.stringify(manifest),new Date().toISOString());
    return key;
  }
  session(id: string): TerminalSession {
    const row = this.connection.prepare('SELECT * FROM terminal_session WHERE id=?').get(id);
    requireCondition(row, 'SESSION_NOT_FOUND');
    return row as unknown as TerminalSession;
  }
  sessions(project: string) {
    return this.connection.prepare('SELECT * FROM terminal_session WHERE project_id=? ORDER BY created_at,id').all(project) as unknown as TerminalSession[];
  }
  turn(id: string): TerminalTurn {
    const row = this.connection.prepare('SELECT * FROM terminal_turn WHERE id=?').get(id);
    requireCondition(row, 'TURN_NOT_FOUND'); return row as unknown as TerminalTurn;
  }
  terminalHost(project: string) {
    return this.connection.prepare('SELECT * FROM terminal_host WHERE project_id=?').get(project) as unknown as TerminalHostRecord | undefined;
  }
  claimTerminalHost(config: HostConfig, identity: ProcessIdentity, previous: string | null, endpoint: string, token: string) {
    return this.transaction(() => {
      const old = this.terminalHost(config.project.id);
      requireCondition((old?.instance_id ?? null) === previous, 'HOST_CLAIM_RACE');
      const instance = randomUUID();
      this.connection.prepare('INSERT INTO terminal_host VALUES (?,?,?,?,?,?,1,0) ON CONFLICT(project_id) DO UPDATE SET instance_id=excluded.instance_id,identity_json=excluded.identity_json,config_hash=excluded.config_hash,endpoint=excluded.endpoint,token=excluded.token,active=1,stop_requested=0').run(config.project.id, instance, JSON.stringify(identity), config.fingerprint, endpoint, token);
      return instance;
    });
  }
  assertHost(project: string, instance: string) {
    const host = this.terminalHost(project);
    requireCondition(host?.active === 1 && host.instance_id === instance && !host.stop_requested, 'STALE_TERMINAL_HOST');
  }
  stopTerminalHost(project: string, instance: string) {
    this.connection.prepare('UPDATE terminal_host SET stop_requested=1 WHERE project_id=? AND instance_id=?').run(project, instance);
  }
  retireTerminalHost(project: string, instance: string) {
    this.connection.prepare('UPDATE terminal_host SET active=0 WHERE project_id=? AND instance_id=?').run(project, instance);
  }
  startSession(config: HostConfig, request: string) {
    requireCondition(config.terminal, 'TERMINAL_DISABLED');
    requireCondition(this.project(config.project.id).capabilities.includes('coding.session'), 'CAPABILITY_NOT_DELEGATED');
    return this.transaction(() => {
      const old = this.connection.prepare('SELECT id,config_hash FROM terminal_session WHERE project_id=? AND request_id=?').get(config.project.id, request);
      if (old) {
        requireCondition(old.config_hash === config.fingerprint, 'REQUEST_ID_CONFLICT');
        return {session: this.session(String(old.id)), created: false};
      }
      requireCondition(this.sessions(config.project.id).filter(s => !['session_closed', 'process_exited'].includes(s.state) || s.resume_requested).length < 4, 'TERMINAL_SESSION_LIMIT');
      const id = randomUUID(), task = randomUUID(), at = new Date().toISOString();
      this.connection.prepare("INSERT INTO task(id,project_id,capability,status,next_action,selected_route,target_ref,created_at,updated_at) VALUES (?,?,'coding.session','queued','terminal_host_start','claude.structured',?,?,?)").run(task, config.project.id, id, at, at);
      this.connection.prepare('INSERT INTO terminal_session(id,project_id,task_id,request_id,cli_session_id,worktree,executable,version,config_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, config.project.id, task, request, randomUUID(), config.project.worktree, config.terminal!.executable, config.terminal!.version, config.fingerprint, at);
      this.event(task, 'terminal.accepted', {session_ref: id, request_id: request});
      return {session: this.session(id), created: true};
    });
  }
  private bound(id: string, instance: string, generation?: number) {
    const session = this.session(id); this.assertHost(session.project_id, instance);
    requireCondition(session.host_instance_id === instance && (generation === undefined || session.generation === generation), 'STALE_TERMINAL_BINDING');
    return session;
  }
  claimSession(id: string, instance: string, config: HostConfig) {
    return this.transaction(() => {
      this.assertHost(config.project.id, instance);
      const session = this.session(id);
      requireCondition(session.project_id === config.project.id && session.config_hash === config.fingerprint, 'CONFIG_CHANGED');
      const resume = session.resume_requested === 1;
      requireCondition(!session.manual_control && !session.interrupt_requested && !this.task(session.task_id).cancel_requested, 'TERMINAL_WRITER_DISABLED');
      requireCondition((session.state === 'starting' && !session.host_instance_id) || (resume && session.state === 'process_exited' && !session.active_turn_id && session.last_turn_id), 'SESSION_NOT_STARTABLE');
      const generation = session.generation + (resume ? 1 : 0);
      this.connection.prepare("UPDATE terminal_session SET host_instance_id=?,process_identity_json=NULL,generation=?,state='starting',resume_requested=0,interrupt_requested=0,error_code=NULL WHERE id=?").run(instance, generation, id);
      // Persist ownership before spawn: a crash here is ambiguous, never a blind restart.
      this.event(session.task_id, resume ? 'terminal.resume_started' : 'terminal.starting', {session_ref: id, generation, cli_session_id: session.cli_session_id});
      return {session: this.session(id), resume};
    });
  }
  stopBeforeStart(id: string, instance: string) {
    this.transaction(() => {
      const session = this.session(id); this.assertHost(session.project_id, instance);
      requireCondition(session.state === 'starting' && !session.host_instance_id && !session.process_identity_json, 'PROCESS_MAY_HAVE_STARTED');
      requireCondition(session.interrupt_requested || session.manual_control || this.task(session.task_id).cancel_requested, 'STOP_NOT_REQUESTED');
      this.connection.prepare("UPDATE terminal_session SET state='session_closed',error_code='STOPPED_BEFORE_START' WHERE id=?").run(id);
      this.state(session.task_id, 'cancelled', 'stopped_before_start', 'none');
      this.event(session.task_id, 'terminal.stopped_before_start', {session_ref: id, process_started: false});
    });
  }
  bindProcess(id: string, instance: string, generation: number, identity: ProcessIdentity) {
    this.transaction(() => {
      const session = this.bound(id, instance, generation);
      requireCondition(session.state === 'starting' && !session.process_identity_json, 'PROCESS_ALREADY_BOUND');
      this.connection.prepare('UPDATE terminal_session SET process_identity_json=? WHERE id=?').run(JSON.stringify(identity), id);
      this.event(session.task_id, 'terminal.process_bound', {session_ref: id, generation, process_identity: identity});
    });
  }
  ready(id: string, instance: string, generation: number) {
    this.transaction(() => {
      const session = this.bound(id, instance, generation);
      requireCondition(['starting', 'turn_completed'].includes(session.state) && session.process_identity_json && !session.active_turn_id && !session.manual_control && !session.interrupt_requested && !this.task(session.task_id).cancel_requested, 'NOT_INPUT_READY');
      this.connection.prepare("UPDATE terminal_session SET state='input_ready' WHERE id=?").run(id);
      this.state(session.task_id, 'waiting_orchestrator', 'submit_next_verified_prompt');
      this.event(session.task_id, 'terminal.input_ready', {session_ref: id, generation, source: 'host_live_writable_transport', official_cli_ready_event: false});
    });
  }
  submit(config: HostConfig, request: TerminalSubmit) {
    requireCondition(config.terminal, 'TERMINAL_DISABLED');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.transaction(() => {
      const session = this.session(request.session_ref);
      requireCondition(session.project_id === config.project.id && session.config_hash === config.fingerprint, 'SESSION_SCOPE_MISMATCH');
      const previous = this.connection.prepare('SELECT id,request_hash FROM terminal_turn WHERE session_id=? AND request_id=?').get(session.id, request.request_id);
      if (previous) {
        requireCondition(previous.request_hash === hash, 'REQUEST_ID_CONFLICT');
        return {turn: this.turn(String(previous.id)), created: false};
      }
      requireCondition(session.generation === request.expected_generation, 'STALE_SESSION_GENERATION');
      requireCondition(session.last_turn_id === request.expected_previous_turn_id, 'PREVIOUS_TURN_MISMATCH');
      requireCondition(session.state === 'input_ready' && !session.active_turn_id && !session.manual_control && !session.interrupt_requested && !this.task(session.task_id).cancel_requested, 'TERMINAL_NOT_INPUT_READY');
      requireCondition(session.turn_count < config.terminal!.max_turns, 'TURN_BUDGET_EXHAUSTED');
      requireCondition(!this.pendingVerification(session.worktree), 'VERIFIER_IN_PROGRESS');
      const id = randomUUID();
      this.connection.prepare('INSERT INTO terminal_turn(id,session_id,request_id,request_hash,generation,prompt,created_at) VALUES (?,?,?,?,?,?,?)').run(id, session.id, request.request_id, hash, session.generation, request.prompt, new Date().toISOString());
      this.connection.prepare("UPDATE terminal_session SET active_turn_id=?,state='streaming',turn_count=turn_count+1 WHERE id=?").run(id, session.id);
      this.state(session.task_id, 'running', 'terminal_turn_accepted');
      this.event(session.task_id, 'terminal.prompt_accepted', {turn_id: id, generation: session.generation, request_id: request.request_id, input_hash: hash});
      if (session.turn_count + 1 === config.terminal!.max_turns) this.event(session.task_id, 'orchestrator.replan_required', {reason: 'TURN_BUDGET_REACHED', automatically_submitted: false});
      return {turn: this.turn(id), created: true};
    });
  }
  dispatch(id: string, instance: string, generation: number, config: HostConfig) {
    return this.transaction(() => {
      const session = this.bound(id, instance, generation);
      requireCondition(session.config_hash === config.fingerprint && session.worktree === config.project.worktree && session.executable === config.terminal?.executable && session.version === config.terminal.version, 'CONFIG_CHANGED');
      requireCondition(session.state === 'streaming' && session.active_turn_id && session.process_identity_json && !session.manual_control && !session.interrupt_requested && !this.task(session.task_id).cancel_requested, 'TERMINAL_WRITER_DISABLED');
      const turn = this.turn(session.active_turn_id);
      requireCondition(turn.status === 'accepted' && turn.generation === generation, 'TURN_ALREADY_DISPATCHED');
      this.connection.prepare("UPDATE terminal_turn SET status='dispatched',deadline_uptime_ms=? WHERE id=?").run(bootClock().uptimeMs + config.terminal.turn_deadline_ms, turn.id);
      this.state(session.task_id, 'running', 'await_cli_receipt', 'unknown');
      this.event(session.task_id, 'terminal.prompt_started', {turn_id: turn.id, generation, effect_not_yet_verified: true});
      return this.turn(turn.id);
    });
  }
  acknowledge(id: string, instance: string, generation: number, turnId: string) {
    this.transaction(() => {
      const session = this.bound(id, instance, generation);
      requireCondition(session.active_turn_id === turnId && this.turn(turnId).status === 'dispatched', 'CLI_RECEIPT_MISMATCH');
      this.connection.prepare("UPDATE terminal_turn SET status='acknowledged' WHERE id=?").run(turnId);
      this.event(session.task_id, 'terminal.prompt_received', {turn_id: turnId, source: 'official_user_replay'});
    });
  }
  result(id: string, instance: string, generation: number, result: TurnResult) {
    this.transaction(() => {
      const session = this.bound(id, instance, generation);
      requireCondition(session.active_turn_id && this.turn(session.active_turn_id).status === 'acknowledged', 'UNBOUND_CLI_RESULT');
      const turn = session.active_turn_id;
      this.connection.prepare("UPDATE terminal_turn SET status='turn_completed',result_json=? WHERE id=?").run(JSON.stringify(result), turn);
      this.connection.prepare('UPDATE terminal_session SET state=?,last_turn_id=?,active_turn_id=NULL WHERE id=?').run(result.outcome === 'completed' ? 'turn_completed' : result.outcome, turn, id);
      this.state(session.task_id, 'waiting_orchestrator', 'verify_diff_and_tests_before_project_completion', 'unknown');
      this.event(session.task_id, 'terminal.turn_completed', {turn_id: turn, generation, outcome: result.outcome, project_completed: false, verification: 'unobserved'});
      const recent = this.connection.prepare("SELECT result_json FROM terminal_turn WHERE session_id=? AND status='turn_completed' ORDER BY created_at DESC,id DESC LIMIT 3").all(id);
      if (recent.length === 3 && recent.every(row => row.result_json === JSON.stringify(result))) this.event(session.task_id, 'orchestrator.replan_required', {reason: 'REPEATED_RESULT_REQUIRES_PROGRESS_CHECK', progress: 'unobserved', automatically_submitted: false});
    });
  }
  noteSpool(id: string, instance: string, generation: number, bytes: number, kind: string, sha256?: string) {
    this.transaction(() => {
      const session = this.bound(id, instance, generation);
      const segment=this.spoolSegments(id).at(-1);
      requireCondition(!segment||segment.start_offset===0&&segment.state==='open','CLI_SPOOL_LEGACY_SEGMENT_MISMATCH');
      this.connection.prepare("INSERT INTO terminal_spool_segment VALUES (?,0,?,?,'open') ON CONFLICT(session_id,start_offset) DO UPDATE SET bytes=excluded.bytes").run(id,session.spool_bytes+bytes,`${id}.jsonl`);
      this.connection.prepare('UPDATE terminal_session SET spool_bytes=spool_bytes+? WHERE id=?').run(bytes, id);
      this.event(session.task_id, 'terminal.output', {session_ref: id, generation, bytes, spool_offset: session.spool_bytes + bytes, event_type: kind, ...(sha256 ? {sha256} : {})});
    });
  }
  spoolSegments(id:string) {return this.connection.prepare('SELECT * FROM terminal_spool_segment WHERE session_id=? ORDER BY start_offset').all(id) as unknown as SpoolSegment[];}
  appendSpool(config:HostConfig,id:string,instance:string,generation:number,line:Buffer,kind:string) {
    return this.storage(config).run('spool_frame',line.length*2+131072,()=>this.transaction(()=>{
      const session=this.bound(id,instance,generation);
      requireCondition(session.spool_bytes+line.length<=config.terminal!.spool_bytes,'CLI_SPOOL_QUOTA');
      const limit=config.storage?.segment_bytes??262144;
      // A frame is never split across segments. Its existing protocol bound still applies.
      const previous=this.spoolSegments(id).at(-1);let segment=previous,created=false;
      requireCondition(!previous||previous.state==='open'&&previous.start_offset+previous.bytes===session.spool_bytes,'CLI_SPOOL_SEGMENT_GAP');
      const previousArtifact=previous?this.connection.prepare("SELECT manifest_json FROM storage_artifact WHERE session_id=? AND kind='spool' AND json_extract(manifest_json,'$.filename')=?").get(id,previous.filename):undefined;
      if(previous){
        const observed=observeArtifact(config.dbPath,'terminal-spool',previous.filename);
        requireCondition(observed.bytes===previous.bytes,'CLI_SPOOL_DURABILITY_GAP');
        if(previousArtifact)requireCondition(previousArtifact.manifest_json===JSON.stringify(observed),'CLI_SPOOL_HASH_MISMATCH');
      }
      if(!previous||previous.bytes>0&&previous.bytes+line.length>limit){
        if(previous)this.connection.prepare("UPDATE terminal_spool_segment SET state='sealed' WHERE session_id=? AND start_offset=?").run(id,previous.start_offset);
        segment={session_id:id,start_offset:session.spool_bytes,bytes:0,filename:session.spool_bytes?`${id}-${session.spool_bytes}.jsonl`:`${id}.jsonl`,state:'open'};created=true;
        this.connection.prepare("INSERT INTO terminal_spool_segment VALUES (?,?,0,?,'open')").run(id,segment.start_offset,segment.filename);
      }
      requireCondition(segment,'CLI_SPOOL_SEGMENT_MISSING');
      writeSpoolSegment(config.dbPath,segment,line,created);
      // A migrated, previously unregistered segment is readable but not retroactively owned for deletion.
      if(created||previousArtifact)this.registerArtifact(id,generation,'spool',observeArtifact(config.dbPath,'terminal-spool',segment.filename));
      this.connection.prepare('UPDATE terminal_spool_segment SET bytes=bytes+? WHERE session_id=? AND start_offset=?').run(line.length,id,segment.start_offset);
      this.connection.prepare('UPDATE terminal_session SET spool_bytes=spool_bytes+? WHERE id=?').run(line.length,id);
      this.event(session.task_id,'terminal.output',{session_ref:id,generation,bytes:line.length,spool_offset:session.spool_bytes+line.length,event_type:kind,sha256:sha256(line)});
    }));
  }
  failed(id: string, instance: string, generation: number, reason: string, hostFailure = false) {
    this.transaction(() => {
      const session = this.session(id), owner = this.terminalHost(session.project_id);
      requireCondition(owner?.active === 1 && owner.instance_id === instance, 'STALE_TERMINAL_HOST');
      requireCondition(session.generation === generation && (hostFailure || session.host_instance_id === instance), 'STALE_TERMINAL_BINDING');
      const turn = session.active_turn_id ? this.turn(session.active_turn_id) : null;
      const uncertain = !!turn && turn.status !== 'accepted';
      if (turn) this.connection.prepare('UPDATE terminal_turn SET status=? WHERE id=?').run(uncertain ? 'uncertain' : 'cancelled', turn.id);
      const next = uncertain ? 'reconciliation_required' : reason === 'PROCESS_EXITED' || reason === 'HOST_DIED_CLI_DEAD' ? 'process_exited' : 'state_unknown';
      this.connection.prepare('UPDATE terminal_session SET state=?,error_code=?,active_turn_id=NULL WHERE id=?').run(next, reason, id);
      if (!['cancelled', 'succeeded', 'failed'].includes(this.task(session.task_id).status)) this.state(session.task_id, uncertain ? 'reconciliation_required' : 'paused_dependency', uncertain ? 'handoff_no_prompt_replay' : reason, uncertain ? 'unknown' : undefined);
      this.event(session.task_id, hostFailure ? 'terminal.host_lost' : 'terminal.process_stopped', {session_ref: id, generation, reason, pending_effect: uncertain ? 'unknown' : 'unobserved'});
      if (uncertain) this.event(session.task_id, 'orchestrator.replan_required', {reason, automatically_submitted: false, next_action: 'reconcile_before_new_prompt'});
    });
  }
  observedExit(id: string, instance: string, generation: number) {
    this.transaction(() => {
      const session = this.session(id), owner = this.terminalHost(session.project_id);
      requireCondition(owner?.instance_id === instance && session.host_instance_id === instance && session.generation === generation, 'STALE_TERMINAL_BINDING');
      if (['HOST_STOPPED', 'INTERRUPTED'].includes(session.error_code ?? '') && session.state === 'state_unknown' && !session.active_turn_id) this.connection.prepare("UPDATE terminal_session SET state='process_exited' WHERE id=?").run(id);
      this.event(session.task_id, 'terminal.process_exited', {session_ref: id, generation, source: 'owned_child_close', project_completed: false});
    });
  }
  requestInterrupt(id: string, generation: number, manual = false) {
    return this.transaction(() => {
      const session = this.session(id); requireCondition(session.generation === generation, 'STALE_SESSION_GENERATION');
      this.connection.prepare('UPDATE terminal_session SET interrupt_requested=1,manual_control=MAX(manual_control,?) WHERE id=?').run(manual ? 1 : 0, id);
      this.event(session.task_id, manual ? 'terminal.writer_relinquished' : 'terminal.interrupt_requested', {session_ref: id, effect_not_rolled_back: true});
      return this.session(id);
    });
  }
  requestResume(id: string, generation: number, config: HostConfig) {
    return this.transaction(() => {
      const session = this.session(id); requireCondition(session.generation === generation, 'STALE_SESSION_GENERATION');
      requireCondition(session.config_hash === config.fingerprint && session.project_id === config.project.id, 'CONFIG_CHANGED');
      requireCondition(!this.connection.prepare("SELECT id FROM storage_artifact WHERE session_id=? AND state!='retained'").get(id),'SESSION_RETENTION_EXPIRED');
      requireCondition(session.state === 'process_exited' && session.last_turn_id && !session.active_turn_id && !session.manual_control && !this.task(session.task_id).cancel_requested, 'RESUME_REQUIRES_FINISHED_TRANSCRIPT');
      requireCondition(!this.connection.prepare("SELECT id FROM terminal_turn WHERE session_id=? AND status IN ('dispatched','acknowledged','uncertain')").get(id), 'UNCERTAIN_TURN_NO_RESUME');
      requireCondition(this.sessions(config.project.id).filter(s => s.id !== id && (!['session_closed', 'process_exited'].includes(s.state) || s.resume_requested)).length < 4, 'TERMINAL_SESSION_LIMIT');
      this.connection.prepare('UPDATE terminal_session SET resume_requested=1,interrupt_requested=0 WHERE id=?').run(id);
      this.event(session.task_id, 'terminal.resume_requested', {session_ref: id, generation, cli_session_id: session.cli_session_id});
      return this.session(id);
    });
  }
  override cancel(taskId: string) {
    const row = this.connection.prepare('SELECT id,generation FROM terminal_session WHERE task_id=?').get(taskId);
    if (!row) return super.cancel(taskId);
    this.transaction(() => {
      this.connection.prepare('UPDATE task SET cancel_requested=1 WHERE id=?').run(taskId);
      this.connection.prepare('UPDATE terminal_session SET interrupt_requested=1 WHERE id=?').run(String(row.id));
      this.event(taskId, 'task.cancel_requested', {effect_not_rolled_back: true});
    });
    return this.task(taskId);
  }
  terminalStatus(id: string) {
    const session = this.session(id), turnId = session.active_turn_id ?? session.last_turn_id;
    const turn = turnId ? this.turn(turnId) : null;
    return {...this.outcome(session.task_id), session_ref: id, session_generation: session.generation, cli_session_id: session.cli_session_id, host_instance_id: session.host_instance_id, process_identity: session.process_identity_json ? JSON.parse(session.process_identity_json) as unknown : null,
      terminal_state: session.state, previous_turn_id: session.last_turn_id, active_turn_id: session.active_turn_id, turn_status: turn?.status ?? null, result: turn?.result_json ? JSON.parse(turn.result_json) as unknown : null,
      mode: 'structured', project_completed: false, verified_for_environment: false, error_code: session.error_code, spool_bytes: session.spool_bytes};
  }
  // A cursor is a read position, never an authority. Every page rechecks project/session/generation.
  readSession(project: string, id: string, generation: number) {
    const session = this.session(id);
    requireCondition(session.project_id === project, 'SESSION_SCOPE_MISMATCH');
    requireCondition(session.generation === generation, 'STALE_SESSION_GENERATION');
    return session;
  }
  revision(id: string) {
    return Number(this.connection.prepare('SELECT COALESCE(MAX(id),0) AS revision FROM event WHERE task_id=?').get(this.session(id).task_id)!.revision);
  }
  sessionPage(project: string, request: TerminalList) {
    return this.transaction(() => {
      this.project(project);
      const revision = Number(this.connection.prepare('SELECT COALESCE(MAX(id),0) AS revision FROM event WHERE project_id=?').get(project)!.revision);
      requireCondition(!request.cursor || request.cursor.revision === revision, 'HISTORY_CHANGED_RESTART_PAGE');
      let sequence = 0;
      if (request.cursor) {
        const after = this.session(request.cursor.after_session_id); requireCondition(after.project_id === project, 'CURSOR_SCOPE_MISMATCH');
        const event = this.connection.prepare("SELECT id FROM event WHERE task_id=? AND kind='terminal.accepted'").get(after.task_id);
        requireCondition(event, 'CURSOR_SCOPE_MISMATCH'); sequence = Number(event.id);
      }
      const rows = this.connection.prepare("SELECT s.* FROM terminal_session s JOIN event e ON e.task_id=s.task_id AND e.kind='terminal.accepted' WHERE s.project_id=? AND e.id>? ORDER BY e.id LIMIT ?").all(project, sequence, request.limit + 1) as unknown as TerminalSession[];
      const sessions = rows.slice(0, request.limit).map(session => ({session_ref: session.id, task_id: session.task_id, cli_session_id: session.cli_session_id,
        generation: session.generation, terminal_state: session.state, host_instance_id: session.host_instance_id, process_identity: session.process_identity_json ? JSON.parse(session.process_identity_json) as unknown : null,
        active_turn_id: session.active_turn_id, previous_turn_id: session.last_turn_id, error_code: session.error_code, created_at: session.created_at, process_liveness: 'not_checked'}));
      return {project_id: project, revision, sessions, next_cursor: rows.length > sessions.length ? {revision, after_session_id: sessions.at(-1)!.session_ref} : null};
    });
  }
  history(project: string, request: TerminalHistory) {
    return this.transaction(() => {
      const session = this.readSession(project, request.session_ref, request.expected_generation), revision = this.revision(session.id);
      requireCondition(!request.cursor || request.cursor.revision === revision, 'HISTORY_CHANGED_RESTART_PAGE');
      const rows = this.turnRows(session, request.cursor?.after_turn_id, request.limit + 1);
      const turns: Array<Record<string, unknown>> = []; let bytes = 0;
      for (const row of rows.slice(0, request.limit)) {
        const transitions = this.connection.prepare("SELECT id,kind,created_at FROM event WHERE task_id=? AND kind IN ('terminal.prompt_accepted','terminal.prompt_started','terminal.prompt_received','terminal.turn_completed') AND json_extract(data_json,'$.turn_id')=? ORDER BY id").all(session.task_id, row.id);
        const result = row.result_json ? JSON.parse(row.result_json) as TurnResult : null;
        const item = {turn_id: row.id, request_id: row.request_id, generation: row.generation, status: row.status, prompt: redact(row.prompt), result: result ? {...result, text: result.text === null ? null : redact(result.text)} : null, created_at: row.created_at, transitions};
        const size = Buffer.byteLength(JSON.stringify(item)); if (turns.length && bytes + size > 524288) break;
        requireCondition(size <= 524288, 'HISTORY_RECORD_TOO_LARGE'); turns.push(item); bytes += size;
      }
      return {session_ref: session.id, session_generation: session.generation, revision, terminal_state: session.state, turns,
        next_cursor: rows.length > turns.length ? {revision, after_turn_id: String(turns.at(-1)!.turn_id)} : null,
        content_trust: 'untrusted_data', project_completed: false, history_kind: 'durable_requests_and_official_results', assistant_stream_complete: false};
    });
  }
  outputPage(project: string, request: TerminalOutput) {
    return this.transaction(() => {
      const session = this.readSession(project, request.session_ref, request.expected_generation), revision = this.revision(session.id);
      requireCondition(!request.cursor || request.cursor.revision === revision, 'HISTORY_CHANGED_RESTART_PAGE');
      const after = request.cursor?.after_event_id ?? 0;
      if (after) requireCondition(this.connection.prepare("SELECT id FROM event WHERE id=? AND task_id=? AND kind='terminal.output'").get(after, session.task_id), 'CURSOR_SCOPE_MISMATCH');
      const rows = this.connection.prepare("SELECT id,data_json FROM event WHERE task_id=? AND kind='terminal.output' AND id>? ORDER BY id LIMIT ?").all(session.task_id, after, request.limit + 1);
      return {session, revision, rows: rows.map(row => ({id: Number(row.id), data: JSON.parse(String(row.data_json)) as {bytes: number; spool_offset: number; event_type: string; sha256?: string}}))};
    });
  }
  handoffContext(project: string, id: string, generation: number) {
    return this.transaction(() => {
      const session = this.readSession(project, id, generation);
      const turns = this.turnRows(session, undefined, 101);
      requireCondition(turns.length <= 100, 'HANDOFF_HISTORY_LIMIT');
      return {session, revision: this.revision(id), turns, task: this.task(session.task_id)};
    });
  }
  persistHandoff<T>(project: string, id: string, generation: number, revision: number, save: () => T): T {
    // Serialize artifact quota/idempotency across gateways sharing this database.
    return this.transaction(() => {
      this.readSession(project, id, generation);
      requireCondition(this.revision(id) === revision, 'HISTORY_CHANGED_RESTART_PAGE');
      return save();
    });
  }
  private turnRows(session: TerminalSession, after: string | undefined, limit: number) {
    let sequence = 0;
    if (after) {
      requireCondition(this.turn(after).session_id === session.id, 'CURSOR_SCOPE_MISMATCH');
      const row = this.connection.prepare("SELECT id FROM event WHERE task_id=? AND kind='terminal.prompt_accepted' AND json_extract(data_json,'$.turn_id')=?").get(session.task_id, after);
      requireCondition(row, 'CURSOR_SCOPE_MISMATCH'); sequence = Number(row.id);
    }
    // Event sequence, not timestamps or random UUID order, is the durable acceptance order.
    return this.connection.prepare("SELECT t.* FROM terminal_turn t JOIN event e ON e.task_id=? AND e.kind='terminal.prompt_accepted' AND json_extract(e.data_json,'$.turn_id')=t.id WHERE t.session_id=? AND e.id>? ORDER BY e.id LIMIT ?").all(session.task_id, session.id, sequence, limit) as unknown as TerminalTurn[];
  }
  bindBroker(config: HostConfig, authority: FileAuthority) {
    return this.transaction(() => {
      const s = this.bound(authority.session, authority.host, authority.generation);
      requireCondition(s.config_hash === config.fingerprint && s.process_identity_json === authority.cli, 'BROKER_CLI_BINDING_MISMATCH');
      const old = this.connection.prepare('SELECT identity_json FROM terminal_broker WHERE session_id=? AND generation=?').get(s.id, s.generation);
      requireCondition(!old || old.identity_json === authority.broker, 'BROKER_ALREADY_BOUND');
      this.connection.prepare('INSERT OR IGNORE INTO terminal_broker VALUES (?,?,?,?,?)').run(s.id, s.generation, authority.broker, authority.cli, authority.host);
      if (!old) this.event(s.task_id, 'terminal.broker_bound', {session_ref: s.id, generation: s.generation, identity: JSON.parse(authority.broker) as unknown});
    });
  }
  broker(id: string, generation: number) {return this.connection.prepare('SELECT * FROM terminal_broker WHERE session_id=? AND generation=?').get(id, generation);}
  fileFence(config: HostConfig, authority: FileAuthority, turn: string) {
    requireCondition(loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
    const s = this.bound(authority.session, authority.host, authority.generation), host = this.terminalHost(s.project_id)!, broker = this.broker(s.id, s.generation);
    const alive = (encoded: string) => {const old = JSON.parse(encoded) as ProcessIdentity; return JSON.stringify(processIdentitySync(old.pid)) === encoded;};
    requireCondition(config.terminal?.files && s.project_id === config.project.id && s.config_hash === config.fingerprint && s.worktree === config.project.worktree, 'FILE_SCOPE_MISMATCH');
    requireCondition(broker?.identity_json === authority.broker && broker.cli_identity_json === authority.cli && broker.host_instance_id === authority.host && s.process_identity_json === authority.cli, 'STALE_BROKER');
    requireCondition(alive(host.identity_json) && alive(authority.cli) && alive(authority.broker), 'FILE_OWNER_NOT_ALIVE');
    requireCondition(s.state === 'streaming' && s.active_turn_id === turn && !s.interrupt_requested && !s.manual_control && !this.task(s.task_id).cancel_requested, 'FILE_TURN_NOT_ACTIVE');
    requireCondition(!this.pendingVerification(s.worktree), 'VERIFIER_IN_PROGRESS');
    const current = this.turn(turn);
    requireCondition(current.generation === authority.generation && current.status === 'acknowledged' && current.deadline_uptime_ms !== null && current.deadline_uptime_ms > bootClock().uptimeMs, 'FILE_TURN_NOT_ACKNOWLEDGED');
    return s;
  }
  toolRequested(id: string, instance: string, generation: number, toolId: string, name: string, input: unknown) {
    this.transaction(() => {
      const s = this.bound(id, instance, generation);
      requireCondition(s.active_turn_id && this.turn(s.active_turn_id).status === 'acknowledged' && brokerTools.includes(name as typeof brokerTools[number]), 'CLI_TOOL_NOT_DELEGATED');
      requireCondition(Number(this.connection.prepare('SELECT COUNT(*) AS n FROM terminal_tool_call WHERE turn_id=?').get(s.active_turn_id)!.n) < 64, 'CLI_TOOL_BUDGET');
      requireCondition(!this.connection.prepare('SELECT id FROM terminal_tool_call WHERE id=?').get(toolId), 'CLI_DUPLICATE_TOOL_ID');
      this.connection.prepare('INSERT INTO terminal_tool_call(id,session_id,turn_id,generation,name,input_hash) VALUES (?,?,?,?,?,?)').run(toolId, id, s.active_turn_id, generation, name, sha256(JSON.stringify(input)));
      this.event(s.task_id, 'terminal.tool_requested', {tool_id: toolId, turn_id: s.active_turn_id, name, input_hash: sha256(JSON.stringify(input))});
    });
  }
  pendingTool(authority: FileAuthority, turn: string, name: string, input: unknown) {
    return this.connection.prepare('SELECT id FROM terminal_tool_call WHERE session_id=? AND generation=? AND turn_id=? AND name=? AND input_hash=? AND result_json IS NULL ORDER BY rowid LIMIT 1').get(authority.session, authority.generation, turn, name, sha256(JSON.stringify(input)))?.id as string | undefined;
  }
  answerTool(id: string, session: string, result: unknown) {
    requireCondition(this.connection.prepare('UPDATE terminal_tool_call SET result_json=? WHERE id=? AND session_id=? AND result_json IS NULL').run(JSON.stringify(result), id, session).changes === 1, 'TOOL_ALREADY_ANSWERED');
  }
  observeToolResult(id: string, instance: string, generation: number, toolId: string, content: unknown, isError: boolean) {
    this.transaction(() => {
      const s = this.bound(id, instance, generation), row = this.connection.prepare('SELECT * FROM terminal_tool_call WHERE id=?').get(toolId);
      requireCondition(row && row.session_id === s.id && row.turn_id === s.active_turn_id && row.generation === generation && !row.observed && row.result_json, 'UNBOUND_TOOL_RESULT');
      const expected = JSON.parse(String(row.result_json)) as {content: unknown; isError?: boolean};
      requireCondition(JSON.stringify(expected.content) === JSON.stringify(content) && !!expected.isError === isError, 'TOOL_RESULT_MISMATCH');
      this.connection.prepare('UPDATE terminal_tool_call SET observed=1 WHERE id=?').run(toolId);
      this.event(s.task_id, 'terminal.tool_result_observed', {tool_id: toolId, turn_id: s.active_turn_id, is_error: isError});
    });
  }
  assertToolsSettled(id: string) {
    const s = this.session(id);
    requireCondition(!this.connection.prepare('SELECT id FROM terminal_tool_call WHERE turn_id=? AND observed=0').get(s.active_turn_id), 'CLI_TOOL_RESULT_UNOBSERVED');
    requireCondition(!this.connection.prepare("SELECT id FROM terminal_file_intent WHERE session_id=? AND status IN ('intent','uncertain')").get(id), 'FILE_EFFECT_UNCERTAIN');
  }
  fileIntents(id: string) {return this.connection.prepare('SELECT * FROM terminal_file_intent WHERE session_id=? ORDER BY rowid').all(id) as unknown as FileIntent[];}
  beginFile(config: HostConfig, authority: FileAuthority, request: FileWrite, before: FileObservation) {
    return this.transaction(() => {
      const s = this.fileFence(config, authority, request.turn_id), hash = sha256(JSON.stringify(request));
      const old = this.connection.prepare('SELECT * FROM terminal_file_intent WHERE session_id=? AND request_id=?').get(s.id, request.request_id) as unknown as FileIntent | undefined;
      if (old) {requireCondition(old.request_hash === hash, 'REQUEST_ID_CONFLICT'); return {intent: old, created: false};}
      requireCondition(!this.connection.prepare("SELECT f.id FROM terminal_file_intent f JOIN terminal_session s ON s.id=f.session_id WHERE s.worktree=? AND f.status IN ('intent','uncertain')").get(s.worktree), 'FILE_EFFECT_UNCERTAIN');
      requireCondition(Number(this.connection.prepare('SELECT COUNT(*) AS n FROM terminal_file_intent WHERE turn_id=?').get(request.turn_id)!.n) < config.terminal!.files!.max_writes_per_turn, 'FILE_WRITE_BUDGET');
      requireCondition(request.expected_sha256 === before.sha256, 'FILE_PRECONDITION_CHANGED');
      const id = randomUUID();
      this.connection.prepare('INSERT INTO terminal_file_intent(id,session_id,turn_id,generation,path,request_id,request_hash,before_hash,after_hash,before_content,content,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, s.id, request.turn_id, s.generation, request.path, request.request_id, hash, before.sha256, sha256(request.content), before.content, request.content, new Date().toISOString());
      this.event(s.task_id, 'terminal.file_intent', {intent_id: id, turn_id: request.turn_id, path: request.path, before_sha256: before.sha256, after_sha256: sha256(request.content)});
      return {intent: this.fileIntents(s.id).find(i => i.id === id)!, created: true};
    });
  }
  finishFile(intent: FileIntent, status: FileIntent['status'], result: unknown) {
    this.connection.prepare('UPDATE terminal_file_intent SET status=?,result_json=? WHERE id=?').run(status, JSON.stringify(result), intent.id);
    this.event(this.session(intent.session_id).task_id, 'terminal.file_observed', {intent_id: intent.id, status, observation: result});
  }
  pendingVerification(worktree: string) {return this.connection.prepare('SELECT v.id FROM terminal_verification v JOIN terminal_session s ON s.id=v.session_id WHERE s.worktree=? AND v.result_json IS NULL').get(worktree);}
  verifications(id: string) {return this.connection.prepare('SELECT * FROM terminal_verification WHERE session_id=? ORDER BY rowid').all(id);}
  beginVerification(config: HostConfig, id: string, generation: number, turn: string, request: string, manifest: unknown) {
    return this.transaction(() => {
      const s = this.readSession(config.project.id, id, generation);
      requireCondition(s.config_hash === config.fingerprint && loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
      const old = this.connection.prepare('SELECT * FROM terminal_verification WHERE session_id=? AND request_id=?').get(id, request);
      if (old) {requireCondition(old.turn_id === turn && old.generation === generation && old.config_hash === config.fingerprint, 'REQUEST_ID_CONFLICT'); return {record: old, created: false};}
      requireCondition(s.last_turn_id === turn && !s.active_turn_id && ['input_ready','process_exited','turn_completed'].includes(s.state), 'VERIFICATION_REQUIRES_FINISHED_TURN');
      requireCondition(!s.interrupt_requested && !s.manual_control && !this.task(s.task_id).cancel_requested, 'VERIFICATION_CANCELLED');
      requireCondition(!this.pendingVerification(s.worktree), 'VERIFIER_IN_PROGRESS');
      requireCondition(!this.sessions(config.project.id).some(row => row.active_turn_id), 'VERIFICATION_REQUIRES_IDLE_WORKTREE');
      requireCondition(!this.connection.prepare("SELECT f.id FROM terminal_file_intent f JOIN terminal_session s ON s.id=f.session_id WHERE s.worktree=? AND f.status IN ('intent','uncertain')").get(s.worktree), 'FILE_EFFECT_UNCERTAIN');
      requireCondition(this.verifications(id).length < 100, 'VERIFICATION_BUDGET');
      const identity = processIdentitySync(process.pid); requireCondition(typeof identity !== 'string', 'VERIFIER_IDENTITY_UNAVAILABLE');
      const verification = randomUUID();
      this.connection.prepare('INSERT INTO terminal_verification(id,session_id,turn_id,generation,request_id,config_hash,manifest_json,owner_identity_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(verification, id, turn, generation, request, config.fingerprint, JSON.stringify(manifest), JSON.stringify(identity), new Date().toISOString());
      this.event(s.task_id, 'terminal.verification_started', {verification_id: verification, turn_id: turn, manifest});
      return {record: this.verifications(id).at(-1)!, created: true};
    });
  }
  finishVerification(id: string, session: string, result: unknown) {
    this.transaction(() => {
      requireCondition(this.connection.prepare('UPDATE terminal_verification SET result_json=? WHERE id=? AND session_id=? AND result_json IS NULL').run(JSON.stringify(result), id, session).changes === 1, 'VERIFICATION_ALREADY_FINISHED');
      this.event(this.session(session).task_id, 'terminal.verification_observed', {verification_id: id, result});
    });
  }
  reconcileFiles(config: HostConfig, id: string, generation: number, observe: (path: string) => FileObservation) {
    return this.transaction(() => {
      const s = this.readSession(config.project.id, id, generation);
      requireCondition(s.config_hash === config.fingerprint && loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
      const dead = (encoded: string | null) => {if (!encoded) return false; const old = JSON.parse(encoded) as ProcessIdentity, now = processIdentitySync(old.pid); return now === 'dead' || typeof now !== 'string' && JSON.stringify(now) !== encoded;};
      requireCondition(dead(s.process_identity_json), 'RECONCILIATION_REQUIRES_DEAD_CLI');
      const broker = this.broker(id, generation); requireCondition(broker && dead(String(broker.identity_json)), 'RECONCILIATION_REQUIRES_DEAD_BROKER');
      const interruptedVerifiers = [];
      for (const row of this.verifications(id).filter(v => !v.result_json)) {
        requireCondition(dead(String(row.owner_identity_json)), 'RECONCILIATION_REQUIRES_DEAD_VERIFIER_OWNER');
        const result = {status: 'NOT_RUN', reason: 'VERIFIER_OWNER_DIED', checks: 'unobserved', automatic_retry: false, project_completed: false};
        this.connection.prepare('UPDATE terminal_verification SET result_json=? WHERE id=? AND result_json IS NULL').run(JSON.stringify(result), String(row.id));
        this.event(s.task_id, 'terminal.verification_interrupted', {verification_id: row.id, ...result}); interruptedVerifiers.push(row.id);
      }
      const observations = [];
      for (const intent of this.fileIntents(id).filter(i => ['intent','uncertain'].includes(i.status))) {
        let hash: string | null | 'unobserved' = 'unobserved';
        try {hash = observe(intent.path).sha256;} catch { /* Unknown remains unknown. */ }
        const state = hash === intent.after_hash ? 'verified' : hash === intent.before_hash ? 'not_applied' : 'uncertain';
        const result = {intent_id: intent.id, path: intent.path, observed_sha256: hash, match: state === 'verified' ? 'desired_content_now' : state === 'not_applied' ? 'previous_content_now' : 'unknown', execution_happened: 'unobserved', automatically_replayed: false};
        this.finishFile(intent, state, result); observations.push(result);
      }
      return {observations, interrupted_verifiers: interruptedVerifiers, automatic_resume: false, prompt_effects: 'not_reconciled_by_file_hashes'};
    });
  }
}
