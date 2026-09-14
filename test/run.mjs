/**
 * run.mjs — 依次跑完所有测试文件，给出单一结论。
 *
 * `differential` 放最前，因为它是最强的保证：把移植过来的截断逻辑与真实
 * CodeBuddy 2.150.0 bundle 逐字节比对，上游行为漂移会直接变成测试失败。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SUITES = [
  ['differential', 'differential.test.mjs'],
  ['load', 'load.test.mjs'],
  ['paths', 'paths.test.mjs'],
  ['routes', 'routes.test.mjs'],
  ['schema', 'schema.test.mjs'],
  ['client', 'client.test.mjs'],
  ['empty-state', 'empty-state.test.mjs'],
  ['inject', 'inject.test.mjs'],
  ['layout', 'layout.test.mjs'],
  ['render', 'render.test.mjs'],
  ['salvage', 'salvage.test.mjs'],
  ['summarize', 'summarize.test.mjs'],
  ['preset-exclude', 'preset-exclude.test.mjs'],
  ['regression-kind', 'regression-kind.test.mjs'],
  ['tools', 'tools.test.mjs'],
]

let failed = 0
for (const [label, file] of SUITES) {
  console.log(`\n${'='.repeat(60)}\n${label}  (${file})\n${'='.repeat(60)}`)
  const result = spawnSync(process.execPath, [join(here, file)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  })
  if (result.status !== 0) failed++
}

console.log(`\n${'='.repeat(60)}`)
if (failed === 0) {
  console.log(`ALL ${SUITES.length} SUITES PASS`)
} else {
  console.log(`${failed} of ${SUITES.length} SUITES FAILED`)
}
console.log('='.repeat(60))
process.exit(failed === 0 ? 0 : 1)
