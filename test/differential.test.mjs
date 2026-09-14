/**
 * Differential test: 移植版 vs CodeBuddy 2.150.0 真实 bundle。
 *
 * bundle 是 webpack 产物，测试把它里面的纯函数源码抽出来单独求值，
 * 逐例比对。抽不出来就报错，而不是静默通过。
 *
 * 只覆盖**仍在用**的函数：
 *   - getCompressedWorkDir()       路径 → slug
 *   - truncateEntrypointContent()  索引截断
 *
 * 原版的 truncateMemoryEntrypoint()（legacy 路径：200 行 / 25e3 字节）已被
 * 移除 —— 本插件只走 typed 路径，保留它属于死代码。
 */
import { readFileSync } from 'node:fs'
import { getCompressedWorkDir, truncateEntrypointContent } from '../src/codebuddy-port.mjs'

const BUNDLE = 'D:/soft/node/node-v22.23.2/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy.js'
const source = readFileSync(BUNDLE, 'utf8')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}\n       actual:   ${a}\n       expected: ${e}`)
  }
}

/* ---------- 从 bundle 抽出真实实现 ---------- */

// truncateEntrypointContent(ei) 用到自由变量 ed.ec (200) 与 ed.y0 (4e4)。
const teStart = source.indexOf('function truncateEntrypointContent')
const teEnd = source.indexOf('function buildSearchingPastContextSection', teStart)
const teSrc = source.slice(teStart, teEnd)

let realTruncateEntrypointContent = null
try {
  realTruncateEntrypointContent = new Function(
    'ed',
    `${teSrc}; return truncateEntrypointContent`,
  )({ ec: 200, y0: 4e4, rw: 'MEMORY.md' })
} catch (error) {
  console.log(`  FAIL 无法从 bundle 抽出函数: ${error.message}`)
  failures++
}

/* ---------- truncateEntrypointContent ---------- */

console.log('\ntruncateEntrypointContent (200 行 / 4e4 字符)')
if (realTruncateEntrypointContent) {
  // ⚠️ 比对**截断逻辑**（保留哪些行、怎么按换行回退），**不含警告文案** ——
  // 警告文案我们有意汉化了（它是注入给模型的文本，应与其余提示词语言一致）。
  // 所以比对时把警告段剥掉只比正文，并且「是否截断」的标志也要一致。
  const bodyOf = (result) => String(result?.content ?? '').split('\n\n> ')[0]
  const compare = (name, input) => {
    const ours = truncateEntrypointContent(input)
    const theirs = realTruncateEntrypointContent(input)
    check(`${name}（正文）`, bodyOf(ours), bodyOf(theirs))
    check(`${name}（标志）`,
      [ours.wasLineTruncated, ours.wasCharTruncated, ours.lineCount, ours.charCount],
      [theirs.wasLineTruncated, theirs.wasCharTruncated, theirs.lineCount, theirs.charCount])
  }

  const cases = {
    '短文本': 'hello\nworld',
    '恰好 200 行': Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
    '201 行': Array.from({ length: 201 }, (_, i) => `line ${i}`).join('\n'),
    '超长单行 (>40K 字符)': 'y'.repeat(50000),
    '多行且超字符上限': Array.from({ length: 300 }, (_, i) => `line ${i} `.padEnd(300, 'z')).join('\n'),
    '中文多行': Array.from({ length: 260 }, (_, i) => `- [条目${i}](f${i}.md) \u2014 描述${i}`).join('\n'),
    '空串': '',
  }
  for (const [name, input] of Object.entries(cases)) compare(name, input)

  // 汉化后的警告仍须表达「记忆不全」+ 处置建议 —— 这是它存在的理由。
  console.log('\n截断警告（汉化后仍须表达「不全」）')
  {
    const cut = truncateEntrypointContent(
      Array.from({ length: 260 }, (_, i) => `- [条目${i}](f${i}.md) — 描述`).join('\n'),
    )
    check('含警告词', cut.content.includes('警告'), true)
    check('说明只加载一部分', cut.content.includes('只加载了一部分'), true)
    check('给出溢出量', cut.content.includes('260 行'), true)
    check('给出处置建议', cut.content.includes('索引条目请保持一行'), true)
  }
}

/* ---------- getCompressedWorkDir ---------- */

console.log('\ngetCompressedWorkDir')
// bundle 里的原实现依赖运行时内部结构，这里校验文档化的契约。
check('windows 路径', getCompressedWorkDir('D:\\workspaces\\ai\\dsh-memory-md'), 'd-workspaces-ai-dsh-memory-md')
check('posix 路径', getCompressedWorkDir('/home/user/proj'), 'home-user-proj')
check('大小写混合', getCompressedWorkDir('C:\\WorkSpace\\MyApp'), 'c-workspace-myapp')
check('结尾分隔符', getCompressedWorkDir('D:\\a\\b\\'), 'd-a-b')
check('正斜杠', getCompressedWorkDir('D:/workspaces/ai/x'), 'd-workspaces-ai-x')

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
