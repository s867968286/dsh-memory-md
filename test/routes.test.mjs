/**
 * routes.test.mjs — drive the HTTP routes directly.
 *
 * 历史教训（两道，都写在断言里防回归）：
 *
 * 1. 早期曾把 MEMORY ROOT 当成 cwd 传进 `resolveScopes()`，设置页于是显示一个
 *    C 盘伪项目（`c-users-kosei-dsh-memory-md`），跟任何真实工作区都对不上。
 * 2. 后来改为让 Host 半从 `sessions.list()` 猜当前工作区，但官方文档明确该
 *    列表是**创建顺序** —— 于是永远返回最老的会话，**切换会话后界面仍显示
 *    上一个会话的路径**。
 *
 * 结论：设置页是全局页面，拿不到「当前会话」。所以 `/api/state` 现在**只返回
 * 与会话无关的路径**（记忆根目录 / 用户级目录 / 设置文件），一个会话相关字段
 * 都不给 —— 不猜，也就不会猜错。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-routes-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { registerRoutes, ROUTE_PREFIX } = await import('../src/routes.mjs')

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

/** 收集注册的路由，并提供一个直接调用它的能力。 */
function makeHarness() {
  const routes = []
  const ctx = {
    logger: { warn: () => {} },
    emit: () => {},
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  // 注意：不再传 getWorkspaceCwd —— 该参数已随"猜工作区"一起移除。
  registerRoutes(ctx, {})
  return { routes, route: routes[0] }
}

/** 用假的 req/res 调一次路由，返回解析后的 JSON。 */
/**
 * 调一次路由。
 *
 * `body` 传对象时序列化成 JSON 并作为请求体流式喂给 handler —— 官方路由
 * 是读流解析的，直接塞属性不管用。
 */
async function callRoute(route, path, method = 'GET', body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    url: `${ROUTE_PREFIX}${path}`,
    method,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8')
    },
  }
  let status = 0
  let responseBody = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      responseBody = chunk
    },
  }
  await route.handler(req, res)
  return { status, json: responseBody ? JSON.parse(responseBody) : null }
}

try {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(join(SANDBOX, 'memory-md'), { recursive: true })

  console.log('\n/state 只给与会话无关的路径')
  {
    const { route } = makeHarness()
    const { status, json } = await callRoute(route, '/api/state')
    check('status 200', status, 200)
    check('root 是记忆目录', json.root, join(SANDBOX, 'memory-md'))
    check('用户级目录在 root 下', json.globalDir, join(SANDBOX, 'memory-md', 'global'))
    check('给出设置文件路径', json.settingsFile, join(SANDBOX, 'memory-md', 'settings.json'))
  }

  console.log('\n不返回任何会话相关字段（否则切换会话就会显示错路径）')
  {
    const { route } = makeHarness()
    const { json } = await callRoute(route, '/api/state')
    // 这几条正是「切换会话后还显示上一个路径」的根源，必须不存在。
    check('没有 project 作用域', json.project, undefined)
    check('没有 cwd', json.cwd, undefined)
    check('没有 slug', json.slug, undefined)
    // 留痕目录也是项目级路径，一并去掉。
    check('没有 journalDir', json.journalDir, undefined)
  }

  console.log('\n不返回条目清单与计数（设置页不展示记忆规模）')
  {
    const { route } = makeHarness()
    const globalDir = join(SANDBOX, 'memory-md', 'global')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'reference_db.md'), '---\nname: DB\ntype: reference\n---\n\n5433\n', 'utf8')
    writeFileSync(join(globalDir, 'MEMORY.md'), '- [DB](reference_db.md) \u2014 port 5433\n', 'utf8')

    const { json } = await callRoute(route, '/api/state')
    check('没有 global 对象', json.global, undefined)
    check('没有条目清单', json.memories, undefined)
    // 中文名文件同样不该让接口出错 —— 插件自己就会派生这种名字。
    writeFileSync(
      join(globalDir, 'reference_\u6570\u636e\u5e93\u7aef\u53e3.md'),
      '---\nname: \u6570\u636e\u5e93\u7aef\u53e3\ntype: reference\n---\n\n5433\n',
      'utf8',
    )
    const again = await callRoute(route, '/api/state')
    check('中文名文件不影响响应', again.status, 200)
  }

  console.log('\n内容接口已移除')
  {
    const { route } = makeHarness()
    const memory = await callRoute(route, '/api/memory?scope=project&file=a.md')
    check('/api/memory 不再存在', memory.status, 404)
    const journal = await callRoute(route, '/api/journal/2026-01-01')
    check('/api/journal 不再存在', journal.status, 404)
  }

  console.log('\nsettings round-trip through the route')
  {
    const { route } = makeHarness()
    const settingsFile = join(SANDBOX, 'memory-md', 'settings.json')

    const put = await callRoute(route, '/api/settings', 'PUT')
    check('PUT without a body is rejected', put.status, 400)
    // A rejected write must not create the file — no side effect on bad input.
    check('rejected write leaves no file', existsSync(settingsFile), false)

    const get = await callRoute(route, '/api/settings')
    check('GET returns defaults', get.json.settings, {
      enabled: true,
      journal: false,
      minReviewTurns: 2,
      minReviewChars: 2000,
      disabledPresets: [],
    })
  }

  // 双阈值是**设置项**（可在设置页调），归一化必须挡住坏值。
  //
  // 关键设计：非正数**回落默认值**，不夹到下限 —— `Math.max(1, 0)` 会把用户
  // 以为"关掉了门槛"的 0 静默变成 1，语义变了却看不出来。
  console.log('\n触发阈值：可在设置页调，坏值回落默认')
  {
    const { route } = makeHarness()

    const put = async (patch) => {
      const res = await callRoute(route, '/api/settings', 'PUT', patch)
      return res.json?.settings
    }

    // 正常值：原样保存
    let s = await put({ minReviewTurns: 5, minReviewChars: 8000 })
    check('轮数原样保存', s.minReviewTurns, 5)
    check('字符数原样保存', s.minReviewChars, 8000)

    // ⭐ 清空字段 = 用回默认值（界面上不显示默认，所以这是用户唯一的"重置"手段）。
    //
    // ⚠️ 必须提交 **null** 而不是 undefined：`JSON.stringify({k: undefined})`
    // 会把键整个丢掉，请求体里根本没这个字段，服务端当然不会重置 ——
    // 用户以为清空了，实际还是旧值。这条断言就是锁这个坑。
    s = await put({ minReviewTurns: 5, minReviewChars: 8000 })
    s = await put({ minReviewTurns: null, minReviewChars: null })
    check('清空（null）→ 轮数回默认', s.minReviewTurns, 2)
    check('清空（null）→ 字符数回默认', s.minReviewChars, 2000)

    // 反证：undefined 会从 JSON 里消失 —— 这正是不能用它的原因。
    check('undefined 会被 JSON 丢掉（所以不能用它表示清空）',
      JSON.stringify({ minReviewTurns: undefined }), '{}')

    // 字符串数字也能接受（表单/JSON 里常见）
    s = await put({ minReviewTurns: '3', minReviewChars: '1500' })
    check('数字字符串被接受（轮数）', s.minReviewTurns, 3)
    check('数字字符串被接受（字符数）', s.minReviewChars, 1500)

    // 坏值一律回落默认 —— 且**不夹到下限**
    for (const [label, bad] of [['0', 0], ['负数', -5], ['小数', 2.5], ['非数字', 'abc']]) {
      const a = await put({ minReviewTurns: bad })
      check(`${label} → 轮数回落默认`, a.minReviewTurns, 2)
      const b = await put({ minReviewChars: bad })
      check(`${label} → 字符数回落默认`, b.minReviewChars, 2000)
    }

    // 坏值不该把**其它**字段带坏
    const mixed = await put({ minReviewTurns: 'abc', enabled: false })
    check('坏值不影响其它字段', mixed.enabled, false)
    check('坏值字段本身回落', mixed.minReviewTurns, 2)
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
