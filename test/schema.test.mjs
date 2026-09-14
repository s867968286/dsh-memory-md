/**
 * schema.test.mjs — 用 DSH **真实的**校验器验证工具 schema。
 *
 * 插件的工具 schema 是自己转的（`@deepseek-ai/dsh-tools` 不在 profile 的
 * 可解析范围内，用不了 `defineTool`），所以必须直接对 DSH 的
 * `assertSupportedJsonSchema` 与 `validateJsonSchemaValue` 验证形状，
 * 而不是靠约定。
 *
 * 这两个函数从 DSH 安装目录动态解析 —— 它们只在 DSH 运行时里存在。
 */
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = join(tmpdir(), `mmd-schema-${process.pid}`)
process.env.DSH_HOME = SANDBOX

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

/* ---------- 从 DSH 安装目录拿真实校验器 ---------- */
const dshRequire = createRequire(
  'D:/soft/node/node-v22.23.2/node_modules/@deepseek-ai/dsh/package.json',
)
const { assertSupportedJsonSchema, validateJsonSchemaValue } = dshRequire('@deepseek-ai/dsh-tools')

/* ---------- 注册工具并收集定义 ---------- */
const { registerMemoryTools } = await import('../src/tools.mjs')

const definitions = new Map()
registerMemoryTools({
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => {}
    },
  },
  config: { dshHome: SANDBOX, workspaceCwd: () => 'D:\\proj', hints: { dirs: '' } },
  logger: { info: () => {}, warn: () => {} },
})

try {
  rmSync(SANDBOX, { recursive: true, force: true })

  console.log('\nDSH 真实校验器接受所有 schema')
  for (const [name, definition] of definitions) {
    let paramsOk = true
    let outputOk = true
    try {
      assertSupportedJsonSchema(definition.parameters)
    } catch {
      paramsOk = false
    }
    try {
      assertSupportedJsonSchema(definition.output.schema)
    } catch {
      outputOk = false
    }
    check(`${name} 参数 schema 合法`, paramsOk, true)
    check(`${name} 输出 schema 合法`, outputOk, true)
  }

  console.log('\n可选字段确实可省略')
  {
    const save = definitions.get('memory_md_save')
    // file 是可选字段：不传应当通过校验。
    const okResult = validateJsonSchemaValue(
      save.parameters,
      { scope: 'global', type: 'user', name: 'a', description: 'b', content: 'c' },
      '',
    )
    // 通过时返回空违规数组。
    check('省略可选字段通过', okResult, [])

    // 缺必填字段应当报出违规。
    // validateJsonSchemaValue 是**返回**违规而不是抛异常。
    const badResult = validateJsonSchemaValue(save.parameters, { scope: 'global' }, '')
    check('缺必填字段报违规', Array.isArray(badResult) && badResult.length > 0, true)
  }

  console.log('\nenum 约束生效')
  {
    const save = definitions.get('memory_md_save')
    const badResult = validateJsonSchemaValue(
      save.parameters,
      { scope: 'global', type: 'nonsense', name: 'a', description: 'b', content: 'c' },
      '',
    )
    check('非法 type 报违规', Array.isArray(badResult) && badResult.length > 0, true)
  }

  console.log('\nrequired 只出现在真正必填的字段上')
  {
    // 收集违规项，用 check 统一记账 —— 早先是「console.log + 手搓 failures++」
    // 再加一条恒真的 `check(..., true, true)`，既绕过 check 的风格、也没真正锁住。
    const offenders = []
    for (const [name, definition] of definitions) {
      const props = definition.parameters.properties ?? {}
      for (const [field, node] of Object.entries(props)) {
        // 任何属性节点都不该带 required（那是对象根的键）。
        if (node.required !== undefined) offenders.push(`${name}.${field}`)
      }
    }
    check('属性节点无残留 required', offenders, [])
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
