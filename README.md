# AutoClaw 国际版 · magpie 插件

把 **AutoClaw 国际版** 的账号接进 [magpie](https://usemagpie.ai)，让 Claude Code、Codex、Gemini CLI、OpenCode 等任何 agent 都能用它的模型。provider id 是 `autoclaw-intl`，agent 里按 `autoclaw-intl/<模型>` 选用。

> 这是一个按协议移植的第三方插件，不是 AutoClaw 或智谱的官方产品。它让本机发出的请求与 AutoClaw 官方客户端一致，用的是你自己的账号和额度。

## 它做什么

- **登录**：Z.ai / Google 网页登录，或粘贴 access token、导入凭据 JSON、读取本机官方客户端的登录态。
- **模型**：登录后读取账号的实时模型目录；上游新增模型不用等插件更新。读不到时用内置清单（`glm-5.3`、`glm-5.3-flash`）。
- **对话**：流式与非流式都支持，工具调用与思考内容原样保留。
- **续期**：access token 到期前自动续期，同一 refresh token 只兑换一次。
- **用量**：积分余额、分钱包、即将过期的积分、订阅计划。
- **签到**：每日签到与登录活跃活动奖励。

只连接国际版端点 `https://autoglm-api.autoglm.ai`，任何失败都不会回退到国内站点。

## 安装

```
magpie plugin add <这个目录的路径>
```

在应用里：Plugins → Add a plugin → 选这个目录。

## 登录

```
magpie plugin login autoclaw-intl
```

四种方式，任选其一：

| 方式 | 说明 |
| --- | --- |
| **网页登录（Z.ai / Google）** | 先打开插件给的一个本地登录页：完成安全验证，页面带你到 Z.ai / Google 的官方授权页。授权后浏览器会跳到 `http://localhost:<端口>/auth/callback-…`——**这个页面打不开是正常的**（它指向的是 magpie 所在的机器）。把浏览器**地址栏里的完整地址**复制下来，粘贴到 magpie 这次登录的「回调地址（Callback URL）」里即可完成。桌面安装时不需要粘贴：跳转会直接回到插件，自动完成。 |
| **Access Token** | 粘贴 access token；refresh token 可选，填了才能自动续期。 |
| **导入凭据 JSON** | 粘贴单个账号的凭据 JSON，或整份官方客户端的 `auth.json`。`enc:` 加密的值会用本机客户端的密钥解开。 |
| **导入本机登录态** | 读取官方客户端的登录态，不开浏览器。只读，不改动客户端的文件。 |

登录态由 magpie 保管（`plugin-auth.json`），refresh token 一次一换，插件保证同一个 token 只兑换一次。

### 容器 / 远程服务器里安装

和 Agent2API 的远程面板同一种形态：滑块在你的浏览器里跑，回调粘回来，**不依赖容器能收到回调**。给插件映射一个登录页面端口，并用环境变量告诉它容器对外的地址：

```
docker run … -p 18433:18433 \
  -e AUTOCLAW_LOGIN_PORT=18433 \
  -e AUTOCLAW_LOGIN_HOST=0.0.0.0 \
  -e AUTOCLAW_LOGIN_PUBLIC_URL=http://<容器对外的地址>:18433 \
  …
```

| 环境变量 | 作用 |
| --- | --- |
| `AUTOCLAW_LOGIN_PORT` | 插件的登录页面监听端口，默认 `18433`。把它映射出去。 |
| `AUTOCLAW_LOGIN_HOST` | 监听地址。容器里设 `0.0.0.0`，端口才能从外面访问。 |
| `AUTOCLAW_LOGIN_PUBLIC_URL` | 你的浏览器打开登录页面用的地址（容器的域名或 IP:端口），例如 `http://box.example.com:18433`。不设时桌面安装也能用（默认 `127.0.0.1`）。 |

登录页面端口对外开放是安全的：页面地址里带着这次登录专有的随机令牌，所有请求都要带它，别的网站即使能访问端口也驱动不了登录（跨站请求还会被 Origin 拦下）。回调端口（18432 等）只在 magpie 本机监听，不需要映射。

操作步骤（容器形态）：

1. 在 magpie 里发起登录，它给出登录页面地址（`AUTOCLAW_LOGIN_PUBLIC_URL` 下的一个链接）。
2. 浏览器打开它，完成安全验证，页面带你到 Z.ai / Google 授权页，登录并授权。
3. 浏览器跳到一个打不开的 `localhost` 地址——正常。复制地址栏里的完整地址，粘回 magpie 的「回调地址（Callback URL）」，登录完成。

## 用量与签到

```
magpie quota                             # 积分、钱包、订阅
```

积分是余额而不是配额，所以卡片上显示的是「还剩多少」，不是百分比。每日签到在 magpie 的 Settings → Plugins 里给这个 provider 打开，每个账号每天一次。

## 模型

登录前的内置清单：

| 模型 | 上游路由 | 上下文 | 输出 |
| --- | --- | --- | --- |
| `glm-5.3` | `zaicoding_glm-5.3` | 1,000,000 | 131,072 |
| `glm-5.3-flash` | `zai_glm-5.3-flash` | 1,000,000 | 32,000 |

登录后以账号的实时目录为准，列表会自动更新。

## 关于系统提示

上游会拒收（406）系统提示里带着别的 agent 身份句的对话——比如 Claude Code、Codex、ZCode 的开场白。插件会把已知的这些句子改写成中性说法，并在首条消息前加上官方客户端使用的那一句；你自己的系统提示正文完整保留在后面，用户消息、工具调用和图片都不动。遇到不认识的 agent 仍可能被拒，这时换一个 provider 即可。

## 开发

```
npm test                                 # 或 node --test test/*.test.mjs
```

不需要构建步骤，也没有运行时依赖：magpie 用自带的 Bun 直接加载 `index.mjs`。

改了源码后，在应用里把插件关掉再打开，或在终端运行一次 `magpie` 命令。

## 许可

**AGPL-3.0-only**。本插件是 [ProvidersPlugin/Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers)（AGPL-3.0-only）中 AutoClaw 国际版 provider 的移植，作为衍生作品采用同一许可。其中取自 MIT 许可作品的部分（[magpie-community/plugins](https://github.com/magpie-community/plugins)、OpenClaw）保留各自的声明，见 [LICENSES/](LICENSES/)，每一部分的来源列在 [LICENSES/SOURCES.json](LICENSES/SOURCES.json)。

AutoClaw 是智谱的商标，本插件与智谱、Z.ai、Google 均无关联。
