// What the usage hook reports for an account (usage.rs): the credit balance
// by wallet, the subscription, and what expires soon.
//
// Credits are a balance, not a quota: the vendor gives what is left and no
// total, so nothing here is turned into a percentage. A balance is what
// routing weighs an account by, so it goes in a window's `balance`; the other
// rows are shown (`display`) and marked `aside`, since using them up doesn't
// stop the account. The points are the main result: a failed subscription or
// profile read is shown beside them, never instead of them.

import { creditRows, queryPoints, querySubscription } from "./points.mjs"
import { hash, number, text } from "./util.mjs"

const POINTS = "积分"

/** fmt：整数的三位分组。 */
export const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** 账号的用量台账键：有 uid 用它，否则用 refresh / access token 的摘要。 */
export function usageKey(auth) {
  const uid = String(auth?.uid ?? auth?.accountId ?? "").trim()
  if (uid) return `uid:${uid}`
  return `tok:${hash(String(auth?.refresh ?? auth?.access ?? ""))}`
}

function date(value) {
  if (value === null || value === undefined || value === "") return undefined
  // epoch 秒或毫秒
  const n = number(value)
  if (n !== undefined) {
    const ms = n > 1e12 ? n : n * 1000
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** 到期时间既可能是时间戳，也可能是「N 天后」这类文字。 */
function expiringWindow(expiring, nowMs) {
  const points = number(expiring?.points)
  if (points === undefined || points <= 0) return null
  const display = [`${fmt(points)} ${POINTS} 即将过期`, text(expiring, ["text"])].filter(Boolean).join(" · ")
  return { name: "即将过期", display, aside: true }
}

/** 订阅：计划名、状态、到期。 */
function subscriptionRows(subscription) {
  if (!subscription) return []
  const plan = [subscription.planName, subscription.status].filter(Boolean).join(" · ")
  const rows = []
  if (plan) rows.push({ name: "订阅", display: plan, aside: true })
  const remain = number(subscription.remainQuota)
  const total = number(subscription.totalQuota)
  if (remain !== undefined && total !== undefined && total > 0) {
    rows.push({ name: "订阅额度", display: `${fmt(remain)} / ${fmt(total)}`, used: Math.min(100, Math.round(((total - remain) / total) * 1000) / 10), aside: true })
  }
  return rows
}

/**
 * 组装 magpie usage 钩子的结果。points 是主结果；订阅读不到时附在 error 里。
 */
export function usageReport({ points, subscription, subscriptionError, plan }) {
  const total = number(points?.totalBalance)
  const windows = []
  const credits = creditRows(points)
  if (total !== undefined) {
    // 余额是一等读数：路由按它认识账号。
    const parts = (points?.wallets ?? [])
      .filter((wallet) => wallet.displayName && number(wallet.balance) !== undefined)
      .map((wallet) => `${wallet.displayName} ${fmt(number(wallet.balance))}`)
    windows.push({ name: POINTS, balance: total, unit: POINTS, display: [`${fmt(total)} ${POINTS}`, ...parts].join(" · ") })
  }
  const expiring = expiringWindow(points?.expiring)
  if (expiring) windows.push(expiring)
  const until = date(subscription?.expireAt)
  const planName = subscription?.planName || plan
  return {
    ...(planName ? { plan: planName } : {}),
    ...(until ? { until } : {}),
    ...(total !== undefined ? { balance: `${fmt(total)} ${POINTS}` } : {}),
    // 积分是纯余额，没有已用量；任何窗口都不带 used，路由不把它当百分比读。
    windows: [...windows, ...subscriptionRows(subscription)],
    // 订阅读不到只附在 error 里，不取代积分。
    ...(subscriptionError ? { error: `订阅查询失败：${subscriptionError}` } : {}),
    credits,
  }
}

/**
 * 查一个账号的用量。积分查不到才是失败；订阅与到期是附加信息。
 */
export async function queryUsage(token, { deviceId, now = Date.now(), options = {} } = {}) {
  const points = await queryPoints(token, options)
  let subscription = null
  let subscriptionError = ""
  try {
    subscription = await querySubscription(token, deviceId, options)
  } catch (error) {
    if (error?.kind === "token_expired") throw error
    subscriptionError = error?.message ?? String(error)
  }
  return usageReport({ points, subscription, subscriptionError })
}
