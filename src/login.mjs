// The sign-in methods magpie offers for this provider, in OpenCode's shape.
//
//   Z.ai / Google web sign-in   weblogin.mjs. Works from a container: the
//                              vendor's redirect is pasted back into magpie.
//   Access token / refresh      prompts; checked against the vendor.
//   Credentials JSON            prompts; checked against the vendor.
//   Desktop sign-in             reads the official client's auth.json; no browser.
//
// All four save an access + refresh pair, so magpie renews them with the
// refresh hook. Tokens go to the account store, never to logs.

import { join } from "node:path"

import { decryptEncValue, osCryptAesKey, readDesktopCredentials, userDataDir } from "./desktop.mjs"
import { fetchProfile, newDeviceId, successFrom } from "./signin.mjs"
import { claims, scalar, stripBearer, text, tokenValid } from "./util.mjs"
import { webLoginMethod } from "./weblogin.mjs"

export { parseLoginAddress, resetWebLogins, startWebLogin, webLoginMethod } from "./weblogin.mjs"
export { successFrom } from "./signin.mjs"

/**
 * 核对并补全一份手工凭据：用资料接口确认它还能用，补上邮箱。
 * JWT 里的 userId 不被外部资料接口的 ID 覆盖。
 */
export async function verifyCredentials(secret, options = {}) {
  const access = stripBearer(text(secret, ["token", "accessToken", "access_token"]))
  const refresh = stripBearer(text(secret, ["refreshToken", "refresh_token"]))
  if (access.startsWith("enc:") || refresh.startsWith("enc:")) {
    throw Object.assign(new Error("凭据仍是 enc: 加密形态，请粘贴解密后的 token，或使用「导入本机登录态」"), { status: 400 })
  }
  if (!tokenValid(access, false) || !tokenValid(refresh, true)) {
    throw Object.assign(new Error("AutoClaw 凭据缺失或格式无效"), { status: 400 })
  }
  // 凭据里写明的 userId 与令牌身份不一致时不添加这个账号。
  const tokenUser = scalar(claims(access)?.user_id)
  const given = scalar(secret.userId) || scalar(secret.user_id)
  if (given && tokenUser && given !== tokenUser) {
    throw Object.assign(new Error("AutoClaw 凭据中的用户标识与令牌身份不一致"), { status: 409 })
  }
  const deviceId = text(secret, ["deviceId", "device_id"]) || scalar(claims(access)?.device_id) || newDeviceId()
  const base = successFrom({
    accessToken: access,
    refreshToken: refresh,
    deviceId,
    userId: tokenUser || given,
    userName: text(secret, ["name", "userName", "user_name"]),
    email: text(secret, ["email"]),
    now: options.now,
  })
  // 资料接口把令牌拒了，这份凭据就是无效的；读不到资料则不算。
  const profile = await fetchProfile(access, deviceId, options).catch((error) => {
    if (error?.kind === "token_expired") throw error
    return null
  })
  if (!base.uid && !profile?.userId) {
    throw Object.assign(new Error("AutoClaw 国际版凭据与用户资料均未给出账号身份，未添加空账号"), { status: 502 })
  }
  // 资料只补空缺：凭据里已有的身份、昵称、邮箱都保留。资料已经在手上，不再请求。
  if (!profile || (base.uid && base.name && base.email)) return base
  return successFrom({
    accessToken: access,
    refreshToken: refresh,
    deviceId,
    userId: base.uid || profile.userId,
    userName: base.name || profile.name,
    email: base.email || profile.email,
    // 到期时间以令牌自己的为准；带上 expires_in 只为让没有 exp 的令牌沿用原来的推算。
    expiresIn: typeof base.expires === "number" ? (base.expires + 600_000 - (options.now ?? Date.now())) / 1000 : undefined,
    now: options.now,
  })
}

/** 解析凭据 JSON 文本；兼容整份 auth.json（其中可能带 userInfo）。 */
export function parseCredentialJson(raw) {
  let value
  try {
    value = JSON.parse(String(raw ?? "").trim())
  } catch {
    throw Object.assign(new Error("AutoClaw 凭据 JSON 格式无效"), { status: 400 })
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("AutoClaw 凭据必须是 JSON 对象"), { status: 400 })
  }
  const merged = { ...value, ...(value.userInfo && typeof value.userInfo === "object" ? { email: value.userInfo.email } : {}) }
  if (merged.provider && merged.provider !== "autoclaw-intl") {
    throw Object.assign(new Error("这份 AutoClaw 凭据不属于国际版"), { status: 400 })
  }
  return merged
}

/** 直接粘贴的 auth.json 原值是 enc: 密文：用本机客户端的密钥解开后才是可用凭据。 */
export async function resolveCredentialJson(raw) {
  const secret = parseCredentialJson(raw)
  if (!String(secret.token ?? "").startsWith("enc:") && !String(secret.refreshToken ?? "").startsWith("enc:")) return secret
  let aesKey
  try {
    aesKey = await osCryptAesKey(join(userDataDir(), "Local State"))
  } catch (error) {
    throw Object.assign(new Error(`凭据是 enc: 加密形态，且取不到本机密钥：${error.message}`), { status: 400 })
  }
  return {
    ...secret,
    token: decryptEncValue(String(secret.token ?? ""), aesKey),
    refreshToken: decryptEncValue(String(secret.refreshToken ?? ""), aesKey),
  }
}

/**
 * 手动填写 access token（refresh token 可选）。
 * 以 oauth 形态保存：凭据是 access + refresh 一对，续期靠 refresh 钩子。
 */
export const tokenMethod = {
  type: "oauth",
  label: "Access Token",
  async authorize(inputs, { signal, ...deps } = {}) {
    return verifyCredentials(
      {
        token: String(inputs?.token ?? ""),
        refreshToken: String(inputs?.refreshToken ?? ""),
        deviceId: String(inputs?.deviceId ?? "").trim() || undefined,
      },
      { signal, ...deps },
    )
  },
  prompts: [
    { type: "password", key: "token", message: "Access Token", validate: (v) => (String(v ?? "").trim() ? undefined : "请填写 access token") },
    { type: "password", key: "refreshToken", message: "Refresh Token（可选，填写后可自动续期）" },
    { type: "text", key: "deviceId", message: "Device ID（可选）" },
  ],
}

/** 导入凭据 JSON：单账号 JSON 或整份 auth.json（token 可以是 enc: 密文，用本机密钥解）。 */
export const credentialJsonMethod = {
  type: "oauth",
  label: "导入凭据 JSON",
  async authorize(inputs, { signal, ...deps } = {}) {
    const secret = await resolveCredentialJson(inputs?.credentialJson)
    return verifyCredentials(secret, { signal, ...deps })
  },
  prompts: [
    {
      type: "password",
      key: "credentialJson",
      message: "凭据 JSON",
      placeholder: '{"token":"…","refreshToken":"…"}',
      validate: (v) => {
        try {
          parseCredentialJson(v)
          return undefined
        } catch (error) {
          return error?.message ?? "凭据 JSON 格式无效"
        }
      },
    },
  ],
}

/** 导入本机国际版登录态：读取官方客户端的 auth.json，不开浏览器。 */
export const desktopMethod = {
  type: "oauth",
  label: "导入本机国际版登录态",
  async authorize() {
    const success = successFrom(await readDesktopCredentials())
    return {
      url: "",
      instructions: `已读取本机 AutoClaw 登录态${success.email ? `（${success.email}）` : ""}，正在保存。`,
      method: "auto",
      callback: async () => success,
    }
  },
}

/** 登录方法，顺序即界面上的按钮顺序。 */
export const loginMethods = [webLoginMethod, tokenMethod, credentialJsonMethod, desktopMethod]
