/**
 * paths.test.mjs — 路径解析（真实函数，不硬编码本机路径）。
 *
 * 前身是 `verify-paths.mjs`：它**手工镜像**了 `dshHomeDir()` 的实现
 * （注释自称 `// Mirror detectDshHome() exactly.`），却没有任何机制保证两边一致 ——
 * 镜像漂移时它继续绿；而且大量 `console.log` 不校验任何东西，读起来像覆盖。
 *
 * 现在直接 import 真实函数，用 `DSH_HOME` / 临时目录造输入。
 */
import { dshHomeDir, memoryRoot, resolveScopes, journalFileName, MEMORY_ROOT_NAME } from '../src/context.mjs'

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

console.log('\ndshHomeDir：显式 DSH_HOME 优先')
{
  check('显式路径原样返回', dshHomeDir('D:\\custom\\.dsh'), 'D:\\custom\\.dsh')
  check('去掉首尾空白', dshHomeDir('  D:\\x\\.dsh  '), 'D:\\x\\.dsh')
  check('空串 → 回落（不返回空串）', dshHomeDir(''), dshHomeDir(undefined))
  check('只有空白 → 回落', dshHomeDir('   '), dshHomeDir(undefined))
}

console.log('\ndshHomeDir：回落顺序 DSH_HOME → USERPROFILE → HOME')
{
  // 该函数读 `process.env`（不接受 env 参数），所以测试要临时改环境变量。
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }
  const withEnv = (env) => {
    for (const k of ['DSH_HOME', 'USERPROFILE', 'HOME']) delete process.env[k]
    Object.assign(process.env, env)
    try {
      return dshHomeDir(undefined)
    } finally {
      for (const k of ['DSH_HOME', 'USERPROFILE', 'HOME']) delete process.env[k]
      Object.assign(process.env, saved)
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    }
  }

  check('DSH_HOME 优先', withEnv({ DSH_HOME: 'D:\\e\\.dsh', USERPROFILE: 'C:\\u' }), 'D:\\e\\.dsh')
  check('无 DSH_HOME → USERPROFILE 拼 .dsh', withEnv({ USERPROFILE: 'C:\\u\\a' }), 'C:\\u\\a\\.dsh')
  check('无 USERPROFILE → HOME（posix 分隔符）', withEnv({ HOME: '/home/a' }), '/home/a/.dsh')
  check('两者都在时优先 USERPROFILE',
    withEnv({ USERPROFILE: 'C:\\u\\a', HOME: '/home/a' }), 'C:\\u\\a\\.dsh')
  check('都没有 → undefined', withEnv({}), undefined)

  // 显式参数最优先，且不依赖环境。
  check('显式参数压过环境',
    (() => { const keep = process.env.DSH_HOME; process.env.DSH_HOME = 'X'; try { return dshHomeDir('D:\\explicit') } finally { if (keep === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = keep } })(),
    'D:\\explicit')
}

console.log('\nmemoryRoot 在 DSH home 之下')
{
  const r = memoryRoot('D:\\custom\\.dsh')
  check('root 是 <dshHome>/memory-md', r, `D:\\custom\\.dsh\\${MEMORY_ROOT_NAME}`)
  check('root 不含工作区路径', r.includes('workspaces'), false)
}

console.log('\nresolveScopes：slug 规则与目录布局')
{
  const s = resolveScopes({ cwd: 'D:\\workspaces\\ai\\demo-app', dshHome: 'C:\\h\\.dsh' })
  check('slug 压缩（盘符/分隔符转 - 并小写）', s.slug, 'd-workspaces-ai-demo-app')
  check('root 在 dshHome 下', s.root, 'C:\\h\\.dsh\\memory-md')
  check('global 索引是 <root>/global/MEMORY.md', s.global.index, 'C:\\h\\.dsh\\memory-md\\global\\MEMORY.md')
  check('project 索引在 slug 目录下', s.project.index, 'C:\\h\\.dsh\\memory-md\\d-workspaces-ai-demo-app\\MEMORY.md')
  // 新目录结构：正文在 memory/ 子目录，日志在 .journal/
  check('project 日志在 .journal 子目录', s.project.journalDir.endsWith('.journal'), true)
}

console.log('\nresolveScopes：posix 路径与边界')
{
  const p = resolveScopes({ cwd: '/home/me/proj', dshHome: '/home/me/.dsh' })
  check('posix slug', p.slug, 'home-me-proj')
  check('posix project 索引', p.project.index, '/home/me/.dsh/memory-md/home-me-proj/MEMORY.md')

  const trailing = resolveScopes({ cwd: 'D:\\a\\b\\', dshHome: 'D:\\h' })
  check('结尾分隔符不影响 slug', trailing.slug, 'd-a-b')
}

console.log('\njournalFileName：零填充日期')
{
  check('补零', journalFileName(new Date(2026, 0, 5)), '2026-01-05')
  check('两位数不变', journalFileName(new Date(2026, 11, 31)), '2026-12-31')
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
