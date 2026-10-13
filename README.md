# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

English | [简体中文](./README.zh.md)

Google Antigravity / Cloud Code Assist model provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This plugin supports DSH Web and Desktop. It registers a DSH `LlmAdapter`
under provider route `antigravity`, stores OAuth credentials under DSH home,
talks to the Cloud Code Assist streaming API directly, and provides bilingual (English & Simplified Chinese) settings.

> v0.1.5 preserves Gemini tool schema references and adds conservative request handling, persistent cooldowns, private credential writes and one version source. Historical tool-call/result pairing from 0.1.4 is retained. See [CHANGELOG](./CHANGELOG.md).

> Unofficial integration. This project is not affiliated with or endorsed by
> Google. Use it only with accounts and services you are authorized to access.

## Install into DSH Web / Desktop

### Option 1: Direct from GitHub

```sh
dsh plugin --profile web add github:Lukeknow0/dsh-antigravity
dsh plugin --profile desktop add github:Lukeknow0/dsh-antigravity
```

### Option 2: From Local Release Tarball

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.1.5.tgz
dsh plugin --profile desktop add ./dist/dsh-antigravity-0.1.5.tgz
```

The package declares a DSH bundle patch, so installation automatically mounts
the host plugin and browser settings page.

If your DSH version does not support `dsh plugin add`, copy the package into
the Web profile manually:

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

Then add the plugin to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

Restart DSH:

```sh
dsh web
```

## Multi-Account Pool & Login

Open **Settings > Antigravity** to manage Google Antigravity accounts:

- **Healthy account selection**: Chooses an available account before a new request. Manual mode uses only the selected account; cooling or suspended accounts are excluded.
- **Stop on limits and denials**: A 429 pauses provider requests for the server-directed wait (60 seconds when none is supplied). The current request is not moved to another account or endpoint. A 401/403 suspends that account until you sign in again. Existing accepted in-flight work may finish; future attempts check the pause.
- **Backward Compatible**: Automatically migrates existing single `antigravity-oauth.json` into Account 1.
- **Frontend Image Generation Tool**: Integrates `antigravity_image_generate` to automatically generate web illustrations using `gemini-3.1-flash-image` into `./assets/images`.

Click **「＋ Add Google Account」** to append additional accounts into the pool.

Credentials are stored at:

```text
$DSH_HOME/storages/antigravity-pool-accounts.json
```

Keep that file private. It contains access and refresh tokens.

## Models

After login, select the **Antigravity** provider in DSH's model picker. Use the
model selector in **Settings > Antigravity** to enable or disable individual
models (enabled models are prioritized at the top of the list) — the live remaining quota percentage is shown next to each one.

Registered model IDs:

| Model ID | Name | Quota pool |
|---|---|---|
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) |

Models in the same quota pool share a weekly limit and a 5-hour limit. Quota is
consumed proportionally to token cost, so heavier models (e.g. Claude Opus)
drain the pool faster than lighter ones.

The plugin resolves these public IDs to runtime model IDs using the live
`fetchAvailableModels` catalog when available, with static routing fallbacks.

## Request policy and tool compatibility

Generation performs at most **two HTTP attempts** in total, with at least a one-second wait before a retry, respecting longer valid `Retry-After`/Google `RetryInfo` hints. Only transport failures and HTTP 500/502/503/504 can retry before a successful streaming response. Once a successful response starts, a broken/partial stream is returned as an error, never automatically replayed. A stable request ID is used, but upstream deduplication is not guaranteed. An explicit `ANTIGRAVITY_BASE_URL` pins the endpoint; no implicit sandbox fallback or model switch is used after a denial. Quota/model discovery is sequential and bounded.

Gemini receives intact `$defs`/`definitions`, local `$ref` and nested/composed schemas. Bad/local-missing/external/anchor references fail locally, without network fetching. Preflight is bounded (128 JSON nesting levels, 50,000 visited data units and 2 MiB across declarations) and is not a complete JSON Schema validator.

Claude/GPT-OSS use restricted Legacy declarations: basic types, properties, required, items, descriptions and string enums; local references are expanded. A nullable single type uses its non-null type as in the previous adapter. Unsupported constraints, unions, tuples and recursive structures fail **explicitly** rather than being silently removed. Complex MCP tool sets may require Gemini or disabling incompatible declarations in the host.

Credential files are atomically replaced with mode `0600` where supported; symlink destinations are refused. Ordinary request logs omit tokens, prompts, tool payloads and email addresses. The CLI sign-in link is deliberately displayed to the local user for authorization; keep redirected login output private. Local settings show emails to help identify accounts, but generation tool results use internal IDs.

**Scope:** these are reliability/privacy protections, not client-identity camouflage or a guarantee against account restrictions. Google can still associate requests with OAuth credentials. No authorization, region or quota restrictions are bypassed. Pause persistence survives restart; independent simultaneously running plugin hosts are not a distributed shared quota controller.

## Upgrade and rollback

Upgrade the profile actually used by your DSH host (Web and Desktop are separate installations), then restart/reload the plugin using your host's normal mechanism. Publishing GitHub does not update already-installed profiles.

If older files were patched in place, the code can be newer than the package's version label. 0.1.5 reads the package version for API status, diagnostics and traces; installing the complete release avoids mixed metadata. Keep your credential file private and backed up before installing. The [0.1.4 release](https://github.com/Lukeknow0/dsh-antigravity/releases/tag/v0.1.4) remains available for rollback; its older, less-conservative retry behavior will return.

Development checks run offline:

```sh
npm test
npm run check
npm run pack:dist
```

The release is fixture-tested, including text/image denials, reference schemas, cooldown persistence and storage. Production accounts and live Google model endpoints are not used by these tests; upstream compatibility may still change.

## License

MIT
