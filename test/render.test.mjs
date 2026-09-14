/**
 * render.test.mjs — 真正渲染一次设置页组件。
 *
 * 为什么需要：`client.test.mjs` 是**源码文本检查**（注册契约、类名前缀、依赖白名单），
 * 它不执行组件 —— 所以 render 里抛错它测不出来。
 *
 * 而这个项目已经在这上面栽过：两个设置页都变成「裸 HTML」，根因是 client 顶层
 * require 了已消失的包，factory 一抛错 `apply` 就从不执行、样式永不注入。
 * 光是"源码里写了样式"不等于"渲染路径能跑通"。
 *
 * 这里用一个极简 React 桩真跑一遍 factory，并断言：
 *   1. 渲染不抛错；
 *   2. 控件确实出来了（开关、数字输入、textarea、路径行）；
 *   3. 输入框显示的是**服务端当前值**，默认值只在 placeholder 里。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

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

/* ---------- 极简 React 桩：够用的 hook 语义 ---------- */

function makeReact() {
  let hooks = []
  let cursor = 0
  let dirty = false
  return {
    api: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
      useState(init) {
        const i = cursor++
        if (hooks[i] === undefined) hooks[i] = typeof init === 'function' ? init() : init
        return [hooks[i], (v) => {
          hooks[i] = typeof v === 'function' ? v(hooks[i]) : v
          dirty = true
        }]
      },
      useEffect(fn) {
        const i = cursor++
        if (hooks[i] === undefined) { hooks[i] = true; fn() }
      },
      useCallback(fn) { cursor++; return fn },
    },
    begin() { cursor = 0; dirty = false },
    get dirty() { return dirty },
  }
}

/** 把渲染树摊平成节点数组，便于断言。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  out.push(node)
  const kids = node.props?.children
  if (Array.isArray(kids)) for (const k of kids) flatten(k, out)
  else flatten(kids, out)
  return out
}

/** 取一个节点的文字内容（递归拼字符串子节点）。 */
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && node.props) return textOf(node.props.children)
  return ''
}

/* ---------- 加载并渲染 ---------- */

const STATE = {
  settings: {
    enabled: true,
    journal: true,
    minReviewTurns: 3,
    minReviewChars: 4000,
    disabledPresets: ['presetmd-*'],
  },
  root: 'C:/x/.dsh/memory-md',
  globalDir: 'C:/x/.dsh/memory-md/global',
  settingsFile: 'C:/x/.dsh/memory-md/settings.json',
  errorLogFile: 'C:/x/.dsh/memory-md/error.log',
}

const React = makeReact()
let exported = null
const win = {
  __ModuleLoader__: {
    load: (spec) => {
      exported = spec.factory((name) => {
        if (name === 'react') return React.api
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}
const doc = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild() {} },
}
const fetchImpl = async (url) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(url.includes('/state') ? STATE : { settings: STATE.settings }),
})

console.log('\nfactory 可执行')
try {
  new Function('window', 'document', 'fetch', 'module', 'exports', source)(
    win, doc, fetchImpl, {}, {},
  )
  check('产出了插件规格', typeof exported?.apply, 'function')
} catch (error) {
  failures++
  console.log(`  FAIL factory 抛错: ${error.message}`)
}

console.log('\napply 注册组件')
let Component = null
try {
  exported.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (_desc, comp) => { Component = comp; return () => {} },
    },
  })
  check('注册了组件', typeof Component, 'function')
} catch (error) {
  failures++
  console.log(`  FAIL apply 抛错: ${error.message}`)
}

/* ---------- 渲染循环：state 来自异步 fetch，所以要等它落地再重渲 ---------- */
let root = null
if (typeof Component === 'function') {
  console.log('\n渲染不抛错（含异步加载后的重渲）')
  try {
    for (let i = 0; i < 5; i++) {
      React.begin()
      root = Component()
      // 让 fetch 的 promise 落地，触发 setState
      await new Promise((r) => setTimeout(r, 0))
      if (!React.dirty) break
    }
    check('渲染完成', root !== null && root !== undefined, true)
  } catch (error) {
    failures++
    console.log(`  FAIL 渲染抛错: ${error.message}`)
  }
}

if (root) {
  const nodes = flatten(root)
  const inputs = nodes.filter((n) => n.type === 'input')
  const switches = nodes.filter((n) => n.props?.role === 'switch')
  const textareas = nodes.filter((n) => n.type === 'textarea')
  const allText = nodes.map(textOf).join('|')

  console.log('\n控件都渲染出来了')
  check('两个开关（启用记忆 / 工作留痕）', switches.length, 2)
  check('两个数字输入框（双阈值）', inputs.length, 2)
  check('预设名单 textarea 仍在', textareas.length, 1)

  console.log('\n保存按钮：攒草稿、点保存才提交（不即时生效）')
  {
    const buttons = nodes.filter((n) => n.type === 'button' && String(n.props?.className ?? '').includes('mmd-btn'))
    check('有一个保存按钮', buttons.length, 1)
    check('按钮文案含「保存」',
      buttons.some((b) => textOf(b.props.children).includes('保存')), true)
    // 刚加载完没有改动 → 按钮该是禁用的（避免无谓的接口调用）
    check('无改动时按钮禁用', buttons[0]?.props?.disabled, true)
  }

  console.log('\n输入框显示的是服务端当前值，不是默认值')
  {
    const values = inputs.map((n) => n.props?.value).sort()
    check('当前值 3 / 4000', values, ['3', '4000'])
  }

  console.log('\n界面上不显示默认值（清空即用默认，由服务端兜底）')
  {
    check('输入框没有 placeholder', inputs.every((n) => n.props?.placeholder === undefined), true)
    check('也没有「默认 N」提示文字', allText.includes('默认'), false)
  }

  console.log('\n路径区包含错误日志（与设置同级）')
  check('渲染出 error.log 路径', allText.includes('error.log'), true)
  check('渲染出记忆目录', allText.includes('C:/x/.dsh/memory-md'), true)

  console.log('\n开关状态跟随 settings')
  check('两个开关都是开（enabled/journal 为 true）',
    switches.every((n) => n.props['aria-checked'] === true), true)

  console.log('\n空 settings 也能渲染（不出现 undefined / NaN）')
  {
    // 用旧进程可能返回的最小 settings 再渲染一次 —— 缺字段不该渲染出字面量 "undefined"。
    const bare = { ...STATE, settings: { enabled: true, journal: false, disabledPresets: [] } }
    const saved = (globalThis.__mmdFetch = fetchImpl)
    void saved
    // 直接换 fetch 实现再跑一轮
    const fetchBare = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/state') ? bare : { settings: bare.settings }),
    })
    // 重新加载一份全新实例（hook 状态不共享）
    let Comp2 = null
    let exp2 = null
    const win2 = { __ModuleLoader__: { load: (spec) => { exp2 = spec.factory((n) => {
      if (n === 'react') return makeReact().api
      throw new Error(`unexpected require: ${n}`)
    }) } } }
    new Function('window', 'document', 'fetch', 'module', 'exports', source)(win2, doc, fetchBare, {}, {})
    exp2.apply({ slots: { inject: (_n, fn) => fn(), register: (_d, c) => { Comp2 = c; return () => {} } } })

    let r2 = null
    const R2 = makeReact()
    void R2
    try {
      r2 = Comp2()
      await new Promise((r) => setTimeout(r, 0))
      r2 = Comp2()
    } catch (error) {
      failures++
      console.log(`  FAIL 最小 settings 渲染抛错: ${error.message}`)
    }
    const t2 = r2 ? flatten(r2).map(textOf).join('|') : ''
    check('不出现字面量 undefined', t2.includes('undefined'), false)
    check('不出现 NaN', t2.includes('NaN'), false)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
