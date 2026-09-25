import test from 'node:test';
import assert from 'node:assert/strict';
import {FAST_MODEL_DEFAULTS,preferredFastModel,selectedFastModel} from '../dist/integrations/fast-models.js';
import {apiModelCatalog} from '../dist/onboarding/model-catalog.js';

test('each provider starts on its luna-class model even without a key',async()=>{
  assert.deepEqual(FAST_MODEL_DEFAULTS,{openai:'gpt-6-luna',anthropic:'claude-haiku-4-5',openrouter:'openai/gpt-6-luna',openai_compatible:''});
  for(const provider of ['openai','anthropic','openrouter']){
    const catalog=await apiModelCatalog(provider,'',undefined,async()=>{throw Error('no network without a key');},'gpt-5.6-luna');
    assert.equal(catalog.selected,FAST_MODEL_DEFAULTS[provider]);assert.equal(catalog.models[0].id,FAST_MODEL_DEFAULTS[provider]);assert.equal(catalog.status,'unavailable');
  }
});

test('refresh recommends the newest listed fast model only before a user chooses one',async()=>{
  const live=ids=>async()=>new Response(JSON.stringify({data:ids.map(id=>({id}))}),{status:200});
  const key='fixture-key-not-real-1234567890';
  assert.equal((await apiModelCatalog('openai',key,'',live(['gpt-5.6-luna','gpt-5.6-sol','gpt-6-sol','gpt-6-luna']),'')).selected,'gpt-6-luna');
  assert.equal((await apiModelCatalog('openai',key,'',live(['gpt-5.6-luna','gpt-6-sol','gpt-6-luna']),'gpt-5.6-luna')).selected,'gpt-5.6-luna','an existing fast-tier choice remains pinned');
  assert.equal((await apiModelCatalog('openai',key,'',live(['gpt-5.6-luna','gpt-6-sol','gpt-6-luna']),'gpt-6-sol')).selected,'gpt-6-sol');
  assert.equal((await apiModelCatalog('anthropic',key,'',live(['claude-haiku-4-5-20251001','claude-haiku-4-5','claude-sonnet-4-5']),'')).selected,'claude-haiku-4-5');
  assert.equal(preferredFastModel('openrouter',['anthropic/claude-haiku-4.5','openai/gpt-5.6-luna']),'openai/gpt-5.6-luna');
  assert.equal(preferredFastModel('openai_compatible',['qwen3-30b','llama-4']),'','unknown compatible providers require an explicit choice');
  assert.equal(selectedFastModel('openai',['gpt-6-luna'],'custom-finetune'),'custom-finetune','a saved custom model must not be silently replaced');
  assert.equal(selectedFastModel('openai',['gpt-6-sol'],''),'','do not inject an unavailable fast model into a live catalog');
  assert.equal(selectedFastModel('openai',['gpt-6-sol'],'gpt-6-luna'),'','the unconfigured pinned default is not an explicit choice when absent from a live catalog');
});
