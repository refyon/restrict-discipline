# restrict-discipline

DSH（DeepSeek Harness）行为规范插件：约束 Agent 的文件操作与系统行为，保护敏感配置，降低上下文 Token 消耗，提供参考 Claude Code CLAUDE.md 机制的项目记忆。

## 功能

规则固定为 4 条主规则，原 16 条细规则收编为子项（v0.6 四元重构；v0.7 记忆改为 claude-code 路线）：

| # | 规则 | 性质 | 子项 |
|---|------|------|------|
| 1 | **强制约束** | 插件自动拦截/确认/留痕 | 1.1 文件分类 · 1.2 `.env` 保护 · 1.3 代理保护 · 1.4 操作留痕与复用 · 1.5 目录外确认 · 1.6 会话摘要 · 1.7 遍历排除 |
| 2 | **Token 节约** | 软约束，不拦截 | 2.1 长输出落盘 · 2.2 按需读取 · 2.3 合并命令 · 2.4 简洁回复 · 2.5 避免重复验证 · 2.6 批量编辑 · 2.7 失败收敛 |
| 3 | **会话记忆** | 文件即记忆（Claude Code 式） | 3.1 项目记忆文件 · 3.2 `#` 快捷召回 · 3.3 会话摘要 · 3.4 旧检索机制已移除 |
| 4 | **编码纪律** | 软约束（Karpathy 准则） | 4.1 先想后写 · 4.2 简单优先 · 4.3 外科手术式修改 · 4.4 目标驱动 |

规则文本由 `lib/rules.js` 单一事实源注入系统提示；硬拦截在 `lib/enforce.js` 按命令模式匹配（与编号解耦）。

## 会话记忆（v0.7，参考 Claude Code 的 CLAUDE.md 机制）

v0.7 起记忆收敛为**单文件 Markdown 项目记忆** `memory/CLAUDE.md`，放弃 v0.6 的 BM25 检索注入：

- **项目记忆文件**（规则 3.1）：`memory/CLAUDE.md` 是项目级长期记忆。每次会话启动（fresh 与 resume）时插件经 `agent.inject` 自动加载全文（超过 `maxLoadChars` 截断并注记）；agent 可直接 `read`/`edit` 维护，保持小而专注。
- **`#` 快捷召回**（规则 3.2）：文件内一级标题（`# 名称`）是记忆条目；用户消息中出现 `#条目名` 时，插件自动把对应条目区块注入会话（Claude Code memory shortcuts）。
- **remember 工具**（规则 3.4 唯一记忆工具）：固定追加到 `memory/CLAUDE.md` 的「## 记忆条目」分节，自动带时间戳与来源审计（会话 id · 轮次），写入前脱敏密钥/令牌（500 字截断）。
- **会话摘要**（规则 1.6/3.3）：每轮 idle 自动写 `memory/<会话id>_<标题>.md`（Markdown 分节，过滤运行时噪音）；仅供留档与人工查阅，不再参与检索注入。
- **已移除**（规则 3.4）：`recall_memory` / `forget_memory` / `memory_stats` / `memory_export` / `memory_gc` 与 BM25 检索注入链路（`lib/memory.js`）已删除——记忆全文自动可用，无需检索工具。
- **迁移**：`node scripts/migrate-legacy-memory.mjs <项目根>` 把旧 `memory/*.md` 的「记忆条目」并入 `memory/CLAUDE.md`（原文件保留）。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:refyon/restrict-discipline
```

## 启用 / 禁用

1. 打开 Web UI → **设置 → 插件**
2. 找到 **restrict-discipline（行为规范）** 卡片：勾选 = 启用（默认），取消勾选 = 禁用
3. 配置写入命名空间 `restrict-discipline`（`$DSH_HOME/settings.yaml`）：`enabled` / `autoLoad` / `maxLoadChars` / `shortcutRecall` / `memoryTools`

禁用后所有拦截/确认/留痕/摘要行为暂停；工具仍可见，但调用会提示已禁用。

## 行为说明

- **目录外修改**：`write`/`edit` 工具及 pwsh 写入/删除命令目标在项目目录外时请求确认；
- **只读放行**：`read`/`read_image`/`grep`/`glob`/`Get-Content` 等只读操作默认放行，不打扰；
- **项目记忆自动加载**：会话启动时插件读 `memory/CLAUDE.md`，经 `agent.inject` 以 user 消息注入（logged channel，随历史保留）；`#条目名` 定向召回经 `session/event` 监听注入。

## 开发

```bash
# 规则核心冒烟测试 + host 集成自检（零依赖）
node test/smoke-host.mjs
node test/integration-host.mjs
```

### 目录结构

```
lib/enforce.js   # 规则核心（纯逻辑、无依赖、可独立测试）
lib/rules.js     # 规则文本单一事实源（4 条主规则）
lib/search.js    # 脚本检索：倒排索引 + BM25（find_operation）
lib/memload.js   # 项目记忆纯逻辑：分节/# 召回/截断/注入块渲染（claude-code 式）
lib/memfile.js   # memory/*.md 记忆文档纯逻辑（分节/条目/CLAUDE.md 追加器）
lib/redact.js    # 密钥/令牌脱敏（写入记忆前）
lib/digest.js    # 摘要净化与截断
lib/index.js     # host 插件：设置注册、工具、摘要、session-start 注入、# 召回、pre-execute 接线
lib/client.js    # 浏览器卡片：设置 → 插件 的启用/禁用开关
cordis.patch.yml # bundle 补丁：将 host 行插入 profile 组成
scripts/migrate-legacy-memory.mjs # 一次性迁移：旧记忆条目并入 memory/CLAUDE.md
```

## 许可

MIT
