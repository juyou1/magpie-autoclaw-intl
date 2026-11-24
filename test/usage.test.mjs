import assert from "node:assert/strict"
import { test } from "node:test"

import { creditRows, expiringPoints, normalizeSubscription, queryPoints, querySubscription, walletsV1, walletsV2 } from "../src/points.mjs"
import { fmt, queryUsage, usageKey, usageReport } from "../src/usage.mjs"

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

/** A stand-in vendor for the points routes. */
function pointsVendor(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    for (const [suffix, reply] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return typeof reply === "function" ? reply() : json(reply)
    }
    throw new Error(`unexpected request ${url}`)
  }
  return { fetchImpl, calls }
}

test("walletsV2: shown wallets by priority, a name where the vendor gives none", () => {
  assert.deepEqual(
    walletsV2([
      { display: true, public_wallet_type: "monthly", display_name: "订阅积分", balance: 120, priority: 2 },
      { display: false, public_wallet_type: "hidden", balance: 999, priority: 0 },
      { display: 1, balance: "50", priority: 1 },
      { display: true, public_wallet_type: "daily", balance_view: "1,234" },
    ]),
    [
      // a wallet without display_name is named by its public type; only one with neither is just "积分"
      { type: "", displayName: "积分", balance: 50, balanceView: "50" },
      { type: "monthly", displayName: "订阅积分", balance: 120, balanceView: "120" },
      { type: "daily", displayName: "daily", balance: undefined, balanceView: "1,234" },
    ],
  )
})

test("walletsV1: only active wallets, instances of one scope added, an unknown balance stays unknown", () => {
  assert.deepEqual(
    walletsV1([
      { status: "Active", display: true, wallet_scope: "WALLET_SCOPE_DAILY", balance: 10 },
      { status: "active", display: true, wallet_scope: "wallet_scope_daily", balance: 5 },
      { status: "inactive", display: true, wallet_scope: "wallet_scope_daily", balance: 99 },
      { status: "active", display: false, wallet_scope: "wallet_scope_daily", balance: 99 },
      { status: "active", display: true, wallet_scope: "", balance: null },
      { status: "active", display: true, wallet_scope: "wallet_scope_long_term", balance: 3 },
      { status: "active", display: true, wallet_scope: "wallet_scope_campaign", balance: "7" },
    ]),
    [
      { type: "daily", displayName: "赠送积分", balance: 15, balanceView: "15" },
      { type: "other", displayName: "其他积分", balance: undefined, balanceView: "" },
      { type: "long_term", displayName: "通用积分", balance: 3, balanceView: "3" },
      { type: "campaign", displayName: "活动积分", balance: 7, balanceView: "7" },
    ],
  )
  assert.deepEqual(walletsV1(null), [])
})

test("expiringPoints and creditRows", () => {
  assert.deepEqual(expiringPoints({ code: 0, data: { expiring_points: "40", expiring_points_text: "月底过期", expire_time_type: "month" } }), {
    points: 40,
    text: "月底过期",
    expireTimeValue: null,
    expireTimeType: "month",
  })
  assert.equal(expiringPoints({ code: 500 }), null)
  assert.equal(expiringPoints({ code: 0, data: "text" }), null)
  assert.deepEqual(creditRows({ wallets: [{ displayName: "订阅积分", balance: 120 }], expiring: { points: 40, text: "月底过期" } }), [
    { name: "订阅积分", remain: 120 },
    { name: "即将过期", remain: 40, grantReason: "月底过期" },
  ])
  assert.deepEqual(creditRows({ wallets: [{ type: "daily" }], expiring: { points: 0 } }), [{ name: "daily" }])
  assert.deepEqual(creditRows(null), [])
})

test("normalizeSubscription: the common spellings, and a value nested deeper", () => {
  assert.deepEqual(normalizeSubscription({ subscribeInfo: { productName: "Pro", status: "active", expireTime: 1800000000, remainQuota: "80", totalQuota: 100 } }), {
    planName: "Pro",
    status: "active",
    expireAt: 1800000000,
    remainQuota: 80,
    totalQuota: 100,
  })
  assert.deepEqual(normalizeSubscription({}), { planName: "", status: "", expireAt: null, remainQuota: undefined, totalQuota: undefined })
  assert.equal(normalizeSubscription({ data: { memberInfo: { planName: "Team" } } }).planName, "Team")
})

test("queryPoints: the v2 wallets are used when they are there", async () => {
  const v = pointsVendor({
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 0, data: { total_balance: "1,200", wallets: [{ display: true, public_wallet_type: "monthly", balance: 1200, priority: 1 }] } },
    "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw": { code: 0, data: { expiring_points: 30 } },
  })
  const points = await queryPoints("tok", { fetchImpl: v.fetchImpl })
  assert.equal(points.totalBalance, undefined, "a balance written with a separator isn't a number: it stays unknown")
  assert.deepEqual(points.wallets, [{ type: "monthly", displayName: "monthly", balance: 1200, balanceView: "1200" }])
  assert.deepEqual(points.expiring, { points: 30, text: "", expireTimeValue: null, expireTimeType: null })
  assert.deepEqual(
    v.calls.map((call) => call.method),
    ["GET", "GET"],
  )
})

test("queryPoints: falls back to v1 when v2 has no wallets list", async () => {
  const v = pointsVendor({
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 0, data: {} },
    "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all": { code: 0, data: { total_balance: 45, wallet_instances: [{ status: "active", display: true, wallet_scope: "wallet_scope_daily", balance: 45 }] } },
    "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw": () => json({ message: "Server Error" }, 500),
  })
  const points = await queryPoints("tok", { fetchImpl: v.fetchImpl })
  assert.equal(points.totalBalance, 45)
  assert.equal(points.wallets[0].displayName, "赠送积分")
  assert.equal(points.expiring, null, "a failed expiry read leaves it out, it doesn't fail the balance")
  assert.equal(v.calls.length, 3)
})

test("queryPoints: the sign-in refused is a sign-in failure; a broken v1 answer is an error", async () => {
  const refused = pointsVendor({ "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 410000 } })
  await assert.rejects(queryPoints("tok", { fetchImpl: refused.fetchImpl }), (error) => error.signIn === "expired")

  const broken = pointsVendor({
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 500 },
    "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all": { code: 0, data: { total_balance: 45 } },
  })
  await assert.rejects(queryPoints("tok", { fetchImpl: broken.fetchImpl }), /旧版积分钱包缺少有效数据/)
})

test("querySubscription: sent with the device id, null data means no subscription", async () => {
  const v = pointsVendor({ "/agentpay/v1/assistant/oversea-subscribe-info": { code: 0, data: null } })
  assert.equal(await querySubscription("tok", "dev1", { fetchImpl: v.fetchImpl }), null)
  assert.deepEqual(v.calls[0].body, { source_id: "autoclaw", device_id: "dev1" })
  assert.equal(v.calls[0].method, "POST")

  const none = pointsVendor({ "/agentpay/v1/assistant/oversea-subscribe-info": { code: 0, data: [] } })
  await assert.rejects(querySubscription("tok", "", { fetchImpl: none.fetchImpl }), /订阅响应形态无效/)
})

test("usageKey: one account one ledger, with or without a uid", () => {
  assert.equal(usageKey({ uid: "42", access: "a" }), "uid:42")
  assert.equal(usageKey({ accountId: "ada@example.com" }), "uid:ada@example.com")
  assert.notEqual(usageKey({ refresh: "r1" }), usageKey({ refresh: "r2" }))
  assert.equal(usageKey({ access: "a" }), usageKey({ access: "a" }))
  assert.match(usageKey({}), /^tok:/)
})

test("usageReport: a balance is a balance, never a percentage", () => {
  const report = usageReport({
    points: {
      totalBalance: 1234,
      wallets: [
        { type: "monthly", displayName: "订阅积分", balance: 1000 },
        { type: "daily", displayName: "赠送积分", balance: 234 },
      ],
      expiring: { points: 40, text: "月底过期" },
    },
    subscription: { planName: "Pro", status: "active", expireAt: 1800000000, remainQuota: 80, totalQuota: 100 },
  })
  assert.equal(report.plan, "Pro")
  assert.equal(report.until, new Date(1800000000 * 1000).toISOString())
  assert.equal(report.balance, "1,234 积分")
  assert.equal(report.error, undefined)
  assert.deepEqual(report.credits, [
    { name: "订阅积分", remain: 1000 },
    { name: "赠送积分", remain: 234 },
    { name: "即将过期", remain: 40, grantReason: "月底过期" },
  ])
  const balance = report.windows.find((window) => window.name === "积分")
  assert.deepEqual(balance, { name: "积分", balance: 1234, unit: "积分", display: "1,234 积分 · 订阅积分 1,000 · 赠送积分 234" })
  assert.equal("used" in balance, false)
  assert.deepEqual(report.windows[1], { name: "即将过期", display: "40 积分 即将过期 · 月底过期", aside: true })
  assert.deepEqual(report.windows[2], { name: "订阅", display: "Pro · active", aside: true })
  assert.deepEqual(report.windows[3], { name: "订阅额度", display: "80 / 100", used: 20, aside: true })
})

test("usageReport: what isn't known is left out", () => {
  const bare = usageReport({ points: { totalBalance: undefined, wallets: [], expiring: null }, subscription: null })
  assert.deepEqual(bare, { windows: [], credits: [] })
  const failed = usageReport({ points: { totalBalance: 10 }, subscription: null, subscriptionError: "AutoClaw 查询订阅未完成（业务码 5）" })
  assert.equal(failed.balance, "10 积分")
  assert.match(failed.error, /订阅查询失败：.*业务码 5/)
  assert.equal(failed.windows.length, 1)
  // an epoch in milliseconds, and a date string, both read
  assert.equal(usageReport({ points: {}, subscription: { expireAt: 1700000000000 } }).until, new Date(1700000000000).toISOString())
  assert.equal(usageReport({ points: {}, subscription: { expireAt: "2026-12-01T00:00:00Z" } }).until, "2026-12-01T00:00:00.000Z")
  assert.equal(usageReport({ points: {}, subscription: { expireAt: "soon" } }).until, undefined)
})

test("fmt", () => {
  assert.equal(fmt(0), "0")
  assert.equal(fmt(1234), "1,234")
  assert.equal(fmt(1234567.6), "1,234,568")
})

test("queryUsage: the balance stands when the subscription can't be read; a refused sign-in doesn't", async () => {
  const v = pointsVendor({
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 0, data: { total_balance: 500, wallets: [] } },
    "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw": { code: 0, data: {} },
    "/agentpay/v1/assistant/oversea-subscribe-info": { code: 500007, msg: "no plan" },
  })
  const report = await queryUsage("tok", { deviceId: "dev1", options: { fetchImpl: v.fetchImpl } })
  assert.equal(report.balance, "500 积分")
  assert.match(report.error, /业务码 500007/)

  const refused = pointsVendor({
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw": { code: 0, data: { total_balance: 500, wallets: [] } },
    "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw": { code: 0, data: {} },
    "/agentpay/v1/assistant/oversea-subscribe-info": { code: 410000 },
  })
  await assert.rejects(queryUsage("tok", { options: { fetchImpl: refused.fetchImpl } }), (error) => error.signIn === "expired")
})
