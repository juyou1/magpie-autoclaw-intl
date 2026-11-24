// The model catalog (models.rs). The live list is at
// /autoclaw-proxy/proxy/autoclaw-model-config: a top-level "models" array
// with no code/data envelope. It isn't an account's permissions, only what
// upstream offers, so a model the account may not use is still refused by the
// vendor at request time.
//
// magpie keeps the list it had when the models hook throws, returns
// provider.models unchanged after a failed fetch, or returns a list marked
// Symbol.for("magpie.fellBack"). The static table below is what magpie starts
// from and what stands when the live list can't be read.

import { get } from "./api.mjs"
import { businessCode } from "./errors.mjs"
import { MODELS_PATH, number, stripRoute, text } from "./util.mjs"

const TTL_MS = 300_000
/** 目录条目数上限。 */
const MAX_ENTRIES = 2048
/** 国际目录证据里的静态窗口。 */
export const DEFAULT_ROUTE = "zai_auto"

/** 登录前与目录读不到时的模型清单（magpie 里显示的 id → 模型行）。 */
export function defaultModels() {
  return {
    "glm-5.3": {
      name: "GLM-5.3",
      id: "zaicoding_glm-5.3",
      limit: { context: 1_000_000, output: 131_072 },
      reasoning: true,
      tool_call: true,
    },
    "glm-5.3-flash": {
      name: "GLM-5.3-Flash",
      id: "zai_glm-5.3-flash",
      limit: { context: 1_000_000, output: 32_000 },
      reasoning: true,
      tool_call: true,
    },
  }
}

/** 一条目录条目 → magpie 模型行；认不出的返回 null（调用方据此整份放弃）。 */
export function catalogEntry(raw) {
  const route = (typeof raw === "string" ? raw : text(raw ?? {}, ["id"]) || "").trim()
  if (!route || route.length > 512 || /[^\x20-\x7e]/.test(route) || !stripRoute(route)) return null
  const id = stripRoute(route)
  const name = typeof raw === "object" && raw ? text(raw, ["name"]) : ""
  if (name && (name.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(name))) return null
  const row = {
    id,
    name: name || id.toUpperCase(),
    // 键 = magpie 里显示的 id；上游要的是带厂商前缀的路由。
    api: { id: route },
    tool_call: true,
  }
  if (typeof raw === "object" && raw) {
    const image = Array.isArray(raw.input) && raw.input.includes("image")
    row.reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : true
    row.modalities = { input: image ? ["text", "image"] : ["text"], output: ["text"] }
    const context = number(raw.contextWindow)
    const output = number(raw.maxTokens)
    row.limit = {
      context: context !== undefined && context > 0 ? context : 0,
      output: output !== undefined && output > 0 ? output : 0,
    }
  }
  return row
}

/**
 * 在线目录 → 模型行（键为 magpie 里的 id）。读不到或不像官方目录时返回 null。
 * 同一 id 出现多次时保留第一条。
 */
export async function catalogModels(accessToken, { signal, fetchImpl } = {}) {
  let payload
  try {
    payload = await get(MODELS_PATH, accessToken, "模型目录查询", { signal, fetchImpl })
  } catch (error) {
    if (error?.kind === "token_expired") throw Object.assign(new Error("AutoClaw 登录态已失效，请重新登录"), { signIn: "expired" })
    return null
  }
  const list = payload?.models
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ENTRIES) return null
  if (businessCode(payload) !== undefined && businessCode(payload) !== 0) return null
  const rows = {}
  for (const raw of list) {
    const row = catalogEntry(raw)
    // 官方客户端遇到一条认不出就整份放弃，这里同样不收半份目录。
    if (!row) return null
    if (!rows[row.id]) rows[row.id] = row
  }
  return Object.keys(rows).length > 0 ? rows : null
}

/** 5 分钟内不重复拉取的目录缓存（按 access token 的摘要键）。 */
const cache = new Map()

export function resetCatalog() {
  cache.clear()
}

/** 带缓存的在线目录；返回 { models, source: "remote" | "none" }。 */
export async function liveCatalog(accessToken, { force = false, now = Date.now(), ...options } = {}) {
  const clock = typeof now === "function" ? now : () => now
  const key = accessToken ? String(accessToken).slice(-64) : ""
  const held = cache.get(key)
  if (!force && held && !held.promise && clock() - held.at < TTL_MS) return held.value
  if (held?.promise) return held.promise
  const gate = { at: 0, value: null, promise: null }
  gate.promise = catalogModels(accessToken, options).then(
    (models) => {
      gate.promise = null
      gate.at = clock()
      gate.value = { models, source: models ? "remote" : "none" }
      // 失败不缓存：下一次立刻重试。
      if (gate.value.source === "remote" && cache.size < 64) cache.set(key, gate)
      else if (cache.get(key) === gate) cache.delete(key)
      return gate.value
    },
    (error) => {
      if (cache.get(key) === gate) cache.delete(key)
      // 登录态被拒要交给 magpie（标记账号需要重新登录）；其它读不到只是没有在线目录。
      if (error?.signIn === "expired") throw error
      return { models: null, source: "none" }
    },
  )
  cache.set(key, gate)
  return gate.promise
}
