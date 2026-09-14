/**
 * summarize.mjs — 轮末在**后台异步**跑一次独立 LLM 调用，做总结反思并落盘。
 *
 * ## 为什么不是往对话里塞提醒
 *
 * 早先的实现挂在 `agent/turn-stopping`，往主对话的 `inbox` append 一条
 * "Before this turn closes…" 的 user 消息。两个问题：
 *
 * 1. **它显示在对话里**，用户看得见，影响体验；
 * 2. 它逼主模型**再跑一步**，而那一轮的开销与延迟都记在用户账上。
 *
 * 现在改成：轮末起一次**独立的、无工具的** LLM 调用，由它总结本轮做了什么、
 * 有哪些值得沉淀，然后由**插件自己**写文件。主对话全程不参与、不显示任何东西。
 *
 * ## 为什么不是子代理
 *
 * `ctx.subagents.start()` 会创建一个真正的子 agent（有自己的 session、会进会话
 * 列表、能调工具），还会再次触发 `agent/turn-stopping` —— 递归风险。这里只需要
 * 一次模型调用，所以直接用 `ctx.llm.stream()`：官方先例是
 * `@deepseek-ai/dsh-session-title-llm`（后台一次性调用生成标题）。
 *
 * ## 防重复与跨回合补偿
 *
 * 每个会话维护一个**游标**（`summarizedTurns` 的 `doneTurn`）= 最后一次**成功**
 * 总结到的回合。总结范围是「游标之后的所有事件」，**不是「本轮」**。
 *
 * 这样做的原因是真实事故：早先只取最后一个 `turn/start` 起的事件，于是任何
 * 「没写成」的回合（以 error 结束 / 内容不足 / 调用失败）的内容**永久丢失** ——
 * 后面的回合用切片看不到它。日志里出现了 20 分钟的工作空白，一个字都没有。
 *
 * 现在：**游标只在成功后推进**。回合崩了、内容不足、调用失败，游标原地不动，
 * 下一轮自然把这段一起带上。连续失败到 `MAX_SUMMARY_ATTEMPTS` 才放弃这一段
 * （否则一段坏内容会让游标永久卡住）。
 *
 * 后台调用不是 agent，不会再次触发 turn-stopping，所以没有递归。
 */
import { join } from 'node:path'

import { MEMORY_ENTRYPOINT, MEMORY_TYPES } from './codebuddy-port.mjs'
import { journalFileName, resolveScopes } from './context.mjs'
import { readSettings, resolvePaths } from './settings.mjs'
import { appendJournal, appendErrorLog, timeStamp, writeMemory, slugify, isSafeFile } from './store.mjs'

/**
 * 同一段内容连续失败多少次后放弃。
 *
 * 失败时保留游标、下一轮自动回补（见监听器里的说明）。但没有上限的话，
 * 一段永远总结不了的内容（例如 provider 一直报错）会让游标永久卡住，
 * 后面的内容再也总结不到 —— 那比丢掉一段更糟。
 */
export const MAX_SUMMARY_ATTEMPTS = 3

/**
 * 单次后台总结的超时（毫秒）。
 *
 * `llm.stream()` **没有内置超时** —— 官方 `GenerateOptions` 只提供 `signal`，
 * 取消责任在调用方。没有这一层的话，provider 挂起会让 `running` 标志永不复位，
 * **游标从此卡死**，后续所有回合都总结不了（不是丢一段，是从此再也不写）。
 *
 * 取值参考：auto-memory 用 40s 外层 + 90s 内层两层超时。这里取 60s ——
 * 单次总结的输出上限是 4000 token，正常几秒内完成；60s 足够容纳慢网络，
 * 又远短于一个回合的典型时长。
 */
export const SUMMARY_TIMEOUT_MS = 60_000

/**
 * 工具调用提示信息的最大字符数。
 *
 * 只取**定位信息**（路径 / 命令 / 模式），不是原始材料 —— `write` 的 `content`
 * 可能有几 KB，`shell` 的 `command` 也可能很长。截断是为了不让单条工具提示
 * 挤占转写窗口。
 */
export const TOOL_HINT_MAX_CHARS = 160

/**
 * `running` 标志的陈旧上限（毫秒）。
 *
 * 正常情况下 `runSummary` 自带超时，`running` 一定会在 `finally` 复位。
 * 但若真有别的挂起路径（`finally` 之前的同步代码抛错等），没有这一层的话
 * 这个会话的总结会**永久静默失效**。
 *
 * `SUMMARY_TIMEOUT_MS` 兜住 LLM 调用本身，这一层兜住"**任何**挂起路径"——
 * 两者互补，都要有。
 */
export const RUNNING_STALE_MS = 5 * 60_000

/**
 * 每个会话的总结游标。
 *
 * `doneTurn` = 最后一次**成功**总结到的回合；失败时不推进，下一轮自动回补。
 * `running` 防重入（后台调用还没回来时不要并发发起第二次）。
 * `attempts` 记连续失败次数，到 MAX_SUMMARY_ATTEMPTS 就放弃这一段。
 */
const summarizedTurns = new Map()

/**
 * 后台调用的输出上限。
 *
 * 必须留足余量：notes 现在允许 1-3 句（见 SUMMARY_SYSTEM），一轮密集工作可能产出
 * 十几条。**输出被截断 = JSON 不完整 = parseSummary 整体丢弃 = 这一轮的日志和
 * 记忆全丢**（不是少记几条，是全丢）。2000 时余量不足，故提到 4000。
 */
export const MAX_OUTPUT_TOKENS = 4000

export function resetForTest() {
  summarizedTurns.clear()
}

/** agent 销毁时清掉会话状态，别让 Map 无限增长。 */
export function forgetSession(sessionId) {
  summarizedTurns.delete(sessionId)
}

/* ------------------------------------------------------------------ *
 * 取本轮的对话文本
 * ------------------------------------------------------------------ */

/** 从一条消息的 content 里抽出纯文本。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * 取出「某个回合之后」的全部事件。
 *
 * **这是跨回合补偿的关键。** 早先的 `eventsThisTurn()` 只取最后一个
 * `turn/start` 起的事件，于是：只要某轮没能写成日志（回合以 error 结束 /
 * 内容不足 / LLM 调用失败），它的工作就**永久丢失** —— 后面的回合用切片看不到它。
 * 真实事故：20:13→20:33 之间 20 分钟的源码研究与实测，日志里一个字都没有。
 *
 * @param events - 会话事件。
 * @param afterTurn - 只取 turn 号**大于**它的回合；`0` 表示从第一个 `turn/start` 起。
 * @returns 事件切片；没有更新的回合时返回空数组。
 */
function eventsSinceTurn(events, afterTurn) {
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event?.type === 'turn/start' && typeof event.data?.turn === 'number' && event.data.turn > afterTurn) {
      return events.slice(i)
    }
  }
  return []
}

/**
 * 取事件里最后一个 `turn/start` 的轮号。
 *
 * `agent/disposed` 的 payload **没有** `turn`（只有 agent），
 * 所以会话结束路径要从事件里自己找。
 */
function latestTurnOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') return event.data.turn
  }
  return undefined
}

/**
 * 是否是**真人**发言。
 *
 * user 角色的消息不止真人说的这一种：运行时上下文快照（包含本插件注入的
 * `<memory-index>`）、skill 目录、其它插件的通知，全部以 `user/message` 落盘，
 * 要靠 `source.kind` 区分。真实数据里非真人消息比真人消息还多一倍。
 *
 * 不过滤的后果不只是浪费 token：快照里含记忆条目的标题与描述，会被总结模型
 * 当成"用户说过的话"，进而可能据此再写一条重复记忆 —— 自我喂养。
 * 同类插件 dsh-mneme 为此专门做了过滤并配了回归测试。
 *
 * 官方契约里 `source` 是**必填**字段（`@deepseek-ai/dsh-llm` 的 `Message`），
 * 所以这里严格匹配即可；宽容放行反而会漏掉未来新增的插件来源。
 */
export function isHumanMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * 从工具调用的 `arguments` 里抽出**一行关键信息**。
 *
 * 为什么需要：`tool/call` 的 `data` 有 `name` **和** `arguments`
 * （`{ turn, step, callId, name, arguments }`，实测 898/898 都有），
 * 只记 `name` 会让总结模型知道"调了 write"却**不知道写到哪个文件** ——
 * 真实日志里因此出现过「无法确认已写入文档的路径」这种自认无知的句子。
 *
 * 但绝不能塞原始材料（`write` 的 `content` 可能是几 KB）：只取**定位信息**，
 * 且一律截断。取不到就返回空串，退回只记工具名。
 */
function toolCallHint(name, raw) {
  if (typeof name !== 'string' || typeof raw !== 'string') return ''
  let args
  try {
    args = JSON.parse(raw)
  } catch {
    return ''
  }
  if (args === null || typeof args !== 'object') return ''

  // 各工具最关键的定位字段，按优先级取第一个存在的。
  const pick = (...keys) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  let hint
  if (name === 'shell' || name === 'pwsh') {
    hint = pick('command')
  } else if (name === 'grep' || name === 'glob') {
    const pattern = pick('pattern')
    const path = pick('path')
    hint = [pattern && `/${pattern}/`, path].filter(Boolean).join(' in ')
  } else {
    // read / write / edit / 以及其它以文件为主的工具
    hint = pick('file_path', 'path', 'notebook_path', 'query', 'url')
  }

  if (!hint) return ''
  const one = hint.replace(/\s+/g, ' ')
  return one.length > TOOL_HINT_MAX_CHARS ? `${one.slice(0, TOOL_HINT_MAX_CHARS)}…` : one
}

/**
 * 把本轮事件渲染成给总结模型的对话记录。
 *
 * 只取真人发言 / assistant 的文本与工具调用名，不取工具**结果**全文 —— 工具输出
 * 往往是几百行日志，塞进去既贵又无助于"这轮做了什么"的判断。
 *
 * ⚠️ **工具调用提示会去重**：实测一轮里能出现 118 次工具调用、
 * 占转写约 60% 的篇幅（2026-09-14 那个 7 轮会话的第 5 轮就是），
 * 而且大量是同一命令反复跑（`npm test` × 20）。不去重有两个害处：
 *   1. 把真正的对话内容挤出 `maxChars` 窗口；
 *   2. 让总结模型以为"做了很多事"，输出随之变长 → 更容易撞输出上限。
 * 去重时保留**顺序**与**出现次数**（`×N`），信息不丢但篇幅大减。
 */
export function renderTranscript(events, { maxChars = 12000 } = {}) {
  const lines = []
  for (const event of events) {
    if (isHumanMessage(event)) {
      const text = textOfContent(event.data?.content).trim()
      if (text) lines.push(`[用户] ${text}`)
      continue
    }
    if (event?.type === 'assistant/message') {
      // ⚠️ `assistant/message` 的正文在 `data.message.content`，**不是** `data.content`。
      // 官方类型（`dsh-session/lib/types/types.d.ts:309-317`）：
      //   'assistant/message': { turn, step, message: AssistantMessage, stream, usage? }
      // 而 `user/message` 的正文确实在 `data.content` —— 两者**不对称**。
      // 读错字段不会报错，只会让转写里**一条助手发言都没有**（实测 708 条全丢），
      // 于是总结模型只看得到用户说了什么、看不到做了什么与得出了什么结论 ——
      // 这正好抵消了「让日志写结论」的努力。
      const text = textOfContent(event.data?.message?.content).trim()
      if (text) lines.push(`[助手] ${text}`)
      continue
    }
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name !== 'string' || !name) continue
      // 带上定位信息（写到哪个文件 / 跑了什么命令），否则总结模型不知道干了什么。
      const hint = toolCallHint(name, event.data?.arguments)
      lines.push(hint ? `[调用工具] ${name} ${hint}` : `[调用工具] ${name}`)
    }
  }

  // 相邻的同类工具调用合并成一条 —— 只压**连续重复**，不跨消息合并，
  // 否则会打乱"什么时候做了什么"的时序。
  const merged = []
  for (const line of lines) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.text === line) {
      last.count += 1
      continue
    }
    merged.push({ text: line, count: 1 })
  }
  const rendered = merged.map((m) => (m.count > 1 ? `${m.text}  ×${m.count}` : m.text))

  const joined = rendered.join('\n\n')
  // 超长时保留尾部：本轮的结论比开头更值得总结。
  return joined.length <= maxChars ? joined : `…（前文略）\n\n${joined.slice(-maxChars)}`
}

/**
 * 只取「最后一轮」的事件。
 *
 * ⚠️ 为什么必须只取最后一轮：judgement 用的是 `tool/call`，而**累积段**包含
 * 从上次成功总结到现在的所有轮。一旦模型在**任意一轮**调过记忆工具，
 * 那个调用就永远留在累积段里 —— 之后每一轮判据都恒为真，**该会话的后台日志
 * 从此永久停写**。这是实测踩到的真 bug（preset-md 会话第 5 轮调了一次
 * `memory_md_journal`，第 6、7 轮就再也没写过日志）。
 *
 * 切法是找**最后一个 `turn/start`**，从它开始截。不用 `event.data.turn` 判断：
 * 官方类型里 `tool/call` 带 `turn`（`dsh-session/lib/types/types.d.ts:334`），
 * 但 `user/message` 就是 `UserMessage`、**不带** `turn` 字段，混用会漏掉消息。
 */
function lastTurnEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') return events.slice(i)
  }
  return events
}

/**
 * 两个**写**记忆的工具名。
 *
 * 就地写字符串而不是从 `tools.mjs` import：`tools.mjs` 已 import
 * `store.mjs` / `context.mjs`，`summarize.mjs` 再反向 import 会引入循环依赖。
 * 名字必须与 `tools.mjs:41,44` 的 `TOOL_WRITE` / `TOOL_JOURNAL` 保持一致。
 */
const MEMORY_WRITE_TOOLS = new Set(['memory_md_save', 'memory_md_journal'])

/**
 * **本轮**里模型是否**写过**记忆。
 *
 * 只认**写**操作（`memory_md_save` / `memory_md_journal`）。
 * `memory_md_search` / `memory_md_read` 是**只读**的：模型「查过旧记忆」
 * 不等于「本轮的新结论已经沉淀好了」，用它们抑制总结在逻辑上说不通 ——
 * 早先用 `startsWith('memory_md_')` 前缀匹配，把四个工具一视同仁，
 * 于是只读检索也会让这一轮不被总结。
 *
 * 调用方必须传「本轮事件」（见 `lastTurnEvents`），不能传累积段 —— 见上面的说明。
 */
function touchedMemoryThisTurn(events) {
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name === 'string' && MEMORY_WRITE_TOOLS.has(name)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/** 总结模型的人设与输出契约。 */
export const SUMMARY_SYSTEM = [
  '你负责回顾 AI 编码助手刚完成的一段工作，提炼出值得记住的东西。',
  '你没有工具：只回复一个 JSON 对象，别的什么都不要输出。',
  '',
  '严格按这个形状输出：',
  '{',
  '  "notes": ["<这段做了什么，以及得出了什么>"],',
  '  "memories": [',
  '    { "type": "user|feedback|project|reference", "scope": "global|project",',
  '      "name": "<简短标题>", "description": "<一句具体的描述>",',
  '      "content": "<记忆正文>" }',
  '  ]',
  '}',
  '',
  'notes —— 给用户日后回看的工作日志。用**对话所用的语言**写。',
  '每条 1-3 句：说清**做了什么**、以及**得出了什么结论**。**结论是最有价值的部分**。',
  '',
  '⚠️ **保持精简，不要写长**：通常 1-3 条足够，最多 5 条。',
  '输出有长度上限，写太长会被**硬截断**，结果是这一轮什么记录都留不下 ——',
  '宁可少写几条写完整，也不要多写几条被截断。',
  '',
  '值得记的事（这是下限，不是上限；没有就不写）：',
  '- 写了或改了代码、配置、文档 —— 以及这个改动达成了什么',
  '- 修了 bug —— 要写清原因和修法，不能只写「修了个 bug」',
  '- 调查了某件事 —— 发现了什么、决定了什么、为什么',
  '- 选定了一个技术方案，或否决了一个',
  '- 回答了一个需要真功夫才能回答的问题',
  '- 跑了测试或分析 —— 要结果，不要命令',
  '',
  '**不要贴原始材料**：工具输出、搜索结果原文、文件内容、以及任何没真正发生的事。',
  '那些只会把日志撑长，却不增加回看价值。但是 —— **搜索和阅读本身就是工作**：',
  '把它们让你学到的东西记下来，只是别贴原文。',
  '除非用户明确要求，不要记录密钥。',
  '没有任何实质工作时，返回空数组。',
  '',
  'memories —— 给**未来对话**用的持久知识。只在用户说了持久的事时才存：',
  '他是谁、希望你怎样工作、对你的纠正、一个持续中的项目事实、或某样东西在哪找。',
  '**纠正和确认都算** —— 要记原因，不只记结论。',
  '同样要精简：**大多数轮次没有值得长期保留的东西，返回空数组是正常的**，',
  '不要为了"有产出"而凑记忆。',
  '**不要存**：代码写法或文件结构（读仓库就知道）、git 历史、调试配方、临时状态、',
  '以及任何未经验证的东西。除非用户明确要求，不要存密钥。',
  '**宁可返回空数组，也不要编造记忆。**',
  '',
  'feedback/project 类的 content 写成「规则或事实」，然后一行 "**Why:**"、',
  '再一行 "**How to apply:**"。',
  '与本工作区无关的 user/feedback/reference 用 scope "global"；',
  '专属于当前工作区的用 "project"。',
].join('\n')

/* ------------------------------------------------------------------ *
 * 后台调用
 * ------------------------------------------------------------------ */

/**
 * 跑一次总结调用，返回解析后的结果。
 *
 * @returns `{ notes, memories }`，或 undefined（无内容 / 解析失败）。
 */
async function runSummary({ llm, route, transcript, signal, logger }) {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `Review this completed turn:\n\n${transcript}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory-md' },
    },
  ]

  let text = ''
  // 官方流里有 `finish` chunk 带 `reason.kind`（`dsh-llm/lib/types/types.d.ts:107-127`）。
  // `max-tokens` 就是**输出被上限截断**的明确信号 —— 有了它就不必靠"猜 JSON 为什么坏"，
  // 可以直接走抢救路径，并在日志里说清原因。
  let truncated = false
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    system: SUMMARY_SYSTEM,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish' && chunk.reason?.kind === 'max-tokens') truncated = true
  }

  if (truncated) {
    logger?.warn?.(
      `[memory-md] 总结输出撞上 maxTokens=${MAX_OUTPUT_TOKENS} 被截断，尝试抢救已完成部分`,
    )
  }
  return parseSummary(text, logger)
}

/**
 * 从第一个 `{` 起做**括号配平**扫描，返回第一个结构完整的 JSON 对象。
 *
 * 为什么不用 `lastIndexOf('}')`：那会被**尾随解释里的花括号**带偏
 * （模型爱在 JSON 后补一句「说明：见 {}」），切出来的片段不是合法 JSON。
 *
 * 扫描时必须跟踪**字符串状态**与**转义**：`"a}b"` 里的 `}` 不是结构字符，
 * `"\""` 里的引号也不是字符串结束 —— 不处理这两点就会在字符串内容上切错。
 *
 * 截断的输出会扫到结尾仍未配平，此时返回 `''`（调用方再走抢救）。
 */
export function firstBalancedObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 从**被截断**的 JSON 里抢救已经完整的顶层数组元素（尤其是 `notes`）。
 *
 * 场景：输出撞上 `maxTokens` 被硬切断 → 整个 JSON 不合法 → 常规解析全失败。
 * 但 `notes` 往往在 `memories` **之前**，那些已经写完的条目其实完好 ——
 * 对照实验确认过：preset-md 的解析也救不回截断，**没有现成做法可抄，这层是增量**。
 *
 * 做法是**配平扫描**而不是字符串匹配：`]` 可能出现在字符串内容里
 * （例如某条 note 写着 "把 a[0] 改成 b]"），正则或 `indexOf` 会切错位置。
 * 这里自己扫，跟踪字符串与转义状态，只在**结构层**判定数组结束。
 *
 * @returns `{ notes, memories, truncated }` —— 抢救到的内容（可能为空）。
 */
export function salvageTruncatedSummary(text) {
  const source = String(text ?? '')
  const out = { notes: [], memories: [], truncated: false }

  /**
   * 取出某个键对应数组里**已经完整**的顶层元素。
   *
   * 必须同时支持**字符串元素**（`notes` 是 `["...", "..."]`）与**对象元素**
   * （`memories` 是 `[{...}, {...}]`）—— 只按 `{`/`[` 判定起点会漏掉纯字符串数组。
   *
   * 做法：从数组的 `[` 起扫，跟踪字符串与转义状态，在**顶层**（depth === 1）
   * 按逗号切分元素，逐个 `JSON.parse`。扫到结尾仍未闭合 = 又一段被截断，
   * 已切出的完整元素照样保留。
   */
  const collect = (key) => {
    const keyAt = source.indexOf(`"${key}"`)
    if (keyAt < 0) return []
    const openAt = source.indexOf('[', keyAt)
    if (openAt < 0) return []

    const items = []
    const take = (raw) => {
      const trimmed = raw.trim().replace(/,\s*$/, '')
      if (!trimmed) return
      try {
        items.push(JSON.parse(trimmed))
      } catch {
        /* 被截断的尾巴或坏元素 —— 丢掉它，但不影响已收下的 */
      }
    }

    let depth = 1          // 已经站在数组内部
    let inString = false
    let escaped = false
    let itemStart = openAt + 1

    for (let i = openAt + 1; i < source.length; i++) {
      const char = source[i]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') { inString = !inString; continue }
      if (inString) continue

      if (char === '{' || char === '[') { depth += 1; continue }
      if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) {
          // 数组正常闭合：收下最后一个元素，收工。
          take(source.slice(itemStart, i))
          return items
        }
        continue
      }
      if (char === ',' && depth === 1) {
        take(source.slice(itemStart, i))
        itemStart = i + 1
      }
    }

    // 扫到结尾都没闭合 → 输出被截断。把尾巴也试一次（多半解析失败，无害）。
    out.truncated = true
    take(source.slice(itemStart))
    return items
  }

  out.notes = collect('notes').map((n) => String(n ?? '').trim()).filter(Boolean)
  out.memories = collect('memories').filter((m) => m && typeof m === 'object')
  return out
}
/**
 * 解析模型输出。
 *
 * 三层防线，从严格到宽松：
 *   1. 括号配平取**第一个完整对象**（不用 `lastIndexOf('}')` —— 会被尾随解释里的
 *      花括号带偏）；
 *   2. 整体解析失败时，**抢救**已经完整的 `notes` / `memories` 元素 ——
 *      输出撞上 `maxTokens` 被硬切断时，`notes` 往往已经写完，
 *      丢掉整轮日志太可惜（对照实验确认 preset-md 也救不回截断，这层是增量）；
 *   3. 什么都拿不到才算真失败，返回 undefined 让调用方保留游标、下轮重试。
 *
 * @returns `{ notes, memories, salvaged? }`；`salvaged` 为真表示这是从截断输出里抢救的。
 */
export function parseSummary(raw, logger) {
  const text = String(raw ?? '').trim()
  if (!text) return undefined

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1].trim() : text

  // ---- 第一层：括号配平取第一个完整对象 ----
  const balanced = firstBalancedObject(candidate)
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced)
      const notes = Array.isArray(parsed?.notes)
        ? parsed.notes.map((n) => String(n ?? '').trim()).filter(Boolean)
        : []
      const memories = Array.isArray(parsed?.memories)
        ? parsed.memories.filter((m) => m && typeof m === 'object')
        : []
      return { notes, memories }
    } catch {
      /* 配平成功但内容不合法（例如字符串里有裸换行）→ 落到抢救层 */
    }
  }

  // ---- 第二层：从截断的输出里抢救完整元素 ----
  const salvaged = salvageTruncatedSummary(candidate)
  if (salvaged.notes.length > 0 || salvaged.memories.length > 0) {
    logger?.warn?.(
      `[memory-md] 总结输出不完整，已抢救出 ${salvaged.notes.length} 条日志、` +
      `${salvaged.memories.length} 条记忆（其余部分丢弃）`,
    )
    return { notes: salvaged.notes, memories: salvaged.memories, salvaged: true }
  }

  // ---- 第三层：确实什么都拿不到 ----
  logger?.warn?.('[memory-md] 总结输出无法解析，已跳过')
  return undefined
}

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */

/** 四种记忆类型 —— 唯一来源见 `codebuddy-port.mjs` 的 `MEMORY_TYPES`。 */
const TYPES = MEMORY_TYPES

/**
 * 把总结结果写进记忆文件与日志文件。
 *
 * 记忆走 `writeMemory`（正文 + frontmatter + 索引），日志走 `appendJournal`
 * （一天一个文件，按写入时间分批）—— 与 `memory_md_save` / `memory_md_journal`
 * 两个工具用的是同一套原语，格式不会漂移。
 */
export function persistSummary({ result, memoryRoot, scopes, settings, logger }) {
  const written = { memories: 0, notes: 0, journalPath: undefined }

  // ---- 记忆
  for (const memory of result.memories) {
    const type = TYPES.includes(memory.type) ? memory.type : undefined
    if (type === undefined) continue
    const name = String(memory.name ?? '').trim()
    const description = String(memory.description ?? '').trim()
    const content = String(memory.content ?? '').trim()
    if (!name || !description || !content) continue

    // 没有工作区时项目级无处可放 —— 降级成全局，而不是丢掉。
    const wantProject = memory.scope === 'project'
    const dir = wantProject && scopes !== undefined ? scopes.project.dir : join(memoryRoot, 'global')

    const requested = typeof memory.file === 'string' && memory.file.trim() ? memory.file.trim() : undefined
    const file = requested !== undefined && isSafeFile(requested) ? requested : `${type}_${slugify(name)}.md`

    try {
      writeMemory(dir, { file, type, name, description, content })
      written.memories++
    } catch (error) {
      logger?.warn?.(`[memory-md] 后台写记忆失败 ${file}: ${String(error)}`)
    }
  }

  // ---- 日志（仅项目级作用域；一天一个文件，按写入时间分批）
  if (settings.journal === true && result.notes.length > 0 && scopes !== undefined) {
    try {
      const date = journalFileName()
      const stamp = timeStamp()
      const at = appendJournal(scopes.project.journalDir, date, result.notes, stamp)
      if (at !== undefined) {
        written.notes = at.entries
        written.journalPath = at.path
      }
    } catch (error) {
      logger?.warn?.(`[memory-md] 后台写日志失败: ${String(error)}`)
    }
  }

  return written
}

/* ------------------------------------------------------------------ *
 * 监听器
 * ------------------------------------------------------------------ */

/**
 * 组装 `agent/turn-stopping` 的监听器。
 *
 * **立即返回**，真正的活在后台跑（`void ... .then()`）。轮次收尾绝不能被网络
 * 调用拖住，任何失败都必须被吞掉。
 *
 * 返回的函数可直接注册到 `agent/turn-stopping`；另挂一个 `.force(payload)`
 * 供 `agent/disposed` 使用（会话结束必须写一次，绕过防抖）。
 *
 * @param args.getLlm - 惰性读取 `ctx.llm`（注册时可能还没就绪）；返回 undefined 时整个能力静默停用。
 * @param args.getSession - 由 agent 取 session。
 * @param args.isDisabledFor - 预设级停用判断。
 * @param args.defaultRoute - 惰性读兜底 provider/model（读不到 requestHeader 时用）。
 */
export function createTurnStoppingListener({
  getLlm,
  getSession,
  isDisabledFor,
  defaultRoute,
  logger,
  // 可注入仅为测试：生产用默认值。见 SUMMARY_TIMEOUT_MS 的说明。
  summaryTimeoutMs = SUMMARY_TIMEOUT_MS,
  // 同上。
  runningStaleMs = RUNNING_STALE_MS,
}) {
  /**
   * 实际执行一次「总结待处理段」。
   *
   * @param agent - 目标 agent。
   * @param turnHint - 已知的轮号（`turn-stopping` 给得到）；`agent/disposed` 路径没有，
   *   此时从事件里取最后一轮的轮号。
   * @param force - 绕过「内容不足」门槛（会话结束/压缩前用，那是不容错过的时间点）。
   */
  const run = (agent, turnHint, force = false) => {
    try {
      if (agent === undefined) return
      const llm = typeof getLlm === 'function' ? getLlm() : undefined
      if (llm === undefined || typeof llm.stream !== 'function') return

      // 预设级停用：这个 agent 所在的 preset 自带记忆，不该再写全局记忆。
      if (typeof isDisabledFor === 'function' && isDisabledFor(agent) === true) return

      const session = getSession(agent)
      if (session === undefined) return

      const cwd = session?.header?.cwd
      const paths = resolvePaths()
      const settings = readSettings(paths)
      if (settings.enabled !== true) return

      // 双阈值从设置实时读取（可在设置页调）。
      // 读设置而非用常量：门槛是"攒够多少再总结"，因人而异，不该写死在代码里。
      // 坏值由 `normalizeSetting` 回落默认，这里不必再校验。
      const minReviewTurns = settings.minReviewTurns
      const minReviewChars = settings.minReviewChars

      const events = session.ownEvents?.() ?? []
      // `agent/disposed` 没有 turn 号 → 从事件里取最后一轮。
      const turn = typeof turnHint === 'number' ? turnHint : latestTurnOf(events)
      if (turn === undefined) return

      // 游标 = 最后一次**成功**总结到的回合。
      //
      // 为什么不是「本轮是否总结过」：回合可能没写成（以 error 结束、内容不足、
      // 调用失败），那种情况下**不能推进游标**，否则那一轮的工作永久丢失。
      // 保留游标，下一轮自然会把未总结的部分一起带上（跨回合补偿）。
      //
      // ⚠️ 首次见到一个会话时，游标**锚定在上一轮**而不是 0 —— 否则新进程启动后
      // 第一次总结会把整个会话历史（可能几十轮、几 MB）当成"未总结内容"重跑一遍，
      // 重复写日志。跨回合补偿只应覆盖**本进程内**没写成的段落。
      const isFirstSight = !summarizedTurns.has(agent.id)
      const state = summarizedTurns.get(agent.id) ??
        { doneTurn: turn - 1, running: false, runningSince: 0, attempts: 0, pending: false }
      if (isFirstSight) {
        // ⚠️ 必须**原地改**这个对象，不能 `set` 一个新对象再继续用旧引用 ——
        // 那样后续对 `state` 的写入（doneTurn/running）全都落在没人看的旧对象上，
        // Map 里那份永远停在初始值，导致「同一轮重复总结」。
        summarizedTurns.set(agent.id, state)
        state.doneTurn = turn - 1
      }

      // ---- 并发与陈旧锁 ----
      //
      // 正常情况下 `runSummary` 自带超时，`running` 一定会在 finally 复位；
      // 但若真有别的挂起路径（例如 finally 之前的同步代码抛错），
      // 超过 RUNNING_STALE_MS 后允许再次触发，免得这个会话的总结**永久静默失效**。
      if (state.running) {
        if (Date.now() - (state.runningSince || 0) < runningStaleMs) {
          // 还在跑：记下"结束时要补跑一次"，而不是直接丢掉这次机会。
          if (force) state.pending = true
          return
        }
        logger?.warn?.('[memory-md] 上一次总结疑似卡死，强制解锁后重试')
        state.running = false
      }
      if (turn <= state.doneTurn) return // 这一段已经处理过

      // ★ 取「上次成功总结之后」的全部事件，而不只是本轮 —— 这是跨回合补偿的核心。
      const pending = eventsSinceTurn(events, state.doneTurn)
      if (pending.length === 0) return

      // 只数真人发言与助手回复。把注入快照也算进来的话，一轮
      // 「真人说一句 + 助手答一句」会被数成 3~4 条而虚过门槛。
      const messages = pending.filter(
        (e) => isHumanMessage(e) || e?.type === 'assistant/message',
      )
      // 双阈值：消息条数**或**内容字符数达标即可。
      // 条数管"有没有实质往来"，字符数管"单条很长也算实质内容"。
      // 都不足 → **不推进游标**，留给下一轮回补（短回合不再造成永久空洞）；
      // 但 force 路径（会话结束/压缩前）不受此限 —— 那是最后的机会。
      const messageCount = messages.length
      const charCount = pending.length === 0 ? 0 : renderTranscript(pending).length
      const enough = messageCount >= minReviewTurns || charCount >= minReviewChars
      if (!enough && !force) return

      // 主模型**本轮**写过记忆 → 它自己处理过了，不重复。
      // 这是「确实处理过」，所以**推进游标**，免得下一轮重复总结。
      //
      // ⚠️ 必须只传「本轮事件」：`pending` 是**累积段**（上次成功总结到现在），
      // 一旦模型在任意一轮写过记忆，那个调用就永远留在里面 —— 判据此后恒为真，
      // 每次总结都被跳过而游标还被推进，**该会话的后台日志从此永久停写**。
      // 这正是真实事故：preset-md 会话第 5 轮调了一次 `memory_md_journal`，
      // 第 6、7 轮就再也没写过日志。
      if (touchedMemoryThisTurn(lastTurnEvents(pending))) {
        state.doneTurn = turn
        return
      }

      const transcript = renderTranscript(pending)
      if (!transcript.trim()) return

      // 路由：优先用本会话最近一次真实请求的 provider/model。
      const header = session?.requestHeader?.()
      const fallback = typeof defaultRoute === 'function' ? defaultRoute() : defaultRoute
      const route = header?.config?.provider && header?.config?.model
        ? { provider: header.config.provider, model: header.config.model }
        : fallback
      // 拿不到路由 → 不推进游标，下一轮重试。
      if (route === undefined || !route.provider || !route.model) {
        logger?.warn?.('[memory-md] 拿不到 provider/model，后台总结跳过（下轮重试）')
        appendErrorLog(paths.errorLogFile, `拿不到 provider/model，轮 ${state.doneTurn}→${turn} 未总结（下轮重试）`)
        return
      }

      const scopes = cwd === undefined ? undefined : resolveScopes({ cwd, dshHome: paths.dshHome })
      const fromTurn = state.doneTurn
      state.running = true
      state.runningSince = Date.now()

      // 后台跑：立刻返回，不阻塞轮次收尾。
      void (async () => {
        let ok = false
        // ★ 超时兜底：`llm.stream()` **没有内置超时**（官方 `GenerateOptions` 只有
        //   `signal`，由调用方负责取消）。没有这一层的话，provider 挂起会让
        //   `running` 永不复位 —— 游标从此卡死，后续所有回合都总结不了。
        //   auto-memory 为同一原因包了 40s 外层 + 90s 内层两层超时。
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('summary timeout')), summaryTimeoutMs)
        try {
          const result = await runSummary({ llm, route, transcript, logger, signal: controller.signal })
          if (result !== undefined) {
            if (result.notes.length > 0 || result.memories.length > 0) {
              const written = persistSummary({
                result,
                memoryRoot: paths.memoryRoot,
                scopes,
                settings,
                logger,
              })
              logger?.info?.(
                `[memory-md] 轮 ${fromTurn}→${turn} 后台总结：写记忆 ${written.memories} 条、日志 ${written.notes} 条`,
              )
            }
            // 解析成功（哪怕是空数组）就算处理过这一段。
            ok = true
          } else {
            appendErrorLog(
              paths.errorLogFile,
              `轮 ${fromTurn}→${turn} 总结输出无法解析（JSON 不完整或格式错误），下轮重试`,
            )
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          logger?.warn?.(`[memory-md] 后台总结失败（下轮重试）: ${detail}`)
          // 详细错误写独立错误日志（与 settings.json 同层），**不写进 .journal**
          // —— 日记是"今天做了什么"的叙事，塞错误会污染它。
          appendErrorLog(paths.errorLogFile, `轮 ${fromTurn}→${turn} 总结失败：${detail}（下轮重试）`)
        } finally {
          clearTimeout(timer)
          // 失败时**保留游标**，下一轮自动回补这段内容。
          // 但不能无限重试：连续失败到上限就放弃这一段，免得永远卡在同一处。
          const attempts = ok ? 0 : state.attempts + 1
          const giveUp = !ok && attempts >= MAX_SUMMARY_ATTEMPTS
          if (giveUp) {
            logger?.warn?.(
              `[memory-md] 轮 ${fromTurn}→${turn} 连续 ${attempts} 次失败，放弃这段（避免卡死）`,
            )
            appendErrorLog(
              paths.errorLogFile,
              `轮 ${fromTurn}→${turn} 连续 ${attempts} 次失败，已放弃这一段（避免游标永久卡死）`,
            )
          }
          state.doneTurn = ok || giveUp ? turn : fromTurn
          state.running = false
          state.runningSince = 0
          state.attempts = attempts

          // ---- 待补跑 ----
          // 这次跑的时候会话结束过（force 被 `running` 挡下）→ 现在补跑一次。
          // 不复位 pending 的话这次机会就永久丢了。
          if (state.pending) {
            state.pending = false
            run(agent, turn, true)
          }
        }
      })()
    } catch (error) {
      // 触发失败绝不能影响轮次收尾。
      logger?.warn?.(`[memory-md] turn-stopping 检查失败: ${String(error)}`)
    }
  }

  const handler = (payload) => run(payload?.agent, payload?.turn, false)
  /** 会话结束/压缩前：绕过门槛与防抖，确保最后一段一定被写。 */
  handler.force = (payload) => run(payload?.agent ?? payload, undefined, true)
  return handler
}

export { MEMORY_ENTRYPOINT }
