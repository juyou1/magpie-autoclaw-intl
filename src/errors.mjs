// Errors (errors.rs) and the business envelope of the international API
// (client.rs). Four classes: the sign-in refused, quota, content policy, and
// everything else as a plain upstream failure. A 403 is not always the
// sign-in: the gateway answers a spent free quota and a banned account with
// 403 too.

import { integer, text } from "./util.mjs"

const MAX_DETAIL_CHARS = 4096
const MESSAGE_KEYS = ["msg", "message", "detail", "error_msg", "error_description", "reason"]
/** 业务码：登录态被拒。 */
const AUTH_CODES = new Set([401, 410_000, 400_000])
/** 业务码：额度 / 高负载。 */
const QUOTA_CODES = new Set([810_000, 810_001])
/** 业务码：账号被封。 */
const BANNED_CODE = 410_004
const CONTENT_WORDS = ["blocked by security policy", "unapproved channel", "illegal api invocation"]

/**
 * 上游拒绝。status 是交给网关的 HTTP 状态，kind 是四档之一
 * (token_expired | quota_limited | content_blocked | fatal)，
 * signIn 对应 X-Magpie-Sign-In：只有凭据被拒才是 expired。
 */
export class UpstreamError extends Error {
  constructor(message, { status = 502, code, upstreamCode, kind = "fatal" } = {}) {
    super(message)
    this.name = "UpstreamError"
    this.status = status
    this.code = code
    this.upstreamCode = upstreamCode
    this.kind = kind
    this.signIn = kind === "token_expired" ? "expired" : "kept"
  }
}

function truncate(value) {
  return String(value ?? "").trim().slice(0, MAX_DETAIL_CHARS)
}

/** parseBody：上游响应体；非 JSON 时保留原文以便排查。 */
export function parseBody(raw) {
  const value = typeof raw === "string" ? raw : String(raw ?? "")
  if (!value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return truncate(value)
  }
}

/** code：上游业务码，兼容顶层与 error 内的几种写法（只认整数或整数字符串）。 */
export function businessCode(body) {
  if (!body || typeof body !== "object") return undefined
  for (const candidate of [body.upstream_code, body.upstreamCode, body.code, body.error?.code, body.error?.upstreamCode, body.error?.upstream_code]) {
    const code = integer(candidate)
    if (code !== undefined) return code
  }
  return undefined
}

function message(body) {
  if (!body) return ""
  for (const candidate of [body, body.error, body.data]) {
    const found = text(candidate, MESSAGE_KEYS)
    if (found) return found
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return ""
}

/** rawDetail：上游的报错原文；没有常见文本字段时回退完整 JSON。 */
export function rawDetail(body) {
  const found = message(body)
  if (found) return truncate(found)
  if (body === null || body === undefined) return ""
  return truncate(typeof body === "string" ? body : JSON.stringify(body))
}

export function appendDetail(base, body) {
  const detail = rawDetail(body)
  if (!detail || base.includes(detail)) return base
  return `${base}：${detail}`
}

/** hasError：SSE 事件或响应体是否带错误。 */
export function hasError(body) {
  if (!body || typeof body !== "object") return false
  const code = businessCode(body)
  return (body.error !== undefined && body.error !== null) || body.type === "error" || (code !== undefined && code !== 0)
}

/** classify：把一次上游回答归到四档之一，并给出归一后的状态。 */
export function classify(status, body) {
  const raw = message(body).toLowerCase()
  const failure = status >= 400 && status < 600 ? status : 502
  const upstream = businessCode(body)
  let kind
  let out
  let hint
  if (upstream === BANNED_CODE) {
    kind = "fatal"
    out = 403
    hint = "AutoClaw 国际版账号被上游停用或封禁，重新登录不能解除，请联系官方处理"
  } else if (upstream === 810_000) {
    kind = "quota_limited"
    out = 429
    hint = "AutoClaw 国际版当前模型的免费额度已用完；其他模型可能仍可使用，请检查官方额度或套餐"
  } else if (upstream === 810_001) {
    kind = "quota_limited"
    out = 429
    hint = "AutoClaw 国际版当前模型高负载或服务配额受限，请稍后重试；不会当作登录失效"
  } else if (status === 401 || (upstream !== undefined && AUTH_CODES.has(upstream))) {
    kind = "token_expired"
    out = 401
    hint = "AutoClaw 凭据被上游拒绝，请续期或重新登录"
  } else if (status === 429) {
    kind = "quota_limited"
    out = 429
    hint = "AutoClaw 上游额度或频率受限，请稍后重试"
  } else if (
    body?.code === "content_filter" ||
    body?.error?.code === "content_filter" ||
    body?.providerCode === "content_filter" ||
    (status >= 400 && CONTENT_WORDS.some((p) => raw.includes(p)))
  ) {
    kind = "content_blocked"
    out = failure
    hint = "AutoClaw 上游内容策略拒绝，不是账号额度问题；请调整系统提示或对话内容"
  } else {
    kind = "fatal"
    out = failure
    hint = `AutoClaw 上游请求失败（HTTP ${status}）`
  }
  return { kind, status: out, message: appendDetail(hint, body), upstreamCode: upstream }
}

/** upstreamError：由 HTTP 状态与响应体构造错误（状态按 classify 归一）。 */
export function upstreamError(status, body) {
  const c = classify(status, body)
  return new UpstreamError(c.message, {
    status: c.status,
    code: c.kind === "content_blocked" ? "content_filter" : c.upstreamCode !== undefined ? String(c.upstreamCode) : "upstream_error",
    upstreamCode: c.upstreamCode,
    kind: c.kind,
  })
}

/** 406 没有原因时附上的说明（prompt.rs UPSTREAM_406_HINT）。 */
export const UPSTREAM_406_HINT =
  "；国际版上游拒收（406）且未给出原因。系统提示与请求头已按当前客户端规范处理，" +
  "不被接受的 max_tokens/max_completion_tokens 不会发送；如果仍复现，请提供脱敏请求以核对，或改用其它提供商。" +
  "不会把未知拒收当成额度不足或自动修改用户对话。"

/** classify 的 406 特例：上游拒收请求且没有给任何文案。 */
export function refusedWithoutReason(status, body) {
  return status === 406 && !message(body)
}

/**
 * 业务信封检查（client.rs business / strict_business）。
 * - 有 code：0 成功；401/410000/400000 是登录态（401），810000/810001 是额度（429），
 *   410004 是封禁（403），其余 502。
 * - 没有 code：带非空 error 或 type=error 失败；带 data 的旧响应（task-complete 等）成功。
 * 失败抛 UpstreamError，成功返回 payload 本身。
 */
export function checkBusiness(payload, operation = "请求") {
  const code = businessCode(payload)
  if (code === undefined) {
    if (hasError(payload)) throw upstreamError(502, payload)
    if (payload?.data !== undefined && payload?.data !== null) return payload
  }
  if ((payload?.error !== undefined && payload?.error !== null) || payload?.type === "error") {
    throw upstreamError(502, payload)
  }
  if (code === 0) return payload
  const codeText = code === undefined ? "未返回" : String(code)
  let status = 502
  let kind = "fatal"
  let hint = `AutoClaw ${operation}未完成（业务码 ${codeText}）`
  if (code !== undefined && AUTH_CODES.has(code)) {
    status = 401
    kind = "token_expired"
    hint = `AutoClaw 登录态已失效，无法${operation}（业务码 ${codeText}）`
  } else if (code !== undefined && QUOTA_CODES.has(code)) {
    status = 429
    kind = "quota_limited"
  } else if (code === BANNED_CODE) {
    status = 403
  }
  throw new UpstreamError(appendDetail(hint, payload), {
    status,
    code: code === undefined ? "upstream_error" : String(code),
    upstreamCode: code,
    kind,
  })
}
