import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, credential } from './helpers.mjs';

function router(api) {
  let handler;
  const ctx={llm:{registerAdapter(){}},emit(){},inject(names,callback){
    if(names.includes('webServer'))callback({effect(fn){fn();},webServer:{register(config){handler=config.handler;}}});
  }};
  api.apply(ctx);
  return async(path='/status',method='GET')=>{
    let body,status;
    await handler({url:'/antigravity/api'+path,method},{writeHead(code){status=code;},end(text){body=JSON.parse(text);}});
    return {body,status};
  };
}
test('package, diagnostics and status all use release 0.1.5',async t=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.version,'0.1.5');
  const {api}=await fixture(t);
  assert.equal(api.PLUGIN_VERSION,pkg.version);
  assert.equal(api.getAntigravityDiagnostics().version,pkg.version);
  const result=await router(api)();
  assert.equal(result.body.value.version,pkg.version);
});
test('status exposes provider cooldown and suspended state without tokens',async t=>{
  const {api,Pool}=await fixture(t);const pool=new Pool();
  await pool.addOrUpdateAccount(credential('local@example.test'));
  await pool.pauseRequests(120000);await pool.suspendAccount(pool.allAccounts[0].id);
  const {body}=await router(api)();
  assert.ok(body.value.requestPauseRemainingMs>110000);
  assert.equal(body.value.accounts[0].suspended,true);
  assert.doesNotMatch(JSON.stringify(body),/test-refresh|"access"|"refresh"/);
});
test('quota refresh route stops account fanout after a limit response',async t=>{
  let requests=0;
  const {api,Pool}=await fixture(t,async()=>{
    requests++;return new Response('{"error":{"message":"limited"}}',{status:429});
  });
  const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));await pool.addOrUpdateAccount(credential('b'));
  await router(api)('/quota','POST');
  assert.equal(requests,1);
});
test('settings explain stop-on-limit behavior instead of instant account rotation',async()=>{
  const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/毫秒级自动切换|instantly on 429|double your capacity/i);
  assert.match(source,/requestPauseRemainingMs/);
  assert.match(source,/account\.suspended/);
});
