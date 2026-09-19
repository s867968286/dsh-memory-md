/**
 * dsh-memory-md — Host 半（bundle 行，host 平面）。
 *
 * 纯本地 Markdown 记忆。对外提供两件东西：
 *
 * 1. **`memory_md_*` 工具** —— 模型主动读写记忆的通道；
 * 2. **两段式记忆注入** —— 不变的部分（协议 + 行为纪律，纯常量）进系统提示词段
 *    （`systemPrompt.section()`），易变的 `MEMORY.md` 索引进行期上下文快照
 *    （`systemPrompt.context()`），模型不必先调工具就知道有什么记忆。
 *    拆开是因为两者生命周期不同：**常量进 section 逐字节恒定、KV Cache 命中、
 *    不产生新消息；读盘的索引进 context，变了才追加。** 把常量混进 context 会
 *    让它随索引变化反复重发；把读盘内容混进 section 会让整个前缀缓存失效。
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
import { memoryPromptText, renderMemoryIndex } from './inject.mjs'
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
/**
 * ⚠️ **不要**把 `webServer` 写进这里。
 *
 * cordis 的 `inject` 是**必要依赖**：依赖未就绪时 fiber 停在 INACTIVE，
 * `apply()` **根本不会执行**（实测：缺 webServer 时 `apply()` 不跑，无 inject
 * 声明的照常跑）。而 `webServer` 只由 `dsh-web-app` bundle 提供
 * （其 cordis.patch.yml:136 插入 `dsh-host-webserver`），`dsh-base` 与
 * `dsh-headless` / `dsh-acp-app` 都**不含**它。
 *
 * 所以顶层声明 `inject: ['webServer']` 的后果是：在 headless / acp profile 下
 * 插件**整体静默失效** —— 不只是设置页没有，而是五个记忆工具与两段式注入
 * 全部不注册、且不打任何警告，排查时完全看不出原因。
 *
 * 正确做法是分层：工具与注入**都不依赖 webServer**，各自走
 * `ctx.inject(['tools'], …)` / `ctx.inject(['systemPrompt'], …)` 延迟注册；
 * **只有设置页路由**才 Web 专属 —— 它在 `ctx.inject(['webServer'], …)` 里注册，
 * 缺服务时那条回调不执行，其余能力照常工作。
 */
export const inject = []
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
  //
  // 用 `ctx.inject(['webServer'], …)` 延迟注册，**而不是**顶层
  // `export const inject = ['webServer']`：后者会让整个插件在没有 webServer 的
  // profile（headless / acp）下连 apply() 都不执行，工具与注入一起消失
  // ——见文件顶部 inject 的说明。这里缺服务只是少一个设置页。
  ctx.inject(['webServer'], (scope) => {
    try {
      registerRoutes(scope, config)
    } catch (error) {
      // 设置页失败不该拖垮工具与注入。
      logger?.warn?.(`[memory-md] 设置页路由注册失败: ${String(error)}`)
    }
  })

  // ---- 记忆工具：本插件对外提供的唯一能力面
  //
  // 用 `ctx.inject(['tools'], …)` 延迟注册，**不是** `ctx.get('tools')` 直接取。
  //
  // 为什么：顶层 `inject` 现在是空数组，`apply()` 会在**任何依赖就绪之前**就跑。
  // 此时若 `tools` 还没装载，`ctx.get('tools')` 拿到 undefined，工具就**永久**
  // 注册不上 —— 而装载顺序取决于 profile 的 bundles 列表，把正确性押在
  // "我们的行排在 tools 之后"是脆弱的（实测确认：tools 晚就绪 → 5 个工具全丢）。
  //
  // `ctx.inject` 是 cordis 的延迟注入：依赖**出现时**才回调，服务后来才就绪也能补上。
  // 与 `systemPrompt` / `llm` 用的是同一条通道，语义一致。
  ctx.inject(['tools'], (scope) => {
    try {
      const dispose = registerMemoryTools({
        tools: scope.tools,
        config: {
          dshHome: paths.dshHome,
          workspaceCwd,
          // 预设停用名单：工具先问这一句，避免「工具在、后台行为也在」。
          isDisabledFor,
          hints: { dirs: `${paths.memoryRoot}\\{global|<workspace-slug>}` },
        },
        logger,
      })
      scope.effect(() => dispose)
    } catch (error) {
      // 工具注册失败不该拖垮设置页与注入 —— 三个能力互相独立。
      logger?.warn?.(`[memory-md] 记忆工具注册失败: ${String(error)}`)
    }
  })

  // 索引冻结缓存：sessionId -> 上一次渲染出的索引文本。
  //
  // 挂在**根 ctx** 而不是 `ctx.inject` 的子 scope 里 —— cordis 的事件沿作用域
  // **向上冒泡**，而 `memory-md/settings-changed` 由 routes 在根 ctx 上 emit，
  // 子 scope 根本收不到（与 `agent/turn-stopping` 那次是同一个坑，见下方 :247）。
  const frozenIndex = new Map()

  // 设置页保存后清空缓存 —— 这正是 routes.mjs:100 那个
  // `memory-md/settings-changed` 事件想做的事（此前**只发不收**：
  // 注释写着"让 Host 半丢弃已缓存的注入文本"，但没有任何监听者）。
  //
  // 有了它，「关掉冻结 → 下一轮 → 再打开」才能拿到最新索引；
  // 否则重新打开时命中的是一份陈旧缓存，用户以为刷新了其实没有。
  ctx.on('memory-md/settings-changed', () => {
    frozenIndex.clear()
  })

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

    // (1) 提示词段：静态文本，进系统提示词。
    //
    // 内容是**协议 + 行为纪律**，两者都是纯常量（一个字节都不读盘）——
    // 所以逐字节恒定，DSH 每个 step 重装提示词时结果不变，前缀 KV Cache 始终命中，
    // 且**不会往会话历史里追加任何消息**。
    //
    // 反之，读盘的索引绝不能放这里：任何随文件变化的 section 都会让整个前缀
    // 的 KV Cache 失效（含全部历史）。索引因此走下面的 `context()`。
    //
    // 用 950 这个空档：在文件引用段（900）之后、工具说明段（1000+）之前，
    // 读起来是"先讲记忆是什么，再讲有哪些工具"。不占人设段（0）或身份段
    // （-1000）—— 那是官方立规矩的地方，插件只解释自己的东西。
    scope.systemPrompt.section({
      name: 'memory-md:protocol',
      order: 950,
      text: (assembly) => (shouldInject(assembly) ? memoryPromptText() : ''),
    })

    // (2) 索引快照：易变，走 context()。
    //
    // **只放索引** —— 它读盘、随记忆增删而变，所以不能进 section（见上）。
    // 纪律是常量，已在上面的 section 里，不在这里重复：曾经拼在这里，
    // 结果是索引一变就把 2400 多字的常量规则带着整段重发（快照是追加而非替换）。
    //
    // ## 冻结（`freezeIndex`）
    //
    // 打开后不再重复注入：缓存**上一次渲染的文本**，之后恒返回这份缓存。
    //
    // 原理：`RuntimeContextProjection.project()` 比对的是
    // `joinContextSections(sections)` 拼接后的**整串**（dsh-agent-loop/lib/index.js:893），
    // 相同就不追加（同文件 :339）。返回值恒定 → 整串不变 → 一条新消息都不产生。
    //
    // ⚠️ 注意**不能**用"返回空串"来实现冻结：那样整串会因为少了我们这段而变化，
    // 照样追加一份新快照，而且那份里没有索引 —— 等于把记忆注入弄坏了。
    //
    // ⚠️ 官方那几段（沙箱策略 / 审批策略 / 子代理）也在同一个整串里，它们变了
    // 仍会追加新快照、我们的文本搭车出现。那个由 loop 的全局 supersede 语义决定，
    // 插件层消不掉；冻结能消掉的是**我们自己这一侧**的重复注入。
    scope.systemPrompt.context({
      name: 'memory-md:index',
      // 外部贡献可用任意有限 order。放在官方三项（沙箱 110 / 审批 115 /
      // 子代理 120）之后，读起来是"运行环境先说，记忆随后"。
      order: 10_000,
      text: (assembly) => {
        if (!shouldInject(assembly)) return ''
        const agent = assembly?.agent
        const cwd = agent === undefined ? undefined : cwdOf(sessionFor(agent))
        const render = () =>
          renderMemoryIndex({ memoryRoot: paths.memoryRoot, cwd, dshHome: paths.dshHome })

        // 设置**实时读取**：改完立刻生效，不必重启。
        // 注意这次读盘在缓存命中时**每步仍会发生** —— 与 dsh-preset-md 同一取舍
        // （其 core.js:443-445 明确记录："缓存命中时每步同步读一次 settings.json"）。
        // 保留它是为了让「新会话/开关翻转」立刻取到最新设置，不必等插件重启。
        const freeze = readSettings(paths).freezeIndex === true
        const id = typeof agent?.id === 'string' ? agent.id : undefined

        // 取不到 sessionId 时**不缓存**，每次读盘。
        //
        // dsh-preset-md 在这里用的是"编进 cwd 的兜底键"（其 core.js:415-424），
        // 理由是它的渲染结果含 `{{cwd}}`，共用一个常量键会串味。我们不同：
        // 索引文本本身按 cwd 解析出不同作用域（`renderMemoryIndex` 收 cwd 参数），
        // 不缓存就等于每次按当前 cwd 重新渲染 —— 语义正确且没有串味风险。
        // 代价只是极少数无 id 场景下多读一次盘，而索引只有一个 MEMORY.md，很便宜。
        if (!freeze || id === undefined) {
          if (id !== undefined) frozenIndex.delete(id)
          return render()
        }

        // 开着冻结 → 只在缓存缺失时渲染一次，之后恒返回缓存。
        // 想刷新就把开关关一下再打开（缓存被清），或直接关掉。
        const cached = frozenIndex.get(id)
        if (cached !== undefined) return cached
        const first = render()
        frozenIndex.set(id, first)
        return first
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
    // 与 tools/routes 同一个基准 —— 否则后台总结会写到另一个记忆根目录。
    dshHome: paths.dshHome,
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
    //
    // agent 销毁时清掉会话状态，别让 Map 无限增长。
    // 索引冻结缓存同理 —— 它在根 ctx 上，这里够得着，一并清掉。
    const id = agent?.id
    if (typeof id === 'string') {
      forgetSession(id)
      frozenIndex.delete(id)
    }
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
