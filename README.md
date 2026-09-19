# dsh-memory-md

纯本地 Markdown 记忆插件（DSH）。助手通过 `memory_md_*` 工具把值得长期保留的内容写进 `~/.dsh/memory-md/`，跨会话记住你。

记忆索引会在**回合开始时作为上下文快照注入**，所以助手不必先调工具就知道有什么记忆。

---

## 一、设计要点

### 1. 注入分两段：常量进提示词，读盘的进快照

记忆文本按**是否读盘**分两类，走不同通道：

| | 内容 | 通道 | 为什么 |
|---|---|---|---|
| **协议 + 行为纪律** | 索引是什么、怎么写记忆（先查再写、删过期、按主题组织、四类型判据……） | `systemPrompt.section()`（系统提示词） | **纯常量**，逐字节恒定 → 前缀 KV Cache 始终命中，**不产生新消息** |
| **索引** | 用户级 + 项目级 `MEMORY.md` | `systemPrompt.context()`（上下文快照） | **读盘**、随记忆变化 → 进 section 会让整个前缀缓存失效 |

**两个方向的红线都成立：**

- **读盘的内容绝不允许进 `section()`** —— DSH 每个 step 都重新装配系统提示词（`dsh-agent-loop` 的 `systemPrompt.assemble()`）。任何随文件变化的 section 都会让**整个前缀**的 KV Cache 失效（含全部历史）。
- **常量不该混进 `context()`** —— 快照是**追加而非替换**。常量一旦和读盘内容捆在同一条快照里，读盘内容一变就把常量**整段重发**，而重发的那份**永久留在会话历史里**。常量放 `section()` 每步都在，但逐字节恒定 → 缓存命中，不产生新消息，**严格更优**。

```js
// 协议 + 纪律：静态常量，写死在提示词里
ctx.systemPrompt.section({ name: 'memory-md:protocol', order: 950, text: () => memoryPromptText() })

// 索引：每次装配重读；空串则不贡献
ctx.systemPrompt.context({
  name: 'memory-md:index',
  order: 10_000,
  text: () => renderMemoryIndex(...),
})
```

实测体量：常量段 **2638 字符**（协议 230 + 纪律 2406），索引快照约 **1478 字符**。

> **一段走过的弯路（已修正）**：行为纪律曾经被拼进 `renderMemoryIndex()` 的产物，与索引同走 `context()`。结果是规则一字未改，却因为和读盘的索引捆在同一条快照里，**索引一变就带着 2400 多字整段重发** —— 等于把常量的缺点（重发）和动态内容的缺点（耦合）都占了。当时给的理由是「让模型读到『有哪些记忆』的同时读到『该怎么对待』」，但那是个**读者便利**的考虑，代价却由每一轮请求承担。CodeBuddy 的原版犯同一个错（把规则与 `## Current MEMORY.md contents` 拼成一整块 `<memory>` 每次全量注入），不该照搬。

早先把两段**都**放进 `context()` 时问题更严重：协议文本跟着每次记忆变化重发。

### 行为纪律的内容与来源

规则文本（`MEMORY_RULES`）吸收自 CodeBuddy 的记忆提示词，**只吸收适用于 DSH 的部分**：

- **吸收**：按主题而非时间组织、更新或删除过期/错误记忆、**写前先查避免重复**、用户明确要求就立刻办、用户纠正了从记忆里说出的说法必须改掉、写前先核实。附正面清单（什么值得存）与负面清单（什么不该存）—— 两者成对，只给约束不给目标等于没给规则。
- **吸收（typed 路径）**：四类记忆各自的「何时写 / 怎么写 / 为什么」（`## Types of memory` 的 `<when_to_save>` / `<how_to_use>` / `<body_structure>`）、「记忆不等于当前事实」（`## Before recommending from memory`）、「用户说别用记忆时当作空」（`## When to access memories`）。
- **排除**：依赖 CodeBuddy 具体工具特性的说法（`write to it directly with the Write tool`、`Use the Write and Edit tools` —— 我们的模型**不能传路径**，写盘由插件走 Host 侧 fs）；grep `*.jsonl` 会话转录（DSH 的会话日志是 `session.jsonl.zstd` 压缩格式，直接 grep 不可行）；`<examples>` 逐条照搬（那些是英文通用编码场景，与中文 DSH 语境错配）。

**为什么不能只放工具 description**：这是**事前纪律**，不是工具用法。模型得在**决定要不要写**的时刻就知道「先查再写」，等它已经调 `memory_md_save` 时才看到就晚了。工具 description 只适合放「这个工具怎么调」。


**没有索引时快照为空，但纪律照常在。** 纪律是**常量**、走 `section()`，它不可能
依赖"磁盘上有没有索引"——所以一条记忆都没有时，提示词段里仍有纪律，只是
`context()` 那份快照返回空串（不注入任何东西）。这是刻意的：纪律讲的正是
"什么时候**该去写**记忆"，恰恰在空库时最需要它。

**后台总结也要防重复。** 后台总结是**独立 LLM 调用**，它看不到注入快照（快照进的是主对话）。所以：

1. `SUMMARY_SYSTEM` 里有一份防重复规则：告诉它**看不到**记忆库、只写本段对话里新出现的明确事实、宁可漏记也不要重复记；并明确 `<memory-index>` 块是**已有记忆的索引**、不是用户说过的话 —— 否则它会据此再写一条重复记忆（自我喂养）。
2. **消息末尾附上「已有的记忆」清单**（`memoryManifestFor()`）—— 这是**机械保障**，不是叮嘱。清单里每条带 `[scope]` 前缀、类型、文件名、年龄与描述，模型据此判断"是不是已经有同一件事的条目，该覆盖哪个文件"。

> 只叮嘱不喂清单是没用的：模型无从知道已经有什么。这一招吸收自 CodeBuddy 的 `buildExtractPrompt()` —— 它把 `formatMemoryManifest(scanMemoryFiles(dir))` 作为 "## Existing memory files" 一节喂给抽取子代理。

**索引超过 1 天会带年龄属性。** 索引是一份**快照**，记的是写下那一刻的记忆库状态。所以旧索引的标签会多一个 `updated` 属性：

```xml
<memory-index scope="global" updated="10 天前">
```

当天/昨天的不附（不存在"过期"问题，挂了只是噪音）。机制吸收自 CodeBuddy 的 `memoryFreshnessText()` —— 那边是注入时附一句 *"This memory is N days old … Verify against current code before asserting as fact."*；这里改成标签属性，因为它天然属于这份索引，模型不必再读一句话去对应它是说给谁听的。规则段里有配套的行为要求（见下）。

**去重是白拿的。** `dsh-agent-loop` 的 `RuntimeContextProjection.project()` 会比对上一次保留的快照文本，**内容未变则不产生任何消息** —— 所以「索引变了才注入、没变就不重复注入」由 loop 负责，插件不需要自己做跳过机制。

**索引带确定性标签。** 每份索引用 `<memory-index scope="global|project" cwd="…">` 裹住，模型不必靠上下文猜这段文本的边界和作用域：

```xml
<memory-index scope="global">
- [用户偏好](memory/user_x.md) — 用中文回复
</memory-index>
```

注入的**只有索引**，不含分类文件全文；模型命中描述后自行读原文。

**⚠️ 注入内容会被官方二次处理，`{{...}}` 必须先中和。** 官方 `interpolate()` 把注入文本里的
`{{name}}` 当作**提示词变量**严格校验（变量名须匹配 `/^[a-z][a-z0-9_]*$/`），且**对
`context()` 和 `section()` 都生效**。所以记忆描述里只要出现 `{{挖空}}`、`{{.Server.Version}}`
这类合法模板语法，就会在 `systemPrompt.assemble()` 里抛错 —— **整个回合失败**，
而且**每轮都失败、永久锁死该工作区**（agent 无法自救，只能手工改 `MEMORY.md`）。

修法是在注入边界做相邻花括号转义（`{{` → `{\{`，任意长度连续花括号都处理），
语义不变、原文可还原。`inject` 套件有回归断言，另有一条**防未来**断言：
协议段那个常量里不允许出现 `{{`。

### 2. 轮末总结在**后台异步**跑，不打扰对话

早先的实现挂在 `agent/turn-stopping`，往主对话 `inbox.append('next-step')` 塞一条 "Before this turn closes…" 的提醒。两个问题：**它显示在对话里**，而且逼主模型再跑一步。

现在改成：轮末起一次**独立的、无工具的 LLM 调用**（`ctx.llm.stream()`），由它总结做了什么、有什么值得沉淀，然后**插件自己**写记忆文件和日志文件。主对话全程不参与、不显示任何东西。

为什么不用子代理：`ctx.subagents.start()` 会创建真正的子 agent（有自己的 session、进会话列表、能调工具），还会再次触发 `agent/turn-stopping` —— 递归风险。这里只需要一次模型调用。

**总结范围是「上次成功总结之后」，不是「本轮」。** 每个会话维护一个游标，**只在成功后推进**。回合崩了、内容不足、调用失败时游标原地不动，下一轮自动补上。

> 这条是踩坑换来的：早先只取最后一个 `turn/start` 起的事件，于是任何"没写成"的回合内容**永久丢失**。
> 真实事故：20 分钟的源码研究与实测，日志里一个字都没有（turn 以 error 结束 + 另一轮太短，
> 两者的工作就此出局，后面的回合用切片也看不到）。连续失败 3 次才放弃该段，避免游标永久卡死。
>
> **进程重启会重置游标**（锚定在上一轮），所以重启前丢失的那段不会自动补回 ——
> 这是刻意取舍：宁可丢一段，也不要每次重启都把整个会话历史重刷一遍日志。

### 3. 不冒充人设，也不让模型拼路径

`systemPrompt.section()` 里有一个是**主会话的人设槽位**（`order: 0`）。插件往那里塞 `You have a persistent memory system…` 等于冒充 DSH 给模型立规矩 —— 这条仍然成立。

本插件只用 **950** 这个空档（文件引用段 900 之后、工具说明段 1000+ 之前），且内容仅限**解释自己的东西**：索引长什么样、怎么读、边界在哪。角色设定与行为准则仍归 DSH 官方。

记忆根目录固定在 `<dshHome>/memory-md`，路径**全部由插件计算**，工具参数里没有 `path` / `dir`。

早先版本的提示词只给裸文件名（`user_role.md`、`MEMORY.md`），模型只能用自己的 cwd 补全，结果把文件写进了工作区：

```
D:\workspaces\ai\dsh-memory-md\MEMORY.md       ← 污染工作区
D:\workspaces\ai\dsh-memory-md\memory_test.md
```

---

## 二、工具

**五个工具**，**写入规范**写在 description 里；**记忆是什么、该怎么对待记忆**归提示词段的协议与快照里的行为纪律。

### `memory_md_save`

保存 / 更新一条记忆。插件负责路径与 `MEMORY.md` 索引，模型只提供内容。

| 参数 | 必填 | 说明 |
|---|---|---|
| `scope` | ✅ | `global`（跨项目）/ `project`（当前工作区） |
| `type` | ✅ | `user` / `feedback` / `project` / `reference` |
| `name` | ✅ | 简短标题 |
| `description` | ✅ | 一句话，说明**什么时候**这条记忆有用 —— 决定它日后能否被找到 |
| `content` | ✅ | Markdown 正文 |
| `file` | | 覆盖已有的某个文件；省略则按 type + name 生成 |

同一文件重复保存 = 就地更新，索引条目不会重复。

### `memory_md_search`

搜索记忆内容，返回匹配行及其文件。用窄词（报错信息、文件路径、函数名）而不是宽泛关键词。

### `memory_md_read`

省略 `file` 则列出所有记忆（标题 / 类型 / 描述）；给了 `file` 则读全文。

### `memory_md_forget`

**删除**一条记忆 —— 正文文件与索引行一起删。用在三种情况：用户明确要求忘记某事；
这条记忆被证明是错的；它已经过期、不再适用。

| 参数 | 必填 | 说明 |
|---|---|---|
| `scope` | ✅ | 从哪个存储里删 |
| `file` | ✅ | 要删的文件名（先用 `memory_md_read` 列表或 `memory_md_search` 拿到确切名字） |

**这是不可逆操作**，所以：

- 文件名对不上时**报错**，而不是猜一个最像的删掉；
- 删除后**回报被删条目的标题与描述**，用户和模型都看得到究竟删了什么；
- 重复删除是幂等的（返回 `removed: false`，不抛错）；
- 接口只会**删单条**，没有「清空全部」这种批量入口。

内容需要修正、条目本身仍成立时，应当用 `memory_md_save` 传同一个 `file`
**覆盖更新** —— 那是「纠正」，不是「忘记」。

### `memory_md_journal`

追加到当天的工作日志（`记忆设置 → 工作留痕` 打开时才有内容）。

**日志属于当前工作区** —— 它记的是「这个项目里做了什么」，所以需要打开一个工作区；没有全局日志。跟具体项目无关的结论应该写成记忆（`memory_md_save`），而不是流水账。

**一次调用 = 一个带时间戳的批次**，每条 **1-3 句**，写清「做了什么 + 得出什么结论」：

```markdown
# 2026-09-13

## 04:27:56
- 修了分隔符 bug —— 根因是并发写共用同一个临时文件名，后写的覆盖先写的，改成随机后缀。
- 补了并发回归测试：8 次并发写入全部保留。

## 04:27:57
- 加了后台总结：轮末起独立 LLM 调用，写记忆与日志，不往主对话塞消息。
```

**为什么不是一句话流水账**：结论才是事后翻看时真正要找的东西。
「研究了 X 的实现方式」看过等于没看；「X 用的是双块折叠，没有 section，所以不吃缓存优化」
才能还原当时的判断。**判定标准见 `docs/plan.md` 第 7.3 节**（正面清单 + 负面清单）。

同一天分几次写的，一眼可见 —— 不必靠条目顺序去猜。

参数：`notes`（字符串数组，一次提交多条）或 `note`（单条便捷写法）。
一次能说清的就别调多次，插件会把它们归到同一批次。

> **通常不需要手动调它。** 轮末的**后台总结**会自动把本轮做了什么写进日志（见第一节第 2 点）。
> 这个工具留给需要精确补记的场合。

日志是**只写不读**的：不参与索引、不出现在 `memory_md_search`、也不会被 `memory_md_read` 列出。它记录「做了什么、结论是什么」供你事后翻看；要让某件事影响未来的对话，用 `memory_md_save`。

开关关闭时静默跳过（返回 `written: false`），不报错打断对话。

返回值里三个字段含义不同，别混：

| 字段 | 含义 |
|---|---|
| `stamp` | 本批次的时间戳 `HH:MM:SS` |
| `entries` | **本批次新增**的条目数 |
| `total` | 当天**累计**条目数 |

> 早先只有一个 `entries`，返回的却是累计值 —— 连写两条时看到 `2` 会误以为「一次写了 2 条」，进而误判成丢数据。拆开后就没有歧义了。

### 写入是原子的

日志采用「读 → 拼接 → 原子替换」，临时文件名带随机后缀。这是必须的：早先用 `<path>.<pid>.tmp`，同进程内两次写会共用同一个临时文件，后写的覆盖先写的再各自 rename —— **条目静默消失**。`tools` 套件里有对应的回归断言。

### 时间戳的同秒问题

同一秒内多次调用会产生名字相同的小节（如两个 `## 04:27:57`）。这不会丢数据，只是两个小节并排 —— 批次边界仍然可读。要更细就得带毫秒，但那是噪音，不值得。

---

## 二·五、写入频率

两条路径并存，互不重复：

| 路径 | 时机 | 谁决定 |
|---|---|---|
| `memory_md_save` 工具 | 模型自己判断该记了 | 模型 |
| **后台总结** | 每轮结束时兜底 | 插件 |

### 后台总结怎么做的

监听 `agent/turn-stopping`，在轮末**起一次独立的、无工具的 LLM 调用**
（`ctx.llm.stream()`），由它总结本轮做了什么、有什么值得沉淀，然后**插件自己**
写记忆文件和日志文件。主对话全程不参与、不显示任何东西。

为什么不用子代理：`ctx.subagents.start()` 会创建真正的子 agent（有自己的
session、进会话列表、能调工具），还会再次触发 `agent/turn-stopping` —— 递归
风险。这里只需要一次模型调用，不是 agent，所以不会递归。

**带来两条必须自己处理的保障**（因为不走子代理，官方不为这次调用兜底）：

- **超时** —— `llm.stream()` **没有内置超时**。不兜的话 provider 一挂起，
  内部状态永不复位，**游标从此卡死、再也不写日志**（比丢一段严重）。故配 60s 超时。
- **`{{...}}` 中和** —— 官方 `interpolate()` 把注入文本里的 `{{...}}` 当**提示词变量**
  严格校验，且对 `context()` 与 `section()` 都生效。记忆里含 `{{` 会**抛错炸整轮**，
  并**永久锁死那个工作区**（每轮都炸、agent 无法自救，只能手工改 `MEMORY.md`）。
  故在注入边界把相邻花括号转义（`{{` → `{\{`，语义不变、原文可还原）。
  dsh-mneme 被 issue #40 追过同一个问题。

> **旧实现是反面教材。** 它往主对话 `inbox.append('next-step')` 塞一条
> "Before this turn closes…" 的提醒：**显示在对话里**，还逼主模型再跑一步；
> 且投递时漏了 `source`，loop 在轮次收尾路径上读 `message.source.kind` 直接抛
> `Cannot read properties of undefined (reading 'kind')`，**整个回合失败**。
>
> 那段代码（`src/remind.mjs`）已删除。`regression-kind` 套件现在断言
> `summarize.mjs` 里**没有** `inbox.append` / `createUserMessage`，且真跑一次
> 轮末时 `inbox.append` 一次都没被调用 —— 只要有人再把"提醒主模型"加回来，
> 测试立刻变红。

### 防重复与防卡死（当前实现）

> ⚠️ 早先这里描述一套**已删除**的「轮末提醒」机制（`remindedTurns` 按 turn 记账、
> 声称 `remind` 套件覆盖）—— 那套机制连同 `src/remind.mjs` 一起删掉了，
> 这段描述却留了下来，与上面「旧实现是反面教材」自相矛盾。现已改成描述实际生效的机制。

后台总结**不会往对话里塞任何东西**（无提醒、不逼主模型再跑一步），
所以不存在「模型看到提醒 → 不写记忆 → 无限追加」这个循环。
真正要防的是**重复总结**与**卡死**：

1. **游标只在成功后推进** —— 失败 / 内容不足时游标原地不动，下一轮把这段一起带上
   （跨回合补偿）。连续失败到 `MAX_SUMMARY_ATTEMPTS`（3 次）才放弃该段，
   否则一段坏内容会让游标永久卡住。
2. **主模型本轮写过记忆 → 不重复总结** —— 只认**写**操作
   （`memory_md_save` / `memory_md_journal`），只读的 `search`/`read` 不算。
   判据**只看本轮**：用累积段会让一次调用永久污染后续所有轮。
3. **超时 + 陈旧锁** —— `SUMMARY_TIMEOUT_MS`（60s）兜住 LLM 调用本身；
   `RUNNING_STALE_MS`（5 分钟）兜住**任何**挂起路径，防 `running` 永久置位。
4. **会话结束 force 触发** —— `agent/disposed` 时绕过门槛与防抖写一次，
   否则最后一段对话没有「下一轮」可以补。
5. **失败可见** —— 失败写进 `error.log`（与 `settings.json` 同级），**不进 `.journal/`**。

全程 try/catch —— **任何异常都不得影响轮次收尾**。

---

## 三、安装

以 **link 方式**装进 DSH 的 web profile。

profile 位置：`<dshHome>/profiles/web/`（Windows：`C:\Users\<你>\.dsh\profiles\web\`）

### 1. 建链接

```bash
cd ~/.dsh/profiles/web/node_modules
cmd //c "mklink /J dsh-memory-md D:\workspaces\ai\dsh-memory-md"
```

Windows 上必须用 **junction**（`mklink /J`）。Git Bash 的 `ln -s` 会退化成**复制目录**，改了源码不生效。建完用 `test -L` 确认。

### 2. 登记到 profile

`~/.dsh/profiles/web/package.json` 两处：

```jsonc
{
  "dependencies": { "dsh-memory-md": "link:D:/workspaces/ai/dsh-memory-md" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-memory-md" ] } }
}
```

### 3. 安装并重启

```bash
cd ~/.dsh/profiles/web && pnpm install
```

然后**重启 dsh**（Host 半是 bundle 行插件，进程启动时装载）。

### 4. 验证

```bash
node D:/workspaces/ai/dsh-memory-md/test/run.mjs
```

---

## 四、目录结构

记忆根目录固定，**不在任何项目目录内**：

```
~/.dsh/memory-md/                    # Windows: C:\Users\<你>\.dsh\memory-md\
├── settings.json                    # 插件设置
├── error.log                        # 错误日志（与设置同级，排查看这层）
├── global/                          # 用户级（跨项目）
│   ├── MEMORY.md                    # 索引（插件维护，唯一入口）
│   ├── memory/                      # 记忆正文
│   │   └── user_xxx.md
│   └── .journal/                    # 留痕（默认关）
│       └── YYYY-MM-DD.md
└── {slug}/                          # 项目级（结构同上）
    ├── MEMORY.md
    ├── memory/
    │   ├── feedback_aaa.md
    │   └── project_bbb.md
    └── .journal/
```

**索引在作用域根，正文在 `memory/` 子目录**，日志在 `.journal/` —— 三者同级。
这样作用域根一眼看清结构，`memory/` 与 `.journal/` 也彼此对称。
索引里的链接相应带子目录：`- [数据库端口](memory/reference_db.md) — …`。

> **从旧版升级（正文曾平铺在作用域根）**：跑一次迁移脚本 —— 这是**一次性运维动作**，
> 不是插件运行时行为（新写入本来就会落在正确位置）。
>
> ```bash
> node scripts/migrate-memory-layout.mjs --dry-run   # 先看会做什么
> node scripts/migrate-memory-layout.mjs             # 实际执行
> ```
>
> **改了目录结构但还没重启 DSH 时，旧进程仍会往旧路径写新文件** ——
> 所以**重启后要再跑一次**，把这段时间散在作用域根的文件收进去。
> 脚本幂等：已搬过的不会再动，没得搬时直接报「无事可做」。
>
> 安全保证：只搬带**已知 `type:`** frontmatter 的真记忆（别的文件一律不动），
> 目标已存在则**跳过并报告，绝不覆盖**，只 `rename` 不改内容。跑前建议先备份。

`{slug}` 由工作区绝对路径压缩而来（盘符与分隔符转 `-`、全小写）：

```
D:\workspaces\ai\dsh-memory-md  →  d-workspaces-ai-dsh-memory-md
```

---

## 五、记忆文件格式

```markdown
---
name: 数据库端口
description: 本地数据库跑在 5433
type: reference
---

正文。feedback / project 类型建议写成：规则或事实，然后 **Why:** 与 **How to apply:** 两行。
```

索引 `MEMORY.md` 由插件维护，一行一条，**超过 200 行会被截断**（只影响读取时的截断，文件本身不动）：

```markdown
- [数据库端口](memory/reference_db.md) — 本地数据库跑在 5433
```

---

## 六、设置

设置 → **记忆设置**：

| 项 | 默认 | 说明 |
|---|---|---|
| 启用记忆 | 开 | 关掉后不注入上下文快照、拒绝保存、不做后台总结；读与搜索仍可用 |
| 工作留痕 | 关 | 是否允许写日志（只写不读）。后台总结与 `memory_md_journal` 都受它控制 |
| 触发轮数 | 2 | 累积够这么多轮就跑一次后台总结。与「触发字符数」**任一达标即触发** |
| 触发字符数 | 2000 | 这一段新增内容够长也触发一次。单条很长（如一次长分析）时不必等够轮数 |
| 在这些预设下停用 | 空 | 一行一个 preset id，支持 `*` 通配（如 `presetmd-*`）。这些预设里的对话不读也不写全局记忆 |

> 两个阈值**清空即用默认值**（服务端归一化兜底）；填非正数也回落默认，
> 不会静默夹到下限。改动点「保存」后生效。

### 预设级停用

本插件挂在 **host 平面**，默认对所有 agent 生效 —— 包括官方四个预设。
但某个预设可能**自带独立记忆**（跟着预设走的人格记忆），那时全局记忆必须整体让位，
否则两套记忆同时生效、互相干扰。

`disabledPresets` 就是为此。命中后**三条入口全停**：

| 入口 | 行为 |
|---|---|
| 五个 `memory_md_*` 工具 | 直接拒绝并说明原因 |
| 后台总结 | 不跑（不写记忆、不写日志） |
| 记忆注入 | 不注入协议段与索引快照 |

**为什么连读也停**：只拦写会让 agent 读到一个它不该依赖的记忆库，
于是回答里混进别的项目的上下文 —— 比完全不生效更难排查。

判定依据是 `session.header.agentPreset`（durable，随会话保存）。
没有 preset id 时永不匹配，即**默认全局生效** —— 官方预设不受影响。

> **为什么不做成「只在某预设下生效」的白名单**：那会让新装的预设默认没有记忆。
> 「默认有、特定预设退出」更符合直觉，漏配时也只影响那一个预设。

设置页有**开关 + 两个触发阈值 + 四条固定路径**（记忆目录、用户级目录、设置文件、错误日志），
外加预设停用名单。改动**点「保存」才生效**（攒草稿，不即时提交）。
设置存 `<dshHome>/memory-md/settings.json`。

**刻意不显示任何与会话有关的东西** —— 不列条目、不显示记忆卡片与计数、
不显示项目级目录或留痕目录。原因：设置页是全局页面，拿不到「当前会话」，
Host 半只能退回 `sessions.list()` 去猜工作区，而官方文档明确该列表是
**创建顺序** —— 于是永远返回最老的会话，**切换会话后界面仍显示上一个会话的
路径**。猜错的路径比不显示更糟，所以整块去掉。

---

## 七、开发

```bash
node test/run.mjs    # 跑全部 15 个测试套件
```

| 套件 | 覆盖 |
|---|---|
| `differential` | 截断逻辑与 CodeBuddy 2.150.0 真实 bundle 逐字节比对 |
| `load` | 按**包名**装载插件（与真实 loader 一致），确认工具与两段式注入注册 |
| `paths` | 路径解析到 DSH 用户目录，不落工作区 |
| `routes` | HTTP 接口：**只给与会话无关的路径**、内容接口已移除 |
| `client` | client 半依赖白名单与注册契约 |
| `empty-state` | 设置页不显示条目、卡片、计数与会话相关路径 |
| `inject` | 两段式注入：索引标签、只注入索引、截断、协议不进快照 |
| `summarize` | 后台总结：解析、写记忆与日志、开关与异常隔离 |
| `preset-exclude` | 预设停用名单：读写日志全拦 |
| `regression-kind` | 从真实会话日志取证：缺 source 会崩回合 |
| `schema` | 工具 schema 过 DSH **真实的** `assertSupportedJsonSchema` |
| `tools` | 工具行为：写入位置、索引维护、越界拒绝 |

### 代码结构

| 文件 | 作用 |
|---|---|
| `src/index.js` | Host 半：注册工具 + 两段式注入 + HTTP 接口 |
| `src/tools.mjs` | 五个记忆工具的实现与说明书 |
| `src/inject.mjs` | 注入：`MEMORY_PROTOCOL`（提示词段）+ `renderMemoryIndex`（快照） |
| `src/summarize.mjs` | 轮末后台总结：独立 LLM 调用，写记忆与日志 |
| `src/schema.mjs` | schema 转换（不用 `defineTool`，见下） |
| `src/routes.mjs` | HTTP 接口 `/memory-md/api/*` |
| `src/settings.mjs` | 设置读写 |
| `src/store.mjs` | **共享写入原语**：原子写、记忆正文、日志追加、索引行、错误日志 |
| `src/context.mjs` | 路径解析 |
| `src/codebuddy-port.mjs` | 截断与 frontmatter（CodeBuddy 移植） |
| `client/client.js` | 设置页（`settings.section`） |

### ⚠️ 为什么顶层不声明 `inject: ['webServer']`

cordis 的 `inject` 是**必要依赖**：依赖未就绪时 fiber 停在 INACTIVE，**`apply()`
根本不会执行**（实测：缺 webServer 时 `apply()` 不跑，没有 inject 声明的照常跑）。

而 `webServer` 只由 **dsh-web-app** bundle 提供（其 `cordis.patch.yml:136` 插入
`dsh-host-webserver`）——`dsh-base`、`dsh-headless`、`dsh-acp-app` **都不含**它。

所以把 `webServer` 写进顶层 `inject` 的后果是：在 headless / acp profile 下，
插件**整体静默失效** —— 不只是设置页没有，而是**五个记忆工具与两段式注入
全部不注册**，且不打任何警告，排查时完全看不出原因。

因此本插件**分层**：

| 能力 | 依赖 | 缺 webServer 时 |
|---|---|---|
| 五个记忆工具 | `ctx.get('tools')` | ✅ 照常注册（取不到只 warn） |
| 两段式注入 | `ctx.inject(['systemPrompt'])` | ✅ 照常生效 |
| 后台总结 | `ctx.inject(['llm'])` | ✅ 照常运行 |
| 设置页路由 | `ctx.inject(['webServer'])` | ⛔ 只有它不注册 |

`load` 套件有一条**防回归**断言：`mod.inject` 必须为空数组 —— 谁再把
`webServer` 提升成整个插件的准入门槛，测试立刻变红。

### ⚠️ 为什么不用 `defineTool`

`@deepseek-ai/dsh-tools` **不在 profile 的可解析范围内**（profile 只暴露 `cosmokit` 与 `schemastery`），插件的 `import` 必然失败。

好在 `ctx.tools.register()` 要的本来就是**纯 JSON Schema**（内部调 `assertSupportedJsonSchema`，不是 spec 转换器），所以 `src/schema.mjs` 自己做转换。两个硬性要求：

- 可选字段必须**完全不写 `required`**；写 `required: false` 会被拒绝
- `required` 只能出现在**对象根**，属性节点上带着它会被拒绝

`schema` 套件用 DSH 真实的校验器验证这两点，而不是靠约定。

### 与同机其它插件的关系

同机还装着 `dsh-preset-md`（伙伴设置），它也占用 `settings.section`。两者是**并列的两页**，互不替换：slot id 不同、各插各的 `<style>`（前缀 `.mmd-` vs `.pmd-`）、不共享模块。

样式令牌与参数行布局沿用 `dsh-preset-md` 的约定 —— 两个页面并排时不该长得像两个产品。这是刻意的视觉对齐，不是代码复用。

### ⚠️ client 半不能引用已消失的包

**真事故**：两个设置页同时变成「裸 HTML」。

根因是两者的 client 都 `require('@deepseek-ai/dsh-client-ui-primitives')`，
而该包在当前 DSH 版本里**已不存在**（`find` 全盘无结果，`dsh/package.json` 也未提及）：

```
FAIL @deepseek-ai/dsh-client-ui-primitives   MODULE_NOT_FOUND
OK   @deepseek-ai/dsh-client-ui-settings
```

`dsh-preset-md` 在 **factory 顶层**解构它，所以一抛错 `apply` 就从不执行 →
`ensureStyles()` 从不调用 → **整页裸样式**。

**教训**：client 半的任何外部 `require` 都必须先确认包真的存在，
不能靠「别的插件这么写」来推断。

`client` 套件把这件事写成显式白名单 —— 新增依赖必须同时改测试，
并且点名禁止 `primitives` 再被引入。

---

## 八、卸载

```bash
# 1. 从 profile 的 package.json 移除 dsh-memory-md（dependencies 与 bundles 两处）
# 2. 删链接并重装
cd ~/.dsh/profiles/web/node_modules && cmd //c "rmdir dsh-memory-md"
cd ~/.dsh/profiles/web && pnpm install
```

记忆文件不会被删（在 `~/.dsh/memory-md/`），需要时手动清理。
