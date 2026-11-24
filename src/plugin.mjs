// The plugin's hooks, in OpenCode's v1 shape as magpie loads them. Each hook
// is a few lines that hand over to a module of its own:
//
//   config           declares the provider and the models it has before anyone
//                    signs in (catalog.mjs)
//   auth.methods     how to sign in (login.mjs)
//   auth.loader      each account's fetch (relay.mjs)
//   auth.refresh     renews the access token before it runs out (refresh.mjs)
//   auth.usage       credit balance, wallets and the subscription (usage.mjs)
//   auth.checkin     the daily check-in (checkin.mjs)
//   provider.models  the account's live model list (catalog.mjs)
//   chat.headers     the caller's session headers, on to the vendor

import { DEFAULT_ROUTE, defaultModels, liveCatalog } from "./catalog.mjs"
import { clientSessionHeaders } from "./chat.mjs"
import { claim, resetLedgers } from "./checkin.mjs"
import { errorResponse, sendChat } from "./relay.mjs"
import { loginMethods } from "./login.mjs"
import { deviceIdOf, refreshShared } from "./refresh.mjs"
import { ORIGIN, PROVIDER, stripBearer } from "./util.mjs"
import { queryUsage, usageKey } from "./usage.mjs"

const PROVIDER_NAME = "AutoClaw 国际版"

/** 登录前，以及在线目录读不到时的模型行。 */
function staticModels() {
  const rows = {}
  for (const [key, row] of Object.entries(defaultModels())) {
    rows[key] = { ...row, api: { id: row.id }, modalities: { input: ["text"], output: ["text"] } }
  }
  return rows
}

/** 在线目录（键是 magpie 里的 id）→ resolveRoute 读的数组形态。 */
function catalogList(models) {
  return Object.entries(models ?? {}).map(([id, row]) => ({ id, name: row.name, routeId: row.api?.id ?? row.id }))
}

/** 供测试：清掉进程内的台账与缓存。 */
export function resetPluginState() {
  resetLedgers()
}

/**
 * 造这个插件的钩子。deps 只供测试注入（假上游、平台）；magpie 调用时只有 input。
 */
export function makeAutoclawIntlPlugin({ fetchImpl, platform, arch } = {}) {
  return async () => {
    const deps = { fetchImpl, platform, arch }
    /** access token → 这个账号的在线目录（数组形态）。 */
    const catalogs = new Map()

    const hooks = {
      config: async (cfg) => {
        cfg.provider ??= {}
        cfg.provider[PROVIDER] ??= {
          name: PROVIDER_NAME,
          npm: "@ai-sdk/openai-compatible",
          api: ORIGIN,
          models: staticModels(),
        }
      },

      auth: {
        provider: PROVIDER,
        methods: loginMethods,
        maxConcurrency: 8,

        // magpie 在令牌临期时、在 loader / models / usage / 请求之前调用；返回的字段合并进账号。
        async refresh(auth) {
          return refreshShared(auth, deps)
        },

        async loader(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "oauth" || !auth.access) return {}
          const account = String(auth.uid ?? auth.accountId ?? "")

          return {
            baseURL: ORIGIN,
            async fetch(input, init) {
              // 每次请求都取当前账号的令牌：续期或重新登录之后用的是新令牌。
              const current = await getAuth()
              const token = stripBearer(String(current?.access ?? auth.access))
              try {
                // 路由要靠在线目录。magpie 不一定先问过 models 钩子，所以这里自己读一次（有缓存）。
                // 目录只是路由的辅助信息：读不到就用静态路由形态与默认路由，登录态由对话请求自己判定。
                const live = await liveCatalog(token, { ...deps }).catch(() => null)
                // resolveRoute 读的是 { models: [...] }；catalogList 把在线目录转成它的数组形态。
                const catalog = live?.models ? { models: catalogList(live.models) } : catalogs.get(token) ?? null
                return await sendChat({ init, token, account, catalog, defaultRoute: DEFAULT_ROUTE, ...deps })
              } catch (error) {
                // agent 放弃了请求：原样交回，让网关知道是取消。
                if (init?.signal?.aborted) throw error
                return errorResponse(error)
              }
            },
          }
        },

        async usage(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "oauth" || !auth.access) return { error: "未登录", windows: [] }
          try {
            return await queryUsage(stripBearer(auth.access), { deviceId: deviceIdOf(auth), options: deps })
          } catch (error) {
            if (error?.kind === "token_expired") throw error
            return { error: error?.message ?? String(error), windows: [] }
          }
        },

        // magpie 每个北京日对每个账号跑一次（用户在 Settings 里开了签到的提供商）。
        async checkin(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "oauth" || !auth.access) throw new Error("未登录")
          return claim({ token: stripBearer(auth.access), userId: String(auth.uid ?? ""), deviceId: deviceIdOf(auth), key: usageKey(auth), options: deps })
        },
      },

      provider: {
        id: PROVIDER,
        async models(provider, { auth, signal } = {}) {
          // 没登录：静态清单。读不到在线目录：保留 magpie 已有的清单。
          if (auth?.type !== "oauth" || !auth.access) return provider.models
          const token = stripBearer(auth.access)
          const live = await liveCatalog(token, { ...deps, signal })
          if (!live.models) return provider.models
          const rows = {}
          for (const [id, row] of Object.entries(live.models)) {
            rows[id] = { ...(provider.models?.[id] ?? {}), ...row, id }
          }
          catalogs.set(token, { models: catalogList(live.models) })
          return rows
        },
      },

      // 调用方的会话关联头（x-autoclaw-*）转给上游；magpie 自己的 x-magpie-* 头不出插件。
      "chat.headers": async (input, output) => {
        if (input?.model?.providerID !== PROVIDER) return
        const sessionHeaders = input?.sessionID ? { "x-autoclaw-session-id": String(input.sessionID) } : {}
        Object.assign(output.headers, clientSessionHeaders({ ...sessionHeaders, ...(input.headers ?? {}) }))
      },
    }
    return hooks
  }
}
