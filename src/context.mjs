/**
 * context.mjs — 作用域与路径解析。
 *
 * 记忆根目录固定为 `<dshHome>/memory-md`，**不可配置**：
 * 早先做成可配置时，默认值按会话 cwd 解析，结果记忆被写进了工作区。
 * 固定路径从根上消除这类失败。
 */
import { getCompressedWorkDir, joinPath } from './codebuddy-port.mjs'

/** 记忆根目录名。 */
export const MEMORY_ROOT_NAME = 'memory-md'

/**
 * DSH 用户目录。
 *
 * `settings.yaml`、`sessions/`、`skills/` 都在这里 —— 永远不是某个工作区。
 * 与 `dsh-preset-md` 的 `resolvePaths()` 同一套约定。
 */
export function dshHomeDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) return env.DSH_HOME.trim()
  const home = env.USERPROFILE || env.HOME
  if (!home) return undefined
  return joinPath(home, '.dsh')
}

/**
 * 固定的记忆根目录：`<dshHome>/memory-md`。
 *
 * 刻意不提供用户可改的覆盖项：可配置的根目录会招致正是它要替代的那类失败 ——
 * 默认值悄悄落在当时打开的那个工作区里。位置固定，所以处处一致、便于 grep。
 */
export function memoryRoot(explicitDshHome) {
  const home = dshHomeDir(explicitDshHome)
  if (home === undefined) {
    throw new Error('dsh-memory-md: cannot locate the DSH home directory (set DSH_HOME)')
  }
  return joinPath(home, MEMORY_ROOT_NAME)
}

/**
 * 解析本次会话需要的全部路径。
 *
 * 返回普通对象：路径字符串可以长期持有，不像 fs target 那样只能在创建处使用。
 */
export function resolveScopes({ cwd, dshHome }) {
  const absoluteRoot = memoryRoot(dshHome)
  const globalDir = joinPath(absoluteRoot, 'global')
  const projectDir = joinPath(absoluteRoot, getCompressedWorkDir(cwd))

  return {
    root: absoluteRoot,
    cwd,
    slug: getCompressedWorkDir(cwd),
    global: {
      dir: globalDir,
      index: joinPath(globalDir, 'MEMORY.md'),
      journalDir: joinPath(globalDir, '.journal'),
    },
    project: {
      dir: projectDir,
      index: joinPath(projectDir, 'MEMORY.md'),
      journalDir: joinPath(projectDir, '.journal'),
    },
  }
}

/** `YYYY-MM-DD`（本地时间）—— 留痕文件名。 */
export function journalFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
