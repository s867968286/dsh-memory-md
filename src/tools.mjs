/**
 * 记忆工具：`memory_md_*`。
 *
 * 写入规范写进工具 description，不重复进系统提示词。原因：
 *
 * 1. **按需可见**：模型要调工具时自然看得到描述，不必每回合都占提示词。
 * 2. **权限**：写文件由插件走 Host 侧的 fs 完成，不经沙箱授权弹窗 ——
 *    写记忆不该让用户处理权限。
 *
 * 注意与 `inject.mjs` 的分工：**记忆是什么、索引怎么读**属于 `MEMORY_PROTOCOL`，
 * 走系统提示词段（常量，不吃 KV Cache）；**怎么写入**属于这里的工具描述。
 * 早先两者都在工具描述里，模型于是只能「用到工具时」才知道有记忆这回事。
 *
 * 参照 CodeBuddy：它同样没有记忆专用工具，而是让 memory-extractor 子代理复用
 * 通用 Read/Grep/Glob/Write/Edit。本实现改为把能力直接做成工具，省掉子代理。
 */
import { join } from 'node:path'

import { MEMORY_ENTRYPOINT, MEMORY_TYPES, parseMemoryFrontmatter } from './codebuddy-port.mjs'
import { journalFileName, resolveScopes } from './context.mjs'
import { normalizeOutputSchema, parametersToJsonSchema } from './schema.mjs'
import { readSettings, resolvePaths } from './settings.mjs'
// 写入原语与后台总结共用 —— 索引格式与日志格式是对外承诺，两处各写一份会漂移。
import {
  appendJournalEntries,
  countEntries,
  deleteMemory,
  indexEntryFor,
  listMemoryFiles,
  memoryFilePath,
  normalizeMemoryFile,
  oneLine,
  readText,
  resolveMemoryFile,
  timeStamp,
  writeAtomic,
  writeMemory,
} from './store.mjs'

/**
 * 四种记忆类型。
 *
 * 唯一来源是 `codebuddy-port.mjs` 的 `MEMORY_TYPES`（那边是**无依赖的叶子模块**，
 * 从这里 import 不会有循环依赖）。早先三处各抄一份，改一处就漂移。
 */
const TYPES = MEMORY_TYPES

/** 工具名必须以 memory_md_ 开头，避免和别的插件撞车。 */
export const TOOL_WRITE = 'memory_md_save'
export const TOOL_SEARCH = 'memory_md_search'
export const TOOL_READ = 'memory_md_read'
export const TOOL_FORGET = 'memory_md_forget'
export const TOOL_JOURNAL = 'memory_md_journal'

/**
 * 解析并校验一次调用要写的作用域与目录。
 *
 * 路径永远由插件算，**不接受调用方传入路径** —— 这正是之前 AI 把文件写进
 * 工作区的根因：模型拿到裸文件名只能用自己的 cwd 补全。
 */
function scopeDirs(config, exec) {
  const paths = resolvePaths(config.dshHome)
  const cwd = config.workspaceCwd?.(exec) ?? undefined
  const scopes = cwd === undefined ? undefined : resolveScopes({ cwd, dshHome: paths.dshHome })
  return { paths, scopes, memoryRoot: paths.memoryRoot }
}

/**
 * 记忆总开关。关掉时写入被拒绝，但读/搜仍然可用 —— 已有文件不该突然读不到。
 */
function assertEnabled(paths) {
  const settings = readSettings(paths)
  if (settings.enabled === false) {
    throw new Error('memory_md_save: 记忆已在「记忆设置」页关闭，请先开启。')
  }
}

/**
 * 预设级停用。
 *
 * 某个 preset 自带独立记忆时（比如跟着预设走的人格记忆），全局记忆必须整体让位，
 * 否则两套记忆同时生效。**读、搜、写、日志全部拦** —— 只拦写会让 agent 读到一个
 * 它不该依赖的记忆库。
 *
 * 由 Host 半注入 `isDisabledFor`；未注入时视为不停用（工具可单独使用）。
 */
function assertPresetAllowed(config, exec, toolName) {
  if (typeof config.isDisabledFor !== 'function') return
  if (config.isDisabledFor(exec?.agent) !== true) return
  throw new Error(
    `${toolName}: 记忆已被当前 agent 预设停用。` +
      '若非预期，请把该 preset id 加入「记忆设置」里的 disabledPresets。',
  )
}

/** 某个作用域的目录；global 永远可用，project 需要工作区。 */
function dirFor(scope, memoryRoot, scopes) {
  if (scope === 'global') return join(memoryRoot, 'global')
  if (scopes === undefined) return undefined
  return scopes.project.dir
}

/**
 * 在给定的作用域集合里按文件名找记忆，返回命中的作用域与正文。
 *
 * 索引在作用域**根**、正文在 `memory/` 子目录 —— 两条路径必须分开拼：
 * 曾统一走 `memoryFilePath()` 把索引也拼进子目录，导致永远读不到（E1）。
 */
function findMemory(file, targets) {
  for (const [scope, dir] of targets) {
    const path = file === MEMORY_ENTRYPOINT ? join(dir, MEMORY_ENTRYPOINT) : memoryFilePath(dir, file)
    const text = readText(path)
    if (text !== undefined) return { scope, text }
  }
  return undefined
}

/** 所有可能存在记忆的作用域目录，**不受本次 scope 参数限制**。 */
function everyScopeTarget(memoryRoot, scopes) {
  const all = [['global', join(memoryRoot, 'global')]]
  if (scopes !== undefined) all.push(['project', scopes.project.dir])
  return all
}

/** 从 description 里抽出用于索引的标题。 */
function titleOf(meta, file) {
  return meta.name || file.replace(/\.md$/, '')
}

/**
 * `memory_md_read` 找不到记忆时的报错文案。
 *
 * ## 为什么不能只说「没有这条记忆」
 *
 * 原文案（`没有这条记忆 "<file>"`）把「**所选作用域内**没有」说成了「不存在」。
 * 踩过的实例：`project_社保国产化工作区与开发环境速查.md` 实际住在 global，
 * 模型按 `scope=project` 去找，收到「没有这条记忆」后合理地判断成记忆丢失
 * 或文件名记错，而不是"作用域传错了"。
 *
 * ## 作用域与类型是两件正交的事
 *
 * 文件名前缀（`project_` / `feedback_` …）是 **type** 分类标签，与 **scope**
 * 无关 —— `project_xxx.md` 住在 global 完全合法。模型最容易在这里串味，
 * 所以报错要把两者分开讲，并在别的作用域确实有这条时直接给出可用的调用。
 */
function describeReadMiss(file, want, memoryRoot, scopes, targets) {
  const scopeText = want === 'all'
    ? '所有作用域'
    : `作用域 ${want}`
  // 「作用域 project 里」要空格、中文与英文单词相邻要留白；「所有作用域里」不要。
  const where = want === 'all' ? `${scopeText}里` : `${scopeText} 里`
  const lines = [`memory_md_read: ${where}没有记忆 "${file}"。`]

  // 别处有 → 直接告诉他怎么读，省掉一轮试错。
  const elsewhere = findMemory(file, everyScopeTarget(memoryRoot, scopes)
    .filter(([scope]) => !targets.some(([t]) => t === scope)))
  if (elsewhere !== undefined) {
    lines.push(
      `它存在，但在另一个作用域里：${elsewhere.scope}。`,
      `改用 scope="${elsewhere.scope}" 重试（scope 决定的是存储位置，与文件名前缀无关）。`,
    )
    return lines.join('\n')
  }

  // 该作用域存在但这条不在。把口径讲清楚，别让模型去猜文件名。
  lines.push(
    `作用域（scope：global / project）与记忆类型（type：${TYPES.join(' / ')}）是两回事 ——`,
    `文件名里的前缀只是 type 标签，不代表它属于哪个作用域。`,
    `先用 memory_md_read 的列表模式（或 memory_md_search）确认它在哪个作用域，`,
    `再按该作用域调用；文件名不确定时也以列表里的为准。`,
  )
  return lines.join('\n')
}

/**
 * 注册全部记忆工具。
 *
 * 不用 `defineTool`：`@deepseek-ai/dsh-tools` 不在 profile 的可解析范围内，
 * 插件的 import 必然失败。`ctx.tools.register()` 要的本来就是纯 JSON Schema，
 * 所以参数 schema 由 `parametersToJsonSchema` 自己转（见 src/schema.mjs）。
 */
export function registerMemoryTools({ tools, config, logger }) {
  const disposers = []

  const tool = (spec) => {
    const definition = {
      name: spec.name,
      description: spec.description,
      // 参数用 spec 形式书写（字段名 → 字段描述），需要转换。
      parameters: parametersToJsonSchema(spec.parameters),
      // 输出 schema 与参数同构（属性带 required: true），走同一套转换。
      output: {
        schema: normalizeOutputSchema(spec.output.schema),
        render: spec.output.render,
      },
      execute: spec.execute,
      presentCall: spec.presentCall,
    }
    // 未定义的键不要留在对象上：register 会做严格校验。
    for (const key of Object.keys(definition)) {
      if (definition[key] === undefined) delete definition[key]
    }
    disposers.push(tools.register(definition))
  }

  /* -------------------- memory_md_save -------------------- */

  tool({
    name: TOOL_WRITE,
    description: [
      '保存或更新一条长期记忆，让它跨会话存活。',
      '',
      '当用户说了值得留存的事时用它：他是谁、希望你怎样工作、对你的纠正、',
      '一个持续中的项目事实、或某样东西在哪找。**纠正和确认都算** —— 要记下原因，不只记结论。',
      '',
      `四种类型，一个文件一条：${TYPES.join(' | ')}。`,
      '- user：角色、目标、偏好、知识背景',
      '- feedback：你该怎样做事（纠正与确认）',
      '- project：本工作区进行中的工作、决定、期限',
      '- reference：外部系统的指针（issue 跟踪器、看板、主机）',
      '',
      '`type` 是**分类标签**（同时进文件名前缀），`scope` 是**存储位置** —— 两者正交：',
      'type=project 的记忆既可以存 project 作用域，也可以存 global。按"换个工作区还成立吗"选 scope，按"这是哪一类"选 type。',
      '',
      '**不要存**：代码写法或文件结构（读仓库就知道）、git 历史、调试配方、',
      '临时状态、以及任何你没验证过的东西。除非用户明确要求，不要存密钥。',
      '',
      '**写之前先查一遍**（用 memory_md_search 或 memory_md_read 的列表模式）：',
      '已有条目能改就改 —— 传同一个 `file` 覆盖它，不要新建一条近似的。',
      '发现旧条目是错的或过期了，也在这次一并改掉。',
      '',
      `目录由插件决定（${config.hints?.dirs ?? '<记忆目录>'}），${MEMORY_ENTRYPOINT} 索引也由插件维护`,
      '—— 你只提供内容，**永远不要传路径**。要更新已有记忆就复用它的文件名，别新建近似重复的。',
    ].join('\n'),
    parameters: {
      scope: {
        type: 'string',
        required: true,
        enum: ['global', 'project'],
        description:
          '存到哪个作用域（=存储位置，与 type 无关）。global = 跨所有项目通用、换工作区仍然成立；project = 只在当前工作区成立。',
      },
      type: {
        type: 'string',
        required: true,
        enum: TYPES,
        description:
          '这条记忆属于哪一类（=分类标签，与 scope 无关，同时决定文件名前缀）。不要因为 type 叫 project 就选 scope=project。',
      },
      name: {
        type: 'string',
        required: true,
        description:
          '简短的人类可读标题，例如「包管理器选择」。会显示在记忆索引里。' +
          '只写标题本身：不要带 type 前缀（不要写 "feedback_xxx"），也不要带 ".md" 后缀 —— 前缀与扩展名由插件自己加。',
      },
      description: {
        type: 'string',
        required: true,
        description:
          '一行、约 150 字以内，说明这条记忆在什么场景下有用 —— 它决定这条记忆以后能不能被找到。要具体。',
      },
      content: {
        type: 'string',
        required: true,
        description:
          'Markdown 正文。feedback/project 类请写成「规则或事实」，再跟一行 "**Why:**" 和一行 "**How to apply:**"。',
      },
      file: {
        type: 'string',
        description:
          '可选：要覆盖的已有文件名（如 "feedback_testing.md"）。省略则由 type + name 派生出新名字。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          path: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          indexLine: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.created ? '已创建' : '已更新'} ${value.scope} 记忆 ${value.file}。`,
        },
      ],
    },
    execute(args, exec) {
      assertPresetAllowed(config, exec, TOOL_WRITE)
      const { paths, memoryRoot, scopes } = scopeDirs(config, exec)
      assertEnabled(paths)
      const dir = dirFor(args.scope, memoryRoot, scopes)
      if (dir === undefined) {
        throw new Error(
          'memory_md_save: 当前没有打开工作区，项目级记忆无处可写。请改用 scope "global"，或先打开一个工作区。',
        )
      }

      const type = TYPES.includes(args.type) ? args.type : undefined
      if (type === undefined) throw new Error(`memory_md_save: 未知的类型 "${args.type}"`)

      // 归一化：索引里的链接带 `memory/` 前缀，模型自然会连前缀一起复制。
      const requested = typeof args.file === 'string' && args.file.trim()
        ? normalizeMemoryFile(args.file)
        : undefined
      if (args.file !== undefined && String(args.file).trim() && requested === undefined) {
        // 注意 requested === undefined 有两种：非法名，以及保留名 MEMORY.md
        // （索引不是正文，见 `isEntrypointName`）。这里只该说非法名的情况。
        if (String(args.file).trim() === MEMORY_ENTRYPOINT) {
          throw new Error(
            `memory_md_save: "${MEMORY_ENTRYPOINT}" 是记忆索引，由插件独占维护，不能当正文覆盖。` +
            `要新增或修改记忆，请省略 file（自动派生），或传列表里的记忆文件名。`,
          )
        }
        throw new Error(
          `memory_md_save: "${String(args.file).trim()}" 不是合法的记忆文件名。` +
          `只写文件名本身，例如 "feedback_testing.md"（索引里的 "memory/xxx.md" 去掉 "memory/" 即可）。`,
        )
      }
      // 文件名：显式传了就用它（有意覆盖）；否则派生，**并且避开 slug 撞车**
      // ——见 `resolveMemoryFile()` 的说明：不同标题派生同名会把上一条整条覆盖掉。
      const file = resolveMemoryFile(dir, { requested, type, name: args.name })

      const { created } = writeMemory(dir, {
        file,
        type,
        name: args.name,
        description: args.description,
        content: args.content,
      })

      logger?.info?.(`[memory-md] ${created ? '已创建' : '已更新'} ${memoryFilePath(dir, file)}`)

      // 返回值里的 indexLine 要和**实际写进索引的那一行**一致。
      // `writeMemory()` 会把 name/description 里的空白折叠成单空格（防换行污染
      // frontmatter 与索引），所以这里不能回显原始入参 —— 否则回报给模型的是
      // 一行并不存在于索引里的文本。
      return Promise.resolve({
        file,
        path: memoryFilePath(dir, file),
        scope: args.scope,
        created,
        indexLine: `- [${oneLine(args.name)}](memory/${file}) \u2014 ${oneLine(args.description)}`,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `保存 ${args.scope} 记忆`,
      kind: 'edit',
      rawInput: { name: args.name, type: args.type, scope: args.scope },
    }),
  })

  /* -------------------- memory_md_search -------------------- */

  tool({
    name: TOOL_SEARCH,
    description: [
      '检索已保存的记忆，返回命中的行及其所在文件。',
      '',
      '当用户提到早先做过的事、问你记得什么，或某个过去的决定会改变',
      '你的答案时，用它。检索词要窄 —— 报错信息、文件路径、函数名 ——',
      '而不是宽泛的词。',
      '',
      '这里只搜记忆文件。要读某条的全文，请用 read 工具打开命中行',
      '旁边给出的路径。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '要查找的字符串或词，大小写不敏感。' },
      scope: {
        type: 'string',
        enum: ['all', 'global', 'project'],
        description: '搜哪个存储。默认 "all"。',
      },
      limit: {
        type: 'integer',
        description: '最多返回多少条命中行。默认 40。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string', required: true },
                file: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.matches.length === 0
            ? '没有匹配到任何记忆。'
            : value.matches
                .map((m) => `${m.scope}/${m.file}:${m.line}: ${m.text}`)
                .join('\n') + (value.truncated ? '\n（结果已截断）' : ''),
        },
      ],
    },
    execute(args, exec) {
      assertPresetAllowed(config, exec, TOOL_SEARCH)
      const { memoryRoot, scopes } = scopeDirs(config, exec)
      const want = args.scope ?? 'all'
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 40
      const needle = String(args.query ?? '').toLowerCase()
      if (!needle) throw new Error('memory_md_search: query 不能为空')

      const targets = []
      if (want === 'all' || want === 'global') targets.push(['global', join(memoryRoot, 'global')])
      if ((want === 'all' || want === 'project') && scopes !== undefined) {
        targets.push(['project', scopes.project.dir])
      }

      const matches = []
      let truncated = false
      outer: for (const [scope, dir] of targets) {
        // 索引在作用域根，正文在 memory/ 子目录 —— 两处都要扫。
        const files = [
          { file: MEMORY_ENTRYPOINT, path: join(dir, MEMORY_ENTRYPOINT) },
          ...listMemoryFiles(dir).map((f) => ({ file: f, path: memoryFilePath(dir, f) })),
        ]
        for (const { file, path } of files) {
          const text = readText(path)
          if (text === undefined) continue
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              if (matches.length >= limit) {
                truncated = true
                break outer
              }
              matches.push({ scope, file, line: i + 1, text: lines[i].slice(0, 300) })
            }
          }
        }
      }

      return Promise.resolve({ matches, truncated })
    },
    presentCall: (args) => ({ card: 'generic', title: `搜索记忆：${args.query}`, kind: 'search' }),
  })

  /* -------------------- memory_md_read -------------------- */

  tool({
    name: TOOL_READ,
    description: [
      '读取某条已保存记忆的全文，或列出有哪些记忆。',
      '',
      `省略 "file" 时会列出每条记忆的标题、类型和描述 —— 这是在检索之前`,
      `了解已知内容最省事的方式。每个作用域的 ${MEMORY_ENTRYPOINT} 索引也`,
      `在这份列表里。`,
      '',
      '**scope 与 type 是两件正交的事，别混**：',
      '- `scope`（global / project）= 这条记忆**存在哪**，决定去哪个目录找；',
      `- \`type\`（${TYPES.join(' / ')}）= 这条记忆**是哪一类**，只是文件名前缀。`,
      '文件名带 `project_` 前缀不代表它属于 project 作用域 —— 它完全可能住在 global。',
      '所以不要用文件名前缀去推断 scope；列表里的 `作用域/文件名` 前缀才是权威。',
    ].join('\n'),
    parameters: {
      scope: {
        type: 'string',
        enum: ['all', 'global', 'project'],
        description: '去哪个作用域找（global=跨项目，project=仅当前工作区）。默认 "all" —— 不确定时就用默认值，它会同时搜两个作用域。',
      },
      file: {
        type: 'string',
        description: `列表里的某个文件名（如 "feedback_testing.md"），或 "${MEMORY_ENTRYPOINT}"。省略则返回列表。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string', required: true },
                file: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                type: { type: 'string', required: true },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.text !== undefined
            ? value.text
            : value.entries.length === 0
              ? '还没有保存过任何记忆。'
              : value.entries
                  .map((e) => `${e.scope}/${e.file} [${e.type || '?'}] ${e.name} — ${e.description}`)
                  .join('\n'),
        },
      ],
    },
    execute(args, exec) {
      assertPresetAllowed(config, exec, TOOL_READ)
      const { memoryRoot, scopes } = scopeDirs(config, exec)
      const want = args.scope ?? 'all'

      const targets = []
      if (want === 'all' || want === 'global') targets.push(['global', join(memoryRoot, 'global')])
      if ((want === 'all' || want === 'project') && scopes !== undefined) {
        targets.push(['project', scopes.project.dir])
      }

      // `MEMORY.md` 是合法入参（读索引），但 `normalizeMemoryFile()` 会把保留名
      // 拒成 undefined（save/forget 依赖这道闸）—— 所以这里先单独放行它。
      const rawFile = typeof args.file === 'string' && args.file.trim()
        ? args.file.trim()
        : undefined
      const file = rawFile === undefined
        ? undefined
        : rawFile === MEMORY_ENTRYPOINT
          ? MEMORY_ENTRYPOINT
          : normalizeMemoryFile(rawFile)

      if (rawFile !== undefined && file === undefined) {
        throw new Error(
          `memory_md_read: "${rawFile}" 不是合法的记忆文件名。` +
          `只写文件名本身，例如 "feedback_testing.md"（索引里的 "memory/xxx.md" 去掉 "memory/" 即可）。`,
        )
      }

      if (file !== undefined) {
        const hit = findMemory(file, targets)
        if (hit !== undefined) return Promise.resolve({ entries: [], text: hit.text })

        // 没找到。报错必须同时说清两件正交的事，否则模型会误判成「记忆丢了」
        // 并去改文件名：
        //   1. **作用域**（scope）：在所选作用域里没有 —— 别处有就点出来；
        //   2. **类型**（type）：文件名前缀只是分类标签，与 scope 无关，
        //      带 `project_` 前缀的记忆完全可以住在 global（这正是踩过的坑）。
        throw new Error(describeReadMiss(file, want, memoryRoot, scopes, targets))
      }

      const entries = []
      for (const [scope, dir] of targets) {
        // 列表含索引条目：与"file 可传 MEMORY.md"的契约、与搜索扫索引的口径一致。
        // 必须把 scope 传进去 —— 输出 schema 要求每条都有它，索引条目是唯一
        // 不由下面那段拼的条目，漏传会让 `scope=all`（默认值）整块校验失败。
        entries.push(...indexEntryFor(dir, scope))
        for (const f of listMemoryFiles(dir)) {
          const raw = readText(memoryFilePath(dir, f)) ?? ''
          const { data } = parseMemoryFrontmatter(raw)
          entries.push({
            scope,
            file: f,
            name: titleOf(data, f),
            description: data.description ?? '',
            type: data.type ?? '',
          })
        }
      }
      return Promise.resolve({ entries })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.file ? `读取记忆：${args.file}` : '列出记忆',
      kind: 'read',
    }),
  })

  /* -------------------- memory_md_forget -------------------- */

  tool({
    name: TOOL_FORGET,
    description: [
      '删除一条已保存的记忆（正文文件 + 索引行一起删）。',
      '',
      '**这是不可逆操作**，用在三种情况：用户明确要求忘记某事；',
      '这条记忆被证明是错的；它已经过期、不再适用。',
      '',
      '删除前先确认删的是哪一条：用 memory_md_search 或 memory_md_read',
      '的列表模式找到确切的文件名。**不要凭印象删** —— 文件名对不上时',
      '这里会报错，而不是猜一个最像的删掉。',
      '',
      '如果只是内容需要修正、条目本身仍然成立，请改用 memory_md_save',
      '传同一个 file 覆盖更新 —— 那是「纠正」，不是「忘记」。',
    ].join('\n'),
    parameters: {
      scope: {
        type: 'string',
        required: true,
        enum: ['global', 'project'],
        description: '从哪个存储里删。',
      },
      file: {
        type: 'string',
        required: true,
        description:
          '要删除的记忆文件名（如 "feedback_testing.md"）。先用 memory_md_read 列表或 memory_md_search 拿到确切的文件名。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
          // 删除前该条记忆的标题与描述 —— 让用户和模型都看到究竟删了什么。
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.removed
            ? `已删除 ${value.scope} 记忆 ${value.file}（${value.name}）。`
            : `${value.scope} 里没有 ${value.file}，什么都没删。`,
        },
      ],
    },
    execute(args, exec) {
      assertPresetAllowed(config, exec, TOOL_FORGET)
      const { paths, memoryRoot, scopes } = scopeDirs(config, exec)
      assertEnabled(paths)
      const dir = dirFor(args.scope, memoryRoot, scopes)
      if (dir === undefined) {
        throw new Error(
          'memory_md_forget: 当前没有打开工作区，没有可删的项目级记忆。',
        )
      }

      const file = typeof args.file === 'string' ? normalizeMemoryFile(args.file) : undefined
      if (!file) {
        // 同 save：非法名与保留名分开说 —— 对索引说"文件名不合法"会误导模型。
        if (String(args.file ?? '').trim() === MEMORY_ENTRYPOINT) {
          throw new Error(
            `memory_md_forget: "${MEMORY_ENTRYPOINT}" 是记忆索引，不能删除。` +
            `删除记忆请传列表里的记忆文件名（如 "feedback_testing.md"）。`,
          )
        }
        throw new Error(
          `memory_md_forget: "${String(args.file ?? '').trim()}" 不是合法的记忆文件名。` +
          `只写文件名本身，例如 "feedback_testing.md"（索引里的 "memory/xxx.md" 去掉 "memory/" 即可）。`,
        )
      }

      // 先读元信息：删除后就无法回报"删掉的是什么"了。
      const raw = readText(memoryFilePath(dir, file))
      if (raw === undefined) {
        // 正文不在。索引里可能还留着死链，一并清掉，但如实回报"没删到正文"。
        deleteMemory(dir, file)
        return Promise.resolve({
          file,
          scope: args.scope,
          removed: false,
          name: file,
          description: '',
        })
      }
      const { data } = parseMemoryFrontmatter(raw)

      deleteMemory(dir, file)
      logger?.info?.(`[memory-md] 已删除 ${memoryFilePath(dir, file)}`)

      return Promise.resolve({
        file,
        scope: args.scope,
        removed: true,
        name: titleOf(data, file),
        description: data.description ?? '',
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `删除 ${args.scope} 记忆：${args.file}`,
      kind: 'edit',
      rawInput: { scope: args.scope, file: args.file },
    }),
  })

  /* -------------------- memory_md_journal -------------------- */

  tool({
    name: TOOL_JOURNAL,
    description: [
      '把内容追加进今天的工作日志（前提是日志功能已开启）。',
      '',
      '日志记录实际做了什么，供用户事后回看。它是**只写不读**的：永远不会',
      '被当作记忆加载，不进索引，也不会被检索。',
      '',
      '日志属于当前工作区，所以需要有打开的工作区；不存在全局日志。',
      '',
      '一次调用 = 一个带时间戳的批次。插件会写一个 `## HH:MM:SS` 标题，并把你的',
      '条目列在其下，所以同一天的多个批次仍可区分。',
      '做完一件有实质内容的事之后再调它 —— 建好了东西、修好了 bug、查清了问题、',
      '或定下了方案。一次调用里传多条，而不是反复调用。',
      '',
      '每条 1-3 句：说清做了什么，以及得到了什么结果。结论才是有价值的部分 ——',
      '「查了解析器，bug 是切片的差一错误」胜过「看了下解析器」。不要粘贴原始材料',
      '（工具输出、搜索结果堆砌、文件内容），但要记下你从检索和阅读中学到的',
      '东西 —— 那本身就是工作。除非用户明确要求，不要存密钥。',
      '',
      '要沉淀能影响未来对话的知识，请改用 memory_md_save ——',
      '日志是叙述性流水，不是记忆。',
    ].join('\n'),
    parameters: {
      notes: {
        type: 'array',
        required: true,
        description:
          '一条或多条记录，说明做了什么以及结果如何，例如 ["修了 stdin 编码 bug —— 流被按 latin1 读取，现在用 utf8", "为空输入场景补了回归测试"]。每条都会变成本批次时间戳下的一个 `- ` 条目。',
        items: {
          type: 'string',
          required: true,
          description: '一条记录，1-3 句：做了什么，以及结果如何。',
        },
      },
      note: {
        type: 'string',
        description:
          '单条记录的便捷写法，等价于传只含一项的 "notes" 数组。它与 "notes" 二选一。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          // 本批的时间戳 `HH:MM:SS`。
          stamp: { type: 'string', required: true },
          path: { type: 'string', required: true },
          // 本批新增的条目数（不是当天累计）。
          entries: { type: 'integer', required: true },
          // 当天累计条目数。
          total: { type: 'integer', required: true },
          written: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.written
            ? `已写入日志：${value.date}.md 的 ${value.stamp} 批次共 ${value.entries} 条（当天累计 ${value.total} 条）。`
            : '日志功能已关闭，未写入任何内容。',
        },
      ],
    },
    execute(args, exec) {
      assertPresetAllowed(config, exec, TOOL_JOURNAL)
      const { paths, scopes } = scopeDirs(config, exec)
      const stamp = timeStamp()

      // 日志是可选留痕：关闭时静默跳过，而不是报错打断对话。
      const settings = readSettings(paths)
      if (settings.journal !== true) {
        return Promise.resolve({
          date: journalFileName(),
          stamp,
          path: '',
          entries: 0,
          total: 0,
          written: false,
        })
      }

      // 留痕只针对具体工作区 —— 全局流水账混杂多个项目，事后没法读，
      // 所以不设 scope 参数，也没有全局分支。
      const dir = scopes?.project.journalDir
      if (dir === undefined) {
        throw new Error(
          'memory_md_journal: 当前没有打开工作区，没有可追加的日志。',
        )
      }

      // 接受 notes 数组；note 作为单条的便捷写法。
      const notes = []
      if (Array.isArray(args.notes)) {
        for (const n of args.notes) {
          const text = String(n ?? '').trim()
          if (text) notes.push(text)
        }
      }
      if (notes.length === 0 && args.note !== undefined) {
        const single = String(args.note ?? '').trim()
        if (single) notes.push(single)
      }
      if (notes.length === 0) {
        throw new Error('memory_md_journal: notes 不能为空')
      }

      const date = journalFileName()
      const path = join(dir, `${date}.md`)

      // 追加语义：文件不存在则建，并写一个日期标题。
      // 读取→拼接→原子替换，这一段必须是同步的。两次并发调用若在这中间
      // 让出，就会各自基于同一份旧内容拼接，后写的覆盖先写的。
      const before = readText(path)
      const after = appendJournalEntries(before, date, notes, stamp)
      writeAtomic(path, after)

      return Promise.resolve({
        date,
        stamp,
        path,
        entries: notes.length,
        total: countEntries(after),
        written: true,
      })
    },
    presentCall: (args) => {
      const first = Array.isArray(args.notes) ? args.notes[0] : args.note
      const count = Array.isArray(args.notes) ? args.notes.length : 1
      return {
        card: 'generic',
        title: count > 1 ? `日志：${first}（+${count - 1}）` : `日志：${first}`,
        kind: 'other',
      }
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时忽略 */
      }
    }
  }
}
