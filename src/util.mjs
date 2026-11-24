// Pure helpers: endpoints, small value readers, JWT claims, request signing,
// model routes. Nothing here touches the network or the disk.

import { createHash, randomBytes, randomUUID } from "node:crypto"

/** 国际版唯一网络出口；任何失败都不回退国内站点。 */
export const PROVIDER = "autoclaw-intl"
export const ORIGIN = "https://autoglm-api.autoglm.ai"
export const CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions"
export const MODELS_PATH = "/autoclaw-proxy/proxy/autoclaw-model-config"
export const TASK_COMPLETE_PATH = "/autoclaw-proxy/proxy/autoclaw-task-complete"
export const TASK_LIST_PATH = "/autoclaw-proxy/proxy/autoclaw-task-list"
export const LEDGER_PATH =
  "/agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all&cursor=&page_size=50&flow_direction=income"
export const WALLETS_V2_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw"
export const WALLETS_V1_PATH = "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all"
export const EXPIRING_PATH = "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw"
export const SUBSCRIBE_PATH = "/agentpay/v1/assistant/oversea-subscribe-info"
export const CAPTCHA_CONFIG_PATH = "/userapi/overseasv1/oauth-captcha-config"
export const REFRESH_PATH = "/userapi/v1/refresh"
export const REFRESH_FALLBACK_PATH = "/userapi/v1/agent-refresh"

/** 官方 TokenServer 端口池：OAuth client 只登记了这些端口的 localhost 回调。 */
export const CALLBACK_PORTS = [18432, 19654, 19723, 53699]

/** 阿里云验证码组件的 CDN。 */
export const ALIYUN_CAPTCHA_JS = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"

// 请求指纹常量（headers.rs）。
const APP_ID = "100003"
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"
const OPENAI_SDK_VERSION = "6.26.0"
const OPENAI_NODE_VERSION = "v24.18.0"
export const CLIENT_VERSION = "1.18.5"
export const CHAT_VERSION = "2.0.3"
export const MAX_TOKEN = 32 * 1024
export const REFRESH_MARGIN_MS = 300_000

export function md5Hex(text) {
  return createHash("md5").update(text).digest("hex")
}

export function randomHex(bytes) {
  return randomBytes(bytes).toString("hex")
}

export function uuid() {
  return randomUUID()
}

/** printable：长度不超过 max 且全部是可打印 ASCII（32..126）。 */
export function printable(value, max) {
  if (typeof value !== "string" || value.length > max) return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 32 || c > 126) return false
  }
  return true
}

/** text：按顺序取第一个非空字符串字段。 */
export function text(value, keys) {
  if (!value || typeof value !== "object") return ""
  for (const key of keys) {
    const v = value[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/** scalar：字符串 / 数字 / 布尔转成文本，其余为空。 */
export function scalar(value) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return String(value)
  return ""
}

export function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function integer(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) ? n : undefined
  }
  return undefined
}

/** stripBearer：一路剥掉 "Bearer " 前缀（存量脏值可能是双前缀）。 */
export function stripBearer(value) {
  let token = String(value ?? "").trim()
  for (;;) {
    if (!/^bearer/i.test(token)) return token
    const rest = token.slice(6)
    if (!rest) return ""
    if (!/^\s/.test(rest)) return token
    token = rest.trimStart()
  }
}

/** tokenValid：凭据是非空、无空白、可打印 ASCII 的短串。 */
export function tokenValid(value, optional = false) {
  if (optional && value === "") return true
  if (!value || value.length > MAX_TOKEN || !printable(value, MAX_TOKEN)) return false
  return !/\s/.test(value)
}

/** claims：JWT 的 payload（不验签，只读自己账号的 user_id / device_id / exp）。 */
export function claims(token) {
  const part = stripBearer(token).split(".")[1]
  if (!part) return null
  try {
    const json = Buffer.from(part, "base64url").toString("utf8")
    const value = JSON.parse(json)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** jwtExpiry：access token 的 exp（epoch 毫秒），读不到为 undefined。 */
export function jwtExpiry(token) {
  const exp = number(claims(token)?.exp)
  return exp !== undefined && exp > 0 ? exp * 1000 : undefined
}

/** beijingDay：北京日界（UTC+8）的 YYYY-MM-DD，签到与活动奖励按它切日。 */
export function beijingDay(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** sha256 的前 32 个十六进制字符，用于会话关联与账号去重键。 */
export function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

/** routeShape：路由形如 <vendor>_<model>（zaicoding_glm-5.3、zai_glm-5.3-flash）。 */
export function routeShape(value) {
  const at = value.indexOf("_")
  if (at <= 0) return false
  const head = value.slice(0, at)
  const tail = value.slice(at + 1)
  if (!/^[a-z][a-z0-9]*$/.test(head)) return false
  return tail.length > 0 && tail.length <= 127 && /^[A-Za-z0-9._:-]+$/.test(tail)
}

const ROUTE_PREFIXES = ["zaicoding_", "zai_"]

/** stripRoute：去掉路由的厂商前缀，得到 magpie 里显示的模型 id。 */
export function stripRoute(route) {
  for (const prefix of ROUTE_PREFIXES) {
    if (route.startsWith(prefix)) return route.slice(prefix.length)
  }
  return route
}

/** resolveRoute：把请求里的模型名解析成上游路由。目录优先，其次按路由形态原样使用，最后落到默认路由。 */
export function resolveRoute(raw, catalog, defaultRoute) {
  const requested = String(raw ?? "").trim()
  if (!requested) return { requested: defaultRoute, route: defaultRoute }
  if (!printable(requested, 512) || !stripRoute(requested)) {
    throw Object.assign(new Error("AutoClaw 模型名称格式无效"), { status: 400 })
  }
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  let route
  for (const field of ["id", "name", "routeId"]) {
    const hit = models.find((m) => typeof m?.[field] === "string" && m[field].trim().toLowerCase() === requested.toLowerCase())
    const candidate = hit ? text(hit, ["routeId", "id"]) : ""
    if (candidate && printable(candidate, 512)) {
      route = candidate
      break
    }
  }
  if (!route) {
    const shaped = ROUTE_PREFIXES.some((p) => requested.startsWith(p)) || routeShape(requested)
    route = shaped ? requested : defaultRoute
  }
  return { requested, route }
}
