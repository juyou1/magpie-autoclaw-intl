import assert from "node:assert/strict"
import { once } from "node:events"
import * as http from "node:http"
import * as net from "node:net"
import { test } from "node:test"

import { loginMethods, parseLoginAddress, startWebLogin, webLoginMethod } from "../src/login.mjs"
import { resetWebLogins } from "../src/login.mjs"

const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: "777", device_id: "ddev", exp: 4070902400 })).toString("base64url")}.sig`
const STATE = "vendor-state-1"
const AUTH_URL = "https://accounts.example.com/auth?state=" + STATE
const REGISTERED = [18432, 19654, 19723, 53699]

/** A stand-in vendor: the routes a sign-in uses, and a record of what it was asked. */
function fakeVendor({ captchaEnabled = true, refuseExchange = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    calls.push({ url, body, headers })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
    if (url.endsWith("/userapi/overseasv1/oauth-captcha-config")) {
      return json({ code: 0, data: captchaEnabled ? { enabled: true, captcha_supplier: "aliyun", region: "ga", prefix: "sq51tr", scene_id: "scene1" } : { enabled: false } })
    }
    if (/\/userapi\/overseasv1\/(zai|google)-oauth-url$/.test(url)) {
      if (captchaEnabled && !body.ali_captcha_verify_param) return json({ code: 631002, msg: "当前版本已停止服务" })
      return json({ code: 0, data: { oauth_url: AUTH_URL } })
    }
    if (/\/userapi\/overseasv1\/(zai|google)-oauth-login$/.test(url)) {
      if (refuseExchange) return json({ code: 631001, msg: "User login error" })
      return json({ code: 0, data: { access_token: `Bearer ${JWT}`, refresh_token: "rt-1", user_id: "external-id", user_name: "Ada" } })
    }
    if (url.endsWith("/userapi/v1/user-profile")) {
      return json({ code: 0, data: { user_id: "external-id", email: "ada@example.com", user_name: "Ada" } })
    }
    throw new Error(`unexpected request ${url}`)
  }
  return { fetchImpl, calls }
}

/** Ports free on this machine, standing in for the vendor's registered callback port and the login page's port. */
async function freePorts(count) {
  const out = []
  for (let i = 0; i < count; i++) {
    const server = net.createServer()
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    out.push(server.address().port)
    server.close()
    await once(server, "close")
  }
  return out
}

const getJson = (url, init) => fetch(url, init).then((r) => r.json())

/** Whether a port can be listened on right now. */
const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })

/**
 * Start a sign-in on free ports.
 *   url            the address magpie shows the user: a container's when loginPublicUrl is set
 *   local          where the page is really served in this test
 *   callbackPort   the port the vendor will send the browser back to
 */
async function begin(options = {}, vendor = options.vendor ?? "zai") {
  const [page, callback] = await freePorts(2)
  const started = await startWebLogin(vendor, { ...options, loginPort: page, callbackPorts: [callback] })
  return {
    ...started,
    local: `http://127.0.0.1:${page}`,
    token: started.url.slice(started.url.lastIndexOf("/") + 1),
    /** the port this test handed over as "registered", which the vendor is told to send the browser to */
    callbackPort: Number(new URL(started.redirectUri).port),
    givenPort: callback,
  }
}

/** Take a sign-in to the point where the vendor's authorization page was handed out. */
async function toAuthorizationPage(vendor, options = {}) {
  const s = await begin({ ...options, fetchImpl: vendor.fetchImpl }, options.vendor ?? "zai")
  const headers = { "X-Login-Token": s.token }
  const config = await getJson(s.local + "/captcha-config", { headers })
  if (config.enabled) await fetch(s.local + "/captcha", { method: "POST", headers, body: JSON.stringify({ receipt: "opaque-receipt" }) })
  const auth = await getJson(s.local + "/open-auth", { method: "POST", headers })
  assert.equal(auth.url, AUTH_URL)
  return { ...s, headers }
}

test.beforeEach(() => resetWebLogins())

test("parseLoginAddress: what a container's environment gives, and the desktop default", () => {
  assert.deepEqual(parseLoginAddress({}), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress(undefined), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PORT: "9000" }), { host: "127.0.0.1", port: 9000, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PORT: "9000", AUTOCLAW_LOGIN_HOST: "0.0.0.0" }), { host: "0.0.0.0", port: 9000, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PUBLIC_URL: "http://box.example.com:18433" }), { host: "127.0.0.1", port: 18433, publicUrl: "http://box.example.com:18433" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PUBLIC_URL: "https://box.example.com/login/" }), { host: "127.0.0.1", port: 18433, publicUrl: "https://box.example.com/login" })
  // a value that isn't one is left out: a typo doesn't keep the user from signing in
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PORT: "abc" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PORT: "70000" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PORT: "-1" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_HOST: "nonsense" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_HOST: "192.168.1.5" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PUBLIC_URL: "javascript:alert(1)" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PUBLIC_URL: "http://user:pw@box.example.com" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
  assert.deepEqual(parseLoginAddress({ AUTOCLAW_LOGIN_PUBLIC_URL: "not a url" }), { host: "127.0.0.1", port: 18433, publicUrl: "" })
})

test("the web sign-in is a sign-in magpie's user finishes by pasting", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "google")
  assert.equal(s.method, "code", "magpie shows a field for what the user pastes, rather than waiting for a redirect")
  assert.equal(typeof s.callback, "function")
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/, "on a desktop the page is opened on this machine, at an address carrying its token")
  assert.match(s.instructions, /Callback URL/)
  assert.ok(s.instructions.includes(s.redirectUri), "the user is told where the vendor will send the browser")
  assert.equal(s.callbackPort, s.givenPort, "the vendor is told to send the browser to the port handed over as registered")
  assert.equal(new URL(s.redirectUri).hostname, "localhost", "the redirect is always a localhost: the vendor only registers loopback ports")
  await s.cancel()
})

test("the vendor is given one of the four loopback ports its client registered, when one is free", async (t) => {
  // The registered ports may be held by the AutoClaw desktop client or another program: then this can't be checked here.
  const free = []
  for (const port of REGISTERED) if (await portIsFree(port)) free.push(port)
  if (!free.length) return t.skip("all four registered callback ports are taken on this machine")
  const vendor = fakeVendor()
  const s = await startWebLogin("zai", { fetchImpl: vendor.fetchImpl, loginPort: (await freePorts(1))[0] })
  assert.ok(free.includes(Number(new URL(s.redirectUri).port)), "the first free registered port is taken")
  await s.cancel()
})

test("from a container: the redirect never reaches the plugin, the user pastes the address", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "google", loginHost: "0.0.0.0", loginPublicUrl: "http://box.example.com:18433" })
  // the address magpie opens is the one the user's browser can reach, not the container's own
  assert.match(s.url, /^http:\/\/box\.example\.com:18433\/[0-9a-f]{64}$/)
  // the vendor sends the browser to a localhost that is the user's own computer: nothing there answers for it
  const navigate = `http://localhost:${s.callbackPort}/auth/callback-google`
  assert.equal(vendor.calls.find((c) => c.url.endsWith("google-oauth-url")).body.navigate_uri, navigate)
  // the user copies the whole address from the address bar and pastes it into magpie
  const result = await s.callback(`${navigate}?code=one-time-code&state=${STATE}`)
  assert.equal(result.type, "success")
  assert.equal(result.access, JWT)
  assert.equal(result.refresh, "rt-1")
  assert.equal(result.accountId, "ada@example.com")
  assert.equal(result.uid, "777")
  const exchange = vendor.calls.find((c) => c.url.endsWith("google-oauth-login"))
  assert.deepEqual(
    { code: exchange.body.code, state: exchange.body.state, navigate: exchange.body.navigate_uri },
    { code: "one-time-code", state: STATE, navigate },
  )
  await assert.rejects(fetch(s.local + "/" + s.token), "the login page is closed once the sign-in is over")
})

test("on a desktop the page's server takes the vendor's redirect itself: nothing to paste", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "google" })
  const landed = await fetch(`http://localhost:${s.callbackPort}/auth/callback-google?code=direct-hit&state=${STATE}`)
  assert.equal(landed.status, 200)
  assert.match(await landed.text(), /授权成功/)
  const result = await s.callback("")
  assert.equal(result.type, "success")
  assert.equal(vendor.calls.find((c) => c.url.endsWith("google-oauth-login")).body.code, "direct-hit")
})

test("the redirect is also taken on the page's port, where a container's proxy sends everything", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "zai", loginHost: "0.0.0.0" })
  const landed = await fetch(`${s.local}/auth/callback-zai?code=via-proxy&state=${STATE}`)
  assert.match(await landed.text(), /授权成功/)
  assert.equal((await s.callback("")).type, "success")
  assert.equal(vendor.calls.find((c) => c.url.endsWith("zai-oauth-login")).body.code, "via-proxy")
})

test("what the user pastes: the whole address, the query string, or just the code", async () => {
  const shapes = [
    [`http://localhost:PORT/auth/callback-zai?code=c1&state=${STATE}`, "the whole address"],
    [`http://localhost:PORT/auth/callback-zai/?code=c1&state=${STATE}#`, "the address as some browsers show it"],
    [`?code=c1&state=${STATE}`, "the query string"],
    [`code=c1&state=${STATE}`, "the query string without the question mark"],
    [`c1`, "the bare code, which carries no state"],
    [`  c1  `, "the bare code with spaces around it"],
  ]
  for (const [pasted, name] of shapes) {
    resetWebLogins()
    const vendor = fakeVendor()
    const s = await toAuthorizationPage(vendor, { vendor: "zai" })
    const result = await s.callback(pasted.replace("PORT", String(s.callbackPort)))
    assert.equal(result.type, "success", name)
    const exchange = vendor.calls.find((c) => c.url.endsWith("zai-oauth-login"))
    assert.equal(exchange.body.code, "c1", name)
    // the state that goes back with the code is the vendor's, from this sign-in's authorization page
    assert.equal(exchange.body.state, STATE, name)
  }
})

test("a pasted callback is checked before anything is exchanged", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  const exchanges = () => vendor.calls.filter((c) => c.url.endsWith("zai-oauth-login")).length
  const port = s.callbackPort
  // another vendor's callback
  await assert.rejects(s.callback(`http://localhost:${port}/auth/callback-google?code=c&state=${STATE}`), /Google/)
  // another sign-in's state
  await assert.rejects(s.callback(`http://localhost:${port}/auth/callback-zai?code=c&state=not-this-one`), /state/)
  await assert.rejects(s.callback(`code=c&state=still-not-it`), /state/)
  // nothing to work with: an empty field is a submission, and says so without ending the sign-in
  for (const junk of ["", "   ", "https://accounts.example.com/auth", "http://localhost/auth/callback-zai"]) {
    await assert.rejects(s.callback(junk), /回调/)
    assert.equal((await fetch(s.local + "/" + s.token)).status, 200, `the page is still up after pasting ${JSON.stringify(junk)}`)
  }
  assert.equal(exchanges(), 0, "none of them reached the exchange")
  // the sign-in is still open for the right one
  assert.equal((await s.callback(`code=the-right-code&state=${STATE}`)).type, "success")
})

test("a word that isn't a URL or a query is taken as a bare authorization code, and the vendor judges it", async () => {
  const vendor = fakeVendor({ refuseExchange: true })
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  await assert.rejects(s.callback("hello"), /授权码无效/)
  assert.equal(vendor.calls.filter((c) => c.url.endsWith("zai-oauth-login")).length, 1, "it reached the vendor, which refused it")
})

test("the vendor refusing the authorization ends the sign-in", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  await assert.rejects(s.callback(`code=c&state=${STATE}&error=access_denied&error_description=the+user+declined`), /已取消或拒绝.*access_denied.*the user declined/)
  // the sign-in is over: a pasted code now says so, and the exchange was never made
  await assert.rejects(s.callback(`code=c&state=${STATE}`), /已取消|已过期|已结束/)
  assert.equal(vendor.calls.filter((c) => c.url.endsWith("zai-oauth-login")).length, 0)
})

test("a callback pasted before the authorization page was handed out is refused", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "zai")
  await assert.rejects(s.callback(`http://localhost:${s.callbackPort}/auth/callback-zai?code=c&state=${STATE}`), /授权页/)
  assert.equal(vendor.calls.filter((c) => c.url.endsWith("zai-oauth-login")).length, 0)
  await s.cancel()
})

test("a redirect with another state is not taken: any page could send one", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  const forged = await fetch(`http://localhost:${s.callbackPort}/auth/callback-zai?code=stolen&state=made-up`)
  assert.equal(forged.status, 200)
  assert.match(await forged.text(), /state/)
  // and without a state at all: the redirect path never goes without one
  const bare = await fetch(`http://localhost:${s.callbackPort}/auth/callback-zai?code=stolen`)
  assert.match(await bare.text(), /state/)
  // favicon and previews carry no code: not a callback, and the listener goes on waiting
  assert.equal((await fetch(`http://localhost:${s.callbackPort}/favicon.ico`)).status, 404)
  assert.equal((await fetch(`http://localhost:${s.callbackPort}/auth/callback-google?code=x&state=${STATE}`)).status, 404, "the other vendor's path isn't served on this port")
  // the real one still completes the sign-in
  const real = await fetch(`http://localhost:${s.callbackPort}/auth/callback-zai?code=the-real-one&state=${STATE}`)
  assert.match(await real.text(), /授权成功/)
  assert.equal((await s.callback("")).type, "success")
  assert.equal(vendor.calls.find((c) => c.url.endsWith("zai-oauth-login")).body.code, "the-real-one")
})

test("with the vendor's captcha switched off, the page goes straight to the authorization page", async () => {
  const vendor = fakeVendor({ captchaEnabled: false })
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  assert.equal("ali_captcha_verify_param" in vendor.calls.find((c) => c.url.endsWith("zai-oauth-url")).body, false)
  assert.equal((await s.callback(`code=c&state=${STATE}`)).type, "success")
})

test("with the captcha on, the authorization page isn't handed out without the receipt", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "google")
  const headers = { "X-Login-Token": s.token }
  const config = await getJson(s.local + "/captcha-config", { headers })
  assert.equal(config.enabled, true)
  assert.equal(config.sceneId, "scene1")
  const early = await getJson(s.local + "/open-auth", { method: "POST", headers })
  assert.match(early.error, /安全验证/)
  // a malformed receipt is refused the same way
  await fetch(s.local + "/captcha", { method: "POST", headers, body: JSON.stringify({ receipt: "bad\u0001receipt" }) })
  assert.match((await getJson(s.local + "/open-auth", { method: "POST", headers })).error, /安全验证/)
  assert.equal(vendor.calls.filter((c) => c.url.endsWith("google-oauth-url")).length, 0, "the vendor isn't asked: it would answer a misleading 631002")
  await s.cancel()
})

test("the receipt is passed on to the vendor unchanged, and not kept", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "google")
  const headers = { "X-Login-Token": s.token }
  await getJson(s.local + "/captcha-config", { headers })
  const receipt = JSON.stringify({ captchaVerifyParam: "opaque+receipt/=" })
  assert.deepEqual(await getJson(s.local + "/captcha", { method: "POST", headers, body: JSON.stringify({ receipt }) }), { ok: true })
  const auth = await getJson(s.local + "/open-auth", { method: "POST", headers })
  assert.equal(auth.url, AUTH_URL)
  assert.equal(vendor.calls.find((c) => c.url.endsWith("google-oauth-url")).body.ali_captcha_verify_param, receipt)
  assert.deepEqual(auth.callback, {
    redirectUri: `http://localhost:${s.callbackPort}/auth/callback-google`,
    message: auth.callback.message,
  })
  assert.match(auth.callback.message, /Callback URL/)
  await s.cancel()
})

test("only this sign-in's page can drive its server, whoever can reach the port", async () => {
  const vendor = fakeVendor()
  const s = await toAuthorizationPage(vendor, { vendor: "zai", loginHost: "0.0.0.0" })
  // the page carries its token, which is what lets the page's own requests through
  const page = await (await fetch(s.local + "/" + s.token)).text()
  assert.ok(page.includes(s.token), "the page carries its token")
  const headers = { "X-Login-Token": s.token }
  for (const [path, method] of [["/captcha-config", "GET"], ["/open-auth", "POST"], ["/status", "GET"]]) {
    assert.equal((await fetch(s.local + path, { method })).status, 403, `${path} without the token`)
    assert.equal((await fetch(s.local + path, { method, headers: { "X-Login-Token": "0".repeat(64) } })).status, 403, `${path} with another token`)
    assert.notEqual((await fetch(s.local + path, { method, headers })).status, 403, `${path} with the token`)
  }
  // another page of the plugin's isn't served without the token in its address
  assert.equal((await fetch(s.local + "/")).status, 403)
  assert.equal((await fetch(s.local + "/" + "a".repeat(64))).status, 403)
  // a request from another site with the token copied is still refused by its Origin
  assert.equal((await fetch(s.local + "/open-auth", { method: "POST", headers: { ...headers, Origin: "https://evil.example" } })).status, 403)
  // and one from the address the page is published at is taken
  const published = await begin({ fetchImpl: vendor.fetchImpl, loginHost: "0.0.0.0", loginPublicUrl: "https://box.example.com" }, "google")
  assert.equal((await fetch(published.local + "/status", { headers: { ...{ "X-Login-Token": published.token }, Origin: "https://box.example.com" } })).status, 200)
  await s.cancel()
  await published.cancel()
})

test("closing the page does not cancel the sign-in", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "zai")
  // In a container the page is navigated away while the user signs in on the vendor's page;
  // that must not end the sign-in. Nothing cancels it but the user, in magpie, or the timeout.
  await new Promise((resolve) => setTimeout(resolve, 50))
  // the page and the callback listener are still up
  assert.equal((await fetch(s.local + "/" + s.token)).status, 200)
  const outcome = s.callback().then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await s.cancel()
  assert.match((await outcome).error?.message ?? "", /取消/)
})

test("the login page's port taken", async () => {
  const holder = net.createServer()
  holder.listen(0, "127.0.0.1")
  await once(holder, "listening")
  const taken = holder.address().port
  const vendor = fakeVendor()
  const [callback] = await freePorts(1)
  await assert.rejects(
    startWebLogin("zai", { fetchImpl: vendor.fetchImpl, loginPort: taken, callbackPorts: [callback] }),
    (error) => error.status === 400 && /登录页面端口/.test(error.message),
  )
  // nothing is left listening on the callback port
  assert.equal(await portIsFree(callback), true)
  holder.close()
})

test("every registered callback port taken", async () => {
  const holders = []
  for (let i = 0; i < 4; i++) {
    const server = net.createServer()
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    holders.push(server)
  }
  const takenPorts = holders.map((server) => server.address().port)
  const vendor = fakeVendor()
  const [page] = await freePorts(1)
  await assert.rejects(
    startWebLogin("zai", { fetchImpl: vendor.fetchImpl, loginPort: page, callbackPorts: takenPorts }),
    (error) => error.status === 400 && /回调端口/.test(error.message),
  )
  // nothing is left listening on the login page's port either
  assert.equal(await portIsFree(page), true)
  for (const server of holders) server.close()
})

test("a vendor that can't be reached: the sign-in starts, and the page says so", async () => {
  const down = { fetchImpl: async () => {
    throw new Error("ECONNREFUSED")
  } }
  const s = await begin(down, "zai")
  const config = await getJson(s.local + "/captcha-config", { headers: { "X-Login-Token": s.token } })
  assert.equal(config.enabled, false)
  assert.match(config.error, /连接失败/)
  await s.cancel()
})

test("a refused exchange is a failed sign-in that closes the page", async () => {
  const vendor = fakeVendor({ refuseExchange: true })
  const s = await toAuthorizationPage(vendor, { vendor: "zai" })
  await assert.rejects(s.callback(`code=c&state=${STATE}`), /授权码无效/)
  await assert.rejects(fetch(s.local + "/" + s.token))
})

test("only one sign-in at a time: the previous one is replaced when a new one starts", async () => {
  const vendor = fakeVendor()
  const first = await begin({ fetchImpl: vendor.fetchImpl }, "zai")
  const outcome = first.callback().then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  const second = await begin({ fetchImpl: vendor.fetchImpl }, "google")
  // the new sign-in is up, the old one is gone
  assert.equal((await fetch(second.local + "/" + second.token)).status, 200)
  await assert.rejects(fetch(first.local + "/" + first.token), "the first sign-in's page is gone")
  assert.match((await outcome).error?.message ?? "", /取代|新的登录/, "its waiting callback is told why")
  await second.cancel()
})

test("a sign-in can be started again after one is cancelled", async () => {
  const vendor = fakeVendor()
  const [page, callback] = await freePorts(2)
  const first = await startWebLogin("zai", { fetchImpl: vendor.fetchImpl, loginPort: page, callbackPorts: [callback] })
  await first.cancel()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const second = await startWebLogin("google", { fetchImpl: vendor.fetchImpl, loginPort: page, callbackPorts: [callback] })
  assert.equal((await fetch(second.url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${page}`))).status, 200)
  await second.cancel()
})

test("the host's AbortSignal ends the sign-in and closes the page", async () => {
  const vendor = fakeVendor()
  const controller = new AbortController()
  const s = await webLoginMethod.authorize({ vendor: "zai" }, { signal: controller.signal, fetchImpl: vendor.fetchImpl })
  const outcome = s.callback(undefined, { signal: controller.signal }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  controller.abort()
  assert.match((await outcome).error?.message ?? "", /取消/)
})

test("an unknown vendor is refused before any port is taken", async () => {
  const net = await import("node:net")
  const before = (await freePorts(1))[0]
  await assert.rejects(webLoginMethod.authorize({ vendor: "github" }, { fetchImpl: fakeVendor().fetchImpl }), /只支持.*Zai.*Google|只支持.*Zai/)
  // the default port is free again: nothing was left listening
  assert.equal(await new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(18433, "127.0.0.1", () => probe.close(() => resolve(true)))
  }), true)
  void before
})

test("the web sign-in is the first method, and asks which vendor", () => {
  assert.equal(loginMethods[0], webLoginMethod)
  assert.equal(webLoginMethod.type, "oauth")
  assert.deepEqual(webLoginMethod.prompts[0].options.map((o) => o.value), ["zai", "google"])
})

test("the address the user reaches the page at is learned from their request, in a container", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl, loginHost: "0.0.0.0" }, "zai")
  // before anyone reaches it, the link magpie has is the loopback one, and the note says so
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\//)
  assert.match(s.instructions, /127\.0\.0\.1.*换成你实际访问/)
  // the user's browser opens the page from outside. fetch can't set Host (undici resets it),
  // so reach it the way a browser would: a plain request with the real Host header.
  const port = Number(new URL(s.local).port)
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" + s.token, headers: { Host: `box.example.com:${port}` } }, (res) => res.on("data", () => {}).on("end", resolve))
    req.on("error", reject)
    req.end()
  })
  const described = s.describe()
  assert.match(described.url, /^http:\/\/box\.example\.com:\d+\/[0-9a-f]{64}$/)
  assert.ok(!described.instructions.includes("换成你实际访问"), "the note about 127 is gone once learned")
  assert.ok(described.instructions.includes(described.url), "the instructions name the learned address")
  // a later request from the page's own origin passes the cross-site check, and one
  // from anywhere else is still turned away
  const origin = described.url.replace(/\/[0-9a-f]{64}$/, "")
  const withOrigin = await fetch(s.local + "/status", { headers: { "X-Login-Token": s.token, Origin: origin } })
  assert.equal(withOrigin.status, 200)
  assert.equal((await fetch(s.local + "/status", { headers: { "X-Login-Token": s.token, Origin: "https://evil.example" } })).status, 403)
  // a direct request whose Host is the container's own address doesn't wash it out
  await fetch(s.local + "/" + s.token)
  assert.match(s.describe().url, /^http:\/\/box\.example\.com:/)
  await s.cancel()
})

test("behind a reverse proxy the forwarded host and scheme are learned", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl, loginHost: "0.0.0.0" }, "google")
  await fetch(s.local + "/" + s.token, { headers: { "X-Forwarded-Host": "app.example.com", "X-Forwarded-Proto": "https" } })
  const described = s.describe()
  assert.match(described.url, /^https:\/\/app\.example\.com\/[0-9a-f]{64}$/)
  // and a request from that origin passes
  const outcome = await getJson(s.local + "/status", { headers: { "X-Login-Token": s.token, Origin: "https://app.example.com" } })
  assert.deepEqual(outcome, { received: false, closed: false, error: "" })
  await s.cancel()
})

test("a configured PUBLIC_URL is never replaced by a learned one", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl, loginHost: "0.0.0.0", loginPublicUrl: "http://set.example.com:18433" }, "zai")
  await fetch(s.local + "/" + s.token, { headers: { Host: "box.example.com:" + s.local.split(":")[2] } })
  assert.match(s.describe().url, /^http:\/\/set\.example\.com:18433\//)
  // an Origin from the configured address passes; one from anywhere else still doesn't
  assert.equal((await fetch(s.local + "/status", { headers: { "X-Login-Token": s.token, Origin: "http://set.example.com:18433" } })).status, 200)
  assert.equal((await fetch(s.local + "/status", { headers: { "X-Login-Token": s.token, Origin: "https://evil.example" } })).status, 403)
  await s.cancel()
})

test("a desktop install (127.0.0.1) doesn't learn an address", async () => {
  const vendor = fakeVendor()
  const s = await begin({ fetchImpl: vendor.fetchImpl }, "zai")
  await fetch(s.local + "/" + s.token, { headers: { Host: "box.example.com:" + s.local.split(":")[2] } })
  assert.match(s.describe().url, /^http:\/\/127\.0\.0\.1:\d+\//, "the loopback link stands")
  assert.ok(!s.describe().instructions.includes("换成你实际访问"), "no note about 127 on a desktop: the link is right as it is")
  await s.cancel()
})
