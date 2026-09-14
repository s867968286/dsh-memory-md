#!/usr/bin/env node
/**
 * migrate-memory-layout.mjs — 把记忆正文从作用域根搬进 `memory/` 子目录。
 *
 * ## 为什么是脚本，不是插件代码
 *
 * 目录结构改过一次：正文原本平铺在作用域根（`<scope>/user_x.md`），与索引
 * `MEMORY.md`、日志 `.journal/` 混在一起；现在统一收进 `<scope>/memory/`。
 *
 * **新写入本来就会落在正确位置** —— 所以只有**历史数据**需要搬，那是一次性运维
 * 动作，不该变成插件每次启动都执行的运行时代码（那是把运维逻辑混进产品逻辑）。
 *
 * ## 什么时候要再跑一次
 *
 * 改了目录结构但**还没重启 DSH** 时，旧进程仍在按旧路径写新文件。
 * 重启后那些文件会散在作用域根 —— 再跑一次本脚本即可。
 * 脚本幂等：已经搬过的不会再动，没得搬时直接报「无事可做」。
 *
 * ## 用法
 *
 *   node scripts/migrate-memory-layout.mjs                  # 搬（默认 ~/.dsh/memory-md）
 *   node scripts/migrate-memory-layout.mjs --dry-run        # 只看会做什么，不落盘
 *   node scripts/migrate-memory-layout.mjs --root <目录>    # 指定记忆根目录
 *
 * ## 安全
 *
 * - **只搬带 `type:` frontmatter 的真记忆** —— 别的东西（说明文件、备份等）一律不动；
 * - 目标已存在 → **跳过并报告，绝不覆盖**；
 * - 只 `rename`（同盘原子），**不改内容**；
 * - 全程先备份提示，`--dry-run` 可先看一遍。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEMORY_ENTRYPOINT = 'MEMORY.md'
const MEMORY_DIR = 'memory'

/** 四种记忆类型 —— 只认这些的 frontmatter 才当记忆正文。 */
const MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run') || argv.includes('-n')

function argValue(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

const ROOT = argValue('--root') ?? process.env.DSH_MEMORY_ROOT ?? join(homedir(), '.dsh', 'memory-md')

/**
 * 判一个文件是否是记忆正文。
 *
 * 判据是 frontmatter 里有**已知的** `type:` —— 不是"有 type 就行"：
 * 别的工具也可能写 frontmatter，只认我们自己那四种类型才不会误搬。
 */
function isMemoryBody(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  const type = m[1].match(/^type:\s*(\S+)\s*$/m)?.[1]
  return Boolean(type && MEMORY_TYPES.has(type))
}

/** 找出所有作用域目录：含 `MEMORY.md` 的直接子目录。 */
function findScopes(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // 只认含索引的目录 —— 避免把 `error/`、备份目录之类也当作用域扫。
    .filter((name) => existsSync(join(root, name, MEMORY_ENTRYPOINT)))
}

console.log(`记忆根目录  ${ROOT}`)
console.log(dryRun ? '模式        干跑（不落盘）\n' : '模式        实际执行\n')

if (!existsSync(ROOT)) {
  console.log('目录不存在 —— 无事可做。')
  process.exit(0)
}

const scopes = findScopes(ROOT)
if (scopes.length === 0) {
  console.log('没有找到含 MEMORY.md 的作用域 —— 无事可做。')
  process.exit(0)
}
console.log(`作用域 ${scopes.length} 个：${scopes.join('、')}\n`)

let totalMoved = 0
let totalIndexFixed = 0
const skipped = []

for (const scope of scopes) {
  const dir = join(ROOT, scope)
  const memoryDir = join(dir, MEMORY_DIR)

  // 待搬清单：作用域根的 .md，排除索引本身，且必须是真记忆。
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== MEMORY_ENTRYPOINT)
    .map((e) => e.name)

  const moved = []
  const notMemory = []
  for (const name of candidates) {
    const text = readFileSync(join(dir, name), 'utf8')
    if (!isMemoryBody(text)) { notMemory.push(name); continue }

    const to = join(memoryDir, name)
    if (existsSync(to)) {
      skipped.push(`[${scope}] ${MEMORY_DIR}/${name} 已存在 —— 跳过，原文件保留在作用域根`)
      continue
    }
    if (!dryRun) {
      mkdirSync(memoryDir, { recursive: true })
      renameSync(join(dir, name), to)
    }
    moved.push(name)
  }

  // 修正索引链接：`](name.md)` → `](memory/name.md)`。
  const indexPath = join(dir, MEMORY_ENTRYPOINT)
  let indexFixed = 0
  if (moved.length > 0) {
    const index = readFileSync(indexPath, 'utf8')
    let next = index
    for (const name of moved) {
      const before = next
      next = next.split(`](${name})`).join(`](${MEMORY_DIR}/${name})`)
      if (next !== before) indexFixed++
    }
    if (next !== index && !dryRun) writeFileSync(indexPath, next, 'utf8')
  }

  totalMoved += moved.length
  totalIndexFixed += indexFixed

  const bits = [`搬走 ${moved.length} 个`]
  if (indexFixed > 0) bits.push(`修正索引链接 ${indexFixed} 条`)
  if (notMemory.length > 0) bits.push(`非记忆文件不动 ${notMemory.length} 个`)
  console.log(`[${scope}] ${bits.join('，')}`)
  if (notMemory.length > 0) {
    for (const n of notMemory) console.log(`           · 不动（无已知 type）：${n}`)
  }
}

console.log()
if (totalMoved === 0) {
  console.log('无事可做 —— 所有记忆正文都已在正确位置。')
} else {
  console.log(`${dryRun ? '将会' : '已'}搬走 ${totalMoved} 个记忆正文` +
    (totalIndexFixed > 0 ? `，修正 ${totalIndexFixed} 条索引链接` : ''))
  if (dryRun) console.log('\n（干跑模式：没有改动任何文件。去掉 --dry-run 才会实际执行。）')
}

if (skipped.length > 0) {
  console.log('\n需要人工确认（未覆盖、未删除）：')
  for (const s of skipped) console.log('  ⚠ ' + s)
}
