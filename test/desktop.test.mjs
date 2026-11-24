import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createCipheriv, randomBytes } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { credentialsFrom, decryptEncValue, readDesktopCredentials, userDataDir } from "../src/desktop.mjs"

const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: "424242", device_id: "devfile", exp: 4070902400 })).toString("base64url")}.sig`
const REFRESH = "refresh-token-value-0123456789"
const WINDOWS = process.platform === "win32"

/** 加密成 Electron safeStorage 的形态：v10 + nonce(12) + ciphertext + tag(16)。 */
function enc(value, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final(), cipher.getAuthTag()])
  return `enc:${Buffer.concat([Buffer.from("v10"), nonce, body]).toString("base64")}`
}

function caught(fn) {
  try {
    return fn()
  } catch (error) {
    return error
  }
}

test("decryptEncValue: round trip, and a plain value passes through", () => {
  const key = randomBytes(32)
  assert.equal(decryptEncValue(enc("hello 你好", key), key), "hello 你好")
  assert.equal(decryptEncValue("plain-token", undefined), "plain-token")
  assert.equal(decryptEncValue("", undefined), "")
})

test("decryptEncValue: wrong key, no key, other versions and malformed input are errors", () => {
  const key = randomBytes(32)
  assert.match(caught(() => decryptEncValue(enc("x", key), randomBytes(32))).message, /AES-GCM 解密失败/)
  assert.match(caught(() => decryptEncValue(enc("x", key), undefined)).message, /没有可用的 os_crypt 密钥/)
  const v11 = `enc:${Buffer.concat([Buffer.from("v11"), randomBytes(40)]).toString("base64")}`
  assert.match(caught(() => decryptEncValue(v11, key)).message, /不支持的 os_crypt 密文版本: v11/)
  const short = `enc:${Buffer.concat([Buffer.from("v10"), randomBytes(28)]).toString("base64")}`
  assert.match(caught(() => decryptEncValue(short, key)).message, /密文长度异常/)
  // Garbage still fails as an unsupported version (its first bytes aren't "v10"), never as a crash.
  assert.match(caught(() => decryptEncValue("enc:!!!not-base64", key)).message, /不支持的 os_crypt 密文版本|密文长度异常|解密失败/)
  // The raw bytes of a bad value never reach the message: no control characters in it.
  assert.doesNotMatch(caught(() => decryptEncValue("enc:!!!not-base64", key)).message, /[\x00-\x1f\x7f-\x9f]/)
})

test("decryptEncValue: a decrypted value that isn't UTF-8 is an error", () => {
  const key = randomBytes(32)
  // 0xFF alone is never valid UTF-8; it must not come back as a replacement character.
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from([0xff, 0xfe])), cipher.final(), cipher.getAuthTag()])
  const value = `enc:${Buffer.concat([Buffer.from("v10"), nonce, body]).toString("base64")}`
  assert.match(caught(() => decryptEncValue(value, key)).message, /不是合法 UTF-8/)
})

test("credentialsFrom: identity and device come from the JWT when not given", () => {
  const c = credentialsFrom(`Bearer ${JWT}`, REFRESH, "", {})
  assert.equal(c.access, JWT)
  assert.equal(c.refresh, REFRESH)
  assert.equal(c.expires, 4_070_902_400_000)
  assert.equal(c.uid, "424242")
  assert.equal(c.accountId, "424242")
  assert.equal(c.deviceId, "devfile")
  assert.equal("email" in c, false)
})

test("credentialsFrom: explicit values win; a missing refresh or expiry is left out", () => {
  const c = credentialsFrom("tok", "", "dev-explicit", { userId: "u1", email: "a@b.c" })
  assert.equal(c.access, "tok")
  assert.equal("refresh" in c, false)
  assert.equal("expires" in c, false)
  assert.equal(c.uid, "u1")
  assert.equal(c.accountId, "a@b.c")
  assert.equal(c.email, "a@b.c")
  assert.equal(c.deviceId, "dev-explicit")
})

test("credentialsFrom: an empty or still-encrypted credential is refused", () => {
  assert.match(caught(() => credentialsFrom("", "", "", {})).message, /凭据缺失或格式无效/)
  assert.match(caught(() => credentialsFrom("enc:abc", "", "", {})).message, /未完成解密/)
})

test("userDataDir: the override, then %APPDATA%, then the default profile folder", () => {
  assert.equal(userDataDir({ AUTOCLAW_USER_DATA_DIR: "X:/custom" }), "X:/custom")
  assert.equal(userDataDir({ APPDATA: "C:/Users/x/AppData/Roaming" }), join("C:/Users/x/AppData/Roaming", "AutoClaw"))
})

test("readDesktopCredentials: no client folder means no sign-in, said plainly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-intl-none-"))
  try {
    // neither the client's auth.json nor a gateway config: the user is told to sign in to the client, or another way
    await assert.rejects(
      readDesktopCredentials(dir, { HOME: dir, USERPROFILE: dir }),
      /没有找到 AutoClaw 国际版官方客户端的登录态/,
    )
    // a client folder whose auth.json has no tokens is the client's own message
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ deviceId: "d" }))
    await assert.rejects(readDesktopCredentials(dir, {}), /auth\.json 中没有 token/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readDesktopCredentials: a gateway config that is there but holds no token", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoclaw-intl-gwempty-"))
  try {
    mkdirSync(join(home, ".openclaw-autoclaw"))
    writeFileSync(join(home, ".openclaw-autoclaw", "openclaw.json"), JSON.stringify({ models: { providers: {} } }))
    await assert.rejects(readDesktopCredentials(join(home, "missing-client"), { HOME: home, USERPROFILE: home }), /没有找到 AutoClaw 国际版官方客户端的登录态/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("readDesktopCredentials: a plain auth.json is read as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-intl-plain-"))
  try {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ token: `Bearer ${JWT}`, refreshToken: REFRESH, deviceId: "devfile", userInfo: { email: "me@example.com" } }),
    )
    const c = await readDesktopCredentials(dir, {})
    assert.equal(c.access, JWT)
    assert.equal(c.refresh, REFRESH)
    assert.equal(c.uid, "424242")
    assert.equal(c.email, "me@example.com")
    assert.equal(c.accountId, "me@example.com")
    assert.equal(c.deviceId, "devfile")
    assert.equal(c.expires, 4_070_902_400_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readDesktopCredentials: an encrypted auth.json is decrypted through the real DPAPI", { skip: !WINDOWS ? "DPAPI is Windows only" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-intl-enc-"))
  try {
    const key = randomBytes(32)
    // Chromium keeps the key as base64("DPAPI" + ProtectedData blob) for the current user.
    const script =
      'Add-Type -AssemblyName System.Security; ' +
      '$k = [Convert]::FromBase64String($env:AC_TEST_KEY); ' +
      "$p = [Security.Cryptography.ProtectedData]::Protect($k, $null, 'CurrentUser'); " +
      '[Console]::Out.Write([Convert]::ToBase64String([byte[]]([Text.Encoding]::ASCII.GetBytes("DPAPI") + $p)))'
    const encryptedKey = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AC_TEST_KEY: key.toString("base64") },
      encoding: "utf8",
    }).trim()
    writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }))
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ token: enc(`Bearer ${JWT}`, key), refreshToken: enc(REFRESH, key), userInfo: { email: "me@example.com" } }),
    )
    const c = await readDesktopCredentials(dir, {})
    assert.equal(c.access, JWT)
    assert.equal(c.refresh, REFRESH)
    assert.equal(c.uid, "424242")
    assert.equal(c.email, "me@example.com")
    assert.equal(c.deviceId, "devfile")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readDesktopCredentials: an encrypted token whose key can't be read is an error, not a wrong sign-in", { skip: !WINDOWS ? "DPAPI is Windows only" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-intl-badkey-"))
  try {
    const key = randomBytes(32)
    writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "bm90IGEgZHBhcGkgYmxvYg==" } }))
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: enc(`Bearer ${JWT}`, key), refreshToken: enc(REFRESH, key) }))
    await assert.rejects(readDesktopCredentials(dir, {}), /加密存储且解密失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readDesktopCredentials: falls back to the gateway config, which has no refresh token", async () => {
  const home = mkdtempSync(join(tmpdir(), "autoclaw-intl-gw-"))
  try {
    mkdirSync(join(home, ".openclaw-autoclaw"))
    writeFileSync(
      join(home, ".openclaw-autoclaw", "openclaw.json"),
      JSON.stringify({ models: { providers: { autoclaw: { models: [{ headers: { "x-authorization": `Bearer ${JWT}` } }] } } } }),
    )
    const c = await readDesktopCredentials(join(home, "missing-client"), { HOME: home, USERPROFILE: home })
    assert.equal(c.access, JWT)
    assert.equal("refresh" in c, false)
    assert.equal(c.uid, "424242")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
