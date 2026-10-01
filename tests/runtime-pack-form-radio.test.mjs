import test from 'node:test';
import assert from 'node:assert/strict';
import {targetSchema} from '../dist/packs/contracts.js';

// B5: public order forms (httpbin.org/forms/post) choose size with radio inputs.
// The selector names the group; the value selects one option.
test('runtime contract a draft-only form target may declare a radio field group',()=>{
  const target={id:'httpbin-order',family:'form.draft-submit',action:'submit_form',url:'https://httpbin.org/forms/post',draft_is_local:true,draft_only:true,auth_required:false,effect_boundary:'single_form_submission',
    ready:'form',auth_gate:'input[type=password]',account_selector:'body',account_text:'httpbin',fields:{custname:{selector:'input[name=custname]',kind:'text'},size:{selector:'input[name=size]',kind:'radio'}},identity_field:'custname',submit:'button',readback_url:null,identity_parameter:'custname'};
  assert.equal(targetSchema.parse(target).fields.size.kind,'radio');
  assert.throws(()=>targetSchema.parse({...target,fields:{...target.fields,size:{selector:'input[name=size]',kind:'toggle'}}}));
});
