# 记忆整理（dream / consolidation）调研：CC 官方 + 三款同类插件 + CodeBuddy

> **用途**：给没有原始对话上下文的读者（人或模型）建立判断力 —— 「定期整理记忆」这件事，
> 业界到底有哪几种做法、本插件的 `/memory-check` 借鉴了哪些、哪些是自以为借鉴其实没采用。
>
> **调研日期**：2026-10-21
> **调研契机**：给 `dsh-memory-md` 增加一个「分析全部记忆、找出重复/过期/错误」的能力
> **相关文档**：`memory-scheme-codebuddy.md`（本插件的移植来源）、`memory-research-six-implementations.md`（六款横向）

---

## 一、筛选口径

从插件市场的 `GET /dsh-market/registry`（`dsh-market/src/routes.ts:2503`）取目录。条目里的
`downloads` 是 **npm 近 30 天下载量**（`registry.ts:23` 字段注释明确这是覆盖度数据，
`null` 表示「没有 npm 包」而非 0）。目录自带 `memory` 分类，共 **269 个**；按 `downloads`
降序取前 40 作为候选池，再按「是否真的有整理/巩固机制」筛。

> ⚠️ **这个方法有系统性盲区，第一轮因此漏掉了最相关的三个实现。**
> 按 `downloads` 排序意味着：**没有 npm 包、只走 GitHub Release 分发的插件 `downloads` 恒为 `null`，
> 永远排不进前 40** —— 而「复刻 CC Dream」这类实验性插件恰恰几乎都不发 npm。
> 第二轮改为按**语义关键词**在主目录全量检索（`dream` / `autodream` / `cc-haha` / `claude-code`），
> 才找到 `dsh-cc-haha-dream`、`@klarkxy/dsh-memory`、`@stardustlc/dsh-dream`。
> **教训：评估「有没有人做过这件事」，按热度取样会系统性漏掉最贴题的实验性实现。**

第一轮深挖四个：`dsh-mneme`、`dsh-prime-memory`、`dsh-auto-memory`、`dsh-memory-palace`，
外加 **Claude Code 官方 `Dream`** 与**本插件的移植来源 CodeBuddy** 两个对照。
第二轮补充三个真正复刻 CC Dream 的实现，见 **第六·五节**；由此得出的遗漏清单见 **第六·六节**。

---

## 二、各家形态对比

| 实现 | 触发方式 | 整理动作 | 结果如何处理 | 有无手动入口 |
|---|---|---|---|---|
| **CC 官方 `Dream`** | `Auto Dream` 三重门控（24h + ≥5 会话 + 文件锁） | 四阶段：审视 → 取新信号 → 合并进主题文件 → 修剪索引 | **直接改写记忆文件** | 有（`/dream` Skill） |
| **`dsh-mneme`** | 写入阈值（条数/字符双条件 + 增量）或空闲定时 | 决策清单 `keep/merge/archive/update/conflict` + 睡眠四阶段 | **自动应用**（单决策一事务 + CAS），冲突可冻结待审 | **完全没有** |
| **`dsh-prime-memory`** | 每轮 / 阈值 / 空闲兜底 | L1 抽取 → L2 场景整合 → L3 画像 | 自动写回，软删可逆，冲突冻结 | 有（`memory_ruminate`） |
| **`dsh-auto-memory`** | 每轮沉淀 + 容量触发压缩 + 定时固化 | 合并/去重/删过期写在「折叠」提示词里 | 直接写文件，归档前校验 sha256 | 有（`memory_consolidate`） |
| **CodeBuddy** | **STOP hook（每回合结束）** | **写入时抽取**，无事后整理 | 受限子代理直接写文件 | **无整理命令** |
| **`dsh-cc-haha-dream`** | 定时（24h + 5 会话，五重门控）**+** `/dream` **+** `memory_dream` 工具 | 四阶段复刻 CC，输出 `create/update/delete/merge` | **宿主侧安全应用** + `.history/` 备份 + 重建索引 | 有（命令 + 工具） |
| **`@klarkxy/dsh-memory`** | 回合末观察 + idle（15 分钟 / 24h / ≥3 变更） | 观察 + 整理成带作用域记录 | 预览 `plan` → 人工/自动 `apply`（revision 乐观锁） | 有（`dream.run` RPC） |
| **`@stardustlc/dsh-dream`** | 安静 60s 后整理候选（每天 4 次上限） | 候选经验 → 梦境日记 | 人工采纳后才召回 | 有（说一句话即可） |
| **本插件 `/memory-check`** | **手动命令** | 规则体检（12 类）+ LLM 语义诊断（5 类） | **只出报告，不改文件** | 命令本身即入口 |

---

## 三、CC 官方 `Dream`（形态源头）

提示词原文取自 `Piebald-AI/claude-code-system-prompts`，`ccVersion: "2.1.296"`。四阶段：

```
## Phase 1 — Orient
- ls 记忆目录、读 INDEX_FILE、扫主题文件以免重复创建
## Phase 2 — Gather recent signal
- 优先找「已经漂移的记忆」（与当前代码矛盾的）
- 需要时用 grep 窄范围搜 JSONL 转录，不要全量读
## Phase 3 — Consolidate
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source
## Phase 4 — Prune and index
- 索引保持 under INDEX_MAX_LINES lines AND under ~25KB
- 每条一行、约 150 字符：`- [Title](file.md) — one-line hook`
- Demote verbose entries（索引行超 ~200 字符说明内容放错了地方）
- Resolve contradictions — if two files disagree, fix the wrong one
```

**`Auto Dream` 的三重门控**（`autoDream.ts:95-100` + 文档）：

```ts
function isGateOpen(): boolean {
  if (getKairosActive()) return false   // KAIROS 模式有自己的 dream
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}
```

通过后再过：时间闸 `minHours = 24`、会话闸 `minSessions = 5`、文件锁。
失败会**回滚锁的 mtime**，让下次会话能重试（`autoDream.ts:261-270`）；
用户手动 kill `DreamTask` 同样回滚 mtime，避免「一次被中断就永远不再做梦」。

---

## 四、`dsh-mneme`（校验机制的主要来源）

### 4.1 两套机制共用一张审计表

- **autoDream**（日间/轻量）：写入计数双条件——`overAbs = count>=阈值 || chars>=阈值` 且
  `overBase = count>=基线+阈值 || chars>=基线+阈值`，两者同时成立才触发（`dream.js:890-892`）。
  基线**持久化到审计表并在重启时播种**，且**只在 ok 轮推进**。
- **Sleep Mode**（夜间/深度，opt-in）：空闲 `sleepIdleMinutes`（默认 5）后触发，
  四阶段各自 try/catch：`conflict_resolution` → `archival_demotion`（纯规则）→
  `pattern_discovery` → `relation_completion`。

### 4.2 决策清单与校验（本插件借鉴最多的部分）

LLM 只输出结构化决策数组，`action` 取值 `keep/merge/archive/update/conflict`
（sleep 的 full 档另加 `create/supersede/differentiate`）。校验器 `validateDecisions` 的几条设计：

- **`skipInvalid`（默认 true）**：单条非法决策只跳过该条并记入 `skipped`，合法子集照常应用，
  run 记为 `degraded`。但**数量爆表 / 全部非法仍整单拒绝**——那是「模型坏了」，不是 schema 漂移。
- **短 id 前缀还原**：模型常把 36 位 UUID 回填成 8 位前缀，校验前先做唯一前缀解析，
  否则全部 unknown id 导致覆盖率闸整单拒绝。
- **`archive` 护栏按类型分级**：`preference/pattern/rejected_solution/constraint/pitfall`
  属长保留类型，除非理由命中「重复/过时」词表，否则不许归档。
- **`update` 保护期**：24 小时内新建的记忆不可 update，单轮最多 2 条。
- **每条记忆最多被 claim 一次**，未提及的自动补 `keep`。

### 4.3 反幻觉

`pattern_discovery` 阶段 LLM 给出的 `evidence` 必须与数据库真实 id **求交集**，
未通过的一律丢弃（`sleep.js:544-549`）。

### 4.4 关键缺口

**没有任何手动触发入口** —— `grep` 确认无 `memory_dream`、无 `/dream`、无 HTTP 端点，
`runDream` 唯一调用点是调度器回调。这一缺口正是本插件补 `/memory-check` 的直接理由。

---

## 五、`dsh-prime-memory` / `dsh-auto-memory`（只参考了「要不要手动入口」）

- **prime-memory**：整理内嵌在写路径（L1 抽取后立即判 `store/skip/update/merge`），
  另有 `memory_ruminate` 手动触发 L1→L2→L3。值得记的取舍是「判不了的对不自动裁决，
  停放待审」+「软删可逆」。
- **auto-memory**：容量驱动压缩（超 `noteCapacityChars` 才腾位）+ 定时固化。
  值得记的是**机械查重闸门**：写前用归一后的标题、前 3 步做确定性比对，
  命中即**拒绝写入并回吐依据**，明确「不自动合并」。

**这两个的机制本插件一条都没采用**：它们都建立在分层存储/向量/场景文件之上，
与本插件「纯 Markdown 文件即真源」的形态不兼容。只借了「该提供一个手动入口」这个判断。

---

## 六、CodeBuddy（本插件的移植来源，但没有整理功能）

### 6.1 实测结论

对 `@tencent-ai/codebuddy-code` v2.150.0 的 `dist/codebuddy.js`（约 17MB）做关键词计数：

| 关键词 | 命中 | 说明 |
|---|---|---|
| `autoDream` | **0** | 没有 |
| `蒸馏` / `巩固` | **各 0** | 没有 |
| `dream` | 5 | **全是噪音**：动画词表 `"Dreaming"`、域名 `dreamhosters.com`、MIME `vnd.dreamfactory` |
| `consolidat` | 7 | 全属 **Insights 报告**的 `at-a-glance consolidation`，与记忆无关 |
| `merge_memories` / `organize_memory` / `dream_memory` 等 | **各 0** | 无整理类工具 |

### 6.2 它真正的做法：写入时抽取

`memory_extraction_stop_hook` 挂在 **STOP 事件**（每回合结束）：

```js
this.event = eV.mb.STOP; this.priority = eV.Mg.Low
async execute(ei) { this.extractionService.extractAsync(session) }
```

`doExtract` 的门槛与执行方式：

- 新增消息 `countNewMessages < 2` → 跳过；
- 主代理本轮已往记忆目录写过（`hasMemoryWritesSince`）→ 跳过并推进游标；
- 执行者是一个**受限子代理**：只给 `Read/Grep/Glob/Write/Edit`，`maxTurns: 5`，
  提示词要求「**只用最近约 N 条消息**」，明确禁止去 grep 源码验证；
- 装载 `formatMemoryManifest(scanMemoryFiles(...))` 作为「已有记忆清单」防重复
  （本插件的后台总结也吸收了同一招）。

它的「去重 / 删过期 / 改错」**只写在那份提示词里**：

> - Update or remove memories that turn out to be wrong or outdated
> - Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

`/memory` 命令只有 `toggle`（切换 `autoMemoryEnabled` 设置），没有整理子命令。

### 6.3 与本插件共享的口径

`truncateMemoryEntrypoint` 的常量 `em = 200`（行）、`ef = 25e3`（字节），
与本插件 `MEMORY_ENTRYPOINT_MAX_LINES = 200` / `MEMORY_ENTRYPOINT_MAX_CHARS = 4e4`
同源（字符口径我们放宽到 4e4）。差别在于：**CodeBuddy 只能靠提示词提醒模型自己压缩，
本插件能用 `index-overflow` 判据确定性报出。**

---

## 六·五、补充调研：真正「复刻 CC Dream」的三个实现（第一轮遗漏）

> **为什么补这一节**：第一轮只按 `memory` 分类 + 下载量排序取样，于是漏掉了三类最相关的对象 ——
> 它们不是「同类里下载量不够高」，而是**市场目录里 `downloads` 为 `null`（无 npm 包、仅 GitHub 分发），
> 按下载量排序永远排不到前面**。这正是「按热度取样」的系统性盲区。

### 6.5.1 `dsh-cc-haha-dream`（最直接的对照：真复刻 CC-HAHA autoDream）

`https://github.com/yihefeikong-rgb/dsh-cc-haha-dream`（无 npm 包、stars 0）

它的 README 自述：复刻 [CC-HAHA](https://github.com/NanmiCoder/cc-haha) 的 `autoDream`，
`dsh-memory` 负责「随手记」，它负责「睡前整理」。**这是与我们目标重合度最高的实现**，
也是上一轮分析里完全缺失的一块。

**关键差异（都是我们没做的）**：

| 维度 | `dsh-cc-haha-dream` | 本插件 `/memory-check` |
|---|---|---|
| 触发 | 后台定时（默认 24h + 5 会话）**+** `/dream` 命令 **+** `memory_dream` 工具 | 只有手动命令 |
| 执行者 | **fork 子代理**（继承会话模型，只给 `read/grep/glob` 只读工具） | 裸 `llm.stream()` 单次调用 |
| 输出 | 动作 JSON `create/update/delete/merge` | 诊断 JSON（只报告） |
| 落盘 | **宿主侧安全应用 + 原子写 + `.history/` 版本备份 + 索引快照** | **不写** |
| 门控 | 五重（enabled / minHours / minSessions / 锁 / 冷启动守卫） | 无（手动即执行） |
| 并发 | `.dream-lock` + `.dream-lock.active` token 跨进程互斥 | 无 |

**值得注意的三个细节设计**：

1. **冷启动守卫**：从未做过梦（没有 `.dream-lock`）时**不冷启动即触发** —— 首次检查只把锁盖成「当前时刻」，
   从此刻开始计 `minHours`。避免「刚装上就立刻跑一次」。
2. **锁的 token 语义**（`src/gates.ts`）：`.dream-lock.active` 用独占创建（`open(path, 'wx')`）保存唯一 token；
   `>1h` 视为 stale 并可回收（先 rename 到隔离名再删）；**只有成功完成且仍持有 token 的调用才更新 mtime**，
   失败只释放自己的锁、不动时间戳 —— 这样失败能重试、并发不会重复跑。
3. **动作预检 + 越界防护**：`preflightActions` 整批预检通过后才开始写入，且校验 id 属于目标作用域。

**它明说的安全约束**（写进了提示词）：
> `delete 只用于:明确过时、被推翻、重复且已合并、或纯噪音。拿不准就不要删。`
> `所有 id 必须来自给定的记忆清单，且保持作用域前缀；不得猜测或越界。`

### 6.5.2 `@klarkxy/dsh-memory`（证据链最严格的一个）

npm 包 `@klarkxy/dsh-memory` v0.1.7（`downloads` 未收录，第一轮因此漏掉）。

它有 **idle Dream**（闲置约 15 分钟 + 距上次 24h + 至少 3 项变更），
但**真正值得学的是它的证据校验链和「预览/应用」分离**：

**(1) 逐字证据引用（`source.text.includes(ref.quote)`）**

LLM 输出必须带 `evidence: [{ seq, quote }]`，宿主侧逐条校验：

```js
const source = messages.find((message) => message.seq === ref?.seq);
return source && typeof ref?.quote === 'string'
  && ref.quote.trim().length >= 2 && ref.quote.length <= 400
  && source.text.includes(ref.quote) ? [...] : [];
if (evidence.length !== row.evidence.length) continue;   // 任一条对不上，整条丢弃
```

而且校验不止「引用存在」，还要求**关键字段出现在引文里**：

```js
if (subject !== 'user' && !quoted.includes(subject)) continue;
if (domain !== 'general' && !quoted.includes(domain)) continue;
if (!quoted.includes(row.key)) continue;
if (row.eventTime !== void 0 && !quoted.includes(row.eventTime)) continue;
if (context.data.aliases.some((alias) => !quoted.includes(alias))) continue;
```

还有针对「活动状态」的语义闸：判为 `completed` 时，引文里**不能**出现
`尚未|还没|计划|如果|是否|吗|[？?]`（防把假设句读成已完成），
且**必须**出现 `已经|现已|刚…完成|完成了` 之类的完成标记。

**(2) 预览与应用分离**

`previewDream` → 产出 `plan`（带 `revision`）→ `applyDream(planId, expectedRevision)`：
- `revision` 不符 → `MEMORY_CONFLICT`「梦境预览已更新，请刷新后重试」；
- `assertDreamApply` 失败 → plan 标 `stale` 并持久化，抛错；
- 应用时按**来源状态**决定新记录状态：所有来源都 `active` 才产出 `active`，
  否则产出 `candidate`（「只有全部来源已生效时，替代条目才自动生效」）；
- 新记录用 `supersedes` 记来源 id，来源置 `superseded`（**不物理删除**）。

**(3) 其他值得记的约束**

- `Do not rewrite active records in place. Do not invent preferences without quoted evidence.`
- `Do not treat novel canon or worldbook text as Memory.`
- `Expiry is a retention bound. Do not infer that a planned event completed merely because a date has elapsed.`
- 观察游标持久化 + 删除墓碑（tombstone）防重启重放旧消息。

### 6.5.3 `@stardustlc/dsh-dream`（候选经验，需人采纳）

v0.10.0。定位是「经验/反思」而非全库体检：一轮任务后安静 60 秒整理候选经验，
写进「梦境日记」等人工采纳，采纳后才能在相关任务中召回。
同项目最多合并 4 轮、每天最多 4 次、间隔 10 分钟、单次最多 1200 输出 token。
**有冷却与等待队列**（队列最多 32 轮 / 24 小时，重启可续）。

它的价值主要在**预算控制与排队**，不在于整理判据。

### 6.5.4 另一个相关但不同类的：`dsh-claude-memory`

只读桥接 Claude Code 已有项目记忆到 DSH（按 git 仓库根解析、注入前脱敏、按需检索），零依赖。
**它不做整理**，但说明了「CC 记忆目录格式」在 DSH 生态里是事实标准。

---

## 六·六、由此得到的遗漏清单（诚实版）

第一轮的分析有**系统性盲区**：按 `memory` 分类 + `downloads` 排序取样，
把「无 npm 包、仅 GitHub/Release 分发」的实现全部排除了。补查后，本插件**确实遗漏**了以下设计：

| 遗漏点 | 来源 | 严重度 | 说明 |
|---|---|---|---|
| **子代理执行**（只给只读工具，可对照代码库验证漂移记忆） | cc-haha-dream | ~~高~~ → **改用主模型复核补上** | 见下方「处置结果」 |
| **逐字证据引用 + 关键字段必须出现在引文里** | klarkxy | ~~高~~ → **已补** | 见下方「处置结果」 |
| **预览/应用分离 + revision 乐观锁** | klarkxy | 中 | 我们只出报告不改文件，所以暂不需要；但若将来加「自动应用」，这是必抄的设计 |
| **冷启动守卫** | cc-haha-dream | 中 | 若将来加自动触发，首次不应立刻跑 |
| **跨进程锁 token + stale 回收** | cc-haha-dream | 中 | 同上，自动触发才需要 |
| **`.history/` 版本备份 + 索引快照** | cc-haha-dream | 中 | 我们「不改文件」所以没有；若改，这是底线 |
| **候选状态（candidate）与来源生效性推导** | klarkxy | 中 | 「只有全部来源 active 才产出 active」是很细的正确性设计 |
| **删除墓碑 + 观察游标** | klarkxy | 低 | 防重启重放，我们无「观察」概念 |

### 处置结果（2026-10-22）

**① 逐字证据引用 —— 已补。** 结论必须带 `quote`，宿主校验 `fullBody.includes(quote)`。

关键实现细节：**区分「编造」与「被我截断」** —— 喂给模型的正文只有 600 字，
校验拿的是完整正文。引文不在完整正文里才算编造；落在 600 字之后是**我们自己截的**，
保留并标记 `quoteOutsideExcerpt`。不区分会把「记忆太长」误判成「模型不可信」，
把好结论一起扔掉。

**② 子代理验证 —— 没有照搬，改用「主模型复核」。**

没有引入子代理，理由是这个成本结构不成立：`cc-haha-dream` 为此要处理父 agent 选取、
provider 可用性、工具不支持时降级，超时默认 15 分钟；而我们要判的东西里，
只有「是否漂移」需要看代码库。

改成的方案：体检跑完后用 `agent.followup()` 把**待复核清单**投回主模型 ——
它本来就有 `read`/`grep`/`glob`，而且已经处在用户意图的上下文里。

三道筛选，避免把负担甩给主模型：
- 只投 `outdated` / `wrong`（`duplicate`/`mergeable`/`vague` 读记忆本身就能判断）；
- 正文里必须出现**可检索锚点**（反引号标识符、路径、版本号、包名），
  否则「去核实」会退化成无目标的全库 grep；
- 指令里写死「只核实、不改文件」「查不到就说无法验证」。

投递可选（设置项 `checkupReviewByModel`，默认开），失败不影响报告。

**仍未补的**：其余六项（预览/应用分离、冷启动守卫、跨进程锁、`.history/` 备份、
候选状态推导、删除墓碑）都属于「从只读报告扩展到自动改写」才需要的基础设施，
当前形态下不构成缺陷。

---

## 七、本插件 `/memory-check` 的取舍

### 7.1 采纳

| 点 | 来源 |
|---|---|
| 反思式整理的整体形态、报告结构 | CC `Dream` |
| 相对日期 → 绝对日期 | CC `Dream` Phase 3 / CodeBuddy `when_to_save` |
| 索引是指针、一行约 150 字 | CC `Dream` Phase 4 |
| 单条非法丢弃、合法子集保留 | `dsh-mneme` `skipInvalid` |
| 输出 id 与真实条目求交 | `dsh-mneme` evidence `intersect` |
| 结构化决策清单 + 严格校验 | `dsh-mneme` consolidation prompt |
| `llm.stream` + `finish.reason.kind` 判终态 | 官方 `/compact` + 本项目 `summarize.mjs` |

### 7.2 明确不采纳

- **自动应用决策**：与「记忆是人工可读可改的 Markdown、不自动改写」的既有取舍冲突。
- **`Auto Dream` 三重门控**：那是自动后台触发才需要的东西，手动命令不需要。
- **向量聚类 / 分层存储 / 归档状态机**：本插件是纯文件、无嵌入，文件即真源。
- **mneme 的动作集**：它的动词是「改数据库」，本插件只出报告，动词对不上。

### 7.3 自研（上面都没有）

- **二元组 Jaccard 标题相似度**（阈值 0.62）：参考实现全部没有相似度阈值。
- **借名检测（`name-mismatch`）**：文件名语义与 `name` 语义零交集。三款同类插件
  与 CodeBuddy **都没有**「标题与内容对不上」这类检查（调研中明确记为「未找到」）。
- **逐字重复（`exact-duplicate`）**：整段逐字比对，比相似度判据保守。
- **索引死链（`dangling-index`）**、**索引超限（`index-overflow`）**：文件式记忆特有。
- **「语义分析未跑成时绝不说『没有问题』」**：实现过程中自审发现自身 bug 后补的。

---

## 八、给后来者的三条判断

1. **先分清「自动后台巩固」与「手动体检」**。前者需要门控、审计表、回滚、并发串行化，
   代价极高（mneme 为此建了三张表和一套队列）；后者只需一个命令和一次只读分析。
   本插件要的是后者。
2. **别把「诊断类别」和「执行动作」混为一谈**。mneme 的 `merge` 是会改数据的动词；
   本插件的 `duplicate` 是一个**结论**。照搬动作集必然要把写回逻辑一起搬进来。
3. **抄配置项之前先核对调用点**。mneme 至少有四处文档与实现不符
   （`sleepPatternLookbackDays` 是死配置、「关系补全」实际无 LLM 等），
   照文档抄会直接抄错。
