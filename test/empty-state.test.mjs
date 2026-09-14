/**
 * 设置页的「少即是多」检查。
 *
 * 三轮简化后的最终契约：**设置页只有开关 + 三条固定路径。**
 *   1. 不补任何空状态提示文案；
 *   2. 不列出具体条目，也不显示任何记忆卡片与计数；
 *   3. 不显示任何**会话相关**的路径（项目级 / 当前工作区 / 留痕目录）——
 *      设置页拿不到「当前会话」，猜出来的路径在切换会话后就是错的。
 *
 * 用剥掉注释的源码做断言：注释里解释「为什么去掉」而提到旧类名，不算残留。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/** 剥掉两种注释，只留可执行代码。 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

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

console.log('\n不补空状态文案')
{
  check('无 emptyHint 参数', /emptyHint/.test(code), false)
  check('无「还没有内容」文案', code.includes('还没有内容'), false)
  check('无「自动创建」文案', code.includes('自动创建'), false)
}

console.log('\n不列出条目、不显示卡片与计数')
{
  // 条目清单已按要求移除 —— 连样式带渲染一起删，不留死代码。
  check('无条目清单样式', /mmd-list/.test(code), false)
  check('无单条条目样式', /mmd-item/.test(code), false)
  check('无条目渲染分支', /scope\.memories\.map/.test(code), false)
  // 用户级卡片连同计数一并去掉：设置页不展示记忆内容或规模。
  check('无用户级卡片', code.includes('用户级记忆'), false)
  check('无 IndexCard 组件', code.includes('IndexCard'), false)
  check('无「N 条」计数', /条`/.test(code), false)
  // 随之废弃的样式也不该留。
  check('无徽章样式', /mmd-badge/.test(code), false)
  check('无空态样式', /mmd-empty/.test(code), false)
}

console.log('\n不显示任何会话相关的路径（切换会话后会显示错的那个）')
{
  // 项目级目录依赖「当前会话」，设置页拿不到；Host 半只能按 sessions.list()
  // 的创建顺序猜，于是切换会话后仍显示上一个会话的路径。整块去掉。
  check('无项目级卡片', code.includes('项目级记忆'), false)
  // 精确匹配「路径行」而不是任意提及：留痕说明文案里也有「当前工作区」四个字。
  check('无当前工作区路径行', code.includes('当前工作区  '), false)
  check('无留痕目录行', code.includes('留痕目录'), false)
}

console.log('\n只留三条与会话无关的路径')
{
  check('保留记忆目录', code.includes('记忆目录'), true)
  check('保留用户级目录', code.includes('用户级目录'), true)
  check('保留设置文件', code.includes('设置文件'), true)
  // 开关仍在（这是设置页的主要职责）。
  check('保留启用记忆开关', code.includes("setRow('enabled'"), true)
  check('保留工作留痕开关', code.includes("setRow('journal'"), true)
  check('保留预设停用名单', code.includes('presetRow'), true)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
