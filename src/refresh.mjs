// Renewing a sign-in (refresh.rs, and the community plugin's single-flight).
//
// A refresh token is spent once: the same token can be exchanged a single
// time. Two paths renew it — magpie's auth.refresh and the check-in when the
// access token is refused — so the exchange in flight is shared, whatever
// asked for it. When the rotated tokens could not be saved, they are kept in
// memory against the spent refresh token: that token is dead on the vendor's
// side, and answering from memory beats spending it again and being told the
// sign-in is invalid.

import { post } from "./api.mjs"
import { businessCode, checkBusiness } from "./errors.mjs"
import { claims, REFRESH_PATH, REFRESH_FALLBACK_PATH, stripBearer, text, tokenValid } from "./util.mjs"

const SHARE_MS = 60_000
const ROTATED_MEMO_MAX = 50
const REFRESH_FALLBACK_CODE = 400_002

/** 在途与刚完成的续期：refreshToken → { at, pending, promise } */
const gates = new Map()
/** 已花费的 refreshToken → 续期结果。 */
const rotated = new Map()

export function resetRefresh() {
  gates.clear()
  rotated.clear()
}

/** 账号自己的设备 id：登录时随请求发出的那个，服务端写进了 token 的 device_id claim。 */
export function deviceIdOf(auth) {
  return (
    [auth?.deviceId, claims(auth?.access)?.device_id, claims(auth?.refresh)?.device_id]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) ?? ""
  )
}

/** 一次上游续期；只在业务码 400002 时改走备用路径。 */
export async function refreshOnce(refreshToken, { access, deviceId, options = {} }) {
  const body = { refresh_token: refreshToken, source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) }
  let payload = await post(REFRESH_PATH, access ?? "", body, "续期", options)
  if (businessCode(payload) === REFRESH_FALLBACK_CODE) {
    payload = await post(REFRESH_FALLBACK_PATH, access ?? "", body, "备用续期", options)
  }
  checkBusiness(payload, "续期")
  const nextAccess = stripBearer(text(payload.data ?? {}, ["access_token"]))
  const nextRefresh = stripBearer(text(payload.data ?? {}, ["refresh_token"]))
  if (!tokenValid(nextAccess, false)) {
    throw Object.assign(new Error("AutoClaw 续期没有返回有效访问令牌"), { status: 502, signIn: "kept" })
  }
  if (!tokenValid(nextRefresh, true)) {
    throw Object.assign(new Error("AutoClaw 续期返回的刷新凭据无效"), { status: 502, signIn: "kept" })
  }
  if (nextAccess.startsWith("enc:") || nextRefresh.startsWith("enc:")) {
    throw Object.assign(new Error("AutoClaw 续期返回了非预期凭据形态，未调用本机解密"), { status: 502, signIn: "kept" })
  }
  return { access: nextAccess, refresh: nextRefresh || refreshToken }
}

function rememberRotated(spent, fresh) {
  rotated.delete(spent)
  rotated.set(spent, fresh)
  while (rotated.size > ROTATED_MEMO_MAX) {
    const oldest = rotated.keys().next().value
    if (oldest === undefined) break
    rotated.delete(oldest)
  }
}

/**
 * 续期，同一 refresh token 单飞。
 * 返回 { access, refresh, expires? }，是要合并进账号的字段（magpie 的 refresh 钩子契约）。
 */
export async function refreshShared(auth, options = {}) {
  const spent = stripBearer(String(auth?.refresh ?? ""))
  if (!spent || !tokenValid(spent, false)) {
    throw Object.assign(new Error("AutoClaw: 这份凭据没有刷新令牌，请重新登录"), { signIn: "expired" })
  }
  const deviceId = deviceIdOf(auth)
  const memo = rotated.get(spent)
  if (memo) {
    // 兜底的新 access token 也会到期：到期就别再喂给调用方，拿兜底里轮换出的新 RT 走一次真刷新。
    // 没有到期时间的令牌按仍有效处理：再花一次 RT 只会把刚轮换出来的令牌又作废掉。
    if (typeof memo.expires !== "number" || memo.expires > Date.now()) return memo
    rotated.delete(spent)
    return refreshShared({ ...auth, refresh: memo.refresh }, options)
  }
  const held = gates.get(spent)
  if (held && (held.pending || Date.now() - held.at < SHARE_MS)) return held.promise
  // 顺手淘汰已过期且不在途的条目，避免长驻进程里无限堆积（含令牌）。
  for (const [key, gate] of gates) {
    if (!gate.pending && Date.now() - gate.at >= SHARE_MS) gates.delete(key)
  }
  const gate = { at: Date.now(), pending: true, promise: null }
  gate.promise = (async () => {
    try {
      const fresh = await refreshOnce(spent, { access: stripBearer(String(auth?.access ?? "")), deviceId, options })
      const expires = claims(fresh.access)?.exp
      const result = {
        access: fresh.access,
        refresh: fresh.refresh,
        ...(typeof expires === "number" && expires > 0 ? { expires: expires * 1000 - 600_000 } : {}),
      }
      gate.pending = false
      gate.at = Date.now()
      // 成功即记：旧 RT 已被服务端作废。之后仍拿着旧 RT 的调用方必须直接拿到这对令牌。
      rememberRotated(spent, result)
      return result
    } catch (error) {
      // 只摘自己：并发重建的 gate 不能被旧的失败回调误删。
      if (gates.get(spent) === gate) gates.delete(spent)
      // 续期被拒是登录态失效；其它失败（网络、上游 5xx）不标失效，30 秒后可再试。
      if (error?.kind === "token_expired") error.signIn = "expired"
      else if (!error.signIn) error.signIn = "kept"
      throw error
    }
  })()
  gates.set(spent, gate)
  return gate.promise
}
