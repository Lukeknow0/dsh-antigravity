import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, credential, json } from './helpers.mjs';
const frame = value => 'data: '+JSON.stringify(value)+'\n\n';

for(const status of [403,429]){
  test(`image ${status} stops without endpoint or account replacement`,async t=>{
    let attempts=0;
    const {api,Pool}=await fixture(t,async url=>{
      if(!url.includes('streamGenerateContent'))return json({});
      attempts++;return new Response('{"error":{"message":"denied"}}',{status,headers:{'Retry-After':'120'}});
    });
    const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
    await assert.rejects(api.generateImageThroughPool('picture',pool,new api.FileModelSettingsStore()),e=>e.status===status);
    assert.equal(attempts,1);
    const state=await pool.getStatus();
    if(status===429){assert.equal(state.requestPauseRemainingMs,0);assert.ok(state.accounts[0].cooldownRemainingMs>110000);assert.equal(state.accounts[1].cooldownRemainingMs,0);}
    else assert.equal(state.accounts[0].suspended,true);
  });
}
test('successful image generation returns bytes and internal ID, not email',async t=>{
  const {api,Pool}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    return new Response(frame({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]},finishReason:'STOP'}]}));
  });
  const pool=new Pool();await pool.addOrUpdateAccount(credential('user@example.test'));
  const result=await api.generateImageThroughPool('picture',pool,new api.FileModelSettingsStore());
  assert.equal(result.base64,'aGVsbG8=');
  assert.equal(result.accountId,pool.allAccounts[0].id);
  assert.doesNotMatch(JSON.stringify(result),/user@example.test/);
});
test('image stream failure before bytes is not automatically replayed',async t=>{
  let attempts=0;
  const {api,Pool}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    attempts++;return new Response(new ReadableStream({start(c){c.error(new TypeError('stream failed'));}}));
  });
  const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await assert.rejects(api.generateImageThroughPool('picture',pool,new api.FileModelSettingsStore()));
  assert.equal(attempts,1);
});
