/**
 * layout.test.mjs — 记忆目录布局与错误日志。
 *
 * 布局约定（每个作用域一致）：
 *
 *   <scope>/MEMORY.md        索引（唯一入口，注入用）
 *   <scope>/memory/*.md      记忆正文
 *   <scope>/.journal/*.md    工作留痕（只写不读）
 *
 * 三者同级。正文放子目录让作用域根干净，并与 `.journal/` 对称。
 *
 * 注：**历史数据的搬迁不在这里** —— 那是一次性运维动作（见 README 的迁移说明），
 * 不是插件运行时行为。插件只保证「新写入落在正确位置」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-layout-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { appendErrorLog, MEMORY_DIR, listMemoryFiles, memoryFilePath, writeMemory } =
  await import('../src/store.mjs')

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

const DIR = join(SANDBOX, 'global')

try {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })

  console.log('\n新写入的正文落在 memory/ 子目录')
  {
    writeMemory(DIR, {
      file: 'user_a.md',
      type: 'user',
      name: '甲',
      description: '甲描述',
      content: '正文甲',
    })
    check('正文在 memory/ 下', existsSync(join(DIR, MEMORY_DIR, 'user_a.md')), true)
    check('正文不在作用域根', existsSync(join(DIR, 'user_a.md')), false)
    check('索引在作用域根', existsSync(join(DIR, 'MEMORY.md')), true)
  }

  console.log('\n索引链接带 memory/ 前缀（否则点开找不到）')
  {
    const idx = readFileSync(join(DIR, 'MEMORY.md'), 'utf8')
    check('链接带前缀', idx.includes('](memory/user_a.md)'), true)
    check('没有裸链接', idx.includes('](user_a.md)'), false)
    // 链接必须真的能解析到文件
    const link = idx.match(/\]\(([^)]+)\)/)?.[1]
    check('链接可解析', existsSync(join(DIR, link)), true)
  }

  console.log('\n更新已有记忆：原地替换，不新增条目')
  {
    writeMemory(DIR, {
      file: 'user_a.md',
      type: 'user',
      name: '甲（改）',
      description: '新描述',
      content: '正文甲改了',
    })
    const idx = readFileSync(join(DIR, 'MEMORY.md'), 'utf8')
    check('索引只有一条', idx.split('\n').filter((l) => l.startsWith('- ')).length, 1)
    check('条目被更新', idx.includes('甲（改）'), true)
    check('正文已更新', readFileSync(join(DIR, MEMORY_DIR, 'user_a.md'), 'utf8').includes('正文甲改了'), true)
  }

  console.log('\nlistMemoryFiles 只扫 memory/ 子目录（不递归）')
  {
    // 作用域根放个 .md，不该被当成记忆
    writeFileSync(join(DIR, 'stray.md'), '---\ntype: user\n---\n\n杂项\n', 'utf8')
    // memory/ 下放个子目录，也不该递归进去
    mkdirSync(join(DIR, MEMORY_DIR, 'nested'), { recursive: true })
    writeFileSync(join(DIR, MEMORY_DIR, 'nested', 'deep.md'), '---\ntype: user\n---\n\n深\n', 'utf8')

    const list = listMemoryFiles(DIR)
    check('不含作用域根的 stray.md', list.includes('stray.md'), false)
    check('含 memory/ 里的正文', list.includes('user_a.md'), true)
    check('不含索引 MEMORY.md', list.includes('MEMORY.md'), false)
    check('不递归进子目录', list.includes('deep.md'), false)
  }

  console.log('\nmemoryFilePath 指向 memory/')
  {
    check('路径正确', memoryFilePath(DIR, 'x.md'), join(DIR, MEMORY_DIR, 'x.md'))
  }

  console.log('\n错误日志：追加写、带时间戳、不进 .journal')
  {
    const logFile = join(SANDBOX, 'error.log')
    appendErrorLog(logFile, '第一条错误')
    appendErrorLog(logFile, '第二条  错误\n带换行')
    const text = readFileSync(logFile, 'utf8')
    check('两条都在', text.includes('第一条错误') && text.includes('第二条'), true)
    check('每条一行（换行被压平）', text.trim().split('\n').length, 2)
    check('带时间戳前缀', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  /.test(text), true)
    // 错误日志与作用域无关，不在任何 .journal/ 里
    check('不在 .journal 里', logFile.includes('.journal'), false)
  }

  console.log('\n错误日志失败时静默（不能再抛错）')
  {
    let threw = false
    try {
      appendErrorLog('\u0000bad', 'x')
      appendErrorLog(undefined, 'x')
      appendErrorLog(join(SANDBOX, 'error.log'), '')
    } catch {
      threw = true
    }
    check('不抛错', threw, false)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
