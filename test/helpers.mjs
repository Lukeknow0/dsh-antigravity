import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function fixture(t, fetchImpl, env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'antigravity-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let callback;
  const logs = [];
  const scheduledTimers = [];
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, TextDecoder, Uint8Array, AbortController, Symbol,
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: () => AbortSignal.timeout(20) },
    setTimeout(fn, ms, ...args) {
      scheduledTimers.push(ms);
      return setTimeout(fn, ms >= 1000 && ms < 30000 ? 1 : ms, ...args);
    }, clearTimeout,
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({level, args})])),
    process: { env, platform: process.platform },
    fetch: (...args) => fetchImpl(...args),
  });
  const cache = new Map();
  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    let mod;
    if (id.startsWith('file:')) {
      mod = new vm.SourceTextModule(await readFile(new URL(id), 'utf8'), {
        context, identifier: id, initializeImportMeta(meta) { meta.url = id; },
      });
      cache.set(id, mod);
      await mod.link((specifier, parent) => load(specifier.startsWith('.') ? new URL(specifier, parent.identifier).href : specifier));
    } else {
      let exports;
      if (id === '@deepseek-ai/dsh-home-paths') exports = { dshHomePath: (...parts) => join(home, ...parts) };
      else if (id === '@deepseek-ai/dsh-llm') exports = {
        LlmAdapter: class {}, LlmError: class extends Error { constructor(message, code, options) { super(message, options); this.code = code; } },
        ToolCallId: x => x, ReasoningEffortId: x => x, attributionHeaders: () => ({}), contentHasImage: () => false,
        isContextWindowExceededError: () => false, isQuotaExceededError: e => e.code === 'QUOTA_EXCEEDED',
        CONTEXT_WINDOW_EXCEEDED_CODE: 'CONTEXT', EMPTY_RESPONSE_CODE: 'EMPTY', QUOTA_EXCEEDED_CODE: 'QUOTA_EXCEEDED',
      };
      else if (id === '@deepseek-ai/dsh-timeout') exports = {
        // Integration tests exercise adapter ownership/cancellation, not the
        // peer package's own idle-timer implementation.
        idleWatchdog(signal) { return { signal, next(iterator) { return iterator.next(); }, [Symbol.dispose]() {} }; },
        timeoutOf() {},
      };
      else if (id === 'node:http') exports = { createServer(handler) {
        callback = handler;
        return { on() {}, listen(port, host, ready) { queueMicrotask(ready); }, close() {} };
      } };
      else exports = await import(id);
      mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: id });
      cache.set(id, mod);
    }
    return mod;
  }
  const mod = await load(new URL('../lib/index.js', import.meta.url).href);
  await mod.evaluate();
  const poolMod = cache.get(new URL('../lib/pool.js', import.meta.url).href);
  return { api: mod.namespace, Pool: poolMod.namespace.AccountPoolManager, home, logs, scheduledTimers,
    interaction: { notify({ url }) {
      const state = new URL(url).searchParams.get('state');
      callback({ method: 'GET', url: '/oauth-callback?code=test&state=' + state }, { writeHead() {}, end() {} });
    } },
  };
}

export const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
export const credential = email => ({ email, refresh: 'test-refresh', access: email, expires: Date.now() + 3600000, projectId: 'test-project' });
export const quota = (fraction, weekly = fraction) => ({ groups: [{ displayName: 'Gemini', buckets: [
  { displayName: '5 hour', remainingFraction: fraction }, { displayName: 'Weekly', remainingFraction: weekly },
] }] });
