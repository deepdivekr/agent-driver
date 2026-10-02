import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {type Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {requireCondition} from '../core/contracts.js';
import {type BrowserTarget,type BrowserPort,type BrowserExtraction,browserHostCompatible,browserObservationSchema,observationScript,extractionScript} from './executor-contracts.js';

const timedOut=(error:unknown)=>error instanceof Error&&(/request timed out/iu.test(error.message)||(error as {code?:unknown}).code===-32001);
/** One live MCP connection per browser CLI/endpoint, shared by the tabs the
 * runtime opens. Starting `aside.exe mcp` costs ~28s per connection in live
 * runs; a connection lingers briefly after its last tab closes so consecutive
 * origins and Works reuse it. Tabs stay owned per executor. */
interface SharedConnection{key:string;client:Client;transport:StdioClientTransport|StreamableHTTPClientTransport;session:string|undefined;users:number;linger:NodeJS.Timeout|null;broken:boolean}
const connections=new Map<string,SharedConnection>();
const connectionKey=(target:BrowserTarget)=>`${target.engine}:${target.engine==='neo'?target.endpoint:target.executable}`;
async function closeConnection(shared:SharedConnection){if(connections.get(shared.key)===shared)connections.delete(shared.key);if(shared.linger)clearTimeout(shared.linger);await shared.client.close().catch(()=>{});await shared.transport.close().catch(()=>{});}
export async function closeSharedBrowserConnections(){await Promise.all([...connections.values()].map(closeConnection));}
const warming=new Map<string,Promise<void>>();
/** Starts the shared connection of a registered foreground browser before it is needed, so the first read that
 * falls back to it does not wait for the process to start (live: the first Aside operation timed out cold).
 * Nothing is opened in the browser; an unused connection closes after the linger time. */
export function warmBrowserConnection(target:BrowserTarget,lingerMs=120_000):void{
  if(target.environment!=='host_foreground'||!browserHostCompatible(target))return;
  const key=connectionKey(target);if(connections.has(key)&&!connections.get(key)!.broken||warming.has(key))return;
  warming.set(key,new McpBrowserExecutor(target).warm(lingerMs).catch(()=>{}).finally(()=>{warming.delete(key);}));
}
export class McpBrowserExecutor implements BrowserPort {
  private shared:SharedConnection|null=null;
  private page:number|string|null=null;private closed=false;
  private readonly variable=`ad_${randomUUID().replaceAll('-','')}`;
  constructor(readonly target:BrowserTarget,private readonly limits:{operation_ms:number;linger_ms:number}={operation_ms:25000,linger_ms:120_000}){}
  private get client(){return this.shared?.client??null;}
  private get session(){return this.shared?.session;}
  private set session(value:string|undefined){if(this.shared)this.shared.session=value;}
  private async connect():Promise<SharedConnection>{
    const key=connectionKey(this.target),client=new Client({name:'agent-office',version:'0.2.0'});
    let transport:StdioClientTransport|StreamableHTTPClientTransport;
    if(this.target.engine==='neo')transport=new StreamableHTTPClientTransport(new URL(this.target.endpoint!));
    else{
      requireCondition(this.target.engine==='aside'&&isAbsolute(this.target.executable!),'BROWSER_ABSOLUTE_CLI_REQUIRED');
      transport=new StdioClientTransport({command:this.target.executable!,args:['mcp','--host','local'],stderr:'pipe'});
    }
    const shared:SharedConnection={key,client,transport,session:undefined,users:0,linger:null,broken:false};
    try{
      // SDK 1.30 HTTP transport declares an optional sessionId getter as string|undefined.
      await client.connect(transport as Transport,{timeout:8000});
      if(transport instanceof StdioClientTransport)transport.stderr?.on('data',()=>{});
      transport.onclose=()=>{shared.broken=true;if(connections.get(key)===shared)connections.delete(key);};
      const catalog=await client.listTools(undefined,{timeout:8000});
      const tool=catalog.tools.find(t=>t.name===(this.target.engine==='neo'?'run':'repl'));
      requireCondition(tool&&tool.inputSchema.properties?.code,'BROWSER_MCP_SCHEMA_MISMATCH');
      if(this.target.engine==='neo'&&catalog.tools.some(t=>t.name==='name_session')){
        const named=await client.callTool({name:'name_session',arguments:{name:'Office browser',category:'data-extraction',summary:'Bounded runtime browser work'}},undefined,{timeout:8000});
        requireCondition(!named.isError,'BROWSER_REMOTE_OPERATION_FAILED');const session=named._meta?.['com.browseros.neo/session'];if(typeof session==='string')shared.session=session;
      }
    }catch(error){await closeConnection(shared);throw error;}
    connections.set(key,shared);return shared;
  }
  async warm(lingerMs:number){const shared=await this.connect();if(shared.users===0&&!shared.linger){shared.linger=setTimeout(()=>{if(shared.users===0)void closeConnection(shared);},lingerMs);shared.linger.unref();}}
  async probe(){
    requireCondition(!this.closed,'BROWSER_CONNECTION_CLOSED');if(this.shared)return;
    requireCondition(browserHostCompatible(this.target),'BROWSER_HOST_PLATFORM_MISMATCH');
    requireCondition(this.target.environment==='host_foreground','BROWSER_GUEST_TRANSPORT_UNVERIFIED');
    const key=connectionKey(this.target);await warming.get(key);let reused=connections.get(key);if(reused?.broken)reused=undefined;
    this.shared=reused??await this.connect();this.shared.users++;if(this.shared.linger){clearTimeout(this.shared.linger);this.shared.linger=null;}
    try{
      // A responding MCP server is not evidence of an attached browser. Listing is read-only.
      await this.script(this.target.engine==='neo'?'return (await browser.pages.list()).length;':'return (await listBrowserTabs()).length;');
    }catch(error){
      const stale=Boolean(reused);await this.disconnect();
      if(!stale)throw error;
      // A lingering connection whose browser went away is replaced once.
      if(reused)await closeConnection(reused);
      this.shared=await this.connect();this.shared.users++;
      try{await this.script(this.target.engine==='neo'?'return (await browser.pages.list()).length;':'return (await listBrowserTabs()).length;');}catch(second){await this.disconnect();throw second;}
    }
  }
  private async script(code:string):Promise<unknown>{
    requireCondition(this.client&&!this.closed,'BROWSER_CONNECTION_CLOSED');
    const marker=`AD_${randomUUID().replaceAll('-','')}:`;
    const neo=this.target.engine==='neo';
    const response=await this.client.callTool({name:neo?'run':'repl',arguments:neo?{code,...(this.session?{session:this.session}:{}),timeout:20000}:{title:'Agent Office browser operation',code:`console.log(${JSON.stringify(marker)}+JSON.stringify(await (async()=>{${code}})()));`}},undefined,{timeout:this.limits.operation_ms});
    const handle=response._meta?.['com.browseros.neo/session'];if(typeof handle==='string')this.session=handle;
    let payload=response.structuredContent as {ok?:boolean;value?:unknown;error?:unknown}|undefined;
    const texts=(Array.isArray(response.content)?response.content:[]).filter((c):c is {type:'text';text:string}=>c.type==='text'&&typeof c.text==='string').map(c=>c.text);
    if(neo&&!payload)for(const text of texts)try{const parsed=JSON.parse(text);if(typeof parsed?.ok==='boolean'){payload=parsed;break;}}catch{}
    const diagnostic=String(payload?.error??texts.join('\n'));
    const domainError=['PACK_WAITING_AUTH','PACK_UNKNOWN_DIALOG','PACK_ACCOUNT_MISMATCH','BROWSER_NOT_READY','SOURCE_TOO_MANY_ROWS','SOURCE_FIELD_AMBIGUOUS','BROWSER_TAB_OWNERSHIP_LOST'].find(code=>diagnostic.includes(code));
    if(response.isError||neo&&payload?.ok!==true)throw Error(domainError??(/browser session not connected|session.*(?:stopped|not active)|connection closed/iu.test(diagnostic)?'BROWSER_SESSION_UNAVAILABLE':'BROWSER_REMOTE_OPERATION_FAILED'));
    if(neo)return payload!.value;
    for(const text of texts){const offset=text.lastIndexOf(marker);if(offset>=0){const line=text.slice(offset+marker.length).split('\n')[0]!;try{return JSON.parse(line);}catch{}}}
    throw Error(domainError??'BROWSER_REMOTE_RESULT_INVALID');
  }
  private assertPage(){requireCondition(this.page!==null,'BROWSER_TAB_NOT_OPEN');}
  private ownedNeo(){return `const pages=await browser.pages.list();if(!pages.some(p=>p.pageId===${JSON.stringify(this.page)}&&p.ownership==='mine'))throw Error('BROWSER_TAB_OWNERSHIP_LOST');`;}
  async open(url:string){
    await this.probe();requireCondition(this.page===null,'BROWSER_TAB_ALREADY_OPEN');
    const create=async()=>{
      if(this.target.engine==='neo'){
        const id=await this.script('return await browser.pages.newPage("about:blank");');requireCondition(typeof id==='number'&&Number.isSafeInteger(id),'BROWSER_PAGE_ID_INVALID');this.page=id;
      }else{
        // Keep only the page we created. No attach-active-tab or profile/session copying.
        await this.script(`globalThis.${this.variable}=await openTab('about:blank');return true;`);this.page=this.variable;
      }
    };
    // A cold foreground browser answered its first operation late in live runs
    // (one ~30s refusal per new origin, then success). Retry once after a
    // timeout, closing the tab a late answer may have left under our variable.
    try{await create();}
    catch(error){
      if(!timedOut(error))throw error;
      if(this.target.engine==='aside')await this.script(`try{await closeTab(globalThis.${this.variable});}catch{}delete globalThis.${this.variable};return true;`).catch(()=>{});
      await create();
    }
    await this.navigate(url);
  }
  async navigate(url:string){
    this.assertPage();const go=()=>this.script(this.target.engine==='neo'?`${this.ownedNeo()}await browser.nav(${this.page}).goto(${JSON.stringify(url)});return true;`:`await globalThis.${this.variable}.goto(${JSON.stringify(url)},{waitUntil:'domcontentloaded',timeout:15000});return true;`);
    try{await go();}catch(error){if(!timedOut(error))throw error;await go();}
  }
  private async read(script:string){this.assertPage();return this.script(this.target.engine==='neo'?`${this.ownedNeo()}return await browser.evaluate(${this.page},{func:${JSON.stringify(script)}});`:`return await globalThis.${this.variable}.evaluate(${script});`);}
  async observe(){return browserObservationSchema.parse(await this.read(observationScript()));}
  async extract(spec:BrowserExtraction){
    this.assertPage();await this.script(this.target.engine==='neo'?`${this.ownedNeo()}await browser.wait(${this.page},{for:'selector',value:${JSON.stringify(spec.ready)}});return true;`:`await globalThis.${this.variable}.locator(${JSON.stringify(spec.ready)}).first().waitFor({state:'visible',timeout:10000});return true;`);
    const result=await this.read(extractionScript(spec));requireCondition(Array.isArray(result),'BROWSER_EXTRACTION_INVALID');return result as Array<Record<string,string>>;
  }
  async scroll(direction:'up'|'down'){this.assertPage();await this.script(this.target.engine==='neo'?`${this.ownedNeo()}await browser.input(${this.page}).scroll(${JSON.stringify(direction)},480);return true;`:`await globalThis.${this.variable}.mouse.wheel(0,${direction==='down'?480:-480});return true;`);}
  private async disconnect(){
    const shared=this.shared;this.shared=null;if(!shared)return;
    shared.users=Math.max(0,shared.users-1);
    if(shared.users>0||shared.broken)return;
    if(this.limits.linger_ms<=0){await closeConnection(shared);return;}
    shared.linger=setTimeout(()=>{void closeConnection(shared);},this.limits.linger_ms);shared.linger.unref();
  }
  async close(){if(this.closed)return;try{if(this.page!==null)await this.script(this.target.engine==='neo'?`${this.ownedNeo()}await browser.pages.close(${this.page});return true;`:`await closeTab(globalThis.${this.variable});delete globalThis.${this.variable};return true;`);}finally{this.page=null;this.closed=true;await this.disconnect();}}
}
