import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAutomatedBrowserAllowed,browserRouteDecision,policySite,siteAutomationPolicy} from '../dist/swarm/account-browser-policy.js';

const surface=(kind,patch={})=>({kind,local:true,persistent_profile:true,network_origin:'user_device',explicitly_connected:true,...patch});

test('runtime contract does not encode site-specific terms or force an API route',()=>{
  assert.equal(policySite('https://mobile.twitter.com/example'),'x.com');assert.equal(policySite('https://old.reddit.com/r/example'),'reddit.com');assert.equal(policySite('https://x.com.evil.test/'),'x.com.evil.test');
  for(const url of ['https://x.com/search','https://reddit.com/r/test','https://stocktwits.com/symbol/ASTS']){
    assert.equal(siteAutomationPolicy(url).automated_access,'browser_permitted');
    assert.equal(assertAutomatedBrowserAllowed(url).automated_access,'browser_permitted');
  }
});

test('runtime contract login requires an explicitly connected local persistent browser',()=>{
  const url='https://portal.example.test/account';
  assert.equal(browserRouteDecision({url,use:'human_login',requires_login:true,surface:surface('owned_vm',{network_origin:'vm'})}).reason,'allowed_connected_browser');
  assert.equal(browserRouteDecision({url,use:'human_login',requires_login:true,surface:surface('owned_headless')}).allowed,false);
  for(const kind of ['browseros_neo','aside','user_chrome'])assert.equal(browserRouteDecision({url,use:'human_login',requires_login:true,surface:surface(kind)}).allowed,true);
  assert.equal(browserRouteDecision({url,use:'human_login',requires_login:true,surface:surface('aside',{network_origin:'cloud'})}).reason,'allowed_connected_browser');
  assert.equal(browserRouteDecision({url,use:'human_login',requires_login:true,surface:surface('browseros_neo',{explicitly_connected:false})}).allowed,false);
  assert.equal(browserRouteDecision({url,use:'automated_read',requires_login:false,surface:surface('owned_headless')}).reason,'allowed_public_browser');
  assert.equal(siteAutomationPolicy(url).automated_access,'browser_permitted');
});

test('runtime contract connected browser can run user-authorized read-only community research',()=>{
  const trusted=surface('browseros_neo');
  assert.equal(browserRouteDecision({url:'https://x.com/login',use:'human_login',requires_login:true,surface:trusted}).allowed,true);
  assert.equal(browserRouteDecision({url:'https://x.com/search',use:'automated_read',requires_login:true,surface:trusted}).allowed,true);
});
