// The chat request and its stream (chat.rs).
//
// What an agent's history can hold that the overseas chat gateway can't read
// is put right before the request leaves: a message's null or missing content
// goes as "", an earlier turn's reasoning_content is carried in the message
// text instead (the gateway can't parse the field), a tool call's arguments
// that aren't a string go as their JSON, and tools that aren't a non-empty
// list are left off with their tool_choice. The output budget fields are
// dropped: the gateway doesn't accept them. User content, tool calls, images
// and turn order are kept.
//
// The stream: the answer's events are passed on as they come, with the model
// name put back to the one the agent asked for. Events that carry nothing
// but control frames are held until the first productive one, so a refusal
// that arrives as a stream is still reported as an error. A stream that ends
// without a finish reason is an error, not a made-up success.

import { hasError, upstreamError } from "./errors.mjs"
import { normalizePrompt } from "./prompt.mjs"
import { hash, printable, resolveRoute } from "./util.mjs"

const PROVIDER = "autoclaw-intl"
/** max_tokens / max_completion_tokens 上游不接受。 */
const BUDGET_FIELDS = ["max_tokens", "max_completion_tokens"]
const CLIENT_SESSION_HEADERS = ["x-autoclaw-session-id", "x-autoclaw-agent-id", "x-autoclaw-zcode-invocation-id"]

function truthy(value) {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value !== ""
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** 增量里除 role 以外是否有非空内容。 */
function productiveDelta(delta) {
  if (!delta || typeof delta !== "object") return false
  return Object.entries(delta).some(([key, part]) => key !== "role" && truthy(part))
}

/** 历史消息整理（就地修改 body）。 */
export function normalizeHistory(body) {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("AutoClaw 国际版请求必须包含非空消息历史"), { status: 400 })
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      throw Object.assign(new Error("AutoClaw 历史消息必须是对象"), { status: 400 })
    }
    if (typeof message.role !== "string" || !message.role) {
      throw Object.assign(new Error("AutoClaw 历史消息缺少角色"), { status: 400 })
    }
    if (message.content === undefined || message.content === null) message.content = ""
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw Object.assign(new Error("AutoClaw 消息正文必须是文本或多模态数组"), { status: 400 })
    }
    // 两个地区的网关都不能解析这个历史字段；改换载体而不丢掉原思考内容。
    const reasoning = message.reasoning_content
    if (reasoning !== undefined && reasoning !== null) {
      if (typeof reasoning !== "string") {
        throw Object.assign(new Error("AutoClaw 历史思考必须是文本"), { status: 400 })
      }
      if (reasoning) {
        const prefix = `[Previous reasoning]\n${reasoning}\n[/Previous reasoning]\n\n`
        if (typeof message.content === "string") message.content = prefix + message.content
        else message.content.unshift({ type: "text", text: prefix })
      }
      delete message.reasoning_content
    }
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls)) {
        throw Object.assign(new Error("AutoClaw 历史工具调用必须是数组"), { status: 400 })
      }
      for (const call of message.tool_calls) {
        const fn = call && typeof call === "object" ? call.function : null
        if (!fn || typeof fn !== "object") {
          throw Object.assign(new Error("AutoClaw 历史工具调用缺少工具说明"), { status: 400 })
        }
        if (typeof fn.name !== "string" || !fn.name) {
          throw Object.assign(new Error("AutoClaw 历史工具调用缺少工具名称"), { status: 400 })
        }
        if (typeof fn.arguments !== "string") {
          fn.arguments = fn.arguments === undefined || fn.arguments === null ? "{}" : JSON.stringify(fn.arguments)
        }
      }
    }
  }
  // 空列表或 null 连同 tool_choice 一起去掉。
  if (body.tools === null || (Array.isArray(body.tools) && body.tools.length === 0)) {
    delete body.tools
    delete body.tool_choice
  } else if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw Object.assign(new Error("AutoClaw 工具声明必须是数组"), { status: 400 })
  }
  return body
}

/**
 * 出站前的请求体：整理历史、解析路由、强制流式、去掉不接受的字段、规范化系统提示。
 * 返回 { body, route, requested }。
 */
export function prepareBody(rawBody, { catalog, defaultRoute }) {
  let body
  try {
    body = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody ?? new Uint8Array()))
  } catch {
    throw Object.assign(new Error("AutoClaw 请求体必须是 JSON 对象"), { status: 400 })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("AutoClaw 请求体必须是对象"), { status: 400 })
  }
  normalizeHistory(body)
  const { route, requested } = resolveRoute(body.model, catalog, defaultRoute)
  body.model = route
  body.stream = true
  for (const field of BUDGET_FIELDS) delete body[field]
  normalizePrompt(body)
  delete body.metadata
  return { body, route, requested }
}

/** 只含换行的保活帧：没有 error / usage，每个 choice 的 delta 只有换行 content。 */
export function newlineOnly(value) {
  if (!value || typeof value !== "object") return false
  if (value.error !== undefined || (value.usage !== undefined && value.usage !== null)) return false
  const choices = Array.isArray(value.choices) ? value.choices : []
  if (!choices.length) return false
  return choices.every((choice) => {
    if (truthy(choice?.finish_reason)) return false
    const delta = choice?.delta
    if (!delta || typeof delta !== "object") return false
    const content = typeof delta.content === "string" ? delta.content : ""
    if (!content || !/^[\r\n]+$/.test(content)) return false
    return !Object.entries(delta).some(([key, part]) => key !== "content" && key !== "role" && truthy(part))
  })
}

/**
 * 上游的 SSE 文本流。push() 喂入文本片段，返回现在可以发给 agent 的事件（字符串数组）。
 * 流的正常结束由 end() 判定：没收到完整结束原因就抛错。
 */
export class StreamOutput {
  constructor({ model, stripNewlineKeepalive = false } = {}) {
    this.model = model
    this.strip = stripNewlineKeepalive === true
    this.buffer = ""
    this.pending = []
    this.pendingBytes = 0
    this.choices = new Map()
    this.started = false
    this.done = false
  }

  /** 喂入一段文本；返回现在可以发出的 SSE 事件（含 data: 前缀与空行）。 */
  push(text) {
    this.buffer += text
    const out = []
    for (;;) {
      // SSE 事件以空行结束；CRLF 与 LF 都认。
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const raw = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.event(raw, out)
      if (this.done) break
    }
    return out
  }

  /** 上游关流；没等到 [DONE] 就是中断。返回最后可发的事件（可为空）。 */
  end() {
    const tail = []
    // 最后一个事件没有结尾空行时也补发。
    if (!this.done && this.buffer.trim()) {
      const rest = this.buffer
      this.buffer = ""
      this.event(rest, tail)
    }
    if (!this.done) {
      throw Object.assign(new Error("AutoClaw 上游流提前中断，未收到完成标记"), { status: 502, code: "runtime_stream_interrupted" })
    }
    return tail
  }

  /** 一个完整事件块；要发出的文本都追加到 out。 */
  event(block, out) {
    if (this.done) return
    // 只取 data: 行；注释与 event: / id: 行不参与。
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data) return
    if (data.trim() === "[DONE]") {
      if (this.choices.size === 0 || ![...this.choices.values()].every(Boolean)) {
        throw Object.assign(new Error("AutoClaw 未返回完整结束原因，未伪造成功完成"), { status: 502 })
      }
      this.flush(out)
      this.done = true
      out.push("data: [DONE]\n\n")
      return
    }
    let value
    try {
      value = JSON.parse(data)
    } catch {
      throw Object.assign(new Error("AutoClaw SSE 事件格式无效"), { status: 502 })
    }
    if (hasError(value)) {
      const status = Number.isInteger(value?.error?.status) ? value.error.status : Number.isInteger(value?.status) ? value.status : 502
      throw upstreamError(status, value)
    }
    const choices = Array.isArray(value.choices) ? value.choices : null
    if (!choices) throw Object.assign(new Error("AutoClaw SSE 事件缺少 choices"), { status: 502 })
    let hasProductive = false
    choices.forEach((choice, at) => {
      const index = Number.isInteger(choice?.index) ? choice.index : at
      if (choice?.finish_reason === "content_filter" || choice?.finish_reason === "content_policy_violation") {
        throw upstreamError(200, { code: "content_filter" })
      }
      const finished = typeof choice?.finish_reason === "string" && choice.finish_reason !== ""
      this.choices.set(index, (this.choices.get(index) ?? false) || finished)
      hasProductive ||= finished || productiveDelta(choice?.delta)
    })
    if (this.strip && newlineOnly(value)) return
    // 回复原样改回 agent 请求的模型名。
    value.model = this.model
    const line = `data: ${JSON.stringify(value)}\n\n`
    if (this.started) {
      out.push(line)
      return
    }
    // 首个有效内容之前先缓冲控制帧：上游以流的形式回错误时，还能把它当错误报出来。
    this.pendingBytes += line.length
    if (this.pending.length >= 128 || this.pendingBytes > 1024 * 1024) {
      throw Object.assign(new Error("AutoClaw 仅返回控制帧，没有有效模型内容"), { status: 502 })
    }
    this.pending.push(line)
    if (hasProductive) this.flush(out)
  }

  /** 把缓冲的控制帧发出，并从此直通。 */
  flush(out) {
    out.push(...this.pending)
    this.pending = []
    this.pendingBytes = 0
    this.started = true
  }
}

/** 由 SHA-256 摘要拼一个 UUID 形态的会话 id（版本位 4、变体位 8..b）。 */
export function deriveSession(parts) {
  const digest = hash(JSON.stringify(parts))
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/**
 * 会话关联 id：官方客户端每轮都带同一个 X-Session-Id。
 * 有宿主会话标识就用它，否则由首个非系统消息推导（多轮稳定）；都没有则返回 null（调用方新生成）。
 * 两种来源都和账号一起做摘要：发给上游的是派生值，宿主的会话标识与消息内容原文都不进请求头。
 */
export function sessionId({ account, session, body }) {
  if (session) return deriveSession([PROVIDER, account, session])
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const first = messages.find((message) => message && message.role !== "system" && message.role !== "developer")
  if (!first) return null
  return deriveSession([PROVIDER, account, first])
}

/** 调用方经请求头带来的会话关联头，只收三个已知名字、可打印的短串。 */
export function clientSessionHeaders(input) {
  const out = {}
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase()
    if (!CLIENT_SESSION_HEADERS.includes(lower) || typeof value !== "string") continue
    const trimmed = value.trim()
    if (!trimmed) continue
    if (!printable(trimmed, 2048)) {
      throw Object.assign(new Error("AutoClaw 会话关联头格式无效"), { status: 400 })
    }
    out[lower] = trimmed
  }
  return out
}
