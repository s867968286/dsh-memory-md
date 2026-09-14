/**
 * dsh-memory-md — Host 半（bundle 行，host 平面）。
 *
 * 纯本地 Markdown 记忆。对外提供两件东西：
 *
 * 1. **`memory_md_*` 工具** —— 模型主动读写记忆的通道；
 * 2. **两段式记忆注入** —— 不变的协议进系统提示词段（`systemPrompt.section()`），
 *    易变的 `MEMORY.md` 索引进运行期上下文快照（`systemPrompt.context()`），
 *    模型不必先调工具就知道有什么记忆。拆开是因为两者生命周期不同：协议是
 *    常量，读盘的只有索引；混在一起会让协议跟着每次记忆变化重发一遍。
 *
 * 轮末另有**后台异步 LLM 总结**（`summarize.mjs`），由它写记忆与日志 ——
 * 不往主对话塞消息，因此对话里看不到任何提醒。
 *
 * 记忆根目录固定在 `<dshHome>/memory-md`，路径由插件算、不接受调用方传入 ——
 * 早先让模型自己补路径的结果，是把文件写进了工作区。
 */
import {
  DEFAULT_SETTINGS,
  isPresetDisabled,
  readSettings,
  resolvePaths,
  writeSettings,
} from './settings.mjs'
import { ROUTE_PREFIX, registerRoutes } from './routes.mjs'
import { MEMORY_PROTOCOL, renderMemoryIndex } from './inject.mjs'
import { registerMemoryTools } from './tools.mjs'
import { createTurnStoppingListener, forgetSession } from './summarize.mjs'

export { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings, ROUTE_PREFIX }

/** 读取一次会话的 cwd。 */
const cwdOf = (session) => {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/**
 * 读取一次会话所属的 agent preset id。
 *
 * 用于「在这个预设下整体停用」的判断。没有 preset（未挂在任何预设下）
 * 或读不到时返回 undefined —— 那种情况永远不匹配停用名单，即默认生效。
 */
const presetOf = (session) => {
  const id = session?.header?.agentPreset
  return typeof id === 'string' && id ? id : undefined
}

export const name = 'memory-md-host'
export const inject = ['webServer']
export function apply(ctx, config = {}) {
  const paths = resolvePaths(config.dshHome)
  const logger = ctx.logger

  const sessionsStore = () => ctx.get('sessions')
  const sessionFor = (agent) => {
    try {
      return sessionsStore()?.get?.(agent.id)
    } catch {
      return undefined
    }
  }

  /**
   * 该 agent 是否处在「已停用本插件」的预设下。
   *
   * 三条入口（工具、后台总结、HTTP）都要先问这一句 —— 否则会出现
   * 「工具被隐藏了、但后台行为还在」的半生效状态。
   *
   * 没有 agent（例如 host 侧无会话的调用）时不拦：默认全局生效。
   */
  const isDisabledFor = (agent) => {
    if (agent === undefined || agent === null) return false
    const presetId = presetOf(sessionFor(agent))
    return isPresetDisabled(readSettings(paths), presetId)
  }

  /**
   * 当前工作区。
   *
   * 项目级记忆要按**真实工作区**算 slug。工具调用带 `exec.agent`（由 agent loop
   * 设置），直接用它就够了。取不到时返回 undefined，让工具报错 —— 而不是去
   * `sessions.list()` 里猜：官方文档明确它是**创建顺序**，猜出来的是最老的那个
   * 会话，会把记忆写进别的项目目录。宁可不写，也不写错地方。
   */
  const workspaceCwd = (exec) => {
    const agent = exec?.agent
    if (agent === undefined) return undefined
    return cwdOf(sessionFor(agent))
  }

  // 设置页需要读写记忆目录，挂在 host 平面（bundle 行插件无法注册 web 路由）。
  // 不再传工作区回调：设置页是全局页面，拿不到「当前会话」，猜出来的路径
  // 切换会话后就是错的（详见 routes.mjs 的说明）。
  registerRoutes(ctx, config)

  // ---- 记忆工具：本插件对外提供的唯一能力面
  const tools = ctx.get('tools')
  if (tools === undefined) {
    logger?.warn?.('[memory-md] tools 服务不可用，记忆工具未注册')
  } else {
    try {
      const dispose = registerMemoryTools({
        tools,
        config: {
          dshHome: paths.dshHome,
          workspaceCwd,
          // 预设停用名单：工具先问这一句，避免「工具在、后台行为也在」。
          isDisabledFor,
          hints: { dirs: `${paths.memoryRoot}\\{global|<workspace-slug>}` },
        },
        logger,
      })
      ctx.effect(() => dispose)
    } catch (error) {
      // 工具注册失败不该拖垮设置页 —— 两个能力互相独立。
      logger?.warn?.(`[memory-md] 记忆工具注册失败: ${String(error)}`)
    }
  }

  // ---- 记忆注入：不变的协议进提示词段，易变的索引进上下文快照
  //
  // 两段分走不同通道，因为生命周期不同：
  //
  // - `section()` 进**系统提示词**。协议是常量，逐字节恒定 —— 所以 DSH 每个
  //   step 重装提示词时结果不变，前缀 KV Cache 始终命中。
  // - `context()` 进**运行期上下文快照**，作为历史里追加的 user 角色消息。
  //   索引读盘、随记忆增删而变，走这条路不吃提示词前缀；去重由 loop 的
  //   `RuntimeContextProjection` 内建 —— 索引没变就不会重复注入。
  //
  // 早先把两者都放进 `context()`：协议文本于是跟着每次记忆变化重发一遍，
  // 而旧快照仍留在历史里（快照是追加而非替换），纯属浪费 token。
  //
  // 用 `ctx.inject` 延迟到 `systemPrompt` 就绪再注册：host 平面早期
  // 该服务可能还没装载，直接 `ctx.get` 会拿到 undefined。
  ctx.inject(['systemPrompt'], (scope) => {
    // 本回合是否该注入记忆。两段共用同一个判断，避免出现「协议在、索引不在」
    // 或反过来的半生效状态。
    const shouldInject = (assembly) => {
      // 记忆总开关关掉 → 完全不注入（与工具侧的 assertEnabled 语义一致）。
      if (readSettings(paths).enabled !== true) return false
      // 预设级停用：这些预设自带独立记忆，全局记忆必须整体让位。
      const agent = assembly?.agent
      if (agent !== undefined && isDisabledFor(agent) === true) return false
      return true
    }

    // (1) 协议段：静态文本，进系统提示词。
    //
    // 用 950 这个空档：在文件引用段（900）之后、工具说明段（1000+）之前，
    // 读起来是"先讲记忆是什么，再讲有哪些工具"。不占人设段（0）或身份段
    // （-1000）—— 那是官方立规矩的地方，插件只解释自己的东西。
    scope.systemPrompt.section({
      name: 'memory-md:protocol',
      order: 950,
      text: (assembly) => (shouldInject(assembly) ? MEMORY_PROTOCOL : ''),
    })

    // (2) 索引快照：易变，走 context()。
    scope.systemPrompt.context({
      name: 'memory-md:index',
      // 外部贡献可用任意有限 order。放在官方三项（沙箱 110 / 审批 115 /
      // 子代理 120）之后，读起来是"运行环境先说，记忆随后"。
      order: 10_000,
      text: (assembly) => {
        if (!shouldInject(assembly)) return ''
        const agent = assembly?.agent
        const cwd = agent === undefined ? undefined : cwdOf(sessionFor(agent))
        return renderMemoryIndex({ memoryRoot: paths.memoryRoot, cwd, dshHome: paths.dshHome })
      },
    })
  })

  // ---- 轮末后台总结：独立 LLM 调用做总结反思，写记忆与日志
  //
  // 不往主对话塞消息，所以对话里看不到任何提醒；也不跑子代理，避免递归与
  // 会话列表污染。
  //
  // 监听器注册在**根 ctx** 上，不是注册在 `ctx.inject` 给的那个子 scope 上：
  // cordis 的事件沿作用域**向上冒泡**，而 agent 的 scope 与本插件的注入 scope
  // 是兄弟关系，挂在子 scope 上根本收不到 `agent/turn-stopping`。
  // 只有 `llm` 这个服务需要延迟取，所以在注入回调里捕获它。
  let llmService
  ctx.inject(['llm'], (scope) => {
    llmService = scope.llm
  })

  const listener = createTurnStoppingListener({
    // 惰性读取：注册时 llm 可能还没就绪，真跑时一定已经就绪。
    getLlm: () => llmService,
    getSession: (agent) => sessionFor(agent),
    // 被停用的预设下不该写全局记忆。
    isDisabledFor,
    // 兜底路由：会话还没有 requestHeader 时用部署默认模型。
    defaultRoute: () => defaultRouteOf(ctx),
    logger,
  })
  ctx.on('agent/turn-stopping', listener)
  // ---- 会话结束：强制写一次，然后清状态
  //
  // 为什么必须 force：`turn-stopping` 在「内容不足」时会故意不写（留给下轮回补），
  // 但会话一旦结束就**没有下一轮**了 —— 最后一段对话会永久丢失。
  // 所以会话结束时绕过门槛与防抖，确保写一次。
  //
  // 顺序要紧：**先** force（此时 session 还能取到），**再** forgetSession 清状态。
  // 反过来的话 `getSession(agent)` 已经拿不到，force 等于空跑。
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    try {
      listener.force?.({ agent })
    } catch (error) {
      // 清理路径上的失败绝不能抛出去。
      logger?.warn?.(`[memory-md] 会话结束总结触发失败: ${String(error)}`)
    }
    // agent 销毁时清掉会话状态，别让 Map 无限增长。
    const id = agent?.id
    if (typeof id === 'string') forgetSession(id)
  })
}

/**
 * 兜底 provider/model。
 *
 * 正常路径是从会话的 `requestHeader()` 取 —— 那才是这个会话真实用过的路由。
 * 这里只是极端情况（首轮还没有 header）的保护，取不到就让总结跳过。
 */
function defaultRouteOf(scope) {
  try {
    // `agentDefaultModel` 直接挂 provider/model（见该包的类型声明）。
    const service = scope.get?.('agentDefaultModel')
    const provider = service?.provider
    const model = service?.model
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  } catch {
    /* 忽略 */
  }
  return undefined
}

export default { name, inject, apply }
