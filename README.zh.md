# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Google Antigravity / Cloud Code Assist 模型提供商插件。

这是一个适用于 DSH Web 和 Desktop 的插件。它在 provider 路由 `antigravity` 下注册 DSH `LlmAdapter`，OAuth 凭证存储于 DSH home 目录下，直接与 Cloud Code Assist 流式 API 通信，并且设置页面支持中英文双语国际化（i18n）。

> v0.1.7 移除单账号引起的全局暂停，429 按等待提示同账号、同端点最多重试一次。参见[更新记录](./CHANGELOG.md)。

> v0.1.6 修复生成请求与额度查询项目绑定不一致，以及旧凭据刷新覆盖真实项目的问题；0.1.5 的请求策略保持不变。

> v0.1.5 保留 Gemini 工具 Schema 引用，并加入保守请求策略、持久冷却、私密凭据写入与统一版本来源。保留 0.1.4 的历史工具调用/结果配对；不伪造成功结果，不修改会话原始定义。参见[更新记录](./CHANGELOG.md)。

> 非官方集成。本项目与 Google 无关，亦未获得 Google 认可。请仅在您有权访问的账号和服务中使用。

---

## 安装到 DSH Web / Desktop

### 方式一：直接从 GitHub 安装

```sh
dsh plugin --profile web add github:Lukeknow0/dsh-antigravity
dsh plugin --profile desktop add github:Lukeknow0/dsh-antigravity
```

### 方式二：通过本地 Release 包安装

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.1.7.tgz
dsh plugin --profile desktop add ./dist/dsh-antigravity-0.1.7.tgz
```

该 package 声明了 DSH bundle patch，安装后会自动挂载 host 插件与浏览器设置页面。

如果您的 DSH 版本暂不支持 `dsh plugin add`，可手动复制到 Web profile：

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

然后在 profile 的 `cordis.patch.yml` 中添加该插件：

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

重启 DSH：

```sh
dsh web
```

---

## 登录与账号池管理

打开 **设置（Settings）> Antigravity**，支持添加和管理多个 Google 账号：

- **健康账号选择**：在新请求开始前选择可用账号；手动模式只使用指定账号，冷却中或授权暂停的账号不进入候选列表。
- **独立账号冷却**：429 只冷却当前账号。无等待提示或等待不超过 30 秒时，同账号同端点最多重试一次；长等待直接停止。默认冷却 15 秒。额度查询的 429 只记录查询错误，不影响聊天冷却。401/403 仍暂停对应账号授权。
- **无损向后兼容**：初次升级将自动把原 `antigravity-oauth.json` 迁移为账号池主账号，无需重新登录。
- **前端生图工具集成**：注册 `antigravity_image_generate` 工具，主模型编写前端代码时可直接在后台调起 `gemini-3.1-flash-image` 生成插画素材并自动保存至 `./assets/images`。

点击 **「＋ 添加 Google 账号」** 可持续追加账号，卡片实时展示各账号独立的 Gemini（绿条）与 Claude（青条）配额进度条。

凭证存储路径：

```text
$DSH_HOME/storages/antigravity-pool-accounts.json
```

> 请妥善保管该文件，其中包含 access token 与 refresh token。

---

## 模型列表

登录后，在 DSH 模型选择器中选择 **Antigravity** 提供商。您可以在 **设置 > Antigravity** 的模型选择器中按需勾选或关闭单个模型（已勾选的模型将自动置顶展示），每个模型副标题均会显示其实时可用额度百分比。

支持注册的模型 ID：

| 模型 ID | 名称 | 额度池 |
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

同一额度池内的模型共享 5 小时与每周额度。额度按 Token 成本比例扣除，因此较重的大模型（如 Claude Opus）消耗额度速度会快于轻量模型。

插件会在可用时通过实时的 `fetchAvailableModels` 目录将这些公开 ID 解析为内部运行时模型 ID，并自带静态路由兜底。

---

## 请求策略与工具兼容边界

每次生成最多 **2 次 HTTP 尝试**。429 的服务端等待超过 30 秒时不重试；否则同账号、同端点等待给定时间（未给出则 2500ms）后最多重试一次。网络及 500/502/503/504 的原有重试行为保持不变。成功响应开始后断流直接报错，不重放。不自动跨号重试，账号切换由用户手动选择或下一轮请求选择健康账号。显式 `ANTIGRAVITY_BASE_URL` 保持固定。

Gemini 保留 `$defs`／`definitions`、本地 `$ref`、组合与嵌套结构。缺失引用、外部引用或锚点引用会在本地明确失败，不联网取回。预检预算为 128 层 JSON 嵌套、50,000 个访问数据单元、所有声明合计 2 MiB；预检不是完整的 JSON Schema 元验证器。

Claude／GPT-OSS 使用受限 Legacy 格式：基本类型、properties、required、items、description 和字符串 enum；本地引用有界展开。可空单类型沿用旧适配器的非 null 类型转换。无法安全表达的验证约束、多分支类型、元组或递归结构会**明确报错，不再静默删除**。复杂 MCP 工具集可能需要使用 Gemini，或在宿主中关闭不兼容的声明。

凭据通过原子写入替换，支持的系统上权限为 `0600`，拒绝符号链接目标。普通请求日志不输出 token、聊天内容、工具参数或邮箱。CLI 登录链接仅为本地用户完成授权而显示，重定向的登录输出也需保密。设置页仍显示邮箱以识别账号，生成工具结果改用内部 ID。

**风险说明**：这属于可靠性和隐私保护，不是身份伪装或“防封”。Google 仍能关联 OAuth 账号和请求；不绕过授权、地区或配额限制。账号冷却状态可跨重启保存，但多个独立运行的宿主并不是分布式统一配额控制器。

## 升级与回滚

Web 与 Desktop 是两个独立安装的 profile。升级实际使用的 profile，再使用宿主正常机制重载插件。GitHub 发布不会自动更新本地安装。

旧文件若曾原地修补，功能代码可能比安装包版本标签更新。0.1.5 的状态 API、诊断和请求日志统一读取包版本；安装完整 Release 可避免元数据混用。安装前私密备份凭据。[0.1.4 Release](https://github.com/Lukeknow0/dsh-antigravity/releases/tag/v0.1.4) 保留供回滚，回滚后也会恢复旧的较宽松重试策略。

开发验证均离线执行：

```sh
npm test
npm run check
npm run pack:dist
```

测试覆盖文本／图片拒绝处理、引用 Schema、冷却持久化与凭据存储，不使用真实 Google 账号或生产模型请求；不能据此保证未来所有上游版本兼容。

## 许可证

[MIT](./LICENSE)
