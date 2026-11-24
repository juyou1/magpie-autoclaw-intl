// The sign-in kept by the official AutoClaw desktop client (credentials.rs,
// crypto.rs). Read-only: this never writes the client's files.
//
//   %APPDATA%/AutoClaw/auth.json   token / refreshToken (and userInfo.email)
//   %APPDATA%/AutoClaw/Local State  os_crypt.encrypted_key
//
// The two tokens are Electron safeStorage values: "enc:<base64>", where the
// base64 is "v10" + a 12-byte nonce + AES-256-GCM ciphertext with its 16-byte
// tag at the end. The key is in Local State as base64("DPAPI" + blob) and is
// unwrapped with DPAPI for the current Windows user, which is what PowerShell's
// [ProtectedData]::Unprotect does. A value without the "enc:" prefix is plain
// and is returned as it is. Both the client builds use the same folder, so
// which region it belongs to is the user's choice, never guessed.

import { execFile } from "node:child_process"
import { createDecipheriv } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { claims, jwtExpiry, MAX_TOKEN, stripBearer, tokenValid } from "./util.mjs"

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 256 * 1024
const AES_KEY_LEN = 32
const NONCE_LEN = 12
const TAG_LEN = 16

/** 用户数据目录：显式覆盖 → %APPDATA%/AutoClaw → ~/AppData/Roaming/AutoClaw。 */
export function userDataDir(env = process.env) {
  if (env.AUTOCLAW_USER_DATA_DIR) return env.AUTOCLAW_USER_DATA_DIR
  if (env.APPDATA) return join(env.APPDATA, "AutoClaw")
  return join(homedir(), "AppData", "Roaming", "AutoClaw")
}

function readJson(path, label) {
  let raw
  try {
    raw = readFileSync(path)
  } catch {
    return null
  }
  if (raw.byteLength > MAX_FILE_BYTES) throw new Error(`${label} 超过大小上限`)
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error(`${label} 不是有效 JSON`)
  }
}

/** 桌面端登录态是否存在（只看文件在不在，不解密）。 */
export function desktopAuthFile(dir = userDataDir()) {
  return join(dir, "auth.json")
}

function isBase64Like(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

let aesKeyCache = null

/** 取 Local State 里的 os_crypt AES 密钥（DPAPI 解密，按文件路径缓存）。 */
export async function osCryptAesKey(localStatePath) {
  if (aesKeyCache?.path === localStatePath) return aesKeyCache.key
  const localState = readJson(localStatePath, "Local State")
  if (!localState) throw new Error(`无法读取 Local State（${localStatePath}）`)
  const encoded = String(localState?.os_crypt?.encrypted_key ?? "").trim()
  if (!encoded) throw new Error("Local State 里没有 os_crypt.encrypted_key")
  if (!isBase64Like(encoded)) throw new Error("Local State 的 os_crypt.encrypted_key 不是合法 base64")
  const blob = Buffer.from(encoded, "base64")
  if (blob.length <= 5) throw new Error("os_crypt 密钥 blob 长度异常（不足以去掉 DPAPI 前缀）")
  if (blob.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("os_crypt 密钥前缀不是 DPAPI（这不是 Windows 平台的 Local State）")
  }
  const key = await dpapiUnprotect(blob.subarray(5))
  if (key.length !== AES_KEY_LEN) throw new Error(`os_crypt 密钥长度异常（期望 ${AES_KEY_LEN} 字节，实际 ${key.length} 字节）`)
  aesKeyCache = { path: localStatePath, key }
  return key
}

async function dpapiUnprotect(blob) {
  if (process.platform !== "win32") throw new Error("DPAPI 解密仅支持 Windows 平台")
  // blob 以 base64 放进环境变量交给 PowerShell（不经过命令行参数，免受引号与编码影响）。
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$b = [Convert]::FromBase64String($env:AC_DPAPI_BLOB_B64); " +
    "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); " +
    "[Console]::Out.Write([Convert]::ToBase64String($p))"
  const run = (file) =>
    execFileAsync(file, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AC_DPAPI_BLOB_B64: blob.toString("base64") },
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
  try {
    return Buffer.from(String((await run("pwsh.exe")).stdout).trim(), "base64")
  } catch (pwshError) {
    // 没装 pwsh（或它启动不了）时退回系统自带的 powershell.exe。
    try {
      return Buffer.from(String((await run("powershell.exe")).stdout).trim(), "base64")
    } catch (error) {
      throw new Error(
        `DPAPI 解密 os_crypt 密钥失败: ${error?.message ?? error}（Local State 属于另一个 Windows 用户时不通用）`,
      )
    }
  }
}

/** 解密一个 "enc:" 字段；不是 "enc:" 开头的值原样返回。 */
export function decryptEncValue(value, aesKey) {
  const raw = String(value ?? "")
  if (!raw.startsWith("enc:")) return raw
  if (!aesKey) throw new Error("没有可用的 os_crypt 密钥，无法解密 enc: 字段")
  const blob = Buffer.from(raw.slice(4).trim(), "base64")
  if (blob.length < 3) throw new Error("加密字段长度异常（不足版本前缀）")
  const version = blob.subarray(0, 3).toString("latin1").replace(/[^\x20-\x7e]/g, "?")
  if (blob.subarray(0, 3).toString("latin1") !== "v10") throw new Error(`不支持的 os_crypt 密文版本: ${version}`)
  const payload = blob.subarray(3)
  if (payload.length <= NONCE_LEN + TAG_LEN) throw new Error("os_crypt 密文长度异常")
  // 布局：nonce(12) + ciphertext + tag(16)。认证标签在尾部，要单独交给 setAuthTag。
  const nonce = payload.subarray(0, NONCE_LEN)
  const ciphertext = payload.subarray(NONCE_LEN, payload.length - TAG_LEN)
  const tag = payload.subarray(payload.length - TAG_LEN)
  let plaintext
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error("AES-GCM 解密失败（密钥或数据不匹配）")
  }
  // 非法 UTF-8 报错而不是替换字符：替换字符会让调用方拿着一段看似正常的垃圾 token 去请求上游。
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext)
  } catch {
    throw new Error("解密结果不是合法 UTF-8 文本")
  }
}

/**
 * 读取本机国际版登录态，返回 magpie 凭据字段（access / refresh / expires / …）。
 * 只在 auth.json 缺失时回落网关配置 ~/.openclaw-autoclaw/openclaw.json（只有 access token，不可续期）。
 * 两者都没有时抛 auth.json 的错误。
 */
export async function readDesktopCredentials(dir = userDataDir(), env = process.env) {
  const auth = readJson(desktopAuthFile(dir), "AutoClaw auth.json")
  if (!auth) {
    // 只在 auth.json 缺失时回落网关配置；两个来源都没有时，报的是官方客户端没装/没登录。
    let fallback = null
    try {
      fallback = fromGatewayConfig(env)
    } catch {
      // 网关配置也没有：下面给出统一的说明。
    }
    if (fallback) return fallback
    throw new Error("没有找到 AutoClaw 国际版官方客户端的登录态：请先在官方客户端里登录，或改用其它登录方式")
  }
  const rawToken = typeof auth.token === "string" ? auth.token : ""
  const rawRefresh = typeof auth.refreshToken === "string" ? auth.refreshToken : ""
  const deviceId = String(auth.deviceId ?? "").trim()
  if (!rawToken && !rawRefresh) throw new Error("AutoClaw auth.json 中没有 token")
  let aesKey
  try {
    aesKey = await osCryptAesKey(join(dir, "Local State"))
  } catch (error) {
    // token 是明文时密钥取不到不算失败。
    if (rawToken.startsWith("enc:")) throw new Error(`AutoClaw token 是加密存储且解密失败: ${error.message}`)
  }
  const access = stripBearer(decryptEncValue(rawToken, aesKey))
  const refresh = stripBearer(decryptEncValue(rawRefresh, aesKey))
  if (!access) throw new Error("AutoClaw auth.json token 解密结果为空")
  return credentialsFrom(access, refresh, deviceId, { email: String(auth.userInfo?.email ?? "").trim() })
}

function fromGatewayConfig(env) {
  const home = env.HOME || env.USERPROFILE || homedir()
  const path = join(home, ".openclaw-autoclaw", "openclaw.json")
  const config = readJson(path, "AutoClaw 网关配置 openclaw.json")
  const providers = config?.models?.providers
  if (providers && typeof providers === "object") {
    for (const provider of Object.values(providers)) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        for (const name of ["X-Authorization", "x-authorization"]) {
          const token = stripBearer(model?.headers?.[name])
          if (token) return credentialsFrom(token, "", "", {})
        }
      }
    }
  }
  throw new Error("openclaw.json 中没有可用的 X-Authorization token")
}

/** 由令牌组装凭据：身份与设备优先取显式值，回落 JWT 的声明；有效期取 JWT 的 exp。 */
export function credentialsFrom(access, refresh, deviceId, extra = {}) {
  // auth.json 解出来的明文自带 "Bearer " 前缀；存量脏值还可能是双前缀。
  const bareAccess = stripBearer(access)
  const bareRefresh = stripBearer(refresh)
  if (!tokenValid(bareAccess, false)) throw new Error("AutoClaw 凭据缺失或格式无效")
  if (!tokenValid(bareRefresh, true)) throw new Error("AutoClaw 凭据缺失或格式无效")
  if (bareAccess.startsWith("enc:") || bareRefresh.startsWith("enc:")) {
    throw new Error("AutoClaw 凭据仍是加密形态，未完成解密")
  }
  const payload = claims(bareAccess)
  const userId = String(extra.userId ?? payload?.user_id ?? "").trim() || undefined
  const device = (deviceId || String(payload?.device_id ?? "").trim()) || undefined
  const expires = extra.expires ?? jwtExpiry(bareAccess)
  return {
    access: bareAccess,
    ...(bareRefresh ? { refresh: bareRefresh } : {}),
    ...(expires ? { expires } : {}),
    ...(userId ? { uid: userId, accountId: extra.email || userId } : {}),
    ...(extra.email ? { email: extra.email } : {}),
    ...(device ? { deviceId: device } : {}),
  }
}
