/**
 * salvage.test.mjs — 截断输出的抢救与括号配平解析。
 *
 * 背景（真事故，2026-09-14）：preset-md 作用域的会话有 7 轮，日志却停在
 * 00:40。查 error.log 得到：
 *   轮 6→7 总结输出无法解析（JSON 不完整或格式错误）
 * 根因是那一轮 37 次工具调用、4435 字符助手发言，总结输出撞上
 * MAX_OUTPUT_TOKENS=4000 被硬截断 → JSON 缺尾 → 整段（notes + memories）丢弃。
 *
 * 三层防线在这里逐条锁住：
 *   1. 括号配平取第一个完整对象（不被尾随解释里的花括号带偏）
 *   2. 截断时抢救已完整的数组元素
 *   3. 配平扫描必须正确处理**字符串内的括号与转义**（这是它比
 *      `lastIndexOf('}')` 或字符串匹配可靠的根本原因）
 */
import { firstBalancedObject, parseSummary, salvageTruncatedSummary } from '../src/summarize.mjs'

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

console.log('\n第一层：括号配平取第一个完整对象')
{
  check('正常对象', firstBalancedObject('{"a":1}'), '{"a":1}')
  // 这是 lastIndexOf('}') 会切错、而配平扫描能救回的典型场景
  check('尾随解释含花括号',
    firstBalancedObject('{"notes":["A"],"memories":[]} 说明：见 {} 这里'),
    '{"notes":["A"],"memories":[]}')
  check('前面有杂文字', firstBalancedObject('好的：\n{"a":1}\n完毕'), '{"a":1}')
  check('嵌套对象', firstBalancedObject('{"a":{"b":{"c":1}}}'), '{"a":{"b":{"c":1}}}')
  check('截断 → 空串', firstBalancedObject('{"notes":["A"],"mem'),
    '')
}

console.log('\n配平扫描处理字符串内的括号与转义（关键）')
{
  // 字符串里出现「看起来像结构」的字符 —— 字符串匹配 / 正则都会切错
  check('字符串内的右花括号', firstBalancedObject('{"a":"}"}'), '{"a":"}"}')
  check('字符串内的左花括号', firstBalancedObject('{"a":"{"}'), '{"a":"{"}')
  check('字符串内的方括号', firstBalancedObject('{"a":"[0]"}'), '{"a":"[0]"}')
  check('字符串内的转义引号', firstBalancedObject('{"a":"say \\"hi\\""}'), '{"a":"say \\"hi\\""}')
  check('字符串内的转义反斜杠', firstBalancedObject('{"a":"C:\\\\path"}'), '{"a":"C:\\\\path"}')

  // 实战形状：note 内容里含数组语法（正如本次会话的日志内容）
  const tricky = '{"notes":["SQL 是 SELECT a[0] FROM t","别写成 ] 提前收尾"],"memories":[]}'
  check('note 含数组语法也能完整取出', firstBalancedObject(tricky), tricky)
}

console.log('\n第二层：截断时抢救完整的 notes')
{
  // 真实形状：notes 写完、memories 断在半路
  const cut = '{"notes":["做了 A，结论是 B","修了 C，根因是 D"],"memories":[{"type":"project","name":"X"'
  const s = salvageTruncatedSummary(cut)
  check('抢救出 2 条 notes', s.notes, ['做了 A，结论是 B', '修了 C，根因是 D'])
  check('记忆只抢救到完整的（这里 0 条）', s.memories.length, 0)
  check('标记为截断', s.truncated, true)
}
{
  // memories 里已完整的那几条也该留住
  const cut = '{"notes":["A"],"memories":[{"type":"project","name":"P1"},{"type":"user","name":"U1"},{"type":"proj'
  const s = salvageTruncatedSummary(cut)
  check('notes 保住', s.notes, ['A'])
  check('两条完整的 memories 保住', s.memories.map((m) => m.name), ['P1', 'U1'])
}
{
  // 抢救也必须正确处理字符串内容里的括号
  const cut = '{"notes":["把 a[0] 改成 b] 了","第二条"],"memories":[{"t'
  const s = salvageTruncatedSummary(cut)
  check('含数组语法的 note 不被切错', s.notes, ['把 a[0] 改成 b] 了', '第二条'])
}

console.log('\nparseSummary 三层合起来的行为')
{
  // 完整输出 → 走第一层
  const ok = parseSummary('{"notes":["A"],"memories":[{"type":"project","name":"P"}]}')
  check('完整输出解析成功', ok, { notes: ['A'], memories: [{ type: 'project', name: 'P' }] })
  check('未标记 salvaged', ok.salvaged, undefined)

  // 截断输出 → 走第二层，且标记 salvaged
  const cut = parseSummary('{"notes":["A","B"],"memories":[{"type":"project","name":"P"')
  check('截断时抢救 notes', cut?.notes, ['A', 'B'])
  check('标记 salvaged', cut?.salvaged, true)

  // 完全垃圾 → 第三层
  check('完全无法解析 → undefined', parseSummary('这里根本不是 JSON'), undefined)
  check('空串 → undefined', parseSummary(''), undefined)
}

console.log('\n不回归：围栏与常见畸形')
{
  const fenced = parseSummary('```json\n{"notes":["A"],"memories":[]}\n```')
  check('剥掉 markdown 围栏', fenced?.notes, ['A'])

  const withText = parseSummary('好的，结果如下：\n{"notes":["A"],"memories":[]}\n以上。')
  check('前后有解释文字也能解析', withText?.notes, ['A'])

  // notes 里混进 null / 空串 / 非字符串 → 过滤掉
  const messy = parseSummary('{"notes":["A",null,"","  ","B"],"memories":[]}')
  check('过滤 notes 里的空值', messy?.notes, ['A', 'B'])

  // memories 里混进非对象 → 过滤掉
  const badMem = parseSummary('{"notes":[],"memories":[{"name":"P"},null,"x",42]}')
  check('过滤 memories 里的非对象', badMem?.memories, [{ name: 'P' }])
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
