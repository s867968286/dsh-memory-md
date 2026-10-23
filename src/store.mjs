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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { MEMORY_ENTRYPOINT, MEMORY_TYPES, parseMemoryFrontmatter } from './codebuddy-port.mjs'

/**
 * 生成 manifest 时每个文件最多读多少字符。
 *
 * manifest 只要 `name` / `description` / `type` 三个字段，它们都在文件头的
 * frontmatter 里。正文可能有几 KB，全读进来纯属浪费 —— CodeBuddy 的
 * `readFileHead()` 出于同一理由只读文件头。
 *
 * 取 2000：足够容纳一个写得很长的 description，又远小于典型正文。
 */
export const FRONTMATTER_HEAD_CHARS = 2000

/**
 * 一份 manifest 最多列多少条。
 *
 * 上限的意义是**控制喂给模型的提示词体积**，不是限制记忆总数 ——
 * 记忆本身不设条数上限（超限由人工优化）。清单里只放最近改动的那些，
 * 模型据此判断"是不是已经有类似的了"已经够用。
 */
export const MANIFEST_MAX_ENTRIES = 200

/**
 * 文件名合法性。
 *
 * 必须接受非 ASCII：插件自己用 `memory_md_save` 从中文标题派生的文件名就是
 * `reference_数据库端口.md`。这里只做两件事——必须以 `.md` 结尾，且不含任何
 * 路径分隔符或 `..`（防目录穿越）。具体允许的字符交给文件系统。
 */
const SAFE_FILE = /^[^/\\:*?"<>|]+\.md$/
export const isSafeFile = (name) => SAFE_FILE.test(name) && !name.includes('..')

/**
 * 记忆正文的保留文件名：索引 `MEMORY.md`（`MEMORY_ENTRYPOINT`）**不是**记忆正文。
 *
 * ## 为什么必须显式排除
 *
 * 索引在作用域**根**、正文在 `memory/` 子目录（见 `MEMORY_DIR`）。而
 * `isSafeFile('MEMORY.md')` 单看文件名是合法的 —— 没有 `normalizeMemoryFile()`
 * 这道闸时，`memory_md_save file="MEMORY.md"` 会在 `memory/` 里写出一个同名
 * 正文、再往索引里加一条指向它的死链，`memory_md_forget` 同理。
 *
 * 三个消费方（save / forget / read）都从 `normalizeMemoryFile()` 过这道闸，
 * 所以这里收口一次，三处同时生效。
 *
 * @returns true 表示该名字是索引，不能当正文处理。
 */
export const isEntrypointName = (name) => name === MEMORY_ENTRYPOINT

/**
 * 把模型给的 `file` 参数归一成**纯文件名**；不合法时返回 undefined。
 *
 * ## 为什么必须做这一步
 *
 * 我们自己写进索引的链接是**带 `memory/` 前缀**的（`writeMemory()` 那行
 * `upsertIndexLine(..., \`${MEMORY_DIR}/${file}\`, ...)`），因为索引在作用域根、
 * 正文在子目录，相对路径必须这么写才对得上。
 *
 * 但工具只接受纯文件名。于是模型**从索引里复制路径**这一最自然的用法
 * 100% 失败 —— `isSafeFile('memory/foo.md')` 会因斜杠被拒。这不是模型手误，
 * 是数据形态与工具契约不一致导致的系统性诱导。
 *
 * 因此读取端宽容：剥掉作用域目录前缀后仍然只认文件名。
 *
 * ## 为什么这不削弱安全
 *
 * `isSafeFile` 的本职是**防目录穿越**（见上方注释），不是要求调用方格式。
 * 这里白名单式地只剥掉**恰好等于** `MEMORY_DIR/` 或 `./` 的前缀，
 * 剥完**仍要过一遍 `isSafeFile`** —— `../../etc/passwd`、`a/b/c.md`
 * 之类照旧被拒，`..` 检查也依然生效。
 *
 * @param raw - 模型传来的原始值。
 * @returns 纯文件名，或 undefined（不合法/非字符串/空）。
 */
export function normalizeMemoryFile(raw) {
  if (typeof raw !== 'string') return undefined
  let name = raw.trim()
  if (!name) return undefined
  // 剥前导 `./` 与作用域目录前缀；只剥一层，剥完重新校验。
  name = name.replace(/^\.\//, '')
  if (name.startsWith(`${MEMORY_DIR}/`)) name = name.slice(MEMORY_DIR.length + 1)
  // 索引不是正文：save/forget 必须拒绝它（read 有专门的索引分支，不走这里）。
  if (isEntrypointName(name)) return undefined
  return isSafeFile(name) ? name : undefined
}

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
 * ## 条目必须一行一条
 *
 * 日志的条目结构就是「`- ` 开头的行」。一条 note 里若含换行，后半截会变成
 * **另一条独立条目**（实测：一条含换行的 note 会被 `countEntries()` 数成 2 条，
 * 于是 `memory_md_journal` 回报的 `total` 虚高，人读起来也多出一条没写过的记录）。
 *
 * 所以这里折叠空白 —— 与 `writeMemory()` 对 frontmatter 的处理同一个理由、
 * 同一套做法：契约本来就是"每条 1-3 句"，折叠不改变语义，却让结构无法被内容破坏。
 *
 * 纯函数：读取→拼接必须一次性做完再原子替换，中间不能 await。
 */
export function appendJournalEntries(existing, date, notes, stamp) {
  const header = existing === undefined ? `# ${date}\n` : existing.replace(/\s*$/, '\n')
  const block = [`## ${stamp}`, ...notes.map((n) => `- ${oneLine(n)}`)].join('\n')
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
 * 让 `memory_md_read` 的列表**包含索引条目**（`file: "MEMORY.md"`）。
 *
 * ## 为什么要有这一条
 *
 * read 的 description 承诺 `file` 可传 `"MEMORY.md"` 读索引全文，而列表是
 * 模型找"能传什么"的唯一入口 —— 列表里没有它，承诺就是空头支票（E1）。
 * 搜索工具已把索引一并扫掉（`tools.mjs` 的 targets 构造），列表口径应一致。
 *
 * 索引由插件独占维护，没有 frontmatter —— 元信息用固定值，type 标成
 * `'index'`（不在四种记忆类型里，模型不会把它当正文记忆对待）。
 *
 * ## 为什么必须回填 `scope`
 *
 * `memory_md_read` 的输出 schema 把 `scope` 标成 required，而列表里**只有**
 * 这些索引条目不是由 tools 侧拼的 —— 早先漏了这个字段，`scope=all`
 * （默认值）一调就整块输出校验失败：
 *
 *   invalid output: missing required property "value.entries[0].scope"
 *
 * 而且 `scope=all` 恰好**总是**把 global 索引排在下标 0，等于默认路径必炸。
 * 调用方只有一处（`tools.mjs` 的 read 列表），把作用域传进来即可。
 *
 * @param dir - 该作用域的记忆目录。
 * @param scope - 该目录属于哪个作用域（`global` / `project`），回填进条目。
 * @returns 索引文件不存在时返回 []；存在则单条条目。
 */
export function indexEntryFor(dir, scope) {
  const raw = readText(join(dir, MEMORY_ENTRYPOINT))
  if (raw === undefined) return []
  return [{
    scope,
    file: MEMORY_ENTRYPOINT,
    name: MEMORY_ENTRYPOINT,
    description: `记忆索引（由插件维护）。传 file="${MEMORY_ENTRYPOINT}" 可读取全文。`,
    type: 'index',
  }]
}

/**
 * 扫出某个作用域里已有的记忆条目，带元信息与修改时间。
 *
 * ## 为什么需要它
 *
 * **后台总结模型看不到记忆库** —— 它是独立 LLM 调用，只拿得到当轮转写。
 * 没有这份清单，它只能靠"别写重复的"这类文字叮嘱自律，而无从知道到底
 * 已经有什么。CodeBuddy 的做法是把这份清单喂给抽取子代理
 * （`formatMemoryManifest()`），这里吸收同一机制。
 *
 * ## 为什么带 mtime
 *
 * 两个用途：
 *   1. 按**最近修改**排序，让模型先看到最相关的条目；
 *   2. 每条附**年龄**，让模型自己判断"这条是不是太久没更新了"。
 *
 * 只读文件头（`FRONTMATTER_HEAD_CHARS`）而不是全读：清单只需要
 * `name` / `description` / `type` 三个字段，正文可能有几 KB，
 * 全部读进来纯属浪费 —— CodeBuddy 的 `readFileHead()` 同理。
 */
export function scanMemoryManifest(dir, { limit = MANIFEST_MAX_ENTRIES, now = Date.now() } = {}) {
  const memoryDir = join(dir, MEMORY_DIR)
  const rows = []
  for (const file of listMemoryFiles(dir)) {
    const path = join(memoryDir, file)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    const head = readText(path)?.slice(0, FRONTMATTER_HEAD_CHARS) ?? ''
    const { data } = parseMemoryFrontmatter(head)
    rows.push({
      file,
      name: typeof data.name === 'string' && data.name ? data.name : file.replace(/\.md$/, ''),
      description: typeof data.description === 'string' ? data.description : '',
      type: data.type ?? '',
      mtimeMs: stat.mtimeMs,
      // 整天的年龄：0 = 今天，1 = 昨天，N = N 天前。
      ageDays: Math.max(0, Math.floor((now - stat.mtimeMs) / 86_400_000)),
    })
  }
  // 最近改动的排在前面 —— 那份清单是给模型看的，顺序本身就是信号。
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { entries: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit }
}

/**
 * 把 manifest 渲染成给模型看的一段纯文本。
 *
 * 格式贴近 CodeBuddy 的 `formatMemoryManifest()`：
 *   `- [type] 文件名 (N 天前): 标题 — 描述`
 *
 * 没条目时返回空串 —— 调用方据此决定不注入这一节（"还没有任何记忆"
 * 不需要专门说一句，模型看到清单为空自然就明白）。
 */
export function formatMemoryManifest(manifest) {
  if (manifest === undefined || manifest.entries.length === 0) return ''
  return manifest.entries
    .map((e) => {
      const age = e.ageDays === 0 ? '今天' : e.ageDays === 1 ? '昨天' : `${e.ageDays} 天前`
      const type = e.type ? `[${e.type}] ` : ''
      const name = e.name ? `${e.name}: ` : ''
      return `- ${type}${e.file} (${age})${name ? ` ${name}` : ''}${e.description}`
    })
    .join('\n')
}

/**
 * 判断一行索引条目是否指向某个文件。
 *
 * ## 为什么不能只用 `line.includes(`](${file})`)`
 *
 * 那是**整行子串**匹配，会被**描述里的文字**骗到。实测过的真事故：
 *
 *   1. 先写乙：`- [乙](memory/b.md) — 第二条`
 *   2. 再写甲，描述恰好引用了乙 → `- [甲](memory/a.md) — 见 ](memory/b.md)`
 *
 * `upsertIndexLine('memory/b.md', …)` 的 `findIndex` 会**先命中甲那一行**
 * （因为甲的描述里含 `](memory/b.md)`），于是把甲的行**原地替换**，
 * 乙真正的索引行反而被覆盖掉 —— 乙的正文还在，索引里却没它了。
 * `removeIndexLine` 同理：删甲会连带删掉描述里提到甲的乙。
 *
 * 引用另一条记忆的链接在**协议里是被鼓励的**（"细节写进条目文件"），
 * 所以这不是臆想出来的输入，是自然会写出来的描述。
 *
 * ## 标题里可以含 `]`，所以不能用「标题中不含 `]`」的字符类
 *
 * 早先这里写的是 `/^- \[[^\]]*\]\(([^)]*)\)/`。`[^\]]*` 遇上标题里的方括号
 * （实测最常见的是 `byte[]`）就会在**第一个** `]` 处截断，后面接不上 `](`，
 * 整行解析失败 —— 于是 upsert 每次都判定「索引里没有这条」而继续追加，
 * 索引里堆出同一行的多份副本（实测 7 份），模型读索引看到重复条目，
 * 人工也永远对不上账。
 *
 * ## 但也不能无条件「从右往左」切
 *
 * 描述里出现 `](memory/b.md)` 是**自然写法**（协议还鼓励"细节写进条目文件"）。
 * 若一路取到行内最后一个 `](`，这条：
 *
 *   `- [甲](memory/a.md) — 见 ](memory/b.md) 那条`
 *
 * 会被切成标题 `甲](memory/a.md) — 见 `、链接 `memory/b.md` —— 于是写乙时
 * **把甲的行顶掉**、删乙时**连带删掉甲**，正是下面这段注释里记录的真事故。
 *
 * ## 所以：只允许**一对方括号**出现在标题里
 *
 * `\[[^\[\]]*\]` 这一分支专为 `byte[]` / `byte[1024]` 这类标题准备；不含方括号的
 * 标题仍走 `[^\[\]]*`。两者都不允许再嵌一层 `](`，描述里的链接因此照旧看不见。
 * 权衡：标题里若出现**多个**方括号组（如 `a[b]c[d]`）仍会解析失败 —— 但那种标题
 * 本身罕见，且失败是**显式不匹配**（不会误删别人的行），比误伤更安全。
 */
function indexLineTargets(line, file) {
  // 只认行首的 `- [`，避免命中正文或描述里的行。
  // 标题段：普通字符，或**一**对方括号（`byte[]`、`[废弃]` 之类）。
  const m = /^-\s*\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(([^)]*)\)/.exec(line)
  return m !== null && m[1] === file
}

/**
 * 把一行追加到索引（不存在则创建并加标题）。
 *
 * `file` 是**相对作用域的链接路径**（如 `memory/user_x.md`）—— 索引在作用域根，
 * 正文在 `memory/`，所以链接必须带上子目录，否则点开找不到文件。
 *
 * ## 这里自己做一行化，不假设调用方已经做过
 *
 * 索引是**整份注入上下文**的东西，一行条目一旦断裂成两行，就凭空多出一条
 * 索引项（等于内容能往索引里插任意行）。`writeMemory()` 已经把 name/description
 * 折叠过了，但**这个函数是索引行的唯一收口**——将来多一个调用方、它忘了折叠，
 * 索引就又破了。所以防御放在收口处，而不是指望每个调用方都记得。
 *
 * 折叠是安全的：`title` / `description` 的契约本来就是一行。
 */
export function upsertIndexLine(indexPath, file, title, description) {
  const line = `- [${oneLine(title)}](${file}) \u2014 ${oneLine(description)}`
  const existing = readText(indexPath)
  if (existing === undefined) {
    writeAtomic(indexPath, `# ${MEMORY_ENTRYPOINT}\n\n${line}\n`)
    return
  }
  // 已存在同文件的条目 → 原地替换，避免重复。
  // 判据必须精确到「行首链接」，否则描述里的链接会让我们改错行（见 indexLineTargets）。
  const lines = existing.split('\n')
  const idx = lines.findIndex((l) => indexLineTargets(l, file))
  if (idx >= 0) {
    lines[idx] = line
    writeAtomic(indexPath, lines.join('\n'))
    return
  }
  const trimmed = existing.replace(/\s*$/, '')
  writeAtomic(indexPath, `${trimmed}\n${line}\n`)
}

/**
 * 从索引里删掉指向某个文件的条目行。
 *
 * 与 `upsertIndexLine()` 对称：那边按行首链接匹配做原地替换，这里按同一
 * 判据整行移除。**只删索引行，不动其他行** —— 标题、空行、以及别的条目
 * 原样保留，人工加在索引里的说明文字不会被误伤。
 *
 * 判据同样是**行首链接**而非整行子串：描述里引用别的记忆很常见，
 * 用子串匹配会连带删掉那些行（见 `indexLineTargets` 的说明）。
 *
 * @returns 是否真的删掉了一行（false = 索引里本来就没有这条）。
 */
export function removeIndexLine(indexPath, file) {
  const existing = readText(indexPath)
  if (existing === undefined) return false
  const lines = existing.split('\n')
  const kept = lines.filter((l) => !indexLineTargets(l, file))
  if (kept.length === lines.length) return false
  writeAtomic(indexPath, kept.join('\n'))
  return true
}

/**
 * 删除一条记忆：正文文件 + 对应的索引行。
 *
 * **这是不可逆操作**，调用方（`memory_md_forget`）负责先确认目标存在并
 * 把删掉的内容回报给模型 —— 用户和模型都得知道究竟删了什么。
 *
 * 索引行先删还是正文先删无所谓：两者都做，且都在同步路径里完成，
 * 中间不会有人看到「正文没了但索引还在」的持久状态。
 *
 * @returns `{ removed: boolean, indexPath: string, bodyPath: string }`；
 *          `removed` 为 false 表示正文与索引行都不存在（无可删）。
 */
export function deleteMemory(dir, file) {
  const bodyPath = join(dir, MEMORY_DIR, file)
  const indexPath = join(dir, MEMORY_ENTRYPOINT)
  const hadBody = existsSync(bodyPath)

  let removed = false
  if (hadBody) {
    rmSync(bodyPath, { force: true })
    removed = true
  }
  // 正文可能已被人工删掉、索引行还在 —— 这种情况也要清索引，否则索引
  // 会留下一条点开找不到文件的死链。
  if (removeIndexLine(indexPath, `${MEMORY_DIR}/${file}`)) removed = true

  return { removed, indexPath, bodyPath }
}

/**
 * frontmatter 值的一行化。
 *
 * ## 为什么必须做
 *
 * `name` / `description` 是**裸插值**进 frontmatter 的，而它们是模型给的自由文本。
 * 含换行时后果不止"文件格式不好看"：
 *
 *   description: 第一行\n- [伪造条目](memory/evil.md) — 我插进来的
 *
 * 会让**索引凭空多出一行**（实测确认）—— 等于一条记忆能往索引里写任意多行，
 * 而索引是整份注入上下文的东西，"索引行由插件维护"这条保证就此失效。
 * 含 `\n---\n` 更严重：frontmatter 提前闭合，`type` 等字段直接丢失。
 *
 * ## 为什么是「折叠空白」而不是「报错」
 *
 * 这两个字段的契约本来就是**一行**（工具描述写明"一行、约 150 字以内"），
 * 所以把任意空白串折成单个空格**不改变语义**，却让"写出坏文件"成为不可能 ——
 * 比拒绝写入更稳：后台总结路径上的报错只会变成一条日志，而记忆已经丢了。
 *
 * `---` 作为整行是危险的，但折叠后 `description: ---` 仍是一行，
 * 解析器按**行首** `---` 判定终止符，它不会被误认。
 *
 * 导出是刻意的：`tools.mjs` 回报的 `indexLine` 必须与**实际写进索引的那一行**
 * 逐字一致，所以它要调用同一个函数，而不是自己再折一遍。
 */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 决定一条记忆该写进哪个文件名。
 *
 * ## 一条铁律：**只有「同一条记忆」才允许覆盖**
 *
 * 覆盖的判据不是"文件名对上了"，而是"文件名对上了**且** frontmatter 里的
 * `name` 也是同一个"。两条不同主题的记忆**绝不允许**共用一份正文 —— 后写的
 * 会把先写的整条抹掉，而文件名、索引行数、错误日志全都看不出这事发生过。
 *
 * ## 显式传 `file` 不再无条件照用（2026-10-18 修）
 *
 * 早先这里是 `if (requested !== undefined) return requested` —— 显式路径
 * **完全绕过**了下面对撞车的防护。当时的理由是"传同一个 file 就是有意覆盖"，
 * 但那只在**调用方知道自己在覆盖什么**时成立。
 *
 * 后台总结并不具备这个前提：它只拿到「文件名 + 描述」清单（见
 * `formatMemoryManifest()`），**看不到正文**，而清单是把 global 与 project
 * 两个作用域合并渲染的。于是模型凭"名字听着像"就把清单里某一条的文件名填进
 * `file`，一条完全无关的新记忆就被写进了别人的文件里。
 *
 * 已确认的真实事故：
 *
 * 1. **2026-10-15（最典型）** 主对话里先存了"本机 GitHub git 加速走 gh-proxy 镜像"，
 *    同一会话后面写"gen-4/gen-5 仓库错位"时把前者的文件名填进了 `file`，
 *    于是镜像那条被整份换成逆向仓库的内容，**镜像知识彻底丢失**（只能重测重写）。
 *    同一天的两个备份里都已是错内容，事后无法恢复 —— 这正是"静默丢数据"。
 * 2. 2026-09-21 / 09-27：global 的 `project_社保国产化工作区与开发环境速查.md`
 *    被两个 sbf 项目工作区各抄一次，共 9 例（另有 4 条 codegraph 记忆被抄进 global）。
 *
 * 注意第 1 例是**主对话里的 memory_md_save**，不是后台总结 —— 说明这条路径
 * 依赖调用方的自觉，而模型只要"觉得文件名像"就会填，光靠提示词约束不住。
 *
 * 所以现在显式路径也要过同名检查：`file` 指向的现有文件若有**不同的 name**，
 * 一律视为撞车，改走派生 + 序号后缀。
 *
 * ⚠️ 别把这条改回"显式就照用"。那样 `memory_md_save` 传同一个 file 覆盖更新
 * 仍然是通的（name 本来就一致），但后台总结抄错名字的路径会重新打开。
 *
 * ## 派生命名为什么要另起序号
 *
 * `slugify()` 会把所有非 `[a-z0-9\u4e00-\u9fa5]` 字符替换成 `_`，于是
 * 「重试机制」与「重试机制！」派生出**同一个** `feedback_重试机制.md`；
 * 长标题更危险：`slugify` 截断到 40 字符，前 40 字相同的标题必然撞车。
 *
 * 所以撞车时加序号后缀另起一个文件。**宁可多一条可见的重复，也不要少一条
 * 不可见的记忆** —— 重复可以在索引里被人一眼看见并手工合并，丢失看不见。
 *
 * @param requested - 调用方显式指定的文件名（已过 `normalizeMemoryFile`）；无则派生。
 * @returns 纯文件名（不含目录）。
 */
export function resolveMemoryFile(dir, { requested, type, name }) {
  // ⚠️ 必须和 `writeMemory()` 落盘时用的是**同一个**归一化值。
  // 那边把 name 过 `oneLine()`（折叠空白）再写进 frontmatter，这里若拿原始
  // `name` 去比，标题里多个换行/连续空格就会被判成"异名"，同一条记忆被
  // 另存成 `-2` —— 一条看不见来源的重复。
  //
  // `stripNameResidue()` 同理：它剥掉标题里混进来的 `feedback_` 前缀与 `.md`/`_md`
  // 残渣（见该函数的说明）。**两边必须用同一个值**，否则「存过一次带前缀的标题，
  // 再按干净标题存」会被判成异名 → 另起 `-2`，正是要消灭的那种重复。
  const wantName = stripNameResidue(name)

  // 显式传了 file：只有「文件不存在」（点名新建）或「同名」（覆盖更新）才照用。
  if (requested !== undefined) {
    const existing = readText(join(dir, MEMORY_DIR, requested))
    if (existing === undefined) return requested
    const { data } = parseMemoryFrontmatter(existing)
    if (oneLine(data.name) === wantName) return requested
    // 落到下面走派生命名 —— 不能覆盖别人。
  }

  const slug = slugify(wantName)
  const derived = `${type}_${slug}.md`
  // 显式 file 撞了名时，派生名可能恰好就是那个被撞的文件；一并按"已存在"处理。
  const existing = readText(join(dir, MEMORY_DIR, derived))
  if (existing === undefined) return derived

  // 文件已存在。同名 → 更新；异名 → 撞车，另起一个。
  const { data } = parseMemoryFrontmatter(existing)
  if (oneLine(data.name) === wantName) return derived

  for (let n = 2; n < 100; n++) {
    const candidate = `${type}_${slug}-${n}.md`
    if (readText(join(dir, MEMORY_DIR, candidate)) === undefined) return candidate
  }
  // 100 个同 slug 文件还没排开 —— 极不可能，退回覆盖（至少不丢新内容）。
  return derived
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
  // ⚠️ 必须一行化：裸插值的换行会污染 frontmatter，进而能往索引里插任意行。
  //
  // ⚠️ 还要过 `stripNameResidue()`，且**必须与 `resolveMemoryFile()` 用同一个值**：
  // 派生文件名时剥掉了 `feedback_` / `.md` 残渣，落盘却把脏标题写进 frontmatter，
  // 就会得到「文件名干净、标题脏」的条目 —— 下一次同名保存因标题对不上而被判成
  // 异名，另起 `-2`。索引标题也来自这里，脏标题会一直显示给模型看。
  const safeName = stripNameResidue(name)
  const safeDescription = oneLine(description)
  const frontmatter = ['---', `name: ${safeName}`, `description: ${safeDescription}`, `type: ${type}`, '---', '']
  writeAtomic(path, `${frontmatter.join('\n')}\n${body}\n`)
  // 索引链接带 `memory/` 前缀 —— 索引在根、正文在子目录。
  upsertIndexLine(join(dir, MEMORY_ENTRYPOINT), `${MEMORY_DIR}/${file}`, safeName, safeDescription)
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

/**
 * 诊断转储的单个文件大小上限（字符）。
 *
 * 输出上限是 4000 token，正常最多也就一两万字符 —— 这个上限只是为了防
 * **异常巨大的输出**（例如模型把整段转写复述了一遍）把磁盘写爆：真出现
 * 那种情况，开头那部分已经足够判断"它到底输出了什么形状的东西"。
 */
export const DIAGNOSTIC_MAX_CHARS = 200_000

/** 时间戳文件名片段：`20261012-163053`。 */
export function fileStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 把一个字符串渲染成**可读的分隔块**，用于诊断转储。
 *
 * 为什么要分隔块而不是直接拼：诊断文件里既有我们生成的元信息、也有模型
 * 的原始输出，而原始输出**本身可能包含看起来像我们元信息的行**（比如模型
 * 自己写了个 `## 上下文`）。没有明确边界时，人工排查会被自己的文件误导。
 */
function dumpSection(title, body) {
  const text = String(body ?? '')
  return `===== ${title} =====\n${text === '' ? '(空)' : text}\n`
}

/**
 * 落盘一次后台总结失败的**完整现场**。
 *
 * ## 为什么需要它
 *
 * `error.log` 只能记一行（`appendErrorLog` 会把空白压成单行），因此它天然
 * 答不了「模型到底输出了什么」—— 而"总结没写成"背后至少有**五种**互斥成因，
 * 且**第一种最容易被忽略、实测却最常见**：
 *
 *   1. **调用本身失败**（`finish error` / `aborted`，输出为空）—— 压根没有 JSON；
 *   2. 调用正常结束但输出为空（模型只出了推理）；
 *   3. 撞上 `maxTokens` 被硬截断（JSON 缺尾）；
 *   4. 模型输出了自然语言而非 JSON；
 *   5. 有 JSON 但字符串里有裸换行等非法转义，配平成功而 `JSON.parse` 失败。
 *
 * 这五种修法完全不同（修链路 / 改提示词 / 调上限 / 改切片 / 加宽松解析），
 * 只看 error.log 只能靠猜 —— 这正是 2026-10-12 那次排查卡住的地方：
 * 93 行日志没有一行能回答"坏在哪里"。
 *
 * ⚠️ 分工：**判定**由 `summarize.mjs` 的 `classifyParseFailure()` 做（那里看得到
 * finish 终态与原文长度），本函数只负责把现场**如实**写下来，不做任何推断。
 * 早先 `error.log` 无条件写「JSON 不完整或格式错误」，等于在第 1、2 种情形下
 * 凭空断言了一个不存在的"JSON 格式问题" —— 那句话直接把排查引向了死路。
 *
 * ## 写在哪
 *
 * `<memoryRoot>/diagnostics/`，与 `error.log` 同层（见 `resolvePaths()` 的
 * 说明）。**不写进 `.journal/`** —— 那是给人读的叙事，塞原始输出会污染它。
 *
 * 失败时静默吞掉：诊断是排查的辅助，绝不能因为它失败而影响主流程。
 *
 * @returns 写入的文件名（供 error.log 引用）；失败时 undefined。
 */
export function writeDiagnosticDump(diagnosticsDir, { sessionId, summary, context, raw }) {
  try {
    if (typeof diagnosticsDir !== 'string' || !diagnosticsDir) return undefined
    const body = String(raw ?? '')
    const clipped = body.length > DIAGNOSTIC_MAX_CHARS
      ? `${body.slice(0, DIAGNOSTIC_MAX_CHARS)}\n\n…（诊断转储截断：原文共 ${body.length} 字符）`
      : body
    // 会话 id 进文件名：一个目录里可能堆着多个会话的失败，不带来源就得逐个打开。
    const short = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 8) : 'nosession'
    const file = `${fileStamp()}-${short}-${summary}.txt`
    const text = [
      dumpSection('摘要', summary),
      dumpSection('上下文', context),
      // 原文放最后：人工打开文件先看到"是哪一次、什么上下文"，再往下看原文。
      dumpSection('模型原始输出（逐字节）', clipped),
    ].join('\n')
    mkdirSync(diagnosticsDir, { recursive: true })
    writeAtomic(join(diagnosticsDir, file), text)
    return file
  } catch {
    /* 诊断转储失败不能再抛错 */
    return undefined
  }
}

/**
 * 剥掉标题里被误当成内容一部分的「文件名残渣」。
 *
 * ## 为什么需要
 *
 * 派生文件名是 `${type}_${slugify(name)}.md`，而 `name` 的约定只是「简短标题」——
 * 没有任何机制拦住模型把**文件名形态**的东西填进来。索引里的标题长这样：
 * `- [feedback_断言必须回退验证会变红](memory/...)`，模型看到的就是带前缀的标题，
 * 于是很自然地把 `feedback_xxx` 甚至 `xxx.md` 原样填回 `name`：
 *
 *   name = `feedback_断言必须回退验证会变红.md`
 *   → `feedback_` + slugify(`feedback_断言必须回退验证会变红.md`)
 *   → `feedback_feedback_断言必须回退验证会变红_md.md`   ← 双前缀 + `_md` 残渣
 *
 * 实测该形态已在库里积累 27 个双前缀、22 个 `_md` 结尾（共 527 条）。
 * 文件名难看只是表象，真正的代价是**同一件事被拆成两条**：一旦有人按正确
 * 形态再存一次，slug 不同 → 另起文件 → 两条内容相近的记忆并存，索引里
 * 看不出哪条是旧的。
 *
 * ## 剥的规则
 *
 * - 开头的 `<type>_` 前缀：**四种类型前缀全剥**，不只剥与本次 `type` 相同的那一个。
 *   理由是 `feedback_user_用户身份.md` 这种名字同样是脏的：模型把 `user_` 当成了
 *   标题的一部分，而文件名已有的 `feedback_` 才是唯一的类型标签；保留它会让
 *   同一个话题下 `user_xxx` 与 `feedback_user_xxx` 两种形态并存，检索时对不上。
 *   代价是标题真以「user 」「project 」等词开头的会被误剥，但标题是给人读的、
 *   剥完仍通顺，且模型本来就不该在标题里写类型标签。
 * - 结尾的 `.md`：转义前先去掉；`_md` 只在**它来自 `.md` 时**才去 —— 但字符串
 *   里已经看不出出处了，所以只在同时满足「剥掉前缀后仍以 `_md` 结尾」且
 *   「去掉后标题非空」时才剥。`dsh_memory_md` 这种中间带 `_md` 的不受影响。
 *
 * 前缀剥离**循环到剥不动为止**（`feedback_feedback_xxx` → `xxx`）：库里已积累
 * 双前缀条目，一次只剥一层的话，脏名再存一次仍是 `feedback_feedback_xxx`，
 * 永远清不干净。循环终止条件是「剥完为空」或「开头不再是类型前缀」。
 *
 * @returns 净化后的标题；若净化后为空则原样返回（不能把标题弄没）。
 */
export function stripNameResidue(name) {
  const raw = oneLine(name)
  if (!raw) return raw
  let title = raw
  // 1) 去掉结尾的 `.md`（模型把文件名当标题填了）。
  if (/\.md$/i.test(title)) title = title.replace(/\.md$/i, '').trim()
  // 2) 循环剥掉开头任意一种类型前缀。`rest` 非空才接受，否则会剥成空串。
  for (;;) {
    const hit = MEMORY_TYPES.find((t) =>
      title.toLowerCase().startsWith(`${t}_`.toLowerCase()),
    )
    if (hit === undefined) break
    const rest = title.slice(hit.length + 1).trim()
    if (!rest) break
    title = rest
  }
  // 3) `_md` 残渣（来自上一步已去掉的 `.md`，或模型抄了 `xxx_md`）。
  //    只在不伤及正文语义时剥：剥完仍非空。
  if (/_md$/i.test(title)) {
    const rest = title.replace(/_md$/i, '').trim()
    if (rest) title = rest
  }
  return title || raw
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
