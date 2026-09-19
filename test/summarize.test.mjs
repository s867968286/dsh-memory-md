/**
 * summarize.test.mjs — 轮末**后台异步总结**的行为验证。
 *
 * 取代旧的 `remind.test.mjs`。旧实现往主对话 `inbox.append('next-step')` 塞一条
 * 提醒消息，会**显示在对话里**；新实现改成起一次独立 LLM 调用，由它总结后
 * 直接落盘。这个测试盯住三件事：
 *
 * 1. **绝不往对话里塞任何消息**（这是本次改动的全部理由）；
 * 2. 后台调用真的被触发，且把记忆与日志写对了地方；
 * 3. 各种不该触发的场景（消息太少 / 本轮已写过记忆 / 开关关闭 / 预设停用）
 *    都不触发，且异常绝不到轮次收尾。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-summarize-${process.pid}`)
process.env.DSH_HOME = SANDBOX

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}\n       actual:   ${a}\n       expected: ${e}`)
  }
}

const CWD = 'D:\\proj'
const { createTurnStoppingListener, resetForTest, renderTranscript, parseSummary, isHumanMessage, SUMMARY_SYSTEM, MAX_OUTPUT_TOKENS, MAX_SUMMARY_ATTEMPTS } = await import(
  '../src/summarize.mjs'
)
const { writeSettings, resolvePaths } = await import('../src/settings.mjs')
const { resolveScopes } = await import('../src/context.mjs')

const paths = resolvePaths(SANDBOX)
const scopes = resolveScopes({ cwd: CWD, dshHome: paths.dshHome })

/** 让后台的 `void async` 跑完。 */
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5))
}

/* ---------- 假件 ---------- */

const appended = []
const llmCalls = []

/** 模型回答：一条 note + 一条 memory。 */
const REPLY = JSON.stringify({
  notes: ['定位到 journal 从未自动触发'],
  memories: [
    {
      type: 'feedback',
      scope: 'global',
      name: '不要拿插件文档当需求真源',
      description: '需求真源是用户，不是被讨论对象的 README',
      content: '**Why:** 文档是实现期产物。\n\n**How to apply:** 先读设计文件。',
    },
  ],
})

/**
 * 假 LLM。
 *
 * `truncate: true` 模拟**输出撞上 maxTokens 被硬截断**：官方流里会有一个
 * `finish` chunk 且 `reason.kind === 'max-tokens'`
 * （`@deepseek-ai/dsh-llm/lib/types/types.d.ts:107-127`），同时产出**半截 JSON**。
 * 这条路径是为真实事故加的（见 summarize.mjs 的 max-tokens 观测），
 * 早先零测试覆盖 —— 只加观测代码不加测试，下次没人知道它还在不在工作。
 */
function makeLlm({ reply = REPLY, fail = false, hang = false, truncate = false } = {}) {
  return {
    stream(options) {
      llmCalls.push(options)
      return (async function* () {
        if (fail) throw new Error('provider exploded')
        if (hang) {
          // 模拟 provider 挂起：一直不产出，直到 signal 被 abort（真实实现必须
          // honor options.signal —— 官方 LlmAdapter 契约里明确要求）。
          await new Promise((resolve, reject) => {
            if (options?.signal?.aborted) return reject(options.signal.reason ?? new Error('aborted'))
            options?.signal?.addEventListener('abort', () => {
              reject(options.signal.reason ?? new Error('aborted'))
            }, { once: true })
            // 兜底：没有 signal 就永远挂着（测试会因此超时失败，正是我们要防的）
          })
          return
        }
        if (truncate) {
          // 半截 JSON：notes 写完、memories 断在半路。
          const half = '{"notes":["抢救回来的一条"],"memories":[{"type":"project","name":"半截'
          yield { type: 'text-delta', index: 0, text: half }
          // 官方 finish reason 是对象（`{ kind: 'max-tokens' }`），不是字符串。
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: reply }
        // 官方 finish reason 是对象形态；早先这里写的是字符串 'stop'，与契约不符。
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 假 session：header + ownEvents + requestHeader。 */
function makeSession(events, agentPreset = 'standard') {
  return {
    header: { cwd: CWD, agentPreset },
    ownEvents: () => events,
    requestHeader: () => ({ config: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }),
  }
}

/**
 * 本轮有往来的事件序列。
 *
 * ⚠️ 夹具必须照抄**真实结构**，否则测不出字段路径 bug：
 *   - `user/message`   → 正文在 `data.content`（+ 必填的 `source`）
 *   - `assistant/message` → 正文在 `data.message.content`（官方 types.d.ts:309-317）
 * 这两者**不对称**。早先夹具把 assistant 正文也写成 `data.content`，
 * 于是代码里同样的错误写法能通过测试 —— 而线上 708 条助手发言一条都读不到。
 */
const turnEvents = (turn, extra = []) => [
  { type: 'turn/start', data: { turn } },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '帮我看下这个问题' }], source: { kind: 'user' } },
  },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我看完了' }] } } },
  ...extra,
]

let session = makeSession([])
let llm = makeLlm()

const agent = {
  id: 's1',
  // 旧实现就是往这里 append，从而把提醒显示在对话里。
  // 现在必须**一次都不被调用**。
  inbox: { append: (target, message) => appended.push({ target, message }) },
}

const listener = createTurnStoppingListener({
  getLlm: () => llm,
  getSession: () => session,
  isDisabledFor: () => false,
  logger: { warn: () => {}, info: () => {} },
})

try {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(paths.memoryRoot, { recursive: true })

  console.log('\n纯函数：本轮对话渲染')
  {
    const text = renderTranscript(turnEvents(1))
    check('含用户消息', text.includes('帮我看下这个问题'), true)
    check('含助手消息', text.includes('我看完了'), true)
    check('含工具调用名', renderTranscript(turnEvents(1, [{ type: 'tool/call', data: { name: 'read' } }])).includes('[调用工具] read'), true)
    check('超长时保留尾部', renderTranscript(turnEvents(1), { maxChars: 10 }).startsWith('…（前文略）'), true)
  }

  // ⭐ 回归：工具调用要带**定位信息**，不能只记工具名（2026-09-13）。
  //
  // `tool/call` 的 data 是 `{ turn, step, callId, name, arguments }`（实测 898/898 都有
  // arguments）。只记 `name` 会让总结模型知道"调了 write"却**不知道写到哪个文件** ——
  // 真实日志里因此出现过「无法确认已写入文档的路径」这种自认无知的句子。
  //
  // 但也**不能塞原始材料**：write 的 content 可能几 KB，必须只取定位字段并截断。
  console.log('\n回归：工具调用带定位信息（但不塞原始材料）')
  {
    const call = (name, args) => ([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { name, arguments: JSON.stringify(args) } },
    ])

    check('write 带文件路径',
      renderTranscript(call('write', { file_path: 'D:/a/b.md', content: 'x'.repeat(5000) })).includes('D:/a/b.md'), true)
    check('shell 带命令',
      renderTranscript(call('shell', { command: 'node test/run.mjs' })).includes('node test/run.mjs'), true)
    check('grep 带模式与路径',
      renderTranscript(call('grep', { pattern: 'foo', path: 'src/' })).includes('foo'), true)
    check('read 带路径',
      renderTranscript(call('read', { file_path: 'src/index.js' })).includes('src/index.js'), true)

    // 关键：绝不把 content 原文带进去
    const big = renderTranscript(call('write', { file_path: 'a.md', content: 'SECRET_PAYLOAD_XYZ' }))
    check('不带 write 的 content 正文', big.includes('SECRET_PAYLOAD_XYZ'), false)

    // 超长命令截断
    const long = renderTranscript(call('shell', { command: 'x'.repeat(1000) }))
    const hint = long.split('\n').find((l) => l.startsWith('[调用工具] shell'))
    check('超长命令被截断', hint.length < 250, true)

    // 参数坏了不能崩，退回只记工具名
    const broken = renderTranscript([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { name: 'write', arguments: '{坏掉的' } },
    ])
    check('坏参数退回只记工具名', broken.includes('[调用工具] write'), true)
  }

  // ⭐ 回归：assistant 正文在 `data.message.content`，不是 `data.content`（2026-09-13）。
  //
  // 官方类型 `dsh-session/lib/types/types.d.ts:309-317`：
  //   'assistant/message': { turn, step, message: AssistantMessage, stream, usage? }
  // 而 `user/message` 的正文在 `data.content` —— 两者**不对称**。
  // 读错字段不报错，只让转写里**一条助手发言都没有**（实测线上 708 条全丢），
  // 总结模型于是只看得到用户说了什么、看不到做了什么与得出了什么结论。
  console.log('\n回归：assistant 正文取自 data.message.content')
  {
    const withCorrect = renderTranscript([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手正文在 message 里' }] } } },
    ])
    check('取到 message.content 的正文', withCorrect.includes('助手正文在 message 里'), true)

    // 反证：写成 data.content（错误结构）就不该被取到 —— 确保我们没在两边都读
    const withWrong = renderTranscript([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '错误结构不该被读到' }] } },
    ])
    check('不从 data.content 读 assistant', withWrong.includes('错误结构不该被读到'), false)
  }

  // 回归：注入的快照绝不能被当成"用户说过的话"。
  //
  // 真实数据（11 个会话）里 user/message 的 source 分布：
  //     69 user / 23 官方快照 / 17 cordis / 7 本插件 / 5 skill-catalog / 其余通知
  // 非真人消息比真人还多一倍。不过滤有两个后果：白烧 token；且快照里含记忆
  // 条目的标题与描述，会被总结模型当成用户发言，据此再写一条重复记忆（自我喂养）。
  console.log('\n回归：注入的快照不污染总结输入')
  {
    const SNAPSHOT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: `${SNAPSHOT}\n\n<memory-index scope="global">\n- [某条记忆](a.md) — 描述\n</memory-index>` }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
        },
      },
      { type: 'user/message', data: { content: [{ type: 'text', text: '真实发言' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '好的' }] } },
    ]
    const text = renderTranscript(events)
    check('不含快照文本', text.includes(SNAPSHOT), false)
    check('不含索引条目', text.includes('某条记忆'), false)
    check('保留真实发言', text.includes('真实发言'), true)
    check('isHumanMessage 只认 kind=user', isHumanMessage(events[1]), false)
    check('isHumanMessage 认真人', isHumanMessage(events[2]), true)

    // 每轮至少两条消息的门槛也不能被快照灌水。
    // 这一轮只有「1 真人 + 1 助手」= 2 条，若把快照算进去就变成 3 条。
    const humans = events.filter((e) => isHumanMessage(e) || e.type === 'assistant/message')
    check('消息计数不含快照', humans.length, 2)
  }

  console.log('\n纯函数：解析模型输出')
  {
    check('解析干净 JSON', parseSummary(REPLY)?.notes, ['定位到 journal 从未自动触发'])
    check('解析 ```json 围栏', parseSummary('```json\n' + REPLY + '\n```')?.memories.length, 1)
    check('解析前后有废话的输出', parseSummary(`好的：\n${REPLY}\n以上。`)?.memories.length, 1)
    check('空输出返回 undefined', parseSummary(''), undefined)
    check('非 JSON 返回 undefined', parseSummary('我不会写 JSON'), undefined)
    check('非法 JSON 返回 undefined', parseSummary('{ 坏掉的'), undefined)
    check('缺字段时回落空数组', parseSummary('{}'), { notes: [], memories: [] })
  }

  // 日志曾经只有负面清单、没有正面清单，于是模型只知道"不该记什么"，写出来
  // 只有一句泛泛的"研究了 X"。修复要点：① 补正面清单；② 允许 1-3 句含结论；
  // ③ 把"search results"从"禁止记录"放宽为"别贴原文"——搜索本身就是工作。
  console.log('\n回归：日志 prompt 要有正面清单与结论要求')
  {
    check('含正面清单', SUMMARY_SYSTEM.includes('值得记的事'), true)
    check('要求写出结论', SUMMARY_SYSTEM.includes('结论是最有价值的部分'), true)
    check('允许 1-3 句', SUMMARY_SYSTEM.includes('1-3 句'), true)
    check('不再要求 one short line', /one short line/i.test(SUMMARY_SYSTEM), false)
    // 搜索是工作 → 不能一刀切禁止；只禁止贴原文。
    check('放宽：搜索本身可记', SUMMARY_SYSTEM.includes('搜索和阅读本身就是工作'), true)
    check('保留：不贴原始材料', SUMMARY_SYSTEM.includes('不要贴原始材料'), true)
    // 索引行仍须简短 —— 那是条目描述，不是日志。
    check('索引行仍要求简短', SUMMARY_SYSTEM.includes('<简短标题>'), true)
  }

  // 输出被截断时**不再整轮丢弃** —— 改成抢救已完整的部分（2026-09-14 修复）。
  //
  // 真事故：preset-md 作用域 7 轮会话的日志停在 00:40，error.log 记的是
  // 「总结输出无法解析（JSON 不完整或格式错误）」。那一轮 37 次工具调用、
  // 4435 字符助手发言，输出撞上 maxTokens 被硬截断 → JSON 缺尾 → notes 一起丢。
  // 但 notes 写在 memories 之前，它们其实完好 —— 现在会被抢救出来。
  console.log('\n回归：输出上限与截断抢救')
  {
    check('token 上限 >= 4000', MAX_OUTPUT_TOKENS >= 4000, true)
    // 截断的 JSON：notes 已完整 → 抢救；memories 半截 → 丢弃那一部分。
    const cut = parseSummary('{"notes":["a","b"],"memories":[{"type":"us')
    check('截断时 notes 被抢救', cut?.notes, ['a', 'b'])
    check('标记为抢救（区别于完整解析）', cut?.salvaged, true)
    // 真正无法解析的才返回 undefined。
    check('完全非 JSON → undefined', parseSummary('完全不是 JSON'), undefined)
  }

  console.log('\n本轮消息太少 → 不调用 LLM')
  {
    llmCalls.length = 0
    appended.length = 0
    resetForTest()
    session = makeSession([{ type: 'turn/start', data: { turn: 1 } }])
    listener({ agent, turn: 1 })
    await settle()
    check('没有 LLM 调用', llmCalls.length, 0)
  }

  console.log('\n有往来 → 后台总结并落盘')
  {
    llmCalls.length = 0
    appended.length = 0
    resetForTest()
    writeSettings(paths, { enabled: true, journal: true, disabledPresets: [] })
    session = makeSession(turnEvents(2, [{ type: 'tool/call', data: { name: 'read' } }]))
    listener({ agent, turn: 2 })
    await settle()

    check('调用了 LLM 一次', llmCalls.length, 1)
    check('llm 路由取自 requestHeader', [llmCalls[0]?.provider, llmCalls[0]?.model], [
      'workbuddy',
      'deepseek-v4.1-flash',
    ])
    check('带了 system 提示词', typeof llmCalls[0]?.system, 'string')
    check('system 里写了日志规则', llmCalls[0].system.includes('notes'), true)

    // ⭐ 本次改动的核心：绝不往对话里塞消息。
    check('没有往 inbox append 任何消息', appended.length, 0)

    console.log('  —— 落盘')
    // 正文在 memory/ 子目录，索引在作用域根 —— 新目录结构。
    const memoryFile = join(paths.memoryRoot, 'global', 'memory', 'feedback_不要拿插件文档当需求真源.md')
    check('记忆文件已写', existsSync(memoryFile), true)
    const memoryText = readFileSync(memoryFile, 'utf8')
    check('含 frontmatter type', memoryText.includes('type: feedback'), true)
    check('含正文', memoryText.includes('**Why:**'), true)

    const indexText = readFileSync(join(paths.memoryRoot, 'global', 'MEMORY.md'), 'utf8')
    check('索引已更新', indexText.includes('memory/feedback_不要拿插件文档当需求真源.md'), true)

    // 日志：一天一个文件，按写入时间分批。
    const date = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const journalFile = join(scopes.project.journalDir, `${today}.md`)
    check('日志文件已写', existsSync(journalFile), true)
    const journalText = readFileSync(journalFile, 'utf8')
    check('日志有日期标题', journalText.startsWith(`# ${today}`), true)
    check('日志有 HH:MM:SS 批次', /^## \d{2}:\d{2}:\d{2}$/m.test(journalText), true)
    check('日志含 note 条目', journalText.includes('- 定位到 journal 从未自动触发'), true)

    console.log('  —— 再次触发同一轮')
    llmCalls.length = 0
    listener({ agent, turn: 2 })
    await settle()
    check('同一轮不重复总结', llmCalls.length, 0)
  }

  // ⭐ 已有记忆清单（吸收 CodeBuddy 的 formatMemoryManifest 机制）。
  //
  // 后台模型**看不到记忆库** —— 它是独立 LLM 调用，只拿得到当轮转写。
  // 没有这份清单，"别写重复的"就只是一句它无从执行的叮嘱。
  console.log('\n已有记忆清单喂给后台模型（防重复的机械保障）')
  {
    llmCalls.length = 0
    appended.length = 0
    resetForTest()
    writeSettings(paths, { enabled: true, journal: true, disabledPresets: [] })

    // 上一段测试已经写过一条 global 记忆。
    session = makeSession(turnEvents(3))
    listener({ agent, turn: 3 })
    await settle()

    check('调用了 LLM', llmCalls.length, 1)
    const sent = llmCalls[0]?.messages?.[0]?.content?.[0]?.text ?? ''
    check('消息里附了「已有的记忆」小节', sent.includes('## 已有的记忆'), true)
    // 清单必须真的含刚才那条（带 scope 前缀，模型据此知道该往哪写）。
    check('清单含已有条目的文件名', sent.includes('feedback_不要拿插件文档当需求真源.md'), true)
    check('清单带 scope 前缀', sent.includes('[global]'), true)
    // 叮嘱要与清单呼应 —— 指向清单，而不是空口说"别写重复"。
    check('指明了先看清单', sent.includes('写之前先看这里'), true)
  }

  console.log('\nmanifest 扫描：按修改时间排序、带类型与年龄')
  {
    const { scanMemoryManifest, formatMemoryManifest: fmt } = await import('../src/store.mjs')
    const m = scanMemoryManifest(join(paths.memoryRoot, 'global'))
    check('扫到了条目', m.entries.length > 0, true)
    check('每条都有 ageDays', m.entries.every((e) => typeof e.ageDays === 'number'), true)
    check('每条都有 file 名', m.entries.every((e) => typeof e.file === 'string' && e.file.endsWith('.md')), true)
    // 按 mtime 倒序 —— 最近改动的排前面。
    const sorted = m.entries.every((e, i) => i === 0 || m.entries[i - 1].mtimeMs >= e.mtimeMs)
    check('按 mtime 倒序', sorted, true)
    // 渲染出来的行要带类型标记与文件名。
    const line = fmt(m).split('\n')[0]
    check('渲染行含类型标记', /- \[\w+\] /.test(line), true)
    check('渲染行含 .md 文件名', line.includes('.md'), true)
    // 空清单渲染成空串 —— 调用方据此不注入那一节。
    check('空清单渲染为空串', fmt({ entries: [], total: 0, truncated: false }), '')
  }

  // ⭐ 回归：记忆工具调用抑制总结的判据，只能看**本轮**（2026-09-14）。
  //
  // 真实事故：preset-md 作用域的会话有 7 轮，日志却停在 00:40 —— 因为判据传的是
  // **累积段**（`pending`）。第 5 轮调过一次 `memory_md_journal` 后，那个调用
  // 永远留在累积段里，判据此后恒为真，第 6、7 轮全被跳过且游标被推进。
  //
  // 三条断言分别锁：
  //   T1 本轮写过   → 跳过（判据的**意图**要保留）
  //   T2 累积段有、本轮没有 → **不得**跳过（这是事故本体）
  //   T3 本轮只读   → **不得**跳过（只读检索≠本轮已沉淀）
  console.log('\n回归：记忆工具抑制总结只看本轮（T1 本轮写过 → 跳过）')
  {
    resetForTest()
    llmCalls.length = 0
    session = makeSession(turnEvents(20, [
      { type: 'tool/call', data: { turn: 20, name: 'memory_md_journal' } },
    ]))
    listener({ agent, turn: 20 })
    await settle()
    check('本轮写过记忆 → 不总结', llmCalls.length, 0)
  }

  console.log('\n回归：T2 累积段里有、但本轮没写 → 必须总结（事故本体）')
  {
    // ⚠️ 必须还原**真实时序**：事件是逐轮追加的，turn 21 收尾时 turn 22 还不存在。
    // 早先的写法把两轮事件一次性给全，于是 turn 21 的判据看到的是"最后一轮=22"，
    // 掩盖了 bug —— 那种夹具会让撤销修复后测试照样全绿（假绿）。
    //
    // bug 的真实触发条件：第一轮**内容不足**（游标不推进）但那轮调过写工具，
    // 于是下一轮的累积段里混着上一轮的调用 → 判据恒真 → **两轮一起被跳过**。
    resetForTest()
    llmCalls.length = 0

    // turn 21：调过写工具，但**内容不足**（没有真人/助手消息）→ 游标不推进。
    session = makeSession([
      { type: 'turn/start', data: { turn: 21 } },
      { type: 'tool/call', data: { turn: 21, name: 'memory_md_journal' } },
    ])
    listener({ agent, turn: 21 })
    await settle()
    check('内容不足 → 本轮不总结', llmCalls.length, 0)

    // turn 22：这时事件才追加到会话里（真实时序）。
    // 累积段 = 21 + 22，其中含 21 的写工具调用。
    session = makeSession([
      { type: 'turn/start', data: { turn: 21 } },
      { type: 'tool/call', data: { turn: 21, name: 'memory_md_journal' } },
      ...turnEvents(22),
    ])
    llmCalls.length = 0
    listener({ agent, turn: 22 })
    await settle()
    // 修复后：只按**本轮（22）**判定 → 没写 → 照常总结。
    // 撤销修复：按**累积段**判定 → 命中 21 的调用 → 跳过（bug）。
    check('本轮没写 → 照常总结（不再被上一轮的调用污染）', llmCalls.length, 1)
    check('总结里带上了内容', llmCalls[0] !== undefined, true)
  }

  console.log('\n回归：T3 本轮只读检索 → 不得抑制总结')
  {
    for (const tool of ['memory_md_search', 'memory_md_read']) {
      resetForTest()
      llmCalls.length = 0
      session = makeSession(turnEvents(30, [{ type: 'tool/call', data: { turn: 30, name: tool } }]))
      listener({ agent, turn: 30 })
      await settle()
      check(`本轮调用 ${tool}（只读）→ 仍然总结`, llmCalls.length, 1)
    }
  }

  // ⭐ 跨回合补偿回归（2026-09-13）。
  //
  // 真实事故：20:13→20:33 之间 20 分钟的源码研究与实测，日志里一个字都没有。
  // 根因是 eventsThisTurn() 只取最后一个 turn/start 起的事件 —— 任何「没写成」的
  // 回合（以 error 结束 / 内容不足 / 调用失败）的内容，后面的回合都看不到，永久丢失。
  // 修法：游标只在**成功后**推进，总结范围是「游标之后的所有事件」。
  console.log('\n回归：跨回合补偿（上一轮没写成，下一轮要带上）')
  {
    resetForTest()
    llmCalls.length = 0

    // turn 10：内容不足（只有 turn/start，没有真人发言）→ 不总结、游标不动
    session = makeSession([{ type: 'turn/start', data: { turn: 10 } }])
    listener({ agent, turn: 10 })
    await settle()
    check('内容不足时不调用 LLM', llmCalls.length, 0)

    // turn 11：有完整往来。游标仍是 10，取到的范围应**同时包含 turn 10 和 11**
    llmCalls.length = 0
    const twoTurns = [
      { type: 'turn/start', data: { turn: 10 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第十轮的独立工作' }] } } },
      ...turnEvents(11),
    ]
    session = makeSession(twoTurns)
    listener({ agent, turn: 11 })
    await settle()

    check('调用了 LLM 一次', llmCalls.length, 1)
    const sent = JSON.stringify(llmCalls[0]?.messages ?? [])
    // 关键断言：turn 10 的内容被补偿带上了，而不是被丢掉。
    check('带上了上一轮的内容（补偿生效）', sent.includes('第十轮的独立工作'), true)
    check('也带上了本轮内容', sent.includes('帮我看下这个问题'), true)
  }

  // ⚠️ 首次见到会话时，游标必须锚定在「上一轮」而不是 0。
  // 否则新进程启动后第一次总结会把整个会话历史（真实场景：33 轮、3.3MB）
  // 当成"未总结内容"重跑一遍，重复写日志。
  console.log('\n回归：首次见到会话不从 0 开始（防历史重跑）')
  {
    resetForTest()
    llmCalls.length = 0

    // 一段很长的历史：turn 1..40，每轮都有完整往来
    const history = []
    for (let t = 1; t <= 40; t++) history.push(...turnEvents(t, [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${t}轮的历史工作` }] } } },
    ]))

    session = makeSession(history)
    listener({ agent, turn: 40 })
    await settle()

    check('调用了 LLM 一次', llmCalls.length, 1)
    const sent = JSON.stringify(llmCalls[0]?.messages ?? [])
    // 关键：只带最近一轮，不带 1..39 的历史
    check('不带第 1 轮历史（没从 0 开始）', sent.includes('第1轮的历史工作'), false)
    check('不带第 39 轮历史', sent.includes('第39轮的历史工作'), false)
    check('带上了当前第 40 轮', sent.includes('第40轮的历史工作'), true)
  }

  console.log('\n回归：失败不推进游标（下一轮重试同一段）')
  {
    resetForTest()
    llmCalls.length = 0
    // 让 LLM 抛错
    llm = makeLlm({ fail: true })
    const s2 = makeSession(turnEvents(20))
    const l2 = createTurnStoppingListener({
      getLlm: () => llm,
      getSession: () => s2,
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    l2({ agent, turn: 20 })
    await settle()
    check('调用过一次（失败）', llmCalls.length, 1)

    // 恢复成正常 LLM，同一段内容应当被**重试**
    llmCalls.length = 0
    llm = makeLlm()
    l2({ agent, turn: 21 })
    await settle()
    check('失败后下一轮重试同一段', llmCalls.length, 1)

    llm = makeLlm()  // 还原给后续用例
  }

  console.log('\n回归：连续失败到上限后放弃（避免游标永久卡死）')
  {
    resetForTest()
    llmCalls.length = 0
    llm = makeLlm({ fail: true })
    const s3 = makeSession(turnEvents(30))
    const l3 = createTurnStoppingListener({
      getLlm: () => llm,
      getSession: () => s3,
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    // 触发 MAX_SUMMARY_ATTEMPTS 次失败
    for (let t = 30; t < 30 + MAX_SUMMARY_ATTEMPTS; t++) {
      l3({ agent, turn: t })
      await settle()
    }
    const afterFail = llmCalls.length
    llmCalls.length = 0
    l3({ agent, turn: 40 })
    await settle()
    // 已放弃该段 → 不再重试
    check(`失败 ${afterFail} 次后不再重试`, llmCalls.length, 0)

    llm = makeLlm()  // 还原
  }

  // ⭐ 超时兜底回归（2026-09-13）。
  //
  // `llm.stream()` 没有内置超时（官方 GenerateOptions 只给 signal，取消责任在调用方）。
  // 没有超时的话，provider 挂起会让 `running` 标志永不复位 —— **游标从此卡死**，
  // 后续所有回合都总结不了（不是丢一段，是从此再也不写）。
  // auto-memory 为同一原因包了两层超时。
  console.log('\n回归：provider 挂起不会卡死游标（超时兜底）')
  {
    resetForTest()
    llmCalls.length = 0
    llm = makeLlm({ hang: true })

    const s4 = makeSession(turnEvents(50))
    const l4 = createTurnStoppingListener({
      getLlm: () => llm,
      getSession: () => s4,
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
      summaryTimeoutMs: 50,   // 测试用短超时；生产默认 SUMMARY_TIMEOUT_MS (60s)
    })

    l4({ agent, turn: 50 })
    // 等超时触发
    await new Promise((r) => setTimeout(r, 300))

    check('挂起时调用过 LLM', llmCalls.length, 1)
    check('传了 signal（取消责任在调用方）', llmCalls[0]?.signal !== undefined, true)

    // 关键：超时后 running 必须复位，否则下一轮会被 `if (state.running) return` 挡死。
    llmCalls.length = 0
    llm = makeLlm()  // 恢复正常
    l4({ agent, turn: 51 })
    await settle()
    check('挂起超时后仍能继续总结（游标未卡死）', llmCalls.length, 1)

    llm = makeLlm()  // 还原
  }

  console.log('\n日志按批追加（同一天多次写入 → 多个小节）')
  {
    const date = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const journalFile = join(scopes.project.journalDir, `${today}.md`)
    const countBatches = () =>
      (existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '')
        .split('\n')
        .filter((l) => l.startsWith('## ')).length

    // 数**增量**而不是总数 —— 绝对数会被别的用例影响，断言一改就脆。
    const before = countBatches()

    resetForTest()
    session = makeSession(turnEvents(3))
    listener({ agent, turn: 3 })
    await settle()
    const afterFirst = countBatches()
    check('第一次写 → 新增一个小节', afterFirst - before, 1)

    resetForTest()
    session = makeSession(turnEvents(4))
    listener({ agent, turn: 4 })
    await settle()
    check('第二次写 → 再新增一个小节', countBatches() - afterFirst, 1)

    check('append-only：旧批次仍在', readFileSync(journalFile, 'utf8').includes('- 定位到 journal 从未自动触发'), true)
  }

  console.log('\n本轮模型已调过记忆工具 → 不重复')
  {
    llmCalls.length = 0
    resetForTest()
    session = makeSession(turnEvents(5, [{ type: 'tool/call', data: { name: 'memory_md_save' } }]))
    listener({ agent, turn: 5 })
    await settle()
    check('没有 LLM 调用', llmCalls.length, 0)
  }

  console.log('\n总开关关闭 → 不总结')
  {
    llmCalls.length = 0
    resetForTest()
    writeSettings(paths, { enabled: false })
    session = makeSession(turnEvents(6))
    listener({ agent, turn: 6 })
    await settle()
    check('没有 LLM 调用', llmCalls.length, 0)
    writeSettings(paths, { enabled: true })
  }

  console.log('\n留痕开关关闭 → 写记忆但不写日志')
  {
    resetForTest()
    writeSettings(paths, { enabled: true, journal: false })

    // 断言「当天日志文件逐字节未变」，而不是 `typeof x === 'boolean'`（恒真）。
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    const journalFile = join(scopes.project.journalDir, `${today}.md`)
    const snap = () => (existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : null)
    const before = snap()

    session = makeSession(turnEvents(7))
    listener({ agent, turn: 7 })
    await settle()

    // 记忆该写就写（关的只是日志）。
    check('记忆仍然写入', existsSync(join(paths.memoryRoot, 'global', 'memory', 'feedback_不要拿插件文档当需求真源.md')), true)
    // ⭐ 这是真正的契约：journal=false ⇒ 日志文件内容一字不改（不存在则仍不存在）。
    check('留痕关闭 → 日志文件未变', snap(), before)
    writeSettings(paths, { journal: true })
  }

  console.log('\n预设被停用 → 不总结')
  {
    llmCalls.length = 0
    resetForTest()
    const disabledListener = createTurnStoppingListener({
      getLlm: () => llm,
      getSession: () => makeSession(turnEvents(8), 'presetmd-accd'),
      isDisabledFor: () => true,
      logger: { warn: () => {}, info: () => {} },
    })
    disabledListener({ agent, turn: 8 })
    await settle()
    check('停用预设不调用 LLM', llmCalls.length, 0)
  }

  console.log('\nLLM 抛错 → 吞掉，不影响轮次收尾')
  {
    resetForTest()
    const badListener = createTurnStoppingListener({
      getLlm: () => makeLlm({ fail: true }),
      getSession: () => makeSession(turnEvents(9)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    let threw = false
    try {
      badListener({ agent, turn: 9 })
      await settle()
    } catch {
      threw = true
    }
    check('异常被吞掉', threw, false)
  }

  console.log('\n监听器本身抛错也不外泄')
  {
    const exploding = createTurnStoppingListener({
      getLlm: () => ({ stream: () => { throw new Error("boom") } }),
      getSession: () => {
        throw new Error('boom')
      },
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    let threw = false
    try {
      exploding({ agent, turn: 10 })
    } catch {
      threw = true
    }
    check('异常被吞掉', threw, false)
  }

  console.log('\n回归：输出被 maxTokens 截断 → 观测到 + 抢救已完整部分')
  {
    resetForTest()
    llmCalls.length = 0
    appended.length = 0
    writeSettings(paths, { enabled: true, journal: true })

    // 清掉之前用例可能留下的日志，便于断言"这次确实写了"。
    const d2 = new Date()
    const p3 = (n) => String(n).padStart(2, '0')
    const today2 = `${d2.getFullYear()}-${p3(d2.getMonth() + 1)}-${p3(d2.getDate())}`
    const journalFile2 = join(scopes.project.journalDir, `${today2}.md`)
    rmSync(journalFile2, { force: true })

    const warns = []
    const truncating = createTurnStoppingListener({
      getLlm: () => makeLlm({ truncate: true }),
      getSession: () => makeSession(turnEvents(40)),
      isDisabledFor: () => false,
      logger: { warn: (m) => warns.push(String(m)), info: () => {} },
    })
    truncating({ agent, turn: 40 })
    await settle()

    check('确实调用了 LLM', llmCalls.length, 1)
    // ⭐ 观测路径：必须报告"撞上 maxTokens 被截断"，而不是静默当成解析失败。
    check('警告里点明了 max-tokens 截断',
      warns.some((w) => w.includes('max-tokens') || w.includes('截断')), true)
    check('警告里说明了抢救数量',
      warns.some((w) => w.includes('抢救')), true)
    // ⭐ 抢救路径：notes 完整 → 该写进日志，不该整轮丢弃。
    check('抢救出的 note 写进了日志',
      existsSync(journalFile2) && readFileSync(journalFile2, 'utf8').includes('抢救回来的一条'), true)
    // memories 半截 → 不落盘（不该把残缺对象当记忆写进去）。
    check('半截的 memory 没有被写入',
      existsSync(join(paths.memoryRoot, 'global', 'memory', 'project_半截.md')), false)
  }

  console.log('\n缺 llm 服务 → 整个能力静默停用')
  {
    resetForTest()
    const noLlm = createTurnStoppingListener({
      getLlm: () => undefined,
      getSession: () => makeSession(turnEvents(11)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    let threw = false
    try {
      noLlm({ agent, turn: 11 })
    } catch {
      threw = true
    }
    check('不抛错', threw, false)
  }

  console.log('\n空输出 / 空 note 不落盘')
  {
    resetForTest()
    const emptyListener = createTurnStoppingListener({
      getLlm: () => makeLlm({ reply: JSON.stringify({ notes: [], memories: [] }) }),
      getSession: () => makeSession(turnEvents(12)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    emptyListener({ agent, turn: 12 })
    await settle()
    // 真正的契约：模型返回空 notes/memories ⇒ **一个文件都不该产生**。
    // 早先写的是 `check(..., true, true)` —— 字面恒真，什么都没锁。
    const globalMemoryDir = join(paths.memoryRoot, 'global', 'memory')
    const files = existsSync(globalMemoryDir) ? readdirSync(globalMemoryDir).sort() : []
    check('空输出不产生任何记忆文件', files, ['feedback_不要拿插件文档当需求真源.md'])
  }

  // ⭐ 回归：`file` 字段（2026-09-17 实测确认的真 bug）。
  //
  // 原状：SUMMARY_SYSTEM 要求模型"用同一个 file 名覆盖更新"，但**规定的 JSON
  // 形状里没有 file 字段** —— 模型被要求用一个没在 schema 里出现的东西。
  //
  // 两种实测坏结果：
  //   1. 不传 file → 按 slug 派生 → 不同主题撞名时**静默覆盖**（丢记忆）；
  //   2. 传 `memory/xxx.md`（照抄主对话索引里的形式）→ 裸 isSafeFile 因含斜杠
  //      拒绝 → 回落派生 → **同一件事变成两条**。
  //
  // 修法：形状里补上 file；消费侧改用 normalizeMemoryFile（与 tools.mjs 同源）；
  // 派生路径走 resolveMemoryFile 防撞车。三条缺一不可。
  console.log('\n回归：后台总结的 file 字段（覆盖更新 / 归一化 / 防撞车）')
  {
    resetForTest()
    const globalDir = join(paths.memoryRoot, 'global')
    const globalMemoryDir = join(globalDir, 'memory')
    const indexOf = () => readFileSync(join(globalDir, 'MEMORY.md'), 'utf8')
    const linesOf = () => indexOf().split('\n').filter((l) => l.startsWith('- '))
    const filesOf = () => (existsSync(globalMemoryDir) ? readdirSync(globalMemoryDir).sort() : [])

    // --- 1) 显式 file（裸文件名）→ 就地更新，不新增文件、不新增索引行
    const before = linesOf().length
    const n1 = createTurnStoppingListener({
      getLlm: () => makeLlm({
        reply: JSON.stringify({
          notes: [],
          memories: [{
            type: 'feedback',
            scope: 'global',
            name: '不要拿插件文档当需求真源',
            description: '改写后的描述',
            content: '**Why:** 改写后的正文。\n\n**How to apply:** 照旧。',
            file: 'feedback_不要拿插件文档当需求真源.md',
          }],
        }),
      }),
      getSession: () => makeSession(turnEvents(20)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    n1({ agent, turn: 20 })
    await settle()
    check('裸文件名 → 就地更新（文件数不变）', filesOf().length, 1)
    check('裸文件名 → 索引行数不变', linesOf().length, before)
    check('内容确实被更新', readFileSync(
      join(globalMemoryDir, 'feedback_不要拿插件文档当需求真源.md'), 'utf8',
    ).includes('改写后的正文'), true)

    // --- 2) 带 `memory/` 前缀（照抄索引的形式）→ 归一化后仍就地更新
    //
    // ⚠️ 这条用例必须让**既有文件名无法由 name 派生出来**，否则测不出区别：
    // 如果 name 派生的文件名恰好就是既有文件，回退路径也会"碰巧"更新同一个文件。
    // 所以先手工写一个名字与标题不一致的文件，模型再按**文件名**（带前缀）去改它。
    resetForTest()
    const { writeMemory } = await import('../src/store.mjs')
    writeMemory(globalDir, {
      file: 'feedback_历史条目.md',
      type: 'feedback',
      name: '历史结论',
      description: '旧描述',
      content: '旧正文。',
    })
    const beforeFiles = filesOf().length
    const beforeLines = linesOf().length

    const n2 = createTurnStoppingListener({
      getLlm: () => makeLlm({
        reply: JSON.stringify({
          notes: [],
          memories: [{
            type: 'feedback',
            scope: 'global',
            // name 与文件名**不一致** —— 派生不出 feedback_历史条目.md
            name: '完全不同的标题',
            description: '又改一次',
            content: '**Why:** 第二次改写。\n\n**How to apply:** 照旧。',
            file: 'memory/feedback_历史条目.md',
          }],
        }),
      }),
      getSession: () => makeSession(turnEvents(21)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    n2({ agent, turn: 21 })
    await settle()
    check('带前缀 → 归一化后改到既有文件（不新增文件）', filesOf().length, beforeFiles)
    check('带前缀 → 不新增索引行', linesOf().length, beforeLines)
    check('既有文件内容被更新', readFileSync(
      join(globalMemoryDir, 'feedback_历史条目.md'), 'utf8',
    ).includes('第二次改写'), true)

    // --- 3) 不同主题但派生同名 → 防撞车（不覆盖）
    resetForTest()
    const n3 = createTurnStoppingListener({
      getLlm: () => makeLlm({
        reply: JSON.stringify({
          notes: [],
          memories: [{
            type: 'reference',
            scope: 'global',
            name: '端口分配',
            description: '本地端口',
            content: '正文一。',
          }],
        }),
      }),
      getSession: () => makeSession(turnEvents(22)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    n3({ agent, turn: 22 })
    await settle()
    const countAfterFirst = filesOf().length

    resetForTest()
    const n4 = createTurnStoppingListener({
      getLlm: () => makeLlm({
        reply: JSON.stringify({
          notes: [],
          memories: [{
            type: 'reference',
            scope: 'global',
            name: '端口分配！', // 只差一个标点 → slug 相同
            description: '另一个主题',
            content: '正文二。',
          }],
        }),
      }),
      getSession: () => makeSession(turnEvents(23)),
      isDisabledFor: () => false,
      logger: { warn: () => {}, info: () => {} },
    })
    n4({ agent, turn: 23 })
    await settle()
    check('slug 撞车 → 另起文件而不是覆盖', filesOf().length, countAfterFirst + 1)
    // 两条正文都要还在 —— 这才是防撞车的意义
    const allText = filesOf().map((f) => readFileSync(join(globalMemoryDir, f), 'utf8')).join('\n')
    check('第一条正文没被覆盖', allText.includes('正文一。'), true)
    check('第二条也写进去了', allText.includes('正文二。'), true)
  }

  // ⭐ 回归：后台总结必须用**与工具同源**的记忆根目录（2026-09-17 实测确认）。
  //
  // 原状：`run()` 里调的是无参 `resolvePaths()`，而 tools.mjs / routes.mjs / index.js
  // 三处都传 `config.dshHome`。profile 显式传一个与 DSH_HOME 环境变量不同的目录时，
  // 工具写到 A、后台总结写到 B —— 表现为"手动存得进、后台总结看不见"。
  console.log('\n回归：后台总结用注入的 dshHome（与工具同源）')
  {
    resetForTest()
    // 与 process.env.DSH_HOME（= SANDBOX）**不同**的目录
    const OTHER_HOME = join(SANDBOX, 'other-home')
    rmSync(OTHER_HOME, { recursive: true, force: true })
    mkdirSync(OTHER_HOME, { recursive: true })

    const n = createTurnStoppingListener({
      getLlm: () => makeLlm({
        reply: JSON.stringify({
          notes: ['写进 other-home 的一条'],
          memories: [{
            type: 'reference',
            scope: 'global',
            name: '异构根目录测试',
            description: '验证 dshHome 传递',
            content: '正文。',
          }],
        }),
      }),
      getSession: () => makeSession(turnEvents(30)),
      isDisabledFor: () => false,
      dshHome: OTHER_HOME,
      logger: { warn: () => {}, info: () => {} },
    })
    n({ agent, turn: 30 })
    await settle()

    // 记忆必须落在注入的 dshHome 下，而不是环境变量指向的那个。
    const inOther = join(OTHER_HOME, 'memory-md', 'global', 'memory')
    check('记忆写进注入的 dshHome', existsSync(inOther), true)
    const files = existsSync(inOther) ? readdirSync(inOther) : []
    check('确实写了一条记忆', files.some((f) => f.includes('异构根目录测试')), true)

    // 反向：不该在环境变量那个根目录里也产生同名文件（那正是修复前的行为）。
    const inEnv = join(SANDBOX, 'memory-md', 'global', 'memory')
    const envFiles = existsSync(inEnv) ? readdirSync(inEnv) : []
    check('没有写到环境变量那个根目录', envFiles.some((f) => f.includes('异构根目录测试')), false)

    rmSync(OTHER_HOME, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
