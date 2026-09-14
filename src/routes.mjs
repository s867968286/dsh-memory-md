/**
 * dsh-memory-md 的 HTTP 接口（`/memory-md/api/*`，同源 fetch）。
 *
 * 只读/写自己的记忆目录与设置文件，不碰别处。
 *
 * 接口刻意**只提供与会话无关的数据**：设置页是全局页面，拿不到「当前会话」，
 * 项目级路径只能靠 `sessions.list()` 猜，而官方文档明确它是**创建顺序** ——
 * 切换会话后必然显示上一个会话的路径。猜错的路径比不显示更糟，所以这里一个
 * 会话相关字段都不给（详见 `registerRoutes` 的说明）。
 */
import { join } from 'node:path'

import {
  memoryRoot,
} from './context.mjs'
import { readSettings, resolvePaths, writeSettings } from './settings.mjs'

export const ROUTE_PREFIX = '/memory-md'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const statusOfError = (message) => {
  if (/请求体|非法/.test(message)) return 400
  return 500
}

/** 注册 `/memory-md` 前缀路由。
 *
 * **刻意不返回任何与会话有关的信息**（项目级目录、当前工作区、留痕目录）。
 *
 * 设置页是全局页面，拿不到「当前会话」这个上下文；Host 半只能退回
 * `sessions.list()` 去猜，而官方文档明确它是**创建顺序**
 * （`dsh-session/lib/types/index.d.ts` 的 `list()`）—— 于是永远返回最老的那个
 * 会话，切换会话后界面仍显示上一个的路径。猜错的路径比不显示更糟，所以这里
 * 只给与会话无关的三条：记忆根目录、用户级目录、设置文件。
 */
export function registerRoutes(ctx, config = {}) {
  const paths = resolvePaths(config.dshHome)

  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = statusOfError(message)
      if (status >= 500) ctx.logger?.warn?.(`[memory-md] 请求处理失败：${message}`)
      sendJson(res, status, { error: message })
    }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'

      if (rest === '/api/state' && method === 'GET') {
        const root = memoryRoot(paths.dshHome)
        return sendJson(res, 200, {
          settings: readSettings(paths),
          root,
          globalDir: join(root, 'global'),
          settingsFile: paths.settingsFile,
          // 错误日志与 settings.json 同级 —— 排查后台总结失败时看它。
          errorLogFile: join(root, 'error.log'),
        })
      }

      if (rest === '/api/settings' && method === 'GET') {
        return sendJson(res, 200, { settings: readSettings(paths) })
      }

      if (rest === '/api/settings' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        const settings = writeSettings(paths, body)
        // 让 Host 半丢弃已缓存的注入文本。
        ctx.emit?.('memory-md/settings-changed')
        return sendJson(res, 200, { settings })
      }

      // `/api/memory` 与 `/api/journal/<date>` 已移除：界面不再展示文件内容，
      // 没有调用方。要看正文直接打开卡片上给出的目录即可。
      // 留着只会变成两条没人验证的死接口 —— 早先 `/api/memory` 的 ASCII-only
      // 文件名校验就是这么漏掉的（插件自己起的中文名一律被判「不合法」）。

      return sendJson(res, 404, { error: 'not found' })
    }),
  })
}
