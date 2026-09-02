# restrict-discipline

DSH（DeepSeek Harness）行为规范插件：约束 Agent 的文件操作与系统行为，保护敏感配置，降低上下文 Token 消耗，提供跨会话 Markdown 记忆库。

## 功能

规则固定为 4 条主规则，原 16 条细规则收编为子项（v0.6）：

| # | 规则 | 性质 | 子项 |
|---|------|------|------|
| 1 | **强制约束** | 插件自动拦截/确认/留痕 | 1.1 文件分类 · 1.2 `.env` 保护 · 1.3 代理保护 · 1.4 操作留痕与复用 · 1.5 目录外确认 · 1.6 会话摘要 · 1.7 遍历排除 |
| 2 | **Token 节约** | 软约束，不拦截 | 2.1 长输出落盘 · 2.2 按需读取 · 2.3 合并命令 · 2.4 简洁回复 · 2.5 避免重复验证 · 2.6 批量编辑 · 2.7 失败收敛 |
| 3 | **会话记忆** | 自动执行 + 工具 | 3.1 自动注入 · 3.2 摘要复用 · 3.3 记忆工具 · 3.4 自动捕获（预留） · 3.5 记忆 GC |
| 4 | **编码纪律** | 软约束（Karpathy 准则） | 4.1 先想后写 · 4.2 简单优先 · 4.3 外科手术式修改 · 4.4 目标驱动 |

规则文本由 `lib/rules.js` 单一事实源注入系统提示；硬拦截在 `lib/enforce.js` 按命令模式匹配（与编号解耦）。

## 会话记忆（Markdown 文档，无数据库）

v0.6 起记忆统一存为 **Markdown 文档** `memory/<会话id>_<标题>.md`（旧 `.txt` 摘要兼容读取）：

- **摘要**（规则 1.6/3.2）：每轮 idle 自动写入，结构 `# 会话摘要` / `## 消息统计` / `## 脚本清单` / `## 最近对话`，自动过滤运行时噪音并脱敏密钥；
- **记忆条目**（规则 3.3）：`## 记忆条目` 节，一行一条 `- [id] 时间 内容（来源: 会话 · 轮次）`，带来源审计；
- **自动注入**（规则 3.1）：新会话首次内容解析时 BM25 + 时间衰减 检索 Top3，注入**渐进披露索引块**（默认 ≤700 字符、每文件一行标题摘要），细节用 `recall_memory` 下钻；
- **软删除/GC**（规则 3.5）：`forget_memory` 把条目移入 `## 已归档条目`（可恢复），`memory_gc` 超期清理（`dry_run` 默认预览）。

### 记忆工具（可在设置中整体关闭 `memoryTools`）

| 工具 | 作用 |
|---|---|
| `remember` | 保存长期记忆（自动来源审计 + 密钥脱敏 + 500 字截断） |
| `recall_memory` | BM25 + 时间衰减检索记忆库，返回命中文件与证据行 |
| `forget_memory` | 软删除（id 或内容关键词，移入已归档） |
| `memory_stats` | 记忆库统计（活动/已归档条目） |
| `memory_export` | 导出全部记忆为 `docs/memory-export-<时间>.md` |
| `memory_gc` | 清理超期已归档条目（`dry_run` 预览，不碰活动条目） |

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:refyon/restrict-discipline
```

## 启用 / 禁用

1. 打开 Web UI → **设置 → 插件**
2. 找到 **restrict-discipline（行为规范）** 卡片：勾选 = 启用（默认），取消勾选 = 禁用
3. 配置写入命名空间 `restrict-discipline`（`$DSH_HOME/settings.yaml`）：`enabled` / `memoryTools` / `memoryTopK` / `indexMaxChars` / `recallLimit` / `gcRetentionDays`

禁用后所有拦截/确认/留痕/摘要行为暂停；工具仍可见，但调用会提示已禁用。

## 行为说明

- **目录外修改**：`write`/`edit` 工具及 pwsh 写入/删除命令目标在项目目录外时请求确认；
- **只读放行**：`read`/`read_image`/`grep`/`glob`/`Get-Content` 等只读操作默认放行，不打扰；
- **会话记忆自动注入**：新会话首次内容解析时，插件在 `system-prompt/assemble` 阶段自动检索 `memory/` 中相关历史摘要（BM25 + 时间衰减、Top3、每文件一行索引、排除本会话自身），追加进运行时上下文快照（【历史记忆】块）；按会话 id 只执行一次，会话销毁时清理标记。注入成功时同步向会话追加"回忆提示"消息（reasoning 列出已回忆文件）。

## 开发

```bash
# 规则核心冒烟测试（零依赖）
node test/smoke-host.mjs
```

### 目录结构

```
lib/enforce.js   # 规则核心（纯逻辑、无依赖、可独立测试）
lib/rules.js     # 规则文本单一事实源（4 条主规则）
lib/search.js    # 脚本/记忆检索：倒排索引 + BM25（find_operation / recall）
lib/memory.js    # 记忆检索（BM25+时间衰减）与注入块渲染（索引/全文）
lib/memfile.js   # memory/*.md 记忆文档纯逻辑（分节/条目/软删/GC）
lib/redact.js    # 密钥/令牌脱敏（写入记忆前）
lib/digest.js    # 摘要净化与截断
lib/index.js     # host 插件：设置注册、工具、摘要、pre-execute 接线
lib/client.js    # 浏览器卡片：设置 → 插件 的启用/禁用开关
cordis.patch.yml # bundle 补丁：将 host 行插入 profile 组成
```

## 许可

MIT
