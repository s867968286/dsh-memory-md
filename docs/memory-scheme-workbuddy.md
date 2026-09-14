# WorkBuddy 记忆方案分析

> 分析对象：WorkBuddy（腾讯）内置记忆系统
> 代码来源：`C:\Users\kosei\Desktop\1\app-extracted`（asar 解压）+ `C:\Users\kosei\.workbuddy\plugins\marketplaces\workbuddy-builtin\prompt-common\fragments`
> 分析日期：2026-09-12

---

## 0. 一句话概括

**纯提示词驱动的三层记忆**：不做语义检索、不做向量库，靠「注入两份有硬上限的 MEMORY.md + 明确告诉模型何时写、何时读、超限了自己清理」实现跨会话记忆。

核心理念：**把记忆治理外包给模型自己**，用提示词约定替代工程机制。

---

## 1. 三层记忆架构

| 层 | 名称 | 位置 | 权限 | 上限 |
|---|---|---|---|---|
| Layer 1 | Cloud Memory | 服务端 | 只读 | — |
| Layer 2 | User-level Local Memory | `~/.workbuddy/MEMORY.md` | 读写 | 4000 字符/session |
| Layer 3 | Workspace Memory | `{cwd}/.workbuddy/memory/` | 读写 | 项目 MEMORY.md 8000 字符/session |

### Layer 1 — Cloud Memory（两个部分）

**(A) 自动注入的用户画像（只读）**
- 服务端生成的用户长期画像摘要
- 会话启动时包在 `<memory>...</memory>` 块中注入
- 本地缓存于 `~/{{WorkbuddyDataFolderName}}/memory/`
- **禁止本地修改** —— 服务端管理，本地写入会在下次会话被覆盖

**(B) 历史对话检索（`conversation_search` 工具）**
- 服务端排序，搜索用户全部历史对话
- 用于回忆**当前上下文没有的具体过往事件**
- 触发场景：*"我们之前讨论的那个 XX 方案是什么？"*
- **该工具对当前会话零访问权限** —— query 必须自包含
- 不用于查偏好/习惯（那由自动注入的画像覆盖）

### Layer 2 — User-level Local Memory（跨项目）

- 路径：`~/.workbuddy/MEMORY.md`
- 作用域：**所有项目**
- 上限：**4000 字符/session**
- 写入时机：用户**显式要求长期记住**且**不绑定具体项目**时
- 定位：**精确的、强制性的规则**，必须严格执行
- 与云画像的区别：云画像是服务端隐式学习，此文件是**显式写入**

### Layer 3 — Workspace Memory（项目级）

- 目录：`{cwd}/.workbuddy/memory/`
- 作用域：**仅当前项目**
- 文件构成：
  - `YYYY-MM-DD.md` —— 每日工作日志，**append-only，永不覆盖**
  - `MEMORY.md` —— 项目长期笔记，上限 **8000 字符/session**
- 若当日日志不存在，先创建目录和日期文件

---

## 2. 路径解析实现

```js
function resolveProjectFolderName() {
  return process.env.WORKBUDDY_DATA_FOLDER_NAME?.trim() || ".workbuddy";
}

function resolveUserDataDir() {
  const envDir = process.env.WORKBUDDY_CONFIG_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), resolveProjectFolderName());
}

// 项目级：基于当前会话 cwd（不是 homedir！）
const memoryDir = path.join(workDir, dataFolderName, "memory");
```

**设计要点：**
- 项目级用 `ctx.options.cwd`，**不是** homedir
- 支持环境变量覆盖，供**私有化定制版**改数据目录名
- Desktop 主进程注入 `WORKBUDDY_CONFIG_DIR` 绝对路径，sidecar/子进程透传
- `WORKBUDDY_DATA_FOLDER_NAME` 让私有化版本把 `.workbuddy` 换成其他名字

> 对比 CodeBuddy：WorkBuddy 的记忆**在项目内**（`{cwd}/.workbuddy/memory/`），可随项目走、可进 git；CodeBuddy 的在 home 下（`~/.codebuddy/projects/{slug}/memory/`），项目间隔离但不随项目走。

---

## 3. 注入机制

### 模板占位符

`prompt-common/fragments/memory-context.md`（仅 3 行）：

```nunjucks
{{ WorkingMemoryContent }}
{{ UserLocalMemoryContent }}
{{ UserMemoryContent }}
```

### 变量填充（MemoryCollector）

```js
async collect(vars, ctx) {
  const workDir = ctx.options.cwd || process.cwd();
  const dataFolderName = resolveProjectFolderName();
  const memoryDir = path.join(workDir, dataFolderName, "memory");
  const localEnabled = !getDisableLocalSkillsMemoryFromAppConfig(this.appConfig);

  vars["WorkbuddyMemoryDir"]     = memoryDir;
  vars["WorkbuddyDataFolderName"] = dataFolderName;
  vars["WorkbuddyMemory_1"]      = getWorkbuddyMemory1(memoryDir, dataFolderName, localEnabled);
  vars["WorkingMemoryContent"]   = localEnabled ? this.getWorkingMemoryContent(memoryDir) : "";
  vars["UserLocalMemoryContent"] = localEnabled ? this.getUserLocalMemoryContent() : "";
  vars["LocalSkillsMemoryEnabled"] = localEnabled ? "true" : "";
}
```

**关键结论：每次会话启动注入的只有两个 MEMORY.md（各带硬上限）+ 云端画像。**
**每日日志（`YYYY-MM-DD.md`）不注入，靠模型自己按需读取。**

### PromptRenderer 收集器顺序

```
1. EnvCollector              — modelId/modelName + 运行时环境 + 响应语言
2. IdentityCollector         — ~/.workbuddy/ 身份文件
3. PersonalizationCollector  — 语气风格 + 自定义提示词
4. MemoryCollector           — WorkbuddyMemory 规则 + WorkingMemoryContent
5. UserMemoryCollector       — 远程 API 用户记忆（云端长期记忆）
6. CollaborationCollector    — ToolResultPresentationPrompt
7. ExpertPromptSlotCollector — 插件注册插槽
8. ExpertManagementCollector — 专家管理
9. BinaryCollector           — 可用二进制工具信息
```

---

## 4. 截断与「强制自清理」机制 ⭐

这是 WorkBuddy 最值得借鉴的设计。

### 双上限

```js
var MAX_MEMORY_CHARS = 8e3;            // 项目级 8000 字符
const MAX_USER_MEMORY_CHARS = 4e3;     // 用户级 4000 字符
```

**项目级限额是用户级的 2 倍** —— 项目细节多，用户偏好少。

### 项目级 MEMORY.md 超限处理

未超限：直接包 `<working_memory_content>` 注入。

超限时**不是简单截断**，而是注入一段 `**ACTION REQUIRED**`：

```
<working_memory_content>
The following is the existing working memory for this project. Use it as context.

{content.substring(0, MAX_MEMORY_CHARS)}
... (memory truncated — MEMORY.md is too large)

**ACTION REQUIRED**: Your MEMORY.md has exceeded the size limit and was truncated during injection.
Before proceeding with the user's task, you MUST first clean up MEMORY.md:
1. Read the full `${memoryDir}/MEMORY.md`
2. Consolidate and deduplicate: merge related entries, remove outdated or redundant information, keep only what's still relevant
3. Rewrite it in place to be concise and well-organized
4. Then proceed with the user's request
</working_memory_content>
```

**设计精髓：把「记忆膨胀」这个长期问题的治理，外包给模型自己。**
- 不需要额外的摘要/压缩 LLM 调用
- 不需要定时维护脚本
- 模型在执行任务前顺手完成整理

### 读取失败处理

```js
catch (err) {
  this.logger.warn(`[MemoryCollector] Failed to read MEMORY.md: ${err}`);
  return "";   // 读不到就注入空串，不崩会话
}
```

---

## 5. 提示词规则（workbuddy-memory-system.md）

### 5.1 写入时机——清单化（MUST follow）

```markdown
**When to write (MUST follow):** Immediately after completing substantive work,
append a brief note to {{WorkbuddyMemoryDir}}/YYYY-MM-DD.md using the Edit tool.
Substantive work includes:
- Built or modified a website/application
- Fixed a bug
- Wrote or generated a report or document
- Completed code refactoring or architecture changes
- Chose a technical approach (framework, design pattern, etc.)
- User shared project conventions or preferences → also update MEMORY.md in place
```

**"该写什么"用正面清单枚举。**

### 5.2 负面清单——不该写什么

```markdown
Daily logs are append-only. Do NOT record transient information
(search results, temporary paths, tool errors).
Only persist what has lasting value across sessions.
```

### 5.3 检索指引——明确"先读哪个"

```markdown
Retrieving historical context: choose the right source as needed — no need to read everything.
- This project's past work → read local daily logs (most recent first) or MEMORY.md
- Items spanning projects or of uncertain location → call conversation_search
- Both sources can be used together if local logs are incomplete.
- No historical dependency → skip reading memory files.
```

**最后一条尤其重要：明确告诉模型"不需要就别读"**，避免无谓的工具调用开销。

### 5.4 维护规则（自清理）

```markdown
Maintenance: Distill daily logs older than 30 days into MEMORY.md by topic,
then delete the old files. Do not store secrets unless the user explicitly asks.
```

### 5.5 角色边界

```markdown
Role boundary: Workspace memory is supplemental only. It does NOT replace
the assistant's normal reply, final answer, or any user-requested deliverable.
```

---

## 6. 开关与降级

```js
var APP_CONFIG_KEY_DISABLE_LOCAL_SKILLS_MEMORY = "disableLocalSkillsMemory";

// 渲染端用正向语义 enabled，adapter 写入时翻译为 !enabled
// 类型不符（非布尔）时返回默认 false，避免脏配置导致崩溃
function getDisableLocalSkillsMemoryFromAppConfig(svc) {
  const raw = svc.get(APP_CONFIG_KEY_DISABLE_LOCAL_SKILLS_MEMORY);
  if (typeof raw !== "boolean") return false;
  return raw;
}
```

禁用后的行为：
- `MemoryCollector.collect`：不读本地 MEMORY.md，所有相关变量置空串
- `WorkingMemoryReminderSection.shouldApply`：跳过 reminder 注入
- **不影响**云端 `UserMemoryCollector` 与 `conversation_search` 工具

---

## 7. 可复用到 DSH 的设计清单

| 设计点 | DSH 侧对应 | 是否需代码 |
|---|---|---|
| 三层记忆结构 | 可直接抄成 skill / AGENTS.md 片段 | ❌ 纯提示词 |
| 双上限（8K/4K 字符） | snapshot 的 `maxBytes`（注意：字节 vs 字符） | ⚠️ 需换算 |
| **强制自清理（ACTION REQUIRED）** | 纯提示词，零代码 | ❌ |
| 写入清单 + 负面清单 | 纯提示词 | ❌ |
| 检索指引（含"不需要就别读"） | 纯提示词 | ❌ |
| 30 天蒸馏规则 | 纯提示词 | ❌ |
| `{cwd}/.workbuddy/memory/` 路径 | DSH: `{cwd}/.dsh/memory/` | ❌ |
| 项目 MEMORY.md 注入上下文 | DSH 原生 AGENTS.md 只认 `AGENTS.md` 文件名 | ⚠️ 见下 |

### DSH 落地的唯一外部依赖

**"把项目 MEMORY.md 注入上下文"这一步**：
- DSH 原生 `AGENTS.md` 自动加载只管 `AGENTS.md` / `~/.dsh/AGENTS.md`
- 不读 `memory/MEMORY.md`
- 两条路：
  - **零插件**：把记忆文件命名为 `AGENTS.md`（放弃 `MEMORY.md` 语义）
  - **装插件**：`dsh-memory-snapshot` 指定 `files: ['~/.dsh/memory/MEMORY.md', ...]`

---

## 8. 关键代码位置索引

| 组件 | 位置 |
|---|---|
| 记忆系统规则模板 | `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/prompt-common/fragments/workbuddy-memory-system.md` |
| 内容占位符 | 同目录 `memory-context.md` |
| MemoryCollector | `app-extracted/main/workbuddy-auth-product-coordinator.js` |
| getWorkbuddyMemory1 | 同上（Layer1-3 规则文本内联在代码里） |
| 路径解析 | 同上 `resolveProjectFolderName` / `resolveUserDataDir` |
| 开关 | 同上 `APP_CONFIG_KEY_DISABLE_LOCAL_SKILLS_MEMORY` |

---

## 9. 实测发现（2026-09-13 核实）

以下为分析文档初稿后，对实际落盘数据的核实结果。

### 9.1 日志目录是「时间戳」，不是固定路径 ⚠️

实测 `D:\WorkBuddy\`：

```
2026-08-16-00-07-57/
2026-09-08-21-03-24/
2026-09-09-09-30-23/          ← 目录名是创建时刻
  └─ .workbuddy/memory/
       └─ 2026-09-09.md        ← 文件名本身规范
```

**文件名是规范的 `YYYY-MM-DD.md`，但父目录是"创建时刻"时间戳。** 每次开工新建时间戳目录 = 每次会话一个新工作区。

`MemoryCollector` 用的是 `ctx.options.cwd`，所以 `memoryDir` 跟着会话工作区走。

**结论：这是"先定工作区（带时间），再写日期文件"。不应照搬 —— 应固定路径 + 日期文件名，一天一个。**

### 9.2 默认没有 MEMORY.md ⚠️

```bash
find "D:/WorkBuddy" -maxdepth 4 -name "MEMORY.md"
# 无输出
```

Layer 3 的 `MEMORY.md` **实际不存在**。按提示词，它只在两种情况产生：
- 用户分享项目约定 → 更新 MEMORY.md
- **30 天以上的日志蒸馏** → *"Distill daily logs older than 30 days into MEMORY.md"*

**推论：新项目 `WorkingMemoryContent` 注入空串，当前记忆完全不进上下文；只有攒够 30 天日志被蒸馏后才"生效"。**

→ **生效明显的反而是过期记忆。** 本方案需改为"记忆即时写入，无延迟"。

### 9.3 日志检索：纯靠模型发挥，无任何机制

代码中**没有任何检索实现**。唯一指引是提示词那 4 行（most recent first / conversation_search / 两者结合 / 不需要就别读）。

**读几个文件、读哪些、是否 grep、怎么匹配 —— 全凭模型判断。无程序化检索、排序、匹配。**

### 9.4 轻量程度的准确描述

「就是写个插件注入提示词」**基本成立**，但仍做三件事：
1. `MemoryCollector` 真实读取文件 + 截断 + 拼 `<working_memory_content>` 块
2. 超限时注入 `ACTION REQUIRED` 强制自清理
3. 路径解析（支持 env 覆盖）

准确说是：**注入提示词 + 读取与截断 + 自清理指令**。

---

## 10. 评价

**优点：**
- 零外部依赖，不建索引、不做向量检索
- 上限明确，且**超限有自治机制**（自清理）
- 写入规则具体到可执行（清单 + 负面清单）
- 检索指引明确，避免无谓工具调用
- 记忆在项目内，可进 git、随项目走

**局限：**
- 完全依赖模型遵守提示词，无程序强制
- 三级记忆的责任边界靠模型判断（"跨项目" vs "本项目"）
- 日志文件靠模型自己读，检索效率取决于模型
- 每轮会话都注入两个 MEMORY.md（虽有上限，仍是固定开销）
- ⚠️ **默认没有 MEMORY.md，记忆要等 30 天蒸馏才生效**（见 9.2）
- ⚠️ **时间戳工作区导致记忆分散**（见 9.1）
- ⚠️ **日志无任何检索机制**，纯靠模型发挥（见 9.3）

**与 CodeBuddy 的核心差异：**
- WorkBuddy = **提示词约定派**（清单规则 + 自清理 + 模型自觉）
- CodeBuddy = **工程检索派**（Grep + 语义召回 + typed frontmatter + glob 触发）
- **本方案：以 CodeBuddy 为主干，吸收 WorkBuddy 的提示词规则**（见 `docs/plan.md`）
