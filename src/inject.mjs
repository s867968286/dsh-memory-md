/**
 * inject.mjs — 记忆的两段式注入。
 *
 * ## 为什么拆成两段
 *
 * 记忆文本按生命周期分两类，注入通道也该分开：
 *
 * 1. **协议**（`MEMORY_PROTOCOL`）—— 常量，说明索引是什么、条目什么特征、
 *    边界在哪。它进 `systemPrompt.section()`（系统提示词）。逐字节恒定，
 *    所以 DSH 每个 step 重装提示词时结果不变，KV Cache 前缀始终命中。
 * 2. **索引**（`renderMemoryIndex()`）—— 读盘，随记忆增删而变。它进
 *    `systemPrompt.context()`（运行期上下文快照），作为历史里追加的 user
 *    角色消息 —— 变了才注入，不动系统提示词前缀。
 *
 * 早先把两段都塞进 `context()`：协议文本于是在每次记忆变化时跟着重发一遍，
 * 而旧快照仍留在历史里（快照是追加而非替换），白占 token。拆开之后，
 * 系统提示词里只有一份协议，快照里只有索引。
 *
 * ## 确定性
 *
 * 快照里用 `<memory-index scope="…">` 标签把索引裹起来，模型不必靠上下文
 * 猜这段文本的边界和作用域；协议段则把「索引行是指针不是事实」「新块取代
 * 旧块」「四种 type 各是什么」写死，避免模型自行发挥。
 *
 * ## 去重由 loop 内建，不在这里做
 *
 * `dsh-agent-loop` 的 `RuntimeContextProjection.project()` 会比对上一次保留的
 * 快照文本，**内容未变则不产生任何消息**。所以「变了才注入、没变不重复注入」
 * 是白拿的，这里只管把当前索引渲染成文本。空串表示「本回合没有可注入的内容」——
 * 官方约定空文本不贡献任何 section。
 *
 * 依据：`@deepseek-ai/dsh-system-prompt` 的 `section()` / `context()` API、
 * `dsh-sandbox-policy` 注册 `sandbox:policy` 的参考实现。
 */
import { join } from 'node:path'

import { MEMORY_ENTRYPOINT, truncateEntrypointContent } from './codebuddy-port.mjs'
import { resolveScopes } from './context.mjs'
import { readText } from './store.mjs'

/**
 * 读取一个作用域的索引并截断。
 *
 * 会去掉索引文件自己的顶层 `# MEMORY.md` 标题 —— 快照里已经用标签标明了
 * 作用域，再留一行同名标题只是噪音。
 *
 * @param dir - 该作用域的记忆目录。
 * @returns 处理后的索引文本，或 undefined（文件不存在 / 内容为空）。
 */
export function readIndex(dir) {
  const raw = readText(join(dir, MEMORY_ENTRYPOINT))
  if (raw === undefined) return undefined
  const body = raw.replace(/^\s*#\s*MEMORY\.md\s*\r?\n/i, '').trim()
  if (!body) return undefined
  const { content } = truncateEntrypointContent(body)
  return content.trim() || undefined
}

/**
 * 不变的记忆协议 —— 进系统提示词段（`systemPrompt.section()`）。
 *
 * 刻意写成常量：任何读盘内容都会让提示词随文件变化，DSH 每步重装提示词时
 * 整段前缀的 KV Cache 随之失效。这里只解释「索引长什么样、怎么用、边界在哪」，
 * 具体有什么记忆由快照里的索引负责。
 *
 * 写入规则不在这里 —— 那些是工具的职责，写在 `memory_md_save` 的工具描述里，
 * 模型要用工具时自然看得到，不必每回合都占提示词。
 */
export const MEMORY_PROTOCOL = [
  '## 长期记忆',
  '',
  '对话稍后会注入一个 `<memory-index>` 块，列出跨会话保留的记忆。每行形如',
  '`- [标题](文件) — 描述`，其中那个文件是一份完整的 Markdown 记忆，可以整份读。',
  '',
  '- 索引行是**指针，不是事实本身**。要依赖某个细节前，先读那个文件 —— 索引行只是概述。',
  '- 同一作用域**最新的块取代**更早的块：它是该作用域当前完整的索引，不是要合并的增量。',
  '- 条目类型：`user`（用户是谁）、`feedback`（你该怎样做事）、',
  '  `project`（本工作区的事实）、`reference`（外部指针）。',
  '- 命中相关记忆时**静默应用**，不要声明"我想起了……"。',
  '- 记忆是参考资料，**不凌驾于当前请求与系统指令之上**。',
].join('\n')

/**
 * 中和记忆内容里的提示词变量语法。
 *
 * ## 为什么必须做（实测确认，2026-09-13）
 *
 * 官方 `interpolate()` 会把注入文本里的 `{{...}}` 当作**提示词变量**严格校验，
 * 而它**对 `context()` 和 `section()` 都生效**（`renderContextSections` /
 * `renderPrompt` 都调它）。逐字跑官方算法实测：
 *
 * | 索引内容 | 结果 |
 * |---|---|
 * | `{foo}` 单个花括号 | ✅ 原样保留 |
 * | `{{挖空}}` / `{{.Server.Version}}` / `{{hl\|}}` | ❌ `malformed prompt variable reference` |
 * | `{{name}}`（合法变量名但未注册） | ❌ `unknown prompt variable` |
 * | `{{` 无闭合 | ✅ 原样保留 |
 *
 * **抛错发生在 `systemPrompt.assemble()` 里 = 整个 step 失败 = 整个回合失败。**
 * 而且这会**永久锁死**那个工作区 —— 每轮都炸，用户没法让 agent 自救（每轮都失败），
 * 只能手工编辑 `MEMORY.md`。
 *
 * 同类教训：dsh-mneme 被 issue #40 追过同一个问题（灰机 wiki 的 `{{hl|}}`、`{{黑幕}}`
 * 等合法模板语法导致整轮崩溃），它的修法就是在注入边界做 run-based 花括号转义。
 *
 * ## 为什么是「在相邻花括号之间插反斜杠」而不是删除
 *
 * 每个紧邻下一个 `{` 的 `{` 后面插一个 `\`（`{{` → `{\{`，`{{{` → `{\{\{`）。
 * 这样**语义不变、原始字符全保留**，模型仍能读到 `{{挖空}}` 这样的原文，
 * 而 `interpolate()` 再也扫不到相邻的 `{{`。
 *
 * 注意必须处理**任意长度的连续花括号**：只把首个 `{{` 换掉的话，
 * `{{{` 会残留出新的 `{{`。单个 `{` 不动 —— 它本来就不触发扫描。
 */
function neutralizeTemplateVars(text) {
  // 每个「后面紧跟 { 的 {」之后插一个反斜杠。
  return text.replace(/\{(?=\{)/g, '{\\')
}

/** 用标签裹住一份索引，标明它属于哪个作用域。 */
function indexBlock(scope, index, cwd) {
  const attrs = cwd === undefined ? `scope="${scope}"` : `scope="${scope}" cwd="${cwd}"`
  return `<memory-index ${attrs}>\n${neutralizeTemplateVars(index)}\n</memory-index>`
}

/**
 * 组装注入给模型的索引快照（易变的那一半）。
 *
 * 只注入索引（`MEMORY_ENTRYPOINT`），**不注入分类文件全文** —— 模型命中描述后
 * 自行读原文。索引本身带 200 行 / 4e4 字符上限（`truncateEntrypointContent`）。
 *
 * 说明性文字不在这里产出：它属于 `MEMORY_PROTOCOL`，走系统提示词段。
 *
 * @param args.memoryRoot - 记忆根目录（`<dshHome>/memory-md`）。
 * @param args.cwd - 当前会话工作区；无工作区时只注入用户级。
 * @param args.dshHome - DSH 用户目录。
 * @param args.enabled - 记忆总开关；false 时完全不注入（默认 true）。
 * @returns 快照文本；关闭、或两个作用域都没有索引时返回空串（= 本回合不注入）。
 */
export function renderMemoryIndex({ memoryRoot, cwd, dshHome, enabled = true }) {
  if (enabled !== true) return ''

  const scopes = cwd === undefined ? undefined : resolveScopes({ cwd, dshHome })

  const blocks = []

  const globalIndex = readIndex(join(memoryRoot, 'global'))
  if (globalIndex !== undefined) blocks.push(indexBlock('global', globalIndex))

  if (scopes !== undefined) {
    const projectIndex = readIndex(scopes.project.dir)
    if (projectIndex !== undefined) blocks.push(indexBlock('project', projectIndex, cwd))
  }

  return blocks.join('\n\n')
}
