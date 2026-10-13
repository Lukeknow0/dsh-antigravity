import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './helpers.mjs';

const model = { id: 'gemini-3.8-flash-tiered', inputModalities: ['text'], maxTokens: 128 };
const tokens = { token: 'mock', projectId: 'mock' };
const text = value => ({ type: 'text', text: value });
const call = (id, name) => ({ type: 'tool-call', id, name, arguments: {} });
const result = (id, name) => ({ type: 'tool-result', toolCallId: id, content: [text(`${name} output`)] });
const complete = () => new Response('data: ' + JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
}) + '\n\n');
const failure = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });

async function stream(api, messages) {
  const chunks = [];
  for await (const chunk of api.requestAntigravityChunksWithAccount({ messages, maxTokens: 32 }, model, undefined, tokens)) chunks.push(chunk);
  return chunks;
}

test('429 on primary stops instead of trying a different endpoint', async t => {
  const hosts = [];
  const { api } = await fixture(t, async url => {
    if (!url.includes('streamGenerateContent')) return json({});
    const host = new URL(url).host;
    hosts.push(host);
    return host === 'cloudcode-pa.googleapis.com'
      ? failure(429, 'Resource has been exhausted') : complete();
  });
  await assert.rejects(() => stream(api, [{ role: 'user', content: [text('hello')] }]), error => error.code === 'RATE_LIMIT');
  assert.deepEqual(hosts, ['cloudcode-pa.googleapis.com']);
});

test('quota errors do not cause requests to sandbox endpoints', async t => {
  const hosts = [];
  const { api } = await fixture(t, async url => {
    if (!url.includes('streamGenerateContent')) return json({});
    const host = new URL(url).host;
    hosts.push(host);
    return host.includes('sandbox.googleapis.com')
      ? failure(400, 'User location is not supported for the API use')
      : failure(429, 'Resource has been exhausted');
  });
  await assert.rejects(() => stream(api, [{ role: 'user', content: [text('hello')] }]),
    error => error.code === 'RATE_LIMIT' && /429/.test(error.message));
  assert.equal(hosts.filter(host => host.includes('sandbox.googleapis.com')).length, 0);
  assert.equal(hosts.length, 1);
});

test('missing tool result is explicitly marked before later user text', async t => {
  let body;
  const { api } = await fixture(t, async (url, init) => {
    if (!url.includes('streamGenerateContent')) return json({});
    body = JSON.parse(init.body);
    return complete();
  });
  await stream(api, [
    { role: 'assistant', content: [call('c1', 'read')] },
    { role: 'user', content: [text('next question')] },
  ]);
  const contents = body.request.contents;
  assert.equal(contents[0].parts[0].functionCall.name, 'read');
  assert.match(contents[1].parts[0].functionResponse.response.error, /unavailable/);
  assert.equal(contents[2].parts[0].text, 'next question');
});

test('multiple tool results are paired in call order before adjacent user text', async t => {
  let body;
  const { api } = await fixture(t, async (url, init) => {
    if (!url.includes('streamGenerateContent')) return json({});
    body = JSON.parse(init.body);
    return complete();
  });
  await stream(api, [
    { role: 'assistant', content: [call('c1', 'alpha'), call('c2', 'beta')] },
    { role: 'user', content: [text('note'), result('c2', 'beta')] },
    { role: 'user', content: [result('c1', 'alpha')] },
  ]);
  const contents = body.request.contents;
  assert.deepEqual(Array.from(contents[1].parts, part => part.functionResponse.name), ['alpha', 'beta']);
  assert.deepEqual(Array.from(contents[1].parts, part => part.functionResponse.response.output), ['alpha output', 'beta output']);
  assert.equal(contents[2].parts[0].text, 'note');
});

test('orphan tool result is retained as context without an invalid function response', async t => {
  let body;
  const { api } = await fixture(t, async (url, init) => {
    if (!url.includes('streamGenerateContent')) return json({});
    body = JSON.parse(init.body);
    return complete();
  });
  await stream(api, [{ role: 'user', content: [result('missing', 'read')] }]);
  assert.match(body.request.contents[0].parts[0].text, /Earlier tool result/);
  assert.equal(body.request.contents[0].parts[0].functionResponse, undefined);
});
