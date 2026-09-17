/**
 * dsh-memory-md 的 Client 半：在官方设置页里注册一个「记忆设置」页面。
 *
 * 观感上与同机运行的 dsh-preset-md 保持一致——它先占用了 `settings.section`
 * 的同一套写法与样式令牌，两个页面并排显示时不该长得像两个产品。
 * 但实现上完全独立，不共享任何东西：
 * - 各自插入自己的 <style>，选择器前缀不同（.mmd- vs .pmd-），互不覆盖；
 * - 注册的 slot id 不同（memory-md vs preset-md），是并列两页而非互相替换；
 * - 不共享模块、全局变量或样式表。
 *
 * - 只用一个官方 slot：`settings.section`（一个注册 = 一个设置页，导航行由官方渲染）；
 * - 不引任何 UI 组件库：React.createElement + 原生 input/button；
 * - 数据全部走 Host 半的 `/memory-md/api/*`（同源 fetch）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-md',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/memory-md/api'
    const SECTION_ID = 'memory-md'

    const CSS = [
      '.mmd-root{font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f);display:flex;flex-direction:column;gap:12px}',
      '.mmd-hint{color:var(--dsw-alias-label-tertiary,#6b6b6b);font-size:12px;line-height:1.6}',
      '.mmd-err{color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:1.6}',
      '.mmd-ok{color:var(--dsw-alias-state-success-primary,#2f9e44);font-size:12px;line-height:1.6}',
      '.mmd-sep{height:1px;background:var(--dsw-alias-border-l2,#eee);margin:2px 0}',
      // 参数行：与 preset-md 的 .pmd-set-row 完全一致
      '.mmd-set-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;min-width:0;min-height:52px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}',
      '.mmd-set-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.mmd-set-label b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f);line-height:21px}',
      '.mmd-set-label span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);line-height:17px}',
      '.mmd-perm{display:flex;flex-direction:column}',
      // 黑色开关（preset-md 同款）
      '.mmd-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3,#b8b8b8);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative;transition:background-color .14s}',
      '.mmd-switch-on{background:var(--dsw-alias-button-primary-fill,#1f1f1f)}',
      '.mmd-switch:disabled{cursor:default;opacity:.5}',
      '.mmd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:2px}',
      '.mmd-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}',
      '.mmd-switch-on .mmd-thumb{transform:translate(16px)}',
      // 路径卡片（只有标题与路径行）
      '.mmd-card{border:.5px solid var(--dsw-alias-border-l4,#e0e0e0);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:transparent}',
      '.mmd-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.mmd-card-title{font-size:13px;font-weight:600;line-height:1.4}',
      '.mmd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);word-break:break-all;line-height:1.6}',
      '.mmd-textarea{width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;resize:vertical}',
      '.mmd-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.mmd-textarea::placeholder{color:var(--dsw-alias-label-dimmed,#9a9a9a)}',
      // 数字参数区：与 preset-md 的 .pmd-fields 同款 —— 两列网格、标签在上、输入在下。
      // 不用「开关行 + 右对齐窄框」：那一列的宽度会被说明文字挤动，视觉上不稳。
      '.mmd-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:2px 0 14px;max-width:420px}',
      '.mmd-fields label{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px;line-height:16px;font-weight:500}',
      '.mmd-fields input{width:100%;box-sizing:border-box;height:34px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);border-radius:9px;padding:0 10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px}',
      '.mmd-fields input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.mmd-fields input:disabled{opacity:.45;cursor:default}',
      '.mmd-fields input::placeholder{color:var(--dsw-alias-label-dimmed,#b0b0b0)}',
      '.mmd-fields em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);line-height:16px}',
      // 底部动作行：保存按钮 + 状态文字。
      '.mmd-row{display:flex;align-items:center;gap:12px;padding-top:2px}',
      '.mmd-btn{appearance:none;height:32px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);padding:0 16px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px;cursor:pointer}',
      '.mmd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}',
      '.mmd-btn:disabled{cursor:default;opacity:.5}',
      '.mmd-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#1f1f1f);color:var(--dsw-alias-button-primary-foreground,#fff)}',
      '.mmd-btn-primary:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-button-primary-fill,#1f1f1f)}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-memory-md-css]')) return
      const style = document.createElement('style')
      style.setAttribute('data-memory-md-css', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function call(path, options) {
      const response = await fetch(`${API}${path}`, options)
      const text = await response.text()
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      if (!payload) throw new Error('服务端返回了空响应')
      return payload
    }

    const json = (method, body) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    /* ────────────────────────── 主页面 ────────────────────────── */

    function MemorySettings() {
      const [state, setState] = React.useState(null)
      const [message, setMessage] = React.useState('')
      /**
       * 编辑中的表单值（全部字段）。`undefined` = 还没编辑过，显示服务端的值。
       *
       * 改完**不立即生效** —— 与 preset-md 一致：攒在草稿里，点「保存」才提交。
       * 这样用户调多个参数只打一次接口，也不会出现"改到一半已经生效"的中间态。
       */
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      const load = React.useCallback(() => {
        call('/state').then(setState).catch((error) => setMessage(String(error.message)))
      }, [])

      React.useEffect(() => { load() }, [load])

      if (!state) return h('div', { className: 'mmd-root' }, h('div', { className: 'mmd-hint' }, message || '加载中…'))

      const saved = state.settings
      /** 当前显示值：草稿优先，没有草稿就用服务端的值。 */
      const form = draft ?? {
        enabled: saved.enabled,
        journal: saved.journal,
        freezeIndex: saved.freezeIndex,
        minReviewTurns: String(saved.minReviewTurns ?? ''),
        minReviewChars: String(saved.minReviewChars ?? ''),
        disabledPresets: (saved.disabledPresets ?? []).join('\n'),
      }
      const patch = (part) => setDraft({ ...form, ...part })

      /** 表单里有没有未保存的改动。 */
      const dirty =
        form.enabled !== saved.enabled ||
        form.journal !== saved.journal ||
        form.freezeIndex !== saved.freezeIndex ||
        form.minReviewTurns !== String(saved.minReviewTurns ?? '') ||
        form.minReviewChars !== String(saved.minReviewChars ?? '') ||
        form.disabledPresets !== (saved.disabledPresets ?? []).join('\n')

      /** 把草稿提交给服务端。归一化只在服务端做，这里不重复实现。 */
      const commit = async () => {
        setSaving(true)
        setMessage('')
        try {
          const data = await call('/settings', json('PUT', {
            enabled: form.enabled,
            journal: form.journal,
            freezeIndex: form.freezeIndex,
            // ⚠️ 清空时提交 **null**，不能提交 undefined ——
            // `JSON.stringify({k: undefined})` 会把键整个丢掉，服务端收到的是空对象，
            // 于是「清空即用默认」根本不会发生（用户以为重置了，实际没变）。
            // `normalizeSetting` 把 null 当"回落默认"处理。
            minReviewTurns: form.minReviewTurns.trim() === '' ? null : Number(form.minReviewTurns),
            minReviewChars: form.minReviewChars.trim() === '' ? null : Number(form.minReviewChars),
            disabledPresets: form.disabledPresets.split('\n').map((s) => s.trim()).filter(Boolean),
          }))
          setState((prev) => ({ ...prev, settings: data.settings }))
          setDraft(null)
          setMessage('已保存，立即生效。')
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
          load()
        } finally {
          setSaving(false)
        }
      }

      const toggle = (key) => h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(form[key]),
        'aria-label': key,
        className: 'mmd-switch' + (form[key] ? ' mmd-switch-on' : ''),
        onClick: () => patch({ [key]: !form[key] }),
      }, h('span', { className: 'mmd-thumb' }))

      const setRow = (key, title, desc) => h('div', { className: 'mmd-set-row', key },
        h('span', { className: 'mmd-set-label' },
          h('b', null, title),
          desc ? h('span', null, desc) : null),
        toggle(key))

      /**
       * 数字参数：标签在上、输入在下、默认值写进 placeholder。
       *
       * 「输入框是空的」= 正在用默认值，一眼能看出来。空串提交后由服务端回落默认。
       */
      /**
       * 数字参数：标签在上、输入在下。
       *
       * 刻意**不显示默认值**（既不在标签里写「默认 N」，也不放 placeholder）——
       * 参数清空即代表「用默认值」，由服务端归一化兜底。界面上不出现具体数字，
       * 默认值将来要调整也不必改文案。
       */
      const num = (key, label, unit) => h('label', { key },
        unit ? `${label}（${unit}）` : label,
        h('input', {
          type: 'number',
          min: '1',
          value: form[key],
          onChange: (event) => patch({ [key]: event.target.value }),
        }))

      /**
       * 预设停用名单：一行一个 id，支持 `*` 后缀通配。
       *
       * 用 textarea 而不是逐项增删 —— 这里通常只有一两项，且用户多半是
       * 从别处复制 id 过来粘贴。改完和别的字段一起保存。
       */
      const presetRow = () => {
        return h('div', { className: 'mmd-set-row' },
          h('span', { className: 'mmd-set-label' },
            h('b', null, '在这些预设下停用'),
            h('span', null,
              '一行一个预设 id，支持 * 通配（如 presetmd-*）。' +
              '这些预设里的对话不会读写全局记忆 —— 适合自带独立记忆的预设。'),
            h('textarea', {
              className: 'mmd-textarea',
              value: form.disabledPresets,
              spellCheck: false,
              rows: 3,
              placeholder: 'presetmd-*',
              onChange: (event) => patch({ disabledPresets: event.target.value }),
            }),
          ),
        )
      }

      return h('div', { className: 'mmd-root' },
        // 「改完立即生效」不再成立：现在是攒草稿、点保存才提交（与 preset-md 一致）。
        h('div', { className: 'mmd-hint' },
          '助手会把值得长期保留的内容写进记忆文件，每轮对话自动带上索引。' +
          '你不必手动维护，随时可以打开下面给出的目录查看。改动点「保存」后生效。'),

        h('div', { className: 'mmd-perm' },
          setRow('enabled', '启用记忆',
            '开：每轮对话自动带上记忆索引。关：完全不注入，已有的记忆文件原样保留。'),
          setRow('journal', '工作留痕',
            '开：每轮结束后台总结把做过的事追加记到当前工作区当天的日志里，供你事后翻看。' +
            '关：不写日志。日志只写不读，永远不会被当成记忆加载。'),
          setRow('freezeIndex', '冻结记忆索引',
            '开：同一对话只注入一次索引，之后不再重复注入（记忆文件变了也不追加），省上下文。' +
            '想刷新记忆时把开关关一下再打开。关：索引一变就注入最新的一份。'),
          // 双阈值：任一达标即触发一次后台总结（两者是「或」关系）。
          h('div', { className: 'mmd-fields' },
            num('minReviewTurns', '触发轮数', '轮'),
            num('minReviewChars', '触发字符数', '字符')),
          presetRow(),
        ),

        // 动作行：保存按钮 + 状态。有未保存改动时才可点，避免无谓的接口调用。
        h('div', { className: 'mmd-row' },
          h('button', {
            type: 'button',
            className: 'mmd-btn mmd-btn-primary',
            disabled: saving || !dirty,
            onClick: () => { void commit() },
          }, saving ? '保存中…' : '保存'),
          dirty && !saving
            ? h('span', { className: 'mmd-hint' }, '有未保存的改动')
            : null,
          message ? h('span', { className: dirty ? 'mmd-hint' : 'mmd-ok' }, message) : null,
        ),

        h('div', { className: 'mmd-sep' }),

        // 只留路径。
        //
        // 刻意**不显示任何记忆卡片与计数**：设置页是全局页面，拿不到「当前会话」，
        // 项目级目录只能从 `sessions.list()` 猜 —— 而官方文档明确它是**创建顺序**，
        // 切换会话后必然显示上一个会话的路径。猜错的路径比不显示更糟。
        // 这里三条路径都与会话无关，永远是对的。
        h('div', { className: 'mmd-card' },
          h('div', { className: 'mmd-card-head' }, h('span', { className: 'mmd-card-title' }, '存放位置')),
          h('div', { className: 'mmd-mono' }, `记忆目录  ${state.root}`),
          h('div', { className: 'mmd-mono' }, `用户级目录  ${state.globalDir}`),
          h('div', { className: 'mmd-mono' }, `设置文件  ${state.settingsFile}`),
          h('div', { className: 'mmd-mono' }, `错误日志  ${state.errorLogFile ?? '—'}`),
        ),
      )
    }

    function apply(ctx) {
      ensureStyles()
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: SECTION_ID, order: 22, label: '记忆设置' },
        MemorySettings,
      ))
    }

    return { apply, inject: ['slots'], name: 'memory-md-client' }
  },
})
