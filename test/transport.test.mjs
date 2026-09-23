import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './helpers.mjs';
const model = { id: 'gemini-3-flash', inputModalities: ['text'], maxTokens: 128 };
const options = { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] };
const tokens = { token: 'mock', projectId: 'mock' };
const sse = data => 'data: ' + JSON.stringify(data) + '\n\n';
const complete = () => new Response(sse({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }));
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('TLS disconnected'), { code: 'ECONNRESET' }) });

test('connect failure tries another endpoint before yielding, with stable requestId', async t => {
  const calls=[];
  const {api}=await fixture(t,async(url,init)=>{
    if(!url.includes('streamGenerateContent'))return json({});
    calls.push({url, body:JSON.parse(init.body)});
    if(calls.length===1)throw reset();
    return complete();
  });
  const chunks=[];
  for await(const c of api.requestAntigravityChunksWithAccount(options,model,undefined,tokens))chunks.push(c);
  assert.equal(calls.length,2);
  assert.notEqual(calls[0].url,calls[1].url);
  assert.equal(calls[0].body.requestId,calls[1].body.requestId);
  assert.equal(chunks.filter(c=>c.type==='text-delta').length,1);
});

test('network failures surface TRANSPORT with cause code rather than UNKNOWN',async t=>{
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    throw reset();
  });
  await assert.rejects(async()=>{for await(const c of api.requestAntigravityChunksWithAccount(options,model,undefined,tokens)){}}, e=>e.code==='TRANSPORT' && /ECONNRESET/.test(e.message));
});

test('after a tool-call is yielded, broken stream is never replayed',async t=>{
  let calls=0;
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    calls++;
    let step=0;
    return new Response(new ReadableStream({pull(controller){
      if(step++===0)controller.enqueue(new TextEncoder().encode(sse({candidates:[{content:{parts:[{functionCall:{name:'read',args:{path:'fixture'}}}]}}]})));
      else controller.error(reset());
    }}));
  });
  let toolEnds=0;
  await assert.rejects(async()=>{for await(const c of api.requestAntigravityChunksWithAccount(options,model,undefined,tokens))if(c.type==='block-end'&&c.block.type==='tool-call')toolEnds++;},e=>e.code==='TRANSPORT');
  assert.equal(calls,1);
  assert.equal(toolEnds,1);
});

test('caller abort is not retried or reported as a network error',async t=>{
  const controller=new AbortController();controller.abort();
  let calls=0;
  const {api}=await fixture(t,async url=>{if(url.includes('streamGenerateContent'))calls++;return json({});});
  await assert.rejects(async()=>{for await(const c of api.requestAntigravityChunksWithAccount(options,model,controller.signal,tokens)){}},e=>e.code==='ABORTED');
  assert.equal(calls,0);
});

test('configured endpoint still retains fallback endpoints', async t => {
  const calls=[];
  const {api}=await fixture(t,async(url)=>{
    if(!url.includes('streamGenerateContent'))return json({});
    calls.push(url);
    if(calls.length===1)throw reset();
    return complete();
  },{ANTIGRAVITY_BASE_URL:'https://daily-cloudcode-pa.googleapis.com'});
  for await(const c of api.requestAntigravityChunksWithAccount(options,model,undefined,tokens)){}
  assert.ok(calls[0].startsWith('https://daily-cloudcode-pa.googleapis.com/'));
  assert.ok(calls[1].startsWith('https://cloudcode-pa.googleapis.com/'));
});

test('tool result and signature survive an endpoint retry without another tool call', async t=>{
  const bodies=[];
  const next={messages:[...options.messages,
    {role:'assistant',content:[{type:'tool-call',id:'call_1',name:'read',arguments:'{"path":"fixture"}'}],
      source:{kind:'model',model:'gemini-3-flash',replayState:{kind:'antigravity',version:1,provider:'antigravity',model:'gemini-3-flash',blocks:[{type:'tool-call',thoughtSignature:'test-signature'}]}}},
    {role:'user',content:[{type:'tool-result',toolCallId:'call_1',content:[{type:'text',text:'42'}]}]},
  ]};
  const {api}=await fixture(t,async(url,init)=>{
    if(!url.includes('streamGenerateContent'))return json({});
    bodies.push(JSON.parse(init.body));
    if(bodies.length===1)throw reset();
    return complete();
  });
  const chunks=[];
  for await(const c of api.requestAntigravityChunksWithAccount(next,model,undefined,tokens))chunks.push(c);
  assert.deepEqual(bodies[0],bodies[1]);
  const contents=bodies[1].request.contents;
  assert.equal(contents[1].parts[0].thought_signature,'test-signature');
  assert.equal(contents[2].parts[0].functionResponse.name,'read');
  assert.equal(contents[2].parts[0].functionResponse.response.output,'42');
  assert.equal(chunks.filter(c=>c.type==='tool-call-delta').length,0);
});

test('truncated text stream is not reported as successful and is not replayed', async t=>{
  let calls=0;
  const {api}=await fixture(t,async url=>{
    if(!url.includes('streamGenerateContent'))return json({});
    calls++;return new Response(sse({candidates:[{content:{parts:[{text:'partial'}]}}]}));
  });
  const chunks=[];
  await assert.rejects(async()=>{for await(const c of api.requestAntigravityChunksWithAccount(options,model,undefined,tokens))chunks.push(c);},e=>e.code==='TRANSPORT');
  assert.equal(calls,1);
  assert.equal(chunks.filter(c=>c.type==='finish').length,0);
});
