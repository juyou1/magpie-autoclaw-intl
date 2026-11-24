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
| **网页登录（Z.ai / Google）** | 在本地开一个引导页，完成安全验证后跳到 Z.ai / Google 的官方授权页，授权完自动回到 magpie。回调只用官方客户端登记的四个本机端口之一（18432 / 19654 / 19723 / 53699）；都被占用时（比如官方客户端正在运行）会提示先关掉它。 |
| **Access Token** | 粘贴 access token；refresh token 可选，填了才能自动续期。 |
| **导入凭据 JSON** | 粘贴单个账号的凭据 JSON，或整份官方客户端的 `auth.json`。`enc:` 加密的值会用本机客户端的密钥解开。 |
| **导入本机登录态** | 读取官方客户端的登录态，不开浏览器。只读，不改动客户端的文件。 |

登录态由 magpie 保管（`plugin-auth.json`），refresh token 一次一换，插件保证同一个 token 只兑换一次。

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
