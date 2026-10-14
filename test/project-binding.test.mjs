import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,credential,json,quota} from './helpers.mjs';
const discovered='real-backend-project';
const metadataFetch=async url=>json(url.includes('loadCodeAssist')?{cloudaicompanionProject:discovered}:url.includes('retrieveUserQuotaSummary')?quota(1):{});

test('quota discovery synchronizes the credential project used by generation',async t=>{
  let request;
  const {api,Pool}=await fixture(t,async(url,init)=>{
    if(url.includes('streamGenerateContent')){
      request=JSON.parse(init.body);
      return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]})+'\n\n');
    }
    return metadataFetch(url);
  });const pool=new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  await api.fetchQuotaForAccount(pool.allAccounts[0],pool);
  assert.equal(pool.allAccounts[0].projectId,discovered);
  const key=await api.ensureApiKeyForAccount(pool.allAccounts[0],pool);
  assert.equal(key.projectId,discovered);
  for await(const c of api.requestAntigravityChunksWithAccount({messages:[{role:'user',content:[{type:'text',text:'hello'}]}]}, {id:'gemini-3.8-flash-tiered',inputModalities:['text']}, undefined, key)){}
  assert.equal(request.project,discovered);
});
test('cached authoritative discovery repairs a legacy generated fallback without network',async t=>{
  let calls=0;const {api,Pool}=await fixture(t,async()=>{calls++;return json({});});const pool=new Pool();
  const fallback=JSON.parse(api.getApiKey({email:'a'})).projectId;
  await pool.addOrUpdateAccount({...credential('a'),projectId:fallback});
  await pool.updateAccountQuota(pool.allAccounts[0].id,{schemaVersion:2,projectId:discovered,backendProjectId:discovered,fetchedAt:Date.now()});
  const result=await api.ensureApiKeyForAccount(pool.allAccounts[0],pool);
  assert.equal(result.projectId,discovered);assert.equal(pool.allAccounts[0].projectId,discovered);assert.equal(calls,0);
});
test('legacy fallback without authoritative cache discovers the real project once',async t=>{
  let loads=0;const {api,Pool}=await fixture(t,async url=>{if(url.includes('loadCodeAssist'))loads++;return metadataFetch(url);});const pool=new Pool();
  await pool.addOrUpdateAccount({...credential('a'),projectId:JSON.parse(api.getApiKey({email:'a'})).projectId});
  assert.equal((await api.ensureApiKeyForAccount(pool.allAccounts[0],pool)).projectId,discovered);
  assert.equal(loads,1);
});
test('a late credential refresh cannot overwrite the synchronized real project',async t=>{
  const {Pool}=await fixture(t);const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));const old={...pool.allAccounts[0]};
  await pool.updateAccountQuota(old.id,{schemaVersion:2,projectId:discovered},'PRO',discovered);
  await pool.updateAccountCredentials(old.id,{...old,access:'new-token'});
  assert.equal(pool.allAccounts[0].projectId,discovered);assert.equal(pool.allAccounts[0].access,'new-token');
});
test('explicit project override is honored without changing stored binding',async t=>{
  const {api,Pool}=await fixture(t,metadataFetch,{ANTIGRAVITY_PROJECT_ID:'operator-project'});const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  const original=pool.allAccounts[0].projectId;
  const result=await api.fetchQuotaForAccount(pool.allAccounts[0],pool);
  assert.equal(result.projectId,'operator-project');assert.equal(pool.allAccounts[0].projectId,original);
  assert.equal((await api.ensureApiKeyForAccount(pool.allAccounts[0],pool)).projectId,'operator-project');
});
test('valid stored project is not replaced by an unverified legacy quota cache',async t=>{
  let calls=0;const {api,Pool}=await fixture(t,async()=>{calls++;return json({});});const pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  await pool.updateAccountQuota(pool.allAccounts[0].id,{schemaVersion:2,projectId:'unverified-cache'});
  assert.equal((await api.ensureApiKeyForAccount(pool.allAccounts[0],pool)).projectId,'test-project');assert.equal(calls,0);
});
