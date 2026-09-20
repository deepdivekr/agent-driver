import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppState, CaseSpec } from "./contracts.js";

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 1_000_000) throw new Error("body too large"); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
function send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
function truncateResponse(res: ServerResponse) {
  // Send headers first so transport retries do not turn one intentional write into two.
  res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  res.flushHeaders(); res.write('{"interrupted":');
  setTimeout(() => res.destroy(), 25);
}

function page(spec: CaseSpec, account: string): string {
  const dynamic = spec.scenario === "S02";
  const form = `<label>Name<input id="name" name="name" aria-label="Name"></label><label>Note<textarea id="note" name="note" aria-label="Note"></textarea></label><button id="save">Save</button>`;
  return `<!doctype html><html><meta charset="utf-8"><title>Workspace</title>
  <style>body{font:18px sans-serif;max-width:800px;margin:30px}label{display:block;margin:16px}input,textarea{display:block;font:inherit;width:400px}button,a{margin:12px;padding:10px}#spacer{height:1200px}</style>
  <body><h1>Workspace</h1><p id="account">${account}</p>
  <button id="edit" ${dynamic ? "" : "hidden"}>Edit</button><section id="editor">${dynamic ? "" : form}</section>
  <label>File<input id="file" aria-label="File" type="file"></label><a id="download" href="api/download">Download</a>
  <input id="trap" aria-label="Decoy" value="leave-alone"><output id="state" data-ready="false">Ready</output><div id="spacer"></div>
  <script>
  const scenario=${JSON.stringify(spec.scenario)}, variant=${spec.seed % 2}, account=${JSON.stringify(account)};
  const editor=document.querySelector('#editor'), status=document.querySelector('#state');
  const form=${JSON.stringify(form)};
  async function event(kind,value){await fetch('api/event',{method:'POST',body:JSON.stringify({kind,value})})}
  async function save(){
    const data={name:document.querySelector('#name').value,note:document.querySelector('#note').value};
    status.dataset.ready='false';
    try {const r=await fetch('api/save',{method:'POST',body:JSON.stringify(data)});if(!r.ok)throw Error('save rejected');const record=await r.json();status.textContent=JSON.stringify(record);status.dataset.ready='true'}catch(e){status.textContent=String(e);status.dataset.ready='error'}
  }
  function wire(){document.querySelector('#save').onclick=save}
  if(!${dynamic})wire();
  document.querySelector('#edit').onclick=()=>{editor.innerHTML=form;if(variant)editor.prepend(editor.lastElementChild);wire()};
  if(!${dynamic}&&variant)editor.prepend(editor.lastElementChild);
  document.querySelector('#file').onchange=async(e)=>{status.dataset.ready='false';const f=e.target.files[0];if(!f)return;
    const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
    const r=await fetch('api/upload',{method:'POST',body:JSON.stringify({name:f.name,base64:btoa(raw)})});status.textContent=await r.text();status.dataset.ready=r.ok?'true':'error'};
  document.querySelector('#download').addEventListener('click',()=>{status.textContent='Download requested';status.dataset.ready='true'});
  document.addEventListener('input',e=>{void event('input',e.target.id)});
  document.addEventListener('visibilitychange',()=>{void event('visibility',document.visibilityState)});
  // Test-controller-only DOM perturbation; never supplies task answers or changes server records.
  window.perturb=()=>{if(scenario==='S02'){editor.innerHTML=editor.innerHTML;wire();return 'dom_replaced'}if(scenario==='S01'){editor.prepend(editor.lastElementChild);return 'form_reordered'}if(scenario==='S06'){const old=document.querySelector('#file'),next=old.cloneNode();next.onchange=old.onchange;old.replaceWith(next);return 'file_input_replaced'}if(scenario==='S04'){document.querySelector('#trap').focus();return 'element_blurred'}return 'no_dom_change'};
  </script></body></html>`;
}

export async function startFixture() {
  const cases = new Map<string, { spec: CaseSpec; state: AppState; faultInjected?: boolean }>();
  const server = createServer((req, res) => { void (async () => {
    const parts = new URL(req.url ?? "/", "http://fixture").pathname.split("/").filter(Boolean);
    const entry = cases.get(parts[0] ?? ""); const account = parts[1];
    if (!entry || !account || !["account-a", "account-b"].includes(account)) return send(res, 404, { error: "not_found" });
    const { spec, state } = entry;
    if (parts.length === 2) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(spec, account)); return; }
    if (parts[2] !== "api") return send(res, 404, {});
    if (parts[3] === "identity" && req.method === "GET") return send(res, 200, {account,run_id:spec.runId});
    if (parts[3] === "record" && req.method === "GET") return send(res, 200, state.records[account]);
    if (parts[3] === "download" && req.method === "GET") {
      state.effects.push({ account, kind: "download" });
      const lines = ["account,period,item,amount", ...[1,2,3].map(n => [account, "2026-09", `item-${n}`, spec.seed * 10 + n].join(","))];
      const csv=lines.join("\n")+"\n";
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
      // A real incomplete business artifact, not just a click counter.
      res.end(spec.condition === "perturbed" && spec.scenario === "S07" ? lines.slice(0,2).join("\n")+"\n" : csv); return;
    }
    if (!["event", "save", "upload"].includes(parts[3] ?? "")) return send(res,404,{});
    if (req.method !== "POST") return send(res, 405, {});
    const data = await body(req);
    if (parts[3] === "event") { state.events.push({ account, kind: String(data.kind), value: String(data.value) }); return send(res, 200, {}); }
    if (parts[3] === "save") {
      if (typeof data.name !== "string" || typeof data.note !== "string") return send(res, 400, {});
      const fault = !entry.faultInjected ? spec.responseFault : undefined;
      if(fault){entry.faultInjected=true;if(fault==='drop_before_save'){truncateResponse(res);return;}}
      state.records[account] = { name: data.name, note: data.note }; state.effects.push({ account, kind: "save" });
      if(fault==='drop_after_save'){truncateResponse(res);return;}
      return send(res, 200, state.records[account]);
    }
    if (parts[3] === "upload") {
      if(typeof data.name!=="string" || typeof data.base64!=="string")return send(res,400,{});
      state.uploads[account]={name:data.name,base64:data.base64};state.effects.push({account,kind:"upload"});return send(res,200,{stored:true});
    }
    send(res,404,{});
  })().catch(error => { if(!res.headersSent)send(res,500,{error:String(error)});else res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    create(spec: CaseSpec) { if(cases.has(spec.runId))throw new Error("duplicate run ID"); cases.set(spec.runId,{spec,state:{records:{"account-a":{name:"",note:""},"account-b":{name:"untouched",note:"sentinel"}},uploads:{},effects:[],events:[]}});return `${baseUrl}/${spec.runId}/${spec.account}/`; },
    snapshot(runId: string): AppState | undefined { const state=cases.get(runId)?.state;return state ? structuredClone(state):undefined; },
    async close() { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  };
}
