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
import { mkdirSync, rmSync } from 'node:fs'
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
check('注册了四个记忆工具', toolNames.sort(), [
  'memory_md_journal',
  'memory_md_read',
  'memory_md_save',
  'memory_md_search',
])
check('名字都带 memory_md_ 前缀', toolNames.every((n) => n.startsWith('memory_md_')), true)

console.log('\n两段式注入：协议进提示词段，索引进上下文快照')
// 协议是常量，走 `systemPrompt.section()` —— DSH 每步重装提示词时结果不变，
// 前缀 KV Cache 始终命中。
check('注册了一个 section', sections.length, 1)
check('section 名', sections[0]?.spec?.name, 'memory-md:protocol')
check('section 有 order', typeof sections[0]?.spec?.order, 'number')
// 索引读盘、随记忆变化，走 `systemPrompt.context()` —— 追加在历史里，
// 不吃提示词前缀；去重由 loop 的 RuntimeContextProjection 内建。
check('注册了一个 context', contexts.length, 1)
check('context 名', contexts[0]?.spec?.name, 'memory-md:index')
check('context 有 order', typeof contexts[0]?.spec?.order, 'number')
check('context text 是函数（每次装配重读）', typeof contexts[0]?.spec?.text, 'function')

console.log('\n订阅轮末后台总结')
check('订阅了 turn-stopping', listeners.has('agent/turn-stopping'), true)
check('订阅了 agent/disposed', listeners.has('agent/disposed'), true)

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
