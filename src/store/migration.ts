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
