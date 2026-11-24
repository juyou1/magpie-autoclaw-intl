// The three-step overseas web sign-in (oauth.rs): captcha config, the
// authorization URL, and the code exchange. Zai and Google take the same
// steps under their own path names.
//
// Step 2 insists on an Aliyun risk-control receipt: without one the vendor
// answers 631002, and with a made-up one 630014. The receipt is produced by
// the vendor's browser-side SDK, so it is not reproduced here: the local
// guide page runs the SDK and hands the opaque string on unchanged. Step 3
// needs no receipt, so the exchange is done here.

import { post } from "./api.mjs"
import { businessCode, rawDetail } from "./errors.mjs"
import { CAPTCHA_CONFIG_PATH, ORIGIN, printable, text } from "./util.mjs"

export const VENDORS = ["zai", "google"]

export function isVendor(value) {
  return VENDORS.includes(value)
}

/** 回调地址：官方 TokenServer 端口池之一的 loopback，路径与官方客户端逐字相同。 */
export function navigateUri(vendor, port) {
  return `http://localhost:${port}/auth/callback-${vendor}`
}

/** OAuth 这条链自己的业务码表。 */
export function describeOauthError(code, upstreamMessage) {
  const said = String(upstreamMessage ?? "").trim()
  switch (code) {
    case 631_002:
      return "本次登录缺少风控验证（验证码未通过或已过期），请重新点击登录再试一次"
    case 630_014:
      return "风控验证未通过，请重新点击登录再试一次"
    case 631_001:
      return "授权码无效或已过期，请重新点击登录"
    case 400_001:
      return "请求参数有误（登录链路内部错误，请重试）"
    case 400_002:
      return "请求签名校验失败（本机时钟可能有偏差），请校准系统时间后重试"
    case 400_005:
      return "登录请求过于频繁，请稍后再试"
    default:
      return said ? `登录失败：${said}` : `登录失败（上游 code=${code ?? "未返回"}）`
  }
}

function ok(payload, operation) {
  const code = businessCode(payload)
  if (code === 0) return payload
  throw Object.assign(new Error(`AutoClaw ${operation}失败：${describeOauthError(code, rawDetail(payload))}`), { status: 502, code })
}

/** 验证码配置；enabled:false 不是错误。归一成 camelCase。 */
export async function captchaConfig(options = {}) {
  const payload = await post(CAPTCHA_CONFIG_PATH, "", {}, "读取验证配置", options)
  const data = ok(payload, "读取验证配置").data
  if (typeof data !== "object" || data === null) {
    throw Object.assign(new Error("AutoClaw 国际版未返回完整有效的 Aliyun 配置"), { status: 502 })
  }
  const enabled = typeof data.enabled === "boolean" ? data.enabled : false
  const pick = (key, max) => {
    const value = text(data, [key])
    if (!printable(value, max) || /\s/.test(value)) return ""
    return value
  }
  if (!enabled) return { enabled: false, supplier: "", region: "", prefix: "", sceneId: "" }
  const supplier = pick("captcha_supplier", 64)
  if (supplier !== "aliyun") {
    throw Object.assign(new Error("国际版上游返回了尚未接入的真人验证服务，未改用其他验证方式"), { status: 503 })
  }
  return {
    enabled: true,
    supplier,
    region: pick("region", 32),
    prefix: pick("prefix", 256),
    sceneId: pick("scene_id", 256),
  }
}

/**
 * 取授权页地址。captcha 是引导页里阿里云 SDK 跑完给的不透明回执，原样转交。
 * 上游启用了风控验证时它必须有：不带的话上游回的是一个与真实原因无关的 631002。
 */
export async function requestOauthUrl(vendor, { port, deviceId, captcha, captchaRequired = true }, options = {}) {
  if (!isVendor(vendor)) throw Object.assign(new Error("AutoClaw 国际版只支持 Zai 或 Google 授权"), { status: 400 })
  const captchaParam = String(captcha ?? "").trim()
  const usable = !!captchaParam && printable(captchaParam, 32 * 1024)
  // 本地就挡掉：该带而没带时上游必然给出那条误导性的 631002。
  // captchaRequired 是三态：只有上游明确说没启用验证（false）时回执才是可带的。
  if ((captchaRequired !== false && !usable) || (captchaParam && !usable)) {
    throw Object.assign(new Error("缺少本轮真实完成的 Aliyun 验证结果，请先完成安全验证"), { status: 400 })
  }
  const operation = `获取 ${vendorLabel(vendor)} 授权地址`
  const body = { source_id: "autoclaw", device_id: deviceId, navigate_uri: navigateUri(vendor, port) }
  if (captchaParam) body.ali_captcha_verify_param = captchaParam
  const payload = await post(`/userapi/overseasv1/${vendor}-oauth-url`, "", body, operation, options)
  const data = ok(payload, operation).data
  const url = text(data ?? {}, ["oauth_url"])
  if (!url) throw Object.assign(new Error("AutoClaw 国际版没有返回官方授权地址"), { status: 502 })
  return url
}

/** 用回调里的一次性授权码换登录态。 */
export async function exchangeCode(vendor, { port, deviceId, code, state }, options = {}) {
  if (!isVendor(vendor)) throw Object.assign(new Error("AutoClaw 国际版只支持 Zai 或 Google 授权"), { status: 400 })
  for (const value of [code, state]) {
    if (!value || !printable(value, 4096) || /\s/.test(value)) {
      throw Object.assign(new Error("AutoClaw 国际版授权换码参数无效"), { status: 400 })
    }
  }
  const operation = `${vendorLabel(vendor)} 登录换取凭证`
  const payload = await post(
    `/userapi/overseasv1/${vendor}-oauth-login`,
    "",
    { source_id: "autoclaw", device_id: deviceId, code, state, navigate_uri: navigateUri(vendor, port) },
    operation,
    options,
  )
  const data = ok(payload, operation).data
  const accessToken = text(data ?? {}, ["access_token"])
  if (!accessToken) throw Object.assign(new Error("登录成功但上游没有返回 access_token"), { status: 502 })
  return {
    accessToken,
    refreshToken: text(data, ["refresh_token"]),
    userId: text(data, ["user_id"]),
    userName: text(data, ["user_name"]),
  }
}

export function vendorLabel(vendor) {
  return vendor === "zai" ? "Zai" : "Google"
}

export { ORIGIN }
