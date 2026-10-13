import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, credential } from './helpers.mjs';

const model = {id:'gemini-3-flash', inputModalities:['text'], maxTokens:128};
const options = {messages:[{role:'user',content:[{type:'text',text:'hello'}]}]};
const tokens = {token:'mock',projectId:'test'};
const complete = () => new Response('data: ' + JSON.stringify({candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]})+'\n\n');
async function consume(api, signal, opts = options) {
  for await (const chunk of api.requestAntigravityChunksWithAccount(opts,model,signal,tokens)) {}
}
for (const status of [400,401,403,404,429]) {
  test(`${status} stops generation without trying other endpoints`,async t => {
    const hosts=[];
    const {api}=await fixture(t,async url=>{
      if(!url.includes('streamGenerateContent'))return json({});
      hosts.push(new URL(url).host);
      return new Response('{"error":{"message":"denied or limited"}}',{status,headers:{'Retry-After':'120'}});
    });
    await assert.rejects(consume(api), e=>e.status===status);
    assert.equal(hosts.length,1);
  });
}
test('transient generation failures share one total retry budget',async t=>{
  let attempts=0;
  const {api,scheduledTimers}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    attempts++;
    return new Response('{"error":{"message":"temporarily unavailable"}}',{status:503});
  });
  await assert.rejects(consume(api),e=>e.code==='SERVER');
  assert.equal(attempts,2);
  assert.ok(scheduledTimers.includes(1000));
});
test('successful HTTP response with an empty broken stream is not replayed',async t=>{
  let attempts=0;
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    attempts++;
    return new Response(new ReadableStream({start(c){c.error(new TypeError('network stream failed'));}}));
  });
  await assert.rejects(consume(api));
  assert.equal(attempts,1);
});
test('an explicit base URL pins all generation attempts to that endpoint',async t=>{
  const hosts=[];
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    hosts.push(new URL(url).host);
    if(hosts.length===1)throw new TypeError('fetch failed');
    return complete();
  },{ANTIGRAVITY_BASE_URL:'https://daily-cloudcode-pa.googleapis.com'});
  await consume(api);
  assert.deepEqual(hosts,['daily-cloudcode-pa.googleapis.com','daily-cloudcode-pa.googleapis.com']);
});
test('local schema preflight runs before any metadata fetch',async t=>{
  let requests=0;
  const {api}=await fixture(t,async()=>{requests++;return json({});});
  await assert.rejects(consume(api,undefined,{...options,tools:[{name:'broken',parameters:{type:'object',properties:{address:{$ref:'#/$defs/missing'}}}}]}),e=>e.code==='INVALID_TOOL_SCHEMA');
  assert.equal(requests,0);
});
test('Gemini tool definitions survive request serialization without mutation',async t=>{
  let body;
  const {api}=await fixture(t,async(url,init)=>{
    if(!url.includes('streamGenerateContent'))return json({});
    body=JSON.parse(init.body);return complete();
  });
  const parameters={type:'object',properties:{address:{$ref:'#/$defs/address'}},$defs:{address:{type:'string'}}};
  const saved=JSON.stringify(parameters);
  await consume(api,undefined,{...options,tools:[{name:'inspect_address',parameters}]});
  assert.equal(body.request.tools[0].functionDeclarations[0].parametersJsonSchema.$defs.address.type,'string');
  assert.equal(JSON.stringify(parameters),saved);
});
test('caller cancellation returns immediately while shared discovery is pending',async t=>{
  let release, ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const metadata=new Promise(resolve=>{release=resolve;});
  const {api}=await fixture(t,async()=>{ready();return metadata;});
  const controller=new AbortController();
  let settled=false, failure;
  const pending=consume(api,controller.signal).catch(error=>{settled=true;failure=error;});
  try {
    await started;controller.abort();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,true);
    assert.equal(failure.code,'ABORTED');
  } finally {release(json({}));await pending;}
});
test('SSE quota errors preserve status and server wait information',async t=>{
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    return new Response('data: '+JSON.stringify({response:{error:{code:429,message:'quota exceeded',details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'180s'}]}}})+'\n\n');
  });
  await assert.rejects(consume(api),e=>e.status===429 && e.cooldownMs===180000);
});
test('a new provider pause stops an already scheduled generation retry',async t=>{
  let attempts=0;let pool;
  const {api,Pool}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    attempts++;await pool.pauseRequests(60000);
    return new Response('{"error":{"message":"temporary"}}',{status:503});
  });
  pool=new Pool();await pool.addOrUpdateAccount(credential('a'));
  const adapter=new api.AntigravityPoolAdapter(pool);
  await assert.rejects(async()=>{for await(const chunk of adapter.stream({...options,model:'gemini-3-flash'})){}},e=>e.code==='RATE_LIMIT');
  assert.equal(attempts,1);
});
for(const status of [401,403,429]){
  test(`quota metadata stops on ${status} instead of endpoint fanout`,async t=>{
    const methods=[];
    const {api,Pool}=await fixture(t,async url=>{
      const method=new URL(url).pathname;methods.push(method);
      return new Response('{"error":{"message":"denied"}}',{status,headers:{'Retry-After':'120'}});
    });
    const pool=new Pool();await pool.addOrUpdateAccount(credential('test'));
    await assert.rejects(api.fetchQuotaForAccount(pool.allAccounts[0],pool),e=>e.status===status);
    assert.equal(methods.length,1);
  });
}
