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

// Live: 13 of 30 forum topics were shown and verification refused the list as incomplete.
test('runtime contract a list that does not fit is shown with shorter entries, never fewer',()=>{
  const topics=Array.from({length:30},(_,index)=>({id:index,title:`Topic ${index} `+'t'.repeat(80),slug:`topic-${index}`,created_at:'2026-10-01T00:00:00Z',excerpt:'e'.repeat(280),views:index,pinned:false,image_url:null,last_poster_username:'poster',category_id:14,bumped_at:'2026-10-01T01:00:00Z'}));
  const view=listView(JSON.stringify({topic_list:{topics}}),'application/json');
  assert.equal(view.text.split('\n').length,30);assert.ok(Buffer.byteLength(view.text)<=9000);
  const last=JSON.parse(view.text.split('\n').at(-1));assert.equal(last.slug,'topic-29');assert.equal(last.created_at,'2026-10-01T00:00:00Z');assert.equal(last.excerpt,undefined);
  const feed='<?xml version="1.0"?><rss><channel>'+Array.from({length:30},(_,index)=>`<item><title>Post ${index}</title><link>https://example.org/${index}</link><pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate><description>${'d'.repeat(900)}</description></item>`).join('')+'</channel></rss>';
  const entries=listView(feed,'application/rss+xml');assert.equal(entries.text.split('\n').length,30);assert.ok(Buffer.byteLength(entries.text)<=9000);assert.equal(JSON.parse(entries.text.split('\n')[29]).link,'https://example.org/29');
});
