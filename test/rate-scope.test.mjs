import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyHttpFailure} from '../lib/request-policy.js';
import {fixture,credential,json} from './helpers.mjs';
const options={model:'gemini-3-flash',messages:[{role:'user',content:[{type:'text',text:'hi'}]}]};
const complete=()=>new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]})+'\n\n');

test('429 without wait permits one retry even when quota is explicit',()=>{
  for(const message of ['Quota reached','Individual quota reached']){
    const p=classifyHttpFailure(429,JSON.stringify({error:{message}}),{});
    assert.equal(p.retryable,true);assert.equal(p.retryDelayMs,2500);assert.equal(p.cooldownMs,15000);
  }
});
test('429 uses exact positive wait up to thirty seconds and rejects longer waits',()=>{
  for(const seconds of [1,2,30,31,120]){
    const p=classifyHttpFailure(429,'{}',{'Retry-After':String(seconds)});
    assert.equal(p.retryable,seconds<=30);assert.equal(p.retryDelayMs,seconds*1000);assert.equal(p.cooldownMs,seconds*1000);
  }
});
test('legacy provider pause is ignored without erasing account cooldowns',async t=>{
  const {Pool,home}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
  await pool.markCooldown(pool.allAccounts[0].id,60000);
  const {readFile,writeFile}=await import('node:fs/promises');const file=home+'/storages/antigravity-pool-accounts.json';
  const raw=JSON.parse(await readFile(file,'utf8'));raw.requestBlockedUntil=Date.now()+120000;await writeFile(file,JSON.stringify(raw));
  const reloaded=new Pool();
  assert.deepEqual(Array.from(await reloaded.getCandidateAccounts(),a=>a.email),['b']);
  assert.equal((await reloaded.getStatus()).requestPauseRemainingMs,0);
});
test('manual selection still does not erase a valid server cooldown',async t=>{
  const {Pool}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  const id=pool.allAccounts[0].id;await pool.markCooldown(id,120000);
  await pool.setPrimaryAccount(id);await pool.updateConfig({schedulingMode:'manual',activeAccountId:id});
  assert.equal((await pool.getCandidateAccounts()).length,0);
  assert.ok((await pool.getStatus()).accounts[0].cooldownRemainingMs>110000);
});
test('long 429 cools only current account and does not automatically switch accounts',async t=>{
  const tokens=[];const {api,Pool}=await fixture(t,async(url,init)=>{
    if(!url.includes('streamGenerateContent'))return json({});tokens.push(init.headers.Authorization);return new Response('{"error":{"message":"Quota reached"}}',{status:429,headers:{'Retry-After':'120'}});
  });const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
  const adapter=new api.AntigravityPoolAdapter(pool);
  await assert.rejects(async()=>{for await(const c of adapter.stream(options)){}},e=>e.status===429);
  assert.equal((await pool.getStatus()).requestPauseRemainingMs,0);assert.equal(tokens.length,1);
  await pool.updateConfig({schedulingMode:'manual',activeAccountId:pool.allAccounts[1].id});
  assert.equal((await pool.getCandidateAccounts()).length,1);
});
test('quota-query 429 only records quotaError and does not cool or globally pause accounts',async t=>{
  const {api,Pool}=await fixture(t,async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}}));
  const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await assert.rejects(api.fetchQuotaForAccount(pool.allAccounts[0],pool),e=>e.status===429);
  const s=await pool.getStatus();assert.equal(s.requestPauseRemainingMs,0);assert.equal(s.accounts[0].cooldownRemainingMs,0);
  assert.ok(s.accounts[0].quotaError);assert.equal((await pool.getCandidateAccounts()).length,1);
});
for(const wait of [0,2]){
  test(`429 wait=${wait} retries once on the same endpoint and account then stops`,async t=>{
    const hosts=[];const {api,Pool,scheduledTimers}=await fixture(t,async(url,init)=>{
      if(!url.includes('streamGenerateContent'))return json({});hosts.push({host:new URL(url).host,token:init.headers.Authorization});
      return new Response('{"error":{"message":"Quota reached"}}',{status:429,headers:wait?{'Retry-After':String(wait)}:{}});
    });const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
    const adapter=new api.AntigravityPoolAdapter(pool);
    await assert.rejects(async()=>{for await(const c of adapter.stream(options)){}},e=>e.status===429);
    assert.equal(hosts.length,2);assert.equal(new Set(hosts.map(x=>x.host)).size,1);assert.equal(new Set(hosts.map(x=>x.token)).size,1);
    assert.ok(scheduledTimers.includes(wait*1000||2500));
    const state=await pool.getStatus();assert.equal(state.requestPauseRemainingMs,0);assert.ok(state.accounts[0].cooldownRemainingMs>0);assert.equal(state.accounts[1].cooldownRemainingMs,0);
  });
}
test('one 429 retry may recover without cooldown',async t=>{
  let attempts=0;const hosts=[];const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});hosts.push(new URL(url).host);
    return attempts++===0?new Response('{}',{status:429}):complete();
  });
  for await(const c of api.requestAntigravityChunksWithAccount(options,{id:options.model,inputModalities:['text']},undefined,{token:'mock',projectId:'mock'})){}
  assert.equal(attempts,2);assert.equal(new Set(hosts).size,1);
});
