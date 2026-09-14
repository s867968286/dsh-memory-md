/**
 * 插件设置：`<dshHome>/memory-md/settings.json`。
 *
 * 缺失或损坏时全部回落默认值 —— 与 `dsh-preset-md` 同一套约定。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHomeDir } from './context.mjs'
import { joinPath } from './codebuddy-port.mjs'

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  /** 是否注入记忆（协议段 + 索引快照）。关掉后两者都不出现。 */
  enabled: true,
  /** 是否开启工作留痕（只写不读）。 */
  journal: false,
  /**
   * 触发后台总结的**轮数**门槛：累积够这么多轮就往后台跑一次总结。
   *
   * 与 `minReviewChars` 是**或**关系 —— 任一达标即触发。
   * 轮数管"有没有实质往来"，字符数管"单条很长也算实质内容"。
   */
  minReviewTurns: 2,
  /**
   * 触发后台总结的**字符数**门槛：这一段新增内容够长就跑一次总结。
   *
   * 实测 2000 字符约等于一两屏正常对话。
   */
  minReviewChars: 2000,
  /**
   * 在这些 agent preset 下**整体停用**本插件。
   *
   * 用途：某个预设自带独立记忆（比如跟着预设走的人格记忆），全局记忆就该让位，
   * 否则两套记忆同时生效、互相干扰。默认空 —— 官方预设不受影响。
   *
   * 元素是 preset id，可用 `*` 作后缀通配，例如 `presetmd-*`。
   */
  disabledPresets: [],
}

const BOOLEAN_KEYS = ['enabled', 'journal']
const ARRAY_KEYS = ['disabledPresets']
/**
 * 正整数键：非正数一律回落默认，**不夹到下限**。
 *
 * 为什么不是 `Math.max(1, v)`：`minReviewTurns: 0` 夹成 1 会静默改变语义
 * （用户以为关掉了门槛，实际还在按 1 轮触发）。回落默认值至少是"看得见的差异"。
 */
const POSITIVE_INT_KEYS = ['minReviewTurns', 'minReviewChars']

/** 归一化单个设置值：类型不符一律回落默认值。 */
export function normalizeSetting(key, value) {
  const fallback = DEFAULT_SETTINGS[key]
  if (value === undefined || value === null || value === '') return fallback
  if (BOOLEAN_KEYS.includes(key)) return typeof value === 'boolean' ? value : fallback
  if (ARRAY_KEYS.includes(key)) {
    if (!Array.isArray(value)) return fallback
    // 只保留非空字符串，去重并排序 —— 内容稳定，便于人工核对。
    const cleaned = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].sort()
    return cleaned
  }
  if (POSITIVE_INT_KEYS.includes(key)) {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  return value
}

/**
 * 该 preset 是否在停用名单里。
 *
 * 支持 `*` 后缀通配，这样新增伙伴预设（`presetmd-xxxx`）不必逐个补。
 * 没有 preset id（未挂在任何预设下）时永远不匹配 —— 默认全局生效。
 */
export function isPresetDisabled(settings, presetId) {
  if (typeof presetId !== 'string' || !presetId) return false
  const list = settings?.disabledPresets
  if (!Array.isArray(list) || list.length === 0) return false
  return list.some((pattern) => {
    if (typeof pattern !== 'string') return false
    if (pattern === presetId) return true
    if (pattern.endsWith('*')) return presetId.startsWith(pattern.slice(0, -1))
    return false
  })
}

/**
 * 解析 dshHome 与设置文件路径。
 *
 * `memoryRoot`（`<dshHome>/memory-md/`）里放三类东西：
 *   - `settings.json` —— 设置
 *   - `error.log` —— 错误日志（与设置同一层，人工排查看这一层就够）
 *   - `global/`、`<slug>/` —— 各作用域目录（内含索引 + `memory/` + `.journal/`）
 */
export function resolvePaths(home) {
  const dshHome = dshHomeDir(home) ?? joinPath(process.cwd(), '.dsh')
  const memoryRoot = join(dshHome, 'memory-md')
  return {
    dshHome,
    memoryRoot,
    settingsFile: join(memoryRoot, 'settings.json'),
    errorLogFile: join(memoryRoot, 'error.log'),
  }
}

/** 读设置。 */
export function readSettings(paths) {
  try {
    const parsed = JSON.parse(readFileSync(paths.settingsFile, 'utf8') || '{}')
    const input = parsed && typeof parsed === 'object' ? parsed : {}
    const next = {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) next[key] = normalizeSetting(key, input[key])
    return next
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（部分更新；原子替换）。 */
export function writeSettings(paths, patch) {
  const next = { ...readSettings(paths) }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && patch[key] !== undefined) next[key] = normalizeSetting(key, patch[key])
  }
  mkdirSync(dirname(paths.settingsFile), { recursive: true })
  const tmp = `${paths.settingsFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, paths.settingsFile)
  return next
}
