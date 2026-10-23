# dsh-preset-md 与三个参考实现对照（记忆沉淀 / 日志机制）

> **用途**：给一个**没有原始对话上下文**的读者快速建立判断力 —— dsh-preset-md 与它借鉴的三个实现在
> 「记忆沉淀与日志」这条轴上各自怎么做、谁的设计更好、哪些坑必须避开。
>
> **日期**：2026-09-13
> **证据**：四个实现**实读源码**；平台侧结论对照官方 `@deepseek-ai/dsh` 已安装包源码实测。
> **对 dsh-preset-md 的具体排查与改法**见另一份 `dsh-preset-md-排查与修改建议.md`。

---

## 0. 一句话结论

| 实现 | 记忆沉淀怎么做 | 一句话评价 |
|---|---|---|
| **dsh-preset-md** | `section`（变量承载正文）+ 独立 LLM 调用写日志/记忆 | **写入侧工程化最好**，但注入侧只用一条腿 |
| Hanako-Memory | 5 section + 6 variable + 滚动摘要 + SQLite FTS5 | 调度骨架最完整，但**大半复杂度没用上** |
| dsh-claw-suite | section + 纯 Markdown 金库 + 字符预算 | 设计最干净，但**生产中是死的**（读错 API） |
| openclaw-persona | 纯读文件注入，零写入 | 只配当反面教材 |

**最重要的一条共性教训**（三个参考实现 + 我们自己都栽过）：

> **测试夹具必须来自官方真实事件，不能自己编。**
> 三个参考实现的夹具都「照抄了错误的数据形状」，于是 bug 测试全绿。

---

## 1. 关键机制对照

| 维度 | **dsh-preset-md** | Hanako | claw-suite | openclaw-persona | **dsh-memory-md** |
|---|---|---|---|---|---|
| 注入接缝 | `section()` ×1（`complete:true`）+ `variable()` ×1 | `section()` ×5 + `variable()` ×6 | `section()` ×3 | section + context | `section()`（协议）+ `context()`（索引） |
| 用 `context()` | ❌ | ❌ | ❌ | ✅ | ✅ |
| **`{{}}` 安全** | ✅ **变量承载（结构性）** | ❌ 直拼 section | ❌ 无转义 | ❌ 无转义 | ✅ 手动转义 |
| **`source.kind` 过滤** | ❌ **缺** | ⚠️ 部分 | ❌ 缺 | N/A | ✅ 已修 |
| **字段路径正确** | ✅ | ❌ `session.events` | ❌ `session.events` + user 路径 | N/A | ✅ 已修 |
| 写入执行者 | 独立 LLM | 独立 LLM | 独立 LLM | **无** | 独立 LLM |
| 总结范围 | 尾部窗口重放 | 全量重读 | 最后 12 条 | — | **游标累积** |
| 水位推进时机 | ⚠️ **执行前** | 指纹 | 无 | — | ✅ **成功后** |
| 超时 | ✅ 120s | ❌ | ⚠️ 仅压缩路径 | — | ✅ 60s |
| 陈旧锁兜底 | ✅ 5 min | ❌ | ❌ | — | ⚠️ 仅超时 |
| 会话结束兜底 | ✅ `disposed` force | ✅ `disposed` | ❌ | — | ❌ |
| pending 补跑 | ✅ | ✅ 断点续跑 | ❌ | — | ❌ |
| 失败可见性 | ✅ 注入对话 | ❌ | ❌ | — | ⚠️ 仅日志 |
| 压缩前 flush | ❌ | ❌ | ✅ **`compaction/start`** | — | ❌ |
| 超限处理 | **提示收敛（不截断）** | 输出侧截断 | **拒绝写入 + 教模型整合** | 日记截断 | 硬截断 200 行 |
| 检索 | 逐行子串 | FTS5（**生产未用**） | 无（全量注入） | 无 | 逐行子串 |
| 写盘纪律 | ⭐ 串行队列 + changelog | 原子写 | 原子写 + 串行队列 | — | 原子写 |

---

## 2. 每个实现的「值得吸收」与「必须避免」

### 2.1 dsh-preset-md（v0.1.0）

**值得吸收：**

| 机制 | 位置 | 为什么 |
|---|---|---|
| ⭐ **变量承载正文** | `src/core.js:382`、`:433` | section 文本只有 `{{preset_md}}`，正文全在变量右值里 → 官方 `interpolate()` **不二次扫描替换值** → 用户内容含 `{{挖空}}`/`{{hl\|}}`/`{{{x}}}` 全部安全（实测 6 种场景） |
| ⭐ **超预算不截断，改为「请收敛」** | `src/core.js:280-301` | 原文：*"截断会把记忆切碎，比超一点更糟"*。让模型自己合并重复、删过期、把细节移进日志 |
| **双阈值触发** | `src/preset.js:455` | 轮数 + 新增字符数；比单一条数门槛精细 |
| **陈旧锁兜底** | `src/preset.js:367-374` | `RUNNING_STALE_MS`（5 min）强制解锁，比"只给 LLM 调用加超时"覆盖更广 |
| **会话结束 force 触发** | `src/preset.js:459-464` | `agent/disposed` 时绕过防抖，最后一段对话不丢 |
| **pending 补跑** | `src/preset.js:437-440` | 被 `running` 挡下的那次不丢，`finally` 里补跑 |
| **失败注入对话可见** | `src/preset.js:336-352` | 后台失败不只 warn，还注入对话 + 60s 节流 |
| **白名单四处一致** | `memory-store.mjs:22`、`tools.mjs:82`、`review.mjs:31`、`tools.mjs:108` | 禁改 `SYSTEM.md`/`AGENTS.md`，四处都校验 |
| **写盘三重保护** | `memory-store.mjs:27-49`、`:219` | 原子写 + 按路径串行队列 + 改前先写 changelog |
| **阈值与窗口解耦** | `src/review.mjs:300` | `window = Math.max(requested, DEFAULT)` 只放大不回缩，避免「触发」与「太短跳过」互相抵消 |
| **注释记录踩坑根因** | `src/preset.js:117-124` 等 | 留下为什么，不只留是什么 |

**必须避免 / 需要优化：** 见 `dsh-preset-md-排查与修改建议.md`。

### 2.2 Hanako-Memory（`dsh-assistant-manager` v0.4.1）

> 注意：**不是 monorepo** —— 无 `workspaces`，全仓仅 1 个 `package.json`；
> `assistant-soul` 是同包**子路径导出**（`exports "./soul"`）。

**值得吸收：**

| 机制 | 位置 | 价值 |
|---|---|---|
| **变量空串 → 段自动消失** | `src/soul/prompt.ts:1-7` | "没有记忆时不注入记忆段"的天然机制（官方 `renderPrompt` 确实 filter 空段） |
| **指纹跳编译 + 失败不写指纹** | `src/soul/fingerprint.ts:46-57` | 幂等：内容没变就跳过编译；失败时不写指纹，下次可重试 |
| **每日兜底 + 断点续跑** | `memory-ticker.ts:186-220` | 4 个触发器（pre-step / turn-stopping / disposed / 1h 定时器）互为补偿 |
| **两把并发锁** | `memory-ticker.ts:63-65` | `summaryInProgress` Set + `dailyRunning` |
| **压缩前冲洗** | 滚动摘要在 compaction 前重算 | 防内容被摘要吃掉 |

**必须避免：**

| 问题 | 位置 | 后果 |
|---|---|---|
| ⭐ **用户文本直拼 section** | `src/soul/index.ts:135-138`（`user.yaml` 档案）、`:144`（`config.identity` 前端 textarea） | 实测复现：写入含 `{{我的暗号}}` 的档案 → **每次新会话都炸整轮**；前端后端均无校验 |
| **`session.events` 不存在** | `rolling-summary.ts:302`（生产路径） | 官方 `Session` 只有 `snapshotEvents()`；测试夹具凭空造了 `session.events` 所以没测出 |
| **`temperature` 传了但没生效** | 7 处传入，`src/soul/llm.ts:39-47` 未转发 | 实际用 provider 默认温度 |
| **`MAX_RETRIES=3` 不可达** | `deep-memory.ts:288` 每次新建 `failCounts`，生产调用点不传 | 设计「3 次后放弃」实际是**无限重试**；**测试传了所以通过** |
| **检索层生产零调用** | `fact-store` 465 行，`searchFullText`/`searchByTags` 只在测试调用 | `facts.db` 只写不读；真正进上下文的是生成的 `facts.md` |
| **双份 yuan 模板已漂移** | `assets/yuan/hanako.md` vs `src/soul/yuan.ts:9-45` | 占位符不同（`{{userName}}` vs `{{user_name}}`），而注释自称"一字不差" |
| **孤儿代码** | `lib/import-hana.js`（325 行）无路由，前端硬编码调用 | 「从 Hana 转移」按钮**必然 404** |

**复杂度账**：注入 ~40 行，沉淀 ~2400 行（占 soul 平面 60%），但**利用率低**。

### 2.3 dsh-claw-suite

**值得吸收（本组最实用）：**

| 机制 | 位置 | 价值 |
|---|---|---|
| ⭐ **字符预算 + 拒绝写入 + 教模型整合** | `memory-entries.mjs:1-5`、`:50-57` | 超限返回 `ok:false` + 当前条目 + 文案 "Consolidate with replace/remove, then retry add." |
| ⭐ **压缩前强制冲洗** | `host.js:463-475` | 监听 `session/event` 的 `compaction/start`，`force:true` 抢救记忆 |
| **身份/记忆所有权分离** | `dsh-agent-identity/host.js:163-166` | identity 明确拒写 `USER.md`/`MEMORY.md` 并报错 |
| **条目级唯一匹配** | `memory-entries.mjs:30-40` | 0 命中 / 多命中都报错，replace/remove 不误伤 |
| **写入前内容扫描** | `memory-scan.mjs:1-10` | 查不可见 Unicode / 凭据 / 注入话术 |
| **高风险写入转待审批** | `host.js:219-224`、`memory-store.mjs:245-283` | pending/approve/reject 队列 |
| **结构化诊断词汇表** | `observe.mjs:88-176`、`codes.mjs:1-44` | `operation/stage/outcome/code` + 凭据打码 + **成功不限流、失败限流** —— 正是"自动写日记"的理想骨架 |
| **三层权限取交（只紧不松）** | `perm-layers.mjs:104-144` | `official ∩ agent ∩ session`，跨层只能收紧 |
| **拒绝写成模型可执行反馈** | `perm-official.mjs:71-81` | "不要重试、不要换写法绕过" |
| **host-contract 测试** | `dsh-agent-memory/test/host-contract.test.mjs:78-88` | 断言注册了哪些事件与 section 名/顺序 |

**必须避免：**

| 问题 | 位置 | 后果 |
|---|---|---|
| ⭐ **`session.events` 不存在** | `host.js:345`（扩散到 11 处） | `transcriptOf(undefined)` → 空串 → 每轮被 `turn_too_short` 跳过 → **整套自动记忆沉淀在生产中是死的** |
| ⭐ **user 字段路径错** | `memory-review.mjs:36` 对两类消息统一读 `data.message.content` | 官方 `user/message` 的 `data` 就是 message → **user 发言被静默丢弃**，实测只剩 `assistant: noted` |
| **夹具照抄错误形状** | `test/review.test.mjs:27-28` | 测试全绿却掩盖上面两条 |
| **无 `{{}}` 转义** | `host.js:252-269`、`identity-files.mjs:67-100` | 实测记忆含 `{{framework}}` → `unknown prompt variable` **炸整轮** |
| **去重 key 用了增长的 `session.seq`** | `host.js:53-57` vs `:360` | `memory_called` 抑制几乎永不生效，可能重复写 |
| **未监听 `turn/end` / `agent/error`** | `host.js:447,463` | 失败/中断回合记忆**永久丢失** |
| **总结只取最后 12 条** | `memory-review.mjs:44-46` | 长回合中段内容永不总结 |
| **无 `source.kind` 过滤** | `memory-review.mjs:32-43` | 只用硬编码 `'[heartbeat]'` 前缀兜底 —— 补丁而非机制 |
| **死代码** | `host.js:77-82`（`mainBriefText` 无调用）、`identity-heartbeat.mjs:14-58`（整套未接线） | 约 150 行 |
| **section 内做同步 IO** | `host.js:261-265` | 每次组装阻塞事件循环，靠 Map 缓存缓解 |

### 2.4 openclaw-persona

**只有 221 行、单文件、零 LLM 调用、零写入。** 它提供不了"自动写日记"的机制参考。

**值得吸收（仅注入姿势）：**

| 机制 | 位置 |
|---|---|
| **per-agent 注册用 `agent.ctx.systemPrompt`** | `src/index.js:101,114,124,143`（官方在重复注册报错里就是这么指路的） |
| **`text` 传函数而非快照** | `:117,127,146` |
| **`mainOnly` 隔离子代理** | `:30,37-40` |
| **走官方 `context()` 通道** | `:124,143`（天然规避"快照污染用户发言"） |
| **`tools/result` 后置刷新** | `:201-215`（比轮询轻） |

**必须避免：**

| 问题 | 位置 |
|---|---|
| 用户 Markdown 原样进 section/context，**零 `{{}}` 转义** | 全文件；且 `{{cwd}}`/`{{model}}` 会被**静默替换**、悄悄改写用户文档 |
| **不转义注入帧** —— 用户写 `</system-reminder>` 可提前闭合 | `:138`、`:150`（官方有范式 `escapeInstructionFrameBody()`） |
| 核心文件**零大小上限** | `:55-59`（只有日记 16K） |
| `DAILY_NOTE_MAX_BYTES` 却用 `.length` 比 | `:35` vs `:72`（中文下实际放大约 3 倍） |
| `safeReadFile` 吞异常 → **静默变空** | `:55-59` → `:117,129` |
| 同步磁盘 IO 在回合关键路径、无超时 | `:57,63` |
| `tools/result` 用字符串拼接做路径前缀匹配 | `:212-213`（相对路径/`~`/反斜杠一律失配，静默不刷新） |
| 硬编码 order、不用官方 `getSectionOrder` | 全文件未找到 |

---

## 3. 跨实现共性坑（**最有价值的部分**）

### 3.1 字段路径与 API：三个实现都栽了

| 事件 / API | 正确 | 踩坑者 |
|---|---|---|
| `assistant/message` 正文 | `data.message.content` | — |
| `user/message` 正文 | **`data.content`** | claw-suite（统一读 `.message` → **丢光 user**） |
| 取全会话事件 | **`snapshotEvents()`** | Hanako + claw-suite（用 `session.events` → 恒空） |

**官方依据**：`dsh-session/lib/types/types.d.ts:309-317`（assistant 结构）、
`dsh-session/lib/types/index.d.ts`（无 `events` 成员，只有 `snapshotEvents`）。

**为什么测试测不出**：夹具自己造了错误形状 → 代码与夹具一起错 → 测试全绿。

> **规矩**：凡是"拼会话文本"的代码，**必须用真实会话日志验证一次字段路径**。
> 我们在 dsh-memory-md 上用真实数据实测，才发现 708 条助手发言一条都没进转写。

### 3.2 `{{...}}` 会炸整轮 —— 官方是硬抛错，不是降级

`dsh-system-prompt/lib/index.js:151-175` 的 `interpolate()` 对**每个 section 和 context** 执行：

- 未知变量 → `unknown prompt variable`
- 非法变量名 → `malformed prompt variable reference`

**抛出点在回合关键路径上**（`preStep()` / `step()`），异常会终止整轮。
更隐蔽的是 `{{cwd}}`/`{{model}}`/`{{provider}}` 官方已注册 → **静默替换**，用户文档被悄悄改写。

**两种解法**：

| 解法 | 谁在用 | 性质 |
|---|---|---|
| **变量承载**（内容放变量右值，section 文本只写 `{{var}}`） | dsh-preset-md | ⭐ **结构性免疫**（官方不二次扫描替换值） |
| **手动转义**（`{{` → `{\{`） | dsh-memory-md | 事后补救（模型看到的文本被改动） |

### 3.3 「测试绿 ≠ 生产对」的三种形态

| 形态 | 实例 |
|---|---|
| 夹具照抄错误形状 | claw-suite `test/review.test.mjs:27-28`、Hanako `memory.test.js:150` |
| 测试传了生产不传的参数 | Hanako `MAX_RETRIES=3`（测试传 `failCounts`，生产不传 → 无限重试） |
| 写了但没人调用 | Hanako 检索层 465 行（只在测试调用）、claw-suite `mainBriefText` 93 行 |

---

## 4. 给 dsh-preset-md 的吸纳清单

按性价比排序（详细排查见 `dsh-preset-md-排查与修改建议.md`）：

**必修：**

1. **加 `source.kind === 'user'` 过滤**（`src/review.mjs:44`、`src/preset.js:140`）
2. **水位改到成功后推进**（`src/preset.js:382`）

**建议补：**

3. **补 `{{}}` 端到端测试**，锁住当前的正确性（现在正确但无测试保护）
4. **压缩前 flush**（学 claw-suite `compaction/start`）
5. **清理死代码 + gitignore 补 `tmp-*.mjs`**

**可考虑采纳：**

6. **超限时"拒绝写入 + 回传当前条目 + 教模型整合"**（学 claw-suite）—— 比只提示收敛更强
7. **结构化日志词汇表**（学 claw-suite `observability`）—— 若要让日记结构化
8. **记忆索引进 `context()`**（学 dsh-memory-md 两段式）—— 拿官方去重与压缩自愈

**保持不变的（它做得好）：**

- 变量承载（`{{}}` 结构性安全）
- 超预算"请收敛"提示（不截断）
- 写盘三重保护
- 双阈值 + 陈旧锁 + pending 补跑 + 失败可见

---

## 5. 源码位置速查

| 实现 | 路径 | 形态 |
|---|---|---|
| **dsh-preset-md** | `D:\workspaces\ai\dsh-preset-md\src\` | 纯 ESM JS，9 文件 ~2517 行，139 测试 |
| **Hanako-Memory** | `D:\workspaces\dsh\DeepSeek-Harness-Hanako-Memory\src\` | TS，双平面（manager + soul 子路径） |
| **dsh-claw-suite** | `D:\workspaces\dsh\dsh-claw-suite\` | 8 包 monorepo，core 用 `.mjs` |
| **openclaw-persona** | `D:\workspaces\dsh\dsh-openclaw-persona\src\index.js` | 单文件 221 行 |
| **dsh-memory-md** | `D:\workspaces\ai\dsh-memory-md\src\` | 纯 ESM JS，11 文件 |

### 官方机制锚点

| 机制 | 位置 |
|---|---|
| `interpolate()` 严格校验 + 不重扫替换值 | `dsh-system-prompt/lib/index.js:151-175` |
| `complete` section 替换全部 section | `dsh-system-prompt/lib/index.js:352-357` |
| 空 text 的 section 被过滤 | `dsh-system-prompt/lib/index.js:112` |
| `section`/`context` 独立排序空间 | `dsh-system-prompt/lib/index.js:331`、`:344` |
| `getSectionOrder` 未知名字返回 `undefined` | `dsh-system-prompt/lib/index.js:247-249` |
| `turn-stopping` 在 error/abort 路径**不派发** | `dsh-agent-loop/lib/index.js:966-991` |
| `assistant/message` 结构 | `dsh-session/lib/types/types.d.ts:309-317` |
| `agent.inject` = `next-step` 且 `wakeup=false` | `dsh-agent-loop/lib/index.js:795` |
| 注入帧转义范式 | `dsh-agent-instructions/lib/index.js:127-129` |

---

*本文件是研究记录，不是需求。dsh-preset-md 的需求与改法见其自身 `docs/`。*
