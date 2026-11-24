// The sign-in methods magpie offers for this provider, in OpenCode's shape.
//
//   Zai / Google web sign-in   authorize() starts a loopback HTTP server on
//                              one of the official client's registered ports
//                              and opens a local guide page; the page runs the
//                              vendor's Aliyun captcha SDK, asks for the
//                              authorization URL, the browser signs in and is
//                              redirected back; callback() exchanges the code.
//   Access token / refresh     an api method with prompts; checked online.
//   Credentials JSON           an api method; checked online.
//   Desktop sign-in            reads the official client's auth.json; no browser.
//
// The loopback port can be reached by any local process, so a code is only
// taken with the state the vendor put in the URL this session handed out, and
// a flow lives for one callback. Tokens go to the account store, never to logs.

import * as http from "node:http"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

import { post } from "./api.mjs"
import { checkBusiness, UpstreamError } from "./errors.mjs"
import { decryptEncValue, osCryptAesKey, readDesktopCredentials, userDataDir } from "./desktop.mjs"
import { captchaConfig, exchangeCode, requestOauthUrl, VENDORS } from "./oauth.mjs"
import { ALIYUN_CAPTCHA_JS, CALLBACK_PORTS, claims, jwtExpiry, scalar, stripBearer, text, tokenValid } from "./util.mjs"

const OAUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000
const BROWSER_WAIT_MS = 5 * 60 * 1000
/** 到期时间比 JWT 的 exp 提前这么多，续期才不会贴着失效边缘。 */
const EXPIRY_SKEW_MS = 10 * 60 * 1000
const VENDOR_NAMES = { zai: "z.ai", google: "Google" }

/** 64 位十六进制 device_id（官方客户端形态）；两跳必须带同一个值。 */
export function newDeviceId() {
  return randomBytes(32).toString("hex")
}

/** 一份凭据的到期时间：优先 JWT 的 exp，其次 expires_in，都没有就不写。 */
export function expiryOf(access, expiresIn, now = Date.now()) {
  const jwt = jwtExpiry(access)
  if (jwt !== undefined) return jwt - EXPIRY_SKEW_MS
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + expiresIn * 1000 - EXPIRY_SKEW_MS
  return undefined
}

/**
 * 由登录响应组装 magpie 的 success 结果。
 * 身份以 JWT 里的 user_id 为准：三方 OAuth 的 data.user_id 可能是外部账号的 ID。
 */
export function successFrom({ accessToken, refreshToken, deviceId, userId, userName, email, expiresIn, now }) {
  const access = stripBearer(String(accessToken ?? ""))
  const refresh = stripBearer(String(refreshToken ?? ""))
  if (!tokenValid(access, false)) throw Object.assign(new Error("AutoClaw 登录响应里没有有效的 access_token"), { status: 502 })
  if (!tokenValid(refresh, true)) throw Object.assign(new Error("AutoClaw 登录响应里的 refresh_token 无效"), { status: 502 })
  const payload = claims(access) ?? {}
  // 公开字段（uid / accountId / email / name）都不能夹带凭据或控制字符：magpie 会把账号名显示在界面上。
  const clean = (value) => {
    const s = String(value ?? "").trim()
    if (!s || s.length > 1024 || /[\u0000-\u001f\u007f]/.test(s)) return ""
    return s === access || s === refresh ? "" : s
  }
  const uid = clean(scalar(payload.user_id) || scalar(userId)) || undefined
  const expires = expiryOf(access, expiresIn, now)
  const safeEmail = clean(email)
  const name = clean(userName)
  return {
    type: "success",
    access,
    ...(refresh ? { refresh } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(uid ? { uid } : {}),
    // magpie 按 accountId → metadata.email → email 给账号命名。
    ...(safeEmail || uid ? { accountId: safeEmail || uid } : {}),
    ...(safeEmail ? { email: safeEmail } : {}),
    ...(name ? { name } : {}),
    ...(deviceId || payload.device_id ? { deviceId: deviceId || scalar(payload.device_id) } : {}),
  }
}

/** 用户资料：登录后的显示名（昵称 / 邮箱）。读不到不视为登录失败。 */
export async function fetchProfile(accessToken, deviceId, options = {}) {
  const payload = await post(
    "/userapi/v1/user-profile",
    accessToken,
    { source_id: "autotyper", ...(deviceId ? { device_id: deviceId } : {}) },
    "用户资料查询",
    options,
  )
  checkBusiness(payload, "查询用户资料")
  if (!payload.data || typeof payload.data !== "object") {
    throw new UpstreamError("AutoClaw 国际版资料响应缺少有效内容", { status: 502 })
  }
  return { userId: scalar(payload.data.user_id), email: text(payload.data, ["email"]), name: text(payload.data, ["user_name"]) }
}

/**
 * 核对并补全一份手工凭据：用资料接口确认它还能用，补上邮箱。
 * JWT 里的 userId 不被外部资料接口的 ID 覆盖。
 */
export async function verifyCredentials(secret, options = {}) {
  const access = stripBearer(text(secret, ["token", "accessToken", "access_token"]))
  const refresh = stripBearer(text(secret, ["refreshToken", "refresh_token"]))
  if (access.startsWith("enc:") || refresh.startsWith("enc:")) {
    throw Object.assign(new Error("凭据仍是 enc: 加密形态，请粘贴解密后的 token，或使用「导入本机登录态」"), { status: 400 })
  }
  if (!tokenValid(access, false) || !tokenValid(refresh, true)) {
    throw Object.assign(new Error("AutoClaw 凭据缺失或格式无效"), { status: 400 })
  }
  // 凭据里写明的 userId 与令牌身份不一致时不添加这个账号。
  const tokenUser = scalar(claims(access)?.user_id)
  const given = scalar(secret.userId) || scalar(secret.user_id)
  if (given && tokenUser && given !== tokenUser) {
    throw Object.assign(new Error("AutoClaw 凭据中的用户标识与令牌身份不一致"), { status: 409 })
  }
  const deviceId = text(secret, ["deviceId", "device_id"]) || scalar(claims(access)?.device_id) || newDeviceId()
  let profile
  try {
    profile = await fetchProfile(access, deviceId, options)
  } catch (error) {
    // 资料接口把令牌拒了：这就是一份无效凭据。其它失败不挡登录。
    if (error?.kind === "token_expired") throw error
  }
  if (!given && !tokenUser && !profile?.userId) {
    throw Object.assign(new Error("AutoClaw 国际版凭据与用户资料均未给出账号身份，未添加空账号"), { status: 502 })
  }
  return successFrom({
    accessToken: access,
    refreshToken: refresh,
    deviceId,
    userId: tokenUser || given || profile?.userId,
    userName: text(secret, ["name", "userName", "user_name"]) || profile?.name,
    email: text(secret, ["email"]) || profile?.email,
    now: options.now,
  })
}

/** 解析凭据 JSON 文本；兼容整份 auth.json（其中可能带 userInfo）。 */
export function parseCredentialJson(raw) {
  let value
  try {
    value = JSON.parse(String(raw ?? "").trim())
  } catch {
    throw Object.assign(new Error("AutoClaw 凭据 JSON 格式无效"), { status: 400 })
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("AutoClaw 凭据必须是 JSON 对象"), { status: 400 })
  }
  const merged = { ...value, ...(value.userInfo && typeof value.userInfo === "object" ? { email: value.userInfo.email } : {}) }
  if (merged.provider && merged.provider !== "autoclaw-intl") {
    throw Object.assign(new Error("这份 AutoClaw 凭据不属于国际版"), { status: 400 })
  }
  return merged
}

/** 直接粘贴的 auth.json 原值是 enc: 密文：用本机客户端的密钥解开后才是可用凭据。 */
export async function resolveCredentialJson(raw) {
  const secret = parseCredentialJson(raw)
  if (!String(secret.token ?? "").startsWith("enc:") && !String(secret.refreshToken ?? "").startsWith("enc:")) return secret
  let aesKey
  try {
    aesKey = await osCryptAesKey(join(userDataDir(), "Local State"))
  } catch (error) {
    throw Object.assign(new Error(`凭据是 enc: 加密形态，且取不到本机密钥：${error.message}`), { status: 400 })
  }
  return {
    ...secret,
    token: decryptEncValue(String(secret.token ?? ""), aesKey),
    refreshToken: decryptEncValue(String(secret.refreshToken ?? ""), aesKey),
  }
}

/** 探测端口池里第一个能监听的端口（listen → 记下 → 关闭）。 */
async function probePort(ports) {
  for (const port of ports) {
    const free = await new Promise((resolve) => {
      const probe = http.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  return 0
}

const html = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

/** 回调落地页。 */
function callbackPage(ok, note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AutoClaw 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f6fa}
.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px 48px;text-align:center;max-width:460px}
h1{font-size:18px;margin:0 0 8px;color:${ok ? "#1a9c5b" : "#d43c3c"}}p{color:#666;font-size:14px;margin:0;line-height:1.6}</style></head>
<body><div class="c"><h1>${ok ? "✓ 授权成功" : "✗ 授权失败"}</h1>
<p>${html(note ?? (ok ? "正在返回 magpie 完成登录，本页可以关闭。" : "回调缺少 code，请回 magpie 重试。"))}</p></div></body></html>`
}

/**
 * 引导页：安全验证（如启用）→「继续授权」→ 跳转厂商授权页。
 * 验证码由厂商的阿里云 SDK 在浏览器里完成，回执 POST /captcha 交给本插件原样转交。
 */
export function guidePage(vendor, captchaJs) {
  const name = VENDOR_NAMES[vendor]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AutoClaw · ${html(name)} 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:#f5f6fa;display:flex;justify-content:center;padding:40px 16px;margin:0}
 .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:460px;width:100%;padding:32px;box-sizing:border-box}
 h1{font-size:20px;margin:0 0 8px}
 p.sub{color:#666;font-size:14px;margin:0 0 20px}
 .step{font-size:14px;color:#333;margin:10px 0;display:flex;gap:8px;align-items:flex-start}
 .step .n{background:#4f6ef7;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none}
 #captchaBox{margin:16px 0;padding:16px;border:1px dashed #ccc;border-radius:10px;display:none}
 #captchaEle{min-height:44px}
 button.primary{background:#4f6ef7;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-size:15px;cursor:pointer;width:100%;margin-top:16px}
 button.primary:disabled{background:#b9c0f4;cursor:not-allowed}
 .msg{font-size:13px;margin-top:10px;min-height:18px}
 .msg.ok{color:#1a9c5b}.msg.err{color:#d43c3c}.msg.warn{color:#c98a00}
 #done{display:none;text-align:center;padding:20px 0}
 .spin{display:inline-block;width:28px;height:28px;border:3px solid #e3e6f7;border-top-color:#4f6ef7;border-radius:50%;animation:r .8s linear infinite;margin-bottom:10px}
 @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
 <h1>AutoClaw · ${html(name)} 登录</h1>
 <p class="sub">本页面由 magpie 插件在本地生成，关闭本页即取消登录。</p>
 <div id="steps">
  <div class="step"><span class="n">1</span><span id="stepCaptcha">检查安全验证…</span></div>
  <div id="captchaBox"><div id="captchaEle"></div></div>
  <div class="step"><span class="n">2</span><span>跳转 ${html(name)} 授权页完成登录</span></div>
 </div>
 <button class="primary" id="goBtn" disabled>继续授权</button>
 <div class="msg" id="msg"></div>
 <div id="done"><div class="spin"></div><div>已完成授权，正在返回 magpie…</div></div>
</div>
<script>
const HIDDEN_TRIGGER_ID="__acHiddenTrigger";
(function ensureHiddenTrigger(){
  let b=document.getElementById(HIDDEN_TRIGGER_ID);
  if(!b){b=document.createElement("button");b.id=HIDDEN_TRIGGER_ID;b.type="button";b.tabIndex=-1;
    b.setAttribute("aria-hidden","true");b.style.cssText="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    document.body.appendChild(b);}
})();
function msg(m,cls){const e=document.getElementById("msg");e.textContent=m;e.className="msg "+(cls||"");}
async function boot(){
  let cfg={enabled:false};
  try{const r=await fetch("/captcha-config");cfg=await r.json();}catch(e){}
  if(cfg&&cfg.enabled){
    document.getElementById("stepCaptcha").textContent="请点击下方按钮完成安全验证";
    const box=document.getElementById("captchaBox");box.style.display="block";
    window.__acRegion=cfg.region||"";window.__acPrefix=cfg.prefix||"";
    window.AliyunCaptchaConfig=window.AliyunCaptchaConfig||{region:window.__acRegion,prefix:window.__acPrefix};
    msg("正在加载安全验证组件…","warn");
    await loadCaptchaLib();
    if(!window.initAliyunCaptcha){msg("验证组件加载失败（网络/广告拦截），请刷新重试","err");return;}
    // 官方流程：init → 预热 ≥2.1s → 程序化 click 隐藏按钮 → 组件弹出验证窗。点击太早组件未就绪会弹出空白框。
    window.initAliyunCaptcha({
      SceneId:cfg.sceneId,mode:"popup",element:"#captchaEle",button:"#"+HIDDEN_TRIGGER_ID,
      captchaVerifyCallback:(params)=>{
        const receipt=typeof params==="string"?params:(params&&typeof params.captchaVerifyParam==="string"?params.captchaVerifyParam:JSON.stringify(params||{}));
        fetch("/captcha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({receipt})})
          .then(()=>{window.__acReceiptSent=true;}).catch(()=>{window.__acReceiptSent=true;});
        return {captchaResult:true};
      },
      onBizResultCallback:()=>{},getInstance:()=>{},
      slideStyle:{width:320,height:40},language:"cn",
      onError:(err)=>{msg("安全验证出错: "+((err&&err.message)||"")+"，请点击重试","err");}
    });
    msg("验证组件已就绪，正在弹出验证窗…","warn");
    setTimeout(()=>{document.getElementById("__acHiddenTrigger").click();},2300);
    const t0=Date.now();
    await (function pollReceipt(){
      if(window.__acReceiptSent||Date.now()-t0>180000)return;
      return new Promise(r=>setTimeout(r,500)).then(pollReceipt);
    })();
    window.__acReceiptSent=false;
    msg("安全验证通过","ok");
  }else{
    document.getElementById("stepCaptcha").textContent="无需安全验证";
  }
  const btn=document.getElementById("goBtn");btn.disabled=false;btn.textContent="继续授权";
}
function loadCaptchaLib(){
  return new Promise((resolve)=>{
    if(window.initAliyunCaptcha){resolve();return;}
    const s=document.createElement("script");
    s.src=${JSON.stringify(captchaJs)};s.async=true;s.onload=()=>resolve();s.onerror=()=>resolve();
    document.head.appendChild(s);
    setTimeout(()=>resolve(),10000);
  });
}
let leavingForAuthorization=false;
document.getElementById("goBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("goBtn");btn.disabled=true;btn.textContent="正在获取授权页…";
  try{
    const r=await fetch("/open-auth",{method:"POST"});
    const j=await r.json();
    if(j.error){msg(j.error,"err");btn.disabled=false;btn.textContent="继续授权";return;}
    document.getElementById("steps").style.display="none";btn.style.display="none";
    document.getElementById("done").style.display="block";
    setTimeout(()=>{leavingForAuthorization=true;location.href=j.url;},600);
  }catch(e){msg("本地登录连接已断开或会话已结束，请回 magpie 重新发起登录：" + (e && e.message ? e.message : e),"err");btn.disabled=false;btn.textContent="继续授权";}
});
window.addEventListener("beforeunload",function(){
  if(leavingForAuthorization)return;
  try{navigator.sendBeacon("/abort",new Blob([JSON.stringify({reason:"页面关闭"})],{type:"application/json"}));}catch(_){}
});
boot().catch((e)=>msg("初始化失败："+((e&&e.message)||e),"err"));
</script></body></html>`
}

const ORIGIN_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/**
 * 启动本地 OAuth：立即返回 { url, instructions, method: "auto", callback }。
 * callback 等浏览器把 code 带回来，拿到后直连上游换 token。
 */
export async function startLocalOauth(vendor, { fetchImpl, ports = CALLBACK_PORTS, captchaJs = ALIYUN_CAPTCHA_JS, now = Date.now } = {}) {
  if (!VENDORS.includes(vendor)) throw Object.assign(new Error("AutoClaw 国际版只支持 Zai 或 Google 授权"), { status: 400 })
  const options = { fetchImpl }
  const deviceId = newDeviceId()
  // state.error 是失败原因；只记第一个（后来的取消不覆盖真正的原因），并唤醒在等的 callback。
  const state = { captchaReceipt: "", captchaEnabled: null, oauthCode: "", oauthState: "", expectedState: null, error: null }
  const fail = (reason) => {
    if (state.error === null) state.error = String(reason)
  }
  const waiters = []
  const notify = () => {
    while (waiters.length) waiters.shift()()
  }
  const waitFor = (timeoutMs, what) =>
    new Promise((resolve, reject) => {
      let timer
      const check = () => {
        if (state.error) {
          cleanup()
          reject(Object.assign(new Error(state.error), { status: 400 }))
          return true
        }
        if (state.oauthCode) {
          cleanup()
          resolve(state.oauthCode)
          return true
        }
        return false
      }
      const waiter = () => void check()
      const cleanup = () => {
        clearTimeout(timer)
        const at = waiters.indexOf(waiter)
        if (at >= 0) waiters.splice(at, 1)
      }
      // 不拖住进程：浏览器迟迟不回来时，由会话超时或宿主的取消来收尾。
      timer = setTimeout(() => {
        cleanup()
        reject(Object.assign(new Error(`${what} 等待超时（${Math.round(timeoutMs / 60000)} 分钟）— 请重试登录`), { status: 400 }))
      }, timeoutMs)
      timer.unref?.()
      waiters.push(waiter)
      check()
    })

  // 端口被占（如官方客户端在跑）时依次尝试其余。
  const port = await probePort(ports)
  if (!port) {
    throw Object.assign(
      new Error(`本地端口 ${ports.join("/")} 均被占用——OAuth 回调需要其中之一（官方 client 白名单端口）。请关闭占用进程（可能是 AutoClaw 桌面端）后重试。`),
      { status: 400 },
    )
  }

  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`
    let url
    try {
      url = new URL(req.url, base)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra })
      res.end(body)
    }
    // 写接口只接受本机来源：浏览器同源 fetch 一定带 Origin；防其它网页跨源 POST 干扰登录。
    const localOrigin = () => {
      const o = req.headers.origin
      return !o || ORIGIN_LOCAL.test(o)
    }
    if (["/captcha", "/open-auth", "/abort"].includes(url.pathname) && !localOrigin(req)) {
      send(403, "application/json", JSON.stringify({ error: "forbidden origin" }))
      return
    }
    if (req.method === "OPTIONS") {
      send(204, "text/plain", "", {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      })
      return
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(200, "text/html; charset=utf-8", guidePage(vendor, captchaJs))
      return
    }
    if (url.pathname === "/captcha-config") {
      captchaConfig(options)
        .then((cfg) => {
          state.captchaEnabled = cfg.enabled === true
          send(200, "application/json", JSON.stringify(cfg))
        })
        .catch(() => send(502, "application/json", JSON.stringify({ enabled: false, error: "config fetch failed" })))
      return
    }
    const readBody = () =>
      new Promise((resolve) => {
        let raw = ""
        req.on("data", (chunk) => {
          raw += chunk
          if (raw.length > 64 * 1024) req.destroy()
        })
        req.on("end", () => {
          try {
            resolve(JSON.parse(raw || "{}"))
          } catch {
            resolve({})
          }
        })
        req.on("error", () => resolve({}))
      })

    if (url.pathname === "/captcha" && req.method === "POST") {
      readBody().then((j) => {
        // 阿里 SDK 把回执作为 captchaVerifyCallback 首参本身（JSON 字符串）；兼容 captchaVerifyParam 字段。
        const receipt = typeof j.receipt === "string" ? j.receipt : typeof j.captchaVerifyParam === "string" ? j.captchaVerifyParam : ""
        state.captchaReceipt = receipt.trim()
        send(200, "application/json", JSON.stringify({ ok: !!state.captchaReceipt }))
      })
      return
    }

    if (url.pathname === "/open-auth" && req.method === "POST") {
      ;(async () => {
        try {
          // 只有上游明确说没启用风控验证时回执才是可带的（见 requestOauthUrl）。
          const authorizeUrl = await requestOauthUrl(
            vendor,
            { port, deviceId, captcha: state.captchaReceipt, captchaRequired: state.captchaEnabled !== false },
            options,
          )
          // 记下厂商放进授权页的 state：回调必须原样带回，否则拒收（防伪造回调劫持登录）。
          let handedOut = ""
          try {
            handedOut = new URL(authorizeUrl).searchParams.get("state") ?? ""
          } catch {
            // 非法地址按缺 state 处理
          }
          if (!handedOut) {
            send(200, "application/json", JSON.stringify({ error: "上游授权页地址缺少 state 参数，已取消登录（回调校验必需）" }))
            return
          }
          state.expectedState = handedOut
          send(200, "application/json", JSON.stringify({ url: authorizeUrl }))
        } catch (error) {
          send(200, "application/json", JSON.stringify({ error: error?.message ?? String(error) }))
        }
      })()
      return
    }

    // 官方登记的回调路径。code 必须配上 /open-auth 记下的 state 才收。
    if (url.pathname === `/auth/callback-${vendor}`) {
      const code = url.searchParams.get("code")
      const callbackState = url.searchParams.get("state") ?? ""
      const denied = url.searchParams.get("error")
      const accepted = !!code && state.expectedState !== null && callbackState === state.expectedState
      if (accepted) {
        state.oauthCode = code
        state.oauthState = callbackState
        notify()
        send(200, "text/html; charset=utf-8", callbackPage(true))
      } else if (denied && state.expectedState !== null && callbackState === state.expectedState) {
        fail(`已取消或拒绝 AutoClaw 国际版官方授权${url.searchParams.get("error_description") ? `：${url.searchParams.get("error_description")}` : ""}`)
        notify()
        send(200, "text/html; charset=utf-8", callbackPage(false, "你取消了授权，可以回 magpie 重新发起登录。"))
      } else {
        // 拒收但不动会话状态：之后到达的合法回调仍能完成登录。
        const note = !code
          ? "回调缺少 code，请回 magpie 重试。"
          : state.expectedState === null
            ? "授权尚未发起或已结束，请回引导页重试。"
            : "回调校验失败（state 不匹配），已拒绝——请回 magpie 重新登录。"
        send(200, "text/html; charset=utf-8", callbackPage(false, note))
      }
      return
    }

    if (url.pathname === "/abort" && req.method === "POST") {
      readBody().then((j) => {
        fail(String(j.reason ?? "用户取消"))
        notify()
        send(200, "application/json", JSON.stringify({ ok: true }))
      })
      return
    }

    send(404, "text/plain", "not found")
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })

  // 流程的收尾只有一个出口：callback 结束、用户取消、或会话超时都走这里，端口只释放一次。
  let sessionDone = false
  let sessionClosed = false
  let sessionTimer
  const closeServer = () => {
    if (sessionClosed) return
    sessionClosed = true
    clearTimeout(sessionTimer)
    if (!sessionDone) {
      fail("本地登录已超时，服务器已关闭——请重新发起登录")
      notify()
    }
    try {
      server.close()
    } catch {
      // 已关闭
    }
    server.closeAllConnections?.()
  }
  // 宿主可能永远不调 callback（用户在 magpie 里取消）：定时器负责关服务器、释放端口。
  sessionTimer = setTimeout(closeServer, OAUTH_SESSION_TIMEOUT_MS)
  sessionTimer.unref?.()

  return {
    url: `http://127.0.0.1:${port}/`,
    instructions: `本地登录页已就绪（未自动打开时手动访问 http://127.0.0.1:${port}/ ）：请完成安全验证并在 ${VENDOR_NAMES[vendor]} 授权页登录，完成后自动返回 magpie。`,
    method: "auto",
    /** 结束这次登录并释放端口；reason 会成为 callback 的失败原因。 */
    cancel(reason = "登录已取消") {
      fail(reason)
      closeServer()
    },
    async callback(signal) {
      // 宿主传来的 AbortSignal：用户在 magpie 里取消了登录，就不再等浏览器。
      const onAbort = () => {
        fail("登录已取消")
        closeServer()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
      try {
        const code = await waitFor(BROWSER_WAIT_MS, "浏览器登录")
        const tokens = await exchangeCode(vendor, { port, deviceId, code, state: state.oauthState }, options)
        // 资料接口读不到不算登录失败；读到就补上邮箱、昵称，以及令牌没给的账号身份。
        const profile = await fetchProfile(tokens.accessToken, deviceId, options).catch((error) => {
          if (error?.kind === "token_expired") throw error
          return null
        })
        return successFrom({
          ...tokens,
          deviceId,
          userId: tokens.userId || profile?.userId,
          userName: tokens.userName || profile?.name,
          email: profile?.email,
          now,
        })
      } finally {
        signal?.removeEventListener("abort", onAbort)
        sessionDone = true
        closeServer()
      }
    },
  }
}

/** 网页登录（Z.ai / Google）：一个带厂商选择的方法。 */
export const webLoginMethod = {
  type: "oauth",
  label: "AutoClaw 国际版网页登录（Z.ai / Google）",
  async authorize(inputs, { signal, ...deps } = {}) {
    const vendor = inputs?.vendor === "google" ? "google" : "zai"
    const flow = await startLocalOauth(vendor, deps)
    return {
      url: flow.url,
      instructions: flow.instructions,
      method: "auto",
      callback: (_code, { signal: inner } = {}) => flow.callback(inner ?? signal),
    }
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

/**
 * 手动填写 access token（refresh token 可选）。
 * 以 oauth 形态保存：凭据是 access + refresh 一对，续期靠 refresh 钩子。
 */
export const tokenMethod = {
  type: "oauth",
  label: "Access Token",
  async authorize(inputs, { signal, ...deps } = {}) {
    return verifyCredentials(
      {
        token: String(inputs?.token ?? ""),
        refreshToken: String(inputs?.refreshToken ?? ""),
        deviceId: String(inputs?.deviceId ?? "").trim() || undefined,
      },
      { signal, ...deps },
    )
  },
  prompts: [
    { type: "password", key: "token", message: "Access Token", validate: (v) => (String(v ?? "").trim() ? undefined : "请填写 access token") },
    { type: "password", key: "refreshToken", message: "Refresh Token（可选，填写后可自动续期）" },
    { type: "text", key: "deviceId", message: "Device ID（可选）" },
  ],
}

/** 导入凭据 JSON：单账号 JSON 或整份 auth.json（token 可以是 enc: 密文，用本机密钥解）。 */
export const credentialJsonMethod = {
  type: "oauth",
  label: "导入凭据 JSON",
  async authorize(inputs, { signal, ...deps } = {}) {
    const secret = await resolveCredentialJson(inputs?.credentialJson)
    return verifyCredentials(secret, { signal, ...deps })
  },
  prompts: [
    {
      type: "password",
      key: "credentialJson",
      message: "凭据 JSON",
      placeholder: '{"token":"…","refreshToken":"…"}',
      validate: (v) => {
        try {
          parseCredentialJson(v)
          return undefined
        } catch (error) {
          return error?.message ?? "凭据 JSON 格式无效"
        }
      },
    },
  ],
}

/** 导入本机国际版登录态：读取官方客户端的 auth.json，不开浏览器。 */
export const desktopMethod = {
  type: "oauth",
  label: "导入本机国际版登录态",
  async authorize() {
    const success = successFrom(await readDesktopCredentials())
    return {
      url: "",
      instructions: `已读取本机 AutoClaw 登录态${success.email ? `（${success.email}）` : ""}，正在保存。`,
      method: "auto",
      callback: async () => success,
    }
  },
}

/** 登录方法，顺序即界面上的按钮顺序。 */
export const loginMethods = [webLoginMethod, tokenMethod, credentialJsonMethod, desktopMethod]
