# dsh-memory-md 方案定案清单

> 状态：**已实施**（原则与设计已确认并落地）
> **本文件记录定案与修订历史，不是需求真源** —— 需求真源是用户；**当前实现以源码为准**
> 更新：2026-09-14
> 参考实现：CodeBuddy Code（主）/ WorkBuddy（辅）
> 依据文档：`docs/memory-scheme-codebuddy.md`、`docs/memory-scheme-workbuddy.md`、`docs/memory-scheme-comparison.md`

### 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-13 | 初稿定案 |
| 2026-09-13 | **六、注入机制**：从 `systemPrompt.section()`（系统提示词段）改为 `systemPrompt.context()`（运行期上下文快照）。理由见该节。 |
| 2026-09-13 | **七、留痕机制**：轮末提醒（`agent/turn-stopping` 往主对话 inbox 塞消息）改为**后台异步独立 LLM 调用**做总结反思并落盘；提醒不再进入当前对话。 |

### 与当前实现的落差（截至 2026-09-13）

> **本节已于 2026-09-13 全部实施完毕。** 保留作修订档案：它记录了「定案要求 vs 当时实现」的差异，
> 是这次改动的起因。现在的实现以下文各节（六、七）为准。

| 定案要求 | 改动前的实现 | 现状 |
|---|---|---|
| `inject: ['systemPrompt']` | `inject = ['webServer']` | ✅ 已注册 `systemPrompt.context()` |
| 注入用户级 + 项目级 MEMORY.md 索引 | 未实现（索引在磁盘上但不进上下文） | ✅ `src/inject.mjs` |
| 轮末提醒走后台异步 LLM | `src/remind.mjs` 往主对话 `inbox.append('next-step')`，**会显示在对话里** | ✅ `src/summarize.mjs`（`remind.mjs` 已删除） |
| 留痕由后台总结自动写入 | `memory_md_journal` 需模型主动调用，与 `memory_md_save` **无联动**，`.journal/` 从未产生 | ✅ 后台总结一并写记忆与日志 |

> 注：`README.md` 与源码注释中「不注入系统提示词」的旧论述是**实现偏离设计后的事后说明**，
> 不是需求。需求以本文件为准；README 已按定案改写。

---

## 一、定位

**一个纯本地的 Markdown 记忆插件，聚焦「AI 自动写入」。**

- 不动官方 `AGENTS.md`（用户自己手写；要全局就写用户级 AGENTS.md，官方已支持）
- 不碰 skill 机制（可参考代码，但不混为一谈）
- 不做 RULE（glob 条件触发）
- 不做云端记忆
- **只装这一个记忆插件**

---

## 二、定案参数

| 项 | 定案值 |
|---|---|
| **插件名** | `dsh-memory-md` |
| **记忆根目录** | `.dsh/memory-md/` |
| **用户级路径** | `.dsh/memory-md/global/` |
| **项目级路径** | `.dsh/memory-md/{slug}/` |
| **索引文件** | `MEMORY.md`（每个作用域一个，在作用域**根**） |
| **记忆正文** | `<作用域>/memory/*.md`（**2026-09-13 起挪进子目录**） |
| **日志路径** | `<作用域>/.journal/YYYY-MM-DD.md` |
| **错误日志** | `.dsh/memory-md/error.log`（与 `settings.json` 同级） |
| **索引维护方** | **AI 维护** |
| **加载控制** | **行数 + 字符双上限**（200 行 / 4e4 字符），超限**硬截断并附警告** |
| **加载顺序** | 用户级 → 项目级（项目级优先级更高，参考 CodeBuddy） |
| **日志默认** | **关闭**（开关留痕） |
| **语义召回** | **不做**（2026-09-13 研究后否决，理由见下） |
| **会话 jsonl 检索** | **放弃** |
| **配置方式** | 自动生效 + UI 改配置；**不做命令** |

### slug 规则

沿用 CodeBuddy `getCompressedWorkDir()`：绝对路径盘符与分隔符转 `-`、全小写。

```
D:\workspaces\ai\dsh-memory-md  →  d-workspaces-ai-dsh-memory-md
```

---

## 三、目录结构

```
.dsh/memory-md/
├── settings.json                    # 设置
├── error.log                        # 错误日志（与设置同级）
├── global/                          # 用户级（跨所有项目）
│   ├── MEMORY.md                    # 索引（AI 维护，唯一入口）
│   ├── memory/                      # 记忆正文
│   │   ├── user_xxx.md              #   type: user
│   │   ├── feedback_yyy.md          #   type: feedback
│   │   └── reference_zzz.md         #   type: reference
│   └── .journal/                    # 留痕（开关控制，不参与记忆加载）
│       └── YYYY-MM-DD.md
│
└── {slug}/                          # 项目级（结构同上）
    ├── MEMORY.md
    ├── memory/
    │   ├── feedback_aaa.md
    │   ├── project_bbb.md
    │   └── reference_ccc.md
    └── .journal/
        └── YYYY-MM-DD.md
```

**要点：**
- 统一管理，**不放项目目录下**
- 路径固定 → 再按日期建文件（**不是** WorkBuddy 的"时间戳目录"式）
- `.journal/` 用隐藏目录明确标记"这不是记忆"，避免被索引扫描
- **索引在作用域根、正文在 `memory/` 子目录** —— 三者同级，作用域根一眼看清结构；
  索引链接相应带前缀（`memory/xxx.md`）。历史数据的平铺→子目录搬迁是
  **一次性运维动作**（`scripts/migrate-memory-layout.mjs`），不在插件运行时。

---

## 四、记忆分类（type）

沿用 CodeBuddy Typed Memory 的 4 类型：

| type | 用途 | 全局 | 项目级 |
|---|---|---|---|
| `user` | 用户角色、目标、偏好、知识背景 | ✅ | — |
| `feedback` | 用户对 AI 行为的纠正与指导 | ✅ | ✅ |
| `project` | 项目进行中的工作、目标、决策 | — | ✅ |
| `reference` | 外部系统与资源的指引 | ✅ | ✅ |

> `reference` 两级都保留：既可能是全局的（本机 Maven 路径），也可能是项目的（本项目 DB 地址）。

### 记忆文件格式

```markdown
---
name: 简洁名称
description: 一句话描述，用于相关性判断，要具体
type: feedback
---

记忆内容。feedback / project 类型建议结构：
- 规则或事实
- **Why:** 原因
- **How to apply:** 如何应用
```

---

## 五、索引机制

### 索引格式

```markdown
# MEMORY.md

- [标题](文件名.md) — 一句话描述
```

### 索引由 AI 维护

模型写分类文件时，同步在 `MEMORY.md` 加/改索引行。

### 加载控制：行数 + 字符双上限

- **限制行数**（防条目数量膨胀）：200 行
- **限制字符数**（防单行超长）：4e4 字符
- 依据：CodeBuddy 的 `em=200` / `y0=4e4` 双限制

> 修正记录：早期分析曾把 `truncateMemoryEntrypoint`（legacy 路径）误当作未使用，
> 于是写下「只保留行数限制」。实际 `truncateEntrypointContent`（typed 路径）
> **两个上限都用**，且差分测试与真实 bundle 逐字节比对（警告文案除外，已汉化）。

超限时**硬截断并附一段警告**，说明溢出量并提示模型整理索引 ——
被截掉的条目正文仍在 `memory/` 子目录里，用 `memory_md_search` 可搜到。

---

## 六、注入机制（两段式：提示词段 + 上下文快照）

### 机制：**不变协议走 `section()`，易变索引走 `context()`**

**这是 2026-09-13 的第二次修订**（第一次是「从 `section()` 全部改到 `context()`」）。
第一次修订的理由只对**读盘内容**成立，而当时的实现把**常量协议**也一起搬了过去。

按生命周期分成两段：

| | 协议（`MEMORY_PROTOCOL`） | 索引（`renderMemoryIndex()`） |
|---|---|---|
| 内容 | 索引是什么、条目什么特征、边界在哪 | 用户级 + 项目级 `MEMORY.md` |
| 通道 | `systemPrompt.section()`（系统提示词） | `systemPrompt.context()`（上下文快照） |
| 读盘 | **否**，纯常量 | 是，随记忆增删而变 |
| KV Cache | 逐字节恒定 → **前缀始终命中** | 追加在可复用前缀**之后**，不吃前缀 |
| 去重 | 无需（常量） | **loop 内建**：内容未变则不注入 |
| order | `950`（文件引用 900 之后、工具说明 1000+ 之前） | `10000`（官方三项 110/115/120 之后） |

**为什么必须拆：** 两段都塞进 `context()` 时，**协议文本会跟着每次记忆变化重发一遍**，
而旧快照仍留在历史里（快照是**追加**，不是替换），纯属浪费 token。拆开后系统提示词里
只有一份协议，快照里只有索引。

**关键实现：**

```js
ctx.inject(['systemPrompt'], (scope) => {
  // 协议：静态常量，进提示词
  scope.systemPrompt.section({
    name: 'memory-md:protocol',
    order: 950,
    text: () => MEMORY_PROTOCOL,
  })
  // 索引：每次装配重读，进快照；空串则不贡献
  scope.systemPrompt.context({
    name: 'memory-md:index',
    order: 10_000,
    text: () => renderMemoryIndex(...),
  })
})
```

**进入 section 的硬性前提（不可放宽）：** DSH 每个 step 都重新装配提示词
（`dsh-agent-loop` 的 `systemPrompt.assemble()`），所以**只有常量**才允许进 section。
任何读盘的 section 都会让提示词随文件变化，整个前缀的 KV Cache 随之失效 ——
这条正是第一次修订的原始理由，现在依然成立。

**行为：**
- 索引文件变化 → 下次装配即生效，**不重启**
- 索引文件未变 → loop 的 `RuntimeContextProjection` 比对后**不产生消息**，天然满足
  「变了才注入、没变不重复注入」，**不需要自己做跳过机制**
- 骨架 `inject` 仍为 `['webServer']`，另经 `ctx.inject(['systemPrompt'])` 延迟注册

> 依据：`@deepseek-ai/dsh-system-prompt` 的 `section()` / `context()` API 与
> `dsh-sandbox-policy` 的参考实现（注册 `sandbox:policy`）；
> 去重逻辑在 `@deepseek-ai/dsh-agent-loop` 的 `RuntimeContextProjection.project()`。

### 注入内容

```
协议段（系统提示词）：记忆是什么、索引怎么读、四种 type、边界
索引快照（上下文）：  1. 用户级 MEMORY.md 索引
                     2. 项目级 MEMORY.md 索引
```

**只注入索引，不注入分类文件全文。** 模型命中描述后自行 `read` 对应文件。

**索引用标签裹住，给模型确定性。** 每份索引包在 `<memory-index scope="global|project" cwd="…">`
里 —— 模型不必靠上下文猜这段文本的边界与作用域：

```xml
<memory-index scope="global">
- [用户偏好](user_x.md) — 用中文回复
</memory-index>
```

### 注入内容需包含（抄 CodeBuddy）

| # | 项 | 状态 |
|---|---|---|
| 1 | **索引说明** —— 这是记忆索引，按需读取原文 | ✅ 协议段（`MEMORY_PROTOCOL`） |
| 2 | **搜索指引** —— 明确告知用什么工具、搜哪个目录 | ✅ 协议段说明「索引行是指针，读原文」，工具名见工具描述 |
| 3 | **写入规则** —— 何时写、写哪种 type、负面清单 | ⚠️ 仍在 `memory_md_save` 工具描述里，**未进协议段** |
| 4 | **角色边界** —— 记忆是补充，不替代正常回答 | ✅ 协议段末两条（静默应用、不凌驾于当前请求） |

> 3 刻意留在工具描述：写入规则只在**要写入时**才需要，每回合都占提示词不划算。
> 1、2、4 是「读到记忆时怎么处理」，所以进协议段。

---

## 七、留痕机制（可选开关）

| | 默认（关） | 开启 |
|---|---|---|
| 记忆加载 | 只注入索引 | **同样只注入索引** |
| 额外行为 | — | 追加写 `.journal/YYYY-MM-DD.md` |
| 加载记忆时 | — | **不读日志** |

**设计要点：日志是单向的"只写不读"。**

- 日志 = 给人看 / 事后追溯的流水
- 记忆 = 给模型用的知识

> 对比 WorkBuddy：它让模型自己判断"先读日志还是读 MEMORY.md"，判断错就漏信息。本方案从结构上消除这个判断。
> 另外 WorkBuddy 的日志放在**时间戳目录**下（`D:\WorkBuddy\2026-09-09-09-30-23\.workbuddy\memory\2026-09-09.md`），本方案固定路径 + 日期文件名，一天一个。

### 7.1 触发方式：后台异步 LLM 总结（2026-09-13 定案）

**轮末（`agent/turn-stopping`）在后台异步发起一次独立的 LLM 调用**，由它做总结反思，
并写入记忆文件与日志文件。**主对话不参与、不显示任何内容。**

| | 旧实现（废弃） | 定案 |
|---|---|---|
| 机制 | 往主对话 `inbox.append('next-step')` 塞一条提醒消息 | 后台起独立 LLM 调用 |
| 对话影响 | 提醒**显示在对话里**，且逼主模型再跑一步 | **完全无影响** |
| 谁写记忆 | 主模型看到提醒后自己调 `memory_md_save` | 后台总结调用自行写入 |
| 谁写日志 | 指望模型再调 `memory_md_journal`（实际从不触发） | 后台总结调用一并写入 |

**废弃原因：**
1. 提醒以 user 消息形式出现在主对话中，**影响体验**；
2. 「提醒主模型去写」依赖模型自觉，`memory_md_save` 与 `memory_md_journal` 之间**没有联动**，
   实际结果是**记忆写了、日志从未写**（`.journal/` 目录至今为空即证据）。

> 机制参考：`ctx.agents.withInitiator(agent, ...)` 起的独立 agent（见 `@deepseek-ai/dsh-agent-loop`）。
> 触发时机：**一轮混合结束时**（`agent/turn-stopping`）。

#### 7.1.1 总结范围：游标式跨回合补偿（2026-09-13 修订）

**总结范围是「游标之后的所有事件」，不是「本轮」。**

每个会话维护一个游标 `doneTurn` = 最后一次**成功**总结到的回合。**游标只在成功后推进**，
失败（回合以 error 结束 / 内容不足 / LLM 调用失败）时原地不动，下一轮自然把这段一起带上。

| 触发场景 | 旧行为（只取本轮） | 现在的行为 |
|---|---|---|
| 回合以 error 结束 | ❌ 该轮工作**永久丢失** | ✅ 游标不动，下轮补上 |
| 回合太短（消息不足） | ❌ 永久丢失 | ✅ 下轮补上 |
| LLM 调用失败 | ❌ 永久丢失（游标已提前推进） | ✅ 下轮重试同一段 |
| 正常成功 | ✅ 写入 | ✅ 写入并推进游标 |

**为什么改（真实事故）：** 早先 `eventsThisTurn()` 只取最后一个 `turn/start` 起的事件，
且游标在调用**前**就推进。结果 20:13→20:33 之间 20 分钟的源码研究与实测，
**日志里一个字都没有** —— turn 26 以 error 结束、turn 27 太短，两者的工作就此出局，
后面的 turn 28 用切片也看不到它们。

**保护措施：** 连续失败到 `MAX_SUMMARY_ATTEMPTS`（3 次）就放弃这一段并推进游标 ——
否则一段永远总结不了的内容（如 provider 持续报错）会让游标**永久卡死**，
后面的内容再也总结不到，那比丢掉一段更糟。

**首次见到会话时，游标锚定在「上一轮」而不是 0。** 否则新进程启动后第一次总结会把
**整个会话历史**（真实场景：33 轮、3.3MB）当成"未总结内容"重跑一遍，重复写日志。
代价是：**进程重启前丢失的那段不会被自动补回**（跨回合补偿只覆盖本次进程内的空洞）。
这是刻意的取舍 —— 宁可丢一段，也不要每次重启都重刷全史。

**副作用：** 跨回合内容变多，`transcript` 可能触及 `maxChars: 12000` 被截断（保留尾部），
`MAX_OUTPUT_TOKENS` 也可能不够 —— 记住**截断 = JSON 不完整 = 整段丢弃**（见 7.3 节）。
`summarize` 套件有对应回归断言。

#### 7.1.2 超时兜底（2026-09-13 修复）

**`llm.stream()` 没有内置超时。** 官方 `GenerateOptions` 只提供 `signal`，
取消责任明确在调用方（`dsh-llm` 的 `LlmAdapter` 契约要求实现方 honor `options.signal`）。

**没有超时的后果比"丢一段"严重**：provider 挂起 → 后台调用永不返回 →
`running` 标志永不复位 → **游标从此卡死，后续所有回合都不再写日志**。
（失败计数只在**抛错**时累加，"挂起"不算失败。）

**修法**：每次后台调用配一个 `AbortController` + 定时器，超时 `abort()`，
按失败处理（保留游标、`attempts + 1`，下轮重试）。

- `SUMMARY_TIMEOUT_MS = 60_000` —— 输出上限 4000 token，正常几秒完成；
  60s 容纳慢网络，又远短于一个回合的典型时长
- `createTurnStoppingListener` 接受 `summaryTimeoutMs` 覆盖项，**仅为测试**（生产用默认值）
- `finally` 里必须 `clearTimeout`，否则定时器泄漏

> 同类先例：auto-memory 为同一原因包了 40s 外层 + 90s 内层 ± 两层超时。

#### 7.1.3 中和 `{{...}}`（2026-09-13 修复，防「炸整轮」）

**这是本项目已知的最高严重度缺陷。** 官方 `interpolate()` 会把注入文本里的 `{{...}}`
当作**提示词变量**严格校验，而它**对 `context()` 和 `section()` 都生效**
（`renderContextSections` 与 `renderPrompt` 都调它）。

逐字跑官方算法实测：

| 索引内容 | 结果 |
|---|---|
| `{foo}` 单个花括号 | ✅ 原样保留 |
| `{{` 无闭合 | ✅ 原样保留 |
| `{{挖空}}` / `{{.Server.Version}}` / `{{hl\|}}` | ❌ `malformed prompt variable reference` |
| `{{name}}`（合法变量名但未注册） | ❌ `unknown prompt variable` |

**抛错发生在 `systemPrompt.assemble()` 里 = 整个 step 失败 = 整个回合失败。**
更糟的是它会**永久锁死那个工作区** —— 每轮都炸，用户没法让 agent 自救
（agent 每轮都失败，改不了文件），**只能手工编辑 `MEMORY.md`**。

**修法**：注入边界做**相邻花括号转义** —— 每个紧邻下一个 `{` 的 `{` 后插 `\`
（`{{` → `{\{`，`{{{` → `{\{\{`）。语义不变、原文可还原，而 `interpolate()` 再也扫不到 `{{`。

- 必须处理**任意长度的连续花括号**：只把首个 `{{` 换掉的话，`{{{` 会残留出新的 `{{`
- 单个 `{` 不动（本来就不触发扫描）
- 协议段是常量且不含 `{{`，但 `inject` 套件有一条**防未来**断言，防止有人往里加占位符语法

> 同类事故：dsh-mneme 被 issue #40 追过（灰机 wiki 的 `{{hl|}}`、`{{黑幕}}` 等
> 合法模板语法导致整轮崩溃），它的修法也是在注入边界做花括号转义。

#### 7.1.4 目录结构与调度改进（2026-09-13，吸收 preset-md 的做法）

**目录结构：记忆正文挪进 `memory/` 子目录。**

```
<scope>/MEMORY.md          索引（唯一入口，注入用）
<scope>/memory/*.md        记忆正文 ← 新位置
<scope>/.journal/*.md      工作留痕（只写不读）
```

索引链接相应改成 `memory/xxx.md`。三个好处：作用域根干净、与 `.journal/` 对称、
未来加子目录（如 `error/`）不与正文平铺混在一起。

**迁移是一次性运维动作，不在插件里。**
新写入本来就会落在 `memory/`，只有历史数据需要搬 —— 那是跑一次脚本的事，
不该变成插件每次启动都执行的运行时代码。脚本见 `scripts/migrate-memory-layout.mjs`：
只搬带 `type:` frontmatter 的真记忆，目标已存在则跳过并报告（**绝不覆盖**），
只 `rename` 不改内容，并同步修正索引链接。

**调度改进（全部吸收自 preset-md）：**

| 机制 | 做法 | 为什么 |
|---|---|---|
| **双阈值触发** | 消息条数 ≥ `minReviewTurns` **或** 字符数 ≥ `minReviewChars`，**二者任一达标即触发** | 条数管"有没有实质往来"，字符数管"单条很长也算实质内容" |
| ↳ 可配置 | 两个阈值都是**设置项**（设置页「触发轮数 / 触发字符数」） | 门槛是"攒够多少再总结"，因人而异，不该写死在代码里 |
| ↳ 坏值处理 | 非正数**回落默认值**，不夹到下限 | `Math.max(1, 0)` 会把用户以为"关掉门槛"的 0 静默变成 1，语义变了却看不出来 |
| **陈旧锁兜底** | `RUNNING_STALE_MS`（5 分钟）强制解锁 | `SUMMARY_TIMEOUT_MS` 只兜 LLM 调用本身；这层兜**任何**挂起路径，防"总结永久静默失效" |
| **`agent/disposed` force** | 会话结束绕过门槛与防抖写一次 | 会话一结束就没有下一轮，最后一段对话会永久丢失 |
| **pending 补跑** | 被 `running` 挡下的那次在 `finally` 里补跑 | 否则那次机会永久丢 |
| **失败可见** | 失败时写 `error.log`（与 `settings.json` 同级） | **不写进 `.journal/`** —— 那是"今天做了什么"的叙事，塞错误会污染它 |
| **写盘串行队列** | 同一路径的写入串行化 | 防并发读-改-写互相覆盖 |
| **不加 changelog** | 我们是**追加索引行 + 日志**，不是替换正文 | 与 preset-md 形态不同，changelog 无意义 |

**LLM 调用次数：1 次。** 与 preset-md 一致 —— 一次调用同时产出 `notes`（日志）
与 `memories`（记忆），落盘时按需分发。双阈值只决定**何时触发**，不改变调用次数。

**汉化**：面向模型的文本（协议段、工具描述、总结提示词、参数说明、错误消息、
截断警告）全部改为中文 —— 用户明确要求，且与日志语言一致。

> ⚠️ **一处有意偏离上游**：`truncateEntrypointContent` 的**警告文案**汉化了
> （它是注入给模型的文本）。**截断逻辑本身仍与 CodeBuddy bundle 逐字节一致** ——
> 差分测试改为「剥掉警告段比正文 + 比对截断标志」，并另加一组断言确保
> 汉化后的警告仍表达「记忆不全」与处置建议。

### 7.2 日志格式（一天一个文件，按写入时间分多批）

- 一天一个文件：`.journal/YYYY-MM-DD.md`，**append-only，永不覆盖**
- 按写入时间分多批：每次写入开一个 `## HH:MM:SS` 小节，条目列在下面

```markdown
# 2026-09-13

## 14:32:07
- 修了分隔符 bug
- 补了并发测试

## 15:08:41
- 加了轮末提醒
```

同一天分几次写的，一眼可见 —— 不必靠条目顺序去猜。

### 7.3 日志写什么（对照 WorkBuddy）

WorkBuddy 的每日日志由**主模型**按提示词规则直接 Edit 写入，要求原文
（`workbuddy-builtin/prompt-common/fragments/workbuddy-memory-system.md`）：

> **When to write (MUST follow):** Immediately after completing substantive work,
> append a brief note to `{{WorkbuddyMemoryDir}}/YYYY-MM-DD.md` using the Edit tool.
> Substantive work includes:
> - Built or modified a website/application
> - Fixed a bug
> - Wrote or generated a report or document
> - Completed code refactoring or architecture changes
> - Chose a technical approach (framework, design pattern, etc.)
> - User shared project conventions or preferences → also update MEMORY.md in place
>
> Daily logs are append-only. Do NOT record transient information
> (search results, temporary paths, tool errors). Only persist what has lasting
> value across sessions.

**要点：**
- 内容是**「做了什么事 + 得出什么结论」**——不是正文，不写 Why/How（那是记忆文件的事）
- 用**正面清单**枚举"什么算 substantive work"
- **负面清单**明确不记：搜索结果、临时路径、工具报错
- **append-only，永不覆盖**

**本方案与 WorkBuddy 的差异：**

| | WorkBuddy | 本方案 |
|---|---|---|
| 谁写 | 主模型（提示词驱动） | **后台异步 LLM 调用**（7.1） |
| 写入时机 | 完成实质工作后立即 | **一轮混合结束时**统一总结 |
| 好处 | — | 不打断主对话；写入更可靠（不依赖主模型自觉） |

**日志条目内容要求（2026-09-13 修订）：** 写「做了什么事 + 得出什么结论」，每条
**1-3 句**。

> **⚠️ 修订原因（务必读完再改这里）。** 初版照抄 WorkBuddy 写的是"一行一条的简述"，
> 实现时只把**负面清单**译进了 `SUMMARY_SYSTEM`，**正面清单漏了**。结果模型只知道
> "不该记什么"（搜索结果/临时路径/工具报错），不知道该记什么，于是真实日志退化成
> 一句泛泛的"研究了 X 的实现方式"——**结论全丢，事后无法还原当时的推理**。
>
> 两个必须记住的教训：
> 1. **正负清单要成对出现。** 只给负面清单等于只给了约束、没给目标。
> 2. **WorkBuddy 的负面清单是在"主模型写日志"的语境下定的**，防的是主模型顺手
>    把搜索结果贴进日志。我们的日志由**后台总结模型**写，它这一轮干的**就是**
>    搜索与分析 —— 原样照搬等于禁止它记录自己的主要产出。现已放宽为
>    **"别贴原始材料"**（工具输出、搜索原文、文件内容），而不是"不许记搜索这件事"。

**正面清单（判定标准，floor 不是 ceiling）**：建/改了什么代码或文档、修了什么 bug
（含原因与修法）、调查了什么（发现与决定）、选定了什么技术方案（或否决了什么）、
回答了什么需要真功夫的问题、跑了什么测试或分析（要结果不要命令）。

**负面清单**：不贴原始材料（工具输出、搜索结果原文、文件内容），不记没发生过的事，
不记密钥（除非用户明确要求）。

**长度与截断**：`MAX_OUTPUT_TOKENS` 已从 2000 提到 4000。放开 notes 长度后必须同步
确认这个余量 —— **输出被截断 = JSON 不完整 = `parseSummary` 整体丢弃 = 这一轮的
日志和记忆全丢**（不是少记几条，是全丢）。`summarize` 套件有对应回归断言。

---

## 八、明确不做（一期）

| 项 | 原因 |
|---|---|
| **glob 条件触发（RULE）** | DSH 无"文件被访问"钩子，需在工具调用层插桩，成本高；且已决定不做 RULE |
| **语义相关性召回** | **否决**（2026-09-13）。见下方专项分析 |
| **会话 jsonl 检索** | DSH 会话是 `session.jsonl.zstd` **压缩格式**，需先解压；且 CodeBuddy 自己标为 "last resort — large files, slow" |
| **云端记忆** | 仅本地 |
| **命令修改** | 只做自动生效 + UI 改配置 |
| **复用 skill 机制** | 概念不混用 |

### 8.1 语义召回专项分析（2026-09-13 实读 CodeBuddy 源码后否决）

**先纠正一个命名误解**：CodeBuddy 的「语义相关性召回」**没有任何语义/向量技术**。
实测其召回模块前后各 8KB 范围内，`embedding` / `vector` / `cosine` / `dotProduct` /
`fetch` / `axios` **全部为 0 次**。（包内 112 处 `vector` 经查是 `vector_stores`——
OpenAI Assistants API 的服务端功能，以及 `GeoVector` 这类 UI 图标，与记忆无关。）

**它的真实实现是「LLM-as-retriever」**：每轮用户输入时，把记忆清单交给一次独立的
LLM 调用（agent 名 `memorySelector`），由它返回相关文件名。

```
每轮用户输入
  ↓ extractLastUserQuery(input)         取最后一条 user 消息文本
  ↓ scanMemoryFiles(memoryDir)          递归扫 *.md（排除 MEMORY.md）
  │   ├─ 每个文件只读前 4096 字节（readFileHead，常量 tn=4096）
  │   ├─ 解析 frontmatter 的 name/description/type
  │   └─ 按 mtime 新→旧排序，取前 200 个（常量 e7=200）
  ↓ formatMemoryManifest(files)         拼成 `- [type] file (time): name: description`
  ↓ doAISelection(query, files)         ★ 起独立 LLM 调用（runOneTime(MEMORY_SELECTOR)）
  │   输入：`Query: {问题}\n\nAvailable memories:\n{清单}`
  │   输出：{ "selected_memories": ["文件名", ...] }
  ↓ 过滤本会话已给过的（memoriesSurfacedInSession 集合）
  ↓ 读选中文件全文
  ↓ MessageUtils.addSystemReminder(L.input, ..., "last")
```

**否决理由（按重要性排序）：**

1. **⭐ 破坏 KV Cache 前缀 —— 这与本项目的最高要求直接冲突。**
   注入目标是 `L.input`（**本轮待发请求**的消息数组），`"last"` 表示挂在用户消息末尾。
   **但它在用户消息附近**：注入点之后的整个请求前缀都要重算。
   更关键的是**它每轮都跑**，每轮产生不同的注入文本 → **每轮请求前缀都不同**。
   （对比：`MEMORY.md` 索引走静态注入，那个才缓存友好。本项目选的是后者。）

2. **每轮多一次 LLM 调用。** 用户每发一条消息就多跑一次模型，延迟与费用都是直接税。

3. **选择器 prompt 抄不到。** 它由服务端按 agent 名下发，客户端包里只有调用点
   （`runOneTime(QYL.MEMORY_SELECTOR, ...)`）。我们能抄机制，**抄不到提示词**——
   而提示词才是效果的关键。

4. **它会读记忆正文进上下文。** 与「索引常驻 + 正文按需」不同，它把选中文件**全文**
   塞进上下文。选择错了就是**污染**——正是我们刚花力气修掉的同类风险。

5. **规模不匹配。** CodeBuddy 需要召回，是因为它的记忆是**大量主题文件**
   （`topics/*.md`），索引装不下。本项目是**一个文件一条记忆 + 索引一行**，
   200 行上限 = 200 条记忆。这个规模下，LLM 挑选省下的上下文抵不过它自身的开销。

**替代方案（成本为零，已生效）：** 索引常驻（缓存安全、字节稳定）+ 协议段告诉模型
「索引行是指针，命中就 `read` 原文」+ `memory_md_search` 全文检索工具。
等于把 CodeBuddy 那次**额外的** LLM 调用，换成模型在主对话里**顺带完成**的判断。

---

## 九、参考实现要点（可复用）

### 从 CodeBuddy 抄

| 设计点 | 说明 |
|---|---|
| **索引格式** | `- [标题](文件.md) — 描述` |
| **Typed frontmatter** | `name` / `description` / `type` 四分类 |
| **搜索指引** | 不塞内容，写死"用什么工具搜哪个目录" |
| **层级加载** | 用户级 → 项目级，项目优先级更高 |
| **行数限制** | 200 行 |
| **slug 压缩规则** | 路径转 `-`、小写 |
| **global 概念** | 全局记忆独立目录 |

### 从 WorkBuddy 抄

| 设计点 | 说明 |
|---|---|
| **写入清单化** | 正面清单枚举"什么算 substantive work" |
| **负面清单** | 明确不记：搜索结果、临时路径、工具报错 |
| **强制自清理** | 超限时注入 `ACTION REQUIRED`，让模型先整理再干活 |
| **检索指引** | 明确"不需要就别读"，避免无谓工具调用 |
| **角色边界** | 记忆是补充，不替代最终交付物 |

### 两者都要改掉的

| 原设计 | 本方案 |
|---|---|
| WorkBuddy 时间戳目录 | 固定路径 + 日期文件名 |
| WorkBuddy 双写（日志 + MEMORY.md） | 只写分类文件，索引由 AI 维护；日志是可关闭的留痕 |
| WorkBuddy MEMORY.md 靠 30 天蒸馏才产生 | 记忆即时写入，无延迟 |
| CodeBuddy 手动改文件需重启 | 每次装配重读，热更新 |
| CodeBuddy 记忆在 home 下不随项目走 | 统一在 `.dsh/memory-md/`，路径固定 |

### 9.1 官方消息结构的两个不对称（踩过的坑）

写 `renderTranscript` 这类遍历会话事件的代码时，必须记住**两类消息的字段路径不同**：

| 事件 | 正文位置 | 依据 |
|---|---|---|
| `user/message` | `data.content` | — |
| **`assistant/message`** | **`data.message.content`** | `dsh-session/lib/types/types.d.ts:309-317`：`{ turn, step, message: AssistantMessage, stream, usage? }` |

**读错的后果不报错，只是静默丢数据。** 2026-09-13 实测：我们读的是 `data.content`，
线上 **708 条助手发言一条都没进转写** —— 总结模型只看得到用户说了什么，
看不到做了什么与得出了什么结论，**正好抵消了「让日志写结论」的全部努力**。

> **为什么测试没抓到**：夹具把 assistant 正文也写成了 `data.content`（跟着代码一起错），
> 于是错误写法照样通过。**夹具必须照抄真实结构**，否则测不出字段路径 bug。
> 现已按官方类型修正夹具，并加了正反两向断言（`data.message.content` 要取到、
> `data.content` 不该被读）。

---

## 十、待办（实现阶段）

### 骨架与基础（已完成）

- [x] 确定插件骨架（Cordis plugin）—— 实际用 `inject = ['webServer']` +
      `ctx.inject(['systemPrompt'])` 延迟注册（host 平面早期该服务可能未就绪）
- [x] 实现 slug 计算 —— `src/context.mjs` 的 `getCompressedWorkDir()`（沿用 CodeBuddy 规则）
- [x] 实现路径解析（global / 项目级）—— `src/context.mjs` 的 `resolveScopes()`
- [x] 实现索引读取 + 行数限制 —— `src/inject.mjs` 的 `readIndex()`，200 行 / 4e4 字符
- [x] 实现注入提示词 —— 协议段 `MEMORY_PROTOCOL`（`src/inject.mjs`）；
      搜索指引与写入规则按 §6 的判定留在工具描述里

### 本轮新增（2026-09-13 定案 → 已实施）

- [x] **注入改走 `systemPrompt.context()`**（六节）—— `src/inject.mjs`；骨架 `inject` 仍为 `['webServer']`，
      另经 `ctx.inject(['systemPrompt'])` 延迟注册（host 平面早期该服务可能未就绪）
- [x] **轮末提醒改后台异步 LLM**（7.1）—— `src/summarize.mjs`；`remind.mjs` 已删除
- [x] **后台总结写入记忆文件与日志文件**（7.1 / 7.3）—— 复用 `src/store.mjs` 的同一套写入原语
- [x] **日志按批写入**（7.2）—— 一天一个 `YYYY-MM-DD.md`，每批一个 `## HH:MM:SS` 小节

### 后续修复（2026-09-13 实机暴露的问题）

- [x] **两段式注入**（§6 第二次修订）—— 常量协议进 `section()`（order 950）、
      易变索引进 `context()`（order 10000）。此前两段都在 `context()`，协议跟着每次记忆变化重发
- [x] **游标式跨回合补偿**（§7.1.1）—— 修 `eventsThisTurn()` 只看本轮导致的永久丢失；
      游标只在成功后推进
- [x] **超时兜底**（§7.1.2）—— `llm.stream()` 无内置超时，provider 挂起会让 `running`
      永不复位、游标永久卡死。加 `SUMMARY_TIMEOUT_MS`（60s）
- [x] **`{{...}}` 中和**（§7.1.3）—— 官方 `interpolate()` 对 `context()`/`section()` 都生效，
      记忆含 `{{` 会抛错炸整轮且**永久锁死工作区**。注入边界做相邻花括号转义
- [x] **快照不污染总结输入**（§4.1）—— `isHumanMessage()` 按 `source.kind` 过滤；
      实测 transcript 体积减少 72.4%
- [x] **日志内容加详**（§7.3）—— 补正面清单、放宽语境错配的负面清单、`MAX_OUTPUT_TOKENS` 2000→4000

### 原有待办（续）

- [x] 实现留痕开关与 `.journal` 写入
- [x] 实现 UI 配置项
- [x] 写测试（12 个套件，含新增 `inject` / `summarize`；`remind` 套件已由 `summarize` 取代）
- [x] 同步更新 `README.md`：按定案改写「三个不」为「三条设计要点」

### 明确不做

见 §8（含语义召回专项分析）。

### 抽取说明

`src/store.mjs` 是新增的共享写入原语（`writeAtomic` / `writeMemory` / `appendJournal` /
`upsertIndexLine` / `slugify` 等）。工具侧与后台总结侧都调它 —— 索引格式与日志格式是
对外承诺，两处各写一份迟早漂移。

---

## 附：文档索引

| 文档 | 内容 |
|---|---|
| `docs/plan.md` | 本文件，方案定案清单 |
| `docs/memory-scheme-codebuddy.md` | CodeBuddy 记忆方案详细分析（源码级） |
| `docs/memory-scheme-workbuddy.md` | WorkBuddy 记忆方案详细分析（源码级） |
| `docs/memory-scheme-comparison.md` | 两方案对比总览 |
| `docs/memory-research-six-implementations.md` | 六个同类实现的注入/沉淀机制研究 |
| `docs/memory-research-preset-md-vs-references.md` | dsh-preset-md 与三个参考实现的对照 |
