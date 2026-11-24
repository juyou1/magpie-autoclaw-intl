// What every sign-in way ends with: a magpie sign-in made from the tokens the
// vendor gave (Agent2Providers login.rs account_from_credentials).
//
// The identity is the user_id inside the access token: with Z.ai or Google the
// vendor's own data.user_id can be the outside account's id. What magpie shows
// beside an account (uid, accountId, email, name) is public, so none of it may
// carry the token itself, a control character, or more than a kilobyte.

import { randomBytes } from "node:crypto"

import { post } from "./api.mjs"
import { checkBusiness } from "./errors.mjs"
import { claims, jwtExpiry, scalar, stripBearer, text, tokenValid } from "./util.mjs"

/** 到期时间比令牌的 exp 提前这么多，续期就不会贴着失效边缘。 */
const EXPIRY_SKEW_MS = 10 * 60 * 1000
const PUBLIC_FIELD_MAX = 1024

/** 64 位十六进制 device_id（官方客户端形态）。 */
export function newDeviceId() {
  return randomBytes(32).toString("hex")
}

/** 一份凭据的到期时间（epoch 毫秒）：优先令牌里的 exp，其次 expires_in，都没有就不写。 */
export function expiryOf(access, expiresIn, now = Date.now()) {
  const jwt = jwtExpiry(access)
  if (jwt !== undefined) return jwt - EXPIRY_SKEW_MS
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + expiresIn * 1000 - EXPIRY_SKEW_MS
  return undefined
}

/** 由登录响应组装 magpie 的 success 结果。 */
export function successFrom({ accessToken, refreshToken, deviceId, userId, userName, email, expiresIn, now }) {
  const access = stripBearer(String(accessToken ?? ""))
  const refresh = stripBearer(String(refreshToken ?? ""))
  if (!tokenValid(access, false)) throw Object.assign(new Error("AutoClaw 登录响应里没有有效的 access_token"), { status: 502 })
  if (!tokenValid(refresh, true)) throw Object.assign(new Error("AutoClaw 登录响应里的 refresh_token 无效"), { status: 502 })
  const payload = claims(access) ?? {}
  const clean = (value) => {
    const s = String(value ?? "").trim()
    if (!s || s.length > PUBLIC_FIELD_MAX || /[\u0000-\u001f\u007f]/.test(s)) return ""
    return s === access || s === refresh ? "" : s
  }
  const uid = clean(scalar(payload.user_id) || scalar(userId)) || undefined
  const expires = expiryOf(access, expiresIn, now)
  const safeEmail = clean(email)
  const name = clean(userName)
  const device = deviceId || scalar(payload.device_id) || undefined
  return {
    type: "success",
    access,
    ...(refresh ? { refresh } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(uid ? { uid } : {}),
    // magpie 按 accountId → metadata.email → email 给账号命名。
    ...(safeEmail || uid ? { accountId: safeEmail || uid } : {}),
    ...(safeEmail ? { email: safeEmail } : {}),
    ...(name ? { name } : {}),
    ...(device ? { deviceId: device } : {}),
  }
}

/** 用户资料：账号的邮箱与昵称。信封里的业务码同样要查：令牌被资料接口拒了就是被拒了。 */
export async function fetchProfile(accessToken, deviceId, options = {}) {
  const payload = await post(
    "/userapi/v1/user-profile",
    accessToken,
    { source_id: "autotyper", ...(deviceId ? { device_id: deviceId } : {}) },
    "用户资料查询",
    options,
  )
  checkBusiness(payload, "查询用户资料")
  const data = payload.data && typeof payload.data === "object" ? payload.data : {}
  return { userId: scalar(data.user_id), email: text(data, ["email"]), name: text(data, ["user_name"]) }
}

/**
 * 读资料补全显示名与账号身份。读不到不算登录失败；令牌被资料接口拒了才是。
 * 结果里已有的身份、设备与到期时间都保留，资料只补空缺。
 */
export async function completeFromProfile(result, deviceId, options = {}) {
  const device = result.deviceId || deviceId
  const profile = await fetchProfile(result.access, device, options).catch((error) => {
    if (error?.kind === "token_expired") throw error
    return null
  })
  if (!profile) return result
  return successFrom({
    accessToken: result.access,
    refreshToken: result.refresh,
    deviceId: device,
    userId: result.uid || profile.userId,
    userName: result.name || profile.name,
    email: result.email || profile.email,
    // 没有新令牌就没有新的到期时间：沿用结果里原来的那个。
    expiresIn: typeof result.expires === "number" ? (result.expires - (options.now ?? Date.now())) / 1000 : undefined,
    now: options.now,
  })
}
