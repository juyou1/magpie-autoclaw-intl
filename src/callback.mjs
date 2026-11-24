// Reading what the user pastes back after signing in on the vendor's page
// (Agent2Providers web_login.rs submit_callback / finish).
//
// The vendor sends the browser to http://localhost:<registered port>/auth/callback-<vendor>?code=…&state=….
// That is the user's own computer, not the one the plugin runs on (a container,
// a server), so the page doesn't load. The user copies the whole address and
// pastes it into magpie's Callback URL field. Three shapes are taken:
//
//   the whole callback URL      http://localhost:18432/auth/callback-zai?code=…&state=…
//   the bare query string       code=…&state=…          (with or without a leading ?)
//   the bare authorization code  4/0A…                   (no "code=" in it)
//
// The vendor in the pasted path must be this sign-in's. The state is the one
// the vendor put in the authorization URL: it goes back with the code, and a
// pasted callback whose state is another one is refused.

const CALLBACK_PATH_PREFIX = "/auth/callback-"

/** percent-decode a query component (+ reads as a space). */
export function percentDecode(input) {
  const raw = String(input ?? "")
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "%") {
      const hex = raw.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    out += ch === "+" ? " " : ch
  }
  try {
    // 单个字节可能是多字节 UTF-8 字符的一部分：按字节序列还原。
    const bytes = Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff)
    return new TextDecoder().decode(bytes)
  } catch {
    return out
  }
}

/** 查询串 → 键值对（百分号解码）。同一键出现多次时取第一个。 */
export function parseQuery(query) {
  const out = {}
  for (const pair of String(query ?? "").split("&")) {
    if (!pair) continue
    const at = pair.indexOf("=")
    const key = percentDecode(at < 0 ? pair : pair.slice(0, at))
    const value = at < 0 ? "" : percentDecode(pair.slice(at + 1))
    if (!(key in out)) out[key] = value
  }
  return out
}

/**
 * 解析用户粘回的内容。成功返回 { vendor: string|null, params }；
 * 认不出授权材料（既没有 code 也没有 error）时返回 null。
 */
export function parsePastedCallback(text, { callbackPathPrefix = CALLBACK_PATH_PREFIX } = {}) {
  const raw = String(text ?? "").trim()
  if (!raw) return null
  let vendor = null
  let query
  // 浏览器有时会给路径补一个尾部斜杠；厂商名只到斜杠为止。
  const vendorOf = (path) => (path ? path.replace(/\/+$/, "") : path)
  if (raw.startsWith(callbackPathPrefix)) {
    // 完整路径形态：/auth/callback-<vendor>?code=…
    const rest = raw.slice(callbackPathPrefix.length)
    const at = rest.indexOf("?")
    vendor = vendorOf(at < 0 ? rest : rest.slice(0, at))
    query = at < 0 ? "" : rest.slice(at + 1)
  } else if (/^https?:\/\//i.test(raw)) {
    // 完整 URL：从路径里认厂商，只取查询串。
    let url
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    const at = url.pathname.indexOf(callbackPathPrefix)
    if (at >= 0) {
      const rest = url.pathname.slice(at + callbackPathPrefix.length)
      const slash = rest.indexOf("/")
      vendor = slash < 0 ? rest : rest.slice(0, slash)
    }
    query = url.search.replace(/^\?/, "")
  } else if (raw.includes("code=")) {
    // 裸查询串
    query = raw.replace(/^\?/, "")
  } else {
    // 裸授权码
    query = `code=${raw}`
  }
  const params = parseQuery(query)
  const code = String(params.code ?? "").trim()
  const error = String(params.error ?? "").trim()
  if (!code && !error) return null
  if (!vendor) vendor = null
  return { vendor, params, code, error }
}
