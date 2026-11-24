// AutoClaw 国际版 — magpie / OpenCode v1 provider plugin.
//
// The protocol is ported from ProvidersPlugin/Agent2Providers `wasm/autoclaw-intl`
// (endpoints, request fingerprints, model routes, chat stream, refresh, usage,
// check-in, campaign rewards, the system-prompt layer) and the os_crypt chain
// from its `crates/providers/src/crypto.rs`. What that pack leaves to its
// Agent2API host (the loopback OAuth server, the Aliyun captcha page, the
// plugin hooks themselves) follows magpie's plugin guide and the MIT-licensed
// community plugin `@magpie-community/opencode-autoclaw-auth`.
// See LICENSES/SOURCES.json.
//
// magpie calls every function the entry module exports as a plugin, so this
// file exports the plugin and nothing else. Tests import from ./src/.

import { makeAutoclawIntlPlugin } from "./src/plugin.mjs"

/** provider "autoclaw-intl": AutoClaw 国际版 (Z.ai / Google web sign-in, pasted token, credential JSON, or the desktop client's sign-in). */
export const AutoclawIntlAuthPlugin = makeAutoclawIntlPlugin()
