import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,credential,json} from './helpers.mjs';
const options={model:'gemini-3-flash',messages:[{role:'user',content:[{type:'text',text:'hi'}]}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const run=async(api,pool,signal)=>{for await(const chunk of new api.AntigravityPoolAdapter(pool).stream({...options,signal})) {}};
for(const status of [401,403,429]){
  test(`unreadable HTTP ${status} remains terminal and updates pool protection`,async t=>{
    let requests=0;
    const {api,Pool}=await fixture(t,async url=>{
      if(!url.includes('streamGenerateContent'))return json({});
      requests++;
      return new Response(new ReadableStream({start(c){c.error(new TypeError('body reset'));}}),{status,headers:{'Retry-After':'120'}});
    });
    const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
    await assert.rejects(run(api,pool),e=>e.status===status);
    assert.equal(requests,1);
    const state=await pool.getStatus();
    if(status===429){assert.equal(state.requestPauseRemainingMs,0);assert.ok(state.accounts[0].cooldownRemainingMs>110000);}else assert.equal(state.accounts[0].suspended,true);
  });
}
test('unreadable metadata 429 records error without pausing chat',async t=>{
  let requests=0;
  const {api,Pool}=await fixture(t,async()=>{
    requests++;return new Response(new ReadableStream({start(c){c.error(new TypeError('reset'));}}),{status:429,headers:{'Retry-After':'120'}});
  });
  const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await assert.rejects(api.fetchQuotaForAccount(pool.allAccounts[0],pool),e=>e.status===429);
  assert.equal(requests,1);const state=await pool.getStatus();assert.equal(state.requestPauseRemainingMs,0);assert.equal(state.accounts[0].cooldownRemainingMs,0);assert.ok(state.accounts[0].quotaError);
});
test('sole cancellation aborts refresh and returns without waiting for token response',async t=>{
  let release,ready,fetchSignal;
  const began=new Promise(r=>{ready=r;});const held=new Promise(r=>{release=r;});
  const {api,Pool}=await fixture(t,async(url,init)=>{if(url.includes('/token')){fetchSignal=init.signal;ready();return held;}return json({});});
  const pool=new Pool();await pool.addOrUpdateAccount({...credential('a'),expires:1});
  const controller=new AbortController();let error;
  const pending=run(api,pool,controller.signal).catch(e=>{error=e;});
  try {
    await began;controller.abort();await tick();
    assert.equal(error?.code,'ABORTED');assert.equal(fetchSignal.aborted,true);
  } finally {release(json({access_token:'after-cancel',expires_in:3600}));await pending;await tick();}
  assert.notEqual(pool.allAccounts[0].access,'after-cancel');
});
test('canceled-only model discovery cannot schedule a second metadata request',async t=>{
  let release,ready,requests=0,fetchSignal;
  const began=new Promise(r=>{ready=r;});const held=new Promise(r=>{release=r;});
  const {api}=await fixture(t,async(url,init)=>{requests++;fetchSignal=init.signal;ready();return held;});
  const controller=new AbortController();
  const pending=(async()=>{for await(const c of api.requestAntigravityChunksWithAccount(options,{id:options.model,inputModalities:['text']},controller.signal,{token:'mock',projectId:'mock'})) {}})();
  await began;controller.abort();await assert.rejects(pending,e=>e.code==='ABORTED');
  assert.equal(fetchSignal.aborted,true);
  release(new Response('{}',{status:503}));
  await new Promise(r=>setTimeout(r,10));
  assert.equal(requests,1);
});
test('canceling one co-consumer retains the refresh for the remaining owner',async t=>{
  let release,ready,refreshes=0,fetchSignal;
  const began=new Promise(r=>{ready=r;});const held=new Promise(r=>{release=r;});
  const {api,Pool}=await fixture(t,async(url,init)=>{refreshes++;fetchSignal=init.signal;ready();return held;});
  const pool=new Pool();await pool.addOrUpdateAccount({...credential('a'),expires:1});
  const first=new AbortController(),second=new AbortController();
  const cancelled=api.ensureApiKeyForAccount(pool.allAccounts[0],pool,first.signal);
  const retained=api.ensureApiKeyForAccount(pool.allAccounts[0],pool,second.signal);
  await began;first.abort();
  try {
    let timer;
    try {
      await Promise.race([assert.rejects(cancelled,e=>e.code==='ABORTED'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cancel did not settle')),30);})]);
    } finally {clearTimeout(timer);}
    assert.equal(fetchSignal.aborted,false);
  } finally {release(json({access_token:'shared-new',expires_in:3600}));}
  assert.equal((await retained).token,'shared-new');assert.equal(refreshes,1);
});
