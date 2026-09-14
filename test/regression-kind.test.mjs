/**
 * regression-kind.test.mjs — 记忆插件绝不往主对话投递消息。
 *
 * ## 背景
 *
 * 旧实现挂在 `agent/turn-stopping`，往主对话 `inbox.append('next-step')` 塞一条
 * "Before this turn closes…" 的提醒。两个后果：提醒**显示在对话里**，且逼主模型
 * 再跑一步。其中还踩过一个坑 —— 投递时漏了 `source`：
 *
 *   { "content": [...], "role": "user", "id": "b87534ed-…" }   ← 少了 source
 *
 * loop 随后在轮次收尾路径上读 `message.source.kind`，抛
 *   Cannot read properties of undefined (reading 'kind')
 * 整个回合以 `reason.kind === 'error'` 结束。
 *
 * ## 现在怎么保证不再犯
 *
 * 改动的思路是**从根上不投递**：轮末只在后台起一次独立 LLM 调用，由它总结后
 * 直接写文件。所以这个回归测试现在断言两件事：
 *
 *   1. `summarize.mjs` 的源码里**没有** `inbox.append` / `createUserMessage`
 *      —— 只要有人再把"提醒主模型"加回来，测试立刻变红；
 *   2. 真的跑一次轮末，`inbox.append` 一次都没被调用。
 *
 * 第二条是端到端的：即使源码里换了别的方式投递，也会被抓到。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SANDBOX = join(tmpdir(), `mmd-regression-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const here = dirname(fileURLToPath(import.meta.url))
const summarizeSource = readFileSync(join(here, '..', 'src', 'summarize.mjs'), 'utf8')

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

console.log('\n源码里不再有「往对话投递」的路径')
{
  check('没有 inbox.append', /inbox\s*\.\s*append/.test(summarizeSource), false)
  check('没有 createUserMessage', /createUserMessage/.test(summarizeSource), false)
  check(
    '也没有 next-step 投递',
    /['"]next-step['"]/.test(summarizeSource),
    false,
  )
}

console.log('\n端到端：轮末不向 inbox 投递任何消息')
{
  const { createTurnStoppingListener, resetForTest } = await import('../src/summarize.mjs')
  const { writeSettings, resolvePaths } = await import('../src/settings.mjs')
  const { resolveScopes } = await import('../src/context.mjs')

  rmSync(SANDBOX, { recursive: true, force: true })
  const paths = resolvePaths(SANDBOX)
  mkdirSync(paths.memoryRoot, { recursive: true })
  writeSettings(paths, { enabled: true, journal: true })
  resolveScopes({ cwd: 'D:\\proj', dshHome: paths.dshHome })

  const appended = []
  const agent = { id: 's1', inbox: { append: (t, m) => appended.push({ t, m }) } }
  const session = {
    header: { cwd: 'D:\\proj', agentPreset: 'standard' },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    ownEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    ],
  }

  resetForTest()
  const listener = createTurnStoppingListener({
    getLlm: () => ({
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"notes":["做了点事"],"memories":[]}' }
        })(),
    }),
    getSession: () => session,
    isDisabledFor: () => false,
    logger: { warn: () => {}, info: () => {} },
  })

  listener({ agent, turn: 1 })
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5))

  check('inbox.append 一次都没被调用', appended.length, 0)
  check('日志确实写了（证明后台真的跑了）', readFileSync(join(paths.memoryRoot, '..', 'memory-md', 'd-proj', '.journal', `${todayOf()}.md`), 'utf8').includes('- 做了点事'), true)

  rmSync(SANDBOX, { recursive: true, force: true })
}

function todayOf() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
