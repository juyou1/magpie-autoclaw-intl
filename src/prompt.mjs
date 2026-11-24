// The system-prompt compatibility layer for the overseas chat gateway
// (prompt.rs). The gateway refuses (406) a chat whose system prompt carries
// another agent's identity line, and expects the official client's opening
// sentence. Two steps, on system/developer text only: rewrite the foreign
// identity sentences it is known to refuse, then make sure the first message
// opens with the identity line. User, tool and assistant messages, images and
// turn order are never touched, and the caller's own system prompt is kept
// whole after the prefix.

/** 新国际客户端系统首句。 */
export const IDENTITY_LINE = "You are AutoClaw. Answer the user directly and concisely."
const IDENTITY_PREFIX = `${IDENTITY_LINE}\n`

/** 外来身份句；长规则先于短规则，匹配忽略 ASCII 大小写。 */
const FOREIGN_IDENTITIES = [
  // ── ZCode（长的在前）──
  ["You are ZCode, an interactive coding agent", "You are an interactive coding agent"],
  ["You are ZCode", "You are an interactive coding agent"],
  ["an agent for ZCode", "an agent for a coding assistant"],
  // ── Codex ──
  ["You are a coding agent running in the Codex CLI tool", "You are a coding agent running in a terminal CLI tool"],
  ["You are a coding agent running in the Codex CLI", "You are a coding agent running in a terminal CLI"],
  ["You are running as a coding agent in the Codex CLI", "You are running as a coding agent in a terminal CLI"],
  ["You are Codex", "You are a coding agent"],
  ["Codex CLI", "Codex command-line tool"],
  // ── Claude 系 ──
  ["You are a Claude agent, built on Anthropic's Claude Agent SDK", "You are a coding assistant"],
  ["Claude Agent SDK", "the agent framework"],
  ["You are Claude Code", "You are a coding assistant"],
  ["an agent for Claude Code", "an agent for a coding assistant"],
  // ── DeepSeek Harness ──
  ["You are an AI agent powered by DeepSeek Harness", "You are an AI agent powered by a local coding harness"],
  ["DeepSeek Harness", "a local coding harness"],
  // ── 其它 CLI / Agent 身份句 ──
  ["You are CodeBuddy Code", "You are a coding assistant"],
  ["You are Hermes Agent", "You are an agent"],
  ["You are Hermes", "You are an agent"],
  ["You are Gemini CLI", "You are a coding agent"],
  ["You are Kimi Code CLI", "You are a coding agent"],
  ["You are Qwen Code", "You are a coding agent"],
  ["You are opencode", "You are a coding assistant"],
  ["You are Cursor", "You are a coding assistant"],
  ["You are Cline", "You are a coding assistant"],
  ["You are goose", "You are a coding assistant"],
  // ── 其它措辞 ──
  ["operating inside pi, a coding agent harness", "operating inside a coding agent harness"],
  ["This conversation is powered by GLM", "This conversation is powered by the GLM"],
]

/** ASCII 大小写不敏感的查找，返回字节下标。 */
function findIgnoreCase(text, from) {
  const haystack = Buffer.from(text, "latin1")
  const needle = Buffer.from(from, "latin1")
  if (!needle.length || haystack.length < needle.length) return -1
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let same = true
    for (let i = 0; i < needle.length; i++) {
      let a = haystack[start + i]
      const b = needle[i]
      if (a >= 97 && a <= 122) a -= 32
      if (a !== (b >= 97 && b <= 122 ? b - 32 : b)) {
        same = false
        break
      }
    }
    if (same) return start
  }
  return -1
}

function replaceAllIgnoreCase(text, from, to) {
  if (findIgnoreCase(text, from) < 0) return text
  let out = ""
  let rest = text
  for (;;) {
    const at = findIgnoreCase(rest, from)
    if (at < 0) return out + rest
    out += rest.slice(0, at) + to
    rest = rest.slice(at + from.length)
  }
}

// 只处理已确认的 GLM 身份句式：模型 ID、文件名和其它正文保持。
function normalizeModelSentence(text) {
  const needle = "powered by the model glm-"
  let rest = text
  let out = ""
  let changed = false
  for (;;) {
    const start = findIgnoreCase(rest, needle)
    if (start < 0) break
    const tail = rest.slice(start + needle.length)
    const m = /^[A-Za-z0-9._:-]+/.exec(tail)
    const end = m ? m[0].length : 0
    if (!end) {
      out += rest.slice(0, start + needle.length)
      rest = tail
      continue
    }
    const version = tail.slice(0, end).replace(/\.+$/, "")
    out += `${rest.slice(0, start)}powered by the GLM-${version} model${tail.slice(version.length, end)}`
    rest = tail.slice(end)
    changed = true
  }
  out += rest
  return changed ? out : text
}

function rewriteIdentities(text) {
  for (const [from, to] of FOREIGN_IDENTITIES) text = replaceAllIgnoreCase(text, from, to)
  return normalizeModelSentence(text)
}

/** 就地改写一条 system / developer 消息的正文（字符串写回，文本 part 数组就地改）。 */
function rewriteIdentitiesInPlace(message) {
  if (typeof message.content === "string") {
    message.content = rewriteIdentities(message.content)
    return
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === "object" && typeof part.text === "string") part.text = rewriteIdentities(part.text)
    }
  }
}

// 前缀 + 一个空行 + 原文（原文为空时不留多余空行）。
function joinPrefix(original) {
  return original ? `${IDENTITY_PREFIX}\n${original}` : IDENTITY_PREFIX
}

/** 给一条 system / developer 消息的正文前置身份句（已以身份句开头则不动）。 */
function prependPrefix(message) {
  if (!("content" in message)) {
    message.content = IDENTITY_PREFIX
    return
  }
  const content = message.content
  if (typeof content === "string") {
    if (!content.startsWith(IDENTITY_LINE)) message.content = joinPrefix(content)
    return
  }
  if (Array.isArray(content)) {
    const index = content.findIndex((part) => part && typeof part === "object" && typeof part.text === "string")
    if (index < 0) {
      content.unshift({ type: "text", text: IDENTITY_PREFIX })
      return
    }
    if (!content[index].text.startsWith(IDENTITY_LINE)) content[index].text = joinPrefix(content[index].text)
    return
  }
  // null / 对象 / 数字当不成系统提示词：换成前缀本身。
  message.content = IDENTITY_PREFIX
}

function isSystemRole(message) {
  return message?.role === "system" || message?.role === "developer"
}

/** 出站前规范化 body 里的系统提示词（就地修改）。messages 缺失或不是数组时直接返回。 */
export function normalizePrompt(body) {
  if (!body || !Array.isArray(body.messages)) return body
  for (const message of body.messages) {
    if (message && isSystemRole(message)) rewriteIdentitiesInPlace(message)
  }
  if (isSystemRole(body.messages[0])) {
    prependPrefix(body.messages[0])
  } else {
    body.messages.unshift({ role: "system", content: IDENTITY_PREFIX })
  }
  return body
}
