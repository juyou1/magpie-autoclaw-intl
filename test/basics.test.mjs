import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import { IDENTITY_LINE, normalizePrompt } from "../src/prompt.mjs"
import { activeHeaders, chatHeaders, platformName, signedHeaders } from "../src/headers.mjs"
import { beijingDay, claims, jwtExpiry, resolveRoute, routeShape, stripBearer, stripRoute, tokenValid } from "../src/util.mjs"

const PREFIX = `${IDENTITY_LINE}\n`
const APP_ID = "100003"
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"
const TS = 1_700_000_000
const expectedSign = createHash("md5").update(`${APP_ID}&${TS}&${APP_KEY}`).digest("hex")

const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: "42", exp: 4070902400, device_id: "dev1" })).toString("base64url")}.sig`

test("signedHeaders: business signature and fingerprint", () => {
  const h = signedHeaders("", TS * 1000)
  assert.equal(h["X-Auth-Appid"], APP_ID)
  assert.equal(h["X-Auth-TimeStamp"], String(TS))
  assert.equal(h["X-Auth-Sign"], expectedSign)
  assert.equal(h["X-Version"], "1.18.5")
  assert.equal(h["X-Channel"], "official")
  assert.equal(h["X-Product"], "autoclaw")
  assert.equal(h["X-Client-Type"], "pc")
  assert.equal(h["X-Harness-Type"], "zcode")
  assert.equal(h["X-Lang"], "zh-CN")
  assert.equal(h["Accept"], "*/*")
})

test("signedHeaders: authorization only with a token", () => {
  assert.equal("authorization" in signedHeaders("", TS * 1000), false)
  assert.equal(signedHeaders("Bearer tok", TS * 1000).authorization, "Bearer tok")
  assert.equal(signedHeaders("  tok  ", TS * 1000).authorization, "Bearer tok")
  assert.throws(() => signedHeaders("has space", TS * 1000), /凭据缺失或格式无效/)
})

test("signedHeaders: X-Tm follows the host platform", () => {
  const tm = platformName() === "win" ? "win" : "linux"
  assert.equal(signedHeaders("", TS * 1000)["X-Tm"], tm)
  assert.equal(platformName("darwin"), "mac")
  assert.equal(platformName("win32"), "win")
  assert.equal(platformName("linux"), "linux")
  assert.equal(platformName("freebsd"), "other")
})

test("activeHeaders: the AutoClaw20 desktop fingerprint", () => {
  const h = activeHeaders("Bearer tok", TS * 1000)
  assert.equal(h["X-Channel"], "AutoClaw20")
  assert.equal(h["X-Version"], "2.2.0")
  assert.equal(h["X-Tm"], "win-x64")
  assert.equal(h["User-Agent"], "AutoClaw/2.2.0 (win-x64)")
  assert.equal(h["X-Auth-Sign"], expectedSign)
  assert.equal(h.Authorization, "Bearer tok")
  assert.throws(() => activeHeaders("", TS * 1000), /凭据缺失或格式无效/)
})

test("chatHeaders: the official 2.0.3 client fingerprint", () => {
  const h = chatHeaders({
    token: `Bearer ${JWT}`,
    route: "zaicoding_glm-5.3",
    session: "sess",
    nowMs: TS * 1000,
    platform: "win32",
    arch: "x64",
  })
  assert.equal(h["User-Agent"], "OpenAI/JS 6.26.0")
  assert.equal(h["X-Version"], "2.0.3")
  assert.equal(h["X-Channel"], "official")
  assert.equal(h["X-Lang"], "en")
  assert.equal(h["X-Auth-Sign"], expectedSign)
  assert.equal(h["X-Authorization"], `Bearer ${JWT}`)
  assert.equal(h["X-Request-Model"], "zaicoding_glm-5.3")
  assert.equal(h["X-Session-Id"], "sess")
  assert.equal(h["X-Stainless-OS"], "Windows")
  assert.equal(h["X-Stainless-Arch"], "x64")
  assert.equal(h["X-Stainless-Runtime"], "node")
  assert.equal(h["X-Stainless-Runtime-Version"], "v24.18.0")
  assert.equal(h["x_trace_id"], "autoclaw-desktop")
  assert.equal(h["X-Request-Id"], h["X-Trace-Id"])
  assert.equal("authorization" in h, false)
})

test("chatHeaders: X-Tm only on mac and win", () => {
  const base = { token: "t", route: "zai_x", session: "s", nowMs: 1 }
  assert.equal("X-Tm" in chatHeaders({ ...base, platform: "linux" }), false)
  assert.equal(chatHeaders({ ...base, platform: "darwin" })["X-Tm"], "mac")
  assert.equal(chatHeaders({ ...base, platform: "win32" })["X-Tm"], "win")
  assert.equal(chatHeaders({ ...base, platform: "darwin", arch: "arm64" })["X-Stainless-Arch"], "arm64")
})

test("chatHeaders: the caller's session headers are forwarded", () => {
  const h = chatHeaders({
    token: "t",
    route: "zai_x",
    session: "derived",
    nowMs: 1,
    clientHeaders: { "X-Autoclaw-Session-Id": "abc", "x-autoclaw-agent-id": "main" },
  })
  assert.equal(h["X-Session-Id"], "abc")
  assert.equal(h["X-Agent-Id"], "main")
  assert.equal("X-ZCode-Invocation-Id" in h, false)
})

test("chatHeaders: invalid route, session or token is a 400", () => {
  assert.throws(() => chatHeaders({ token: "t", route: "", session: "s", nowMs: 1 }), /模型路由名无效/)
  assert.throws(() => chatHeaders({ token: "t", route: "zai_x", session: "", nowMs: 1 }), /会话关联无效/)
  assert.throws(() => chatHeaders({ token: "a b", route: "zai_x", session: "s", nowMs: 1 }), /凭据缺失或格式无效/)
})

test("stripBearer strips every leading prefix", () => {
  assert.equal(stripBearer("Bearer Bearer x.y.z"), "x.y.z")
  assert.equal(stripBearer("Bearer"), "")
  assert.equal(stripBearer("Bearerxyz"), "Bearerxyz")
  assert.equal(stripBearer("  a  "), "a")
  assert.equal(stripBearer(undefined), "")
})

test("tokenValid", () => {
  assert.equal(tokenValid("abc"), true)
  assert.equal(tokenValid(""), false)
  assert.equal(tokenValid("", true), true)
  assert.equal(tokenValid("a b"), false)
})

test("claims and expiry are read from the JWT payload", () => {
  assert.equal(claims(`Bearer ${JWT}`)?.user_id, "42")
  assert.equal(claims(JWT)?.device_id, "dev1")
  assert.equal(jwtExpiry(JWT), 4_070_902_400_000)
  assert.equal(claims("notajwt"), null)
  assert.equal(jwtExpiry("notajwt"), undefined)
})

test("beijingDay follows UTC+8", () => {
  assert.equal(beijingDay(Date.UTC(2026, 10, 23, 17)), "2026-11-24")
  assert.equal(beijingDay(Date.UTC(2026, 10, 23, 15, 59)), "2026-11-23")
})

test("routeShape and stripRoute", () => {
  assert.equal(routeShape("zai_auto"), true)
  assert.equal(routeShape("zaicoding_glm-5.3"), true)
  assert.equal(routeShape("_x"), false)
  assert.equal(routeShape("Zai_x"), false)
  assert.equal(routeShape("nox"), false)
  assert.equal(stripRoute("zaicoding_glm-5.3"), "glm-5.3")
  assert.equal(stripRoute("zai_auto"), "auto")
  assert.equal(stripRoute("glm-4"), "glm-4")
})

test("resolveRoute: catalog first, then a route-shaped name, then the default", () => {
  const catalog = { models: [{ id: "glm-5.3", name: "GLM-5.3", routeId: "zaicoding_glm-5.3" }] }
  assert.deepEqual(resolveRoute("glm-5.3", catalog, "zai_auto"), { requested: "glm-5.3", route: "zaicoding_glm-5.3" })
  assert.equal(resolveRoute("GLM-5.3", catalog, "zai_auto").route, "zaicoding_glm-5.3")
  assert.equal(resolveRoute("zaicoding_glm-5.3", catalog, "zai_auto").route, "zaicoding_glm-5.3")
  assert.equal(resolveRoute("zai_glm-5.3-flash", { models: [] }, "zai_auto").route, "zai_glm-5.3-flash")
  // A name that is printable but not route-shaped falls back to the default route.
  assert.deepEqual(resolveRoute("whatever", { models: [] }, "zai_auto"), { requested: "whatever", route: "zai_auto" })
  assert.deepEqual(resolveRoute("", null, "zai_auto"), { requested: "zai_auto", route: "zai_auto" })
  // Non-printable or over-long names are refused.
  assert.throws(() => resolveRoute("bad\nroute", { models: [] }, "zai_auto"), /模型名称格式无效/)
  assert.throws(() => resolveRoute("x".repeat(513), { models: [] }, "zai_auto"), /模型名称格式无效/)
})

test("prompt: the identity line is prefixed and the caller's prompt kept", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: "You are ZCode, an interactive coding agent working in a repo." }] })
  assert.equal(body.messages[0].content, `${PREFIX}\nYou are an interactive coding agent working in a repo.`)
})

test("prompt: a first message that isn't system gets a system message in front", () => {
  const body = normalizePrompt({ messages: [{ role: "user", content: "hi" }, { role: "system", content: "rules" }] })
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[0].role, "system")
  assert.equal(body.messages[0].content, PREFIX)
  assert.equal(body.messages[2].role, "system")
  assert.equal(body.messages[2].content, "rules")
})

test("prompt: an identity line already present is not doubled", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: `${IDENTITY_LINE}\n\nYou are Claude Code, Anthropic's official CLI tool for Claude.` }] })
  assert.equal(body.messages[0].content, `${IDENTITY_LINE}\n\nYou are a coding assistant, Anthropic's official CLI tool for Claude.`)
})

test("prompt: developer role and parts arrays", () => {
  const body = normalizePrompt({
    messages: [{ role: "developer", content: [{ type: "text", text: "You are Codex, in the Codex CLI." }, { type: "image_url", image_url: { url: "x" } }] }],
  })
  assert.equal(body.messages[0].content[0].text, `${PREFIX}\nYou are a coding agent, in the Codex command-line tool.`)
  assert.equal(body.messages[0].content[1].image_url.url, "x")
})

test("prompt: a parts array without text gets a text part", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "x" } }] }] })
  assert.equal(body.messages[0].content[0].text, PREFIX)
  assert.equal(body.messages[0].content.length, 2)
})

test("prompt: null and missing content, user text untouched", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: null }, { role: "user", content: "You are ZCode" }] })
  assert.equal(body.messages[0].content, PREFIX)
  assert.equal(body.messages[1].content, "You are ZCode")
  const bare = normalizePrompt({ messages: [{ role: "system" }] })
  assert.equal(bare.messages[0].content, PREFIX)
})

test("prompt: long rules run before short ones", () => {
  const body = normalizePrompt({
    messages: [{ role: "system", content: "You are an AI agent powered by DeepSeek Harness. The runtime context names the DeepSeek Harness checkout." }],
  })
  // A plain sentence swap, as the Rust original does: the article before the replaced name stays.
  assert.equal(
    body.messages[0].content,
    `${PREFIX}\nYou are an AI agent powered by a local coding harness. The runtime context names the a local coding harness checkout.`,
  )
})

test("prompt: matching ignores ASCII case and replaces every occurrence", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: "a zcode lowercase untouched; `Codex CLI` and codex cli" }] })
  assert.equal(body.messages[0].content, `${PREFIX}\na zcode lowercase untouched; \`Codex command-line tool\` and Codex command-line tool`)
})

test("prompt: the GLM model sentence", () => {
  const a = normalizePrompt({ messages: [{ role: "system", content: "You are a coding agent POWERED BY THE MODEL glm-5.3-flash[1m]." }] })
  assert.equal(a.messages[0].content, `${PREFIX}\nYou are a coding agent powered by the GLM-5.3-flash model[1m].`)
  const b = normalizePrompt({ messages: [{ role: "system", content: "This conversation is powered by GLM-5.3." }] })
  assert.equal(b.messages[0].content, `${PREFIX}\nThis conversation is powered by the GLM-5.3.`)
})

test("prompt: text outside the system role is never rewritten", () => {
  const body = normalizePrompt({ messages: [{ role: "user", content: "You are Codex CLI" }, { role: "assistant", content: "You are Claude Code" }] })
  assert.equal(body.messages[1].content, "You are Codex CLI")
  assert.equal(body.messages[2].content, "You are Claude Code")
})

test("prompt: non-ASCII text survives", () => {
  const body = normalizePrompt({ messages: [{ role: "system", content: "İstanbul You are Codex ünïcode ✓ 你好" }] })
  assert.equal(body.messages[0].content, `${PREFIX}\nİstanbul You are a coding agent ünïcode ✓ 你好`)
})

test("prompt: a body without messages is left alone", () => {
  const body = { model: "x" }
  assert.equal(normalizePrompt(body), body)
  assert.deepEqual(body, { model: "x" })
})
