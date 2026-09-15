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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
