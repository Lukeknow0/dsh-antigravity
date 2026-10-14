# Changelog

## 0.1.7 — 2026-10-14

- Removed all provider-wide pause state/calls. A chat 429 cools only the current account; other healthy accounts remain selectable. Existing account cooldowns are preserved.
- For any HTTP 429, a server wait above 30 seconds stops immediately. A shorter positive wait or no wait permits exactly one retry on the same account and endpoint, after the stated wait or 2500ms respectively. Default account cooldown is 15000ms.
- Quota-query 429 only records quotaError; it never cools chat requests or prevents the batch from refreshing other accounts.
- No automatic cross-account replay. Successful generation streams are never replayed, including failures before the first visible output.

## 0.1.6 — 2026-10-14

- Synchronize the real server-discovered project into the account record in the same queued save as quota metadata. Generation and quota/catalog lookup no longer retain different project bindings.
- Repair a missing or legacy generated fallback project from explicitly authoritative cached metadata or project discovery before generating; do not trust unmarked legacy quota project IDs or overwrite an explicit environment override.
- Prevent delayed credential refresh snapshots from overwriting a newer project binding. Access/refresh token updates and cooldowns retain their existing behavior.
- This is a narrow binding fix: no changes to endpoint selection, 429 handling, account rotation, or model permissions. It does not establish that every 429 has this cause.

## 0.1.5 — 2026-10-13

### Fixed
- Preserve Gemini JSON Schema definitions, local references and composed/nested schemas. Preflight invalid references before OAuth/catalog requests; never mutate shared tool definitions.
- Bound schema cloning and Legacy reference expansion; accept plain objects across execution realms; distinguish schema keywords from user property names.
- Use package metadata as the single version source for status, diagnostics and request traces.
- Coalesce concurrent token/project/model lookups with active-consumer ownership: cancel orphaned work, retain work for other callers, and preserve account cooldowns when credentials refresh.
- Preserve terminal HTTP status and Retry-After even when the error response body is unreadable; a body reset cannot turn 401/403/429 into an endpoint retry.

### Safety-oriented behavior changes
- A generation request has at most two pre-stream HTTP attempts, with delayed retries only for transport failures or HTTP 500/502/503/504. A successful HTTP response is never replayed after a stream failure.
- HTTP 400/401/403/404/408/409/429 stop the current request. 401/403 suspend the affected account until reauthorization. 429 persists an account cooldown and provider-wide pause; no automatic account/model/endpoint replacement on rejection.
- Honor valid Retry-After and Google RetryInfo; default 429 wait is 60 seconds. Long transient server waits are reported instead of shortened.
- Explicit base URL stays pinned. Default requests no longer use sandbox endpoints. Metadata discovery and manual quota refreshes are sequential and respect terminal responses.
- Manual mode selects only the specified account. Cooling or suspended accounts are never returned as last-resort candidates.
- Text and image generation share the request policy. Image output uses an internal account ID rather than an email address.
- Write credential JSON atomically through private, exclusive temporary files; refuse symlink destinations and redact ordinary logs/public errors.

### Compatibility notes
- Gemini keeps complete JSON Schema declarations within the local budget. External/anchor references and unsupported dynamic reference semantics are not fetched or silently resolved; local preflight is not a complete JSON Schema meta-validator.
- Claude/GPT-OSS use the restricted Legacy `parameters` format. Supported local references are expanded. String enums and nullable single types are supported; unrepresentable validation constraints/unions/recursive structures fail locally instead of being silently erased. Complex tool sets may therefore require Gemini or reducing unsupported declarations.
- Provider pause state is persisted for restart recovery and managed by each plugin instance; this is not distributed coordination across multiple independent running hosts.
- This is an unofficial integration, not an identity-hiding or anti-ban feature. OAuth/account visibility and upstream policy enforcement remain unchanged.

### Verification
- Offline automated tests cover schema conversion, stop-on-denial behavior, cooldown persistence, cancellation, stream failures, OAuth refresh, storage and settings state. CI targets Node 20/22/24.
- Release development did not use production Google accounts or live model requests. Passing fixtures does not establish compatibility with every future upstream version.

## 0.1.4
- Improved endpoint failover and historical tool-call/result pairing; unavailable results are not fabricated as successful.
- The 0.1.4 tag and release remain available for rollback. Its broader retry/failover policy is intentionally changed in 0.1.5.
