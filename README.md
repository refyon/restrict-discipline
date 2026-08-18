# restrict-discipline

DSH（DeepSeek Harness）行为规范插件：约束 Agent 的文件操作与系统行为，并可在 **设置 → 插件** 中一键启用/禁用。

## 功能（7 条规则）

1. **文件分类** — 新建文件必须放入对应目录（脚本 → `scripts/`，日志 → `log/`，文档 → `docs/`，记忆 → `memory/`）；禁止在项目根目录直接创建文件（write 工具与 pwsh 写入都会被拦截）。
2. **.env 保护** — 禁止读取/修改/删除/搜索项目根目录下的 `.env`；任何尝试被拦截并记录到 `log/<会话名>/env-access.log`，并提示助手告知用户。
3. **代理保护** — 禁止修改系统代理设置及 git/npm/yarn/pnpm/bun/pip 的 proxy 配置（含 `git config http.proxy`、`npm config set proxy`、`$env:http_proxy`、`netsh winhttp set proxy` 等），记录到 `log/<会话名>/denials.log`。
4. **操作留痕** — 提供 `record_operation` 工具：把有实际效果的操作保存为 `scripts/<会话名>/` 下**可双击运行**的 `.cmd`（调用同名 `.ps1`），并维护 `index.md` 索引。
5. **目录外确认** — 修改/删除项目目录以外的文件时弹出确认（ask）；**只读访问默认放行**（`read`/`grep`/`glob`/读取命令不打扰）。
6. **会话摘要** — 每轮对话结束时自动把会话总结写入 `memory/<会话名>.txt`（覆盖旧摘要）。
7. **遍历排除** — 使用 `grep`/`glob` 遍历项目内容时主动排除 `.env`。

## 安装

```bash
# 从 npm 安装
dsh plugin --profile web add restrict-discipline

# 或直接从 GitHub 安装
dsh plugin --profile web add github:<你的用户名>/restrict-discipline
```

> 其他 profile（`tui`、`headless` 等）同理：`dsh plugin --profile <name> add restrict-discipline`。

## 启用 / 禁用

打开 Web UI → **设置 → 插件**，找到 **restrict-discipline（行为规范）** 卡片：

- 勾选 = 启用（默认），7 条规则全部生效；
- 取消勾选 = 禁用，所有拦截/确认/留痕/摘要行为暂停（工具仍可见，但调用会提示已禁用）。

开关写入设置命名空间 `restrict-discipline.enabled`（`$DSH_HOME/settings.yaml`）。

## 目录外修改确认

- `write` / `edit` 工具、或 pwsh 的写入/删除命令（`New-Item`、`Set-Content`、`Out-File`、`Copy-Item`、`Move-Item`、`Remove-Item`、重定向等）目标在项目目录外 → 弹出确认；
- 只读（`read` / `read_image` / `grep` / `glob` / `Get-Content` 等）默认放行。

## 开发

```bash
# 规则核心冒烟测试（零依赖，无需安装任何东西）
node test/smoke-host.mjs
```

### 结构

```
lib/enforce.js   # 规则核心（纯逻辑、无依赖，可独立测试）
lib/index.js     # host 插件：设置注册、工具、摘要、pre-execute 接线
lib/client.js    # 浏览器卡片：设置 → 插件 中的启用/禁用开关
cordis.patch.yml # bundle 补丁：把 host 行插入 profile 组成
```

本插件不发布任何服务（无 `ctx.provide`），因此无需 `isolate` realm；其工具注册、设置命名空间、系统提示章节与事件监听都落在 host 作用域，覆盖所有会话。

## 许可

MIT
