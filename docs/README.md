# docs 索引

本目录分两层：**research**（调研记录，不是需求）与 **design**（定案清单）。

> ⚠️ **需求真源是用户，当前实现以源码为准。** 这里的任何文档都不能当作「系统现在就是这样」的证据。

---

## design/ —— 定案清单

| 文件 | 用途 |
|---|---|
| [`plan.md`](design/plan.md) | 方案定案清单与修订历史（原则、取舍、已被否决的路线）。改实现前先读这份。 |

## research/ —— 调研记录

### 形态与选型

| 文件 | 用途 |
|---|---|
| [`memory-scheme-codebuddy.md`](research/memory-scheme-codebuddy.md) | **CodeBuddy 记忆方案源码级分析（本插件的移植来源）** |
| [`memory-scheme-workbuddy.md`](research/memory-scheme-workbuddy.md) | WorkBuddy 记忆方案分析 |
| [`memory-scheme-comparison.md`](research/memory-scheme-comparison.md) | 上面两者的对比总览（选型依据） |

### 横向研究

| 文件 | 用途 |
|---|---|
| [`memory-research-six-implementations.md`](research/memory-research-six-implementations.md) | 六款同类实现的注入/沉淀机制横向研究 + 官方注入机制 |
| [`memory-research-hermes-eternal-audit.md`](research/memory-research-hermes-eternal-audit.md) | 对照审查 `dsh-hermes-memory` 与 `dsh-memory-eternal` |
| [`memory-research-preset-md-vs-references.md`](research/memory-research-preset-md-vs-references.md) | `dsh-preset-md` 与三个参考实现在「记忆沉淀/日志」轴上的对照 |

### 记忆整理（dream / consolidation）

| 文件 | 用途 |
|---|---|
| [`memory-research-dream-and-checkup.md`](research/memory-research-dream-and-checkup.md) | **`/memory-check` 的调研底稿**：CC 官方 `Dream`、`dsh-mneme`、`dsh-prime-memory`、`dsh-auto-memory` 的整理机制对比；**第二轮的三个真正复刻 CC Dream 的实现**（`dsh-cc-haha-dream`、`@klarkxy/dsh-memory`、`@stardustlc/dsh-dream`）；CodeBuddy 为何没有整理功能（实测证据）；本插件哪些是机制借鉴、哪些是自研；**第六·六节的「已知遗漏」清单**。 |

---

## 阅读顺序建议

- **要改 `/memory-check`**：先 `research/memory-research-dream-and-checkup.md` 的第七节（取舍），再 `design/plan.md`（全局原则）。
- **要改记忆写入/注入**：先 `research/memory-scheme-codebuddy.md`（移植来源），再 `design/plan.md`。
- **要评估某个第三方记忆插件**：先看 `research/memory-research-six-implementations.md` 的方法论，再看对应的专项文档。
