import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject,scopeTerms} from '../dist/work/project-scan.js';

// Live: importing a news bot from a large repository read unrelated files until the budget was used and reported
// that the bot could not be found. The owner's scope now decides which files are read first.
test('the owner\'s import scope puts its files first, including code that only shares their name stem',async t=>{
  const root=await mkdtemp(join(tmpdir(),'scan-scope-')),project=join(root,'big-app');t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(project,'lib'),{recursive:true});await mkdir(join(project,'docs'));await mkdir(join(project,'app'));
  await writeFile(join(project,'README.md'),'# Big app\nA shop with many features.\n');
  for(let i=0;i<150;i++)await writeFile(join(project,'app',`screen-${String(i).padStart(3,'0')}.ts`),`export const screen${i}='x';\n// setInterval placeholder ${'y'.repeat(6000)}\n`);
  await writeFile(join(project,'docs','reading-operations.md'),'# AI 읽을거리 수집 운영\n15분 주기로 저자 피드를 수집한다.\n');
  await writeFile(join(project,'lib','reading-automation.ts'),'export async function collect(){/* fetch feeds on a cron schedule */ return fetch("https://example.org/feed.xml");}\n');
  await writeFile(join(project,'lib','reading-source-registry.mjs'),'export const sources=[{id:"karpathy-blog",format:"atom"}];\n');
  assert.deepEqual(scopeTerms('"읽을거리" 뉴스 수집 봇만 가져온다. RSS 피드에서 새 글을 확인해 텔레그램으로 전달하는 업무로 옮긴다.').slice(0,3),['읽을거리','뉴스','수집']);
  const plain=await scanProject(project),scoped=await scanProject(project,'"읽을거리" 뉴스 수집 봇만 가져온다.');
  const files=scan=>new Set(scan.evidence.map(item=>item.file));
  assert.equal(files(plain).has('lib/reading-source-registry.mjs'),false,'Without a scope the budget goes to whatever sorts first.');
  for(const file of ['docs/reading-operations.md','lib/reading-automation.ts','lib/reading-source-registry.mjs'])assert.ok(files(scoped).has(file),file);
  const registry=scoped.evidence.find(item=>item.file==='lib/reading-source-registry.mjs');
  assert.equal(registry.signal,'scope');assert.match(registry.context.text,/karpathy-blog/u,'In-scope code is shown even when no generic signal matches it.');
  assert.match(scoped.evidence.find(item=>item.file==='docs/reading-operations.md').description,/15분 주기/u);
  assert.notEqual(plain.content_sha256,scoped.content_sha256);assert.equal((await scanProject(project,'"읽을거리" 뉴스 수집 봇만 가져온다.')).content_sha256,scoped.content_sha256,'The same scope reads the same files.');
});
