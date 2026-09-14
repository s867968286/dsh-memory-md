# CodeBuddy 记忆方案分析

> 分析对象：CodeBuddy Code（腾讯）记忆系统 v2.136.0
> 代码来源：`D:\soft\node\node-v22.23.2\node_modules\@tencent-ai\codebuddy-code`（已打包 `dist/codebuddy.js`）
> 官方文档：包内 `dist/web-ui/docs/cn/cli/memory.md`
> 分析日期：2026-09-12

---

## 0. 一句话概括

**工程检索派的三层记忆**：静态指令文件（人写）+ 条件规则（glob 自动触发）+ Auto Memory（AI 自主写入 + 语义按需召回）。

核心理念：**按需检索而非全量注入**，用 frontmatter 描述 + glob 匹配 + 语义相关性决定"什么进上下文"。

---

## 1. 三种记忆类型（官方口径）

| 记忆类型 | 位置 | 用途 | 共享范围 |
|---|---|---|---|
| **用户记忆** | `~/.codebuddy/CODEBUDDY.md` | 所有项目的个人偏好 | 仅本人（所有项目） |
| **用户规则** | `~/.codebuddy/rules/*.md` | 模块化个人规则 | 仅本人（所有项目） |
| **项目记忆** | `./CODEBUDDY.md` 或 `./.codebuddy/CODEBUDDY.md` | 团队共享指令 | 随 git 共享 |
| **项目规则** | `./.codebuddy/rules/*.md` | 按主题划分的项目指令 | 随 git 共享 |
| **项目记忆（本地）** | `./CODEBUDDY.local.md` | 个人项目特定偏好 | 仅本人（当前项目） |

### 加载顺序

1. **用户级**：`~/.codebuddy/CODEBUDDY.md` + `~/.codebuddy/rules/` 下所有规则
2. **项目级主文件**：从 cwd **向上递归**加载所有 `CODEBUDDY.md` / `CODEBUDDY.local.md`
3. **项目级规则**：**仅**加载 cwd 的 `.codebuddy/rules/`（不加载父目录规则）
4. **子目录记忆**：操作子目录文件时**动态加载**该子目录的 `CODEBUDDY.md`
5. **本地记忆**：`./CODEBUDDY.local.md`

> `CODEBUDDY.local.md` 自动加入 `.gitignore`。

### 为什么是三种而不是一种？

**不是冗余，是三种不同问题：**

| 机制 | 谁写 | 解决什么 |
|---|---|---|
| `CODEBUDDY.md` | **人写** | 团队共识，随 git 走 |
| `rules/*.md` | **人写** | 同一内容的模块化拆分 + **条件触发能力** |
| Auto Memory | **AI 写** | 自动沉淀，跨会话 |

**rules 存在的两个理由：**
1. **功能**：只有 rules 支持 `paths` glob 条件触发（`CODEBUDDY.md` 只能全量常驻）
2. **迁移成本**：Cursor 用户 `.cursor/rules/*.mdc` → `.codebuddy/rules/*.md`，目录结构几乎不用改；且支持**符号链接**（`ln -s ~/shared-rules .codebuddy/rules/shared`）

**AGENTS.md 兼容**：若项目无 `CODEBUDDY.md`，回退用 `AGENTS.md`；`CODEBUDDY.md` 优先。

---

## 2. Auto Memory 系统

### 存储位置（⚠️ 文档与实际不符）

**官方文档写的是** `~/.codebuddy/memories/{project-id}/`，**但实际默认路径是**：

```
~/.codebuddy/projects/{slug}/memory/
```

源码依据（`dist/codebuddy.js` @13897184）：

```js
static getProjectMemoryDir(eA) {
  let el = eA ?? this.getCompressedWorkDir(),
      ec = join(this.getHomeProjectsDir(), el, "memory"),   // 新路径（默认）
      eu = join(this.getHomeMemoriesDir(), el);             // 旧路径（兼容）
  return !existsSync(ec) && existsSync(eu) ? eu : ec;       // 新路径不存在且旧路径存在才回退
}
```

| 路径 | 状态 |
|---|---|
| `~/.codebuddy/projects/{slug}/memory/` | ✅ **默认** |
| `~/.codebuddy/memories/{slug}/` | ⚠️ 仅兼容读取（旧版本路径） |
| `~/.codebuddy/memories/global/` | ✅ 全局记忆仍在此 |

**`{slug}` 生成规则**：`getCompressedWorkDir()` 把绝对路径的盘符和分隔符转 `-`、全小写。
例：`D:\workspaces\sbfgch\yrdwsbfsf-service` → `d-workspaces-sbfgch-yrdwsbfsf-service`

**推论：CodeBuddy 的记忆按工作目录隔离，每个目录一个独立记忆库，不随项目走。**

### 其他记忆目录

```js
static getGlobalMemoryDir()  { return join(getHomeMemoriesDir(), "global") }
static getTeamMemoryDir(eA)  { return join(getProjectHomeDir(), "memories", `@${eA}`) }
```

`getMemoryDir()` 的优先级：**团队记忆 > 项目记忆**（团队功能开启且有 userId 时）。

---

## 3. MEMORY.md 索引机制 ⭐

> ⚠️ **重要区分（2026-09-13 更正）**：CodeBuddy 有**两条注入路径**，机制不同，早期分析曾将其混淆。
>
> | 路径 | 函数 | 注入内容 |
> |---|---|---|
> | **legacy** | `generateLegacyMemoryPrompt` | `MEMORY.md` 全文（经 `truncateMemoryEntrypoint` 截断） |
> | **typed**（默认） | `generateTypedMemoryPrompt` → `buildMemoryPrompt` | 各记忆文件的 **frontmatter 描述** |
>
> `truncateMemoryEntrypoint`（200 行 + 25KB）服务于 **legacy 索引路径**。

### 两条路径的加载控制差异

**legacy 路径**：读 `MEMORY.md` 全文，做两级截断。

**typed 路径**：注入的是**各文件的 frontmatter 描述字段**（`name` / `description` / `type`）。

**关键点：`description` 字段在「写入时」就受约束** —— 代码内模板明确要求：

```
{{one-line description — used to decide relevance in future conversations, so be specific}}
```

即**单条描述长度由写入侧约束**，不是靠读取侧截断。

**行数限制防的是「条目数量膨胀」**（索引条目过多），**不是**防"单行长文本"。早期"防行长爆炸"的解读有误。

### legacy 路径的双级截断（源码）

```js
let ef = "MEMORY.md", em = 200, eE = 25e3
//   em = 200 行, eE = 25000 字节
```

截断函数 `truncateMemoryEntrypoint`：

```js
function truncateMemoryEntrypoint(eA) {
  let el, ec = eA.trim(), eu = ec.split("\n");
  // 第一级：按行
  if (eu.length > em && (ec = eu.slice(0, em).join("\n"), el = "lines"));
  // 第二级：按字节
  if (Buffer.byteLength(ec, "utf-8") > eE) {
    let eA = Buffer.from(ec, "utf-8"), eu = Math.min(eE, eA.length);
    // 回退到 UTF-8 字符边界（续字节判断：192 & byte === 128）
    for (; eu > 0 && (192 & eA[eu]) == 128;) eu--;
    let ed = eA.subarray(0, eu).toString("utf-8"),
        ep = ed.lastIndexOf("\n");           // 再回退到换行
    ec = ep > 0 ? ed.slice(0, ep) : ed, el = "bytes";
  }
  // 追加截断标记
  if (el) { let eA = el === "lines" ? `first ${em} lines` : `first ${eE} bytes`; ec += ... }
}
```

**两级截断 + UTF-8 边界安全 + 换行回退 + 截断标记**，比 `dsh-memory-snapshot` 的单级字节截断更完备。

> 注：legacy prompt 路径里另有一套近似实现（前 200 行 + 4e4 字符），typed memory 路径用 `truncateMemoryEntrypoint`（200 行 + 25e3 字节）。

### 索引格式

```markdown
# MEMORY.md

- [标题](文件.md) — 一句话描述
```

**注入的不是全文，而是这个索引本身**（受限于 200 行 / 25KB）。

---

## 4. 注入机制：三条通路

### 通路 A：MEMORY.md 索引常驻

`generateLegacyMemoryPrompt()` 读取 `{memoryDir}/MEMORY.md`，截断后注入。

### 通路 B：搜索指引（关键设计 ⭐）

注入提示词时**写死搜索方法**，而不是把内容塞进上下文：

```markdown
## Searching past context

When looking for past context:
1. Search topic files in your memory directory:
   Grep with pattern="<search term>" path="${el}/" glob="*.md"
2. Session transcript logs (last resort — large files, slow):
   Grep with pattern="<search term>" path="${ep}/" glob="*.jsonl"

Use narrow search terms (error messages, file paths, function names)
rather than broad keywords.
```

**这是最值得借鉴的一招：不在索引里塞内容，而是告诉模型"怎么去搜"。**

### 检索策略的本质：分层收窄，不是无脑 grep ⭐

> 2026-09-13 补充确认。

**不是「无脑 grep 全部 `*.md`」**，而是**先看索引、再搜内容**：

```
1. MEMORY.md 索引常驻（前 200 行 / 25KB）
   → 模型先看到"有哪些主题、在哪个文件"
2. 命中后 grep 该主题文件（glob="*.md"）
   → 精确内容检索
3. .jsonl 会话转录是最后手段
   → 提示词自己标注 "last resort — large files, slow"
```

**索引的作用就是「把搜索范围收窄」**，避免全目录扫描。这是分层设计，不是暴力搜索。

### `.jsonl` 会话检索在 DSH 的落地障碍 ⚠️

**DSH 的会话日志是压缩的，需要先解压。**

实测 `~/.dsh/sessions/`：

```
sessions/--D-workspaces-ai-dsh-memory-md--/{session-uuid}/session.jsonl.zstd
```

| 项 | 情况 |
|---|---|
| 格式 | `session.jsonl.zstd`（**zstd 压缩**） |
| 直接 grep | ❌ 不可行 |
| 实现成本 | 需先解压；`dsh-session-persistence-jsonl` 依赖 `koffi`（**原生模块**） |
| 好消息 | ✅ 目录名已按工作区聚合（`--path--` 编码），无需自建索引 |

**结论：会话检索一期不做。**
- CodeBuddy 自己就标为 last resort，本来就不是主路径
- 分类记忆文件已承载"值得留存的知识"，会话原文属于"不该进记忆"的原始素材
- 追溯原文的需求由**可选的留痕开关**覆盖

### 通路 C：语义相关性按需注入

`MemoryContextInterceptor.injectRelevantMemories()`：

```js
async injectRelevantMemories(eA, el) {
  if (!this.memoryRelevanceService) return;
  let eu = el || this.extractLastUserQuery(eA.input);     // 提取用户查询
  let {memoryDir: ed} = await this.getMemoryDir();
  if (!existsSync(ed) || !await this.memoryRelevanceService.isEnabled()) return;
  let el = await this.getRelevantMemoriesContent(eu, ed, ...);  // 按查询检索
  if (el) {
    let ec = `<system-reminder data-role="memory">${el}</system-reminder>`;
    MessageUtils.addSystemReminder(eA.input, ec, "last");  // 注入到消息末尾
  }
}
```

**每轮用户输入时，提取查询 → 检索相关记忆 → 作为 `system-reminder` 注入到消息末尾。**
这是**语义按需召回**，比 glob 匹配更精确。

---

## 5. 条件规则（Conditional Rules）机制 ⭐

### frontmatter 字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否加载此规则 |
| `alwaysApply` | boolean | `true` | 是否始终应用 |
| `paths` | string/string[] | — | 触发规则的文件路径 glob |

### 规则类型判定（源码）

```js
async parse(eA, el) {
  let {scope, autoGeneratedGlobs} = el,
      ep = await readFile(eA, "utf-8"),
      eg = MarkdownUtils.extractFrontMatterWithContent(ep),
      eh = eg.data,
      ef = !1 !== eh.enabled,                                    // enabled
      em = (ec = ed && ed.length > 0 ? ed : this.parseGlobs(eh)) && ec.length > 0,  // 有 globs
      eE = !0 === eh.alwaysApply || !em && !1 !== eh.alwaysApply; // alwaysApply 推导
  return {
    filePath: eA, scope, 
    type: !eE && em ? MemoryType.MANUAL : MemoryType.ALWAYS,
    content: eg.content, enabled: ef, globs: ec, alwaysApply: eE, importedFrom: []
  }
}
```

| `alwaysApply` | `paths` | 类型 | 行为 |
|---|---|---|---|
| `true`（默认） | 任意 | ALWAYS | 始终注入 |
| `false` | 有值 | MANUAL | 仅在操作匹配文件时触发 |
| `false` | 无 | 不支持 | 规则不加载 |

### 触发实现——独立的拦截器

拦截器优先级表中：

```js
eA.ConditionalRules = 1740,        // 独立拦截器
eA.MemoryContext = 1150,           // 记忆注入是另一个
```

运行时逻辑：

```js
// 文件被 Read / @引用 时，标记为待触发
conditionalRules.pendingTriggers.add(resolveFilePathToWorkDir(filePath))

// 拦截器消费待触发集合
if (pendingTriggers.size) {
  let ec = await this.conditionalRulesService.consume(el);
  ec.content && MessageUtils.addSystemReminder(eA.input, ec.content, "last");
}

// consume 内部
let el = Array.from(eA.pendingTriggers),
    ec = await this.findMatchingRules(el, eA.processedRules);
eA.pendingTriggers.clear();
let eu = ec.length > 0 ? this.buildInjectionContent(ec) : "";
logger.info(`Matched ${ec.length} conditional rules`);
```

**触发时机**（官方文档）：
- 使用 `@path/to/file` 引用文件时
- 使用 Read / Glob / Grep / Edit / Write 等文件操作工具时

触发后作为 system-reminder 注入；**所有条件规则都注入过后不重复注入**（`processedRules` 去重）。

### Glob 匹配

启用 `matchBase` 选项：

| 模式 | 匹配 |
|---|---|
| `**/*.ts` | 任意目录所有 TS 文件 |
| `*.ts` | 任意目录所有 TS 文件（matchBase） |
| `src/**/*.{ts,tsx}` | 大括号展开 |
| `{src,lib}/**/*.ts, tests/**/*.test.ts` | 逗号组合 |

### CLI vs IDE 差异

- **CLI**：条件规则靠 glob 自动匹配触发，**不支持模型智能选择**
- **IDE**：支持 `@RuleName` 手动引用 + 模型基于上下文智能决策

---

## 6. Typed Memory（默认启用）

### 四种类型

| 类型 | 用途 | 示例 |
|---|---|---|
| `user` | 用户角色、目标、偏好、知识背景 | "用户是高级后端工程师，擅长 Go" |
| `feedback` | 用户对行为的纠正和指导 | "不要在测试中 mock 数据库" |
| `project` | 项目进行中的工作、目标和决策 | "下周三起冻结非关键合并" |
| `reference` | 外部系统和资源的指引 | "bug 跟踪在 Linear 项目 INGEST 中" |

### 文件格式

```markdown
---
name: 用户角色
description: 用户的职业背景和技术专长
type: user
---

用户是资深后端工程师，拥有 10 年 Go 语言经验，但首次接触项目的 React 前端部分。
```

### 代码内模板

```
{{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{${ed.join(", ")}}}
---
{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}
```

**`description` 明确用于"决定未来对话中的相关性"** —— 这就是索引层。

### 禁用方式

- `settings.json`: `"memory": { "typedMemory": false }`
- 环境变量：`CODEBUDDY_TYPED_MEMORY_ENABLED=false`

**`name` + `description` 的 frontmatter 与 DSH skill 格式一致** —— 迁移时几乎不用改。

---

## 7. CODEBUDDY.md 导入语法

支持 `@path/to/import`：

```markdown
查看 @README 了解项目概述，@package.json 了解可用的 npm 命令。
- Git 工作流程 @docs/git-instructions.md
- @~/.codebuddy/my-project-instructions.md
```

- 支持相对/绝对路径，**支持 `@~/` 家目录**
- **递归导入最大深度 5 层**
- 代码块和代码范围内的 `@` **不解析**（避免误伤 `@tencent-ai/codebuddy-code`）
- 用 `/memory` 查看已加载的记忆文件

**这实现了"索引文件引用正文文件"的另一种形态。**

---

## 8. 缓存与重载（重要限制）

| 操作 | 重新加载 | 说明 |
|---|---|---|
| 进程重启 | ✅ 是 | 缓存清空 |
| 通过 `/memory` 编辑 | ✅ 是 | 自动清缓存 |
| `/clear` 命令 | ❌ 否 | 仅清除消息历史 |
| **手动修改文件** | ❌ **否** | **需手动重启** |
| **新增/删除规则文件** | ❌ **否** | **需手动重启** |

**这是 CodeBuddy 的主要短板** —— 手动编辑记忆文件不生效，必须重启。
对比 `dsh-memory-snapshot`：每次装配重读磁盘，改完下次会话即生效。

---

## 9. 开关与设置

```js
let eC = "CODEBUDDY_CODE_DISABLE_AUTO_MEMORY";
function isAutoMemoryEnabled() { return !BooleanUtils.isTruthy(process.env[eC]) }
```

- `/config` 面板切换 Auto Memory
- `/memory` 命令面板切换
- `settings.json`: `"memory": { "autoMemoryEnabled": false }`
- 环境变量：`CODEBUDDY_DISABLE_AUTO_MEMORY=1`

建议保持规则文件简洁，**特别大的规范文档用 `@import` 引用而非直接包含**。

---

## 10. 可复用到 DSH 的设计清单

| 设计点 | 价值 | DSH 落地 |
|---|---|---|
| **索引格式** `- [标题](文件.md) — 描述` | 高 | 直接可用，无需改动 |
| **双级截断**（200 行 + 25KB，UTF-8 边界安全） | 高 | snapshot 只有字节截断，需自研补 |
| **搜索指引**（写死 Grep 方法） | ⭐ 最高 | 纯提示词，DSH 有 `grep` 工具 |
| **typed frontmatter** (`name`/`description`/`type`) | 高 | `name`+`description` 与 DSH skill 兼容 |
| 条件规则 glob 触发 | 中 | **DSH 无此机制**，需自研插件的拦截器 |
| 语义相关性召回 | 中 | DSH 无现成，或用 `dsh-memory-eternal` |
| `@` 导入语法（递归深度 5） | 中 | 纯提示词可实现 |
| 层级加载（用户→项目→向上递归） | 高 | DSH 原生 AGENTS.md 已有类似机制 |

---

## 11. 关键代码位置索引

| 组件 | 位置 |
|---|---|
| 官方文档 | `dist/web-ui/docs/cn/cli/memory.md` |
| 常量定义 | `dist/codebuddy.js`：`ef="MEMORY.md", em=200, eE=25e3` |
| 截断函数 | `truncateMemoryEntrypoint` |
| 路径解析 | `getProjectMemoryDir` / `getCompressedWorkDir` @13897184 |
| 记忆注入 | `generateLegacyMemoryPrompt` / `generateTypedMemoryPrompt` |
| 语义召回 | `MemoryContextInterceptor.injectRelevantMemories` |
| 条件规则解析 | `MemoryParser.parse` |
| 条件规则触发 | `pendingTriggers` + `conditionalRulesService.consume` |
| 拦截器优先级表 | `ConditionalRules=1740`, `MemoryContext=1150` |
| Typed Memory 模板 | `{{one-line description...}}` 附近 |

---

## 12. 评价

**优点：**
- 分层清晰：静态指令 / 条件规则 / 自动记忆各司其职
- **按需检索设计完整**：索引 + 搜索指引 + 语义召回 + glob 触发
- 双级截断实现严谨（UTF-8 边界安全 + 换行回退 + 截断标记）
- typed frontmatter 结构化，`description` 用于相关性判断
- 支持 `@import` 与符号链接，便于组织

**局限：**
- **手动改文件必须重启**（最大痛点）
- 依赖 `memoryRelevanceService` 实现语义召回
- 记忆存在 home 下，**项目间隔离但不随项目走、不进 git**
- 文档与实际路径不符（`memories/` vs `projects/{slug}/memory/`）
- CLI 不支持模型智能选择条件规则（IDE 才有）

**与 WorkBuddy 的核心差异：**
- CodeBuddy = **工程检索派**：Grep + 语义召回 + typed + glob 触发，机制完备但重
- WorkBuddy = **提示词约定派**：清单规则 + 强制自清理 + 模型自觉，零基础设施但全靠模型遵守
- **要精确检索选 CodeBuddy，要轻量简单选 WorkBuddy**
