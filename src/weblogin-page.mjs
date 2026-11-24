// The login page the user's browser opens (Agent2API's panel page and
// aliyun-captcha.js, as one page of the plugin's own).
//
// What it does, in order:
//   1. asks the plugin for the vendor's captcha configuration;
//   2. if the vendor wants one, loads the vendor's Aliyun captcha SDK and shows
//      the puzzle. The SDK hands back an opaque receipt, which the page passes
//      to the plugin unchanged;
//   3. asks the plugin for the vendor's authorization page, and goes there.
//
// What it doesn't do: finish the sign-in. The vendor sends the browser back to
// http://localhost:<registered port>/auth/callback-<vendor>. On the machine the
// plugin runs on that page is served and the sign-in completes by itself.
// Anywhere else (a container) it doesn't load, so before leaving, the page says
// plainly what address the browser will land on and that its whole address is
// to be pasted into magpie.
//
// Every request carries the token from this page's address: the port can be
// open to the network in a container, and the token is what makes this page,
// and not some other site, the one that drives this sign-in.

import { ALIYUN_CAPTCHA_JS } from "./util.mjs"

const VENDOR_NAMES = { zai: "z.ai", google: "Google" }

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

const STYLE = `
 body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:#f5f6fa;display:flex;justify-content:center;padding:40px 16px;margin:0}
 .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:520px;width:100%;padding:32px;box-sizing:border-box}
 h1{font-size:20px;margin:0 0 8px}
 p.sub{color:#666;font-size:14px;margin:0 0 20px;line-height:1.6}
 .step{font-size:14px;color:#333;margin:10px 0;display:flex;gap:8px;align-items:flex-start;line-height:1.6}
 .step .n{background:#4f6ef7;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none;margin-top:1px}
 #captchaBox{margin:16px 0;padding:16px;border:1px dashed #ccc;border-radius:10px;display:none}
 #captchaEle{min-height:44px}
 button.primary{background:#4f6ef7;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-size:15px;cursor:pointer;width:100%;margin-top:16px}
 button.primary:disabled{background:#b9c0f4;cursor:not-allowed}
 .msg{font-size:13px;margin-top:10px;min-height:18px;line-height:1.6}
 .msg.ok{color:#1a9c5b}.msg.err{color:#d43c3c}.msg.warn{color:#c98a00}
 #hint{display:none;margin-top:16px;padding:14px 16px;border-radius:10px;background:#fff7e6;border:1px solid #f5d08a;font-size:14px;line-height:1.7}
 #hint code{display:block;word-break:break-all;background:#fff;padding:8px 10px;border-radius:6px;margin:8px 0;font-size:13px}
 #hint a{color:#4f6ef7}
 .spin{display:inline-block;width:14px;height:14px;border:2px solid #e3e6f7;border-top-color:#4f6ef7;border-radius:50%;animation:r .8s linear infinite;vertical-align:-2px;margin-right:6px}
 @keyframes r{to{transform:rotate(360deg)}}
`

/** 登录页面。token 是这个登录专有的令牌（页面地址里就有），所有接口请求都带上它。 */
export function loginPageHtml({ vendor, token, captchaJs = ALIYUN_CAPTCHA_JS }) {
  const name = escapeHtml(VENDOR_NAMES[vendor] ?? vendor)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AutoClaw · ${name} 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<style>${STYLE}</style></head>
<body>
<div class="card">
 <h1>AutoClaw · ${name} 登录</h1>
 <p class="sub">这个页面由 magpie 的 AutoClaw 插件提供。</p>
 <div class="step"><span class="n">1</span><span id="stepCaptcha">检查安全验证…</span></div>
 <div id="captchaBox"><div id="captchaEle"></div></div>
 <div class="step"><span class="n">2</span><span>前往 ${name} 授权页，登录并授权</span></div>
 <div class="step"><span class="n">3</span><span>回到 magpie 完成登录</span></div>
 <button class="primary" id="goBtn" disabled>前往授权页</button>
 <div class="msg" id="msg"></div>
 <div id="hint"></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const HIDDEN_TRIGGER_ID = "__acHiddenTrigger";
function msg(text, cls) { const e = document.getElementById("msg"); e.textContent = text; e.className = "msg " + (cls || ""); }
// 每个请求都带上这个登录的令牌：端口可以对网络开放，知道令牌的只有这个页面。
async function call(path, options = {}) {
  const headers = Object.assign({ "X-Login-Token": TOKEN }, options.headers || {});
  const response = await fetch(path, Object.assign({}, options, { headers, credentials: "omit", cache: "no-store" }));
  return response.json();
}
function loadCaptchaLib() {
  return new Promise((resolve) => {
    if (window.initAliyunCaptcha) { resolve(true); return; }
    const script = document.createElement("script");
    script.src = ${JSON.stringify(captchaJs)};
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha === "function");
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(typeof window.initAliyunCaptcha === "function"), 15000);
  });
}
function ensureHiddenTrigger() {
  let button = document.getElementById(HIDDEN_TRIGGER_ID);
  if (button) return button;
  button = document.createElement("button");
  button.id = HIDDEN_TRIGGER_ID;
  button.type = "button";
  button.tabIndex = -1;
  button.setAttribute("aria-hidden", "true");
  button.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
  document.body.appendChild(button);
  return button;
}
async function boot() {
  let config = { enabled: false };
  try {
    const response = await call("/captcha-config");
    if (response && response.error) throw new Error(response.error);
    config = response || config;
  } catch (error) {
    msg("读取安全验证配置失败：" + (error && error.message ? error.message : "网络错误") + "。请刷新重试；持续失败请检查容器能否访问 autoglm-api.autoglm.ai", "err");
    return;
  }
  if (config.enabled) {
    document.getElementById("stepCaptcha").textContent = "完成安全验证";
    document.getElementById("captchaBox").style.display = "block";
    msg("正在加载安全验证组件…", "warn");
    const loaded = await loadCaptchaLib();
    if (!loaded) { msg("安全验证组件加载失败（网络不通或被拦截），请刷新重试", "err"); return; }
    // 官方流程：init → 预热 ≥2.1 秒 → 程序化点击隐藏按钮 → 组件弹出验证窗。点得太早会弹出空白框。
    let receiptSent = false;
    window.AliyunCaptchaConfig = window.AliyunCaptchaConfig || { region: config.region || "", prefix: config.prefix || "" };
    try {
      window.initAliyunCaptcha({
        SceneId: config.sceneId,
        mode: "popup",
        element: "#captchaEle",
        button: "#" + HIDDEN_TRIGGER_ID,
        language: "cn",
        slideStyle: { width: 320, height: 40 },
        getInstance: () => {},
        onBizResultCallback: () => {},
        captchaVerifyCallback: async (params) => {
          // 阿里 SDK 把回执作为首参本身（JSON 字符串）；兼容 captchaVerifyParam 字段。
          const receipt = typeof params === "string" ? params : params && typeof params.captchaVerifyParam === "string" ? params.captchaVerifyParam : "";
          try {
            const result = await call("/captcha", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receipt }) });
            receiptSent = !!(result && result.ok);
            return { captchaResult: receiptSent, bizResult: receiptSent };
          } catch (error) {
            msg("安全验证结果没有送达插件：" + (error && error.message ? error.message : "网络错误"), "err");
            return { captchaResult: false, bizResult: false };
          }
        },
        onError: (error) => { msg("安全验证出错：" + ((error && error.message) || "") + "，请重试", "err"); },
      });
    } catch (error) {
      msg("安全验证组件初始化失败：" + ((error && error.message) || ""), "err");
      return;
    }
    msg("验证组件已就绪，正在弹出验证窗…", "warn");
    setTimeout(() => { document.getElementById(HIDDEN_TRIGGER_ID).click(); }, 2300);
    // 等回执送到插件（最多三分钟），然后放行「前往授权页」。
    const started = Date.now();
    while (!receiptSent && Date.now() - started < 180000) await new Promise((resolve) => setTimeout(resolve, 400));
    if (!receiptSent) { msg("还没有完成安全验证，请先完成", "warn"); return; }
    msg("安全验证通过", "ok");
  } else {
    document.getElementById("stepCaptcha").textContent = "无需安全验证";
  }
  const button = document.getElementById("goBtn");
  button.disabled = false;
}
async function goToAuthorization() {
  const button = document.getElementById("goBtn");
  button.disabled = true;
  button.textContent = "正在获取授权页…";
  let result;
  try {
    result = await call("/open-auth", { method: "POST" });
  } catch (error) {
    msg("连接登录服务失败：" + (error && error.message ? error.message : "网络错误") + "。请回 magpie 重新发起登录", "err");
    button.disabled = false;
    button.textContent = "前往授权页";
    return;
  }
  if (!result || result.error) {
    msg((result && result.error) || "没有拿到授权页，请回 magpie 重新发起登录", "err");
    button.disabled = false;
    button.textContent = "前往授权页";
    return;
  }
  // 先把「回来之后怎么办」讲清楚，再离开：离开后这个页面就没有了。
  const callback = (result.callback && result.callback.redirectUri) || "";
  const hint = document.getElementById("hint");
  if (callback) {
    hint.innerHTML =
      "<b>授权完成后</b>，浏览器会跳到下面这个地址：" +
      "<code>" + callback.replace(/[&<>]/g, "") + "</code>" +
      "如果它显示「无法访问」，这是正常的（它指向的是插件所在的机器，不是你的电脑）。" +
      "这时请<b>复制地址栏里的完整地址</b>，回到 magpie，粘贴到这次登录的「回调地址 / Callback URL」里。" +
      "如果它显示「授权成功」，什么都不用做，magpie 会自己完成。";
    hint.style.display = "block";
  }
  button.textContent = "我已复制，前往授权页";
  await new Promise((resolve) => setTimeout(resolve, 1500));
  location.href = result.url;
}
document.getElementById("goBtn").addEventListener("click", goToAuthorization);
// 页面关掉不算取消：在容器里，用户去授权页登录时这个页面就被导航走了，回来还要靠这次登录。
// 取消只由用户在 magpie 里操作，或登录超时。
boot();
</script></body></html>`
}

/** 厂商把浏览器送回来、而且插件收到了：这一页。 */
export function callbackPageHtml(ok, note) {
  const title = ok ? "授权成功" : "授权没有完成"
  const color = ok ? "#1a9c5b" : "#d43c3c"
  const text = note ?? (ok ? "可以关闭这个窗口，回到 magpie。" : "请回到 magpie 重新发起登录。")
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f6fa}
.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px 48px;text-align:center;max-width:480px;line-height:1.7}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{color:#666;font-size:14px;margin:0;word-break:break-word}</style></head>
<body><div class="c"><h1>${title}</h1><p>${escapeHtml(text)}</p></div></body></html>`
}

/** 这个端口上其它任何请求：只说明情况，不多给。 */
export function closedPageHtml(note) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AutoClaw 登录</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f6fa;color:#666;font-size:14px}</style>
<body><div>${escapeHtml(note)}</div></body></html>`
}
