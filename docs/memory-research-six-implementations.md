# DSH 记忆插件横向研究：六款实现 + 官方注入机制

> **这份文档的用途**：给一个**没有原始对话上下文**的读者（人或模型）快速建立判断力 ——
> 「热记忆该怎么注入」这件事上，业界实际有哪几种做法、各自代价是什么、官方平台提供了什么。
>
> **写作日期**：2026-09-13
> **基础**：四款 DSH 插件**实读源码**（非文档），两款非 DSH 产品有前人分析材料。
> **阅读建议**：先读 [§0 结论速查](#0-结论速查)，需要动手时再读 [§3 设计空间](#3-设计空间四种组合) 和 [§4 避坑清单](#4-避坑清单跨项目共性)。

---

## 0. 结论速查

### 0.1 一句话结论

**热记忆注入有两个正交的决策**，六款产品正好铺满这个空间：

1. **易变内容走哪条通道** —— 官方快照管线（声明式）还是自建 pre-step 消息（命令式）
2. **要不要把常量前缀拆进系统提示词** —— 拆（保住 KV Cache 前缀）还是不拆

**关键事实：拆静态前缀与走哪条通道无关。** 官方通道的 3 个实现里就有 1 个不拆；自建通道的 2 个都拆了。

### 0.2 六款速查表

| | 流派 | 常量前缀 | 易变内容通道 | 去重归属 | 压缩自愈 |
|---|---|---|---|---|---|
| **dsh-auto-memory** | DSH / 工程派 | ✅ `section()` 10000 | `context()` 10000 | **官方 loop** | 自算 |
| **dsh-meow-memory** | DSH / 约定派 | ✅ `section()` 130 | **pre-step 自建** | 自建·**ID** | 自建 |
| **dsh-mnemon** | DSH / 工程派 | ✅ 瀑布 push | **pre-step 自建** | 自建·**文本** | 自建 |
| **dsh-mneme** | DSH / 约定派 | ❌ **无 section** | `context()` 90/85 | **官方 loop** | 白拿 |
| **CodeBuddy** | 非 DSH | — | 每条通路不同 | — | — |
| **WorkBuddy** | 非 DSH | — | 会话启动注入 | — | 提示词自清理 |

### 0.3 如果只想记三件事

1. **官方平台帮你做了两件事：内容去重 + 压缩后重建。** 走 `systemPrompt.context()` 就白拿
   （已用官方真实算法验证，见 [§2.3](#23-官方-loop-白拿的两件事)）。别自己重写。
2. **`section()` 只能放常量。** 这是硬红线：DSH 每个 step 重装提示词，任何读盘的 section
   都会让**整个前缀** KV Cache 失效。
3. **遍历 `user/message` 前必须按 `source.kind === 'user'` 过滤。** 注入的快照也是
   `user/message`，真实数据里非真人消息**比真人还多一倍**。四款里两款踩过
   （见 [§4.1](#41-快照污染用户发言跨插件共性坑)）。

---

## 1. 先决知识：DSH 的注入机制

读任何一款实现前，需要知道官方提供了什么。**这是判断"该抄谁"的前提。**

### 1.1 两套注入机制，`context()` 是少数派

| 机制 | 采用方 | 去重 | supersede 范围 |
|---|---|---|---|
| `systemPrompt.context()` | **仅 3 个**一方包 | loop 内建，**共享一个槽位** | 全局一句 `supersedes earlier runtime-context snapshots` |
| `agent/pre-step` + 自建消息 | **16 个**一方包 | 各自实现 | 各自定义 |

一方包的 `context()` 贡献者及其 order：

| name | order | 内容 |
|---|---|---|
| `sandbox:policy` | 110 | 沙箱模式 + 工作区根路径 |
| `approval:policy` | 115 | 一句 `ASK_SENTENCE` / `NEVER_SENTENCE` |
| `subagent:delegation` | 120 | 子代理委派说明 |

**官方三家都满足"小 + 稳定 + 全局取代"** —— 这是共享一条快照合理的根本原因。

### 1.2 三件容易搞错的事

**① 你的内容会和其他插件拼进同一条消息。**

```js
// dsh-system-prompt/lib/index.js:130
function joinContextSections(sections) {
  const body = sections.map((s) => s.text).join("\n\n")
  if (body.length === 0) return ""
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}
```

**② 去重比对的是拼接后的整段文本**，不是你的那一段。

```js
// dsh-agent-loop/lib/index.js:336
project(current, sections) {
  if (this.retained === undefined && current.length === 0) return
  const snapshot = current.length === 0 ? CLEARED : current
  if (this.retained?.text === snapshot) return   // ← 整段比对
```

**后果**：任一贡献者变化 → 整条快照重发 → 其他人的稳定字节跟着再发一遍。
这正是 mnemon 放弃官方机制的理由（见 [§2.3](#23-mnemon自建-放弃官方机制)）。

**③ `form` 是语义标注，不决定谁去重。** 官方 `ContextForm` 的注释明确说
vocabulary 是语义而非视觉的。meow 用 `form:'snapshot'` 却自己管投递；
`dsh-time-context` 用 `form:'snapshot'` 却自己挂 pre-step 并自管去重。

### 1.3 官方 section / context 的排序空间是独立的

`systemPrompt.section()` 与 `systemPrompt.context()` 各有自己的排序空间，
**同一个 order 数值在两边不冲突**（`dsh-system-prompt/lib/index.js:331` 与 `:344`
分别 sort 两个数组）。

官方 `SECTION_ORDERS` 关键锚点（`lib/types/index.d.ts:109`）：
`HARNESS_IDENTITY -1000` / `DEPLOYMENT_PERSONA_PREFIX 0` / `FILE_REFERENCE 900` /
`TOOL_BASH 1000` / `TOOL_READ 1100` ... / `TOOLS_SDK 5000` / `STRUCTURED_OUTPUT 9900` /
`HARNESS_SOURCE 10000` / `WEB_SURFACE 10100` / `DEPLOYMENT_PERSONA_SUFFIX 10200`

**外部贡献可用任意有限 order。** 900–1000 之间是空档（我们的 950 就在这里）。

---

## 2. 四款 DSH 插件详解

> 四款均已实读源码。行号对应当前 checkout 的版本，见每节的版本注记。

### 2.1 dsh-auto-memory —— 与 dsh-memory-md 几乎逐条同构

**版本**：2.5.1 ｜ **形态**：未压缩 JS（`lib/index.js` 8281 行）

**注册三处，全部吃官方快照管线：**

| 接缝 | name | order | 行号 |
|---|---|---|---|
| `context()` | `dsh:auto-memory` | 10000 | `lib/index.js:6958` |
| `section()` | `dsh:auto-memory-rules` | 10000 | `lib/index.js:7026` |
| `context()` | `dsh:m6-reference-tail` | 10001 | `lib/index.js:7036` |

```js
// lib/index.js:120
/** Prompt order of the memory section. 10000 = 末尾注入(紧跟用户消息,recency 最高,
 *  保证记忆纪律/自动沉淀说明被模型最后读到,遵循度更高)。 */
const SECTION_ORDER = 10000
```

**它的缓存理由几乎是我们那句的英文版**（`lib/index.js:3591`）：

> 动态记忆 → `ctx.systemPrompt.context()`(user-role 快照)：内容变化才追加新快照，内容不变不重复
> 注入(dsh-agent-loop project() 去重)，system prompt 不再包含动态内容 → 字节级稳定 →
> DeepSeek 前缀缓存全程命中（对比 section 方案：动态内容任何变化都从变化点起击穿整个前缀，**含全部历史**）

**`agent/pre-step` 只做状态刷新，不投递**（`lib/index.js:6907`）—— 投递 100% 走 `context()`。
这点和我们完全一致。

**⚠️ 与我们最深的分歧**：它把 order 10000 用来放**行为纪律**（"必须遵守"），
我们 950 只放**解释性协议**（索引怎么读）。它是"让模型遵守"，我们是"让模型读懂格式"。

**它比我们多的三样（都不建议抄）：**

| 机制 | 位置 | 为什么不用抄 |
|---|---|---|
| `snapshotMinGapRounds: 5` 频率控制 | `lib/index.js:309` | 防**它自己**的历史膨胀；它的快照比我们大得多 |
| `snapshotReinjectOnCompact` | `lib/index.js:310` | 官方已自带（见 §2.3），它在补偿**自己的观察器状态** |
| sha256 日志段指纹 | `lib/index.js:6992` | 同上，节流用 |

**三个已验证缺陷**（说明"成熟插件"也会烂尾）：

1. `disposeTailSurface`（`:7036`）**未加入 disposer 列表**（`:8247` 只有 `disposeContext, disposeSection`）→ surface 泄漏
2. `injectEnabled` 有 UI 开关、有文档承诺"关掉即完全不注入"，但 **host 侧全文只出现 1 次**（就是定义处 `:205`）→ 开关是空操作
3. `injectBudgetChars` 实际 `1600`（`:210`），注释与 README 都写 2400 → 文档漂移

---

### 2.2 dsh-meow-memory —— 按用户消息注入，`context()` 用量为零

**版本**：0.26.0 ｜ **形态**：TypeScript（`src/`）

**关键澄清**：全仓 grep `systemPrompt.context()` → **零命中**。
它只有一个 `section()`（**静态手册**），热记忆全走 pre-step。

```js
// src/index.ts:615 —— 唯一一处 section()
const dispose = svc.section({ name: 'meow-memory:guide', order: 130, text: getMemoryGuide() })
```

`order: 130` 的理由写在 `src/index.ts:591`：工具指南区间末尾（各 `tool:*` 占 100–116）。

**投递方式：splice 到真实用户消息之前**（`src/index.ts:777` / `816` / `868`）：

```js
const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user')
if (userMsgs.length === 0) return decision   // 工具轮：不注入
```

**两条链路的对应关系**（README 的说法 → 实际分支）：

| README 说法 | 实际通道 | 位置 |
|---|---|---|
| first-turn snapshot injection | pre-step 首轮分支 → `buildInjection` | `index.ts:784-822` |
| per-message keyword hits | pre-step 命中分支 → `buildHitInjection` | `index.ts:848-873` |

**首轮判定用会话日志而非 `decision.messages[0]`**（`index.ts:787-797`）——
注释解释：首条用户消息可能与插件通知同批到达，`messages[0]` 未必是用户消息；
harness 在 pre-step **之后**才 append 当前消息，所以首条消息时日志必为空。

**去重粒度最细**：`按 memory id` 记在 `.dsh-meow/sessions/<id>.json`
（`readInjected` / `markInjected`，`src/inject.ts:95-107`），
语义是"**没注入过才注入**"，不是"变了才注入"。

**代价最实在**：首轮快照与命中块**都没有字节上限**，唯一硬上限是 `hitTopK: 2`
（条数）。三款里唯一载荷不可控的。

---

### 2.3 dsh-mnemon —— 唯一主动放弃官方机制

**版本**：0.5.2 ｜ **形态**：TypeScript（monorepo）

**放弃官方去重的理由**（`src/host/lifecycle.ts:357-362`）——**这是全篇最有价值的一段注释**：

> `.context()` used to carry this inside the host's shared runtime-context projection.
> Carrying it here instead **attributes it to dsh-mnemon and keeps a memory write from
> re-emitting other contributors' sections**; supersede stays intact because the block is
> still a complete state replacing its predecessor, keyed on the rendered text's revision digest.

翻译：官方去重键是**全体贡献者 join 后的共享渲染**，一次记忆写入会把
sandbox/approval 的字节一并重发。mnemon 选择独立消息来摆脱这个耦合。

**手法三招：**

1. **`{ prepend: true }`**（`lifecycle.ts:281`）—— cordis 里 `prepend` 即 `unshift`，
   而 waterfall 是"外层先跑"。所以它成为**最外层**参与者：先 `await next()` 拿到
   完整批次（含官方快照），再把自己的快照 append 在最后。
2. **主动过滤残留 context**：`src/host/guidance.ts:10-13` 的 `withoutMemoryViewContext()`
   把 `mnemon:runtime-memory` 从 `assembly.contexts` 剔除，注释：
   *"A View is an own-plugin message, never part of the shared context snapshot."*
3. **自建去重**（`lifecycle.ts:363-371`）：

```ts
private memorySnapshotMessage(): HostUserMessage | undefined {
  const wake = this.memoryWake()
  if (wake === undefined) return undefined
  const text = wake.text
  if (text.trim() === '' || text === this.injectedMemoryText) return undefined
  this.injectedMemoryText = text
  return createPluginMessage(text, 'recall', 'Memory View snapshot')
}
```

**代价（注释自己承认）**：`.context()` "used to get **supersede-on-change for free**"；
自建消息意味着"**re-emitting on change is this plugin's responsibility**"。

**⚠️ 一条真实隐患（补偿不对称）**：
`cueInjected` 已做成 surface-aware（`cueAlreadyVisible()`，`lifecycle.ts:345-352`，
扫 `session.surface.nodes` 因为 durable log 是 append-only 看不到 rewind），
但 **`injectedMemoryText` 仍是纯会话级 flag** —— rewind 丢弃快照消息后该 flag 仍为
"已注入"，会造成**漏注入**。

**投递形态**：`form: 'recall'`（不是 `'snapshot'`）——
因为 `snapshot` 语义上归官方那套 supersede 机制所有，既然脱离了那套机制，就选了语义更贴切的。

**它的文档与代码不一致**：`docs/en/workflows.md:7-13` 与 `v0.2.5.md` 仍写
"协议=section，Wake=context()"，但 v0.3.6 起已改为自有消息（`docs/en/releases/v0.3.6.md:10`）。

**预算上限**：`MEMORY.md` 10KB / `USER.md` 4KB（`plugins/dsh-mnemon-source-runtime/src/defaults.ts`）。

---

### 2.4 dsh-mneme —— 最彻底地吃官方，连 section 都不用

**版本**：外层 0.7.16 / 内层 `dsh-mneme/` 0.7.32 ｜ **形态**：纯 JS（`src/` 与 `lib/` 逐字节一致）

**只有 `context()` ×2，零 `section()`、零 pre-step：**

| name | order | 行号 |
|---|---|---|
| `memory` | 90 | `src/inject.js:215` |
| `user-settings` | 85 | `src/inject.js:240` |

```js
// src/inject.js:226-231
// Hot memory (v0.5.0 1.3) leads the single memory block: ... Folding it here
// (instead of a separate context) keeps the prompt assembly stable at two blocks.
const hotText = renderHotContext(ctx);
const body = render(candidates);
if (!hotText) return body;
return body ? `${hotText}\n\n${body}` : hotText;
```

**它明说的目标是"装配保持两块稳定"，不是缓存。** 全仓 grep
`KV|prefix cache|前缀缓存|prompt cach|cache hit` → **零命中**。

**⇒ 它放弃了「常量与易变分离」从而放弃了对缓存稳定性的任何控制。**
常量表头（`[短期上下文]` 等，`src/lang.js:51-79`）留在动态快照里，
每次记忆变化都把常量重发一遍。

**去重：零自管。** 渲染函数每次 assembly 无条件重算，无 hash/version/id 记账。
压缩/rewind 也**零处理**，白拿官方。

**一个真正硬核的坑**：官方 `interpolate()` 会把注入文本里的 `{{...}}` 当
**提示词变量**严格校验（变量名须匹配 `/^[a-z][a-z0-9_]*$/`）。记忆正文里合法的
模板语法（`{{.Server.Version}}`、`{{hl|}}`）会 **throw 并炸掉整轮**。
它只能在注入边界做 run-based 花括号转义（`escapePromptVars`，`src/inject.js:132-135`），
覆盖 memory / 热记忆 / 用户设置三处出口。事故记录见 `CHANGELOG.md:447`。

**它做对了一件事**：三处遍历 `user/message` **全部**按 `source.kind` 过滤
（见 [§4.1](#41-快照污染用户发言跨插件共性坑)）。

**形态**：纯文本 `[短期上下文]` / `[记忆库]` / `[用户设置]`，**无 XML 标签**。
上限：单条 300 / 整块 1500 字符 / 5 条；热记忆 5 轮 / 2000 token。

---

## 3. 设计空间：四种组合

```
                    拆静态前缀？
                    是 ────────── 否
走官方     是    auto-memory     mneme          ← 3 款
context()  │     dsh-memory-md
           │
          否    meow / mnemon                   ← 2 款
```

**右下角为空，不是巧合**：既然已经放弃官方去重（自己扛所有状态），
那就更该把常量挪出动态块 —— 否则等于把两边的缺点都占了。

### 3.1 决策树

**问题 1：内容多大、多久变一次？**

- **小且稳定**（几个字节，一会话几乎不变）→ `context()`，白拿去重
- **易变 / 大块** → 仍可用 `context()`，但要注意它会让**整条**快照重发（拖累他人）

**问题 2：supersede 范围是全局还是局部？**

- **全局**（新的取代所有旧的）→ `context()` 的语义正好
- **局部**（按文件取代、整体取代某类）→ **必须自建消息**，否则语义被踩坏

官方三家都在"小 + 稳定 + 全局"那一格，所以共用一条快照合理。

### 3.2 两条路线的对价表

| | 走 `context()` | 自建 pre-step 消息 |
|---|---|---|
| **去重** | 白拿（整段文本比对） | 自建（ID 或文本，见下） |
| **压缩后重建** | **白拿**（见 §3.3） | 自建 |
| **rewind 恢复** | 白拿 | 自建（需扫 surface） |
| **归属** | 归官方插件名，轨迹 UI 归因不到你 | 归你自己 |
| **supersede 语义** | 全局一句 | 自定义 |
| **耦合** | 与他人共享一条消息，互相拖累 | 隔离 |
| **载荷上限** | 无硬约束（自行控制） | 无硬约束（自行控制） |

**自建去重连"什么算变了"都要各自定义** —— meow 按 **ID**（没注入过才注入），
mnemon 按 **文本**（渲染文本比对）。两者语义不同，选哪个取决于你的内容是否有稳定 ID。

### 3.3 官方 loop 白拿的两件事（**已用真实算法验证**）

**别自己重写这个。** 验证方法：逐字截取官方 `RuntimeContextProjection` 源码
（该类未导出）并执行，用官方真实的 `isReplacementSurfaceEvent`：

```
4) 内容未变且快照在 surface 上 → 不产出（去重跳过）✓
5) 压缩替换区间覆盖该快照
6) 内容一字未变 → 产出新快照 ✓
```

机制（`dsh-agent-loop/lib/index.js:327`）：

```js
else if (this.retained && isReplacementSurfaceEvent(event)
         && event.sourceEventSeqs?.includes(this.retained.seq) === true) this.retained = null
```

压缩侧发的是 `surfaceOp: {op:'replace'}` 且 `sourceEventSeqs` 覆盖被吃掉的 seq
（`dsh-compaction-basic/lib/index.js:627`）→ `retained` 归零 → 下次必然重发。

> **⚠️ 一个我犯过的错，写在这里以免后人重犯**：
> 曾以为"官方缺压缩后重建"，并建议移植 auto-memory 的 `contextVersion` 检测。
> **两处都错**：① auto-memory 的 `contextVersion` 是**它自己的观察器计数器**
> （只在它自己产生有效 Segment 时递增），不是官方信号；② 官方本来就自带。
> **教训：建议"移植 X 的能力"之前，先验证官方是否已提供。**

---

## 4. 避坑清单（跨项目共性）

### 4.1 快照污染用户发言（跨插件共性坑）

**运行时快照以 `user/message` 落盘**，遍历时必须按 `source.kind === 'user'` 过滤。

**真实数据**（11 个会话，130 条 `user/message`）：

```
    69  user                                          ← 真实用户
    23  plugin plugin=@deepseek-ai/dsh-system-prompt form=snapshot   ← 运行时快照
    17  plugin plugin=cordis-host-runner
     7  plugin plugin=@deepseek-ai/dsh-memory-md
     5  skill-catalog form=catalog
     3  plugin plugin=dsh-mnemon form=instructions
     3  agent-message form=relay
     3  subagent-settled form=notice
```

**非真人消息比真人还多一倍。**

**为什么严重**（不只是浪费 token）：快照里含记忆条目的**标题与描述**，
被总结模型当成"用户说过的话"后，可能据此**再写一条重复记忆** —— 自我喂养。

**各家处置：**

| 产品 | 状态 |
|---|---|
| dsh-auto-memory | **踩过**，写了 `intent-clean.js` 三层剥离；曾被列为 blocker B1（有过"真人问题整条被丢"的事故，`lib/intent-clean.js:13-18`） |
| dsh-mneme | ✅ **已正确过滤**三处 + 回归测试，注释明写 *"only direct human prompts are summarized"* |
| dsh-meow-memory | ✅ 用 `source?.kind === 'user'` 判断 |
| **dsh-memory-md** | ⚠️ **曾踩**，2026-09-13 已修（`isHumanMessage`） |

**修法（严格匹配，不要 fail-open）：**

```js
export function isHumanMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}
```

官方契约里 `Message.source` 是**必填**字段（`@deepseek-ai/dsh-llm` 的
`lib/types/message.d.ts:128`），所以严格匹配不会漏；宽容放行反而会漏掉未来新增的插件来源。

> mneme 用的是 fail-open（`kind !== undefined && kind !== 'user'`），为兼容极简测试替身。
> 生产路径安全，但严格匹配更好。

**同类问题**：`MIN_NEW_MESSAGES` 之类的"本轮消息数"门槛也不能把注入消息算进去，
否则一轮「真人一句 + 助手一句」会被数成 3~4 条**虚过门槛**。

**dsh-memory-md 修复实测量**：

| | 修复前 | 修复后 |
|---|---|---|
| transcript 总字符（11 会话） | 158,722 | 43,884 |
| 含快照文本的会话 | 11 / 11 | 0 |

减少 **72.4%**。

### 4.2 `{{...}}` 会炸整轮

官方 `interpolate()` 把注入文本里的 `{{...}}` 当提示词变量**严格校验**
（变量名须匹配 `/^[a-z][a-z0-9_]*$/`），不合法就 **throw**。

**这条对读盘内容的风险最高** —— 记忆正文/索引可能含合法的模板语法
（`{{.Server.Version}}`、`{{hl|}}`）。mneme 为此做了边界转义。

> **⚠️ dsh-memory-md 尚未验证此风险。** 我们的协议段是常量（安全），
> 但索引来自 `MEMORY.md`，理论上可能被写入花括号。**这是已知的未验证风险点。**

### 4.3 只有常量才允许进 `section()`

DSH 每个 step 重装提示词（`dsh-agent-loop` 的 `systemPrompt.assemble()`），
**任何读盘的 section 都会让整个前缀 KV Cache 失效**。

这是硬红线。当年 dsh-memory-md 从 `section()` 全部迁到 `context()` 的理由只对
**读盘内容**成立；把**常量协议**放回去是安全的（且能避免它随快照重发）。
我们的第二次修订就是做这个拆分。

### 4.4 其他已验证的坑

| 坑 | 谁踩过 | 说明 |
|---|---|---|
| `disposeTailSurface` 未注册 disposer | auto-memory (`:7036` vs `:8247`) | surface 泄漏 |
| 配置开关是空操作 | auto-memory `injectEnabled` | host 侧从不读取，UI/文档却承诺生效 |
| 倒置的补偿 | mnemon `injectedMemoryText` | rewind 感知只做了一半，会漏注入 |
| 文档与代码不一致 | mnemon、mneme | workflows.md 描述的是旧机制 |
| `src/` 改了没同步 `lib/` | mneme (issue #65) | npm 实际加载 `lib/`，导致"不报错但静默失效" |
| 时间戳工作区导致记忆分散 | WorkBuddy | 每次会话新建时间戳目录 |

---

## 4.5 回合结束后的「总结」怎么写（四款对照）

> 这一节回答的问题与 §2 不同：§2 是**热记忆怎么常驻**（注入），这一节是**回合结束后谁来总结、怎么写记忆/日志**（写盘）。
> 2026-09-13 实读四款源码得出。

### 4.5.1 谁来做总结：三种路线

| | 谁总结 | 内容从哪来 | 触发 |
|---|---|---|---|
| **auto-memory** | **真子代理** `subagents.start('spawn')` | **显式传文本**（拼 user+assistant） | `turn-stopping` |
| **meow** | **主 agent 自己** `agent.followup()` | **靠自身上下文**（`turnText` 是死参数） | `turn-stopping` + 定时器 |
| **mnemon** | **真子代理** `subagents.start('fork')` | **靠继承的上下文**（prompt 仅一句） | `turn-stopping` → **30s 空闲延迟** |
| **mneme** | **独立 LLM 调用** `ctx.llm.stream()` | **显式传全会话转录** | `session/event` 的 `turn/end` |

**核心分野是「内容从哪来」**：

- **fork / 主 agent 自己**（meow、mnemon）→ 模型本来就记得历史，**不需要传内容**。
  meow 的 `buildReflectMessage(ws, turnText, ...)` 里 **`turnText` 接收后从未被使用**；
  mnemon 的 review prompt 只有一句 `'Review the inherited completed checkpoint now.'`。
- **独立调用 / spawn**（auto-memory、mneme、**我们**）→ 没有会话上下文，**必须自己喂**。

### 4.5.2 总结范围：四种做法

| | 范围 | 水位存哪 | 失败时 | 重启后 |
|---|---|---|---|---|
| **auto-memory** | 只最后 **1 条 user + 1 条 assistant** | 无（`lastTurn` 只存最后一个 turn） | **永久丢失**（实测 turn 2 的内容在 turn 3 提示词中完全不出现） | ❌ |
| **meow · reflect** | **只本轮**，无游标 | 无 | **永久丢失** | ❌ |
| **meow · dream** | 本窗口累积 | DB `last_dream_time` | `releaseDream` **不清水位** ✅ | ✅ 可恢复 |
| **mnemon** | 跨轮累积（`turnActivity` Map） | **进程内存** | 不清零 ✅ | ❌ **永久丢失**（作者列为 roadmap P0） |
| **mneme** | **每次重读整个会话** | **无游标**（重读即补偿） | 天然补上 ✅ | ✅ |
| **我们** | 游标之后累积 | **进程内存** | 不清零 ✅ | ❌ 永久丢失（重启锚定上一轮） |

**三种解决"漏掉回合"的思路：**

1. **无游标、每轮重读**（mneme）—— 最简单，天然补偿。代价：每次都重喂整个会话，**O(n²) 的 token 成本**；且转录截断是**保头弃尾**（`trim = (s,n) => s.slice(0,n)`），超长会话**最新内容反而被丢掉**。
2. **游标/水位 + 失败不推进**（meow·dream、mnemon、我们）—— mnemon 的注释最直白：*"failed/aborted → retain activity"*。
   代价：**水位存进程内存**时，重启即丢（mnemon 和我们都是；mnemon 把它列为 roadmap P0）。
3. **只最后各一条**（auto-memory）—— **放弃补偿**，靠降低频率（每日 8 次 + 冷却 30 分）控制成本。

> **auto-memory 的重试队列在默认配置下是死代码**（子代理实测）：失败后入队「最多 3 次、队列上限 5」，
> 由 5 分钟定时器驱动（`lib/index.js:8223`）。但 `runtime.lastConsolidateAt` 在**调用子代理前**就置位
> （`:5116`），重试必然先撞 30 分钟冷却（`:5099`）；即使时钟推过去，又撞同轮去重（`:5101`）；
> 而队列条目 TTL 也是 30 分钟（`:8227`），与冷却相同 —— 条目总在"冷却未过"与"已过期"之间被消费掉。
> 实测两次真实定时器 tick（25 分钟 / 40 分钟）**都没有产生第二次子代理调用**。
> **教训：冷却扣减必须在成功之后，否则重试永远没有预算可用。**

### 4.5.3 ⭐ 官方关键约束：`turn-stopping` 在 error/abort 路径**不派发**

**这条影响所有基于 `turn-stopping` 的实现。已实读 `dsh-agent-loop/lib/index.js:925-1001` 一手确认。**

```js
// :933
try {
  while (true) {
    ...
    const stepEnd = await this.step(decision)
    if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd
    ...
    if (turnEnds && this.inbox.nextStep.length === 0) {
      await this.dispatch.serial("agent/turn-stopping", { turn, signal })  // :967 ← 唯一派发点，在 try 的 while 内
    }
  }
} catch (error) {
  if (signal.aborted) { turnEnds = { kind: "aborted" }; throw error }      // :978
  turnEnds = { kind: "error", ... }                                        // :984 ← 走这里
  this.throwError(error)                                                    // ← 直接抛，不派发
} finally {
  this.session.append("turn/end", { turn, reason: turnEnds })              // :994 ← 只写事件，不派发 hook
}
```

**决定性细节：`turnEnds` 由 `step()` 的返回值赋值**（`:958`），而 `step()` 正常路径只返回
`{kind:'completed'}` / `{kind:'max-tokens'}` / `null`（`:1115-1119`）—— 它的 `catch` 是
**`throw error` 重新抛出**（`:1120-1122`），**从不返回 `kind:'error'`**。
所以 `kind:'error'` / `'aborted'` 只可能出现在 `catch` 块里，而那里**没有派发代码**。

| 场景 | `turn-stopping` 是否派发 |
|---|---|
| 正常完成 `completed` | ✅ 派发 |
| `max-tokens` | ✅ 派发 |
| **LLM 抛错 `error`** | ❌ **不派发** |
| **用户中止 `aborted`** | ❌ **不派发** |

**后果**：回合以 error 或 abort 结束时，`turn-stopping` 监听器**根本不会被调用**。
所以"回合崩了 → 下次补上"这个能力，**只能靠"水位/游标从未推进"来实现**，不能靠"崩了再触发一次"。

mnemon 独立确认同一点，并明确它的应对是水位跨轮累积、失败不清零。

> ⚠️ **一个容易踩的阅读陷阱**：只看 `:966` 的派发条件会以为"error 也照发"——
> 那个条件确实只检查 `turnEnds && inbox.nextStep.length === 0`，**但它位于 `try` 块内**，
> 而 error/abort 会直接跳进 `catch`，绕开整个循环。本次分析中有一份报告就是这样误判的。

**推论**：想监听"所有回合结束"（含 error），必须改用 `session/event` 的 `turn/end`
—— 这正是 **mneme 选 `session/event` 而不是 `turn-stopping`** 的原因，它连 `reason` 都不看，
error 回合照样总结。

### 4.5.4 并发与失败处理对照

| | 并发控制 | 超时兜底 | 重试 | 频率限制 |
|---|---|---|---|---|
| **auto-memory** | `runtime.consolidating` + `_subagentInflight>=3` 拒 spawn + 熔断 30 分 | ✅ **40s 外层** + 90s 内层 + `run.result` 兜底 | 队列（≤3 次/≤5 深度）但**默认配置下是死代码** | **每日 8 次 + 冷却 30 分**（夜间翻倍） |
| **meow · reflect** | ❌ **无任何保护** | — | ❌ 无 | 连续 7 个工具 step 门槛 |
| **meow · dream** | DB 租约 + CAS + 心跳 | — | ✅ `releaseDream` 下周期重试 | 空闲 3h + 6h 冷却 + 峰时抑制 |
| **mnemon** | `reviewRunning` + 新调度先 abort 旧 | — | ❌ 无退避/熔断（roadmap P0 未做） | 空闲 30s + score≥5 + 脏准入 |
| **mneme** | per-session 互斥 + **全局串行队列** | — | ✅ 429 指数退避 3 次 | 间隔默认 0（每轮必跑） |
| **我们** | `running` 标志 | ❌ **无** | ✅ 失败不推进游标，下轮重试 | ❌ **无** |

**两个我们缺的（值得补）：**

1. **超时兜底** —— auto-memory 包了三层（40s 外层 `:5220`、90s 内层 `:4875`、`run.result` 兜底 `:4900`），
   注释说明 **DSH 无内置超时**，卡死会泄漏状态并使 `finally` 不执行。
   我们的 `running` 标志如果因 LLM 挂起而不释放，**游标会永久卡死**
   （失败计数只在抛错时累加，"挂起"不算失败）。**这是真实风险。**
2. **频率限制** —— 三家都有（每日上限/冷却/门槛）。我们是**每轮都跑**，成本线性增长。

**一个反直觉的发现**：auto-memory 的范围**比我们还窄**（只取最后各一条），说明"跨回合补偿"它**没解决** —— 我们的游标方案在这点上比它完整。

**另一条教训（来自它的实现）**：auto-memory 把冷却/额度扣减放在**调用子代理之前**（`:5116-5117`），
导致失败也消耗预算，重试队列因此永远没有可用额度。
**我们反过来 —— 只在成功后才推进游标**，这一点是对的。

### 4.5.5 各家自认的代价（原话）

| 插件 | 原话 | 出处 |
|---|---|---|
| meow | *"steer 延续同 turn 会把 AI 的工作汇报顶成中间步骤"* | `src/dream.ts:297-301` |
| meow | *"**50 元 token 血训**"*（反复 dream 是最大烧钱风险） | `src/dream.ts:243-245` |
| meow | *"封存会让一次断网永久吞掉窗口的 dream"* | `src/db.ts:494-498` |
| mnemon | 水位不持久化 = **roadmap P0 未完成项** | `docs/en/workflows.md:308`、`roadmap.md:14` |
| mneme | *"本机实测**单日 84 次**、单会话一天 **198 条**、同一事实 6 小时铸出 **28+ 条**"* | `src/config.js:21-24` |
| mneme | *"对话一多时 turn/end 会批量触发蒸馏，多个 LLM 请求'一拥而上'正是 **429 的来源**"* | `src/summarize.js:150-155` |

> mneme 那组数字最有警示意义：**它默认"每轮必跑"，结果单日 84 次调用、同一事实 6 小时铸出 28 条重复**。
> 它为此加了三个阀门，但**默认全部关闭**（"阀门交给用户按需拧，升级本身不改行为"）。
> 我们目前也是每轮必跑 —— 值得引以为戒。

### 4.5.6 我们能从这个对照里拿到的三条

1. **`turn-stopping` 在 error 路径不派发**（§4.5.3）—— 解释了我们遇到的"回合崩了零留痕"。若要让 error 回合也留痕，得改用 `session/event` 的 `turn/end`。**但注意**：用户已明确否决"为 error 加错误日志"（无意义），所以这条只作为**机制知识**记录，不作为改动方向。
2. **补超时兜底** —— 防 `running` 标志永久卡死。这是**真实风险**，不是美化。
3. **考虑频率限制** —— mneme 的 84 次/日 是前车之鉴。

---

## 5. 非 DSH 产品参考

> 这两款的分析材料在 `docs/memory-scheme-{codebuddy,workbuddy}.md`，
> 本节只提炼**与注入机制相关**的部分。

### 5.1 CodeBuddy —— 工程检索派

**版本**：v2.136.0 ｜ **形态**：打包 `dist/codebuddy.js`

**两条注入路径**（早期分析曾混淆，2026-09-13 更正）：

| 路径 | 函数 | 注入内容 |
|---|---|---|
| **legacy** | `generateLegacyMemoryPrompt` | `MEMORY.md` 全文（截断后） |
| **typed**（默认） | `generateTypedMemoryPrompt` | 各记忆文件的 **frontmatter 描述** |

**索引格式**（我们直接沿用了）：

```markdown
# MEMORY.md

- [标题](文件.md) — 一句话描述
```

**双级截断**（`truncateMemoryEntrypoint`）：200 行 + 25KB，UTF-8 边界安全 + 换行回退 + 截断标记。
比单级字节截断完备。

**最值得借鉴的一招：搜索指引**（不塞内容，告诉模型怎么搜）：

```markdown
## Searching past context
1. Grep with pattern="<search term>" path="${memoryDir}/" glob="*.md"
2. Session transcript logs (last resort — large files, slow)
Use narrow search terms rather than broad keywords.
```

**本质是分层收窄**，不是无脑 grep：索引常驻 → 命中后 grep 主题文件 → jsonl 转录是最后手段。

**typed frontmatter 的 `description` 用于"决定未来对话中的相关性"** ——
长度由**写入侧**约束，不是读取侧截断。行数限制防的是**条目数量膨胀**，不是单行长文本。

**最大痛点**：手动改记忆文件**不生效，必须重启**。对比：DSH 每次装配重读磁盘。

**其他独有能力**：glob 条件触发（`ConditionalRules` 拦截器）、语义召回
（`injectRelevantMemories`）、`@import` 递归（深度 5）。

### 5.2 WorkBuddy —— 提示词约定派

**形态**：asar 解压 + prompt-common fragments

**三层**：

```
Layer 1  Cloud Memory        服务端画像 + conversation_search   只读
Layer 2  User Local Memory   ~/.workbuddy/MEMORY.md             4000 字符
Layer 3  Workspace Memory    {cwd}/.workbuddy/memory/
           ├─ YYYY-MM-DD.md   每日日志，append-only
           └─ MEMORY.md       项目笔记                    8000 字符
```

**每次会话启动只注入两个 MEMORY.md + 云画像。**
每日日志**不注入**，靠模型自己按需读取。

**最值得借鉴的一招：强制自清理（ACTION REQUIRED）**

超限时**不简单截断**，而是注入指令让模型先整理再干活：

```
**ACTION REQUIRED**: Your MEMORY.md has exceeded the size limit and was truncated
during injection. Before proceeding with the user's task, you MUST first clean up:
1. Read the full MEMORY.md
2. Consolidate and deduplicate
3. Rewrite it in place
4. Then proceed with the user's request
```

**把"记忆膨胀"这个长期治理问题外包给模型自己** —— 零额外 LLM 调用、零维护脚本。

**检索指引明确写"不需要就别读"**（避免无谓工具调用）：

```markdown
- This project's past work → read local daily logs (most recent first) or MEMORY.md
- Items spanning projects → call conversation_search
- No historical dependency → skip reading memory files.
```

**实测发现的问题**（2026-09-13 核实）：

- 日志目录是**时间戳**（`2026-09-09-09-30-23/`），不是固定路径 → 记忆分散
- **默认没有 MEMORY.md**，只在"用户分享约定"或"30 天日志蒸馏"时产生
  → 新项目注入空串，**生效明显的反而是过期记忆**
- 代码中**没有任何检索实现**，全凭模型发挥

### 5.3 两者对比与我们的选型

| | WorkBuddy | CodeBuddy |
|---|---|---|
| 流派 | 提示词约定派 | 工程检索派 |
| 核心手段 | 清单规则 + 强制自清理 + 模型自觉 | Grep + 语义召回 + typed + glob |
| 基础设施 | 零 | 需 relevanceService、拦截器、索引服务 |
| 记忆位置 | `{cwd}/`（项目内，可进 git） | `~/.codebuddy/projects/{slug}/`（home 下） |
| 超限处理 | ⭐ **强制模型自清理** | 双级截断 + 标记 |
| 热重载 | ✅ 每次装配重读 | ❌ **必须重启** |

**dsh-memory-md 的选型（已定案，见 `docs/plan.md`）**：
以 CodeBuddy 为主干（索引格式 / typed 四分类 / 搜索指引 / 行数限制），吸收 WorkBuddy 的提示词规则，自研插件落地，**每次装配重读 → 热更新**。

**吸收关系（2026-09-13 更正，此前本文档归错了位置）**：

| 来源 | 落到哪里 | 理由 |
|---|---|---|
| **CodeBuddy 的规则** | **长期记忆**（`memories`） | 它的规则本就写给"持久记忆"：按主题组织、What to save / What NOT to save、去重前先查重、索引简洁。它**没有日志概念** |
| **WorkBuddy 的正面/负面清单** | **日志**（`notes`） | WorkBuddy 的提示词分两份：`MEMORY.md` 规则 + **日志规则**（"append a brief note"、append-only、30 天蒸馏）。日志粒度这一栏 CodeBuddy 是空白 |

> ⚠️ **一个真实踩过的坑**：初版只把 WorkBuddy 的**负面清单**译进了 `SUMMARY_SYSTEM`，
> **正面清单漏了**。于是模型只知道"不该记什么"，写出来的日志退化成一句泛泛的
> "研究了 X 的实现方式"，**结论全丢**。
> **教训：正负清单必须成对出现 —— 只给约束不给目标，等于没给规则。**
> 另有语境陷阱：WorkBuddy 的负面清单是给"主模型写日志"定的，防它顺手贴搜索结果；
> 我们的日志由**后台总结模型**写，它这一轮干的就是搜索与分析，原样照搬会禁止它
> 记录自己的主要产出。详见 `docs/plan.md` 第 7.3 节。

---

## 6. dsh-memory-md 自身基线

> 改这个插件前必读。**需求真源是用户 + `docs/plan.md`，不是本文档。**

### 6.1 两段式注入

| | 内容 | 通道 | order | 行号 |
|---|---|---|---|---|
| **协议** | `MEMORY_PROTOCOL`，常量 | `systemPrompt.section()` | 950 | `src/index.js:153` |
| **索引** | global + project 的 `MEMORY.md` | `systemPrompt.context()` | 10000 | `src/index.js:160` |

- 协议段用 950：文件引用（900）之后、工具说明（1000+）之前，**且不占人设段（0）**
- 索引用 `<memory-index scope="global|project" cwd="…">` 标签裹住（`src/inject.mjs:90`）
- 上限：200 行 / 4e4 字符（`src/codebuddy-port.mjs:40,42`）

**为什么这样拆**：早先两段**都**在 `context()` 里，于是协议文本跟着每次记忆变化
重发一遍（旧快照仍留在历史中，快照是追加而非替换）。拆开后提示词里只剩一份协议。

**硬性前提**：只有常量允许进 `section()`（见 §4.3）。

### 6.2 enabled 语义

`true` 才注入（协议段与索引快照**同时**受控，`src/index.js` 的 `shouldInject`）；
`false` 时工具侧 `assertEnabled()` 拒绝**写入**，但读/搜仍可用。

### 6.3 记忆与日记的 scope 不对称

| | global | project |
|---|---|---|
| `memory_md_save` | ✅ | ✅ |
| `memory_md_journal` | ❌ **已移除** | ✅ |

日记只针对具体工作区 —— 全局流水账混杂多个项目、事后没法读。

### 6.4 轮末后台总结

`agent/turn-stopping` 起一次**独立的、无工具的 LLM 调用**（`ctx.llm.stream()`），
由它总结后**插件自己**写文件。主对话全程不参与、不显示任何东西。

**不投递任何消息**（`regression-kind` 套件断言 `summarize.mjs` 里没有
`inbox.append` / `createUserMessage`，且真跑一次轮末时 `inbox.append` 零调用）。

> **旧实现是反面教材**：往主对话 `inbox.append('next-step')` 塞提醒 →
> 显示在对话里、逼主模型再跑一步；且漏了 `source`，loop 读 `message.source.kind`
> 直接抛错、**整个回合失败**。代码（`src/remind.mjs`）已删除。

**遍历用户消息必须过滤**（见 §4.1）：`src/summarize.mjs` 的 `isHumanMessage`（`:98`）。

**它同时承担两件事**，契约不同：

| | 落点 | 规则来源 | 粒度 |
|---|---|---|---|
| **日志**（`notes`） | `.journal/YYYY-MM-DD.md` | **WorkBuddy** 的正/负面清单 | 每条 1-3 句，含结论 |
| **记忆**（`memories`） | `MEMORY.md` + 分类文件 | **CodeBuddy** 的 typed 规则 | 索引行一句话 |

**`MAX_OUTPUT_TOKENS` 不可随意调低**：输出被截断 = JSON 不完整 = `parseSummary`
**整体丢弃** = 这一轮的日志与记忆**全丢**（不是少记几条）。放开 notes 长度后
已从 2000 提到 4000，`summarize` 套件有回归断言。

---

## 7. 速查索引

### 7.1 源码位置

| 产品 | 路径 | 形态 |
|---|---|---|
| dsh-auto-memory | `D:\workspaces\dsh\dsh-auto-memory\lib\index.js` | 未压缩 JS（8281 行） |
| dsh-meow-memory | `D:\workspaces\dsh\dsh-meow-memory\src\` | TypeScript |
| dsh-mnemon | `D:\workspaces\dsh\dsh-mnemon\src\host\lifecycle.ts` | TypeScript |
| dsh-mneme | `D:\workspaces\dsh\dsh-mneme\dsh-mneme\src\inject.js` | 纯 JS（src/lib 一致） |
| CodeBuddy | `D:\soft\node\node-v22.23.2\node_modules\@tencent-ai\codebuddy-code\dist\codebuddy.js` | 打包 |
| WorkBuddy | `C:\Users\kosei\Desktop\1\app-extracted\` + `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/prompt-common/fragments/` | asar 解压 |
| **本项目** | `D:\workspaces\ai\dsh-memory-md\src\` | 纯 ESM JS |

### 7.2 官方机制锚点

| 机制 | 位置 |
|---|---|
| 快照拼接（含 supersede 头） | `dsh-system-prompt/lib/index.js:130` |
| 快照文本渲染 | `dsh-system-prompt/lib/index.js:144` |
| 去重 + 整段比对 | `dsh-agent-loop/lib/index.js:336` |
| 压缩替换置 null | `dsh-agent-loop/lib/index.js:327` |
| 压缩替换事件构造 | `dsh-compaction-basic/lib/index.js:627` |
| section/context 独立排序 | `dsh-system-prompt/lib/index.js:331` / `:344` |
| `Message.source` 必填 | `dsh-llm/lib/types/message.d.ts:128` |
| `ContextForm` 语义 | `dsh-llm/lib/types/message.d.ts:42-54` |
| section order 常量 | `dsh-system-prompt/lib/types/index.d.ts:109` |

### 7.3 本文档引用的证据强度

| 结论 | 强度 |
|---|---|
| 官方 loop 自带压缩后重建 | ⭐ **实测**（逐字执行官方算法） |
| 快照污染用户发言的严重性 | ⭐ **实测**（11 个真实会话统计） |
| 修复效果 72.4% | ⭐ **实测**（真实数据前后对比） |
| 四款插件的机制与行号 | 实读源码 |
| CodeBuddy / WorkBuddy | 前人分析材料（非本次实读） |

> CodeBuddy 与 WorkBuddy 两节**基于 `docs/memory-scheme-*.md` 的既有材料**，
> 本次未重新验证其源码。引用时注意这一点。

---

*文档结束。改动建议：本文件是**研究记录**，不是需求。需求见 `docs/plan.md`。*
