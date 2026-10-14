import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, credential, json } from './helpers.mjs';

for(const mode of ['auto','primary-backup','manual']){
  test(`${mode} never returns cooling accounts`,async t=>{
    const {Pool}=await fixture(t);const pool=new Pool();
    await pool.addOrUpdateAccount(credential('primary'));
    await pool.addOrUpdateAccount(credential('backup'));
    await pool.updateConfig({schedulingMode:mode});
    await pool.markCooldown(pool.allAccounts[0].id,60000);
    const list=await pool.getCandidateAccounts();
    assert.deepEqual(Array.from(list,a=>a.email),mode==='manual'?[]:['backup']);
  });
}
test('manual candidates contain only the specified account',async t=>{
  const {Pool}=await fixture(t);const pool=new Pool();
  await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
  await pool.updateConfig({schedulingMode:'manual',activeAccountId:pool.allAccounts[1].id});
  assert.deepEqual(Array.from(await pool.getCandidateAccounts(),a=>a.email),['b']);
});
test('concurrent cooldown changes cannot shorten an existing wait',async t=>{
  const {Pool}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await Promise.all([pool.markCooldown(pool.allAccounts[0].id,120000),pool.markCooldown(pool.allAccounts[0].id,1000)]);
  assert.equal((await pool.getStatus()).requestPauseRemainingMs,0);
  assert.ok((await pool.getStatus()).accounts[0].cooldownRemainingMs > 110000);
});
test('suspended account remains unavailable until reauthorization',async t=>{
  const {Pool}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await pool.suspendAccount(pool.allAccounts[0].id,'AUTH');
  assert.equal((await pool.getCandidateAccounts()).length,0);
  assert.equal((await pool.getStatus()).accounts[0].suspended,true);
  await pool.addOrUpdateAccount(credential('a'));
  assert.equal((await pool.getCandidateAccounts()).length,1);
});
for(const status of [403,429]){
  test(`adapter ${status} neither changes accounts nor clears pause`,async t=>{
    const hits=[];
    const {api,Pool}=await fixture(t,async(url,init)=>{
      if(!url.includes('streamGenerateContent'))return json({});
      hits.push(init.headers.Authorization);
      return new Response('{"error":{"message":"denied"}}',{status,headers:{'Retry-After':'120'}});
    });
    const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
    const adapter=new api.AntigravityPoolAdapter(pool);
    const run=async()=>{for await(const chunk of adapter.stream({model:'gemini-3-flash',messages:[{role:'user',content:[{type:'text',text:'hello'}]}]})) {}};
    await assert.rejects(run(),e=>e.status===status);
    assert.equal(hits.length,1);
    const state=await pool.getStatus();
    if(status===429){
      assert.equal(state.requestPauseRemainingMs,0);
      assert.ok(state.accounts[0].cooldownRemainingMs>110000);
      assert.deepEqual(Array.from(await pool.getCandidateAccounts(),a=>a.email),['b']);
    }else assert.equal(state.accounts[0].suspended,true);
  });
}
test('concurrent token refresh is single-flight and keeps cooldown',async t=>{
  let refreshes=0;
  const {api,Pool}=await fixture(t,async url=>{
    if(url.includes('/token')) {refreshes++;return json({access_token:'new-test',expires_in:3600});}
    return json({});
  });
  const pool=new Pool();await pool.addOrUpdateAccount({...credential('a'),expires:1});
  const account=pool.allAccounts[0];await pool.markCooldown(account.id,60000);
  await Promise.all([api.ensureApiKeyForAccount(account,pool),api.ensureApiKeyForAccount(account,pool)]);
  assert.equal(refreshes,1);
  assert.ok((await pool.getStatus()).accounts[0].cooldownRemainingMs > 50000);
});
test('invalid-grant token response becomes a terminal auth error',async t=>{
  let refreshes=0;
  const {api,Pool}=await fixture(t,async()=>{
    refreshes++;return new Response('{"error":"invalid_grant","error_description":"revoked"}',{status:400});
  });
  const pool=new Pool();await pool.addOrUpdateAccount({...credential('a'),expires:1});
  await assert.rejects(api.ensureApiKeyForAccount(pool.allAccounts[0],pool),e=>e.code==='AUTH');
  assert.equal(refreshes,1);
});
test('persistent public errors and ordinary logs omit account identities',async t=>{
  const {Pool,logs}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('user@example.test'));
  await pool.markCooldown(pool.allAccounts[0].id,60000,'access_token=test-secret email=user@example.test');
  const state=await pool.getStatus();
  assert.doesNotMatch(state.accounts[0].lastError,/test-secret|user@example.test/);
  assert.doesNotMatch(JSON.stringify(logs),/user@example.test|test-refresh/);
});
