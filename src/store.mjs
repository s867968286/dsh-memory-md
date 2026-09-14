/**
 * store.mjs — 记忆目录的读写原语。
 *
 * 这些函数原先内联在 `tools.mjs` 里。后台总结（`summarize.mjs`）也要用同一套
 * 写入语义（原子替换、索引维护、日志分批），所以抽到这里共用 —— 两处各写一份
 * 迟早会漂移，而「索引格式」和「日志格式」正是本插件对外承诺的东西。
 *
 * 全部是**同步**的：读取→拼接→原子替换必须一口气做完，中间不能 await，
 * 否则两次并发写会各自基于同一份旧内容拼接，后写的覆盖先写的。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { MEMORY_ENTRYPOINT, parseMemoryFrontmatter } from './codebuddy-port.mjs'

/**
 * 文件名合法性。
 *
 * 必须接受非 ASCII：插件自己用 `memory_md_save` 从中文标题派生的文件名就是
 * `reference_数据库端口.md`。这里只做两件事——必须以 `.md` 结尾，且不含任何
 * 路径分隔符或 `..`（防目录穿越）。具体允许的字符交给文件系统。
 */
const SAFE_FILE = /^[^/\\:*?"<>|]+\.md$/
export const isSafeFile = (name) => SAFE_FILE.test(name) && !name.includes('..')

/** 读文本；不存在或读失败返回 undefined。 */
export const readText = (path) => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * 原子写：先写临时文件再改名，避免半截文件。
 *
 * 临时文件名必须**唯一**：只用 `<path>.<pid>.tmp` 时，同进程内两次并发写
 * 会共用同一个临时文件，后写的覆盖先写的，然后两次 rename 搬走同一份内容
 * —— 一条记录就此静默消失。加上随机后缀，让每次写各占一个临时文件。
 */
export function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    // 失败时别留下垃圾临时文件。
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 忽略 */
    }
    throw error
  }
}

/** 统计日志条目数（以 `- ` 开头的行）。 */
export function countEntries(text) {
  if (text === undefined) return 0
  return text.split('\n').filter((l) => l.startsWith('- ')).length
}

/** `HH:MM:SS`（本地时间）—— 每次写日志操作的时间戳。 */
export function timeStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/**
 * 追加一批日志，返回新内容。
 *
 * 每次调用（= 一次写日志操作）开一个 `## HH:MM:SS` 小节，条目列在下面：
 *
 *   # 2026-09-13
 *
 *   ## 14:32:07
 *   - 修了分隔符 bug
 *   - 补了并发测试
 *
 *   ## 15:08:41
 *   - 加了轮末提醒
 *
 * 这样「同一天里分几次写的」一眼可见，不必靠猜条目顺序。
 *
 * 纯函数：读取→拼接必须一次性做完再原子替换，中间不能 await。
 */
export function appendJournalEntries(existing, date, notes, stamp) {
  const header = existing === undefined ? `# ${date}\n` : existing.replace(/\s*$/, '\n')
  const block = [`## ${stamp}`, ...notes.map((n) => `- ${n}`)].join('\n')
  return `${header}\n${block}\n`
}

/**
 * 把一批条目追加到当天的日志文件。
 *
 * @returns 写入结果；`notes` 为空时不落盘。
 */
export function appendJournal(dir, date, notes, stamp) {
  if (!Array.isArray(notes) || notes.length === 0) return undefined
  const path = join(dir, `${date}.md`)
  const before = readText(path)
  const after = appendJournalEntries(before, date, notes, stamp)
  writeAtomic(path, after)
  return { path, entries: notes.length, total: countEntries(after) }
}

/**
 * 记忆正文的子目录名。
 *
 * 目录结构（每个作用域一致）：
 *
 *   <scope>/MEMORY.md        索引（唯一入口，注入用）
 *   <scope>/memory/*.md      记忆正文 ← 本常量
 *   <scope>/.journal/*.md    工作留痕（只写不读）
 *
 * 三者同级。正文放子目录有三个好处：
 *   1. 作用域根目录干净 —— 只有索引与两个子目录，人工翻看时一眼看清结构；
 *   2. `.journal/` 与 `memory/` 对称，都明确是"按用途分的子目录"；
 *   3. 未来要加别的子目录（如 `error/`）时不会与正文平铺混在一起。
 */
export const MEMORY_DIR = 'memory'

/**
 * 列出某个作用域下已存在的记忆正文文件（只扫 `memory/` 子目录，**不递归**）。
 *
 * 不递归是刻意的：`MEMORY.md`（索引）在作用域根、`.journal/` 在另一个子目录，
 * 都不该被当成"记忆正文"混进来。
 */
export function listMemoryFiles(dir) {
  const memoryDir = join(dir, MEMORY_DIR)
  try {
    if (!existsSync(memoryDir)) return []
    return readdirSync(memoryDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== MEMORY_ENTRYPOINT)
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 把一行追加到索引（不存在则创建并加标题）。
 *
 * `file` 是**相对作用域的链接路径**（如 `memory/user_x.md`）—— 索引在作用域根，
 * 正文在 `memory/`，所以链接必须带上子目录，否则点开找不到文件。
 */
export function upsertIndexLine(indexPath, file, title, description) {
  const line = `- [${title}](${file}) \u2014 ${description}`
  const existing = readText(indexPath)
  if (existing === undefined) {
    writeAtomic(indexPath, `# ${MEMORY_ENTRYPOINT}\n\n${line}\n`)
    return
  }
  // 已存在同文件的条目 → 原地替换，避免重复
  const lines = existing.split('\n')
  const idx = lines.findIndex((l) => l.includes(`](${file})`))
  if (idx >= 0) {
    lines[idx] = line
    writeAtomic(indexPath, lines.join('\n'))
    return
  }
  const trimmed = existing.replace(/\s*$/, '')
  writeAtomic(indexPath, `${trimmed}\n${line}\n`)
}

/**
 * 写一条记忆：正文 + frontmatter，并同步索引。
 *
 * 正文写进 `<dir>/memory/<file>`，索引行链接写成 `memory/<file>`。
 * 索引仍在作用域根的 `MEMORY.md`。
 */
export function writeMemory(dir, { file, type, name, description, content }) {
  const path = join(dir, MEMORY_DIR, file)
  const created = readText(path) === undefined
  const body = String(content ?? '').trim()
  const frontmatter = ['---', `name: ${name}`, `description: ${description}`, `type: ${type}`, '---', '']
  writeAtomic(path, `${frontmatter.join('\n')}\n${body}\n`)
  // 索引链接带 `memory/` 前缀 —— 索引在根、正文在子目录。
  upsertIndexLine(join(dir, MEMORY_ENTRYPOINT), `${MEMORY_DIR}/${file}`, name, description)
  return { path, created }
}

/** 一个记忆正文文件的完整路径。 */
export function memoryFilePath(dir, file) {
  return join(dir, MEMORY_DIR, file)
}

/**
 * 往错误日志追加一行。
 *
 * **位置**：与 `settings.json` 同一层（`<memoryRoot>/error.log`）——
 * 排查问题时看这一层就够，不必翻进各作用域目录。
 *
 * **绝不写进 `.journal/`**：那是"今天做了什么"的留痕，是给人读的叙事；
 * 把"异步写日志失败"这类错误混进去只会污染它（这条是用户明确要求的）。
 *
 * 错误日志本身失败时**静默吞掉** —— 记错误日志的动作不能再抛错，
 * 否则会把它所保护的那条路径也带崩。
 */
export function appendErrorLog(errorLogFile, message) {
  try {
    if (typeof errorLogFile !== 'string' || !errorLogFile) return
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const oneLine = String(message ?? '').replace(/\s+/g, ' ').trim()
    if (!oneLine) return
    mkdirSync(dirname(errorLogFile), { recursive: true })
    appendFileSync(errorLogFile, `${stamp}  ${oneLine}\n`, 'utf8')
  } catch {
    /* 错误日志失败不能再抛错 */
  }
}

/** 把标题转成安全的文件名片段。 */
export function slugify(text) {
  return (
    String(text ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'memory'
  )
}
