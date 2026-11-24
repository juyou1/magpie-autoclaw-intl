import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_ROUTE } from "../src/catalog.mjs"
import { resetCatalog } from "../src/catalog.mjs"
import { resetLedgers } from "../src/checkin.mjs"
import { resetRefresh } from "../src/refresh.mjs"
import { makeAutoclawIntlPlugin } from "../src/plugin.mjs"

const JWT = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`
const DAY = 24 * 3600
const nowSec = () => Math.floor(Date.now() / 1000)
const TOKEN = JWT({ user_id: "777", device_id: "ddev", exp: nowSec() + DAY })
const RENEWED = JWT({ user_id: "777", device_id: "ddev", exp: nowSec() + 2 * DAY })
const sse = (text) => new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`
const chunk = (content, extra = {}) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "zaicoding_glm-5.3", choices: [{ index: 0, delta: { content, ...extra } }] })
const finish = () => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "zaicoding_glm-5.3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
const DONE = "data: [DONE]\n\n"

/** The stand-in vendor: every route the plugin uses, with a per-request record. */
function makeVendor() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method: init.method, headers, body })
    const bearer = headers["x-authorization"] ?? headers.authorization ?? ""
    if (url.endsWith("/autoclaw/v1/chat/completions")) {
      if (bearer !== `Bearer ${TOKEN}` && bearer !== `Bearer ${RENEWED}`) return json({ message: "invalid token" }, 401)
      return sse(frame(chunk("", { role: "assistant" })) + frame(chunk("pong")) + frame(finish()) + DONE)
    }
    if (url.endsWith("/autoclaw-model-config")) {
      if (bearer !== `Bearer ${TOKEN}`) return json({}, 401)
      return json({ models: ["zai_auto", { id: "zaicoding_glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxTokens: 131072 }] })
    }
    if (url.includes("/agent-assetmgr/api/v2/wallets")) return json({ code: 0, data: { total_balance: 1500, wallets: [{ display: true, public_wallet_type: "monthly", display_name: "订阅积分", balance: 1500, priority: 1 }] } })
    if (url.includes("/points/expiring")) return json({ code: 0, data: {} })
    if (url.endsWith("/oversea-subscribe-info")) return json({ code: 0, data: { productName: "Pro", status: "active" } })
    if (url.endsWith("/autoclaw-task-list")) return json({ code: 0, data: [{ task_id: "daily_signin", status: "pending", reward_points: 30 }] })
    if (url.endsWith("/autoclaw-task-complete")) return json({ code: 0, data: { success: true, reward_points: 30 } })
    if (url.includes("/ledgers_std")) return json({ code: 0, data: { entries: [{ amount: 4000, description: "AutoClaw Weekly Perks", metadata: { grant_date: "2000-01-01", event_type: "autoclaw_user_active" } }] } })
    if (url.endsWith("/userapi/v1/user-info")) return json({ code: 0, data: {} })
    if (url.endsWith("/userapi/v1/refresh")) return json({ code: 0, data: { access_token: RENEWED, refresh_token: "rt-2" } })
    throw new Error(`unexpected request ${url}`)
  }
  return { fetchImpl, calls }
}

/** The plugin with one signed-in account, as magpie would hold it. */
async function signedIn(auth) {
  const vendor = makeVendor()
  const plugin = await makeAutoclawIntlPlugin({ fetchImpl: vendor.fetchImpl, platform: "win32", arch: "x64" })()
  let current = auth
  const getAuth = async () => current
  return { plugin, vendor, getAuth, setAuth: (next) => (current = next) }
}

const AUTH = { type: "oauth", access: TOKEN, refresh: "rt-1", uid: "777", accountId: "ada@example.com", deviceId: "ddev" }
const routes = (vendor) => vendor.calls.map((call) => call.url.replace("https://autoglm-api.autoglm.ai", ""))

test.beforeEach(() => {
  resetCatalog()
  resetLedgers()
  resetRefresh()
})

test("the plugin function returns the hooks magpie calls, and nothing else", async () => {
  const { plugin } = await signedIn(AUTH)
  assert.deepEqual(Object.keys(plugin).sort(), ["auth", "chat.headers", "config", "provider"])
  assert.equal(plugin.auth.provider, "autoclaw-intl")
  assert.equal(plugin.auth.methods.length, 4)
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(plugin.provider.id, "autoclaw-intl")
})

test("config: the provider is declared once, and a user's own configuration is kept", async () => {
  const { plugin } = await signedIn(AUTH)
  const cfg = {}
  await plugin.config(cfg)
  await plugin.config(cfg)
  const provider = cfg.provider["autoclaw-intl"]
  assert.equal(provider.name, "AutoClaw 国际版")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, "https://autoglm-api.autoglm.ai")
  assert.deepEqual(Object.keys(provider.models), ["glm-5.3", "glm-5.3-flash"])
  assert.equal(provider.models["glm-5.3"].api.id, "zaicoding_glm-5.3")

  const own = { provider: { "autoclaw-intl": { name: "Mine", models: { custom: { name: "Custom" } } } } }
  await plugin.config(own)
  assert.deepEqual(own.provider["autoclaw-intl"], { name: "Mine", models: { custom: { name: "Custom" } } })
})

test("models: the static list before sign-in, the live list for an account, the kept list when the vendor can't be read", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  const staticList = { "glm-5.3": { name: "GLM-5.3" }, "glm-5.3-flash": { name: "GLM-5.3-Flash" } }
  assert.equal(await plugin.provider.models({ models: staticList }, { auth: undefined }), staticList)
  assert.equal(await plugin.provider.models({ models: staticList }, { auth: { type: "api", key: "x" } }), staticList)

  const live = await plugin.provider.models({ models: staticList }, { auth: AUTH })
  assert.deepEqual(Object.keys(live), ["auto", "glm-5.3"])
  assert.equal(live["glm-5.3"].name, "GLM-5.3")
  assert.equal(live["glm-5.3"].limit.output, 131072)
  assert.equal(live.auto.api.id, "zai_auto")
  assert.equal(routes(vendor).filter((route) => route.endsWith("/autoclaw-model-config")).length, 1)

  // a signed-out account: the sign-in is marked, magpie keeps its list
  // (another token, so the catalog cached a moment ago for TOKEN isn't reused)
  const stranger = JWT({ user_id: "999", exp: nowSec() + DAY })
  const signedOut = await makeAutoclawIntlPlugin({ fetchImpl: async () => json({ code: 410000 }, 401) })()
  await assert.rejects(signedOut.provider.models({ models: staticList }, { auth: { ...AUTH, access: stranger } }), (error) => error.signIn === "expired")
  // a vendor that can't be reached isn't a sign-out: the list magpie had stands
  const unreachable = await makeAutoclawIntlPlugin({ fetchImpl: async () => json({ message: "down" }, 500) })()
  assert.equal(await unreachable.provider.models({ models: staticList }, { auth: { ...AUTH, access: stranger } }), staticList)
})

test("loader: no sign-in means no options", async () => {
  const { plugin } = await signedIn({ type: "oauth", access: "", refresh: "" })
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api", key: "k" })), {})
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {})
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "oauth", access: "", refresh: "" })), {})
})

test("loader: a chat request goes to the vendor's chat route with the account's token, and streams back", async () => {
  const { plugin, vendor, getAuth } = await signedIn(AUTH)
  const options = await plugin.auth.loader(getAuth)
  assert.equal(options.baseURL, "https://autoglm-api.autoglm.ai")
  const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "ping" }], stream: true })
  const response = await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", headers: { authorization: "Bearer magpie-key" }, body })
  assert.equal(response.status, 200)
  const text = new TextDecoder().decode(await response.arrayBuffer())
  const events = text.split("\n\n").filter(Boolean).map((event) => event.slice(6))
  // the role frame is held and goes out with the first content
  assert.equal(JSON.parse(events[0]).choices[0].delta.role, "assistant")
  assert.equal(JSON.parse(events[1]).choices[0].delta.content, "pong")
  assert.equal(events.at(-1), "[DONE]")
  const call = vendor.calls.find((c) => c.url.endsWith("/chat/completions"))
  assert.equal(call.headers["x-authorization"], `Bearer ${TOKEN}`)
  assert.equal(call.headers.authorization, undefined, "the agent's own key doesn't reach the vendor")
  assert.equal(call.body.model, "zaicoding_glm-5.3")
})

test("loader: a refusal is a Response for the gateway, with the sign-in state said", async () => {
  const stranger = JWT({ user_id: "999", exp: nowSec() + DAY })
  const { plugin } = await signedIn(AUTH)
  const options = await plugin.auth.loader(async () => ({ ...AUTH, access: stranger }))
  const response = await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "ping" }] }) })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired")
  // a body that isn't a chat request is a 400
  const bad = await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body: "{}" })
  assert.equal(bad.status, 400)
})

test("loader: after a renewal the next request carries the new token", async () => {
  const { plugin, vendor, getAuth, setAuth } = await signedIn(AUTH)
  const options = await plugin.auth.loader(getAuth)
  setAuth({ ...AUTH, access: RENEWED, refresh: "rt-2" })
  const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "ping" }] })
  const response = await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body })
  assert.equal(response.status, 200)
  assert.equal(vendor.calls.at(-1).headers["x-authorization"], `Bearer ${RENEWED}`)
})

test("refresh: the fields magpie merges into the account", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  const fresh = await plugin.auth.refresh(AUTH)
  assert.equal(fresh.access, RENEWED)
  assert.equal(fresh.refresh, "rt-2")
  assert.equal(typeof fresh.expires, "number")
  const call = vendor.calls.find((c) => c.url.endsWith("/userapi/v1/refresh"))
  assert.deepEqual(call.body, { refresh_token: "rt-1", source_id: "autoclaw", device_id: "ddev" })
  await assert.rejects(plugin.auth.refresh({ ...AUTH, refresh: "" }), (error) => error.signIn === "expired")
})

test("usage: balance, wallets and subscription for the account", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  const report = await plugin.auth.usage(async () => AUTH)
  assert.equal(report.balance, "1,500 积分")
  assert.equal(report.plan, "Pro")
  assert.deepEqual(report.windows[0], { name: "积分", balance: 1500, unit: "积分", display: "1,500 积分 · 订阅积分 1,500" })
  assert.deepEqual(routes(vendor).filter((route) => route.includes("/agent-assetmgr/") || route.includes("/agentpay/")).sort(), [
    "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw",
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
    "/agentpay/v1/assistant/oversea-subscribe-info",
  ])
  assert.deepEqual(await plugin.auth.usage(async () => undefined), { error: "未登录", windows: [] })
})

test("checkin: the day's check-in is claimed once; a second run the same day is already done", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  const first = await plugin.auth.checkin(async () => AUTH)
  assert.equal(first.outcome, "claimed")
  assert.equal(first.credit, 30)
  // the vendor was asked for the task list first, then the task was completed, then the ledger read for the campaign reward
  const order = routes(vendor).map((route) => route.split("?")[0]).filter((route) => route.includes("task") || route.includes("ledger") || route.includes("user-info"))
  assert.deepEqual(order.slice(0, 3), ["/autoclaw-proxy/proxy/autoclaw-task-complete", "/agent-assetmgr/api/v1/ledgers_std", "/userapi/v1/user-info"])
  const second = await plugin.auth.checkin(async () => AUTH)
  assert.equal(second.outcome, "done")
  await assert.rejects(plugin.auth.checkin(async () => undefined), /未登录/)
})

test("two accounts keep separate catalogs and sign-in ledgers", async () => {
  const a = await signedIn(AUTH)
  const b = await signedIn({ ...AUTH, uid: "888", accountId: "bob@example.com" })
  const optA = await a.plugin.auth.loader(async () => AUTH)
  const optB = await b.plugin.auth.loader(async () => ({ ...AUTH, uid: "888", access: TOKEN }))
  const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "ping" }] })
  await optA.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body })
  await optB.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body })
  assert.notEqual(a.vendor.calls[0].headers["x-session-id"], b.vendor.calls[0].headers["x-session-id"], "the session id is apart per account")
  const checkA = await a.plugin.auth.checkin(async () => AUTH)
  const checkB = await b.plugin.auth.checkin(async () => ({ ...AUTH, uid: "888" }))
  assert.equal(checkA.outcome, "claimed")
  assert.equal(checkB.outcome, "claimed", "the second account has its own ledger for the day")
})

test("chat.headers: the caller's session id goes to the vendor as its session header, for this provider only", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  const options = await plugin.auth.loader(async () => AUTH)
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "autoclaw-intl" }, sessionID: "conv-123" }, output)
  assert.deepEqual(output.headers, { "x-autoclaw-session-id": "conv-123" })
  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "openai" }, sessionID: "conv-123" }, other)
  assert.deepEqual(other.headers, {})
  const extra = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "autoclaw-intl" }, headers: { "X-Autoclaw-Agent-Id": "main", "x-magpie-caller-agent": "claude" } }, extra)
  assert.deepEqual(extra.headers, { "x-autoclaw-agent-id": "main" })

  const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "ping" }] })
  await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", headers: output.headers, body })
  // a session that came from the conversation id stays the same whatever the messages are
  const first = vendor.calls.at(-1).headers["x-session-id"]
  await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", headers: output.headers, body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "something else entirely" }] }) })
  assert.equal(vendor.calls.at(-1).headers["x-session-id"], first)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("a model added upstream shows up without a plugin release", async () => {
  const { plugin, vendor } = await signedIn(AUTH)
  await plugin.provider.models({ models: {} }, { auth: AUTH })
  const options = await plugin.auth.loader(async () => AUTH)
  // the agent asks for a model only the live list knows, by the name magpie shows
  const response = await options.fetch("https://autoglm-api.autoglm.ai/chat/completions", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "ping" }] }) })
  assert.equal(response.status, 200)
  assert.equal(vendor.calls.at(-1).body.model, DEFAULT_ROUTE)
})
