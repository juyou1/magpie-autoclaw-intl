// The web sign-in, as it works from a container (Agent2Providers web_login.rs
// and callback_server.rs).
//
// The vendor's authorization page sends the browser to
// http://localhost:<registered port>/auth/callback-<vendor>?code=…&state=….
// That localhost is the computer the browser runs on. On a desktop install it
// is also where the plugin runs, and the redirect lands here and completes the
// sign-in. In a container or on a server it is the user's own computer: the
// page doesn't load, and the user copies the whole address from the address
// bar and pastes it into magpie. Both end in the same exchange, and nothing
// depends on the redirect arriving.
//
// Two listeners, two levels of trust:
//
//   the registered callback port   127.0.0.1 only, one of the four the vendor
//                                  registered for its client. A redirect can
//                                  carry no secret of ours, so what it checks
//                                  is the state the vendor put in this sign-in's
//                                  authorization URL: a redirect from another
//                                  sign-in, or made up by a page, has another.
//
//   the login page port            AUTOCLAW_LOGIN_PORT (18433) on
//                                  AUTOCLAW_LOGIN_HOST (127.0.0.1). It serves
//                                  the page that runs the vendor's captcha and
//                                  asks for the authorization URL. The page's
//                                  address carries a random token for this one
//                                  sign-in and every request must bring it, so
//                                  the port can be opened to the network for a
//                                  browser on another computer.
//
// The captcha runs in the user's own browser: the vendor insists on its Aliyun
// receipt before it hands out an authorization URL, and the receipt comes from
// the vendor's browser-side SDK. The plugin passes it on unchanged and never
// keeps it longer than that.

import { randomBytes } from "node:crypto"
import * as http from "node:http"

import { parsePastedCallback } from "./callback.mjs"
import { captchaConfig, exchangeCode, requestOauthUrl, VENDORS, vendorLabel } from "./oauth.mjs"
import { completeFromProfile, newDeviceId, successFrom } from "./signin.mjs"
import { CALLBACK_PORTS, printable } from "./util.mjs"
import { callbackPageHtml, closedPageHtml, loginPageHtml } from "./weblogin-page.mjs"

const DEFAULT_LOGIN_PORT = 18433
/** 没有下一步时，一次登录保留多久。 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000
/** 回调收到后，留给换码的时间。 */
const FINISH_TIMEOUT_MS = 2 * 60 * 1000
/** 回执是不透明串；再大就当异常请求断开。 */
const MAX_BODY_BYTES = 256 * 1024

/** 进行中的登录；同一时间只有一个。 */
let current = null

/** 供测试：结束所有进行中的登录。 */
export function resetWebLogins() {
  const held = current
  current = null
  held?.close()
}

/**
 * 登录页面的监听与访问地址。
 *   AUTOCLAW_LOGIN_PORT        监听端口（默认 18433）
 *   AUTOCLAW_LOGIN_HOST        监听地址；容器里设 0.0.0.0，端口才能映射出去
 *   AUTOCLAW_LOGIN_PUBLIC_URL  用户浏览器访问页面用的地址（容器的域名或 IP:端口）
 * 写错的值按没设处理，不让一次笔误挡住登录。
 */
export function parseLoginAddress(env = process.env) {
  const port = Number(env.AUTOCLAW_LOGIN_PORT)
  let publicUrl = ""
  if (env.AUTOCLAW_LOGIN_PUBLIC_URL) {
    try {
      const url = new URL(env.AUTOCLAW_LOGIN_PUBLIC_URL)
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.search && !url.hash) publicUrl = url.href.replace(/\/+$/, "")
    } catch {
      // 不是合法地址
    }
  }
  return {
    host: env.AUTOCLAW_LOGIN_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LOGIN_PORT,
    publicUrl,
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = http.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })
}

/** Z.ai 的回调白名单只认这四个端口：取第一个能监听的。 */
async function firstFreePort(ports) {
  for (const port of ports) {
    if (await isFree(port)) return port
  }
  return 0
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve())
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

function send(res, status, type, body) {
  if (res.headersSent) return
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" })
  res.end(body)
}

const sendJson = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value))

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ""
    let cut = false
    req.on("data", (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        cut = true
        req.destroy()
      }
    })
    req.on("end", () => {
      if (cut) return resolve(null)
      try {
        const value = JSON.parse(raw || "{}")
        resolve(value && typeof value === "object" ? value : {})
      } catch {
        resolve({})
      }
    })
    req.on("error", () => resolve({}))
  })
}

/** 浏览器同源请求一定带 Origin；没带的（curl、重定向）不靠它判断。 */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** 授权页地址里的 state：换码要原样回传，回调也靠它认本轮授权。 */
function stateOf(authorizeUrl) {
  let state = ""
  try {
    state = new URL(authorizeUrl).searchParams.get("state") ?? ""
  } catch {
    // 非法地址按缺 state 处理
  }
  return state && printable(state, 4096) ? state : ""
}

/** 一次网页登录。 */
class WebLogin {
  constructor(vendor, options) {
    this.vendor = vendor
    this.options = options
    this.deviceId = newDeviceId()
    /** 页面地址里的令牌：知道它才能驱动这次登录的接口。 */
    this.token = randomBytes(32).toString("hex")
    this.captchaReceipt = ""
    /** null = 还不知道上游要不要验证码。 */
    this.captchaEnabled = null
    this.authorizationUrl = ""
    this.expectedState = ""
    /** 收到的回调材料：{ code, error }。 */
    this.callback = null
    this.error = ""
    this.waiters = new Set()
    this.closed = false
    this.pageServer = null
    this.callbackServer = null
    this.callbackPort = 0
    this.pageBase = ""
    this.timer = null
  }

  /** 取两个端口；拿不到就什么都不留。 */
  async start() {
    const { callbackPorts = CALLBACK_PORTS, loginHost = "127.0.0.1", loginPort = DEFAULT_LOGIN_PORT } = this.options
    this.callbackPort = await firstFreePort(callbackPorts)
    if (!this.callbackPort) {
      throw Object.assign(
        new Error(`AutoClaw 登录所需的回调端口（${callbackPorts.join(" / ")}）都被占用（通常是 AutoClaw 桌面客户端在运行）。请先退出它，或换一种登录方式`),
        { status: 400 },
      )
    }
    this.callbackServer = http.createServer((req, res) => this.serveCallback(req, res))
    try {
      await listen(this.callbackServer, this.callbackPort, "127.0.0.1")
      this.pageServer = http.createServer((req, res) => this.servePage(req, res))
      await listen(this.pageServer, loginPort, loginHost)
    } catch (error) {
      await this.release()
      const what = error?.code === "EADDRINUSE" ? "已被占用" : error?.code === "EADDRNOTAVAIL" ? "地址不存在" : error?.code ?? error?.message
      const which = this.pageServer?.listening ? `回调端口 ${this.callbackPort}` : `登录页面端口 ${loginPort}`
      throw Object.assign(new Error(`${which} 无法监听（${what}）。请检查容器的端口映射和 AUTOCLAW_LOGIN_PORT / AUTOCLAW_LOGIN_HOST`), { status: 400 })
    }
    this.pageBase = (this.options.loginPublicUrl || `http://127.0.0.1:${loginPort}`).replace(/\/+$/, "")
    current = this
    this.arm(IDLE_TIMEOUT_MS)
    return this
  }

  async release() {
    const page = this.pageServer
    const callback = this.callbackServer
    this.pageServer = null
    this.callbackServer = null
    await Promise.all([closeServer(page), closeServer(callback)])
  }

  /** 结束这次登录。已经拿到回调材料时，理由不覆盖它。 */
  close(reason = "登录已结束") {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    if (!this.callback) this.error ||= reason
    if (current === this) current = null
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    void this.release()
  }

  arm(ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.close("登录超时，请重新发起"), ms)
    this.timer.unref?.()
  }

  cancel(reason = "登录已取消") {
    this.close(reason)
  }

  /** 回调落点，也是交给上游的 navigate_uri。 */
  get redirectUri() {
    return `http://localhost:${this.callbackPort}/auth/callback-${this.vendor}`
  }

  /** 授权页给出后告诉用户：浏览器会被送到哪里、打不开时怎么做。 */
  callbackHint() {
    return {
      redirectUri: this.redirectUri,
      message: `授权完成后浏览器会跳到 ${this.redirectUri}。如果那个页面打不开，请复制地址栏里的完整地址，粘贴到 magpie 的回调地址（Callback URL）里。`,
    }
  }

  /**
   * 记下一份回调材料。
   * 来自登记端口的 302 必须带着本轮授权地址里的 state：那是任何网页都能发起的请求。
   * 用户亲手粘贴的内容可以没有 state（只剩授权码时就是如此，官方客户端同样按空串处理）；
   * 带了就校验。
   */
  take(pasted, { pasted: byUser = false } = {}) {
    if (this.closed) return { ok: false, message: "这次登录已经结束，请回到 magpie 重新发起。" }
    if (!this.authorizationUrl) return { ok: false, message: "还没有取得授权页，请先在登录页面完成安全验证。", notReady: true }
    const state = String(pasted.params.state ?? "")
    if (state !== this.expectedState && !(byUser && state === "")) {
      return { ok: false, message: "回调校验失败（state 不匹配）：这次回调不属于本轮登录。请回 magpie 重新登录。", wrongState: true }
    }
    if (this.callback) return { ok: false, message: "这次登录已经收到过回调。" }
    if (pasted.error) {
      const description = String(pasted.params.error_description ?? "").trim()
      this.callback = { code: "", error: description ? `${pasted.error}：${description}` : pasted.error }
    } else {
      this.callback = { code: pasted.code, error: "" }
    }
    this.arm(FINISH_TIMEOUT_MS)
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    return { ok: true }
  }

  /** 厂商登记的回调端口：只接 302，也只认这一条路径。 */
  async serveCallback(req, res) {
    const url = new URL(req.url, "http://localhost")
    if (url.pathname !== `/auth/callback-${this.vendor}`) return send(res, 404, "text/html; charset=utf-8", closedPageHtml("Not Found"))
    const pasted = parsePastedCallback(`${url.pathname}${url.search}`)
    // favicon、预连接、标签页预览没有授权材料：不是回调，监听器继续等。
    if (!pasted) return send(res, 404, "text/html; charset=utf-8", closedPageHtml("Not Found"))
    if (this.closed) return send(res, 410, "text/html; charset=utf-8", closedPageHtml("这一轮登录已经结束，请回到 magpie 重新发起。"))
    const taken = this.take(pasted)
    if (!taken.ok) return send(res, 200, "text/html; charset=utf-8", callbackPageHtml(false, taken.message))
    return send(res, 200, "text/html; charset=utf-8", callbackPageHtml(true))
  }

  /** 登录页面端口：页面本身，和页面用的接口。 */
  async servePage(req, res) {
    const url = new URL(req.url, "http://login")
    // 页面：地址里带着令牌。
    if (url.pathname === `/${this.token}`) {
      if (this.closed) return send(res, 410, "text/html; charset=utf-8", closedPageHtml("这次登录已经结束，请回到 magpie 重新发起。"))
      return send(
        res,
        200,
        "text/html; charset=utf-8",
        loginPageHtml({ vendor: this.vendor, token: this.token, captchaJs: this.options.captchaJs }),
      )
    }
    // 容器里反向代理常常只转发一个端口：回调路径也在这里接，校验和登记端口上一样。
    if (url.pathname === `/auth/callback-${this.vendor}`) return this.serveCallback(req, res)

    // 接口：没有正确的令牌，只说不认识这个登录。
    const token = req.headers["x-login-token"]
    if (typeof token !== "string" || token !== this.token) return sendJson(res, 403, { error: "不是这次登录的页面" })
    if (req.method === "OPTIONS") return send(res, 204, "text/plain", "")
    // 跨站请求即使带着令牌也不行：Origin 既不是本机，也不是页面对外的地址。
    const origin = req.headers.origin
    const own = this.options.loginPublicUrl ? new URL(this.options.loginPublicUrl).origin : ""
    if (origin && !LOCAL_ORIGIN.test(origin) && origin !== own) return sendJson(res, 403, { error: "forbidden origin" })

    if (url.pathname === "/captcha-config" && req.method === "GET") {
      try {
        const config = await captchaConfig(this.options)
        this.captchaEnabled = config.enabled === true
        return sendJson(res, 200, config)
      } catch (error) {
        this.captchaEnabled = null
        return sendJson(res, 502, { enabled: false, error: error?.message ?? String(error) })
      }
    }
    if (url.pathname === "/captcha" && req.method === "POST") {
      const body = await readJson(req)
      const receipt = typeof body?.receipt === "string" ? body.receipt : typeof body?.captchaVerifyParam === "string" ? body.captchaVerifyParam : ""
      this.captchaReceipt = receipt.trim()
      return sendJson(res, 200, { ok: !!this.captchaReceipt })
    }
    if (url.pathname === "/open-auth" && req.method === "POST") {
      if (this.closed) return sendJson(res, 200, { error: "这次登录已经结束，请回到 magpie 重新发起。" })
      try {
        const authorizeUrl = await requestOauthUrl(
          this.vendor,
          { port: this.callbackPort, deviceId: this.deviceId, captcha: this.captchaReceipt, captchaRequired: this.captchaEnabled !== false },
          this.options,
        )
        const state = stateOf(authorizeUrl)
        if (!state) throw Object.assign(new Error("上游授权页地址缺少 state 参数，已取消登录（回调校验必需）"), { status: 502 })
        this.authorizationUrl = authorizeUrl
        this.expectedState = state
        this.arm(IDLE_TIMEOUT_MS)
        return sendJson(res, 200, { url: authorizeUrl, callback: this.callbackHint() })
      } catch (error) {
        return sendJson(res, 200, { error: error?.message ?? String(error) })
      }
    }
    if (url.pathname === "/status" && req.method === "GET") {
      return sendJson(res, 200, { received: !!this.callback, closed: this.closed, error: this.error })
    }
    return sendJson(res, 404, { error: "not found" })
  }
  /** 用户在 magpie 里粘贴的内容。粘贴错了不结束登录：用户可以重新粘贴。 */
  takePasted(text) {
    if (this.closed) throw Object.assign(new Error(this.error || "这次登录已取消或已过期，请重新发起"), { status: 400 })
    // 302 已经把材料送来（桌面场景）时，用户随后提交空串是「不知道要粘贴」：
    // 直接放行，走已收到的材料完成登录。
    if (this.callback) return
    const pasted = parsePastedCallback(text)
    if (!pasted) {
      throw Object.assign(new Error("回调地址里没有 AutoClaw 授权码：请复制授权后浏览器地址栏里的完整地址"), { status: 400 })
    }
    if (pasted.vendor && pasted.vendor !== this.vendor) {
      throw Object.assign(new Error(`回调属于 ${vendorLabel(pasted.vendor)}，与本次 ${vendorLabel(this.vendor)} 登录不一致，请重新发起`), { status: 400 })
    }
    const taken = this.take(pasted, { pasted: true })
    if (!taken.ok) throw Object.assign(new Error(taken.message), { status: 400 })
  }

  /** 等到回调材料到了，或这次登录结束。 */
  async wait() {
    if (this.callback || this.closed) return
    await new Promise((resolve) => {
      const wake = () => {
        this.waiters.delete(wake)
        resolve()
      }
      this.waiters.add(wake)
    })
  }

  /** 用一次性授权码换登录态。 */
  async finish() {
    if (this.callback.error) {
      throw Object.assign(new Error(`已取消或拒绝 AutoClaw 国际版官方授权：${this.callback.error}`), { status: 400 })
    }
    const tokens = await exchangeCode(
      this.vendor,
      { port: this.callbackPort, deviceId: this.deviceId, code: this.callback.code, state: this.expectedState },
      this.options,
    )
    const result = successFrom({ ...tokens, deviceId: this.deviceId, now: this.options.now })
    return completeFromProfile(result, this.deviceId, this.options)
  }

  /** magpie 的登录方式描述。 */
  describe() {
    const vendor = vendorLabel(this.vendor)
    return {
      url: `${this.pageBase}/${this.token}`,
      instructions: [
        `1. 打开登录页面（已自动打开；没有的话手动访问 ${this.pageBase}/${this.token}），完成安全验证。`,
        `2. 页面会带你到 ${vendor} 的授权页，在那里登录并授权。`,
        `3. 授权后浏览器会跳到 ${this.redirectUri}。这个页面打不开是正常的：请复制地址栏里的完整地址，粘贴到这里的回调地址（Callback URL）里。`,
      ].join("\n"),
      method: "code",
    }
  }
}

/**
 * 发起网页登录。返回 magpie 的登录方式描述：
 * { url, instructions, method: "code", callback, cancel }。
 */
export async function startWebLogin(vendor, options = {}) {
  if (!VENDORS.includes(vendor)) {
    throw Object.assign(new Error(`AutoClaw 国际版只支持 ${VENDORS.map(vendorLabel).join(" 或 ")} 授权`), { status: 400 })
  }
  const login = new WebLogin(vendor, options)
  // 一次只留一个登录。回调端口是借来的：上一轮不放，这一轮的回调可能落到它的监听器上，
  // 而授权码一次性，两轮并存等于让其中一轮必输。
  current?.close("已开始新的登录，这一次被取代")
  await login.start()
  return {
    ...login.describe(),
    /** 厂商会把浏览器送到的地址（端口是它登记的四个之一）。 */
    redirectUri: login.redirectUri,
    cancel: (reason) => login.cancel(reason),
    /** magpie 调用：用户粘贴的内容。用户还没提交时 magpie 不会调用，调用即提交过。 */
    async callback(pasted, { signal } = {}) {
      const onAbort = () => login.close("登录已取消")
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        if (signal?.aborted) onAbort()
        // magpie 传了参数就是用户提交过：空串或空白同样是提交，立即告诉用户没粘到授权码，
        // 登录保留让他重新提交。粘贴校验不过同样只报错不收场。
        if (pasted !== undefined) login.takePasted(String(pasted))
        await login.wait()
        if (!login.callback) throw Object.assign(new Error(login.error || "这次登录已结束，请重新发起"), { status: 400 })
        // 到这里材料齐了：换码无论成败，这次登录都到此为止。
        return await login.finish()
      } finally {
        signal?.removeEventListener("abort", onAbort)
        // 材料已收（换码完或换码失败）或登录已被结束（取消、超时、被取代）才收场；
        // 只是粘贴报错时登录还开着，不关。
        if (login.callback || login.closed) login.close()
      }
    },
  }
}

/** 登录方式：Z.ai / Google 网页登录。 */
export const webLoginMethod = {
  type: "oauth",
  label: "AutoClaw 国际版网页登录（Z.ai / Google）",
  async authorize(inputs, { signal, ...deps } = {}) {
    const vendor = String(inputs?.vendor ?? "zai")
    // 选了不认识的方式就照实说，不悄悄换成另一种。
    if (!VENDORS.includes(vendor)) {
      throw Object.assign(new Error(`AutoClaw 国际版只支持 ${VENDORS.map(vendorLabel).join(" 或 ")} 授权`), { status: 400 })
    }
    const address = parseLoginAddress()
    const flow = await startWebLogin(vendor, {
      fetchImpl: deps.fetchImpl,
      loginHost: deps.loginHost ?? address.host,
      loginPort: deps.loginPort ?? address.port,
      loginPublicUrl: deps.loginPublicUrl ?? address.publicUrl,
      callbackPorts: deps.callbackPorts,
      captchaJs: deps.captchaJs,
      now: deps.now,
    })
    signal?.addEventListener("abort", () => flow.cancel(), { once: true })
    // 只给 magpie 它认得的三个字段；cancel 留在 startWebLogin 的返回里给测试和内部用。
    return { url: flow.url, instructions: flow.instructions, method: "code", callback: flow.callback }
  },
  prompts: [
    {
      type: "select",
      key: "vendor",
      message: "登录方式",
      options: [
        { label: "Z.ai 账号", value: "zai", hint: "智谱 z.ai 账号体系" },
        { label: "Google 账号", value: "google" },
      ],
    },
  ],
}
