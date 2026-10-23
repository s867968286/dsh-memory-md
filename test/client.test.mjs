/**
 * client.test.mjs — 静态检查 client 半的外部依赖与注册契约。
 *
 * 背景（真事故）：两个设置页都变成「裸 HTML」。根因是它们的 client 顶层
 * `require('@deepseek-ai/dsh-client-ui-primitives')`，而**当时**该包在 DSH 里
 * 已不存在。factory 一抛错，`apply` 就从不执行 → 样式永不注入 → 整页裸样式。
 *
 * 现状（2026-10-19 更新）：该包在 0.2.1-rc.2 里回来了，是前端 shell 的静态
 * 模块（与 `slots`、`dockkit` 并列），因此 `Switch` 恢复可用。但**上面那条
 * 教训不变**：client 半新增任何外部 `require` 都要先确认它真的存在，并同步
 * 更新下面的白名单 —— 这正是这个测试存在的理由。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')

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

/**
 * client 半允许 require 的模块。
 *
 * 只列**实际 require 的**：`dsh-client-ui-settings` 是 package.json 里
 * `dsh.client.inject` 的声明（表示依赖该插件先加载），不是 require 目标。
 */
const ALLOWED = new Set([
  'react',
  // 设置页的开关改用官方 Switch（自绘那份的圆角与「通用设置」对不上）。
  // 该包是前端 shell 的静态模块，已确认其导出含 Switch。
  '@deepseek-ai/dsh-client-ui-primitives',
])

console.log('\n外部依赖白名单')
{
  // 抓出所有 require('...') 的字面量（含被注释掉的不算 —— 先剥注释）。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  const specifiers = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const unique = [...new Set(specifiers)].sort()

  check('只 require 白名单内的模块', unique, [...ALLOWED].sort())

  // 白名单之外一个都不许有：曾经就是多 require 了一个当时不存在的包，
  // 导致整个 factory 抛错、apply 从不执行，设置页变成裸 HTML。
  const unexpected = unique.filter((name) => !ALLOWED.has(name))
  check('没有白名单之外的 require', unexpected, [])
}

console.log('\n注册契约')
{
  check('用官方模块加载器', source.includes('window.__ModuleLoader__.load'), true)
  check('声明 id', /id:\s*'dsh-memory-md'/.test(source), true)
  check('注册到 settings.section', source.includes("slots.inject('settings.section'"), true)
  check('声明 inject: [slots]', /inject:\s*\[\s*'slots'\s*\]/.test(source), true)
  check(
    'section id 与别的插件不撞',
    /id:\s*SECTION_ID/.test(source) && /SECTION_ID\s*=\s*'memory-md'/.test(source),
    true,
  )
}

console.log('\n样式自足')
{
  // 必须自带 <style>，不能依赖官方 primitives 的样式。
  check('自带样式表', source.includes('document.createElement(\'style\')'), true)
  check('样式标签有唯一标识', source.includes("data-memory-md-css"), true)
  // 所有元素类名都带 mmd- 前缀，避免和别的插件互相覆盖。
  const classNames = [...source.matchAll(/className:\s*'([^']+)'/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean)
  const foreign = classNames.filter((c) => !c.startsWith('mmd-'))
  check('类名统一 mmd- 前缀', foreign, [])
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
