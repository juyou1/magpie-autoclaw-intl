// The daily check-in (checkin.rs) and the login-activity campaign reward
// (promotion.rs).
//
// daily_signin is completed through task-complete; an HTTP 200 or an
// "already completed" is never reported as a new reward. A per-account
// ledger keeps a request that is still in flight, or whose result is
// unknown, from being sent again at once: after a crash the task list is
// read first instead of posting again.
//
// The campaign reward has no claim endpoint of its own: it is paid when the
// user-info "login activity" call arrives under the desktop fingerprint.
// What was paid is read back from the ledger by Beijing grant_date; a failed
// read is not "nothing paid", and never triggers the activity again.

import { activate, get, post } from "./api.mjs"
import { checkBusiness, UpstreamError } from "./errors.mjs"
import { LEDGER_PATH, TASK_COMPLETE_PATH, TASK_LIST_PATH, beijingDay, hash, integer, text } from "./util.mjs"

const IN_FLIGHT_MS = 120_000
const RETRY_AFTER_MS = 600_000
const REWARD_EVENTS = ["autoclaw_user_active", "autoclaw_user_signup_day", "autoclaw_weekly_perks"]
const REWARD_ACTIVITIES = [
  "autoclaw_user_active_reward",
  "autoclaw_user_active_bonus",
  "autoclaw_new_user_day_1_to_7_bonus",
  "autoclaw_weekly_perks",
]

/** 每个账号一份的签到台账。键是 accountKey，由插件按账号给出。 */
const ledgers = new Map()

function ledgerFor(key) {
  return ledgers.get(key) ?? {}
}

function saveLedger(key, ledger) {
  // 只留有意义的条目，账号很多时不无限增长。
  if (ledgers.size >= 200 && !ledgers.has(key)) ledgers.delete(ledgers.keys().next().value)
  ledgers.set(key, ledger)
}

export function resetLedgers() {
  ledgers.clear()
}

/** daily_signin 在任务列表里的状态：true 已完成，false 未完成，undefined 列表里没有或没说。 */
export async function taskDone(token, options = {}) {
  const payload = await get(TASK_LIST_PATH, token, "任务列表查询", options)
  checkBusiness(payload, "查询任务列表")
  const tasks = Array.isArray(payload.data) ? payload.data : []
  const task = tasks.find((item) => item?.task_id === "daily_signin")
  if (!task) return undefined
  if (typeof task.completed === "boolean") return task.completed
  if (task.status === "completed") return true
  if (task.status === "pending") return false
  return undefined
}

/**
 * 每日签到一次。返回 { success, alreadyCompleted, rewardPoints, msg }，
 * 结果未知时带 pending: true。
 */
export async function dailySignin(token, options = {}) {
  const payload = await post(TASK_COMPLETE_PATH, token, { task_id: "daily_signin" }, "签到", options)
  checkBusiness(payload, "签到")
  const data = payload.data
  if (!data || typeof data !== "object") {
    throw new UpstreamError("AutoClaw 签到未返回有效任务结果", { status: 502 })
  }
  const points = integer(data.reward_points)
  const alreadyCompleted = data.already_completed === true
  if (alreadyCompleted) return { success: false, alreadyCompleted: true, rewardPoints: points, msg: "今天已签到" }
  if ((points !== undefined && points > 0) || data.success === true) {
    return {
      success: true,
      alreadyCompleted: false,
      rewardPoints: points,
      msg: points !== undefined && points > 0 ? `签到成功，获得 ${points} 积分` : "签到成功",
    }
  }
  // 接口没说成没成：只读任务列表核对，不重复提交。
  const completed = await taskDone(token, options).catch((error) => {
    if (error?.kind === "token_expired") throw error
    return undefined
  })
  return {
    success: false,
    alreadyCompleted: completed === true,
    pending: completed === undefined,
    rewardPoints: points,
    msg:
      completed === true ? "任务列表显示今天已签到" : completed === false ? "签到未领取，稍后重试" : "签到结果尚未确认，稍后只读核对任务状态",
  }
}

export function isReward(entry) {
  const metadata = entry?.metadata
  const event = text(metadata, ["event_type"])
  if (REWARD_EVENTS.some((prefix) => event.startsWith(prefix)) || event.includes("weekly_perks")) return true
  const activity = text(metadata, ["activity_id"])
  return REWARD_ACTIVITIES.some((prefix) => activity.startsWith(prefix)) || activity.includes("weekly_perks")
}

function entrySummary(entry) {
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}
  return {
    points: integer(entry.amount),
    grantDate: text(metadata, ["grant_date"]),
    description: text(entry, ["description"]),
    activityId: text(metadata, ["activity_id"]),
    eventType: text(metadata, ["event_type"]),
  }
}

/** 今天（北京日界）到账的活动奖励。窗口没覆盖到更早的记录时标 incomplete。 */
export function promotionOf(entries, today = beijingDay()) {
  const list = Array.isArray(entries) ? entries : []
  const matched = list.filter(isReward)
  const latest = matched[0] ? entrySummary(matched[0]) : null
  const found = matched.filter((entry) => entry.metadata?.grant_date === today)
  // 首页就拿满了，而最老一条仍不早于今天：更早的今天入账可能在下一页。
  const oldest = list.at(-1)?.metadata?.grant_date
  const incomplete = found.length === 0 && list.length >= 50 && (typeof oldest !== "string" || oldest >= today)
  if (found.length === 0) return { granted: false, grantDate: today, incomplete, latest }
  let total = 0
  let known = !incomplete && list.length < 50
  for (const entry of found) {
    const amount = integer(entry.amount)
    if (amount === undefined) known = false
    else total += amount
  }
  return {
    granted: true,
    points: known ? total : null,
    grantDate: today,
    description: found[0] ? text(found[0], ["description"]) : "",
    entries: found.map(entrySummary),
    incomplete: false,
    latest,
  }
}

/** 今日活动奖励；窗口不完整时抛错（读不到不等于没发）。 */
export async function promotionToday(token, options = {}) {
  const payload = await get(LEDGER_PATH, token, "活动奖励查询", options)
  checkBusiness(payload, "查询活动奖励")
  if (!Array.isArray(payload.data?.entries)) {
    throw new UpstreamError("AutoClaw 活动流水没有有效 entries 数组", { status: 502 })
  }
  const report = promotionOf(payload.data.entries)
  if (!report.granted && report.incomplete) {
    throw new UpstreamError("AutoClaw 当日活动收入窗口未完整，暂不能确认是否已到账", { status: 502 })
  }
  return report
}

/** 账号键：有 userId 用它，否则用 access token 的摘要；同一账号的台账归一处。 */
export function accountKey(userId, accessToken) {
  const id = text({ userId }, ["userId"])
  return hash(JSON.stringify([id || hash(String(accessToken ?? ""))]))
}

/** magpie 的 checkin 结果。 */
function report(claim, extra = {}) {
  const outcome =
    claim.success === true ? "claimed" : claim.alreadyCompleted === true ? "done" : claim.pending === true ? "inactive" : "failed"
  const points = claim.success === true ? integer(claim.rewardPoints) : undefined
  return {
    outcome,
    message: text(claim, ["msg"]) || undefined,
    ...(points !== undefined && points > 0 ? { credit: points } : {}),
    ...extra,
  }
}

/**
 * claim：一次签到流程。返回 magpie checkin 钩子的结果。
 * 活动奖励只读流水确认；没到账且距上次尝试超过 10 分钟才触发一次 user-info。
 */
export async function claim({ token, userId, deviceId, key, now = Date.now(), options = {} }) {
  const ledgerKey = key ?? accountKey(userId, token)
  const today = beijingDay(now)
  let ledger = ledgerFor(ledgerKey)
  if (ledger.day !== today || ledger.identity !== ledgerKey) ledger = { day: today, identity: ledgerKey }
  if (ledger.inFlightUntil > now) {
    return report({ success: false, pending: true, msg: "上一轮签到结果尚未确认，稍后会核对任务状态" })
  }
  if (ledger.retryAt > now) {
    return report({ success: false, pending: true, msg: "本轮签到尚在冷却，稍后继续核对" })
  }
  let claimResult
  if (ledger.completed === true) {
    claimResult = { success: false, alreadyCompleted: true, msg: "今天已签到" }
  } else {
    // 崩溃留下在途标记后，先用只读任务状态核对，不直接重复 POST。
    let confirmed = false
    if (ledger.inFlightUntil > 0) {
      confirmed = await taskDone(token, options)
      if (confirmed === undefined) {
        saveLedger(ledgerKey, { ...ledger, retryAt: now + RETRY_AFTER_MS, updatedAt: now })
        return report({ success: false, pending: true, msg: "上一轮签到结果未知，任务列表也未给出结论，请稍后核对" })
      }
    }
    if (confirmed === true) {
      claimResult = { success: false, alreadyCompleted: true, msg: "任务列表确认今天已签到" }
    } else {
      ledger.inFlightUntil = now + IN_FLIGHT_MS
      saveLedger(ledgerKey, ledger)
      claimResult = await dailySignin(token, options)
    }
  }
  ledger.completed = claimResult.success === true || claimResult.alreadyCompleted === true
  // 已提交但读数未知的动作保留在途标记，冷却后只能先读任务状态。
  if (ledger.completed === true || claimResult.pending !== true) ledger.inFlightUntil = 0
  ledger.retryAt = ledger.completed === true ? 0 : now + RETRY_AFTER_MS
  ledger.updatedAt = now
  saveLedger(ledgerKey, ledger)

  // 活动奖励：以流水为准。
  let reward
  try {
    reward = await promotionToday(token, options)
  } catch (error) {
    if (error?.kind === "token_expired") throw error
    reward = null
  }
  if (reward && reward.granted === false && now - (ledger.promotionAttemptAt ?? 0) >= RETRY_AFTER_MS) {
    ledger.promotionAttemptAt = now
    saveLedger(ledgerKey, ledger)
    try {
      await activate(token, deviceId, options)
      reward = await promotionToday(token, options).catch((error) => (error?.kind === "token_expired" ? Promise.reject(error) : null))
    } catch (error) {
      if (error?.kind === "token_expired") throw error
      claimResult.promotionError = error?.message ?? String(error)
    }
  }
  return attachReward(report(claimResult), reward)
}

/** 把活动奖励的读数附到签到结果上（只追加，不覆盖签到的真实结果）。 */
export function attachReward(result, reward) {
  if (!reward) return result
  const extra = { ...result }
  if (reward.granted === true && typeof reward.points === "number" && reward.points > 0) {
    extra.message = extra.message ? `${extra.message}（活动福利 +${reward.points} 已到账）` : `活动福利 +${reward.points} 已到账`
  }
  return extra
}
