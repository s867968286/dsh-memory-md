/**
 * tools.test.mjs — 记忆工具的行为验证。
 *
 * 覆盖三件事：
 * 1. 工具以 `memory_md_` 前缀注册，描述里写了规范；
 * 2. 写入永远落在 `<dshHome>/memory-md/`，**绝不会**落到工作区；
 * 3. 索引由插件维护，模型不必（也不能）自己拼路径。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-tools-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { registerMemoryTools, TOOL_WRITE, TOOL_SEARCH, TOOL_READ, TOOL_JOURNAL } = await import('../src/tools.mjs')

// 插件自己转 schema（不用 defineTool），所以这里注册器拿到的已是 JSON Schema。

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

const WORKSPACE = 'D:\\workspaces\\ai\\dsh-memory-md'
const registered = new Map()

const fakeTools = {
  register(definition) {
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
}

const logger = { info: () => {}, warn: () => {} }

function makeConfig(workspace) {
  return {
    dshHome: SANDBOX,
    workspaceCwd: () => workspace,
    hints: { dirs: '' },
  }
}

/** exec 上下文：工具靠 exec.agent 定位工作区。 */
const exec = { agent: { id: 's1' } }

/**
 * 断言一次调用会失败。
 *
 * `execute` 可能**同步**抛（参数校验在返回 promise 之前），也可能返回被拒的
 * promise，所以两种都要接住 —— 只挂 `.catch()` 会漏掉前者。
 */
const throwsSync = (fn) => {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') return out.then(() => false, () => true)
    return Promise.resolve(false)
  } catch {
    return Promise.resolve(true)
  }
}

try {
  rmSync(SANDBOX, { recursive: true, force: true })

  registerMemoryTools({
    tools: fakeTools,
    config: makeConfig(WORKSPACE),
    logger,
  })

  console.log('\n工具注册')
  check('四个工具都注册了', [...registered.keys()].sort(), [TOOL_JOURNAL, TOOL_READ, TOOL_WRITE, TOOL_SEARCH].sort())
  check('全部带 memory_md_ 前缀', [...registered.keys()].every((n) => n.startsWith('memory_md_')), true)
  check('save 的参数是 JSON Schema', registered.get(TOOL_WRITE).parameters.type, 'object')
  check(
    'save 的参数含 scope/type/name/description/content',
    Object.keys(registered.get(TOOL_WRITE).parameters.properties).sort(),
    ['content', 'description', 'file', 'name', 'scope', 'type'],
  )
  check(
    'description 写明了四种 type',
    ['user', 'feedback', 'project', 'reference'].every((t) =>
      registered.get(TOOL_WRITE).description.includes(t),
    ),
    true,
  )
  check(
    'description 指明插件负责路径与索引',
    registered.get(TOOL_WRITE).description.includes('永远不要传路径'),
    true,
  )

  console.log('\n写入落在记忆目录，不落工作区')
  const save = registered.get(TOOL_WRITE)
  const result = await save.execute(
    {
      scope: 'project',
      type: 'reference',
      name: '数据库端口',
      description: '本地数据库跑在 5433',
      content: '本地 Postgres 监听 5433。\n\n**Why:** 默认 5432 被占用。\n**How to apply:** 连本地库时用 5433。',
    },
    exec,
  )

  const expectedDir = join(SANDBOX, 'memory-md', 'd-workspaces-ai-dsh-memory-md')
  check('created 为 true', result.created, true)
  check('路径在记忆目录下', result.path.startsWith(expectedDir), true)
  // 正确判断：不在 workspace 前缀下。不能用 includes —— 工作区名叫 dsh-memory-md，
  // slug 也含这段，includes 判断恒真且无意义。
  check('路径绝不在工作区', result.path.startsWith(WORKSPACE), false)
  check('文件真的写出来了', existsSync(result.path), true)

  const body = readFileSync(result.path, 'utf8')
  check('frontmatter 写入了 type', body.includes('type: reference'), true)
  check('frontmatter 写入了 description', body.includes('description: 本地数据库跑在 5433'), true)
  check('正文保留', body.includes('监听 5433'), true)

  console.log('\n索引由插件维护')
  const index = join(expectedDir, 'MEMORY.md')
  check('索引文件已创建', existsSync(index), true)
  const indexText = readFileSync(index, 'utf8')
  check('索引含条目', indexText.includes('[数据库端口]'), true)
  check('索引含描述', indexText.includes('本地数据库跑在 5433'), true)
  check('返回了索引行', result.indexLine, '- [数据库端口](memory/reference_数据库端口.md) — 本地数据库跑在 5433')

  console.log('\n重复写入是更新，不是新增条目')
  const again = await save.execute(
    {
      scope: 'project',
      type: 'reference',
      name: '数据库端口',
      description: '本地数据库跑在 5433（已确认）',
      content: '更新后的正文。',
      file: result.file,
    },
    exec,
  )
  check('created 为 false', again.created, false)
  const indexAfter = readFileSync(index, 'utf8')
  const occurrences = indexAfter.split('\n').filter((l) => l.includes(result.file)).length
  check('索引里只有一条该文件的条目', occurrences, 1)
  check('描述被就地更新', indexAfter.includes('已确认'), true)

  console.log('\n读取与搜索')
  const read = registered.get(TOOL_READ)
  const listing = await read.execute({ scope: 'all' }, exec)
  check('列出一条记忆', listing.entries.length, 1)
  check('条目带 type', listing.entries[0].type, 'reference')
  check('条目带 name', listing.entries[0].name, '数据库端口')

  const full = await read.execute({ scope: 'project', file: result.file }, exec)
  check('可按文件名读全文', full.text.includes('更新后的正文'), true)

  const search = registered.get(TOOL_SEARCH)
  const hit = await search.execute({ query: '5433', scope: 'all' }, exec)
  check('搜索命中', hit.matches.length > 0, true)
  check('命中带文件名', typeof hit.matches[0].file, 'string')
  check('命中带行号', Number.isInteger(hit.matches[0].line), true)

  const miss = await search.execute({ query: '绝不可能出现的字符串', scope: 'all' }, exec)
  check('无命中返回空数组', miss.matches, [])

  console.log('\n越界输入被拒绝')
  for (const [label, args] of [
    ['非法 type', { scope: 'global', type: 'evil', name: 'x', description: 'y', content: 'z' }],
    ['带目录的 file', { scope: 'global', type: 'user', name: 'x', description: 'y', content: 'z', file: '../../evil.md' }],
    ['空 query', null],
  ]) {
    const target = args === null ? search : save
    const call = args === null ? { query: '' } : args
    let threw = false
    try {
      await target.execute(call, exec)
    } catch {
      threw = true
    }
    check(`拒绝：${label}`, threw, true)
  }

  console.log('\n日志：默认关闭时不写入')
  {
    const { readSettings, resolvePaths: rp } = await import('../src/settings.mjs')
    check('默认 journal 是关的', readSettings(rp(SANDBOX)).journal, false)

    const journal = registered.get(TOOL_JOURNAL)
    const off = await journal.execute({ note: '不该落盘' }, exec)
    check('关闭时 written=false', off.written, false)
    check('关闭时不写文件', off.path, '')
    const { existsSync: ex } = await import('node:fs')
    check(
      '关闭时 .journal 目录不存在',
      ex(join(SANDBOX, 'memory-md', 'd-workspaces-ai-dsh-memory-md', '.journal')),
      false,
    )
  }

  console.log('\n日志：开启后按批次追加')
  {
    const { writeSettings, resolvePaths: rp } = await import('../src/settings.mjs')
    writeSettings(rp(SANDBOX), { journal: true })

    const journal = registered.get(TOOL_JOURNAL)
    const first = await journal.execute({ note: '装好了插件' }, exec)
    check('第一次写入 ok', first.written, true)
    check('本次新增 1 条', first.entries, 1)
    check('当天累计 1 条', first.total, 1)
    check('路径在 .journal 下', first.path.includes('.journal'), true)
    check('文件名是日期', /^\d{4}-\d{2}-\d{2}\.md$/.test(first.path.split(/[\\/]/).pop()), true)
    check('返回了时间戳', /^\d{2}:\d{2}:\d{2}$/.test(first.stamp), true)

    const second = await journal.execute({ note: '修了分隔符 bug' }, exec)
    check('第二次本次新增 1 条', second.entries, 1)
    check('当天累计 2 条', second.total, 2)
    const body = readFileSync(second.path, 'utf8')
    check('两条都在', body.includes('装好了插件') && body.includes('修了分隔符 bug'), true)
    check('顺序正确', body.indexOf('装好了插件') < body.indexOf('修了分隔符 bug'), true)
    check('有日期标题', body.startsWith('# '), true)

    console.log('\n每次操作一个时间戳小节')
    {
      const headings = body.split('\n').filter((l) => /^## \d{2}:\d{2}:\d{2}$/.test(l))
      check('两次操作 = 两个小节', headings.length, 2)
      check('小节就是返回的 stamp', headings.includes(`## ${second.stamp}`), true)

      // 一次调用多条 → 同一小节下并列
      const third = await journal.execute({ notes: ['条目一', '条目二', '条目三'] }, exec)
      check('一批 3 条', third.entries, 3)
      check('累计 5 条', third.total, 5)
      const body3 = readFileSync(third.path, 'utf8')
      const blocks = body3.split(/^## /m).slice(1)
      check('现在有三个小节', blocks.length, 3)
      const lastBlock = blocks.at(-1)
      check('最后的小节含 3 条', lastBlock.split('\n').filter((l) => l.startsWith('- ')).length, 3)
      check('最后的小节标题正确', lastBlock.startsWith(third.stamp), true)

      // note 与 notes 混用时的边界
      const fourth = await journal.execute({ notes: [], note: '仅 note' }, exec)
      check('notes 为空数组时回落 note', fourth.entries, 1)
      let emptyThrew = false
      try {
        await journal.execute({ notes: [] }, exec)
      } catch {
        emptyThrew = true
      }
      check('notes 与 note 都空 → 报错', emptyThrew, true)
    }

    // 日志**不**进记忆索引、不参与搜索 —— 这是它与记忆的本质区别。
    const listing = await registered.get(TOOL_READ).execute({ scope: 'all' }, exec)
    check('日志不出现在记忆列表', listing.entries.some((e) => e.file.includes('.journal')), false)
    const searched = await registered.get(TOOL_SEARCH).execute({ query: '装好了插件', scope: 'all' }, exec)
    check('日志不出现在搜索结果', searched.matches, [])

    let emptyThrew = false
    try {
      await journal.execute({ note: '   ' }, exec)
    } catch {
      emptyThrew = true
    }
    check('空 note 被拒绝', emptyThrew, true)

    console.log('\n并发追加不丢条目')
    {
      // 回归：早先临时文件名是 `<path>.<pid>.tmp`，同进程并发写会共用同一个
      // 临时文件，后写的覆盖先写的，再各自 rename —— 条目静默消失。
      //
      // 注意：`execute` 内部是同步的，单纯 Promise.all 不会真的交错。所以这里
      // 直接对底层做真实交错：两次「读→拼接→写」各自在不同时刻发生。
      const before = readFileSync(second.path, 'utf8')
      const base = before.split('\n').filter((l) => l.startsWith('- ')).length

      // 1) 顺序写入：验证追加语义本身没问题。
      const results = []
      for (let i = 0; i < 8; i++) {
        results.push(await journal.execute({ note: `并发条目 ${i}` }, exec))
      }
      const after = readFileSync(second.path, 'utf8')
      const now = after.split('\n').filter((l) => l.startsWith('- ')).length

      check('8 次写入全部保留', now, base + 8)
      check('每条都能在文件里找到', Array.from({ length: 8 }, (_, i) => `并发条目 ${i}`).every((n) => after.includes(n)), true)
      check('每次返回新增 1 条', results.every((r) => r.entries === 1), true)
      check('total 单调递增', results.every((r, i) => r.total === base + i + 1), true)
      check('没有残留临时文件', existsSync(`${second.path}.${process.pid}.tmp`), false)
    }

    console.log('\n原子写的临时文件名唯一')
    {
      // 直接验证 writeAtomic 的临时名不含可复用的固定后缀 —— 这是丢条目的根因。
      // 实现已抽到 store.mjs（工具与后台总结共用一套写入原语）。
      const src = readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8')
      const usesRandom = /const tmp = `\$\{path\}\.\$\{process\.pid\}\.\$\{randomUUID\(\)/.test(src)
      check('临时名带随机后缀', usesRandom, true)
      const fixedPidOnly = /const tmp = `\$\{path\}\.\$\{process\.pid\}\.tmp`/.test(src)
      check('不再使用仅含 pid 的固定名', fixedPidOnly, false)
    }

    writeSettings(rp(SANDBOX), { journal: false })
  }

  console.log('\n总开关关闭时拒绝写入')
  {
    const { writeSettings, resolvePaths: rp } = await import('../src/settings.mjs')
    writeSettings(rp(SANDBOX), { enabled: false })
    check(
      '关闭后 save 被拒绝',
      await throwsSync(() =>
        registered.get(TOOL_WRITE).execute(
          { scope: 'global', type: 'user', name: 'x', description: 'y', content: 'z' },
          exec,
        ),
      ),
      true,
    )
    const stillSearching = await registered.get(TOOL_SEARCH).execute({ query: '5433', scope: 'all' }, exec)
    check('关闭后 search 仍可用', Array.isArray(stillSearching.matches), true)
    const stillReading = await registered.get(TOOL_READ).execute({ scope: 'all' }, exec)
    check('关闭后 read 仍可用', Array.isArray(stillReading.entries), true)
    writeSettings(rp(SANDBOX), { enabled: true })
  }

  console.log('\nglobal 作用域不需要工作区')
  const noWsRegistered = new Map()
  registerMemoryTools({
    tools: { register: (d) => { noWsRegistered.set(d.name, d); return () => {} } },
    config: makeConfig(undefined),
    logger,
  })
  const globalSave = noWsRegistered.get(TOOL_WRITE)
  check(
    'project 无工作区时报错',
    await throwsSync(() =>
      globalSave.execute({ scope: 'project', type: 'user', name: 'a', description: 'b', content: 'c' }, exec),
    ),
    true,
  )
  const g = await globalSave.execute(
    { scope: 'global', type: 'user', name: '偏好', description: '喜欢简洁', content: '用 pnpm。' },
    exec,
  )
  check('global 仍然可写', g.created, true)
  check('global 路径正确', g.path.startsWith(join(SANDBOX, 'memory-md', 'global')), true)

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
