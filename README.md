# restrict-discipline

DSH（DeepSeek Harness）行为规范插件：约束 Agent 的文件操作与系统行为，保护敏感配置，降低上下文 Token 消耗。可在 **设置 → 插件** 中一键启用/禁用。

## 功能

### 强制约束（违规自动拦截）

| # | 规则 | 说明 |
|---|------|------|
| 1 | 文件分类 | 新建文件必须放入对应目录（`scripts/`、`log/`、`docs/`、`memory/` 等），禁止在项目根目录创建文件 |
| 2 | `.env` 保护 | 禁止读取/修改/删除/搜索项目根目录的 `.env`；违规访问被拦截并记录到 `log/<会话名>/env-access.log` |
| 3 | 代理保护 | 禁止修改系统代理及 git/npm/yarn/pnpm/pip 的 proxy 配置；违规命令被拦截并记录到 `log/<会话名>/denials.log` |
| 4 | 操作留痕与复用 | 执行有实际效果的操作前先用 `find_operation` 按关键词检索 `scripts/` 是否已有相同脚本，命中则直接运行复用；未命中再执行，并用 `record_operation` 保存为 `scripts/<会话名>/` 下可双击运行的脚本（`.cmd` + `.ps1`），维护 `index.md` 索引 |
| 5 | 目录外确认 | 修改/删除项目目录以外的文件时请求用户确认；只读访问默认放行 |
| 6 | 会话摘要与跨会话复用 | 每轮对话结束自动将会话总结（含本会话已记录脚本清单）写入 `memory/<会话名>.txt`（覆盖旧摘要）；新会话开始时先读取历史摘要，复用之前会话执行过的脚本（配合规则 4 的 `find_operation`） |
| 7 | 遍历排除 | `grep`/`glob` 遍历项目内容时主动排除 `.env` |

### Token 节约（软约束，不拦截）

| # | 规则 | 说明 |
|---|------|------|
| 8 | 长输出落盘 | 大输出先重定向到 `log/<会话名>/`，再按需 grep/read 关键片段 |
| 9 | 按需读取 | 大文件用 `offset`/`limit` 分段读取，先 grep 定位；内容未变不重复整读 |
| 10 | 合并命令 | 独立命令合并为一次 pwsh 调用（`;` 分隔），独立工具调用并行发出 |
| 11 | 简洁回复 | 要点式短句，不重复规则原文、不整段回显命令输出 |
| 12 | 避免重复验证 | 状态未变化时不重复执行/读取；确需复验时合并为一条命令 |

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:refyon/restrict-discipline
```

其他 profile（`tui`、`headless` 等）将 `web` 替换为目标 profile 名即可：

```bash
dsh plugin --profile <profile> add github:refyon/restrict-discipline
```

## 启用 / 禁用

1. 打开 Web UI → **设置 → 插件**
2. 找到 **restrict-discipline（行为规范）** 卡片：勾选 = 启用（默认），取消勾选 = 禁用
3. 配置写入命名空间 `restrict-discipline.enabled`（`$DSH_HOME/settings.yaml`）

禁用后所有拦截/确认/留痕/摘要行为暂停；工具仍可见，但调用会提示已禁用。

## 行为说明

- **目录外修改**：`write`/`edit` 工具及 pwsh 写入/删除命令（`New-Item`、`Set-Content`、`Out-File`、`Copy-Item`、`Move-Item`、`Remove-Item`、重定向等）目标在项目目录外时请求确认；
- **只读放行**：`read`/`read_image`/`grep`/`glob`/`Get-Content` 等只读操作默认放行，不打扰。

## 开发

```bash
# 规则核心冒烟测试（零依赖）
node test/smoke-host.mjs
```

### 目录结构

```
lib/enforce.js   # 规则核心（纯逻辑、无依赖、可独立测试）
lib/index.js     # host 插件：设置注册、工具、摘要、pre-execute 接线
lib/client.js    # 浏览器卡片：设置 → 插件 的启用/禁用开关
cordis.patch.yml # bundle 补丁：将 host 行插入 profile 组成
```

## 许可

MIT
