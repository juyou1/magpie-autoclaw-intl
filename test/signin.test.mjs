import assert from "node:assert/strict"
import { test } from "node:test"

import { completeFromProfile, expiryOf, fetchProfile, newDeviceId, successFrom } from "../src/signin.mjs"

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`
const JWT = jwt({ user_id: "777", device_id: "ddev", exp: 4070902400 })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const PROFILE = { code: 0, data: { user_id: "ext", email: "ada@example.com", user_name: "Ada" } }

/** A stand-in vendor with the profile route, recording what it was asked. */
function vendor(reply = () => json(PROFILE)) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
    return reply(url)
  }
  return { fetchImpl, calls }
}

test("newDeviceId: 64 hex characters, a new one each time", () => {
  const a = newDeviceId()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, newDeviceId())
})

test("expiryOf: the token's exp, then expires_in, else nothing", () => {
  assert.equal(expiryOf(JWT, 99999, 1), 4070902400000 - 600000, "the token's exp wins, ten minutes early")
  assert.equal(expiryOf("opaque", 3600, 1_700_000_000_000), 1_700_000_000_000 + 3600_000 - 600_000)
  assert.equal(expiryOf("opaque", 0, 1), undefined)
  assert.equal(expiryOf("opaque", undefined, 1), undefined)
})

test("successFrom: the identity is the token's user_id, and the public fields are each their own", () => {
  const s = successFrom({ accessToken: `Bearer ${JWT}`, refreshToken: "Bearer rt", userId: "external-id", userName: "Ada", email: "ada@example.com", now: () => 1 })
  assert.deepEqual(s, {
    type: "success",
    access: JWT,
    refresh: "rt",
    expires: 4070902400000 - 600000,
    uid: "777",
    accountId: "ada@example.com",
    email: "ada@example.com",
    name: "Ada",
    deviceId: "ddev",
  })
})

test("successFrom: what isn't known is left out", () => {
  assert.deepEqual(successFrom({ accessToken: "opaque", refreshToken: "", now: () => 1 }), { type: "success", access: "opaque" })
  const named = successFrom({ accessToken: "opaque", refreshToken: "", userId: "u1", userName: "Bob", deviceId: "dev" })
  assert.deepEqual(named, { type: "success", access: "opaque", uid: "u1", accountId: "u1", name: "Bob", deviceId: "dev" })
})

test("successFrom: a public field never carries the credential, a control character or an over-long value", () => {
  assert.deepEqual(successFrom({ accessToken: "opaque", refreshToken: "rt", userId: "opaque" }), { type: "success", access: "opaque", refresh: "rt" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "rt", userId: "rt" }), { type: "success", access: "t", refresh: "rt" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "", userId: "u\u007f1", email: "a\u0000b@c.d", userName: "x".repeat(1025) }), { type: "success", access: "t" })
  assert.deepEqual(successFrom({ accessToken: "t", refreshToken: "", userId: "42" }), { type: "success", access: "t", uid: "42", accountId: "42" })
})

test("successFrom: a response without a usable token is an error", () => {
  assert.throws(() => successFrom({ accessToken: "", refreshToken: "" }), /没有有效的 access_token/)
  assert.throws(() => successFrom({ accessToken: "has space", refreshToken: "" }), /没有有效的 access_token/)
  assert.throws(() => successFrom({ accessToken: "t", refreshToken: "bad token" }), /refresh_token 无效/)
})

test("fetchProfile: asked with the device id; a profile without data is an empty one", async () => {
  const v = vendor()
  assert.deepEqual(await fetchProfile(JWT, "ddev", { fetchImpl: v.fetchImpl }), { userId: "ext", email: "ada@example.com", name: "Ada" })
  assert.deepEqual(v.calls[0], { url: "https://autoglm-api.autoglm.ai/userapi/v1/user-profile", body: { source_id: "autotyper", device_id: "ddev" } })
  const bare = vendor(() => json({ code: 0 }))
  assert.deepEqual(await fetchProfile(JWT, "", { fetchImpl: bare.fetchImpl }), { userId: "", email: "", name: "" })
  assert.deepEqual(bare.calls[0].body, { source_id: "autotyper" })
})

test("completeFromProfile: completes a bare result, and never overrides the token's identity", async () => {
  const v = vendor()
  const bare = successFrom({ accessToken: "opaque-without-identity", refreshToken: "rt" })
  const done = await completeFromProfile(bare, "dev1", { fetchImpl: v.fetchImpl })
  assert.equal(done.uid, "ext")
  assert.equal(done.accountId, "ada@example.com")
  assert.equal(done.email, "ada@example.com")
  assert.equal(done.name, "Ada")
  assert.equal(done.deviceId, "dev1")
  assert.equal(done.refresh, "rt")

  const fromToken = successFrom({ accessToken: JWT, refreshToken: "rt", deviceId: "ddev" })
  const kept = await completeFromProfile(fromToken, "ignored", { fetchImpl: v.fetchImpl })
  assert.equal(kept.uid, "777", "the token's user_id stands")
  assert.equal(kept.accountId, "ada@example.com")
  assert.equal(kept.deviceId, "ddev", "the device the sign-in already had stands")
})

test("completeFromProfile: a profile that can't be read changes nothing; one that refuses the token is a sign-in failure", async () => {
  const bare = successFrom({ accessToken: "opaque-without-identity", refreshToken: "rt" })
  assert.deepEqual(await completeFromProfile(bare, "dev1", { fetchImpl: vendor(() => json({ message: "down" }, 500)).fetchImpl }), bare)
  assert.deepEqual(await completeFromProfile(bare, "dev1", { fetchImpl: async () => {
    throw new Error("ECONNRESET")
  } }), bare)
  await assert.rejects(completeFromProfile(bare, "dev1", { fetchImpl: vendor(() => json({ code: 410000 })).fetchImpl }), (error) => error.signIn === "expired")
})
