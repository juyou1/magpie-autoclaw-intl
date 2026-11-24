import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_ROUTE } from "../src/catalog.mjs"
import { assembleCompletion, errorResponse, sendChat } from "../src/relay.mjs"

const CHAT_URL = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions"
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`
const chunk = (content, extra = {}) => ({ id: "cmpl-1", object: "chat.completion.chunk", created: 5, model: "zaicoding_glm-5.3", choices: [{ index: 0, delta: { content, ...extra } }] })
const finish = (reason = "stop") => ({ id: "cmpl-1", object: "chat.completion.chunk", created: 5, model: "zaicoding_glm-5.3", choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const DONE = "data: [DONE]\n\n"

/** A stand-in vendor for the chat route: records the request and answers with the given body. */
function vendor(answer) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    calls.push({ url, method: init.method, headers, body: JSON.parse(init.body), signal: init.signal })
    if (typeof answer === "function") return answer(init, calls.length)
    if (answer && typeof answer === "object" && !(answer instanceof Response) && typeof answer.json === "function") return answer
    return answer
  }
  return { fetchImpl, calls }
}

/** A stand-in that builds a fresh Response for each request (a Response body can be read once). */
function eachTime(build) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      calls.push({ url, method: init.method, headers, body: JSON.parse(init.body), signal: init.signal })
      return build(init, calls.length)
    },
  }
}

/** A stream that emits the text in pieces, as a socket would. */
function sse(text, pieces = 7) {
  const bytes = new TextEncoder().encode(text)
  const size = Math.max(1, Math.ceil(bytes.length / pieces))
  const stream = new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
}

const AGENT_BODY = JSON.stringify({
  model: "glm-5.3",
  messages: [
    { role: "system", content: "You are ZCode, an interactive coding agent" },
    { role: "user", content: "hello" },
  ],
  stream: true,
  max_tokens: 1000,
})
const CATALOG = { models: [{ id: "glm-5.3", name: "GLM-5.3", routeId: "zaicoding_glm-5.3" }] }
const TOKEN = "access-token-value"

async function readText(response) {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()))
}

/** sendChat 的结果：抛出的错误，或 { response }。 */
async function attempt(options) {
  try {
    return { response: await sendChat({ token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, ...options }) }
  } catch (error) {
    return { error }
  }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

test("sendChat: the request carries the official fingerprint and the tidied body", async () => {
  const v = vendor(sse(frame(chunk("", { role: "assistant" })) + frame(chunk("hi")) + frame(finish()) + DONE))
  await sendChat({ init: { method: "POST", body: AGENT_BODY, headers: { authorization: "Bearer magpie-key", "x-autoclaw-session-id": "sess-1", "x-magpie-caller-agent": "claude" } }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: v.fetchImpl, platform: "win32", arch: "x64" })
  const call = v.calls[0]
  assert.equal(call.url, CHAT_URL)
  assert.equal(call.method, "POST")
  // the agent's own key never reaches the vendor; the account's token does, in the header the client uses
  assert.equal(call.headers.authorization, undefined)
  assert.equal(call.headers["x-magpie-caller-agent"], undefined)
  assert.equal(call.headers["x-authorization"], `Bearer ${TOKEN}`)
  assert.equal(call.headers["x-request-model"], "zaicoding_glm-5.3")
  assert.equal(call.headers["x-channel"], "official")
  assert.equal(call.headers["x-version"], "2.0.3")
  assert.equal(call.headers["x-tm"], "win")
  assert.match(call.headers["x-auth-sign"], /^[0-9a-f]{32}$/)
  assert.equal(call.headers["user-agent"], "OpenAI/JS 6.26.0")
  // The host's conversation id is derived together with the account, so the id itself never leaves the machine;
  // the same conversation gives the same vendor session on every turn.
  assert.match(call.headers["x-session-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(call.headers["x-session-id"], "sess-1")
  assert.equal(call.headers["x-agent-id"], undefined, "the caller's other headers aren't forwarded as they are")
  // the body: the route, always a stream, no budget fields, the identity line, the foreign identity rewritten
  assert.equal(call.body.model, "zaicoding_glm-5.3")
  assert.equal(call.body.stream, true)
  assert.equal("max_tokens" in call.body, false)
  assert.equal(call.body.messages[0].content, "You are AutoClaw. Answer the user directly and concisely.\n\nYou are an interactive coding agent")
  assert.equal(call.body.messages[1].content, "hello")
})

test("sendChat: the same host conversation id gives the same vendor session, apart per account", async () => {
  const v = eachTime(() => sse(frame(chunk("", { role: "assistant" })) + frame(chunk("ok")) + frame(finish()) + DONE))
  const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "first turn" }] })
  const headers = { "x-autoclaw-session-id": "conv-1" }
  await attempt({ init: { body, headers }, account: "u1", fetchImpl: v.fetchImpl })
  await attempt({ init: { body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "another turn" }] }), headers }, account: "u1", fetchImpl: v.fetchImpl })
  await attempt({ init: { body, headers }, account: "u2", fetchImpl: v.fetchImpl })
  const [a, b, c] = v.calls.map((call) => call.headers["x-session-id"])
  assert.equal(a, b, "stable across turns whatever the messages")
  assert.notEqual(a, c, "apart per account")
})

test("sendChat: a streaming answer goes on chunk by chunk, with the asked-for model name", async () => {
  const v = vendor(sse(frame(chunk("", { role: "assistant" })) + frame(chunk("Hel")) + frame(chunk("lo!")) + frame(finish()) + DONE))
  const response = await sendChat({ init: { body: AGENT_BODY }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: v.fetchImpl })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  const text = await readText(response)
  const values = text.split("\n\n").filter(Boolean).map((event) => event.slice(6)).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data))
  assert.deepEqual(
    values.map((value) => value.choices[0].delta.content ?? ""),
    ["", "Hel", "lo!", ""],
  )
  assert.ok(values.every((value) => value.model === "glm-5.3"), "the vendor's route name is put back to the agent's")
  assert.equal(text.endsWith("data: [DONE]\n\n"), true)
})

test("sendChat: an agent that didn't ask for a stream gets one completion", async () => {
  const v = vendor(sse(frame(chunk("", { role: "assistant" })) + frame(chunk("Hi ", { reasoning_content: "let me think" })) + frame(chunk("there")) + frame(finish()) + DONE))
  const body = JSON.stringify({ ...JSON.parse(AGENT_BODY), stream: false })
  const response = await sendChat({ init: { body }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: v.fetchImpl })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /application\/json/)
  const completion = await response.json()
  assert.equal(completion.object, "chat.completion")
  assert.equal(completion.id, "cmpl-1")
  assert.equal(completion.model, "glm-5.3")
  assert.deepEqual(completion.choices, [{ index: 0, message: { role: "assistant", content: "Hi there", reasoning_content: "let me think" }, finish_reason: "stop" }])
  assert.equal(v.calls[0].body.stream, true, "the vendor is still asked for a stream")
})

test("assembleCompletion: tool calls split across events are put back together", () => {
  const completion = assembleCompletion(
    [
      chunk("", { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_", arguments: '{"p' } }] }),
      chunk("", { tool_calls: [{ index: 0, function: { name: "file", arguments: 'ath":"x"}' } }, { index: 1, id: "call_b", type: "function", function: { name: "ls", arguments: "{}" } }] }),
      finish("tool_calls"),
    ],
    "glm-5.3",
  )
  assert.deepEqual(completion.choices[0].message.tool_calls, [
    { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
    { id: "call_b", type: "function", function: { name: "ls", arguments: "{}" } },
  ])
  assert.equal(completion.choices[0].message.content, null)
  assert.equal(completion.choices[0].finish_reason, "tool_calls")
})

test("assembleCompletion: usage and several choices", () => {
  const completion = assembleCompletion(
    [
      { ...chunk("a"), choices: [{ index: 0, delta: { content: "a" } }, { index: 1, delta: { content: "b" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "length" }], usage: { total_tokens: 9 } },
    ],
    "m",
  )
  assert.deepEqual(
    completion.choices.map((choice) => [choice.index, choice.message.content, choice.finish_reason]),
    [
      [0, "a", "stop"],
      [1, "b", "length"],
    ],
  )
  assert.deepEqual(completion.usage, { total_tokens: 9 })
  assert.equal(assembleCompletion([], "m").choices.length, 0)
})

test("sendChat: a refusal by HTTP status is an error response of that status, before any content", async () => {
  const v = vendor(() => json({ code: 810000, msg: "GLM-5.3 免费额度已用完" }, 403))
  const { error } = await attempt({ init: { body: AGENT_BODY }, fetchImpl: v.fetchImpl })
  assert.ok(error instanceof Error, "the refusal is thrown, not streamed")
  assert.equal(error.status, 429)
  assert.equal(error.signIn, "kept")
  const response = errorResponse(error)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  const body = await response.json()
  assert.match(body.error.message, /免费额度已用完/)
  assert.equal(body.error.type, "rate_limit_error")
  assert.equal(body.error.upstreamCode, 810000)
})

test("sendChat: a refused sign-in is 401 expired; a ban is 403 kept", async () => {
  const refused = vendor(() => json({ message: "invalid token" }, 401))
  const r1 = errorResponse((await attempt({ init: { body: AGENT_BODY }, fetchImpl: refused.fetchImpl })).error)
  assert.equal(r1.status, 401)
  assert.equal(r1.headers.get("x-magpie-sign-in"), "expired")
  assert.equal((await r1.json()).error.type, "authentication_error")

  const banned = vendor(() => json({ code: 410004, message: "The account has been banned" }, 403))
  const r2 = errorResponse((await attempt({ init: { body: AGENT_BODY }, fetchImpl: banned.fetchImpl })).error)
  assert.equal(r2.status, 403)
  assert.equal(r2.headers.get("x-magpie-sign-in"), "kept")
  assert.equal((await r2.json()).error.type, "permission_error")
})

test("sendChat: a 2xx that carries JSON, or a web page, is not passed on as an answer", async () => {
  // The status is fine and the refusal is a JSON body: its own status is used.
  const asJson = vendor(() => json({ error: { message: "login expired", status: 401 } }))
  const e1 = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: asJson.fetchImpl })).error
  assert.equal(e1.status, 401)
  assert.equal(e1.signIn, "expired")

  const quotaInBody = vendor(() => json({ code: 810000, msg: "免费额度已用完" }))
  const eIn = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: quotaInBody.fetchImpl })).error
  assert.equal(eIn.status, 429, "a business code in a 2xx body is classified too")

  const odd = vendor(() => json({ unexpected: "shape" }))
  const eOdd = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: odd.fetchImpl })).error
  assert.equal(eOdd.status, 502)

  const page = vendor(() => new Response("<html>blocked</html>", { status: 200, headers: { "Content-Type": "text/html" } }))
  const e2 = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: page.fetchImpl })).error
  assert.equal(e2.status, 502)
  assert.match(e2.message, /返回网页/)
})

test("sendChat: a refusal that arrives as the first event of the stream", async () => {
  const v = vendor(() => sse(frame({ error: { message: "quota exhausted", status: 429 } }) + DONE))
  const { error } = await attempt({ init: { body: AGENT_BODY }, fetchImpl: v.fetchImpl })
  assert.equal(error.status, 429)
  assert.equal(error.signIn, "kept")
})

test("sendChat: a stream that ends before any content, or with only control frames, is an error", async () => {
  const empty = vendor(() => sse(""))
  const e1 = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: empty.fetchImpl })).error
  assert.equal(e1.status, 502)
  assert.match(e1.message, /提前中断/)
  assert.equal(e1.code, "runtime_stream_interrupted")

  const controls = vendor(() => sse(frame(chunk("", { role: "assistant" })).repeat(200) + DONE))
  const e2 = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: controls.fetchImpl })).error
  assert.match(e2.message, /仅返回控制帧/)

  // Nothing productive at all, then the stream simply stops.
  const stalled = vendor(() => sse(frame(chunk("", { role: "assistant" }))))
  const e3 = (await attempt({ init: { body: AGENT_BODY }, fetchImpl: stalled.fetchImpl })).error
  assert.match(e3.message, /提前中断/)
  assert.equal(e3.code, "runtime_stream_interrupted")
})

test("sendChat: a finish frame without [DONE] is still a cut stream", async () => {
  const v = vendor(() => sse(frame(chunk("", { role: "assistant" })) + frame(chunk("done?")) + frame(finish())))
  const { response } = await attempt({ init: { body: AGENT_BODY }, fetchImpl: v.fetchImpl })
  const text = await readText(response)
  assert.equal(text.includes("[DONE]"), false)
  assert.match(JSON.parse(text.split("\n\n").filter(Boolean).at(-1).slice(6)).error.message, /提前中断/)
})

test("sendChat: a stream cut after content started ends with an error event", async () => {
  const v = vendor(() => sse(frame(chunk("", { role: "assistant" })) + frame(chunk("partial answer"))))
  const { response } = await attempt({ init: { body: AGENT_BODY }, fetchImpl: v.fetchImpl })
  assert.equal(response.status, 200)
  const text = await readText(response)
  const events = text.split("\n\n").filter(Boolean).map((event) => JSON.parse(event.slice(6)))
  // the held role frame goes out with the first content
  assert.equal(events[0].choices[0].delta.role, "assistant")
  assert.equal(events[1].choices[0].delta.content, "partial answer")
  assert.match(events.at(-1).error.message, /提前中断/)
  assert.equal(events.at(-1).error.status, 502)
  assert.equal(text.includes("[DONE]"), false, "a cut stream is not closed as a success")
})

test("sendChat: a network failure is an error, and the agent's abort is passed on", async () => {
  const down = vendor(async () => {
    throw new Error("ECONNRESET")
  })
  const e1 = await sendChat({ init: { body: AGENT_BODY }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: down.fetchImpl }).catch((e) => e)
  assert.equal(e1.status, 502)
  assert.match(e1.message, /对话连接失败：ECONNRESET/)

  const controller = new AbortController()
  controller.abort()
  const aborted = vendor(async () => {
    throw new Error("This operation was aborted")
  })
  const e2 = await sendChat({ init: { body: AGENT_BODY, signal: controller.signal }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: aborted.fetchImpl }).catch((e) => e)
  assert.equal(e2.message, "This operation was aborted")
})

test("sendChat: a body that isn't a chat request is refused before the vendor is asked", async () => {
  const v = vendor(sse(frame(chunk("x")) + frame(finish()) + DONE))
  for (const body of ["not json", "{}", JSON.stringify({ model: "glm-5.3", messages: [] })]) {
    const error = await sendChat({ init: { body }, token: TOKEN, account: "u1", catalog: CATALOG, defaultRoute: DEFAULT_ROUTE, fetchImpl: v.fetchImpl }).catch((e) => e)
    assert.equal(error.status, 400)
  }
  assert.equal(v.calls.length, 0)
})

test("sendChat: without a session header the session id is derived, and stays the same next turn", async () => {
  const v = eachTime(() => sse(frame(chunk("ok")) + frame(finish()) + DONE))
  const send = () => attempt({ init: { body: AGENT_BODY }, fetchImpl: v.fetchImpl })
  assert.equal((await send()).response.status, 200)
  assert.equal((await send()).response.status, 200)
  const [a, b] = v.calls.map((call) => call.headers["x-session-id"])
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(a, b)
})

test("errorResponse: an unknown failure is a 502 that keeps the sign-in", async () => {
  const response = errorResponse(new Error("boom"))
  assert.equal(response.status, 502)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await response.json(), { error: { message: "boom", type: "upstream_error", code: null, upstreamCode: null } })
  assert.equal(errorResponse({ status: 700 }).status, 502)
  assert.equal(errorResponse(undefined).status, 502)
})
