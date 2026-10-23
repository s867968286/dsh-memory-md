/**
 * layout.test.mjs — 记忆目录布局与错误日志。
 *
 * 布局约定（每个作用域一致）：
 *
 *   <scope>/MEMORY.md        索引（唯一入口，注入用）
 *   <scope>/memory/*.md      记忆正文
 *   <scope>/.journal/*.md    工作留痕（只写不读）
 *
 * 三者同级。正文放子目录让作用域根干净，并与 `.journal/` 对称。
 *
 * 注：**历史数据的搬迁不在这里** —— 那是一次性运维动作（见 README 的迁移说明），
 * 不是插件运行时行为。插件只保证「新写入落在正确位置」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-layout-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const { appendErrorLog, MEMORY_DIR, listMemoryFiles, memoryFilePath, resolveMemoryFile, writeMemory } =
  await import('../src/store.mjs')

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

const DIR = join(SANDBOX, 'global')

try {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })

  console.log('\n新写入的正文落在 memory/ 子目录')
  {
    writeMemory(DIR, {
      file: 'user_a.md',
      type: 'user',
      name: '甲',
      description: '甲描述',
      content: '正文甲',
    })
    check('正文在 memory/ 下', existsSync(join(DIR, MEMORY_DIR, 'user_a.md')), true)
    check('正文不在作用域根', existsSync(join(DIR, 'user_a.md')), false)
    check('索引在作用域根', existsSync(join(DIR, 'MEMORY.md')), true)
  }

  console.log('\n索引链接带 memory/ 前缀（否则点开找不到）')
  {
    const idx = readFileSync(join(DIR, 'MEMORY.md'), 'utf8')
    check('链接带前缀', idx.includes('](memory/user_a.md)'), true)
    check('没有裸链接', idx.includes('](user_a.md)'), false)
    // 链接必须真的能解析到文件
    const link = idx.match(/\]\(([^)]+)\)/)?.[1]
    check('链接可解析', existsSync(join(DIR, link)), true)
  }

  console.log('\n更新已有记忆：原地替换，不新增条目')
  {
    writeMemory(DIR, {
      file: 'user_a.md',
      type: 'user',
      name: '甲（改）',
      description: '新描述',
      content: '正文甲改了',
    })
    const idx = readFileSync(join(DIR, 'MEMORY.md'), 'utf8')
    check('索引只有一条', idx.split('\n').filter((l) => l.startsWith('- ')).length, 1)
    check('条目被更新', idx.includes('甲（改）'), true)
    check('正文已更新', readFileSync(join(DIR, MEMORY_DIR, 'user_a.md'), 'utf8').includes('正文甲改了'), true)
  }

  console.log('\nlistMemoryFiles 只扫 memory/ 子目录（不递归）')
  {
    // 作用域根放个 .md，不该被当成记忆
    writeFileSync(join(DIR, 'stray.md'), '---\ntype: user\n---\n\n杂项\n', 'utf8')
    // memory/ 下放个子目录，也不该递归进去
    mkdirSync(join(DIR, MEMORY_DIR, 'nested'), { recursive: true })
    writeFileSync(join(DIR, MEMORY_DIR, 'nested', 'deep.md'), '---\ntype: user\n---\n\n深\n', 'utf8')

    const list = listMemoryFiles(DIR)
    check('不含作用域根的 stray.md', list.includes('stray.md'), false)
    check('含 memory/ 里的正文', list.includes('user_a.md'), true)
    check('不含索引 MEMORY.md', list.includes('MEMORY.md'), false)
    check('不递归进子目录', list.includes('deep.md'), false)
  }

  console.log('\nmemoryFilePath 指向 memory/')
  {
    check('路径正确', memoryFilePath(DIR, 'x.md'), join(DIR, MEMORY_DIR, 'x.md'))
  }

  console.log('\n错误日志：追加写、带时间戳、不进 .journal')
  {
    const logFile = join(SANDBOX, 'error.log')
    appendErrorLog(logFile, '第一条错误')
    appendErrorLog(logFile, '第二条  错误\n带换行')
    const text = readFileSync(logFile, 'utf8')
    check('两条都在', text.includes('第一条错误') && text.includes('第二条'), true)
    check('每条一行（换行被压平）', text.trim().split('\n').length, 2)
    check('带时间戳前缀', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  /.test(text), true)
    // 错误日志与作用域无关，不在任何 .journal/ 里
    check('不在 .journal 里', logFile.includes('.journal'), false)
  }

  console.log('\n错误日志失败时静默（不能再抛错）')
  {
    let threw = false
    try {
      appendErrorLog('\u0000bad', 'x')
      appendErrorLog(undefined, 'x')
      appendErrorLog(join(SANDBOX, 'error.log'), '')
    } catch {
      threw = true
    }
    check('不抛错', threw, false)
  }

  console.log('\nfrontmatter 值一行化（换行会污染文件与索引）')
  {
    // 实测过的真事故：description 含换行时，索引会**凭空多出一行**
    // —— 一条记忆于是能往索引里插任意多行，而索引是整份注入上下文的东西。
    // 含 `\n---\n` 更严重：frontmatter 提前闭合，type 等字段直接丢失。
    const DIR2 = join(SANDBOX, 'oneline')
    mkdirSync(DIR2, { recursive: true })
    writeMemory(DIR2, {
      file: 'evil.md',
      type: 'feedback',
      name: '正常标题',
      description: '无害描述\n- [伪造条目](memory/evil2.md) — 我插进来的',
      content: '正文',
    })
    const idx = readFileSync(join(DIR2, 'MEMORY.md'), 'utf8')
    const entryLines = idx.split('\n').filter((l) => l.startsWith('- '))
    check('索引只多了一条应有条目', entryLines.length, 1)
    check('没有伪造条目', idx.includes('伪造条目'), true) // 文字保留…
    check('…但被压在同一行里', idx.includes('](memory/evil2.md)'), true)
    // 关键：它没有变成**独立的索引行**
    check('伪造内容不构成独立行', entryLines.some((l) => l.startsWith('- [伪造条目]')), false)

    // --- 作为分隔符时不能提前闭合 frontmatter
    const DIR3 = join(SANDBOX, 'sep')
    mkdirSync(DIR3, { recursive: true })
    writeMemory(DIR3, {
      file: 'b.md',
      type: 'feedback',
      name: 'B',
      description: '正常描述\n---\ntype: user\nname: 伪造',
      content: '正文B',
    })
    const raw = readFileSync(join(DIR3, MEMORY_DIR, 'b.md'), 'utf8')
    const { parseMemoryFrontmatter } = await import('../src/codebuddy-port.mjs')
    const { data } = parseMemoryFrontmatter(raw)
    check('type 未被篡改', data.type, 'feedback')
    check('name 未被篡改', data.name, 'B')
    check('frontmatter 只有三行', raw.split('\n').slice(1, 4).every((l) => /^\w+: /.test(l)), true)

    // --- 索引行的收口处（upsertIndexLine）**自带**一行化，不依赖调用方。
    // 索引是整份注入上下文的东西，一行断裂就凭空多一条索引项。
    // 这条断言锁住「防御在收口处」——将来多一个调用方忘了折叠也不会破索引。
    const { upsertIndexLine } = await import('../src/store.mjs')
    const DIR6 = join(SANDBOX, 'upsert')
    mkdirSync(DIR6, { recursive: true })
    const idx6 = join(DIR6, 'MEMORY.md')
    upsertIndexLine(idx6, 'memory/a.md', '标题\n- [伪造](memory/evil.md) — 插进来的', '描述\n第二行')
    const idx6Text = readFileSync(idx6, 'utf8')
    check('收口处折叠了换行（只一条索引行）',
      idx6Text.split('\n').filter((l) => l.startsWith('- ')).length, 1)
  }

  console.log('\n日志条目一行一条（含换行的 note 不能伪造出额外条目）')
  {
    // 日志的条目结构就是「- 开头的行」。一条 note 含换行时，后半截会变成
    // **另一条独立条目** —— 实测：countEntries 会把一条 note 数成 2 条，
    // 于是 memory_md_journal 回报的 total 虚高，人读起来也多出没写过的记录。
    // 与 frontmatter 同理：契约本来就是"每条 1-3 句"，折叠不改变语义。
    const { appendJournalEntries, countEntries } = await import('../src/store.mjs')
    const notes = ['第一句结论\n- 伪造的第二条条目', '正常条目']
    const out = appendJournalEntries(undefined, '2026-09-17', notes, '10:00:00')
    check('条目数与传入一致', countEntries(out), notes.length)
    check('没有伪造出的独立条目行',
      out.split('\n').filter((l) => l.startsWith('- ')).length, notes.length)
    check('原文语义保留（折叠成一行）', out.includes('第一句结论 - 伪造的第二条条目'), true)
  }

  console.log('\n索引行的匹配必须精确到「行首链接」（描述里的链接不能骗到它）')
  {
    // 实测过的真事故：一条记忆的描述里**引用另一条记忆的链接**是自然写法
    // （协议还鼓励"细节写进条目文件"）。原来用整行子串 `](${file})` 匹配，于是：
    //
    //   - upsert：先写甲、其描述含 `](memory/b.md)`；再写乙时 findIndex 找
    //     `](memory/b.md)` 会**先命中甲那一行**，把甲的行原地替换成乙 —— 甲消失。
    //   - remove：甲的描述里提到乙，删乙时会**连带删掉甲**。
    //
    // ⚠️ 用例顺序必须让「先写的条目描述里引用后写的文件」，否则触发不到。
    const { upsertIndexLine, removeIndexLine } = await import('../src/store.mjs')
    const DIR7 = join(SANDBOX, 'match')
    mkdirSync(DIR7, { recursive: true })
    const p = join(DIR7, 'MEMORY.md')
    const entries = () => readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('- '))

    // 甲先写，描述里引用**尚未存在**的乙
    upsertIndexLine(p, 'memory/a.md', '甲', '见 ](memory/b.md) 那条')
    upsertIndexLine(p, 'memory/b.md', '乙', '第二条')
    check('写乙后两条都在（甲未被顶掉）', entries().length, 2)
    check('甲的条目完好', entries().some((l) => l.includes('[甲](memory/a.md)')), true)
    check('乙的条目也写入', entries().some((l) => l.includes('[乙](memory/b.md)')), true)

    // 更新乙 → 只改乙那一行
    upsertIndexLine(p, 'memory/b.md', '乙（改）', '新描述')
    check('更新乙后仍是两条', entries().length, 2)
    check('甲的行没被碰', entries().some((l) => l.includes('[甲](memory/a.md)')), true)

    // 删乙 → 甲的条目必须留下（甲的描述里含乙的链接，不能因此被删）
    removeIndexLine(p, 'memory/b.md')
    check('删乙后甲仍在', entries().some((l) => l.includes('[甲](memory/a.md)')), true)
    check('删乙后只剩一条', entries().length, 1)
  }

  console.log('\n标题含方括号（byte[]）时索引行仍能被认出来（不得重复追加）')
  {
    // 实测过的真事故：zcpt 作用域里一条标题为
    // 「fastjson 兼容包 byte[] 的 invalid base64 缺陷」的记忆，
    // 在 MEMORY.md 里被**重复写了 7 遍**，界面永远显示"未索引"。
    //
    // 根因是判据写成了 `/^- \[[^\]]*\]\(([^)]*)\)/`：`[^\]]*` 在 `byte[]` 的
    // 第一个 `]` 处就停住，剩下的 ` 的 invalid …](link)` 接不上 `](`，整行不匹配。
    // upsert 于是每次都判定"索引里没有它"，每调用一次就多追加一行。
    //
    // 断言「行数不增长」比断言字符串内容更能锁住这个缺陷 —— 只要出现第 2 行，
    // 就说明判据又退化成"标题中不许有 `]`"了。
    const { upsertIndexLine, removeIndexLine } = await import('../src/store.mjs')
    const DIR8 = join(SANDBOX, 'bracket')
    mkdirSync(DIR8, { recursive: true })
    const p = join(DIR8, 'MEMORY.md')
    const entries = () => readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('- '))
    const FILE = 'memory/project_zcpt_fastjson兼容包_base64缺陷.md'
    const TITLE = 'fastjson 兼容包 byte[] 的 invalid base64 缺陷'

    // 反复收录同一条 —— 真实事故里是 7 次，这里写满 7 次复刻。
    for (let i = 0; i < 7; i++) upsertIndexLine(p, FILE, TITLE, '在 zcpt 排查…')
    check('重复收录 7 次仍只有 1 行', entries().length, 1)
    check('标题原样保留（含 byte[]）', entries().some((l) => l.includes(`[${TITLE}]`)), true)

    // 内容变了要能**原地更新**，而不是再追加一行。
    upsertIndexLine(p, FILE, TITLE, '改过的描述')
    check('更新后仍是 1 行', entries().length, 1)
    check('描述已更新', entries()[0].includes('改过的描述'), true)

    removeIndexLine(p, FILE)
    check('删除能认出这条（不是删不掉）', entries().length, 0)

    // 别的方括号形态也要认得出：以方括号开头、方括号在标题中间。
    const p2 = join(DIR8, 'MEMORY2.md')
    const entries2 = () => readFileSync(p2, 'utf8').split('\n').filter((l) => l.startsWith('- '))
    upsertIndexLine(p2, 'memory/x.md', '[废弃] 旧方案', '说明')
    upsertIndexLine(p2, 'memory/x.md', '[废弃] 旧方案', '说明改了')
    check('标题以方括号开头也能原地更新', entries2().length, 1)
    upsertIndexLine(p2, 'memory/y.md', 'byte[1024] 缓冲区', '说明')
    upsertIndexLine(p2, 'memory/y.md', 'byte[1024] 缓冲区', '说明改了')
    check('方括号在标题中间也能原地更新', entries2().length, 2)
  }

  console.log('\n派生文件名避开 slug 撞车（否则整条记忆被覆盖）')
  {
    // 实测过的真事故：slugify 把非 [a-z0-9中文] 全换成 _，于是
    // 「重试机制」与「重试机制！」派生出**同一个**文件名，
    // 后写的把先写的整条覆盖掉，且索引里也只留后一条 —— 前一条无声消失。
    const DIR4 = join(SANDBOX, 'slug')
    mkdirSync(DIR4, { recursive: true })

    const a = resolveMemoryFile(DIR4, { type: 'feedback', name: '重试机制' })
    check('第一条派生名', a, 'feedback_重试机制.md')
    writeMemory(DIR4, { file: a, type: 'feedback', name: '重试机制', description: '接口失败要重试', content: '正文A' })

    // 同名重复保存 → 仍走同一个文件（就地更新，既有契约）
    const same = resolveMemoryFile(DIR4, { type: 'feedback', name: '重试机制' })
    check('同名 → 就地更新（不新开文件）', same, a)

    // 异名但同 slug → 必须另起文件，不能覆盖
    const b = resolveMemoryFile(DIR4, { type: 'feedback', name: '重试机制！' })
    check('异名同 slug → 另起文件', b !== a, true)
    writeMemory(DIR4, { file: b, type: 'feedback', name: '重试机制！', description: '重试要退避', content: '正文B' })

    check('两条记忆都在', listMemoryFiles(DIR4).sort(), ['feedback_重试机制-2.md', 'feedback_重试机制.md'])
    check('第一条正文没被覆盖', readFileSync(join(DIR4, MEMORY_DIR, a), 'utf8').includes('正文A'), true)
    const idx4 = readFileSync(join(DIR4, 'MEMORY.md'), 'utf8')
    check('索引有两条', idx4.split('\n').filter((l) => l.startsWith('- ')).length, 2)

    // 显式传 file + **同名** → 这就是「传同一个 file 覆盖更新」的契约，照用。
    const sameTitle = resolveMemoryFile(DIR4, { requested: 'feedback_重试机制.md', type: 'feedback', name: '重试机制' })
    check('显式 file + 同名 → 就地覆盖（既有契约）', sameTitle, 'feedback_重试机制.md')

    // 显式传 file + **异名** → 绝不允许覆盖别人！
    // 这是 2026-10-18 修掉的真事故：后台总结只拿到「文件名 + 描述」清单、
    // 看不到正文，凭"名字沾边"就把清单里某条的文件名填进 file，于是
    // global 的「社保国产化工作区与开发环境速查」被两个 sbf 工作区各抄一次，
    // 两条无关记忆顶着别人的文件名活了下来（实测共 9 例）。
    // 修前这里返回 'feedback_重试机制.md' 并把正文A 整条抹掉。
    const clash = resolveMemoryFile(DIR4, { requested: 'feedback_重试机制.md', type: 'feedback', name: '换成别的标题' })
    check('显式 file + 异名 → 不覆盖，改走派生', clash !== 'feedback_重试机制.md', true)

    // 长标题截断到 40 字符 → 前 40 字相同的标题必然撞车，同样要避开
    const longA = 'A'.repeat(60) + 'x'
    const longB = 'A'.repeat(60) + 'y'
    const DIR5 = join(SANDBOX, 'slug2')
    mkdirSync(DIR5, { recursive: true })
    const fa = resolveMemoryFile(DIR5, { type: 'project', name: longA })
    writeMemory(DIR5, { file: fa, type: 'project', name: longA, description: 'd1', content: 'c1' })
    const fb = resolveMemoryFile(DIR5, { type: 'project', name: longB })
    check('超长标题撞车也另起文件', fb !== fa, true)
  }

  console.log('\n标题空白差异不该被当成异名（否则会多出看不见来源的 -2）')
  {
    // writeMemory 会把 name 过 oneLine() 折叠空白后写进 frontmatter。
    // 若比较时用原始 name，标题里多一个换行/连续空格就被判成异名 → 另存 -2。
    const DIR7 = join(SANDBOX, 'whitespace')
    mkdirSync(DIR7, { recursive: true })
    writeMemory(DIR7, { file: 'feedback_重试机制.md', type: 'feedback', name: '重试机制', description: 'd', content: 'c' })
    const spaced = resolveMemoryFile(DIR7, { requested: 'feedback_重试机制.md', type: 'feedback', name: '  重试机制  ' })
    check('前后空白 → 视为同一条，仍就地更新', spaced, 'feedback_重试机制.md')
    const NL = String.fromCharCode(92) + 'n'
    const nl = resolveMemoryFile(DIR7, { requested: 'feedback_重试机制.md', type: 'feedback', name: '重试' + NL + '机制' })
    // 换行被 oneLine() 折成空格 → slug 化后是 `重试_机制`，文件名与标题仍然一致。
    check('中间换行 → 折叠后仍算同一条（不另存 -2）', nl.includes('-2.md'), false)
  }

  console.log('\n显式 file 撞名时不能抹掉别人的正文（端到端）')
  {
    // 复刻后台总结抄错名字的完整写入序列：先有一条别人的记忆，
    // 再让一次总结把那个文件名填进 file，写一条完全无关的内容。
    const DIR6 = join(SANDBOX, 'crosswrite')
    mkdirSync(DIR6, { recursive: true })

    writeMemory(DIR6, { file: 'project_速查.md', type: 'project', name: '速查', description: '坐标', content: '正文A' })
    const f = resolveMemoryFile(DIR6, { requested: 'project_速查.md', type: 'project', name: '完全无关的 jackson 结论' })
    check('撞名不再返回别人的文件名', f === 'project_速查.md', false)
    writeMemory(DIR6, { file: f, type: 'project', name: '完全无关的 jackson 结论', description: 'CVE', content: '正文B' })

    const files = listMemoryFiles(DIR6).sort()
    check('两条记忆都在，没有互相顶掉', files.length, 2)
    const bodyA = readFileSync(join(DIR6, MEMORY_DIR, 'project_速查.md'), 'utf8')
    check('原记忆的正文与标题都还在', bodyA.includes('正文A') && bodyA.includes('name: 速查'), true)
    check('新记忆写进了自己的文件', bodyA.includes('正文B'), false)

    const idx6 = readFileSync(join(DIR6, 'MEMORY.md'), 'utf8')
    check('索引里两条都在', idx6.split('\n').filter((l) => l.startsWith('- ')).length, 2)
    check('索引标题没有被顶掉', idx6.includes('[速查]'), true)
  }

  console.log('\n标题里混进文件名残渣时不能污染派生名（双前缀 / _md）')
  {
    // 实测事故：索引标题就是 name，长这样 `- [feedback_断言必须回退验证会变红](memory/...)`。
    // 模型看到带前缀的标题，就把 `feedback_xxx` 甚至 `xxx.md` 原样填回 name：
    //   name = `feedback_断言必须回退验证会变红.md`
    //   → `feedback_` + slugify(...) → `feedback_feedback_断言必须回退验证会变红_md.md`
    // 库里已积累 27 个双前缀、22 个 `_md` 结尾（共 527 条）。
    const DIR8 = join(SANDBOX, 'residue')
    mkdirSync(DIR8, { recursive: true })

    const dirty = resolveMemoryFile(DIR8, { type: 'feedback', name: 'feedback_断言必须回退验证会变红.md' })
    check('双前缀 + .md 残渣被剥净', dirty, 'feedback_断言必须回退验证会变红.md')

    writeMemory(DIR8, { file: dirty, type: 'feedback', name: 'feedback_断言必须回退验证会变红.md', description: 'd', content: '正文' })
    const raw = readFileSync(join(DIR8, MEMORY_DIR, dirty), 'utf8')
    check('frontmatter 的 name 也洗干净了', raw.includes('name: 断言必须回退验证会变红\n'), true)
    const idx = readFileSync(join(DIR8, 'MEMORY.md'), 'utf8')
    check('索引标题不再带前缀与后缀', idx.includes('[断言必须回退验证会变红]'), true)

    // 关键：先用脏标题存、再用干净标题存，必须命中**同一个**文件。
    // 若两边归一化不一致，这里会另起 `-2`，正是要消灭的那种重复。
    const clean = resolveMemoryFile(DIR8, { type: 'feedback', name: '断言必须回退验证会变红' })
    check('脏标题存过之后，干净标题仍命中同一文件', clean, dirty)

    // 四种类型前缀**全剥**，不只剥与本次 type 相同的那一个。
    // 理由：`feedback_user_用户身份.md` 同样是脏名 —— 模型把 `user_` 当成标题的一部分，
    // 而文件名已有的 `feedback_` 才是唯一的类型标签；留着会让同一话题出现两种形态。
    check('异 type 前缀也剥掉',
      resolveMemoryFile(DIR8, { type: 'feedback', name: 'project_某某结论' }),
      'feedback_某某结论.md')
    check('user_ 前缀也剥掉',
      resolveMemoryFile(DIR8, { type: 'project', name: 'user_用户身份' }),
      'project_用户身份.md')
    // 多层前缀循环剥到干净为止：库里已有 `feedback_feedback_xxx` 存量，
    // 只剥一层的话脏名再存一次仍是双前缀，永远清不干净。
    check('多层前缀循环剥净',
      resolveMemoryFile(DIR8, { type: 'feedback', name: 'feedback_feedback_feedback_xxx' }),
      'feedback_xxx.md')
    // 中间带 _md 的正常标题不受影响。
    check('中间 _md 不误伤',
      resolveMemoryFile(DIR8, { type: 'project', name: 'dsh_memory_md 两段式注入' }),
      'project_dsh_memory_md_两段式注入.md')
    // 净化后不能把标题弄空。
    check('净化后为空时保留原名',
      resolveMemoryFile(DIR8, { type: 'feedback', name: 'feedback_' }),
      'feedback_feedback.md')
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
