# 记忆方案对比总览：WorkBuddy vs CodeBuddy

> 目的：为「DSH 轻量级本地 MD 记忆方案」选型提供依据
> 详细分析见同目录 `memory-scheme-workbuddy.md` / `memory-scheme-codebuddy.md`
> 日期：2026-09-12

---

## 1. 一句话对比

| | WorkBuddy | CodeBuddy |
|---|---|---|
| **流派** | 提示词约定派 | 工程检索派 |
| **核心手段** | 清单规则 + 强制自清理 + 模型自觉 | Grep + 语义召回 + typed frontmatter + glob 触发 |
| **基础设施** | 零 | 需 relevanceService、拦截器、索引服务 |
| **记忆位置** | `{cwd}/.workbuddy/memory/`（项目内） | `~/.codebuddy/projects/{slug}/memory/`（home 下） |
| **随项目走** | ✅ 可进 git | ❌ 项目隔离但不随项目走 |

---

## 2. 架构对比

### WorkBuddy：三层

```
Layer 1  Cloud Memory        服务端画像 + conversation_search   只读
Layer 2  User Local Memory   ~/.workbuddy/MEMORY.md             4000 字符
Layer 3  Workspace Memory    {cwd}/.workbuddy/memory/
           ├─ YYYY-MM-DD.md   每日日志，append-only
           └─ MEMORY.md       项目笔记                    8000 字符
```

### CodeBuddy：三种

```
静态指令   CODEBUDDY.md / .codebuddy/CODEBUDDY.md     人写，随 git
条件规则   .codebuddy/rules/*.md                      人写，glob 触发
自动记忆   ~/.codebuddy/projects/{slug}/memory/       AI 写
           ├─ MEMORY.md        索引（前200行/25KB）
           └─ 主题文件.md       正文，按需 Grep
```

---

## 3. 关键能力逐项对比

| 能力 | WorkBuddy | CodeBuddy | 备注 |
|---|---|---|---|
| 索引常驻 | ✅ 两个 MEMORY.md | ✅ MEMORY.md 前 200 行 / 25KB | 都有硬上限 |
| 正文按需读 | ✅ 模型读日志文件 | ✅ 模型 Grep 主题文件 | 都是模型自主 |
| 超限处理 | ⭐ **强制模型自清理** | 双级截断 + 标记 | WorkBuddy 更聪明 |
| 截断实现 | 字符数截断 | 行 + 字节双级，UTF-8 边界安全 | CodeBuddy 更严谨 |
| 写入规则 | ⭐ 正面清单 + 负面清单 | 提示词内说明 | WorkBuddy 更具体 |
| 检索指引 | ⭐ 明确"不需要就别读" | ⭐ 写死 Grep 命令 | 都很有价值 |
| glob 条件触发 | ❌ | ✅ `ConditionalRules` 拦截器 | CodeBuddy 独有 |
| 语义召回 | ❌（云侧 conversation_search） | ✅ 每轮按 query 注入 | CodeBuddy 本地也有 |
| typed frontmatter | ❌ | ✅ 4 类型 | CodeBuddy 独有 |
| `@import` 递归 | ❌ | ✅ 深度 5 | CodeBuddy 独有 |
| **热重载** | ✅ 每次装配重读 | ❌ **手动改文件需重启** | ⭐ WorkBuddy 胜 |
| 关卡开关 | ✅ appConfig | ✅ env + settings | 都有 |

---

## 4. 两份方案各自的"最值得抄的一招"

### WorkBuddy：强制自清理（ACTION REQUIRED）

超限时不简单截断，而是注入指令让模型**先整理再干活**：

```
**ACTION REQUIRED**: Your MEMORY.md has exceeded the size limit...
Before proceeding with the user's task, you MUST first clean up MEMORY.md:
1. Read the full MEMORY.md
2. Consolidate and deduplicate
3. Rewrite it in place
4. Then proceed with the user's request
```

**把长期治理问题外包给模型，零额外 LLM 调用、零维护脚本。**

### CodeBuddy：搜索指引

不把内容塞进上下文，而是**告诉模型怎么去搜**：

```
## Searching past context
1. Grep with pattern="<search term>" path="${memoryDir}/" glob="*.md"
2. Session transcript logs (last resort — large files, slow)
Use narrow search terms rather than broad keywords.
```

**用一次 Grep 调用替代全量注入，这是"按需"的精髓。**

---

## 5. 对 DSH 落地的启示

### DSH 平台现有能力

| 能力 | DSH 现状 |
|---|---|
| AGENTS.md 自动加载 | ✅ 但只认 `~/.dsh/AGENTS.md` + 项目目录链 |
| skill 机制 | ✅ SKILL.md + frontmatter（`name`/`description`） |
| 按需加载 | ✅ `skill` 工具（catalog 常驻 + body 按需） |
| 热更新 | ✅ skill 目录 watch，无需重启 |
| `grep` / `read` 工具 | ✅ 现成 |
| 记忆目录 | ❌ 无原生记忆概念 |
| glob 条件触发 | ❌ 无 |
| 语义召回 | ❌ 无（Mnemon / dsh-memory-eternal 可补） |

### 组合建议（已定案）

```
主方案：CodeBuddy 方式
  索引格式 / Typed 四分类 / 搜索指引 / 层级加载 / 行数限制

辅：WorkBuddy 的提示词规则
  写入清单 + 负面清单 / 强制自清理 / 角色边界

落地：自研插件 dsh-memory-md
  记忆根目录 .dsh/memory-md/
  只注入索引，不注入正文；每次装配重读，热更新
```

> 定案细节见 `docs/plan.md`。原「改名 AGENTS.md / 复用其他插件」路线已否决。

### 现成插件评估结论

| 插件 | 结论 |
|---|---|
| `dsh-memory-snapshot` | ⚠️ **不采用**。仅作"每次装配重读"这一机制的可行性验证参考 |
| `dsh-memory-eternal` | ⚠️ **不采用**。只装一个记忆插件；本项目自研 |
| `dsh-continual-harness` | ⚠️ **不采用**。定位不同 |

**已评估无关插件**（个人项目，不作代码参考）：`agent-qa`、`deepseek-desk-rsi`、`deepseek-harness-molt`、`dsh-tianshu-tui`、`dsh-webui`。

---

## 6. 待决策项

1. **记忆作用域**：项目级（随 git）还是用户级（跨工作区）？两家做法相反。
2. **超限治理**：抄 WorkBuddy 的强制自清理，还是自研截断？
3. **注入方式**：零插件（改名 AGENTS.md）还是装 snapshot？
4. **是否要 glob 条件触发**：要的话 DSH 得自研拦截器（成本高）。
5. **是否要语义召回**：要的话复用 `dsh-memory-eternal` 的 `memory_recall`。

---

## 7. 资料位置

| 内容 | 路径 |
|---|---|
| WorkBuddy 详细分析 | `docs/memory-scheme-workbuddy.md` |
| CodeBuddy 详细分析 | `docs/memory-scheme-codebuddy.md` |
| WorkBuddy 提示词模板 | `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/prompt-common/fragments/` |
| WorkBuddy 源码 | `C:\Users\kosei\Desktop\1\app-extracted\main\workbuddy-auth-product-coordinator.js` |
| CodeBuddy 源码 | `D:\soft\node\node-v22.23.2\node_modules\@tencent-ai\codebuddy-code\dist\codebuddy.js` |
| CodeBuddy 官方文档 | 同上包内 `dist/web-ui/docs/cn/cli/memory.md` |
| 你的现有记忆库 | `C:\Users\kosei\.codebuddy\projects\d-workspaces-sbfgch-yrdwsbfsf-service\memory\` |
