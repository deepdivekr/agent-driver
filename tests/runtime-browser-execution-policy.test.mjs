import test from 'node:test';
import assert from 'node:assert/strict';
import {browserHandJevInput,chooseBrowserExecutionHand} from '../dist/taskpack/browser-execution-policy.js';

const proposed=(route_id)=>({status:'PROPOSED',route_id,fields:{},trace:{provider:'typesafe',model:'fixture',input_sha256:'a'.repeat(64),elapsed_ms:1,input_tokens:'unobserved',output_tokens:'unobserved',status:'accepted'}});

const adaptive={kind:'semantic_browser',reason:'ADAPTIVE_STEP',executor:'jev_or_llm_with_browser_tools'};

test('runtime contract read-only travel hand preserves source and authentication boundaries regardless of tool choice',()=>{
  const unreviewed={source_id:'public_flights',permission:'unreviewed',state:'search_form'};
  for(const route of ['semantic_browser','reviewed_deterministic']){
    assert.deepEqual(chooseBrowserExecutionHand(unreviewed,proposed(route)),{kind:'hold',reason:'SOURCE_PERMISSION_UNREVIEWED'});
    assert.deepEqual(chooseBrowserExecutionHand({...unreviewed,permission:'read_only_confirmed',state:'challenge'},proposed(route)),{kind:'hold',reason:'CHALLENGE_REQUIRED'});
    for(const state of ['authentication','consent'])assert.deepEqual(chooseBrowserExecutionHand({...unreviewed,permission:'read_only_confirmed',state},proposed(route)),{kind:'hold',reason:'CONSENT_OR_AUTH_REQUIRED'});
  }
});

test('runtime contract Jev hand prompt permits selector navigation and form input without granting authority',()=>{
  const search={source_id:'public_flights',permission:'read_only_confirmed',state:'search_form'};
  const input=browserHandJevInput('Find flights to Tokyo next month',search);
  assert.deepEqual(input.routes.map(route=>route.id),['semantic_browser','reviewed_deterministic','hold']);
  assert.equal(input.policy_version,'browser_hand_v2');
  assert.match(input.routes[0].description,/Jev or an LLM/);
  assert.match(input.routes[0].description,/selectors, locators, DOM references/);
  assert.match(input.routes[1].description,/navigation, search-form input, a search button/);
  assert.equal(input.fields.length,0);assert.equal(input.observed_state.execution_authority,false);
  assert.deepEqual(chooseBrowserExecutionHand(search,proposed('semantic_browser')),adaptive);
  assert.deepEqual(chooseBrowserExecutionHand(search,proposed('reviewed_deterministic')),{kind:'reviewed_deterministic',reason:'EXECUTE_PACK_STEP',executor:'reviewed_browser_primitive'});
});

test('runtime contract browser hand honors adaptive result inspection instead of forcing deterministic reads',()=>{
  const search={source_id:'public_flights',permission:'read_only_confirmed',state:'search_form'};
  assert.deepEqual(chooseBrowserExecutionHand({...search,state:'results'},proposed('semantic_browser')),adaptive);
  assert.deepEqual(chooseBrowserExecutionHand({...search,state:'results'},proposed('reviewed_deterministic')),{kind:'reviewed_deterministic',reason:'READ_RENDERED_RESULT',executor:'reviewed_browser_primitive'});
  assert.deepEqual(chooseBrowserExecutionHand({...search,state:'known_benign_popup',reviewed_popup_id:'locale_hint'},proposed('reviewed_deterministic')),{kind:'reviewed_deterministic',reason:'DISMISS_REVIEWED_POPUP',executor:'reviewed_browser_primitive',popup_id:'locale_hint'});
  assert.deepEqual(chooseBrowserExecutionHand({...search,state:'known_benign_popup',reviewed_popup_id:'locale_hint'},proposed('semantic_browser')),adaptive);
});

test('runtime contract unfamiliar UI escalates observation without automatic human hold or ungrounded replay',()=>{
  const search={source_id:'public_flights',permission:'read_only_confirmed',state:'search_form'};
  for(const state of ['unknown_popup','unknown','known_benign_popup']){
    for(const route of ['semantic_browser','reviewed_deterministic'])assert.deepEqual(chooseBrowserExecutionHand({...search,state},proposed(route)),adaptive);
  }
  assert.deepEqual(chooseBrowserExecutionHand(search,{status:'JEV_UNAVAILABLE'}),adaptive);
  assert.deepEqual(chooseBrowserExecutionHand(search,proposed('unsupported_route')),adaptive);
  assert.deepEqual(chooseBrowserExecutionHand({...search,state:'unknown_popup'},proposed('hold')),{kind:'hold',reason:'UNKNOWN_UI'});
});
