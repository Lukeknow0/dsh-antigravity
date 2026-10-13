# Antigravity 0.1.5 Safety and Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release 0.1.5 from the verified 0.1.4 baseline with intact tool schemas, bounded/respectful requests, persistent cooldowns, and private credential storage.

**Architecture:** Extract pure schema and HTTP policy modules; integrate both at the adapter boundary, then unify pool/security behavior. Keep OAuth protocol identity and DSH public interfaces unchanged. Tests use local fixtures only.

**Tech Stack:** JavaScript ESM, Node >=20, node:test, vm.SourceTextModule; existing DSH peer dependencies, no new runtime dependency.

## Global Constraints

- Base: `v0.1.4^{}` / `cb9797f417583c24b03e885fa452ee0f6ab27c6e`.
- Release version: `0.1.5`.
- No Google live model requests, identity camouflage, limit/region bypass, installed-profile edits, application restart, npm publishing, force push, or real credential logging.
- Generation requests: at most 2 HTTP attempts; 400/401/403/404/409/429 stop immediately.
- Successful response/started stream is never replayed on stream failure.
- Default retry delay >=1000ms, honor larger valid server hints; default 429 cooldown 60000ms, persist provider pause.
- Manual mode uses only selected account. Cooling/suspended accounts are never candidates.
- Files for concurrent workers are disjoint: schema worker owns only `lib/tool-schema.js` + `test/tool-schema.test.mjs`; policy worker owns only `lib/request-policy.js` + `test/request-policy.test.mjs`; lead owns integrations and other files.

---

### Task 1: Tool schema compiler

**Files:** Create `lib/tool-schema.js`, `test/tool-schema.test.mjs`; modify `lib/index.js` only at lead integration.

**Interfaces:** `convertToolDeclarations(tools, legacy = false)` -> declaration array; `ToolSchemaError` -> Error with code `INVALID_TOOL_SCHEMA`, toolName and pointer. Gemini declaration has `parametersJsonSchema`; Legacy has `parameters`.

- [ ] Add tests for intact `$defs`/`definitions` + `$ref`, nested anyOf arrays, keyword-named properties, input immutability, missing/external refs, native circular objects, budget limits, preserved Gemini recursive refs, expanded Legacy refs, nullable single type, rejected lossy Legacy constraints/unions.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToolDeclarations } from '../lib/tool-schema.js';
test('Gemini preserves address reference definitions', () => {
  const parameters = {type:'object', properties:{address:{$ref:'#/$defs/address'}},
    $defs:{address:{type:'string'}}, required:['address']};
  const before = JSON.stringify(parameters);
  const [tool] = convertToolDeclarations([{name:'inspect_address', parameters}]);
  assert.equal(tool.parametersJsonSchema.$defs.address.type, 'string');
  assert.equal(tool.parametersJsonSchema.properties.address.$ref, '#/$defs/address');
  assert.equal(JSON.stringify(parameters), before);
});
```

- [ ] Run `node --test test/tool-schema.test.mjs`, observe missing feature failure, implement the module with a schema-keyword-aware walk and pointer resolver, rerun until green. Use only own object keys; bounded traversal and no remote fetch.
- [ ] Lead replaces old conversion functions with:

```js
function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  try { return [{functionDeclarations: convertToolDeclarations(tools, useLegacyParameters)}]; }
  catch (error) {
    if (error.code !== 'INVALID_TOOL_SCHEMA') throw error;
    throw new LlmError(error.message, error.code, {cause:error});
  }
}
```

- [ ] Lead preflights at the start of adapter/request function before any OAuth/catalog fetch. Integration tests assert zero mock fetches for invalid schemas and unchanged input across Gemini/Legacy conversion.
- [ ] Commit the green compiler and integration.

### Task 2: Error classification and request state machine

**Files:** Create `lib/request-policy.js`, `test/request-policy.test.mjs`; modify `lib/index.js`, `test/transport.test.mjs`, `test/endpoint-tool-pairing.test.mjs`, create `test/request-safety.test.mjs`, modify `test/helpers.mjs`.

**Interfaces:** `classifyHttpFailure(status,text,headers,now=Date.now())` -> `{code,retryable,cooldownMs,suspendAccount,retryDelayMs}`; `waitForRetry(ms,signal)` -> cancelable Promise. Codes AUTH (401/403), RATE_LIMIT or QUOTA_EXCEEDED (429), INVALID_REQUEST (4xx), SERVER (5xx), TIMEOUT (408/504); only 500/502/503/504 retryable. Helper accepts Headers or a plain case-insensitive header bag. RetryInfo @type and numeric/HTTP-date Retry-After are validated, never shorten valid hints.

- [ ] Add pure classification/wait tests before the module. Example:

```js
test('permission denial is never retryable', () => {
  const p = classifyHttpFailure(403, '{"error":{"message":"denied"}}', new Headers(), 1000);
  assert.equal(p.retryable, false);
  assert.equal(p.suspendAccount, true);
});
test('429 preserves server wait', () => {
  const p = classifyHttpFailure(429, '{}', new Headers({'Retry-After':'120'}), 1000);
  assert.equal(p.cooldownMs, 120000);
  assert.equal(p.retryable, false);
});
```

- [ ] Run `node --test test/request-policy.test.mjs`, implement pure helpers, prove green.
- [ ] Lead changes generation to one runtime model, max 2 attempts total, endpoint pinning, success-response no-replay and terminal 4xx. Attach `status`, `cooldownMs`, `suspendAccount` to returned LlmError.

```js
const policy = classifyHttpFailure(response.status, text, response.headers);
const error = new LlmError(friendlyAntigravityError(response.status, text), policy.code);
Object.assign(error, {status:response.status, cooldownMs:policy.cooldownMs,
  suspendAccount:policy.suspendAccount, retryDelayMs:policy.retryDelayMs});
if (!policy.retryable) throw error;
```

- [ ] First write generation tests asserting one HTTP attempt for 403/429/400, at most two attempts for transient failures, no replay after an empty broken successful stream, explicit endpoint pinning, signal cancellation during delay.
- [ ] Update old intentional 429-fallback tests to stop-and-wait expectations; preserve signature/tool-pairing tests with a nonterminal transport retry. Fixture may scale timers for deterministic test speed but must exercise the actual policy/abort path.
- [ ] Unify image generation via the same request iterator/policy so it cannot independently rotate accounts or ignore status handling. Add image tests for 403/429, successful inline bytes and interrupted streams.
- [ ] Make project/model/quota metadata sequential, max 2 attempts; 401/403/429 throw instead of continuing or silently using fallback. Remove sandbox from default candidates. Avoid broad catch blocks swallowing definitive errors. Add mock metadata refusal tests.
- [ ] Coalesce token refresh promises by pool/account and runtime/project discovery promises by credential key; release each in-flight entry in finally. Add concurrent refresh tests.
- [ ] Run focused and full tests; commit the green request integration.

### Task 3: Durable pool pauses and credential protection

**Files:** Modify `lib/pool.js`, `lib/index.js`; create `lib/security.js`, `test/security.test.mjs`, `test/pool-safety.test.mjs`; update the old cooldown regression.

**Interfaces:** `redactSecrets(value)` -> string; `writePrivateJson(file,payload)` -> Promise<void>; pool `pauseRequests(durationMs)` and `suspendAccount(id, reason)` -> persisted mutations; status exposes `requestPauseRemainingMs`, `suspended` without secrets.

- [ ] Write failing tests excluding cooling/suspended accounts, truly manual selection, provider pause across a new Pool instance, no 429 account rotation, and relogin preserving provider pause. Existing pool states stay readable.

```js
test('cooling accounts are not a last-resort fallback', async t => {
  const {Pool} = await fixture(t);
  const pool = new Pool();
  await pool.addOrUpdateAccount(credential('primary'));
  await pool.markCooldown(pool.allAccounts[0].id, 60000);
  assert.equal((await pool.getCandidateAccounts()).length, 0);
});
```

- [ ] Implement available-only candidates, provider-level `requestBlockedUntil`, account permission suspension; never clear limit pause through a quota refresh or login. Preserve the longest pause on concurrent writes. Lead adapter handles only its initially chosen account, records 429 pause even with one account, and records AUTH suspension without automatic replacement.
- [ ] Write storage tests for exclusive random temp files, permissions 0600, rejecting symlink destinations, cleanup after errors, JSON integrity under queued modifications; write redaction tests for access/refresh/authorization, internal access/refresh field names, emails and URL query secrets.
- [ ] Implement private atomic storage using node:fs/promises. Verify target type via lstat, create temp via `open(...,'wx',0o600)`, write/close/rename, enforce mode, delete only the owned verified temporary path on error. Don't follow user-controlled links.
- [ ] Replace both credential writers and all pool errors/logs with shared storage/redaction. Keep normal request logs structured and omit email/token/request/response content. Extend fixture console capture for tests.
- [ ] Run `node --experimental-vm-modules --test test/security.test.mjs test/pool-safety.test.mjs test/request-safety.test.mjs` and full suite; commit.

### Task 4: Version and truthful product presentation

**Files:** Modify `package.json`, `lib/index.js`, `lib/client.js`, `README.md`, `README.zh.md`, `test/quota-ui.test.mjs`; create `.github/workflows/test.yml`, `CHANGELOG.md`, `test/release.test.mjs`.

- [ ] Add test requiring status/diagnostic version to match package version and confirming no obsolete instant-429-failover promise.
- [ ] Read package version once with node:fs; use the exported PLUGIN_VERSION for status/trace. Bump package to 0.1.5; check syntax for every module through a wildcard command.
- [ ] Display provider pause and suspended account state; rewrite descriptions in both locales to explain pre-request account selection, pinned manual mode, cooldown respect and non-official integration risks.
- [ ] Document conservative behavior changes, Schema/Legacy boundaries, version mismatch explanation and rollback to 0.1.4. No promises of invisibility or anti-ban behavior.
- [ ] Add GitHub Actions Node 20/22/24 matrix using `npm test` + `npm run check`; tests require no dependency installation or Google credentials.
- [ ] Run full suite, checks and `npm pack --dry-run --json`; test packed package contains new runtime modules and never contains credential paths, local diagnostics, tests' temp homes or secret logs.

### Task 5: Review and GitHub delivery

- [ ] Request independent read-only review against the design for functional regressions, request amplification, secret handling and identity/limit bypass. Fix confirmed findings with failing tests first.
- [ ] Run `npm test && npm run check && npm run pack:dist`; record package SHA-256 and verify tar entries/version.
- [ ] Commit explicit changed files only. Fetch origin, confirm no concurrent main changes, fast-forward main (no forced history) and push to `origin main`.
- [ ] Create annotated v0.1.5 tag; push tag and create GitHub release attaching `dist/dsh-antigravity-0.1.5.tgz` with factual release notes and offline-only verification limits.
- [ ] Verify GitHub remote main/tag commit and release asset identity. If authorization/network fails, retain complete local artifacts and report the precise blocker, do not claim uploaded.
- [ ] Keep installed Web/Desktop 0.1.3-labelled copies untouched; tell user how to explicitly upgrade afterward. Mark the persisted goal complete only after requested upload is verified.
