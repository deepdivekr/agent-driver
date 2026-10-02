/** A long feed or list response is shown as its entries, one per line, so a run reads it once instead of paging
 * through markup (live: a news Work spent its turns on byte ranges of four feeds). The entries are parsed by the host
 * from the bytes it received; nothing is summarised or reordered. */
const decode=(value:string)=>value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu,'$1').replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/<[^>]+>/gu,' ').replace(/&quot;/gu,'"').replace(/&#39;|&apos;/gu,"'").replace(/&amp;/gu,'&').replace(/\s+/gu,' ').trim();
const tag=(block:string,names:string[])=>{for(const name of names){const match=new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,'iu').exec(block);if(match&&decode(match[1]!))return decode(match[1]!);}return '';};
export interface FeedEntry {title:string;link:string;author:string;published:string;summary:string;}
export function feedEntries(xml:string,limit=40):FeedEntry[]|null{
  if(!/<(?:rss|feed|rdf:RDF)[\s>]/iu.test(xml.slice(0,2000)))return null;
  const blocks=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/giu)].map(match=>match[2]!);if(!blocks.length)return null;
  return blocks.slice(0,limit).map(block=>{
    const href=/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>(?![\s\S]*?<link\b[^>]*\brel=["']alternate)/iu.exec(block)?.[1]??/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/iu.exec(block)?.[1]??/<link\b[^>]*\bhref=["']([^"']+)["']/iu.exec(block)?.[1];
    return {title:tag(block,['title']).slice(0,300),link:(href??tag(block,['link','guid','id'])).slice(0,500),author:(tag(block,['dc:creator','name','author'])).slice(0,120),published:tag(block,['pubDate','published','updated','dc:date']).slice(0,60),summary:tag(block,['description','summary','content:encoded','content']).slice(0,200)};
  });
}
/** The largest array of objects inside a JSON document, as rows of their short scalar fields. */
export function jsonListRows(document:unknown,limit=60):Array<Record<string,string|number|boolean|null>>|null{
  let best:unknown[]|null=null,bestRank=-1;
  const score=(items:unknown[])=>{const keys=new Set(Object.keys(items[0] as object).map(key=>key.toLowerCase()));return Number(['title','headline','subject'].some(key=>keys.has(key)))*2+Number([...keys].some(key=>/(?:created|published|updated|date|time)/u.test(key)));};
  const visit=(value:unknown,depth:number)=>{
    if(depth>4||value===null||typeof value!=='object')return;
    if(Array.isArray(value)){
      // The list of a page is the one whose entries have a title and a date; a longer list of tags or users is not
      // (live: a forum's tag list was shown instead of its topics).
      if(value.length>=3&&value.every(item=>item&&typeof item==='object'&&!Array.isArray(item))){const rank=score(value);if(!best||rank>bestRank||rank===bestRank&&value.length>best.length){best=value;bestRank=rank;}}
      for(const item of value.slice(0,3))visit(item,depth+1);return;
    }
    for(const child of Object.values(value))visit(child,depth+1);
  };
  visit(document,0);if(!best)return null;
  return (best as Array<Record<string,unknown>>).slice(0,limit).map(item=>Object.fromEntries(Object.entries(item).filter(([key,value])=>!/(?:password|token|secret|api.?key|cookie|session)/iu.test(key)&&(value===null||typeof value==='number'||typeof value==='boolean'||typeof value==='string'&&value.length<=300)).slice(0,14)) as Record<string,string|number|boolean|null>);
}
/** The entry view of a body that does not fit one page, or null when the body is neither a feed nor a JSON list.
 * When the entries do not fit `room` they are shown shorter rather than fewer: a list cut after 13 of 30 entries is
 * incomplete evidence of what the list holds (live: verification refused it), a list of 30 titles and dates is not. */
export function listView(body:string,contentType:string,room=9000):{kind:'feed'|'json_list';text:string;entries:number}|null{
  const type=contentType.toLowerCase(),fits=(text:string)=>Buffer.byteLength(text)<=room;
  const lines=(rows:object[])=>rows.map(row=>JSON.stringify(row)).join('\n');
  if(/xml|rss|atom/u.test(type)||/^\s*<\?xml/u.test(body)){
    const entries=feedEntries(body);
    if(entries?.length){let text=lines(entries);for(const keep of [200,0]){if(fits(text))break;text=lines(entries.map(entry=>({...entry,summary:entry.summary.slice(0,keep)})));}return {kind:'feed',entries:entries.length,text};}
  }
  if(/json/u.test(type)){try{
    const rows=jsonListRows(JSON.parse(body));
    if(rows?.length){
      let text=lines(rows);
      if(!fits(text))text=lines(rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>/(?:^id$|title|headline|subject|slug|url|link|creat|publish|updat|date|time|author|name)/iu.test(key)).map(([key,value])=>[key,typeof value==='string'?value.slice(0,160):value]))));
      // Still too long: one identifier, the title, one address and one date per entry.
      if(!fits(text))text=lines(rows.map(row=>{const first=(pattern:RegExp)=>Object.entries(row).find(([key,value])=>pattern.test(key)&&value!==null&&value!=='');return Object.fromEntries([first(/^id$/iu),first(/title|headline|subject/iu),first(/slug|url|link/iu),first(/creat|publish/iu)??first(/date|time|updat/iu)].filter((entry):entry is [string,string|number|boolean|null]=>Boolean(entry)).map(([key,value])=>[key,typeof value==='string'?value.slice(0,120):value]));}));
      return {kind:'json_list',entries:rows.length,text};
    }
  }catch{/* Not JSON after all. */}}
  return null;
}
