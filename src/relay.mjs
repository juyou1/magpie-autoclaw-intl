// One chat request, from the agent's body to the Response handed back to the
// gateway (chat.rs forward()).
//
// The vendor is always asked for a stream. An agent that asked for one gets
// it chunk by chunk, with the model name put back to the one it asked for. An
// agent that didn't gets the answer assembled into a single completion.
//
// Nothing is sent to the agent until the vendor's first real content: a
// refusal that comes back as HTTP status, as a JSON body, or as an event in
// the stream is reported with the status it should have.

import { prepareBody, sessionId, StreamOutput } from "./chat.mjs"
import { UpstreamError, upstreamError } from "./errors.mjs"
import { chatHeaders } from "./headers.mjs"
import { CHAT_PATH, ORIGIN, uuid } from "./util.mjs"

/** agent 在请求体里写的模型名；回复里改回它。 */
function requestedModelOf(body) {
  try {
    const model = JSON.parse(body).model
    return typeof model === "string" && model ? model : ""
  } catch {
    return ""
  }
}

function wantsStreamOf(body) {
  try {
    return JSON.parse(body).stream !== false
  } catch {
    return true
  }
}

/** 流已经发出去了，改不了状态码：把拒绝作为最后一个事件交给 agent。 */
function errorEvent(error) {
  const status = error?.status ?? 502
  return {
    error: {
      message: error?.message ?? "AutoClaw 上游请求失败",
      status,
      code: error?.code ?? null,
      upstreamCode: error?.upstreamCode ?? null,
      type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "upstream_error",
    },
  }
}

const ERROR_TYPE = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error" }

/** 拒绝的状态：响应体里 error.status 或 status。 */
function statusOf(body) {
  for (const candidate of [body?.error?.status, body?.status]) {
    if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) return candidate
  }
  return null
}

/** 上游的拒绝，按 Chat Completions 的错误形态交给网关。 */
export function errorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502
  return new Response(
    JSON.stringify({
      error: {
        message: error?.message ?? "AutoClaw 上游请求失败",
        type: ERROR_TYPE[status] ?? "upstream_error",
        code: error?.code ?? null,
        upstreamCode: error?.upstreamCode ?? null,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        // 只有凭据被拒才是 expired；额度、封禁、内容策略与未知失败都保留登录。
        "X-Magpie-Sign-In": error?.signIn ?? (status === 401 ? "expired" : "kept"),
      },
    },
  )
}

/** 逐块读上游的流，过 StreamOutput，产出要发给 agent 的事件文本。 */
async function* relayEvents(response, output) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      for (const event of output.push(done ? "" : decoder.decode(value, { stream: true }))) yield event
      if (done) {
        for (const event of output.end()) yield event
        return
      }
    }
  } finally {
    reader.releaseLock()
    try {
      await reader.cancel().catch(() => {})
    } catch {
      // 已取消
    }
  }
}

/** 事件文本 → 其中的 JSON 值（[DONE] 除外）。 */
function valuesOf(event) {
  const out = []
  for (const block of event.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      out.push(JSON.parse(data))
    }
  }
  return out
}

/** 事件流 → 一个非流式 completion。 */
export function assembleCompletion(values, model) {
  const out = { id: "", object: "chat.completion", created: 0, model, choices: [] }
  const toolCalls = new Map()
  for (const value of values) {
    if (!out.id && value.id) out.id = value.id
    if (!out.created && value.created) out.created = value.created
    if (value.usage) out.usage = value.usage
    for (const choice of Array.isArray(value.choices) ? value.choices : []) {
      const index = Number.isInteger(choice?.index) ? choice.index : 0
      let target = out.choices[index]
      if (!target) {
        out.choices[index] = target = { index, message: { role: "assistant", content: "" }, finish_reason: null }
      }
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {}
      if (typeof delta.content === "string") target.message.content += delta.content
      if (typeof delta.reasoning_content === "string") target.message.reasoning_content = (target.message.reasoning_content ?? "") + delta.reasoning_content
      if (typeof delta.role === "string") target.message.role = delta.role
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const at = Number.isInteger(call?.index) ? call.index : 0
        const held = toolCalls.get(at) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
        if (typeof call.id === "string") held.id += call.id
        if (typeof call.function?.name === "string") held.function.name += call.function.name
        if (typeof call.function?.arguments === "string") held.function.arguments += call.function.arguments
        toolCalls.set(at, held)
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) target.finish_reason = choice.finish_reason
    }
  }
  out.choices = out.choices.filter(Boolean)
  if (toolCalls.size && out.choices[0]) {
    out.choices[0].message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    if (!out.choices[0].message.content) out.choices[0].message.content = null
  }
  return out
}

/**
 * 发送一次对话请求，返回交给网关的 Response。
 * 拒绝在首个内容之前到达时抛 UpstreamError，由调用方转成 errorResponse()。
 */
export async function sendChat({ init, token, account, catalog, defaultRoute, fetchImpl, platform, arch }) {
  const send = fetchImpl ?? fetch
  const requested = requestedModelOf(init?.body)
  const prepared = prepareBody(init?.body, { catalog, defaultRoute })
  const wantsStream = wantsStreamOf(init?.body)

  // 调用方的会话标识只用来派生上游会话 id（和账号一起做摘要）：宿主的会话 id 与消息原文都不进请求头。
  // 其余请求头由这里按官方指纹重新生成，agent 自己的头不出插件。
  const incoming = new Headers(init?.headers ?? {})
  const hostSession = incoming.get("x-autoclaw-session-id")
  const session = sessionId({ account, session: hostSession, body: prepared.body }) ?? uuid()
  const headers = chatHeaders({ token, route: prepared.route, session, platform, arch })

  let response
  try {
    response = await send(`${ORIGIN}${CHAT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(prepared.body),
      redirect: "error",
      signal: init?.signal,
    })
  } catch (cause) {
    if (init?.signal?.aborted) throw cause
    throw new UpstreamError(`AutoClaw 对话连接失败：${cause?.message ?? cause}`, { status: 502 })
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  // 非 2xx，或 2xx 但回了 JSON：拒绝在响应体里。
  if (response.status < 200 || response.status >= 300 || contentType.includes("application/json")) {
    const text = await response.text().catch(() => "")
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    if (response.ok) {
      // 状态码正常但回了 JSON：拒绝的状态在响应体里（error.status 或 status），没有就是 502。
      if (body && typeof body === "object") throw upstreamError(statusOf(body) ?? 502, body)
      throw new UpstreamError(`AutoClaw 上游未返回事件流：${text.slice(0, 200)}`, { status: 502 })
    }
    throw upstreamError(response.status, body)
  }
  if (contentType.includes("text/html")) {
    const text = await response.text().catch(() => "")
    throw new UpstreamError(`AutoClaw 返回网页而不是模型结果：${text.slice(0, 200)}`, { status: 502 })
  }

  const model = requested || prepared.requested
  const output = new StreamOutput({ model })
  const events = relayEvents(response, output)
  // StreamOutput 把控制帧缓冲到首个有效内容，所以第一个产出的事件意味着回答已经开始。
  // 在那之前到达的拒绝（状态码、JSON 体、或流里的错误事件）都还有正确的状态码可用。
  const first = await events.next()
  if (first.done) {
    throw Object.assign(new UpstreamError("AutoClaw 上游流提前中断，未收到完成标记", { status: 502 }), { code: "runtime_stream_interrupted" })
  }

  const rest = (async function* () {
    yield first.value
    yield* events
  })()

  if (wantsStream) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of rest) controller.enqueue(encoder.encode(event))
        } catch (error) {
          // 流已经开始，改不了状态码：拒绝作为最后一个事件交给 agent。
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent(error))}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Magpie-Sign-In": "kept" },
    })
  }

  const values = []
  for await (const event of rest) values.push(...valuesOf(event))
  return new Response(JSON.stringify(assembleCompletion(values, model)), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
  })
}
