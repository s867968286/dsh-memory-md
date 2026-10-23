/**
 * preset-exclude.test.mjs — 预设级停用。
 *
 * 需求：本插件默认在**所有**预设下生效（含官方四个），但使用者在
 * 「记忆设置」里把某些预设加进停用名单后，那些预设**整体**不生效 ——
 * 工具、轮末提醒、日志全停，而不是「工具藏起来但后台照跑」。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-preset-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { isPresetDisabled, readSettings, resolvePaths, writeSettings } = await import(
  '../src/settings.mjs'
)
const { registerMemoryTools, TOOL_WRITE, TOOL_SEARCH, TOOL_READ, TOOL_FORGET, TOOL_JOURNAL } = await import(
  '../src/tools.mjs'
)

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

const paths = resolvePaths(SANDBOX)

console.log('\n匹配规则')
{
  const settings = { disabledPresets: ['presetmd-*', 'exact-id'] }
  check('精确命中', isPresetDisabled(settings, 'exact-id'), true)
  check('通配命中', isPresetDisabled(settings, 'presetmd-accd'), true)
  check('通配命中另一个', isPresetDisabled(settings, 'presetmd-e4d0'), true)
  check('官方预设不受影响', isPresetDisabled(settings, 'standard'), false)
  check('无 preset 不命中', isPresetDisabled(settings, undefined), false)
  check('空 id 不命中', isPresetDisabled(settings, ''), false)
  check('默认设置不命中', isPresetDisabled(readSettings(paths), 'presetmd-accd'), false)
}

console.log('\n设置归一化')
{
  writeSettings(paths, { disabledPresets: [' presetmd-* ', '', 'presetmd-*', '  ', 'a'] })
  // 空项丢弃、去重、排序 —— 内容稳定才便于人工核对。
  check('清理并去重', readSettings(paths).disabledPresets, ['a', 'presetmd-*'])
  writeSettings(paths, { disabledPresets: 'not-an-array' })
  check('类型不符回落默认', readSettings(paths).disabledPresets, [])
}

console.log('\n停用后工具全部拒绝')
{
  writeSettings(paths, { enabled: true, journal: true, disabledPresets: ['presetmd-*'] })

  const defs = new Map()
  /** 当前 agent 所在 preset —— 由 isDisabledFor 读取，模拟 Host 半的行为。 */
  let currentPresetId
  const isDisabledFor = (agent) => {
    void agent
    return isPresetDisabled(readSettings(paths), currentPresetId)
  }

  // 预置一条记忆，供读/搜使用。
  mkdirSync(join(SANDBOX, 'memory-md', 'global'), { recursive: true })
  writeFileSync(
    join(SANDBOX, 'memory-md', 'global', 'MEMORY.md'),
    '- [X](user_x.md) \u2014 \u4f9b\u6d4b\u8bd5\n',
    'utf8',
  )

  registerMemoryTools({
    tools: { register: (d) => { defs.set(d.name, d); return () => {} } },
    config: {
      dshHome: SANDBOX,
      workspaceCwd: () => 'D:\\proj',
      isDisabledFor,
      hints: { dirs: '' },
    },
    logger: { info: () => {}, warn: () => {} },
  })

  const exec = { agent: { id: 's1' } }
  const attempts = [
    ['save', TOOL_WRITE, { scope: 'global', type: 'user', name: 'a', description: 'b', content: 'c' }],
    ['search', TOOL_SEARCH, { query: 'x' }],
    ['read', TOOL_READ, { scope: 'all' }],
    // 删除也必须拦 —— 否则模型能绕过停用把记忆删掉。
    ['forget', TOOL_FORGET, { scope: 'global', file: 'user_a.md' }],
    ['journal', TOOL_JOURNAL, { note: 'n' }],
  ]

  const run = async (name, args) => {
    try {
      await defs.get(name).execute(args, exec)
      return 'ok'
    } catch (error) {
      return error.message.includes('已被当前 agent 预设停用') ? 'blocked' : `other: ${error.message}`
    }
  }

  console.log('  —— 停用中 ——')
  currentPresetId = 'presetmd-accd'
  for (const [label, tool, args] of attempts) {
    check(`${label} 被拒绝`, await run(tool, args), 'blocked')
  }

  console.log('  —— 未停用的预设（官方）——')
  currentPresetId = 'standard'
  // 不该再被 preset 拦；这里只验证「不是被 preset 拦掉」。
  for (const [label, tool, args] of attempts) {
    const result = await run(tool, args)
    check(`${label} 不再被预设拦`, result === 'blocked', false)
  }

  console.log('  —— 完全无预设 ——')
  currentPresetId = undefined
  for (const [label, tool, args] of attempts) {
    const result = await run(tool, args)
    check(`${label} 无预设时可用`, result === 'blocked', false)
  }

  console.log('  —— 停用的预设下不写盘 ——')
  currentPresetId = 'presetmd-accd'
  const before = readFileSync(join(SANDBOX, 'memory-md', 'global', 'MEMORY.md'), 'utf8')
  await run(TOOL_WRITE, { scope: 'global', type: 'user', name: '不应该写入', description: 'x', content: 'y' })
  const after = readFileSync(join(SANDBOX, 'memory-md', 'global', 'MEMORY.md'), 'utf8')
  check('索引未被改动', after, before)
  check('没有产出新文件', existsSync(join(SANDBOX, 'memory-md', 'global', 'user_不应该写入.md')), false)
}

console.log('\n当前预设取自事件流折叠，而不是创建时冻结的 header')
{
  // 0.1.7-rc.2 的实测场景：新建会话（默认 standard-gitbash）→ blank 窗口内
  // 切「伙伴模式」。切换只 append `agent-preset/selected` 事件、更新投影，
  // header 不变（header 是创建时冻结的，dsh-session/lib/index.js:1668 只在
  // prepare 时写入一次）。只读 header 的旧实现在这里永远拿不到
  // companion-mode，停用规则于是永不命中（真机复现：伙伴会话里后台日志照写）。
  writeSettings(paths, { enabled: true, journal: true, disabledPresets: ['companion-mode'] })

  // 端到端驱动真实判定链：apply() → ctx.inject(['tools']) → registerMemoryTools
  // 收到的 config.isDisabledFor 与生产是同一个函数。这里截获它直接断言，
  // 比 mock 一遍匹配规则更贴近真实路径。
  const { apply } = await import('../src/index.js')

  const headerPreset = 'standard-gitbash'
  // 切到伙伴模式的会话：header 还是旧档，事件流最后一次 selected 是 companion-mode。
  const sessionSwitched = {
    header: { agentPreset: headerPreset, cwd: 'D:\\proj' },
    ownEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'standard-gitbash' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } },
    ],
  }
  // 从未切过档的会话：事件流里没有 selected 事件 → 应回落 header 档。
  const sessionNeverSwitched = {
    header: { agentPreset: headerPreset, cwd: 'D:\\proj' },
    ownEvents: () => [{ type: 'turn/start', data: { turn: 1 } }],
  }
  // 事件流读不了的会话（异常路径）→ 也应回落 header 档，而不是抛错。
  const sessionBrokenEvents = {
    header: { agentPreset: headerPreset, cwd: 'D:\\proj' },
    get ownEvents() { throw new Error('boom') },
  }

  const sessions = {
    'agent-switched': sessionSwitched,
    'agent-never-switched': sessionNeverSwitched,
    'agent-broken-events': sessionBrokenEvents,
  }
  const registered = []
  const hooks = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === 'sessions' ? { get: (id) => sessions[id] } : undefined),
    inject: (names, fn) => { hooks.set(names.join('+'), fn) },
    on() {},
  }

  apply(ctx, { dshHome: SANDBOX })
  hooks.get('tools')({
    tools: { register: (d) => { registered.push(d); return () => {} } },
    effect: () => {},
  })
  check('工具已注册', registered.length > 0, true)

  // 每个工具的 execute 走 assertPresetAllowed(exec.agent)，同一 agent id 下
  // 停用与否由 isDisabledFor 决定 —— 用写工具做行为级断言。
  const writeTool = registered.find((d) => d.name === TOOL_WRITE)
  const attempt = async (agentId) => {
    try {
      await writeTool.execute({ scope: 'global', type: 'user', name: 'x', description: 'y', content: 'z' }, { agent: { id: agentId } })
      return 'ok'
    } catch (error) {
      return error.message.includes('已被当前 agent 预设停用') ? 'blocked' : `other: ${error.message}`
    }
  }

  // 核心回归点：header 说是 standard-gitbash，但事件流已切到 companion-mode ——
  // 旧实现（只读 header）在这里返回 'ok'，新实现必须拦。
  check('切档后按事件流判定：被停用', await attempt('agent-switched'), 'blocked')
  check('从未切档：回落 header 档（不在名单）', await attempt('agent-never-switched'), 'ok')
  check('事件流不可读：回落 header 档且不抛错', await attempt('agent-broken-events'), 'ok')

  console.log('\n名单为空时不扫事件流（W1 回归：每 step 全量折叠 ownEvents 纯属浪费）')
  {
    // isDisabledFor 被 shouldInject 每 step 调两次（section + context 各一次）、
    // 被每个工具调用再调。名单为空（默认配置）时结果恒 false —— presetOf()
    // 的全事件流折叠必须被跳过。行为级验证：给会话挂一个**计数**的 ownEvents，
    // 名单为空时一次都不该被读。
    writeSettings(paths, { enabled: true, journal: true, disabledPresets: [] })

    let eventsRead = 0
    sessions['agent-counted'] = {
      header: { agentPreset: 'standard-gitbash', cwd: 'D:\\proj' },
      ownEvents: () => { eventsRead++; return [] },
    }

    check('空名单下工具可用', await attempt('agent-counted'), 'ok')
    check('空名单不读事件流', eventsRead, 0)

    // 反向保护：短路不能把真正的停用判断也短路掉 —— 名单非空时事件流
    // 折叠必须发生，命中时照常拦截。
    writeSettings(paths, { disabledPresets: ['standard-*'] })
    eventsRead = 0
    check('非空名单命中时被拦', await attempt('agent-counted'), 'blocked')
    check('非空名单才读事件流', eventsRead > 0, true)
    writeSettings(paths, { disabledPresets: [] })
  }
}

console.log('\n停用预设下工具从会话可见列表消失（per-scope tools.restrict）')
{
  // 需求语义：「等价于该预设下没有本插件」。assertPresetAllowed 只拦**调用**，
  // 工具仍会出现在 request/header 的工具列表里 —— 模型看得到工具与描述。
  // 新增的 agent/created + agent-preset/selected 监听器在命中名单时对该会话的
  // scope 调 tools.restrict({ deny })，工具从该会话的 view().visible 消失；
  // 切走时摘掉 restriction，工具恢复可见。
  writeSettings(paths, { enabled: true, journal: true, disabledPresets: ['companion-mode'] })

  const { apply } = await import('../src/index.js')

  // ---- fake tools registry：per-scope restriction，模拟 dsh-tools 的可见性解析
  // ⚠️ 结构对齐真实 agent ctx：tools 服务挂在其下（agentCtx.tools.view/restrict）。
  const GLOBAL_TOOLS = new Set([TOOL_WRITE, TOOL_SEARCH, TOOL_READ, TOOL_FORGET, TOOL_JOURNAL, 'other_tool'])
  const makeScopedTools = () => {
    const state = { restrictions: [] }
    const tools = {
      view: () => ({
        visible: new Set([...GLOBAL_TOOLS].filter((n) => state.restrictions.every((r) => !r.deny.includes(n)))),
        restrictableNames: new Set(GLOBAL_TOOLS),
      }),
      // restrict 在真实 dsh-tools 里要求 scoped ctx；这里只断言收到 deny 名单。
      restrict: (filter) => { state.restrictions.push(filter); return () => { state.restrictions.splice(state.restrictions.indexOf(filter), 1) } },
    }
    return { ctx: { tools }, count: () => state.restrictions.length }
  }

  // ---- fake ctx：记录事件监听器，模拟事件派发
  const listeners = new Map()
  const sessions = new Map()
  const agents = new Map() // sessionId -> fake agent ctx
  const hooks = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined),
    inject: (names, fn) => { hooks.set(names.join('+'), fn) },
    on: (event, fn) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    },
  }

  apply(ctx, { dshHome: SANDBOX })
  hooks.get('tools')({
    tools: { register: () => () => {} },
    effect: () => {},
  })

  // 模拟一次会话创建 + blank 窗口内切到停用预设（真机主路径：
  // agent/created 时还没切（事件流为空，折叠回落 header 档），selected 事件
  // 由官方 append 到会话事件流并广播 —— 所以 fake session 的 ownEvents 用
  // **可变数组**，dispatch selected 时同步 push，模拟真实 append。
  const createdEvents = []
  const createdSession = {
    id: 'sess-a',
    header: { agentPreset: 'standard-gitbash', cwd: 'D:\\proj' },
    ownEvents: () => createdEvents,
  }
  sessions.set('sess-a', createdSession)
  const scopeA = makeScopedTools()
  agents.set('sess-a', scopeA.ctx)
  for (const fn of listeners.get('agent/created') ?? []) fn({ agent: { id: 'sess-a', ctx: scopeA.ctx, session: createdSession } })
  check('agent/created（未命中）时未收窄', scopeA.count(), 0)

  // blank 窗口内切档：官方先 append 事件再广播 (sessionId, presetId)。
  createdEvents.push({ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } })
  for (const fn of listeners.get('agent-preset/selected') ?? []) fn('sess-a', 'companion-mode')
  check('切到停用预设后收窄挂上', scopeA.count(), 1)
  check('可见列表不含 memory 工具', [...scopeA.ctx.tools.view().visible].filter((n) => n.startsWith('memory_md')).length, 0)
  check('其他工具不受影响', scopeA.ctx.tools.view().visible.has('other_tool'), true)

  // 切回非停用预设：摘掉 restriction，工具恢复可见。
  createdEvents.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard-gitbash' } })
  for (const fn of listeners.get('agent-preset/selected') ?? []) fn('sess-a', 'standard-gitbash')
  check('切走后 restriction 摘除', scopeA.count(), 0)
  check('切走后 memory 工具恢复可见', [...scopeA.ctx.tools.view().visible].filter((n) => n.startsWith('memory_md')).length, 5)

  // 从创建起就是停用预设（恢复旧会话）：agent/created 时直接挂上。
  const restoredSession = {
    id: 'sess-b',
    header: { agentPreset: 'companion-mode', cwd: 'D:\\proj' },
    ownEvents: () => [],
  }
  sessions.set('sess-b', restoredSession)
  const scopeB = makeScopedTools()
  agents.set('sess-b', scopeB.ctx)
  for (const fn of listeners.get('agent/created') ?? []) fn({ agent: { id: 'sess-b', ctx: scopeB.ctx, session: restoredSession } })
  check('创建即停用预设：直接收窄', scopeB.count(), 1)
  check('创建即停用：列表不含 memory 工具', [...scopeB.ctx.tools.view().visible].filter((n) => n.startsWith('memory_md')).length, 0)

  // 销毁：Map 清理 + disposer 被调（真实 dsh-tools 里 effect 随 scope 自灭，
  // 这里显式调是为了让 fake registry 的计数归零可断言）。
  for (const fn of listeners.get('agent/disposed') ?? []) fn({ agent: { id: 'sess-b', session: restoredSession } })
  check('销毁后 disposer 已执行', scopeB.count(), 0)

  // per-session 隔离：A 收窄不影响 B。
  check('A 会话的收窄不影响 B 会话', scopeA.count(), 0)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
