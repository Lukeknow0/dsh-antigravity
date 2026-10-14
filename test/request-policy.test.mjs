import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpFailure, waitForRetry } from '../lib/request-policy.js';

for (const status of [400, 401, 403, 404, 408, 409, 418]) {
  test(`${status} is never an endpoint-failover reason`, () => {
    const p = classifyHttpFailure(status, '{}', new Headers(), 1000);
    assert.equal(p.retryable, false);
    assert.equal(p.suspendAccount, status === 401 || status === 403);
  });
}
for (const status of [500, 502, 503, 504]) {
  test(`${status} permits one delayed pre-stream retry`, () => {
    const p = classifyHttpFailure(status, '{}', new Headers(), 1000);
    assert.equal(p.retryable, true);
    assert.equal(p.retryDelayMs, 1000);
  });
}
test('429 honors numeric Retry-After without a shorter fallback', () => {
  const p = classifyHttpFailure(429, '{}', new Headers({ 'Retry-After': '120' }), 1000);
  assert.equal(p.code, 'RATE_LIMIT');
  assert.equal(p.cooldownMs, 120000);
});
test('429 honors HTTP-date Retry-After', () => {
  const now = Date.UTC(2026, 9, 13, 10, 0, 0);
  const p = classifyHttpFailure(429, '{}', { 'rEtRy-AfTeR': new Date(now + 90000).toUTCString() }, now);
  assert.equal(p.cooldownMs, 90000);
});
test('uses the longest explicit RetryInfo and header, defaulting when neither is valid', () => {
  const text = JSON.stringify({error: {status: 'RESOURCE_EXHAUSTED', details: [
    {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '180.5s'},
  ]}});
  const p = classifyHttpFailure(429, text, new Headers({'Retry-After':'60'}), 1000);
  assert.equal(p.cooldownMs, 180500);
  assert.equal(classifyHttpFailure(429, '{}', {'Retry-After':'-1'}, 1000).cooldownMs, 15000);
  assert.equal(classifyHttpFailure(429, '{}', {'Retry-After':'nonsense'}, 1000).cooldownMs, 15000);
});
test('quota response without a wait permits one bounded retry', () => {
  const p = classifyHttpFailure(429, '{"error":{"message":"Individual quota reached"}}', new Headers());
  assert.equal(p.code, 'QUOTA_EXCEEDED');
  assert.equal(p.retryable, true);
  assert.equal(p.retryDelayMs, 2500);
});
test('server Retry-After applies to transient retry delay', () => {
  assert.equal(classifyHttpFailure(503, '{}', {'Retry-After':'5'}, 1000).retryDelayMs, 5000);
});
test('abort during backoff rejects immediately with its reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const pending = waitForRetry(60000, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});
test('already aborted signal never schedules work', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before wait'));
  await assert.rejects(waitForRetry(1000, controller.signal), /cancelled before wait/);
});
test('a short delay completes without leaving an abort listener', async () => {
  const signal = new AbortController().signal;
  let listeners = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { listeners++; return originalAdd(...args); };
  signal.removeEventListener = (...args) => { listeners--; return originalRemove(...args); };
  await waitForRetry(1, signal);
  assert.equal(listeners, 0);
});
