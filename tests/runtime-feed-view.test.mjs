import test from 'node:test';
import assert from 'node:assert/strict';
import {feedEntries,jsonListRows,listView} from '../dist/work/feed-view.js';

// Live: a news Work read four feeds in byte ranges and ran out of turns. A feed or list is shown as its entries.
test('RSS and Atom feeds become entries with title, link, author, date and a short summary',()=>{
  const atom=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><title>Agents &amp; tools</title><link href="https://example.org/2026/agents" rel="alternate"/><author><name>Simon</name></author><published>2026-09-30T10:00:00Z</published><summary type="html">&lt;p&gt;A long &lt;b&gt;post&lt;/b&gt; about agents.&lt;/p&gt;</summary></entry><entry><title>Second</title><link href="https://example.org/2026/second"/><updated>2026-09-29T10:00:00Z</updated></entry></feed>`;
  assert.deepEqual(feedEntries(atom),[{title:'Agents & tools',link:'https://example.org/2026/agents',author:'Simon',published:'2026-09-30T10:00:00Z',summary:'A long post about agents.'},{title:'Second',link:'https://example.org/2026/second',author:'',published:'2026-09-29T10:00:00Z',summary:''}]);
  const rss=`<rss version="2.0"><channel><title>Site</title><item><title><![CDATA[Something big]]></title><link>https://example.org/big</link><dc:creator>Matt</dc:creator><pubDate>Tue, 30 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Why it matters</p>]]></description></item></channel></rss>`;
  assert.deepEqual(feedEntries(rss),[{title:'Something big',link:'https://example.org/big',author:'Matt',published:'Tue, 30 Sep 2026 10:00:00 GMT',summary:'Why it matters'}]);
  assert.equal(feedEntries('<html><body><p>not a feed</p></body></html>'),null);
});
test('a JSON document is shown as its largest list of objects, short scalar fields only',()=>{
  const discourse={tags:Array.from({length:40},(_,i)=>({id:i,name:`tag-${i}`,count:i})),users:[{id:1,username:'a'}],topic_list:{more_topics_url:'/c/news/14?page=1',topics:[{id:12070,title:'Index-Translate 공개',slug:'index-translate',created_at:'2026-09-30T01:00:00Z',excerpt:'x'.repeat(400),posters:[{user_id:1}],api_key:'no'},{id:12063,title:'결정 모델 d1',slug:'d1',created_at:'2026-09-29T01:00:00Z'},{id:12001,title:'세 번째',slug:'third',created_at:'2026-09-28T01:00:00Z'}]}};
  assert.deepEqual(jsonListRows(discourse)[0],{id:12070,title:'Index-Translate 공개',slug:'index-translate',created_at:'2026-09-30T01:00:00Z'});assert.equal(jsonListRows(discourse).length,3);
  assert.equal(jsonListRows({a:1,b:{c:[1,2,3]}}),null);
  const view=listView(JSON.stringify(discourse),'application/json; charset=utf-8');assert.equal(view.kind,'json_list');assert.equal(view.text.split('\n').length,3);
  assert.equal(listView('plain text','text/plain'),null);
});
