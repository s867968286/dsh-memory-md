/**
 * codebuddy-port.mjs
 *
 * CodeBuddy Code 记忆子系统的移植（v2.150.0）。
 *
 * 源码：`@tencent-ai/codebuddy-code@2.150.0 dist/codebuddy.js`
 *
 * 保留的部分：
 *   - getCompressedWorkDir()      路径 → slug
 *   - truncateEntrypointContent() 索引截断（200 行 / 4e4 字符）
 *   - parseMemoryFrontmatter()    typed frontmatter
 *   - MEMORY_TYPES                user / feedback / project / reference
 *
 * **不再保留的部分（有意为之）**：
 *
 * 原版的主体是 `buildMemoryPrompt()` —— 把**记忆内容本身**拼成一大段文本注入
 * 系统提示词。本插件不这样做，因此那一整套（buildMemoryLines /
 * buildSearchingPastContextSection / 各段提示词常量）已删除。理由：
 *
 * 1. **缓存**：DSH 每个 step 都重新装配系统提示词（dsh-agent-loop 的
 *    `systemPrompt.assemble()`）。任何**读盘**的 section 都让提示词随文件变化，
 *    整个前缀的 KV Cache 随之失效。记忆正文/索引随时在变，正属于这类。
 * 2. **人设**：提示词里的人设段是 DSH 给模型立规矩的地方，插件不该冒充它。
 *
 * 注意「不注入」的边界：本插件**确实**往提示词放一段**常量协议**
 * （`MEMORY_PROTOCOL`，走 order 950 这个空档，内容仅限解释自己的索引格式）——
 * 它是常量，所以不触发上面第 1 条。真正被否掉的是「把读盘的记忆内容进 section」。
 * 记忆本体经 `systemPrompt.context()` 走上下文快照（见 src/inject.mjs）。
 *
 * 具体能力由 `memory_md_*` 工具提供，写入规范写在工具描述里（见 src/tools.mjs）。
 *
 * 截断逻辑用差分测试锁死，与真实 bundle 逐字节比对（test/differential.test.mjs）。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** typed 路径的行数上限 */
export const MEMORY_ENTRYPOINT_MAX_LINES = 200
/** typed 路径的字符上限（4e4） */
export const MEMORY_ENTRYPOINT_MAX_CHARS = 4e4
/** 索引文件名 */
export const MEMORY_ENTRYPOINT = 'MEMORY.md'
/** 四种语义类型 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/**
 * `getCompressedWorkDir()` 的移植。
 *
 * 规则：绝对路径的盘符与分隔符转 `-`，整体小写。
 *
 *   D:\workspaces\ai\dsh-memory-md  ->  d-workspaces-ai-dsh-memory-md
 *
 * 原版跑在 `process.cwd()`；这里由调用方传入绝对路径。
 */
export function getCompressedWorkDir(cwd) {
  let normalized = String(cwd)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1')
  // 去掉开头斜杠，让 POSIX 绝对路径也保持单前缀
  normalized = normalized.replace(/^\/+/, '')
  return normalized.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/g, '').toLowerCase()
}

/**
 * 最小路径拼接，避免依赖 node:path。
 *
 * 分隔符取**绝对基路径**（首段的盘符或开头斜杠）的风格：这样用正斜杠书写的
 * 相对路径拼到 Windows 绝对路径上时不会混出 `D:\proj\.dsh/memory-md`。
 */
export function joinPath(...parts) {
  const filtered = parts.filter((p) => p !== undefined && p !== null && p !== '')
  if (filtered.length === 0) return ''

  const first = String(filtered[0])
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(first) || /^\\\\/.test(first)
  const sep = isWindowsAbsolute ? '\\' : '/'

  return filtered
    .map((p, i) => {
      let s = String(p)
      if (i > 0) s = s.replace(/^[\\/]+/, '')
      if (i < filtered.length - 1) s = s.replace(/[\\/]+$/, '')
      if (isWindowsAbsolute) s = s.replace(/\//g, '\\')
      return s
    })
    .join(sep)
}

/* ------------------------------------------------------------------ *
 * 截断
 * ------------------------------------------------------------------ */

/**
 * `truncateEntrypointContent()` 的逐字移植（**截断逻辑**逐字，警告文案已汉化）。
 *
 * 行数上限（200）然后字符上限（4e4），超限时附一段警告说明具体溢出量。
 *
 * ⚠️ **与上游的唯一有意差异**：警告文案汉化了（它是注入给模型的文本，
 * 应与其余提示词语言一致）。截断逻辑本身 —— 保留哪些行、怎么按换行回退 ——
 * 仍与 CodeBuddy bundle 逐字节一致，差分测试比对的是**这部分**。
 */
export function truncateEntrypointContent(input) {
  const content = String(input).trim()
  const lines = content.split('\n')
  const lineCount = lines.length
  const charCount = content.length
  const wasLineTruncated = lineCount > MEMORY_ENTRYPOINT_MAX_LINES
  const wasCharTruncated = charCount > MEMORY_ENTRYPOINT_MAX_CHARS

  if (!wasLineTruncated && !wasCharTruncated) {
    return { content, lineCount, charCount, wasLineTruncated, wasCharTruncated }
  }

  let next = wasLineTruncated
    ? lines.slice(0, MEMORY_ENTRYPOINT_MAX_LINES).join('\n')
    : content

  if (next.length > MEMORY_ENTRYPOINT_MAX_CHARS) {
    const cut = next.lastIndexOf('\n', MEMORY_ENTRYPOINT_MAX_CHARS)
    next = next.slice(0, cut > 0 ? cut : MEMORY_ENTRYPOINT_MAX_CHARS)
  }

  const overflows = []
  if (wasLineTruncated) overflows.push(`${lineCount} 行（上限 ${MEMORY_ENTRYPOINT_MAX_LINES}）`)
  if (wasCharTruncated) overflows.push(`${charCount} 字符（上限 ${MEMORY_ENTRYPOINT_MAX_CHARS}）`)

  return {
    content:
      next +
      `\n\n> 警告：${MEMORY_ENTRYPOINT} 共 ${overflows.join(' 且 ')}，只加载了一部分。` +
      '索引条目请保持一行、约 200 字以内；细节写进主题文件。',
    lineCount,
    charCount,
    wasLineTruncated,
    wasCharTruncated,
  }
}

/* ------------------------------------------------------------------ *
 * frontmatter
 * ------------------------------------------------------------------ */

/**
 * 解析 typed memory 的 `name` / `description` / `type` frontmatter。
 * 对应原版的 `parseMemorySemanticType` 校验。
 */
export function parseMemoryFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  if (!match) return { data: {}, content: String(text) }
  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const idx = rawLine.indexOf(':')
    if (idx <= 0) continue
    const key = rawLine.slice(0, idx).trim()
    const value = rawLine.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) data[key] = value
  }
  return { data, content: String(text).slice(match[0].length).replace(/^\r?\n/, '') }
}
