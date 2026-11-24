import assert from "node:assert/strict"
import { test } from "node:test"

import { businessCode, checkBusiness, classify, hasError, parseBody, UpstreamError, upstreamError } from "../src/errors.mjs"

function caught(fn) {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

test("parseBody keeps JSON, and the raw text when it isn't JSON", () => {
  assert.deepEqual(parseBody('{"a":1}'), { a: 1 })
  assert.equal(parseBody("<html>"), "<html>")
  assert.equal(parseBody(""), null)
  assert.equal(parseBody(undefined), null)
})

test("businessCode reads the nested spellings and only whole integers", () => {
  assert.equal(businessCode({ code: 0 }), 0)
  assert.equal(businessCode({ code: "410000" }), 410000)
  assert.equal(businessCode({ error: { upstream_code: "410000" } }), 410000)
  assert.equal(businessCode({ error: { code: 810000 } }), 810000)
  assert.equal(businessCode({ code: "810000abc" }), undefined)
  assert.equal(businessCode({ code: "content_filter" }), undefined)
  assert.equal(businessCode("text"), undefined)
  assert.equal(businessCode(null), undefined)
})

test("hasError", () => {
  assert.equal(hasError({ code: 5 }), true)
  assert.equal(hasError({ error: { message: "x" } }), true)
  assert.equal(hasError({ type: "error" }), true)
  assert.equal(hasError({ code: 0 }), false)
  assert.equal(hasError({ choices: [] }), false)
  assert.equal(hasError("data"), false)
})

test("classify: a spent free quota is 429 and keeps the sign-in", () => {
  const c = classify(403, { code: 810000, msg: "GLM-5.3 免费额度已用完" })
  assert.equal(c.kind, "quota_limited")
  assert.equal(c.status, 429)
  assert.match(c.message, /免费额度已用完/)
})

test("classify: a busy model is 429, not a sign-in refusal", () => {
  const c = classify(429, { code: 810001 })
  assert.equal(c.kind, "quota_limited")
  assert.equal(c.status, 429)
})

test("classify: a banned account is a 403 of the account's", () => {
  const c = classify(403, { code: 410004, message: "The account has been banned" })
  assert.equal(c.kind, "fatal")
  assert.equal(c.status, 403)
  assert.match(c.message, /封禁/)
})

test("classify: the sign-in refused", () => {
  assert.equal(classify(401, {}).kind, "token_expired")
  assert.equal(classify(200, { code: 410000 }).status, 401)
  assert.equal(classify(200, { code: 400000 }).kind, "token_expired")
})

test("classify: content policy", () => {
  const c = classify(400, { code: "content_filter" })
  assert.equal(c.kind, "content_blocked")
  assert.equal(c.status, 400)
  assert.equal(classify(403, { message: "blocked by security policy" }).kind, "content_blocked")
})

test("classify: anything else is a plain upstream failure", () => {
  assert.equal(classify(200, {}).status, 502)
  assert.equal(classify(500, { message: "boom" }).status, 500)
  assert.equal(classify(999, {}).status, 502)
})

test("upstreamError: only a refused sign-in is expired", () => {
  assert.equal(upstreamError(401, { message: "x" }).signIn, "expired")
  assert.equal(upstreamError(403, { code: 810000 }).signIn, "kept")
  assert.equal(upstreamError(403, { code: 410004 }).signIn, "kept")
  assert.equal(upstreamError(400, { code: "content_filter" }).code, "content_filter")
  assert.equal(upstreamError(502, { code: 500123 }).code, "500123")
  assert.equal(upstreamError(502, {}).code, "upstream_error")
})

test("checkBusiness: code 0 and the legacy data-only envelope succeed", () => {
  assert.deepEqual(checkBusiness({ code: 0, data: { a: 1 } }), { code: 0, data: { a: 1 } })
  assert.deepEqual(checkBusiness({ data: { ok: 1 } }), { data: { ok: 1 } })
})

test("checkBusiness: the sign-in codes are a 401", () => {
  const error = caught(() => checkBusiness({ code: 410000 }, "查询积分"))
  assert.ok(error instanceof UpstreamError)
  assert.equal(error.status, 401)
  assert.equal(error.signIn, "expired")
  assert.match(error.message, /无法查询积分/)
  assert.match(error.message, /410000/)
})

test("checkBusiness: quota, ban and unknown codes", () => {
  assert.equal(caught(() => checkBusiness({ code: 810000 })).status, 429)
  assert.equal(caught(() => checkBusiness({ code: 410004 })).status, 403)
  const other = caught(() => checkBusiness({ code: 400001, msg: "参数被拒" }))
  assert.equal(other.status, 502)
  assert.equal(other.signIn, "kept")
  assert.match(other.message, /参数被拒/)
  assert.equal(caught(() => checkBusiness({ code: 7 })).upstreamCode, 7)
})

test("checkBusiness: an error field without a code fails", () => {
  assert.equal(caught(() => checkBusiness({ error: { message: "bad" } })).status, 502)
  assert.equal(caught(() => checkBusiness({ type: "error", data: {} })).status, 502)
})
