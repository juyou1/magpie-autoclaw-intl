// One request to the international API (client.rs). Every call goes to
// ORIGIN only; nothing falls back to the CN site. A failure names the action,
// the HTTP status and the business code, and never an upstream sentence that
// could carry an account token.

import { activeHeaders, signedHeaders } from "./headers.mjs"
import { appendDetail, parseBody, UpstreamError, upstreamError } from "./errors.mjs"
import { ORIGIN } from "./util.mjs"

const TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

function timeoutSignal(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readLimited(response, operation) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new UpstreamError(`AutoClaw ${operation}响应超过 ${MAX_BODY_BYTES >> 20} MiB`, { status: 502 })
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/**
 * request：一次请求，返回 { status, body }（body 已解析；不是 JSON 时是原文）。
 * 网络错误抛 UpstreamError(502)；成败由调用方按状态与业务码判断。
 */
export async function request(method, path, { token = "", body, headers, operation = "请求", signal, fetchImpl } = {}) {
  let response
  try {
    response = await (fetchImpl ?? fetch)(`${ORIGIN}${path}`, {
      method,
      headers: new Headers(headers ?? signedHeaders(token)),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: timeoutSignal(signal),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    const raw = String(cause?.message ?? cause).trim()
    throw new UpstreamError(raw ? `AutoClaw ${operation}连接失败：${raw}` : `AutoClaw ${operation}连接失败或响应中断`, { status: 502 })
  }
  let bytes
  try {
    bytes = await readLimited(response, operation)
  } catch (cause) {
    if (cause instanceof UpstreamError) throw cause
    throw new UpstreamError(`AutoClaw ${operation}连接失败：${cause?.message ?? cause}`, { status: 502 })
  }
  return { status: response.status, body: parseBody(new TextDecoder().decode(bytes)) }
}

/** 2xx 且响应体是 JSON 对象才成功，否则抛错；成功返回响应体。 */
function httpOk(reply, operation) {
  if (reply.status < 200 || reply.status >= 300) throw upstreamError(reply.status, reply.body)
  if (!reply.body || typeof reply.body !== "object") {
    throw new UpstreamError(appendDetail(`AutoClaw ${operation}未返回有效 JSON（HTTP ${reply.status}）`, reply.body), { status: 502 })
  }
  return reply.body
}

/** 业务路由的 GET（带签名头与账号 token）。 */
export async function get(path, token, operation, options = {}) {
  return httpOk(await request("GET", path, { token, operation, ...options }), operation)
}

/** 业务路由的 POST。 */
export async function post(path, token, body, operation, options = {}) {
  return httpOk(await request("POST", path, { token, body, operation, ...options }), operation)
}

/** 登录活跃触发：带 AutoClaw20 桌面指纹调 user-info，活动奖励据此入账。 */
export async function activate(token, deviceId, options = {}) {
  const operation = "登录活跃触发"
  return httpOk(
    await request("POST", "/userapi/v1/user-info", {
      headers: activeHeaders(token),
      body: { source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) },
      operation,
      ...options,
    }),
    operation,
  )
}
