// Request headers for the international endpoints (headers.rs).
//
// Three fingerprints, kept apart on purpose:
//   signedHeaders()  userapi / assetmgr business routes
//   activeHeaders()  the user-info "login activity" call: campaign rewards are
//                    only paid out under the AutoClaw20 desktop channel
//   chatHeaders()    the overseas chat route of the official 2.0.3 client
// Linux omits X-Tm on chat: the overseas WAF still refuses the official
// "linux" value, and leaving it out is the confirmed compatible form.

import {
  CHAT_VERSION,
  CLIENT_VERSION,
  MAX_TOKEN,
  md5Hex,
  printable,
  randomHex,
  stripBearer,
  tokenValid,
  uuid,
} from "./util.mjs"

const APP_ID = "100003"
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"
const OPENAI_SDK_VERSION = "6.26.0"
const OPENAI_NODE_VERSION = "v24.18.0"

/** mac | win | linux，其它平台为 other。 */
export function platformName(platform = process.platform) {
  if (platform === "darwin") return "mac"
  if (platform === "win32") return "win"
  if (platform === "linux") return "linux"
  return "other"
}

function signedParts(nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000))
  return { timestamp, sign: md5Hex(`${APP_ID}&${timestamp}&${APP_KEY}`) }
}

function bearer(token, optional) {
  const bare = stripBearer(String(token ?? ""))
  if (!bare && optional) return ""
  if (!tokenValid(bare, false)) {
    throw Object.assign(new Error("AutoClaw 凭据缺失或格式无效"), { status: 400 })
  }
  return bare
}

/** 业务路由头（模型目录、钱包、任务、订阅）。token 为空时不带 authorization。 */
export function signedHeaders(token, nowMs = Date.now()) {
  const { timestamp, sign } = signedParts(nowMs)
  const tm = platformName() === "win" ? "win" : "linux"
  const headers = {
    "Content-Type": "application/json",
    Accept: "*/*",
    "X-Version": CLIENT_VERSION,
    "X-Product": "autoclaw",
    "X-Client-Type": "pc",
    "X-Harness-Type": "zcode",
    "X-Tm": tm,
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": timestamp,
    "X-Auth-Sign": sign,
    "X-Trace-Id": uuid(),
  }
  const bare = bearer(token, true)
  if (bare) headers.authorization = `Bearer ${bare}`
  return headers
}

/** 登录活跃触发头；只供签到动作使用，不混入登录、余额查询或模型请求。 */
export function activeHeaders(token, nowMs = Date.now()) {
  const { timestamp, sign } = signedParts(nowMs)
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": "AutoClaw/2.2.0 (win-x64)",
    "X-Version": "2.2.0",
    "X-Tm": "win-x64",
    "X-Product": "autoclaw",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": timestamp,
    "X-Auth-Sign": sign,
    "X-Trace-Id": randomHex(16),
    "X-Lang": "zh-CN",
    "X-Channel": "AutoClaw20",
    Authorization: `Bearer ${bearer(token, false)}`,
  }
}

/** The OpenAI SDK's names for an OS and a CPU (its normalizePlatform / normalizeArch). */
export function stainlessOs(platform = process.platform) {
  const p = String(platform).toLowerCase()
  if (p.includes("ios")) return "iOS"
  if (p === "android") return "Android"
  if (p === "darwin") return "MacOS"
  if (p === "win32") return "Windows"
  if (p === "freebsd") return "FreeBSD"
  if (p === "openbsd") return "OpenBSD"
  if (p === "linux") return "Linux"
  return p ? `Other:${p}` : "Unknown"
}

export function stainlessArch(arch = process.arch) {
  if (arch === "x32") return "x32"
  if (arch === "x64" || arch === "x86_64") return "x64"
  if (arch === "arm") return "arm"
  if (arch === "arm64" || arch === "aarch64") return "arm64"
  return arch ? `other:${arch}` : "unknown"
}

/**
 * 国际版对话请求头。clientHeaders 里可带调用方自己的会话关联头
 * (x-autoclaw-session-id / -agent-id / -zcode-invocation-id)，转发到上游同名头。
 */
export function chatHeaders({ token, route, session, clientHeaders, nowMs = Date.now(), platform, arch }) {
  const bare = bearer(token, false)
  if (!printable(String(route ?? ""), 512) || !route) {
    throw Object.assign(new Error("AutoClaw 国际版模型路由名无效"), { status: 400 })
  }
  if (!session || !printable(session, 2048)) {
    throw Object.assign(new Error("AutoClaw 国际版会话关联无效"), { status: 400 })
  }
  const { timestamp, sign } = signedParts(nowMs)
  const os = platformName(platform)
  const request = uuid()
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `OpenAI/JS ${OPENAI_SDK_VERSION}`,
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": OPENAI_SDK_VERSION,
    "X-Stainless-OS": stainlessOs(platform),
    "X-Stainless-Arch": stainlessArch(arch),
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": OPENAI_NODE_VERSION,
    "X-Product": "autoclaw",
    "X-Client-Type": "pc",
    "X-Version": CHAT_VERSION,
    "X-Lang": "en",
    "X-Channel": "official",
    x_trace_id: "autoclaw-desktop",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": timestamp,
    "X-Auth-Sign": sign,
    "X-Authorization": `Bearer ${bare}`,
    "X-Request-Id": request,
    "X-Trace-Id": request,
    "X-Request-Model": route,
    "X-Session-Id": session,
  }
  if (os === "mac" || os === "win") headers["X-Tm"] = os
  const lower = new Headers(clientHeaders ?? {})
  for (const [upstream, client] of [
    ["X-Session-Id", "x-autoclaw-session-id"],
    ["X-Agent-Id", "x-autoclaw-agent-id"],
    ["X-ZCode-Invocation-Id", "x-autoclaw-zcode-invocation-id"],
  ]) {
    const value = (lower.get(client) ?? "").trim()
    if (!value) continue
    if (!printable(value, 2048)) {
      throw Object.assign(new Error("AutoClaw 会话关联头格式无效"), { status: 400 })
    }
    headers[upstream] = value
  }
  return headers
}
