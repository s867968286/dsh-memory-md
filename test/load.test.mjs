/**
 * load.test.mjs — 按 DSH bundle loader 的方式装载已安装插件。
 *
 * **必须按包名装载**（`import('dsh-memory-md')`），不能按文件路径。
 * 两者不等价：DSH 的 loader 以包为单位解析依赖，插件因此能解析到
 * `@deepseek-ai/dsh-tools`；按文件路径加载时解析基准变成插件目录，
 * 该依赖不可见，工具注册会静默跳过。
 *
 * 这个测试因此也兼作「装载方式是否正确」的回归：按包名导入能拿到工具。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.USERPROFILE || process.env.HOME
const LINK = join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-memory-md')

// ⚠️ 必须隔离 DSH_HOME，否则 `apply()` 会读到**真实用户记忆目录**并对其做迁移等副作用。
// 这曾经真的发生过：迁移首次接进 apply() 时，本套件因为没有沙箱而对着
// `C:\Users\kosei\.dsh\memory-md\` 跑了迁移（幸好那次因目录未建而全部失败）。
const SANDBOX = join(tmpdir(), `mmd-load-${process.pid}`)
process.env.DSH_HOME = SANDBOX
mkdirSync(join(SANDBOX, 'memory-md'), { recursive: true })

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

/* ---------- 按包名装载（与真实 loader 一致）---------- */
console.log('\n按包名装载')
const mod = await import('dsh-memory-md')

check('package entry exports apply', typeof mod.apply, 'function')
check('declares webServer inject', mod.inject, ['webServer'])
check('route prefix', mod.ROUTE_PREFIX, '/memory-md')
void LINK

/* ---------- drive apply() with a stub ctx ---------- */
const listeners = new Map()
const routes = []
const warnings = []
const toolNames = []
const contexts = []
const sections = []

const ctx = {
  logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
  get(name) {
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'tools') {
      return {
        register(definition) {
          toolNames.push(definition.name)
          return () => {}
        },
      }
    }
    return undefined
  },
  // cordis 的延迟注入：依赖就绪后回调带一个 scoped ctx。
  // 本插件用它注册运行期上下文快照，并捕获 `llm` 供轮末后台总结使用。
  inject(deps, fn) {
    const scope = {
      ...ctx,
      llm: { stream: async function* () {} },
      systemPrompt: {
        context(spec) {
          contexts.push({ deps, spec })
          return () => {}
        },
        section(spec) {
          sections.push({ deps, spec })
          return () => {}
        },
      },
    }
    fn(scope)
    return { dispose: () => {} }
  },
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  },
  // 事件总线：`memory-md/settings-changed` 由 routes 在根 ctx 上 emit，
  // 插件在根 ctx 上监听 —— 测试要能真的触发它（否则清缓存那条路径测不到）。
  emit(name, payload) {
    for (const fn of listeners.get(name) ?? []) fn(payload)
    return true
  },
  effect(fn) {
    fn()
    return () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

console.log('\napply()')
mod.apply(ctx, {})

check('注册了 HTTP 路由', routes.length, 1)
check('路由 kind', routes[0].kind, 'prefix')
check('路由 path', routes[0].path, '/memory-md')

// 工具注册是异步的（defineTool 惰性解析），等一个微任务队列。
await new Promise((resolve) => setTimeout(resolve, 50))
console.log('\n工具注册')
check('注册了五个记忆工具', toolNames.sort(), [
  'memory_md_forget',
  'memory_md_journal',
  'memory_md_read',
  'memory_md_save',
  'memory_md_search',
])
check('名字都带 memory_md_ 前缀', toolNames.every((n) => n.startsWith('memory_md_')), true)

console.log('\n两段式注入：常量进提示词段，读盘的索引进上下文快照')
// 协议 + 行为纪律都是常量，走 `systemPrompt.section()` ——
// DSH 每步重装提示词时结果不变，前缀 KV Cache 始终命中，且不产生新消息。
check('注册了一个 section', sections.length, 1)
check('section 名', sections[0]?.spec?.name, 'memory-md:protocol')
check('section 有 order', typeof sections[0]?.spec?.order, 'number')
// ★ 关键：section 的 text 必须对任意 assembly 返回**同一份常量**。
// 它一旦读盘（例如把索引塞进来），整个提示词前缀的 KV Cache 就随文件变化失效
// —— 含全部历史。这条断言把「常量」这个前提钉死。
{
  const spec = sections[0]?.spec
  const a = typeof spec?.text === 'function' ? spec.text({ agent: undefined }) : spec?.text
  const b = typeof spec?.text === 'function' ? spec.text({ agent: { id: 'other' } }) : spec?.text
  check('section text 非空', typeof a === 'string' && a.length > 0, true)
  check('section text 与 assembly 无关（纯常量）', a === b, true)
  // 纪律确实在这个常量里 —— 它不能只出现在快照里。
  check('section 含行为纪律', String(a).includes('写入的四条纪律'), true)
}
// 索引读盘、随记忆变化，走 `systemPrompt.context()` —— 追加在历史里，
// 不吃提示词前缀；去重由 loop 的 RuntimeContextProjection 内建。
check('注册了一个 context', contexts.length, 1)
check('context 名', contexts[0]?.spec?.name, 'memory-md:index')
check('context 有 order', typeof contexts[0]?.spec?.order, 'number')
check('context text 是函数（每次装配重读）', typeof contexts[0]?.spec?.text, 'function')
// ★ 反向断言：常量纪律**不得**出现在快照里，否则索引一变就带着它整段重发
// （快照是追加而非替换，重发会永久占住会话历史）。
{
  const spec = contexts[0]?.spec
  const text = typeof spec?.text === 'function' ? spec.text({ agent: undefined }) : (spec?.text ?? '')
  check('context 里没有纪律（避免随索引重发）', String(text).includes('写入的四条纪律'), false)
}

console.log('\n订阅轮末后台总结')
check('订阅了 turn-stopping', listeners.has('agent/turn-stopping'), true)
check('订阅了 agent/disposed', listeners.has('agent/disposed'), true)

/* ---------- 索引冻结（freezeIndex）----------
 *
 * 冻结的判据是「返回值恒定」——`RuntimeContextProjection.project()` 比对的是
 * 拼接后的整串（dsh-agent-loop/lib/index.js:893），相同就不追加新快照。
 * 所以这里直接断言 text() 的返回值，不依赖 loop。
 *
 * ⚠️ 用 global 作用域：它不需要工作区，`cwd: undefined` 也会读 global 索引。
 */
console.log('\n索引冻结：缓存上一次渲染的文本，返回值恒定即不追加')
{
  const settingsFile = join(SANDBOX, 'memory-md', 'settings.json')
  const globalDir = join(SANDBOX, 'memory-md', 'global')
  const indexPath = join(globalDir, 'MEMORY.md')
  const writeIndex = (body) => {
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(indexPath, body, 'utf8')
  }
  const writeSettings = (patch) => {
    mkdirSync(join(SANDBOX, 'memory-md'), { recursive: true })
    writeFileSync(settingsFile, JSON.stringify(patch), 'utf8')
  }

  const spec = contexts[0]?.spec
  const text = (id) => (typeof spec?.text === 'function'
    ? spec.text({ agent: id === undefined ? undefined : { id } })
    : (spec?.text ?? ''))

  writeIndex('# MEMORY.md\n\n- [甲](a.md) — 第一次\n')
  writeSettings({ enabled: true, freezeIndex: true, journal: false, disabledPresets: [] })

  const first = text('sess-1')
  check('冻结开启：首次渲染出索引', String(first).includes('第一次'), true)

  // 文件被改了 —— 冻结下返回值**必须**仍是旧的（否则整串一变就又追加一份）
  writeIndex('# MEMORY.md\n\n- [甲](a.md) — 第一次\n- [乙](b.md) — 第二次\n')
  const second = text('sess-1')
  check('冻结开启：索引文件变了也不重新渲染', second, first)

  // 另一个会话有独立的缓存 —— 它拿到的是"当前"索引
  const other = text('sess-2')
  check('冻结按会话独立（新会话看到最新）', String(other).includes('第二次'), true)

  // 关掉冻结 → 立刻读盘，拿到最新
  writeSettings({ enabled: true, freezeIndex: false, journal: false, disabledPresets: [] })
  const afterOff = text('sess-1')
  check('关掉冻结：立刻读盘拿到最新', String(afterOff).includes('第二次'), true)

  // 再打开 → 因为关闭期间缓存已被清，拿到的是最新的，而不是一份陈旧文本
  writeSettings({ enabled: true, freezeIndex: true, journal: false, disabledPresets: [] })
  const reopened = text('sess-1')
  check('重新打开：拿到最新（不是陈旧缓存）', String(reopened).includes('第二次'), true)

  // settings-changed 事件清空全部缓存 —— 这是设置页保存后的刷新路径
  writeIndex('# MEMORY.md\n\n- [丙](c.md) — 第三次\n')
  ctx.emit('memory-md/settings-changed')
  const refreshed = text('sess-1')
  check('settings-changed 清缓存后重新渲染', String(refreshed).includes('第三次'), true)

  // 会话销毁时清掉它的缓存（避免 Map 随会话数增长）
  writeIndex('# MEMORY.md\n\n- [丁](d.md) — 第四次\n')
  for (const fn of listeners.get('agent/disposed') ?? []) fn({ agent: { id: 'sess-1' } })
  const afterDispose = text('sess-1')
  check('会话销毁后缓存被清（重新渲染）', String(afterDispose).includes('第四次'), true)

  writeSettings({ enabled: true, freezeIndex: false, journal: false, disabledPresets: [] })
}

// apply() 内部对工具注册失败只 warn 不抛 —— 这里确保没有静默降级。
console.log('\napply() 期间没有告警')
check('无告警', warnings, [])

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
