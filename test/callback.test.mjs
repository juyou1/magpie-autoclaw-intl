import assert from "node:assert/strict"
import { test } from "node:test"

import { parsePastedCallback, parseQuery, percentDecode } from "../src/callback.mjs"

const CODE = "4/0A4RR5FWBuQexamplecodegeneratedbygoogleandpercentencoded"
const STATE = "st-ate.123~abc"

test("percentDecode: escapes, a plus as a space, malformed escapes kept", () => {
  assert.equal(percentDecode("a%20b"), "a b")
  assert.equal(percentDecode("a+b"), "a b")
  assert.equal(percentDecode("%2F"), "/")
  assert.equal(percentDecode("a%2"), "a%2")
  assert.equal(percentDecode("%zz"), "%zz")
  assert.equal(percentDecode("100%"), "100%")
  assert.equal(percentDecode("%E4%BD%A0%E5%A5%BD"), "你好")
  assert.equal(percentDecode(""), "")
  assert.equal(percentDecode(undefined), "")
})

test("parseQuery: pairs, a key without a value, the first of a repeated key", () => {
  assert.deepEqual(parseQuery(`code=${CODE}&state=${STATE}`), { code: CODE, state: STATE })
  assert.deepEqual(parseQuery("a=1&flag&b="), { a: "1", flag: "", b: "" })
  assert.deepEqual(parseQuery("a=1&a=2"), { a: "1" })
  assert.deepEqual(parseQuery(""), {})
  assert.deepEqual(parseQuery("&&"), {})
  assert.deepEqual(parseQuery(undefined), {})
  assert.deepEqual(parseQuery("error=access_denied&error_description=user+denied"), { error: "access_denied", error_description: "user denied" })
})

test("the whole callback URL, as the browser shows it", () => {
  const pasted = parsePastedCallback(`http://localhost:18432/auth/callback-zai?code=${CODE}&state=${STATE}`)
  assert.equal(pasted.vendor, "zai")
  assert.equal(pasted.code, CODE)
  assert.equal(pasted.params.state, STATE)
  assert.equal(parsePastedCallback(`http://localhost:53699/auth/callback-google?code=${CODE}&state=${STATE}`).vendor, "google")
})

test("the whole URL the browser may have modified", () => {
  // a trailing slash or a fragment, upper-case scheme, whitespace around it
  assert.equal(parsePastedCallback(`  HTTP://localhost:18432/auth/callback-zai/?code=${CODE}&state=${STATE}#x  `)?.code, CODE)
  assert.equal(parsePastedCallback(`http://localhost:18432/auth/callback-zai/?code=${CODE}&state=${STATE}#x`).vendor, "zai")
  assert.equal(parsePastedCallback(`http://127.0.0.1:18432/auth/callback-zai?code=${CODE}&state=${STATE}`).vendor, "zai")
  // the browser resolved localhost to [::1]
  assert.equal(parsePastedCallback(`http://[::1]:18432/auth/callback-zai?code=${CODE}&state=${STATE}`).code, CODE)
})

test("the path without the origin", () => {
  const pasted = parsePastedCallback(`/auth/callback-zai?code=${CODE}&state=${STATE}`)
  assert.deepEqual([pasted.vendor, pasted.code, pasted.params.state], ["zai", CODE, STATE])
  assert.equal(parsePastedCallback("/auth/callback-zai")?.code, undefined, "the path alone carries no code")
})

test("the bare query string, with or without a leading question mark", () => {
  for (const text of [`code=${CODE}&state=${STATE}`, `?code=${CODE}&state=${STATE}`]) {
    const pasted = parsePastedCallback(text)
    assert.equal(pasted.vendor, null)
    assert.equal(pasted.code, CODE)
    assert.equal(pasted.params.state, STATE)
  }
})

test("the bare authorization code", () => {
  const pasted = parsePastedCallback(CODE)
  assert.equal(pasted.vendor, null)
  assert.equal(pasted.code, CODE)
  assert.equal(pasted.params.state, undefined)
})

test("what is refused: nothing to work with", () => {
  assert.equal(parsePastedCallback(""), null)
  assert.equal(parsePastedCallback("   "), null)
  assert.equal(parsePastedCallback(null), null)
  assert.equal(parsePastedCallback("http://localhost:18432/auth/callback-zai"), null, "a URL without a query")
  assert.equal(parsePastedCallback("http://localhost:18432/"), null)
  assert.equal(parsePastedCallback("https://accounts.google.com/o/oauth2/auth"), null)
  assert.equal(parsePastedCallback("code=&state=x"), null, "an empty code is no code")
})

test("a refusal the vendor sent back", () => {
  const pasted = parsePastedCallback("http://localhost:18432/auth/callback-zai?error=access_denied&error_description=the+user+declined&state=s1")
  assert.equal(pasted.code, "")
  assert.equal(pasted.error, "access_denied")
  assert.equal(pasted.params.error_description, "the user declined")
  assert.equal(pasted.vendor, "zai")
})

test("a code that happens to contain an equals sign still reads as the bare code when there is no code=", () => {
  const odd = "abc=def"
  const pasted = parsePastedCallback(odd)
  assert.equal(pasted.params.code, odd)
})

test("a different callback path prefix", () => {
  const pasted = parsePastedCallback("/cb/zai?code=c1&state=s1", { callbackPathPrefix: "/cb/" })
  assert.equal(pasted.vendor, "zai")
  assert.equal(pasted.code, "c1")
})
