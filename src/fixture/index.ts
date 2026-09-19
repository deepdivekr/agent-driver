import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FixtureServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

type FixtureRecord = {
  taskId: string;
  family: string;
  effectCount: number;
  completed: boolean;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function pageFor(taskId: string, family: string): string {
  const common = `<p id="task-id">${taskId}</p><output id="state" data-testid="state" data-complete="false">pending</output><script>
    async function complete() {
      await fetch('/api/action/${encodeURIComponent(taskId)}', { method: 'POST', body: 'fixture-action' });
      document.querySelector('#state').dataset.complete = 'true';
      document.querySelector('#state').textContent = 'complete';
    }
  </script>`;
  if (family === "static_dom") return `<!doctype html><title>Static form</title>${common}<input id="value" value=""><button id="save">Save</button><script>save.onclick=complete;</script>`;
  if (family === "dynamic_spa") return `<!doctype html><title>Dynamic modal</title>${common}<button id="open-modal">Open</button><dialog id="modal"><input id="modal-value"><button id="apply">Apply</button></dialog><script>openModal=document.querySelector('#open-modal');openModal.onclick=()=>modal.showModal();apply.onclick=complete;</script>`;
  if (family === "multi_tab") return `<!doctype html><title>Shared target</title>${common}<button id="target-action" data-target="${taskId}">Target action</button><script>document.querySelector('#target-action').onclick=complete;</script>`;
  if (family === "authenticated") return `<!doctype html><title>Authenticated table</title>${common}<p id="account">synthetic-account</p><select id="period"><option>2026-01</option><option>2026-02</option></select><button id="load">Load</button><script>document.querySelector('#load').onclick=complete;</script>`;
  if (family === "file_upload") return `<!doctype html><title>File upload</title>${common}<input id="file" type="file"><output id="preview"></output><script>document.querySelector('#file').onchange=()=>{preview.textContent='ready';complete();};</script>`;
  if (family === "canvas") return `<!doctype html><title>Canvas</title>${common}<canvas id="canvas" width="120" height="80"></canvas><button id="paint">Paint</button><script>document.querySelector('#paint').onclick=()=>{canvas.getContext('2d').fillRect(0,0,10,10);complete();};</script>`;
  if (family === "cross_app") return `<!doctype html><title>Export</title>${common}<button id="export">Export</button><p id="exported"></p><script>document.querySelector('#export').onclick=()=>{exported.textContent='exported';complete();};</script>`;
  return `<!doctype html><title>Download</title>${common}<a id="download" href="/download/${encodeURIComponent(taskId)}" download="${taskId}.txt">Download</a><script>document.querySelector('#download').onclick=complete;</script>`;
}

function familyFromTaskId(taskId: string): string {
  const prefix = taskId.split("-")[0];
  return prefix === "static" ? "static_dom" : prefix === "dynamic" ? "dynamic_spa" : prefix === "multi" ? "multi_tab" : prefix === "authenticated" ? "authenticated" : prefix === "file" ? "file_upload" : prefix === "canvas" ? "canvas" : prefix === "cross" ? "cross_app" : "downloads";
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const records = new Map<string, FixtureRecord>();
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && parts[0] === "task" && parts[1]) {
      const taskId = decodeURIComponent(parts[1]);
      const family = familyFromTaskId(taskId);
      records.set(taskId, records.get(taskId) ?? { taskId, family, effectCount: 0, completed: false });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageFor(taskId, family));
      return;
    }
    if (request.method === "GET" && parts[0] === "download" && parts[1]) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${decodeURIComponent(parts[1])}.txt"` });
      response.end(`fixture-download:${decodeURIComponent(parts[1])}`);
      return;
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "records" && parts[2]) {
      const record = records.get(decodeURIComponent(parts[2]));
      if (!record) {
        sendJson(response, 404, { error: "record_not_found" });
        return;
      }
      sendJson(response, 200, record);
      return;
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "action" && parts[2]) {
      const taskId = decodeURIComponent(parts[2]);
      const record = records.get(taskId);
      if (!record) {
        sendJson(response, 404, { error: "record_not_found" });
        return;
      }
      await readBody(request);
      record.effectCount += 1;
      record.completed = true;
      sendJson(response, 200, { ok: true, request_id: randomUUID() });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind to a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
