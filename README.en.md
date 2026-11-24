# AutoClaw International · magpie plugin

Brings **AutoClaw 国际版 (International)** accounts into [magpie](https://usemagpie.ai), so any agent — Claude Code, Codex, Gemini CLI, OpenCode and the rest — can use its models. The provider id is `autoclaw-intl`; agents name its models `autoclaw-intl/<model>`.

> A third-party plugin ported from the public protocol. It is not an official product of AutoClaw or Zhipu. It makes your machine's requests look like the official AutoClaw client's, using your own account and credits.

## What it does

- **Signs in** with Z.ai / Google in the browser, or with a pasted access token, a credentials JSON, or the official desktop client's sign-in.
- **Models**: reads the account's live model catalog after sign-in, so a model upstream adds appears without a plugin release. Falls back to the built-in list (`glm-5.3`, `glm-5.3-flash`).
- **Chat**: streaming and non-streaming, with tool calls and reasoning kept.
- **Renews** the access token before it runs out; a refresh token is spent once.
- **Usage**: credit balance by wallet, expiring points, the subscription plan.
- **Check-in**: the daily check-in and the login-activity campaign reward.

It talks to the international endpoint `https://autoglm-api.autoglm.ai` only, and never falls back to the CN site.

## Install

```
magpie plugin add <path to this folder>
```

In the app: Plugins → Add a plugin, and pick the folder.

## Sign in

```
magpie plugin login autoclaw-intl
```

Four ways:

| Way | What happens |
| --- | --- |
| **Web sign-in (Z.ai / Google)** | Opens a login page of the plugin's own: complete the security check, and the page takes you to Z.ai's or Google's own authorization page. When you are done, the vendor sends the browser to `http://localhost:<port>/auth/callback-…` — **that page not loading is normal** (it points at the machine magpie runs on). Copy the whole address from the address bar and paste it into the sign-in's Callback URL field. On a desktop install nothing is pasted: the redirect comes straight back to the plugin and completes by itself. |
| **Access Token** | Paste an access token. The refresh token is optional, but without one the sign-in can't renew. |
| **Credentials JSON** | Paste one account's credential JSON, or the client's whole `auth.json`. `enc:` values are decrypted with the local client's key. |
| **Desktop sign-in** | Reads the official client's sign-in, no browser. Read-only: the client's files are never changed. |

magpie keeps the sign-in (`plugin-auth.json`). Refresh tokens rotate; the plugin makes sure one is exchanged only once.

### Installing in a container or on a server

The same shape as Agent2API's remote panel: the captcha runs in your browser and the callback is pasted back — **nothing depends on the container receiving the redirect**. Map one port for the login page and tell the plugin the address your browser reaches it at:

```
docker run … -p 18433:18433 \
  -e AUTOCLAW_LOGIN_PORT=18433 \
  -e AUTOCLAW_LOGIN_HOST=0.0.0.0 \
  -e AUTOCLAW_LOGIN_PUBLIC_URL=http://<the container's outside address>:18433 \
  …
```

| Variable | What it does |
| --- | --- |
| `AUTOCLAW_LOGIN_PORT` | The login page's port, `18433` by default. Map it out. |
| `AUTOCLAW_LOGIN_HOST` | What to listen on. `0.0.0.0` in a container, so the port can be reached from outside. |
| `AUTOCLAW_LOGIN_PUBLIC_URL` | The address your browser opens the page at (the container's domain or IP:port), e.g. `http://box.example.com:18433`. Left unset, a desktop install works as it is (`127.0.0.1`). |

The page's port can be open to the network safely: the page's address carries a random token for this one sign-in, every request must bring it, and a request from another site is turned away by its Origin — knowing the port isn't enough to drive the sign-in. The callback ports (18432 and its three siblings) listen on magpie's own loopback only and need no mapping.

The steps, from a container:

1. Start the sign-in in magpie; it gives the login page's address (a link under `AUTOCLAW_LOGIN_PUBLIC_URL`).
2. Open it in your browser, complete the security check, and sign in on the vendor's page.
3. The browser lands on a `localhost` page that doesn't load — normal. Copy its whole address from the address bar, paste it into the sign-in's Callback URL field, and the sign-in completes.

## Usage and check-in

```
magpie quota                             # credits, wallets, subscription
```

Credits are a balance, not a quota, so the card shows what is left rather than a percentage. The daily check-in is switched on for the provider in Settings → Plugins, once a day per account.

## Models

The built-in list before sign-in:

| Model | Upstream route | Context | Output |
| --- | --- | --- | --- |
| `glm-5.3` | `zaicoding_glm-5.3` | 1,000,000 | 131,072 |
| `glm-5.3-flash` | `zai_glm-5.3-flash` | 1,000,000 | 32,000 |

After sign-in the account's live catalog stands, and the list updates by itself.

## About the system prompt

The vendor refuses (406) a chat whose system prompt carries another agent's identity line — Claude Code's, Codex's, ZCode's opening sentence, for instance. The plugin rewrites the ones it knows into neutral wording and puts the official client's own opening sentence in front; your own system prompt follows whole, and user messages, tool calls and images are never touched. An agent it doesn't know can still be refused; use another provider for that one.

## Developing

```
npm test                                 # or: node --test test/*.test.mjs
```

No build step and no runtime dependencies: magpie loads `index.mjs` directly on its bundled Bun.

After editing the source, switch the plugin off and on in the app, or run any `magpie` command in a terminal.

## License

**AGPL-3.0-only.** This plugin is a port of the AutoClaw 国际版 provider in [ProvidersPlugin/Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers) (AGPL-3.0-only) and, as a derivative work, carries the same license. The parts taken from MIT-licensed works ([magpie-community/plugins](https://github.com/magpie-community/plugins), OpenClaw) keep their own notices in [LICENSES/](LICENSES/), and where each part came from is listed in [LICENSES/SOURCES.json](LICENSES/SOURCES.json).

AutoClaw is a trademark of Zhipu. This plugin isn't affiliated with Zhipu, z.ai or Google.
