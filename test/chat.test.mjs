import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_ROUTE } from "../src/catalog.mjs"
import { clientSessionHeaders, deriveSession, newlineOnly, normalizeHistory, prepareBody, sessionId, StreamOutput } from "../src/chat.mjs"
import { IDENTITY_LINE } from "../src/prompt.mjs"

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`
const delta = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content, ...extra } }] })
const finish = (reason = "stop") => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/

test("normalizeHistory: what the gateway can't read is put right, and nothing is lost", () => {
  const { messages } = normalizeHistory({
    messages: [
      { role: "system", content: "sys" },
      { role: "user" },
      {
        role: "assistant",
        content: "a",
        reasoning_content: "thinking about it",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "a2" }],
        reasoning_content: "t2",
        tool_calls: [
          { id: "1", type: "function", function: { name: "read", arguments: { path: "x" } } },
          { id: "2", type: "function", function: { name: "ls" } },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "out" },
    ],
  })
  assert.equal(messages[0].content, "sys")
  assert.equal(messages[1].content, "")
  assert.equal(messages[2].content, "[Previous reasoning]\nthinking about it\n[/Previous reasoning]\n\na")
  assert.equal("reasoning_content" in messages[2], false)
  assert.equal(messages[3].content[0].text, "[Previous reasoning]\nt2\n[/Previous reasoning]\n\n")
  assert.equal(messages[3].content[1].text, "a2")
  assert.equal(messages[3].tool_calls[0].function.arguments, JSON.stringify({ path: "x" }))
  assert.equal(messages[3].tool_calls[1].function.arguments, "{}")
  assert.deepEqual(messages[4], { role: "tool", tool_call_id: "1", content: "out" })
})

test("normalizeHistory: empty reasoning, and tools that aren't a list", () => {
  const noReasoning = normalizeHistory({ messages: [{ role: "assistant", content: "a", reasoning_content: "" }] })
  assert.equal(noReasoning.messages[0].content, "a")
  assert.equal("reasoning_content" in noReasoning.messages[0], false)

  const emptyTools = normalizeHistory({ messages: [{ role: "user", content: "x" }], tools: [], tool_choice: "auto" })
  assert.equal("tools" in emptyTools, false)
  assert.equal("tool_choice" in emptyTools, false)
  const nullTools = normalizeHistory({ messages: [{ role: "user", content: "x" }], tools: null })
  assert.equal("tools" in nullTools, false)

  const kept = normalizeHistory({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f" } }], tool_choice: "auto" })
  assert.equal(kept.tools.length, 1)
  assert.equal(kept.tool_choice, "auto")
})

test("normalizeHistory: what is refused", () => {
  assert.throws(() => normalizeHistory({ messages: [] }), /非空消息历史/)
  assert.throws(() => normalizeHistory({}), /非空消息历史/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user", content: 5 }] }), /文本或多模态数组/)
  assert.throws(() => normalizeHistory({ messages: [{ content: "x" }] }), /缺少角色/)
  assert.throws(() => normalizeHistory({ messages: ["text"] }), /历史消息必须是对象/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user", reasoning_content: 5 }] }), /历史思考必须是文本/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user", tool_calls: "x" }] }), /工具调用必须是数组/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user", tool_calls: [{}] }] }), /缺少工具说明/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user", tool_calls: [{ function: {} }] }] }), /缺少工具名称/)
  assert.throws(() => normalizeHistory({ messages: [{ role: "user" }], tools: "x" }), /工具声明必须是数组/)
})

test("prepareBody: route, streaming, dropped fields and the system prefix", () => {
  const p = prepareBody(
    JSON.stringify({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 500,
      max_completion_tokens: 900,
      metadata: { a: 1 },
      stream: false,
    }),
    { catalog: { models: [{ id: "glm-5.3", routeId: "zaicoding_glm-5.3" }] }, defaultRoute: DEFAULT_ROUTE },
  )
  assert.equal(p.route, "zaicoding_glm-5.3")
  assert.equal(p.requested, "glm-5.3")
  assert.equal(p.body.model, "zaicoding_glm-5.3")
  assert.equal(p.body.stream, true)
  for (const field of ["max_tokens", "max_completion_tokens", "metadata"]) assert.equal(field in p.body, false)
  assert.deepEqual(p.body.messages, [{ role: "system", content: `${IDENTITY_LINE}\n` }, { role: "user", content: "hi" }])
})

test("prepareBody: an unknown name falls back to the default route, and bytes are accepted", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ model: "unknown", messages: [{ role: "user", content: "hi" }] }))
  const p = prepareBody(bytes, { catalog: null, defaultRoute: DEFAULT_ROUTE })
  assert.equal(p.route, DEFAULT_ROUTE)
  // the name the agent asked for is kept, so the reply names that model
  assert.equal(p.requested, "unknown")
  assert.equal(p.body.model, DEFAULT_ROUTE)
  assert.throws(() => prepareBody("not json", { catalog: null, defaultRoute: DEFAULT_ROUTE }), /必须是 JSON 对象/)
  assert.throws(() => prepareBody("[1]", { catalog: null, defaultRoute: DEFAULT_ROUTE }), /必须是对象/)
})

test("newlineOnly: a keep-alive frame and what isn't one", () => {
  assert.equal(newlineOnly(delta("\n")), true)
  assert.equal(newlineOnly(delta("\r\n\r")), true)
  assert.equal(newlineOnly(delta("\nhello")), false)
  assert.equal(newlineOnly(delta("", { reasoning_content: "x" })), false)
  assert.equal(newlineOnly({ choices: [{ index: 0, delta: { content: "\n" }, finish_reason: "stop" }] }), false)
  assert.equal(newlineOnly({ ...delta("\n"), usage: { total_tokens: 1 } }), false)
  assert.equal(newlineOnly({ ...delta("\n"), error: { message: "x" } }), false)
  assert.equal(newlineOnly({ choices: [] }), false)
  assert.equal(newlineOnly(null), false)
})

test("stream: a normal answer, split at awkward places, with the model name put back", () => {
  const out = new StreamOutput({ model: "glm-5.3" })
  const emitted = []
  const text = frame(delta("")) + frame(delta("Hel")) + frame(delta("lo!")) + frame(finish()) + "data: [DONE]\n\n"
  emitted.push(...out.push(text.slice(0, 20)))
  assert.equal(emitted.length, 0, "nothing before a whole event")
  emitted.push(...out.push(text.slice(20, 200)))
  assert.ok(emitted.length >= 2, "the held role frame goes out with the first content")
  assert.equal(JSON.parse(emitted[0].slice(6)).model, "glm-5.3")
  emitted.push(...out.push(text.slice(200)))
  assert.equal(out.done, true)
  assert.equal(emitted.at(-1), "data: [DONE]\n\n")
  assert.equal(out.end().length, 0)
  assert.ok(emitted.every((event) => event.endsWith("\n\n")))
  assert.deepEqual(
    emitted.filter((event) => event !== "data: [DONE]\n\n").map((event) => JSON.parse(event.slice(6)).choices[0].delta.content ?? ""),
    ["", "Hel", "lo!", ""],
  )
})

test("stream: CRLF events are read", () => {
  const out = new StreamOutput({ model: "m" })
  const got = out.push(`data: ${JSON.stringify(delta("a"))}\r\n\r\ndata: ${JSON.stringify(finish())}\r\n\r\ndata: [DONE]\r\n\r\n`)
  assert.equal(got.filter((event) => event.startsWith("data: {")).length, 2)
  assert.equal(JSON.parse(got[0].slice(6)).choices[0].delta.content, "a")
  assert.equal(got.at(-1), "data: [DONE]\n\n")
})

test("stream: an event split across two pushes is reassembled", () => {
  const out = new StreamOutput({ model: "m" })
  const whole = frame(delta("ab"))
  out.push(whole.slice(0, 25))
  const got = out.push(whole.slice(25) + frame(finish()) + "data: [DONE]\n\n")
  const contentOf = (event) => (event === "data: [DONE]\n\n" ? event : (JSON.parse(event.slice(6)).choices[0].delta.content ?? ""))
  assert.deepEqual(got.map(contentOf), ["ab", "", "data: [DONE]\n\n"])
})

test("stream: comments and non-data lines pass by unseen", () => {
  const out = new StreamOutput({ model: "m" })
  const got = out.push(`: keep-alive\nevent: ping\nid: 3\n\n${frame(delta("x"))}${frame(finish())}data: [DONE]\n\n`)
  assert.equal(got.filter((event) => event.startsWith("data: {")).length, 2)
})

test("stream: only control frames is an error, after the held frames reach 128", () => {
  const out = new StreamOutput({ model: "m" })
  // role-only frames are held; a few of them are still a stream that is warming up
  assert.equal(out.push(frame(delta("", { role: "assistant" })).repeat(10)).length, 0)
  // the 128th held frame without any content means the model never answered
  assert.throws(() => out.push(frame(delta("", { role: "assistant" })).repeat(200)), /仅返回控制帧/)
  assert.equal(out.started, false)
})

test("stream: newline keep-alive frames can be stripped", () => {
  const plain = new StreamOutput({ model: "m" })
  const keptAll = plain.push(frame(delta("\n")) + frame(delta("real")) + frame(finish()) + "data: [DONE]\n\n")
  assert.equal(keptAll.filter((event) => event.startsWith("data: {")).length, 3)
  const stripping = new StreamOutput({ model: "m", stripNewlineKeepalive: true })
  const kept = stripping.push(frame(delta("\n")) + frame(delta("real")) + frame(finish()) + "data: [DONE]\n\n")
  assert.equal(kept.filter((event) => event.startsWith("data: {")).length, 2)
  assert.equal(kept.at(-1), "data: [DONE]\n\n")
})

test("stream: a refusal that arrives as a stream is still an error", () => {
  assert.throws(
    () => new StreamOutput({ model: "m" }).push(frame({ error: { message: "login expired", status: 401 } })),
    (error) => error.status === 401 && error.signIn === "expired",
  )
  assert.throws(
    () => new StreamOutput({ model: "m" }).push(frame({ code: 810000, msg: "免费额度已用完" })),
    (error) => error.status === 429 && error.signIn === "kept",
  )
  assert.throws(() => new StreamOutput({ model: "m" }).push(frame(finish("content_filter"))), (error) => error.code === "content_filter")
  assert.throws(() => new StreamOutput({ model: "m" }).push("data: not-json\n\n"), /SSE 事件格式无效/)
  assert.throws(() => new StreamOutput({ model: "m" }).push(frame({ id: "x", object: "chat.completion.chunk" })), /缺少 choices/)
  const late = new StreamOutput({ model: "m" })
  late.push(frame(delta("abc")))
  assert.throws(() => late.push(frame({ error: { message: "boom", status: 500 } })), (error) => error.status === 500)
})

test("stream: a stream that ends early is not a success", () => {
  const cut = new StreamOutput({ model: "m" })
  cut.push(frame(delta("partial")))
  assert.throws(() => cut.end(), (error) => error.code === "runtime_stream_interrupted" && error.status === 502)

  const noFinish = new StreamOutput({ model: "m" })
  noFinish.push(frame(delta("x")))
  assert.throws(() => noFinish.push("data: [DONE]\n\n"), /未返回完整结束原因/)

  const multi = new StreamOutput({ model: "m" })
  multi.push(frame({ choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }, { index: 1, delta: { content: "b" } }] }))
  assert.throws(() => multi.push("data: [DONE]\n\n"), /未返回完整结束原因/, "the second choice never finished")
})

test("stream: the last event without its blank line is still read", () => {
  // A finish frame that arrives without the blank line after it, then [DONE] with one.
  const out = new StreamOutput({ model: "m" })
  out.push(frame(delta("x")))
  const got = out.push(`data: ${JSON.stringify(finish())}\n\ndata: [DONE]\n\n`)
  assert.equal(got.length, 2)
  assert.equal(out.done, true)
  assert.equal(out.end().length, 0)
})

test("stream: a stream that ends on an unterminated event, without [DONE], is interrupted", () => {
  const out = new StreamOutput({ model: "m" })
  out.push(frame(delta("x")))
  out.push(`data: ${JSON.stringify(finish())}\n\n`)
  assert.throws(() => out.end(), /提前中断/)
})

test("stream: an unterminated last event is delivered before [DONE] is checked", () => {
  const out = new StreamOutput({ model: "m" })
  out.push(frame(delta("x")))
  out.push(`data: ${JSON.stringify(finish())}\n\ndata: [DONE]`)
  // [DONE] has no blank line after it: end() reads it and the stream completes
  const got = out.end()
  assert.deepEqual(got, ["data: [DONE]\n\n"])
  assert.equal(out.done, true)
})

test("session id: stable across turns, apart per account, derived not copied", () => {
  const body = { messages: [{ role: "system", content: "s" }, { role: "user", content: "first" }] }
  const s = sessionId({ account: "u1", body })
  assert.match(s, UUID4)
  assert.equal(s, sessionId({ account: "u1", body: { messages: [{ role: "system", content: "changed" }, { role: "user", content: "first" }] } }))
  assert.notEqual(s, sessionId({ account: "u2", body }))
  assert.notEqual(sessionId({ account: "u1", session: "s", body: {} }), sessionId({ account: "u1", session: "t", body: {} }))
  assert.equal(sessionId({ account: "u1", body: { messages: [{ role: "system", content: "only" }] } }), null)
  assert.match(deriveSession(["a"]), UUID4)
  assert.equal(deriveSession(["a"]), deriveSession(["a"]))
})

test("client session headers: only the three known ones, printable only", () => {
  assert.deepEqual(
    clientSessionHeaders({ "X-Autoclaw-Session-Id": " abc ", "x-autoclaw-agent-id": "main", "x-other": "y", "x-autoclaw-zcode-invocation-id": "" }),
    { "x-autoclaw-session-id": "abc", "x-autoclaw-agent-id": "main" },
  )
  assert.deepEqual(clientSessionHeaders(undefined), {})
  assert.throws(() => clientSessionHeaders({ "x-autoclaw-session-id": "bad\nvalue" }), /会话关联头格式无效/)
})
