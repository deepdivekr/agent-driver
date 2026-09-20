import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {transportFromChild} from '../../dist/terminal/claude.js';
export async function fixtureLaunch(config, session, resume, callbacks) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./terminal-fixture.mjs', import.meta.url)), session.cli_session_id, config.project.worktree, resume ? 'resume' : 'new'], {cwd: config.project.worktree, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  return transportFromChild(child, session, callbacks);
}
