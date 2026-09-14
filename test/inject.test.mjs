/**
 * inject.test.mjs — 两段式记忆注入的内容。
 *
 * 盯住设计承诺：
 *   1. **索引快照**注入**用户级 + 项目级**两份 `MEMORY.md` 索引；
 *   2. **只注入索引**，不注入分类文件全文；
 *   3. 两份都没有时返回空串 —— 官方约定空文本不贡献 section，
 *      也就不会产生任何历史消息；
 *   4. 索引用 `<memory-index scope="…">` 标签裹住，边界与作用域对模型明确；
 *   5. 索引超限时截断（`truncateEntrypointContent`，200 行 / 4e4 字符）。
 *
 * 协议（`MEMORY_PROTOCOL`）不在快照里 —— 它走 `systemPrompt.section()`
 * （系统提示词段），由 `load.test.mjs` 验证注册。这里只验证它不含易变内容。
 *
 * 去重（内容未变不重复注入）由 `dsh-agent-loop` 的 `RuntimeContextProjection`
 * 负责，不在本模块 —— 所以这里不测去重。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-inject-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { renderMemoryIndex, readIndex, MEMORY_PROTOCOL } = await import('../src/inject.mjs')
const { resolvePaths } = await import('../src/settings.mjs')
const { resolveScopes } = await import('../src/context.mjs')
const { MEMORY_ENTRYPOINT } = await import('../src/codebuddy-port.mjs')

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

const CWD = 'D:\\proj'
const paths = resolvePaths(SANDBOX)
const scopes = resolveScopes({ cwd: CWD, dshHome: paths.dshHome })
const GLOBAL_DIR = join(paths.memoryRoot, 'global')
const PROJECT_DIR = scopes.project.dir

const write = (dir, file, text) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), text, 'utf8')
}

const render = (overrides = {}) =>
  renderMemoryIndex({ memoryRoot: paths.memoryRoot, cwd: CWD, dshHome: paths.dshHome, ...overrides })

try {
  rmSync(SANDBOX, { recursive: true, force: true })

  console.log('\n两份索引都不存在 → 空串（不注入）')
  {
    check('返回空串', render(), '')
  }

  console.log('\n只有用户级索引')
  {
    write(GLOBAL_DIR, MEMORY_ENTRYPOINT, '# MEMORY.md\n\n- [用户偏好](user_x.md) — 用中文回复\n')
    const text = render()
    check('用 memory-index 标签裹住', text.includes('<memory-index scope="global">'), true)
    check('含索引行', text.includes('[用户偏好](user_x.md)'), true)
    check('不含项目级块', text.includes('scope="project"'), false)
  }

  console.log('\n两份索引都有 → 都注入，各自一个标签块')
  {
    write(PROJECT_DIR, MEMORY_ENTRYPOINT, '# MEMORY.md\n\n- [数据库端口](reference_db.md) — 跑在 5433\n')
    const text = render()
    check('含用户级块', text.includes('scope="global"'), true)
    check('含项目级块', text.includes('scope="project"'), true)
    check('项目块带 cwd', text.includes(`cwd="${CWD}"`), true)
    check('含全局索引行', text.includes('[用户偏好](user_x.md)'), true)
    check('含项目索引行', text.includes('[数据库端口](reference_db.md)'), true)
  }

  console.log('\n只注入索引，不注入分类文件全文')
  {
    write(GLOBAL_DIR, 'user_secret.md', '这是正文，不该出现在快照里')
    const text = render()
    check('正文没被注入', text.includes('这是正文，不该出现在快照里'), false)
  }

  console.log('\n协议不混进快照（它走系统提示词段）')
  {
    const text = render()
    check('快照不含协议标题', text.includes('## 长期记忆'), false)
    check('协议是常量文本', typeof MEMORY_PROTOCOL, 'string')
    check('协议说明标签格式', MEMORY_PROTOCOL.includes('<memory-index>'), true)
    check('协议说明取代语义', MEMORY_PROTOCOL.includes('取代'), true)
    // ⭐ 协议段走 `systemPrompt.section()`，而 section 也过官方 interpolate()。
    // 常量里绝不能出现 {{ —— 那会在 assemble() 里抛错、炸掉整个回合。
    // 这条断言是「防未来」：有人往协议里加占位符语法时立刻失败，而不是线上爆炸。
    check('协议不含 {{（否则炸整轮）', /\{\{/.test(MEMORY_PROTOCOL), false)
  }

  console.log('\n去掉索引文件自己的 # MEMORY.md 标题（避免与标签重复）')
  {
    const text = render()
    check('不含裸标题行', /^# MEMORY\.md$/m.test(text), false)
    check('仍含索引条目', text.includes('[用户偏好](user_x.md)'), true)
  }

  console.log('\n总开关关闭 → 完全不注入')
  {
    check('返回空串', render({ enabled: false }), '')
  }

  // ⭐ 回归：记忆里含 {{...}} 必须被中和（2026-09-13 实测确认的真 bug）。
  //
  // 官方 interpolate() 把注入文本里的 {{...}} 当提示词变量严格校验，且对
  // context() 与 section() 都生效。抛错发生在 systemPrompt.assemble() 里
  // = 整个 step 失败 = 整个回合失败，而且会**永久锁死**那个工作区
  //（每轮都炸，用户没法让 agent 自救，只能手工编辑 MEMORY.md）。
  // 同类事故：dsh-mneme issue #40。
  console.log('\n回归：索引里的 {{...}} 被中和（否则会炸整轮）')
  {
    // 写在 global 作用域，这样 render() 读得到。
    write(GLOBAL_DIR, MEMORY_ENTRYPOINT, [
      '# MEMORY.md',
      '',
      '- [模板](a.md) — 用 {{挖空}} 语法',
      '- [配置](b.md) — {{.Server.Version}}',
      '- [管道](c.md) — {{hl|}}',
      '- [变量](d.md) — {{name}}',
      '- [三层](e.md) — {{{triple}}}',
      '- [单括号](f.md) — {foo} 单个花括号不该动',
      '',
    ].join('\n'))

    const text = render({ cwd: undefined })
    // 关键断言：产物里不能再出现相邻的 {{（那正是 interpolate 的扫描目标）
    check('不含未中和的 {{', /\{\{/.test(text), false)
    // 单个 { 不该被改（它本来就不触发扫描）
    check('单个花括号原样保留', text.includes('{foo} 单个花括号不该动'), true)
    // 原文语义可还原（去掉插入的反斜杠即可）
    check('可还原原文', text.replace(/\\(?=\{)/g, '').includes('{{挖空}}'), true)
    check('三层花括号也可还原', text.replace(/\\(?=\{)/g, '').includes('{{{triple}}}'), true)

    // 还原给后续用例
    write(GLOBAL_DIR, MEMORY_ENTRYPOINT, '# MEMORY.md\n\n- [用户偏好](user_x.md) — 用中文回复\n')
  }

  console.log('\n无工作区 → 只注入用户级')
  {
    const text = render({ cwd: undefined })
    check('含用户级块', text.includes('scope="global"'), true)
    check('不含项目级块', text.includes('scope="project"'), false)
  }

  console.log('\n索引为空文件 → 当作没有')
  {
    const dir = join(paths.memoryRoot, 'd-empty')
    write(dir, MEMORY_ENTRYPOINT, '   \n\n')
    check('readIndex 返回 undefined', readIndex(dir), undefined)
  }

  console.log('\n索引超限 → 截断并附警告')
  {
    const dir = join(paths.memoryRoot, 'd-big')
    const lines = Array.from({ length: 260 }, (_, i) => `- [条目 ${i}](f${i}.md) — 描述`)
    write(dir, MEMORY_ENTRYPOINT, `# MEMORY.md\n\n${lines.join('\n')}\n`)
    const got = readIndex(dir)
    check('带截断警告', got.includes('警告'), true)
    check('行数被截到 200 以内', got.split('\n').filter((l) => l.startsWith('- ')).length <= 200, true)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
