// Credit points (wallets.rs) and the subscription (subscription.rs).
// The v2 wallets answer is preferred; only a clear business failure or a
// missing wallets list falls back to v1. A number the vendor doesn't give
// stays unknown and is never counted as zero.

import { get, post } from "./api.mjs"
import { businessCode, checkBusiness, UpstreamError } from "./errors.mjs"
import { EXPIRING_PATH, SUBSCRIBE_PATH, WALLETS_V1_PATH, WALLETS_V2_PATH, integer, number, scalar, text } from "./util.mjs"

/** 业务码：登录态被拒。 */
const AUTH_CODES = new Set([401, 410_000, 400_000])

function truthy(value) {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value !== ""
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function walletsV2(list) {
  const rows = []
  for (const wallet of Array.isArray(list) ? list : []) {
    if (!truthy(wallet?.display)) continue
    const name = text(wallet, ["display_name", "public_wallet_type"])
    const balance = number(wallet.balance)
    const display = text(wallet, ["balance_view"])
    rows.push({
      priority: integer(wallet.priority) ?? Number.MAX_SAFE_INTEGER,
      value: {
        type: text(wallet, ["public_wallet_type"]),
        displayName: name || "积分",
        balance,
        balanceView: display || (balance !== undefined ? String(balance) : ""),
      },
    })
  }
  return rows.sort((a, b) => a.priority - b.priority).map((row) => row.value)
}

const V1_WALLET_NAMES = { daily: "赠送积分", monthly: "订阅积分", long_term: "通用积分", annual: "通用积分", campaign: "活动积分" }

export function walletsV1(list) {
  // 同一 scope 的多个实例相加；任一余额未知则整项未知，不按零合计。
  const scopes = new Map()
  for (const wallet of Array.isArray(list) ? list : []) {
    if (text(wallet, ["status"]).toLowerCase() !== "active" || !truthy(wallet.display)) continue
    const scope = text(wallet, ["wallet_scope"]).toLowerCase().replace("wallet_scope_", "") || "other"
    const balance = number(wallet.balance)
    const known = scopes.get(scope)
    scopes.set(scope, known === undefined ? balance : known !== undefined && balance !== undefined ? known + balance : undefined)
  }
  return [...scopes].map(([kind, balance]) => ({
    type: kind,
    displayName: V1_WALLET_NAMES[kind] ?? "其他积分",
    balance,
    balanceView: balance !== undefined ? String(balance) : "",
  }))
}

/** 到期查询的归一结果；读不到有效数据为 null。 */
export function expiringPoints(payload) {
  if (businessCode(payload) !== 0 || !payload?.data || typeof payload.data !== "object") return null
  return {
    points: number(payload.data.expiring_points),
    text: text(payload.data, ["expiring_points_text"]),
    expireTimeValue: payload.data.expire_time_value ?? null,
    expireTimeType: payload.data.expire_time_type ?? null,
  }
}

/** queryPoints：{ totalBalance, wallets, expiring }。主结果不受附加的到期查询失败影响。 */
export async function queryPoints(token, options = {}) {
  const primary = await get(WALLETS_V2_PATH, token, "积分查询", options)
  if (AUTH_CODES.has(businessCode(primary))) checkBusiness(primary, "查询积分")
  let total
  let wallets
  if (businessCode(primary) === 0 && Array.isArray(primary.data?.wallets)) {
    total = number(primary.data.total_balance)
    wallets = walletsV2(primary.data.wallets)
  } else {
    const legacy = await get(WALLETS_V1_PATH, token, "旧版积分查询", options)
    checkBusiness(legacy, "查询积分")
    if (!legacy.data || typeof legacy.data !== "object" || !Array.isArray(legacy.data.wallet_instances)) {
      throw new UpstreamError("AutoClaw 旧版积分钱包缺少有效数据", { status: 502 })
    }
    total = number(legacy.data.total_balance)
    wallets = walletsV1(legacy.data.wallet_instances)
  }
  let expiring = null
  try {
    expiring = expiringPoints(await get(EXPIRING_PATH, token, "积分到期查询", options))
  } catch (error) {
    // 到期查询只是附加信息：登录态被拒才向上抛，其余留空。
    if (error?.kind === "token_expired") throw error
  }
  return { totalBalance: total, wallets, expiring }
}

/** credits：钱包与「即将过期」的逐项读数，供用量卡片展示。 */
export function creditRows(points) {
  const rows = []
  for (const wallet of Array.isArray(points?.wallets) ? points.wallets : []) {
    const name = text(wallet, ["displayName", "type"]) || "积分"
    const row = { name }
    const balance = number(wallet.balance)
    if (balance !== undefined) row.remain = balance
    rows.push(row)
  }
  const expiring = number(points?.expiring?.points)
  if (expiring !== undefined && expiring > 0) {
    const row = { name: "即将过期", remain: expiring }
    const note = text(points.expiring, ["text"])
    if (note) row.grantReason = note
    rows.push(row)
  }
  return rows
}

/** 有限深搜：先看常见嵌套键，再按广度优先扫对象，最多 200 个节点。 */
function find(data, keys) {
  const pending = [data]
  for (const key of ["subscribeInfo", "subscribe", "data", "memberInfo", "vipInfo"]) {
    const nested = data[key]
    if (nested && typeof nested === "object" && !Array.isArray(nested)) pending.push(nested)
  }
  let visited = 0
  while (pending.length) {
    const value = pending.shift()
    visited += 1
    if (visited > 200) return undefined
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && child !== null && child !== undefined && child !== "") return child
      if (child && typeof child === "object" && !Array.isArray(child)) pending.push(child)
    }
  }
  return undefined
}

const EXPIRE_KEYS = ["expireAt", "expireTime", "expiredAt", "endTime", "validEndTime"]

export function normalizeSubscription(data) {
  const pick = (keys) => {
    const found = find(data, keys)
    return found === undefined ? "" : scalar(found)
  }
  const pickNumber = (keys) => number(find(data, keys))
  return {
    planName: pick(["productName", "planName", "memberName", "subscribeName", "vipName"]),
    status: pick(["status", "subscribeStatus", "memberStatus"]),
    expireAt: find(data, EXPIRE_KEYS) ?? null,
    remainQuota: pickNumber(["remainQuota", "remainingQuota", "remainCredits", "availableCredits", "leftQuota"]),
    totalQuota: pickNumber(["totalQuota", "credits", "totalCredits"]),
  }
}

/** 订阅查询：国际版明确使用 Stripe 的 oversea-subscribe-info，不尝试国内 subscribe-info。 */
export async function querySubscription(token, deviceId, options = {}) {
  const payload = await post(
    SUBSCRIBE_PATH,
    token,
    { source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) },
    "查询订阅",
    options,
  )
  checkBusiness(payload, "查询订阅")
  const data = payload.data
  if (data === null || data === undefined) return null
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new UpstreamError("AutoClaw 国际版订阅响应形态无效", { status: 502 })
  }
  return normalizeSubscription(data)
}
