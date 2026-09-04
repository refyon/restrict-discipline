# restrict-discipline

DSH（DeepSeek Harness）行为规范插件：约束 Agent 的文件操作与系统行为，保护敏感配置，降低上下文 Token 消耗，并提供文件即记忆的项目记忆能力。

## 功能

规则固定为 4 条主规则，细规则收编为子项：

| # | 规则 | 性质 | 子项 |
|---|------|------|------|
| 1 | **强制约束** | 插件自动拦截/确认/留痕 | 1.1 文件分类 · 1.2 `.env` 保护 · 1.3 代理保护 · 1.4 操作留痕与复用 · 1.5 目录外确认 · 1.6 会话摘要 · 1.7 遍历排除 |
| 2 | **Token 节约** | 软约束，不拦截 | 2.1 长输出落盘 · 2.2 按需读取 · 2.3 合并命令 · 2.4 简洁回复 · 2.5 避免重复验证 · 2.6 批量编辑 · 2.7 失败收敛 |
| 3 | **会话记忆** | 文件即记忆 | 3.1 项目记忆文件（`memory/MEMORY.md`，会话启动自动加载注入、超限截断；`remember` 工具追加，自动脱敏+来源审计）· 3.2 `#` 快捷召回 · 3.3 会话摘要（`memory/<会话>.md` 留档，不参与注入）· 3.4 无检索工具（记忆全文自动可用） |
| 4 | **编码纪律** | 软约束（Karpathy 准则） | 4.1 先想后写 · 4.2 简单优先 · 4.3 外科手术式修改 · 4.4 目标驱动 |

规则文本由 `lib/rules.js` 单一事实源注入系统提示；硬拦截在 `lib/enforce.js` 按命令模式匹配（与编号解耦）。

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
- **项目记忆自动加载**：会话启动时插件读 `memory/MEMORY.md`（若不存在则自动回退读取上一版本的文件名，并在注入时提示重命名），经 `agent.inject` 以 user 消息注入（logged channel，随历史保留）；`#条目名` 定向召回经 `session/event` 监听注入。

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
lib/memload.js   # 项目记忆纯逻辑：分节/# 召回/截断/注入块渲染
lib/memfile.js   # memory/*.md 记忆文档纯逻辑（分节/条目/项目记忆文件追加器）
lib/redact.js    # 密钥/令牌脱敏（写入记忆前）
lib/digest.js    # 摘要净化与截断
lib/index.js     # host 插件：设置注册、工具、摘要、session-start 注入、# 召回、pre-execute 接线
lib/client.js    # 浏览器卡片：设置 → 插件 的启用/禁用开关
cordis.patch.yml # bundle 补丁：将 host 行插入 profile 组成
```

## 许可

MIT
