import assert from "node:assert/strict"
import { once } from "node:events"
import { test } from "node:test"

import { credentialJsonMethod, parseCredentialJson, startLocalOauth, successFrom, tokenMethod, verifyCredentials, webLoginMethod } from "../src/login.mjs"
import { ALIYUN_CAPTCHA_JS } from "../src/util.mjs"

const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: "777", device_id: "ddev", exp: 4070902400 })).toString("base64url")}.sig`
const STATE = "vendor-state-1"

/** A stand-in for the vendor: answers the four routes the sign-in uses and records what it was asked. */
function fakeVendor({ captchaEnabled = true, refuseExchange = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    calls.push({ url, body, headers })
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
    if (url.endsWith("/userapi/overseasv1/oauth-captcha-config")) {
      return json({ code: 0, data: captchaEnabled ? { enabled: true, captcha_supplier: "aliyun", region: "cn-hangzhou", prefix: "sq51tr", scene_id: "scene1" } : { enabled: false } })
    }
    if (/\/userapi\/overseasv1\/(zai|google)-oauth-url$/.test(url)) {
      if (!captchaEnabled) return json({ code: 0, data: { oauth_url: "https://accounts.example.com/auth?state=" + STATE } })
      if (!body.ali_captcha_verify_param) return json({ code: 631002, msg: "当前版本已停止服务" })
      return json({ code: 0, data: { oauth_url: "https://accounts.example.com/auth?state=" + STATE } })
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

/** Ports free on this machine, standing in for the client's registered pool. */
async function freePorts(count) {
  const net = await import("node:net")
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("successFrom: the JWT's user_id is the identity; email and nickname are separate fields", () => {
  const s = successFrom({ accessToken: `Bearer ${JWT}`, refreshToken: "Bearer rt", deviceId: "devfile", userId: "external-id", userName: "Ada", email: "ada@example.com", now: () => 1 })
  assert.equal(s.type, "success")
  assert.equal(s.access, JWT)
  assert.equal(s.refresh, "rt")
  assert.equal(s.uid, "777")
  assert.equal(s.accountId, "ada@example.com")
  assert.equal(s.email, "ada@example.com")
  assert.equal(s.name, "Ada")
  assert.equal(s.expires, 4_070_902_400_000 - 600_000)
  assert.equal(s.deviceId, "devfile")
})

test("successFrom: what isn't known is left out", () => {
  assert.deepEqual(successFrom({ accessToken: "opaque", refreshToken: "", now: () => 1 }), { type: "success", access: "opaque" })
  const named = successFrom({ accessToken: "opaque", refreshToken: "", userId: "u1", userName: "Bob" })
  assert.equal(named.accountId, "u1")
  assert.equal(named.name, "Bob")
  assert.equal("email" in named, false)
})

test("successFrom: a public field never carries the credential, a control character or an over-long value", () => {
  assert.deepEqual(successFrom({ accessToken: "opaque", refreshToken: "rt", userId: "opaque" }), { type: "success", access: "opaque", refresh: "rt" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "rt", userId: "rt" }), { type: "success", access: "t", refresh: "rt" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "", userId: "u\u007f1" }), { type: "success", access: "t" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "", userId: "x".repeat(1025) }), { type: "success", access: "t" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "", userId: "42" }), { type: "success", access: "t", uid: "42", accountId: "42" })
})

test("successFrom: a response without a usable access token is an error", () => {
  assert.throws(() => successFrom({ accessToken: "", refreshToken: "" }), /没有有效的 access_token/)
  assert.throws(() => successFrom({ accessToken: "has space", refreshToken: "" }), /没有有效的 access_token/)
})

test("parseCredentialJson: a credential object, a whole auth.json, and what is refused", () => {
  assert.equal(parseCredentialJson('{"token":"t","userInfo":{"email":"x@y.z"}}').email, "x@y.z")
  assert.equal(parseCredentialJson('{"provider":"autoclaw-intl","token":"t"}').token, "t")
  assert.throws(() => parseCredentialJson("{bad"), /JSON 格式无效/)
  assert.throws(() => parseCredentialJson("[1]"), /必须是 JSON 对象/)
  assert.throws(() => parseCredentialJson('{"provider":"autoclaw-cn","token":"t"}'), /不属于国际版/)
})

test("verifyCredentials: a pasted token is checked against the vendor and completed from the profile", async () => {
  const vendor = fakeVendor()
  const v = await verifyCredentials({ token: `Bearer ${JWT}`, refreshToken: "rt" }, { fetchImpl: vendor.fetchImpl })
  assert.equal(v.access, JWT)
  assert.equal(v.uid, "777")
  assert.equal(v.accountId, "ada@example.com")
  assert.equal(v.deviceId, "ddev")

  const bare = await verifyCredentials({ token: "opaque-without-identity", refreshToken: "" }, { fetchImpl: vendor.fetchImpl })
  assert.equal(bare.uid, "external-id")
  assert.match(bare.deviceId, /^[0-9a-f]{64}$/)
})

test("verifyCredentials: what is refused", async () => {
  const vendor = fakeVendor()
  await assert.rejects(
    verifyCredentials({ token: JWT, refreshToken: "rt", userId: "someone-else" }, { fetchImpl: vendor.fetchImpl }),
    /用户标识与令牌身份不一致/,
  )
  const refused = async () => new Response(JSON.stringify({ code: 410000 }), { headers: { "content-type": "application/json" } })
  await assert.rejects(verifyCredentials({ token: "opaque", refreshToken: "" }, { fetchImpl: refused }), /登录态已失效/)
  const empty = async () => new Response(JSON.stringify({ code: 0, data: {} }), { headers: { "content-type": "application/json" } })
  await assert.rejects(verifyCredentials({ token: "opaque", refreshToken: "" }, { fetchImpl: empty }), /未给出账号身份/)
  const never = async () => {
    throw new Error("must not request")
  }
  await assert.rejects(verifyCredentials({ token: "enc:abc", refreshToken: "" }, { fetchImpl: never }), /enc: 加密形态/)
  await assert.rejects(verifyCredentials({ token: "has space", refreshToken: "" }, { fetchImpl: never }), /格式无效/)
  // the mismatched identity is refused on the token alone: the vendor is not asked
  const before = vendor.calls.length
  await assert.rejects(
    verifyCredentials({ token: JWT, refreshToken: "rt", userId: "someone-else" }, { fetchImpl: vendor.fetchImpl }),
    /用户标识与令牌身份不一致/,
  )
  assert.equal(vendor.calls.length, before)
})

test("the methods: types, prompts and that secrets are typed unseen", () => {
  assert.equal(webLoginMethod.type, "oauth")
  assert.deepEqual(webLoginMethod.prompts[0].options.map((o) => o.value), ["zai", "google"])
  assert.equal(tokenMethod.type, "oauth")
  assert.equal(tokenMethod.prompts[0].type, "password")
  assert.equal(tokenMethod.prompts[1].type, "password")
  assert.equal(credentialJsonMethod.prompts[0].type, "password")
  assert.equal(credentialJsonMethod.prompts[0].validate('{"token":"t"}'), undefined)
  assert.match(credentialJsonMethod.prompts[0].validate("{bad"), /JSON 格式无效/)
  assert.equal(tokenMethod.prompts[0].validate("  "), "请填写 access token")
})

test("the token and JSON methods: both are oauth sign-ins that go through the same check", async () => {
  // The methods talk to the vendor; the stand-in answers with a profile, so a pasted token is completed from it.
  const vendor = fakeVendor()
  const viaToken = await tokenMethod.authorize({ token: JWT, refreshToken: "rt" }, { fetchImpl: vendor.fetchImpl })
  assert.equal(viaToken.type, "success")
  assert.equal(viaToken.access, JWT)
  assert.equal(viaToken.refresh, "rt")
  assert.equal(viaToken.uid, "777")
  const viaJson = await credentialJsonMethod.authorize({ credentialJson: JSON.stringify({ token: JWT, refreshToken: "rt", userInfo: { email: "who@example.com" } }) }, { fetchImpl: vendor.fetchImpl })
  assert.equal(viaJson.type, "success")
  assert.equal(viaJson.email, "who@example.com")
  // A token the vendor refuses is a failed sign-in, not a saved account.
  const refused = async () => new Response(JSON.stringify({ code: 410000 }), { headers: { "content-type": "application/json" } })
  await assert.rejects(tokenMethod.authorize({ token: "opaque" }, { fetchImpl: refused }), /登录态已失效/)
})

test("web sign-in: the whole loop against a stand-in vendor", async () => {
  const vendor = fakeVendor()
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("google", { fetchImpl: vendor.fetchImpl, ports: [port], now: () => 1_700_000_000_000 })
  const base = `http://127.0.0.1:${port}`
  try {
    // 1. the guide page, with the captcha SDK's address in it
    const page = await (await fetch(base + "/")).text()
    assert.match(page, /AutoClaw · Google 登录/)
    assert.ok(page.includes(ALIYUN_CAPTCHA_JS))
    assert.equal(page.includes("<script src="), false)

    // 2. the captcha config the page reads
    const config = await (await fetch(base + "/captcha-config")).json()
    assert.equal(config.enabled, true)
    assert.equal(config.sceneId, "scene1")

    // 3. a page on another site can't drive the local server
    const foreign = await fetch(base + "/open-auth", { method: "POST", headers: { Origin: "https://evil.example" } })
    assert.equal(foreign.status, 403)

    // 4. the guide page hands in the captcha receipt
    const receipt = await (await fetch(base + "/captcha", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ receipt: '{"captchaVerifyParam":"opaque-receipt"}' }) })).json()
    assert.equal(receipt.ok, true)

    // 5. without a receipt the vendor would answer 631002; with it the page gets the authorization URL
    const auth = await (await fetch(base + "/open-auth", { method: "POST", headers: { Origin: base } })).json()
    assert.equal(auth.url, "https://accounts.example.com/auth?state=" + STATE)
    const urlCall = vendor.calls.find((c) => c.url.endsWith("google-oauth-url"))
    assert.equal(urlCall.body.ali_captcha_verify_param, '{"captchaVerifyParam":"opaque-receipt"}')
    assert.equal(urlCall.body.navigate_uri, `http://localhost:${port}/auth/callback-google`)
    assert.equal(urlCall.body.source_id, "autoclaw")
    assert.match(urlCall.body.device_id, /^[0-9a-f]{64}$/)
    assert.equal(urlCall.headers.authorization, undefined)

    // 6. a callback without the state, or with another one, is refused and the flow goes on
    const forged = await fetch(`${base}/auth/callback-google?code=stolen&state=someone-elses`)
    assert.match(await forged.text(), /state 不匹配/)
    await sleep(50)
    let settled = false
    const pending = flow.callback().finally(() => {
      settled = true
    })
    await sleep(50)
    assert.equal(settled, false)

    // 7. the real redirect; the code is exchanged with the state the vendor handed out
    const landed = await fetch(`${base}/auth/callback-google?code=one-time-code&state=${STATE}`)
    assert.match(await landed.text(), /授权成功/)
    const result = await pending
    assert.equal(result.type, "success")
    assert.equal(result.access, JWT)
    assert.equal(result.refresh, "rt-1")
    assert.equal(result.uid, "777")
    assert.equal(result.accountId, "ada@example.com")
    assert.equal(result.email, "ada@example.com")
    assert.equal(result.name, "Ada")
    const exchange = vendor.calls.find((c) => c.url.endsWith("google-oauth-login"))
    assert.deepEqual(
      { code: exchange.body.code, state: exchange.body.state, navigate: exchange.body.navigate_uri, device: exchange.body.device_id === urlCall.body.device_id },
      { code: "one-time-code", state: STATE, navigate: `http://localhost:${port}/auth/callback-google`, device: true },
    )
  } finally {
    await sleep(50)
  }
  // the loopback port is released once the sign-in is over
  await assert.rejects(fetch(base + "/"))
})

test("web sign-in: with the captcha on, the authorization URL needs the receipt first", async () => {
  const vendor = fakeVendor()
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("zai", { fetchImpl: vendor.fetchImpl, ports: [port] })
  const base = `http://127.0.0.1:${port}`
  try {
    await (await fetch(base + "/captcha-config")).json()
    // No receipt yet: the page is told so, and the vendor is not asked (it would answer a misleading 631002).
    const early = await (await fetch(base + "/open-auth", { method: "POST" })).json()
    assert.match(early.error, /请先完成安全验证/)
    assert.equal(vendor.calls.filter((c) => c.url.endsWith("zai-oauth-url")).length, 0)
    // A malformed receipt is refused the same way.
    await fetch(base + "/captcha", { method: "POST", body: JSON.stringify({ receipt: "bad\u0001receipt" }) })
    assert.match((await (await fetch(base + "/open-auth", { method: "POST" })).json()).error, /请先完成安全验证/)
  } finally {
    flow.cancel("测试结束")
  }
  await assert.rejects(fetch(base + "/"))
})

test("web sign-in: the host's AbortSignal ends the wait and releases the port", async () => {
  const vendor = fakeVendor()
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("zai", { fetchImpl: vendor.fetchImpl, ports: [port] })
  const base = `http://127.0.0.1:${port}`
  const controller = new AbortController()
  const outcome = flow.callback(controller.signal).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await sleep(30)
  controller.abort()
  assert.match((await outcome).error?.message ?? "", /登录已取消/)
  await assert.rejects(fetch(base + "/"))
})

test("web sign-in: a refused exchange is a failed sign-in that closes the port", async () => {
  const vendor = fakeVendor({ refuseExchange: true })
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("zai", { fetchImpl: vendor.fetchImpl, ports: [port] })
  const base = `http://127.0.0.1:${port}`
  await (await fetch(base + "/captcha-config")).json()
  await fetch(base + "/captcha", { method: "POST", body: JSON.stringify({ receipt: "opaque-receipt" }) })
  const auth = await (await fetch(base + "/open-auth", { method: "POST" })).json()
  assert.equal(auth.error, undefined)
  const pending = flow.callback()
  // rejection is observed from the start, so a failure before it is awaited is not an unhandled rejection
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await fetch(`${base}/auth/callback-zai?code=c&state=${STATE}`)
  const result = await outcome
  assert.match(result.error?.message ?? "", /授权码无效或已过期/)
  await assert.rejects(fetch(base + "/"))
})

test("web sign-in: a vendor with the captcha switched off needs no receipt", async () => {
  const vendor = fakeVendor({ captchaEnabled: false })
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("zai", { fetchImpl: vendor.fetchImpl, ports: [port] })
  const base = `http://127.0.0.1:${port}`
  const config = await (await fetch(base + "/captcha-config")).json()
  assert.equal(config.enabled, false)
  const auth = await (await fetch(base + "/open-auth", { method: "POST" })).json()
  assert.ok(auth.url)
  assert.equal("ali_captcha_verify_param" in vendor.calls.find((c) => c.url.endsWith("zai-oauth-url")).body, false)
  const outcome = flow.callback().then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await fetch(`${base}/auth/callback-zai?code=c&state=${STATE}`)
  assert.equal((await outcome).value?.type, "success")
})

test("web sign-in: closing the guide page cancels the sign-in", async () => {
  const vendor = fakeVendor()
  const [port] = await freePorts(1)
  const flow = await startLocalOauth("zai", { fetchImpl: vendor.fetchImpl, ports: [port] })
  const base = `http://127.0.0.1:${port}`
  const outcome = flow.callback().then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await fetch(base + "/abort", { method: "POST", headers: { Origin: base }, body: JSON.stringify({ reason: "页面关闭" }) })
  assert.match((await outcome).error?.message ?? "", /页面关闭/)
  await assert.rejects(fetch(base + "/"))
})

test("web sign-in: an unknown vendor is refused before any port is taken", async () => {
  await assert.rejects(startLocalOauth("github", { fetchImpl: fakeVendor().fetchImpl }), /只支持 Zai 或 Google/)
})
