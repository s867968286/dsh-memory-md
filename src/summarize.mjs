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
import {
  appendJournal,
  appendErrorLog,
  formatMemoryManifest,
  scanMemoryManifest,
  normalizeMemoryFile,
  resolveMemoryFile,
  timeStamp,
  writeDiagnosticDump,
  writeMemory,
} from './store.mjs'

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
  '      "content": "<记忆正文>", "file": "<可选：要覆盖的已有文件名>" }',
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
  '',
  '⚠️ `name` 只写**标题本身**：不要带 type 前缀（不要写 `feedback_xxx`），',
  '也不要带 `.md` 后缀 —— 前缀与扩展名由插件自己加。',
  '写成 `feedback_xxx.md` 会派生出 `feedback_feedback_xxx_md.md` 这种文件名，',
  '并且让同一件事变成两条互相看不见的记忆。',
  '',
  '⚠️ **消息末尾会附一份「已有的记忆」清单**（如果记忆库非空）。**写之前先看它**：',
  '清单里已经有同一件事的条目 → 把那一行的**文件名**填进 `file` 字段覆盖更新，',
  '而不是新写一条。清单为空或没有相关的 → 才新写（新写时**省略 `file`**）。',
  '这是避免写出重复记忆的唯一依据 ——',
  '你**看不到**这些记忆的正文，只能看到文件名与描述。',
  '',
  '🚨 **`file` 填错会毁掉一条记忆，必须严格执行**：',
  '- 每一行清单都带作用域前缀：`[global]` 或 `[project]`。',
  '  **只能抄和你这次要写的那条同一个作用域的行** —— 你要写 `scope: "project"`，',
  '  就只准从 `[project]` 行里挑；写 `global` 就只准从 `[global]` 行里挑。',
  '- **只有当描述说的确实是同一件事**时才填 `file`。只是"名字沾边"、"主题相近"',
  '  不算 —— **拿不准就省略 `file`**，宁可多一条能在索引里看见的重复，',
  '  也不要顶掉一条你看不见正文的记忆。',
  '- `file` 只填**文件名本身**（如 `feedback_testing.md`），**不要带目录前缀**：',
  '  写 `memory/feedback_testing.md` 会另存成一条新记忆，正是我们要避免的重复。',
  '注意：这段对话里可能出现的 `<memory-index>` 块也是**已有记忆的索引**，',
  '不是用户说过的话 —— 不要因为在那里见过某个说法就再存一条。',
  '拿不准某件事是不是已经记过了，就**不要写** —— 宁可漏记，也不要重复记。',
  '',
  '**不要存**：代码写法或文件结构（读仓库就知道）、git 历史、调试配方、临时状态、',
  '以及任何未经验证的东西。除非用户明确要求，不要存密钥。',
  '**宁可返回空数组，也不要编造记忆。**',
  '**即使用户明确要求存，上面这几类也不该原样存** —— 若用户让你记一份 PR 列表或',
  '活动汇总，问一句其中**哪一点是反直觉的、从代码里看不出来的**，那才值得留。',
  '',
  '**按主题组织，不要按时间堆**：一条记忆应当是一个独立成立的主题，',
  '而不是"这段时间发生了什么"。',
  '',
  '**相对日期一律转成绝对日期**（用户说"周四" → 写成具体日期），',
  '否则这条记忆过一阵就读不懂了。',
  '',
  '**四种类型要选对**（选错会让这条记忆日后搜不到）：',
  '- `user` —— 用户是谁：角色、目标、职责、知识背景。用来把回答调整到适合这个人。',
  '- `feedback` —— 用户对"该怎么做事"的指示。**纠正和认可都要记**：',
  '  只记纠正会让你回避过去的错误，却偏离用户已认可的做法，变得过度保守。',
  '- `project` —— 本工作区里代码和 git 看不到的事：谁在做什么、为什么、何时。',
  '- `reference` —— 外部系统的入口：东西在哪找（不要抄外部内容，只记指针）。',
  '',
  'feedback/project 类的 content 写成「规则或事实」，然后一行 "**Why:**"、',
  '再一行 "**How to apply:**"。',
  '',
  '**description 要短**：一行、约 150 字以内 —— 它会被原样放进记忆索引，',
  '而索引是整份加载进上下文的，写长了会挤占后面的条目。',
  '只写「什么场景下这条用得上」，细节留在 content 里。',
  '与本工作区无关的 user/feedback/reference 用 scope "global"；',
  '专属于当前工作区的用 "project"。',
].join('\n')

/* ------------------------------------------------------------------ *
 * 后台调用
 * ------------------------------------------------------------------ */

/**
 * 汇总两个作用域的已有记忆，渲染成一段给后台模型看的清单。
 *
 * **为什么要合并两个作用域**：后台总结可能往 global 写（跨项目的偏好），
 * 也可能往 project 写（本工作区的事）。只给一份清单，它就没法判断
 * "另一边的库里是不是已经有类似的了"。
 *
 * 每行都带作用域前缀（`global/` `project/`），因为模型需要知道
 * 「要覆盖这一条，该往哪个 scope 写」。
 *
 * @returns 渲染好的清单文本；两边都没有记忆时返回空串。
 */
function memoryManifestFor(paths, scopes) {
  const sections = []

  const globalManifest = scanMemoryManifest(join(paths.memoryRoot, 'global'))
  const globalText = formatMemoryManifest(globalManifest)
  if (globalText) {
    sections.push(...globalText.split('\n').map((l) => `[global] ${l}`))
  }

  if (scopes !== undefined) {
    const projectManifest = scanMemoryManifest(scopes.project.dir)
    const projectText = formatMemoryManifest(projectManifest)
    if (projectText) {
      sections.push(...projectText.split('\n').map((l) => `[project] ${l}`))
    }
  }

  return sections.join('\n')
}

/**
 * 跑一次总结调用，返回解析后的结果。
 *
 * ## `manifest` 是防重复的机械保障
 *
 * 这个模型**看不到记忆库**（独立调用，不共享主对话上下文），所以光叮嘱它
 * 「别写重复的」是没用的 —— 它无从知道已经有什么。把已有条目清单
 * （`formatMemoryManifest()`）放进 user 消息，它才有判断依据。
 *
 * 这是吸收 CodeBuddy `buildExtractPrompt()` 的做法：那边把
 * `formatMemoryManifest(scanMemoryFiles(dir))` 的结果作为
 * "## Existing memory files" 一节喂给抽取子代理。
 *
 * @returns `{ notes, memories }`，或 undefined（无内容 / 解析失败）。
 */
async function runSummary({ llm, route, transcript, existingMemories, signal, logger }) {
  // `existingMemories` 是**已经渲染好的清单文本**（见 `memoryManifestFor()`），
  // 不是 manifest 对象 —— 那边已经把两个作用域合并并加好 scope 前缀。
  const suffix = existingMemories
    ? '\n\n## 已有的记忆（写之前先看这里，能改就改，别新建重复的）\n\n' + existingMemories
    : ''

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `Review this completed turn:\n\n${transcript}${suffix}` }],
      source: { kind: 'plugin', plugin: 'dsh-memory-md' },
    },
  ]

  let text = ''
  // 官方流里有 `finish` chunk 带 `reason.kind`（`dsh-llm/lib/types/types.d.ts:107-127`）。
  // `max-tokens` 就是**输出被上限截断**的明确信号 —— 有了它就不必靠"猜 JSON 为什么坏"，
  // 可以直接走抢救路径，并在日志里说清原因。
  let truncated = false
  // 除了 `max-tokens`，另两种终态也要留下：`error` / `aborted` 意味着这次调用
  // 根本没跑完，输出为空或半截 —— 与"模型输出了坏 JSON"是**完全不同**的故障，
  // 只看"无法解析"会把两者混为一谈。
  //
  // ⚠️ 光记 `kind` **不够**：官方契约里 `error` / `aborted` 的 finish reason
  // **必带 `failure`**（`dsh-llm/lib/types/types.d.ts` 的 `FinishReasonMap`：
  // `{ kind: 'error', failure: LlmFailure }`），里面有 `message` / `code` /
  // `status` / `requestId` —— 那才是"为什么失败"的答案。
  //
  // 真实教训（2026-10-12）：第一版埋点只记了 `finish error`，于是诊断文件里
  // 写着「终态 error、原文 0 字符」，却**说不出是限流、超时还是鉴权失败**，
  // 排查到这一步又卡住。官方 `dsh-session-title-llm` 的 `finishError()` 在
  // `error`/`aborted` 时直接 `throw new Error(failure.message)` 并挂上
  // `code`（lib/index.js:161-174）—— 它不吞这个信息，我们也不该吞。
  let finishKind
  let failure
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    // ⚠️ **必须带上**，否则 pi-ai 会回落到 profile 级 reasoning
    // （`dsh-llm-pi-ai/lib/index.js:1847`：`options.reasoningEffort ?? profile.reasoning`），
    // 用的就不是主对话那个级别了 —— 真实事故里这直接导致上游 400／code 11150。
    // `route` 已从 `requestHeader().config` 照抄了该字段（见调用点的说明）。
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
    messages,
    system: SUMMARY_SYSTEM,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') {
      finishKind = chunk.reason?.kind
      if (chunk.reason?.kind === 'max-tokens') truncated = true
      else if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        failure = chunk.reason.failure
      }
    }
  }

  if (truncated) {
    logger?.warn?.(
      `[memory-md] 总结输出撞上 maxTokens=${MAX_OUTPUT_TOKENS} 被截断，尝试抢救已完成部分`,
    )
  }
  // 把原文与终态一并交回调用方：解析失败时要靠它们写诊断转储。
  // 这里**不再只返回解析结果** —— 那样原文就丢了，正是排查卡住的原因。
  return {
    result: parseSummary(text, logger),
    raw: text,
    truncated,
    finishKind,
    failure,
  }
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
  //
  // ⚠️ 这里**只报"拿不到"，不猜原因**。早先这句写的是
  // 「总结输出无法解析（JSON 不完整或格式错误）」—— 括号里那句是**凭空的因果
  // 断言**：调用可能压根没产出任何内容（finish error / 被中止 / 模型只出了推理），
  // 那时根本不存在"JSON"。真实事故（2026-10-12）里 93 行日志全是这句，
  // 它把人一路带向"调大 maxTokens / 改解析器"，而真因是调用失败。
  // 分类与措辞交给 `classifyParseFailure()`，那里能看到 finish 终态。
  logger?.warn?.('[memory-md] 总结输出未取得可解析内容，已跳过')
  return undefined
}

/**
 * 把「解析拿不到结果」**按实情**分类。
 *
 * ## 为什么必须分类，而不是一句"无法解析"
 *
 * `parseSummary` 返回 undefined 只是说"没拿到东西"，它对**为什么**一无所知：
 * 调用可能失败了、可能被截断、可能输出为空、也可能是真的格式错。这四种的排查
 * 方向与修法完全不同。早先把它们统一写成「JSON 不完整或格式错误」，于是：
 *
 *   - 真因是调用失败时，那句话会把人引向"调大 `MAX_OUTPUT_TOKENS`"死路
 *     （真实事故 2026-10-12：93 行日志、排查绕了两轮）；
 *   - 光看日志**无法区分**这四种，因为没有一行记录了 finish 终态与原文长度。
 *
 * 判定顺序有意为之：**调用失败优先**。因为 `error`/`aborted` 时必然没有完整
 * 输出，若先判"输出为空"或"无法解析"，就会把调用失败降格成格式问题 ——
 * 那正是原来的毛病。
 *
 * @returns `{ slug, label }`：`slug` 进诊断文件名（便于按类型筛文件名），
 *   `label` 是给人读的一句话。
 */
export function classifyParseFailure({ raw, truncated, finishKind, failure }) {
  // ① 调用失败 / 被中止：一个字都不该有，先认这个。
  if (failure !== undefined || finishKind === 'error' || finishKind === 'aborted') {
    const aborted = finishKind === 'aborted'
    return {
      slug: 'summary-call-failed',
      label: aborted ? '总结调用被中止（未产出内容）' : '总结调用失败（未产出内容）',
    }
  }
  // ② 撞输出上限：有内容但不完整，且抢救也没捞到完整条目。
  if (truncated) {
    return {
      slug: 'summary-truncated',
      label: '总结输出撞上 maxTokens 被截断，且未抢救出任何完整条目',
    }
  }
  // ③ 调用正常结束，但模型没给正文。注意这与 ① 不同：`stop` 但空输出是
  //    **模型行为**（可能只出了推理），不是链路故障。
  if (String(raw ?? '').trim() === '') {
    return { slug: 'summary-empty-output', label: '总结输出为空（调用正常结束但无正文）' }
  }
  // ④ 确实有内容、确实不是合法 JSON —— 只有这一种才配得上"格式错误"的措辞。
  return {
    slug: 'summary-unparsable',
    label: '总结输出无法解析（有内容但不是合法 JSON）',
  }
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

    // 文件名：显式给 `file`（覆盖更新）时先**归一化** —— 与 `tools.mjs` 用同一个
    // 函数。这里曾经只用裸 `isSafeFile()`，于是模型从主对话的 `<memory-index>`
    // 里抄到 `memory/xxx.md`（带目录前缀，索引里就是这个形式）时会被拒，
    // 然后静默回落到派生文件名 —— **同一件事变成两条记忆**。
    // 归一化的理由与工具侧完全一样（见 store.mjs 的 `normalizeMemoryFile`）。
    const requested = typeof memory.file === 'string' && memory.file.trim()
      ? normalizeMemoryFile(memory.file)
      : undefined
    // 派生文件名要走防撞车逻辑：不同标题可能派生出同一个 slug，
    // 直接覆盖会把上一条记忆整条抹掉。
    const file = resolveMemoryFile(dir, { requested, type, name })

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
  // 记忆根目录的解析基准。由 Host 半传 config.dshHome —— 与 tools/routes 同源，
  // 否则后台总结会写到与工具不同的目录（见 run() 内的说明）。
  dshHome,
  // 取 preset id。**由 Host 半注入**：`presetOf()` 住在 `index.js`，它要折叠
  // 会话事件流（`agent-preset/selected`）再回落 header，逻辑不小且已有单一实现；
  // 在这里重写一份迟早与停用判据漂移。只用于诊断输出，取不到就是 undefined。
  presetOf,
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
      // ⚠️ 必须收 `dshHome` —— profile 可以显式传一个与 `DSH_HOME` 环境变量
      // 不同的目录。无参调用会让后台总结读写 A 目录，而工具与路由读写 B 目录，
      // 表现为"手动存得进、后台总结看不见"。四个调用点必须解析到同一个根。
      const paths = resolvePaths(dshHome)
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
      // 转写只算一次：下面真正发总结用的是同一段（同参数），曾经算两遍。
      const transcript = renderTranscript(pending)
      const charCount = transcript.length
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

      if (!transcript.trim()) return

      // 路由：优先用本会话最近一次真实请求的 provider/model。
      //
      // ⚠️ **必须连同 `reasoningEffort` 一起取**，不能只取 provider/model。
      // 请求头里的 config 是官方 `LlmCallConfig`（`dsh-llm/lib/types/call-config.d.ts`），
      // 除 provider/model 外还带 `reasoningEffort` / `temperature` / `maxTokens` / `stop`，
      // 且**逐字段 1:1 映射**到 `GenerateOptions` —— 官方 loop 就是照这份 header
      // 构造请求的（该文件顶部注释：*"the loop builds requests from the logged
      // header rather than accepting these per call"*）。
      //
      // 只取两个字段的后果不是"少传一个可选参数"，而是**静默换了来源**：
      // pi-ai 对 undefined 的 `reasoningEffort` 会回落到 **profile 级**的
      // （`dsh-llm-pi-ai/lib/index.js:1847`：`options.reasoningEffort ?? profile.reasoning`），
      // 于是后台调用用的级别与主对话不是同一个。真实事故（2026-10-12）：
      // 主对话显式传 `high` 一直正常，而后台调用回落到 profile 的值，
      // 被上游拒绝 —— 400 / code 11150
      // 「the reasoning effort value is not supported by the current model」。
      //
      // 主对话**能跑通**这件事本身就是最强的证据：照抄它的参数不会更差。
      const header = session?.requestHeader?.()
      const fallback = typeof defaultRoute === 'function' ? defaultRoute() : defaultRoute
      const config = header?.config
      const route = config?.provider && config?.model
        ? {
            provider: config.provider,
            model: config.model,
            // 逐个可选字段照搬 —— 有就带、没就不带，不自己编造默认值。
            ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort
              ? { reasoningEffort: config.reasoningEffort } : {}),
            ...(typeof config.temperature === 'number' ? { temperature: config.temperature } : {}),
            ...(typeof config.stop !== 'undefined' ? { stop: config.stop } : {}),
          }
        : fallback
      // 拿不到路由 → 不推进游标，下一轮重试。
      if (route === undefined || !route.provider || !route.model) {
        logger?.warn?.('[memory-md] 拿不到 provider/model，后台总结跳过（下轮重试）')
        appendErrorLog(paths.errorLogFile, `拿不到 provider/model，轮 ${state.doneTurn}→${turn} 未总结（下轮重试）`)
        return
      }

      const scopes = cwd === undefined ? undefined : resolveScopes({ cwd, dshHome: paths.dshHome })
      // 已有记忆清单 —— 给后台模型判断"是不是已经有类似的了"。
      // 它看不到记忆库（独立调用，不共享主对话上下文），没有这份清单就只能靠猜。
      // 两个作用域都给：它可能写 global，也可能写 project。
      const existingMemories = memoryManifestFor(paths, scopes)
      const fromTurn = state.doneTurn
      state.running = true
      state.runningSince = Date.now()

      // ---- 诊断上下文：失败时随原文一起落盘 ----
      //
      // 为什么在这里算好而不是失败时现取：`runSummary` 是 await 出去的，
      // 回来时 `agent` / `session` 可能已经随会话销毁而取不到了（`agent/disposed`
      // 之后正是这种时序）。而"哪个会话、哪个模型、第几轮"恰恰是排查的第一入口。
      const sessionId = typeof session?.id === 'string' ? session.id : undefined
      const presetId = typeof presetOf === 'function' ? presetOf(session) : undefined
      const diagContext = [
        `时间        ${new Date().toISOString()}`,
        `会话        ${sessionId ?? '(未知)'}`,
        `工作区      ${cwd ?? '(未知)'}`,
        `preset      ${presetId ?? '(未知)'}`,
        `轮次        ${fromTurn}→${turn}`,
        // 合并写一行（而不是只留下面拆开的两行）：诊断目录里要按模型横向
        // 统计"哪个模型老失败"时，分开的行 grep 不到 `provider/model` 这个串。
        // 与 error.log 里的写法保持一致，两处可以直接对着看。
        `路由        ${route.provider}/${route.model}`,
        `provider    ${route.provider}`,
        `model       ${route.model}`,
        // 排查 400「reasoning effort 不被支持」时这条是**第一现场**：
        // 它同时说明了"用了哪个级别"与"级别是从哪来的"（照抄主对话 vs 回落）。
        `思考级别    ${route.reasoningEffort ?? '(未指定 → 由适配器回落 profile 值)'}`,
        `maxTokens   ${MAX_OUTPUT_TOKENS}（插件硬编码上限）`,
        `转写字符数  ${transcript.length}`,
        `已有记忆清单字符数 ${existingMemories.length}`,
      ].join('\n')

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
          const { result, raw, truncated, finishKind, failure } = await runSummary({
            llm, route, transcript, existingMemories, logger, signal: controller.signal,
          })
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
            // ⚠️ 措辞必须**按实情分类**，不能写死一句因果断言。
            //
            // 早先这里无条件写「总结输出无法解析（JSON 不完整或格式错误）」，
            // 而括号里那句是凭空断言的因果 —— 实测最常见的其实是**调用失败**
            // （finish error、原文 0 字符），那时压根不存在 JSON，更没有"格式"。
            // 这句话把排查引向了"调大 MAX_OUTPUT_TOKENS"的死路。
            //
            // `failure` 是 `error`/`aborted` 终态里的官方失败详情
            // （`{ message, code, status, providerRetryAfterMs, requestId }`），
            // 必记：光知道"调用没成"分不清限流 / 超时 / 鉴权。
            const kind = classifyParseFailure({ raw, truncated, finishKind, failure })
            const failureLine = failure === undefined
              ? ''
              : `\n失败详情   code=${failure.code ?? '(无)'}` +
                `\n           message=${failure.message ?? '(无)'}` +
                (failure.status !== undefined ? `\n           status=${failure.status}` : '') +
                (failure.providerRetryAfterMs !== undefined
                  ? `\n           retryAfter=${failure.providerRetryAfterMs}ms` : '') +
                (failure.requestId !== undefined ? `\n           requestId=${failure.requestId}` : '')
            const dump = writeDiagnosticDump(paths.diagnosticsDir, {
              sessionId,
              summary: kind.slug,
              context: `${diagContext}\n判定       ${kind.label}` +
                `\nfinish 终态 ${finishKind ?? '(未收到 finish chunk)'}` +
                `${failureLine}\n` +
                `截断标记   ${truncated ? '是（撞上 maxTokens）' : '否'}\n` +
                `原文长度   ${raw.length} 字符`,
              raw,
            })
            appendErrorLog(
              paths.errorLogFile,
              `轮 ${fromTurn}→${turn} ${kind.label}，下轮重试` +
              `｜模型 ${route.provider}/${route.model}｜会话 ${sessionId ?? '未知'}` +
              `｜finish ${finishKind ?? '无'}｜截断 ${truncated ? '是' : '否'}｜原文 ${raw.length} 字符` +
              // 失败详情进 error.log 的那一行也要带上 —— 它才是人工第一眼看的地方，
              // 让人为了看一个 code 还得去开诊断文件是说不过去的。
              (failure !== undefined
                ? `｜失败 ${failure.code ?? '?'}: ${String(failure.message ?? '').slice(0, 200)}` +
                  (failure.status !== undefined ? `（HTTP ${failure.status}）` : '')
                : '') +
              (dump !== undefined ? `｜诊断 ${dump}` : '｜诊断转储失败'),
            )
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          logger?.warn?.(`[memory-md] 后台总结失败（下轮重试）: ${detail}`)
          // 详细错误写独立错误日志（与 settings.json 同层），**不写进 .journal**
          // —— 日记是"今天做了什么"的叙事，塞错误会污染它。
          // 抛错路径没有模型输出可存，但会话/模型/轮次同样要记 —— 否则事后
          // 分不清"是 provider 挂了"还是"模型输出了坏 JSON"。
          appendErrorLog(
            paths.errorLogFile,
            `轮 ${fromTurn}→${turn} 总结失败：${detail}（下轮重试）` +
            `｜模型 ${route.provider}/${route.model}｜会话 ${sessionId ?? '未知'}`,
          )
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
