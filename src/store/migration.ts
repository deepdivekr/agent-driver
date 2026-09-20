export const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, binding_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task(
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), capability TEXT NOT NULL,
 status TEXT NOT NULL, effect_state TEXT NOT NULL DEFAULT 'none', next_action TEXT NOT NULL,
 selected_route TEXT, target_ref TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS step(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), capability TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lease(
 resource TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), task_id TEXT NOT NULL REFERENCES task(id),
 generation INTEGER NOT NULL, token TEXT NOT NULL, active INTEGER NOT NULL,
 inflight_intent TEXT);
CREATE TABLE IF NOT EXISTS command_intent(
 id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES step(id), task_id TEXT NOT NULL REFERENCES task(id),
 resource TEXT NOT NULL REFERENCES lease(resource), generation INTEGER NOT NULL,
 effect TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL,
 response_json TEXT, verification_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event(
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES project(id),
 task_id TEXT NOT NULL REFERENCES task(id), kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE IF NOT EXISTS outbox(event_id INTEGER PRIMARY KEY REFERENCES event(id));
CREATE TABLE IF NOT EXISTS consumer_cursor(
 project_id TEXT NOT NULL REFERENCES project(id), consumer_id TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,consumer_id));
`;

export const MIGRATION_2 = `
CREATE TABLE submission(
 project_id TEXT NOT NULL REFERENCES project(id), request_id TEXT NOT NULL,
 task_id TEXT NOT NULL UNIQUE REFERENCES task(id), request_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL, config_hash TEXT NOT NULL, accepted_at TEXT NOT NULL,
 worker_nonce TEXT, worker_pid INTEGER, worker_started_at TEXT,
 PRIMARY KEY(project_id,request_id));
UPDATE schema_version SET version=2;
`;

export const MIGRATION_3 = `
CREATE TABLE supervisor(
 project_id TEXT PRIMARY KEY REFERENCES project(id),nonce TEXT NOT NULL,identity_json TEXT NOT NULL,
 config_hash TEXT NOT NULL,active INTEGER NOT NULL,stop_requested INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL);
ALTER TABLE submission ADD COLUMN worker_identity_json TEXT;
ALTER TABLE submission ADD COLUMN launch_nonce TEXT;
ALTER TABLE submission ADD COLUMN launch_owner TEXT;
ALTER TABLE submission ADD COLUMN dispatch_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submission ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submission ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE submission ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submission ADD COLUMN retry_after_ms REAL NOT NULL DEFAULT 0;
ALTER TABLE submission ADD COLUMN last_error TEXT;
ALTER TABLE submission ADD COLUMN accepted_boot_id TEXT;
ALTER TABLE submission ADD COLUMN accepted_uptime_ms REAL;
UPDATE submission SET recovery_state='legacy_unknown' WHERE worker_nonce IS NOT NULL;
UPDATE schema_version SET version=3;
`;

export const MIGRATION_4=`
CREATE TABLE terminal_host(project_id TEXT PRIMARY KEY REFERENCES project(id),instance_id TEXT NOT NULL,identity_json TEXT NOT NULL,config_hash TEXT NOT NULL,endpoint TEXT NOT NULL,token TEXT NOT NULL,active INTEGER NOT NULL,stop_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE terminal_session(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project(id),task_id TEXT NOT NULL UNIQUE REFERENCES task(id),request_id TEXT NOT NULL,
 cli_session_id TEXT NOT NULL UNIQUE,worktree TEXT NOT NULL,executable TEXT NOT NULL,version TEXT NOT NULL,config_hash TEXT NOT NULL,
 host_instance_id TEXT,process_identity_json TEXT,generation INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'starting',
 last_turn_id TEXT,active_turn_id TEXT,turn_count INTEGER NOT NULL DEFAULT 0,interrupt_requested INTEGER NOT NULL DEFAULT 0,
 resume_requested INTEGER NOT NULL DEFAULT 0,manual_control INTEGER NOT NULL DEFAULT 0,error_code TEXT,spool_bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
 UNIQUE(project_id,request_id));
CREATE TABLE terminal_turn(
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES terminal_session(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 generation INTEGER NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'accepted',deadline_uptime_ms REAL,result_json TEXT,created_at TEXT NOT NULL,
 UNIQUE(session_id,request_id));
UPDATE schema_version SET version=4;
`;

export const MIGRATION_5=`
CREATE TABLE terminal_broker(session_id TEXT NOT NULL REFERENCES terminal_session(id),generation INTEGER NOT NULL,identity_json TEXT NOT NULL,cli_identity_json TEXT NOT NULL,host_instance_id TEXT NOT NULL,PRIMARY KEY(session_id,generation));
CREATE TABLE terminal_tool_call(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES terminal_session(id),turn_id TEXT NOT NULL REFERENCES terminal_turn(id),generation INTEGER NOT NULL,name TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT,observed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE terminal_file_intent(
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES terminal_session(id),turn_id TEXT NOT NULL REFERENCES terminal_turn(id),generation INTEGER NOT NULL,
 path TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,before_hash TEXT,after_hash TEXT NOT NULL,before_content TEXT,content TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'intent',result_json TEXT,created_at TEXT NOT NULL,UNIQUE(session_id,request_id));
CREATE TABLE terminal_verification(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES terminal_session(id),turn_id TEXT NOT NULL REFERENCES terminal_turn(id),generation INTEGER NOT NULL,request_id TEXT NOT NULL,config_hash TEXT NOT NULL,manifest_json TEXT NOT NULL,owner_identity_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,UNIQUE(session_id,request_id));
UPDATE schema_version SET version=5;
`;

export const MIGRATION_6 = `
CREATE TABLE storage_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy_hash TEXT NOT NULL,root_identity TEXT NOT NULL);
CREATE TABLE storage_reservation(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project(id),kind TEXT NOT NULL,bytes INTEGER NOT NULL,owner_identity_json TEXT NOT NULL,created_at TEXT NOT NULL,active INTEGER NOT NULL);
CREATE TABLE terminal_spool_segment(session_id TEXT NOT NULL REFERENCES terminal_session(id),start_offset INTEGER NOT NULL,bytes INTEGER NOT NULL,filename TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',PRIMARY KEY(session_id,start_offset));
INSERT INTO terminal_spool_segment SELECT id,0,spool_bytes,id||'.jsonl','open' FROM terminal_session WHERE spool_bytes>0;
CREATE TABLE storage_artifact(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project(id),session_id TEXT NOT NULL REFERENCES terminal_session(id),generation INTEGER NOT NULL,kind TEXT NOT NULL,manifest_json TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'retained',pruned_at TEXT);
UPDATE schema_version SET version=6;
`;
