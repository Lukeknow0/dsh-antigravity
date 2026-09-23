import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, credential, quota, json } from './helpers.mjs';

const oauthFetch = async url => {
  if (url.includes('/token')) return json({ refresh_token: 'test-refresh', access_token: 'test-access', expires_in: 3600 });
  if (url.includes('userinfo')) return json({ email: 'login@example.test' });
  return json({ cloudaicompanionProject: 'test-project' });
};

test('CLI login persists credentials to the pool', async t => {
  const { api, Pool, interaction } = await fixture(t, oauthFetch);
  const pool = new Pool();
  await api.loginAndSave(pool, interaction);
  assert.equal((await pool.getStatus()).accounts[0].email, 'login@example.test');
});

test('legacy loginAndSave callers still save to their supplied store', async t => {
  const { api, interaction } = await fixture(t, oauthFetch);
  const store = new api.FileCredentialStore();
  await api.loginAndSave(store, interaction);
  assert.equal((await store.read()).email, 'login@example.test');
});

test('quota and cooldown writes do not collide or lose final state', async t => {
  const { Pool, home } = await fixture(t);
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  await pool.addOrUpdateAccount(credential('b'));
  const [a, b] = pool.allAccounts;
  await Promise.all(Array.from({ length: 20 }, (_, i) => pool.updateAccountQuota(i % 2 ? a.id : b.id, quota(i / 20))));
  await Promise.all([pool.markCooldown(a.id), pool.clearCooldown(b.id), pool.updateConfig({ schedulingMode: 'auto' })]);
  const stored = JSON.parse(await readFile(join(home, 'storages/antigravity-pool-accounts.json'), 'utf8'));
  assert.equal(stored.accounts[0].quota.groups[0].buckets[0].remainingFraction, 0.95);
  assert.ok(stored.accounts[0].cooldownUntil > Date.now());
  assert.equal(stored.accounts[1].cooldownUntil, 0);
});

test('auto scheduling uses actual quota buckets including weekly exhaustion', async t => {
  const { Pool } = await fixture(t);
  const pool = new Pool();
  for (const email of ['empty', 'weekly-empty', 'healthy']) await pool.addOrUpdateAccount(credential(email));
  for (const [i, acc] of pool.allAccounts.entries()) await pool.updateAccountQuota(acc.id, [quota(0), quota(1, 0), quota(0.9)][i]);
  assert.equal((await pool.getCandidateAccounts())[0].email, 'healthy');
});

test('primary in cooldown appears only once after healthy backup', async t => {
  const { Pool } = await fixture(t);
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('primary'));
  await pool.addOrUpdateAccount(credential('backup'));
  await pool.updateConfig({ schedulingMode: 'primary-backup' });
  await pool.markCooldown(pool.allAccounts[0].id);
  assert.deepEqual(Array.from(await pool.getCandidateAccounts(), a => a.email), ['backup', 'primary']);
});

test('refresh preserves dynamically discovered models from other accounts and user selection', async t => {
  const { api, Pool } = await fixture(t, async (url, options) => {
    if (url.includes('fetchAvailableModels')) return json({ models: options.headers.Authorization?.includes('a-account')
      ? { 'gemini-9-alpha': {} } : { 'gemini-9-beta': {} } });
    return json({});
  });
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a-account'));
  await pool.addOrUpdateAccount(credential('b-account'));
  const settings = new api.FileModelSettingsStore();
  await api.fetchQuotaForAccount(pool.allAccounts[0], pool, settings);
  await settings.setEnabledModelIds(['gemini-9-alpha']);
  await api.fetchQuotaForAccount(pool.allAccounts[1], pool, settings);
  const saved = await settings.read();
  assert.ok(saved.catalogModels.some(m => m.id === 'gemini-9-alpha'));
  assert.ok(saved.catalogModels.some(m => m.id === 'gemini-9-beta'));
  assert.deepEqual(Array.from(saved.enabledModelIds), ['gemini-9-alpha']);
});

test('quota discovery requests and token refresh have bounded network waits', async t => {
  const requests = [];
  const { api, Pool } = await fixture(t, async (url, options) => {
    requests.push({ url, signal: options.signal });
    if (url.includes('/token')) return json({ access_token: 'new', expires_in: 3600 });
    if (url.includes('fetchAvailableModels')) return json({ models: {} });
    return json({});
  });
  const pool = new Pool();
  await pool.addOrUpdateAccount({ ...credential('a'), expires: 1 });
  await api.fetchQuotaForAccount(pool.allAccounts[0], pool, new api.FileModelSettingsStore());
  assert.ok(requests.length >= 4);
  for (const req of requests) assert.ok(req.signal, `Missing timeout: ${req.url}`);
});

test('a stalled quota endpoint exits on timeout instead of leaving refresh pending', async t => {
  const { api, Pool } = await fixture(t, async (url, options) => {
    if (!url.includes('retrieveUserQuotaSummary')) return json({});
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  let timer;
  try {
    await Promise.race([
      assert.rejects(api.fetchQuotaForAccount(pool.allAccounts[0], pool), /retrieveUserQuotaSummary failed/),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quota refresh stayed pending')), 500); }),
    ]);
  } finally { clearTimeout(timer); }
});

test('parallel quota refreshes retain both account catalogs and disabled models stay disabled', async t => {
  const { api, Pool } = await fixture(t, async (url, options) => {
    if (url.includes('fetchAvailableModels')) return json({ models: options.headers.Authorization.includes('a-account')
      ? { 'gemini-9-alpha': {} } : { 'gemini-9-beta': {} } });
    return json({});
  });
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a-account'));
  await pool.addOrUpdateAccount(credential('b-account'));
  const settings = new api.FileModelSettingsStore();
  await settings.setEnabledModelIds([]);
  await Promise.all(pool.allAccounts.map(acc => api.fetchQuotaForAccount(acc, pool, settings)));
  const saved = await settings.read();
  assert.ok(saved.catalogModels.some(m => m.id === 'gemini-9-alpha'));
  assert.ok(saved.catalogModels.some(m => m.id === 'gemini-9-beta'));
  assert.equal(saved.enabledModelIds.length, 0);
});

test('missing quota is unknown while explicit zero is preserved', async t => {
  const { api, Pool } = await fixture(t, async url => json(url.includes('retrieveUserQuotaSummary') ? {
    groups: [{ displayName: 'Claude and GPT models', buckets: [
      { bucketId: 'weekly', displayName: 'Weekly', remainingFraction: 0.395 },
      { bucketId: 'five-hour', displayName: 'Five Hour' },
      { bucketId: 'zero', displayName: 'Zero', remainingFraction: 0 },
    ] }],
  } : { models: {} }));
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  const result = await api.fetchQuotaForAccount(pool.allAccounts[0], pool);
  const buckets = result.groups[0].buckets;
  assert.equal(buckets[0].remainingFraction, 0.395);
  assert.equal(buckets[1].remainingFraction, null);
  assert.equal(buckets[2].remainingFraction, 0);
});

test('refresh failure is visible per account and keeps last successful timestamp', async t => {
  let fail = false;
  const { api, Pool } = await fixture(t, async url => {
    if (fail) throw new Error('upstream unavailable');
    return json(url.includes('retrieveUserQuotaSummary') ? quota(0.8) : { models: {} });
  });
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  const account = pool.allAccounts[0];
  const first = await api.fetchQuotaForAccount(account, pool);
  fail = true;
  await assert.rejects(api.fetchQuotaForAccount(account, pool));
  const failed = (await pool.getStatus()).accounts[0];
  assert.match(failed.quotaError, /upstream unavailable/);
  assert.equal(failed.quota.fetchedAt, first.fetchedAt);
  assert.equal(failed.quotaStale, true);
  fail = false;
  await api.fetchQuotaForAccount(account, pool);
  assert.equal((await pool.getStatus()).accounts[0].quotaError, null);
});

test('old cached zeros are not asserted as measured zeros after upgrade', async t => {
  const { Pool } = await fixture(t);
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('a'));
  await pool.updateAccountQuota(pool.allAccounts[0].id, { ...quota(0), fetchedAt: Date.now() });
  const account = (await pool.getStatus()).accounts[0];
  assert.equal(account.quota.groups[0].buckets[0].remainingFraction, null);
  assert.equal(account.quotaStale, true);
});
