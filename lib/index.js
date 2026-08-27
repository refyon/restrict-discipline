// lib/index.js — restrict-discipline：DSH 行为规范插件（Host 半边）。
//
// 通过 bundle patch（cordis.patch.yml）作为 host 行加载，进程级常驻；设置菜单
// 中可在“插件”页启用/禁用（命名空间 restrict-discipline.enabled）。规则核心在
// lib/enforce.js（无依赖，便于测试）。
//
// 规则（1–7 强制，8–12 Token 节约软约束，不拦截）：
//   1. 禁止在项目根目录创建文件
//   2. 禁止访问/修改/删除项目根目录下的 .env
//   3. 禁止修改系统代理设置或 git/npm 等工具的 proxy 配置
//   4. 操作留痕：record_operation 把执行过的操作保存为 scripts/<会话名>/ 下可双击脚本
//   5. 修改/删除项目目录外的文件需用户确认（只读默认放行）
//   6. 会话摘要：轮次结束自动把会话总结写入 memory/<会话名>.txt（覆盖旧摘要）
//   7. grep/glob 遍历时排除 .env
//   8. 长输出落盘：大输出先重定向到 log/，再按需 grep/read
//   9. 按需读取：大文件用 offset/limit 分段读，不重复整读
//  10. 合并命令：独立小命令合并为一次 pwsh 调用，工具调用并行发出
//  11. 简洁回复：不重复规则原文、不整段贴输出
//  12. 检索节制：优先本地信息，web_search 用精确关键词

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { buildEnforcer } from './enforce.js'
import { searchScripts } from './search.js'
import { isNoise, textOf, clip, pickScriptLines } from './digest.js'

export const name = 'restrict-discipline'

// 硬依赖声明：确保本行在这些服务激活后才 apply。Cordis 的 ctx.get(name, strict=true)
// 只在提供服务的 fiber 处于 ACTIVE 状态时返回值；若不声明 inject，本行可能先于
// tools/sandboxPolicy 等激活而 apply，导致 ctx.get('tools') 返回 undefined、
// 工具注册块被整体跳过（enforce 等 ctx.on 监听仍生效，造成"规则生效但工具不可见"）。
export const inject = ['tools', 'systemPrompt', 'fs', 'sandboxPolicy', 'sessionTitle']

/** 设置命名空间：enabled=false 时全部规则暂停。 */
const NS = settingsNamespace('restrict-discipline')
const Schema = z.object({
  enabled: z.boolean().default(true),
})

const RULES_TEXT = '【行为规范 - 由 restrict-discipline 插件强制，可在设置→插件中关闭】\n'
  + '1. 文件分类：新建文件必须按功能放入对应目录（脚本→scripts/，日志→log/，文档→docs/，记忆→memory/ 等）。禁止在项目根目录直接创建任何新文件（包括 README、.gitignore 等点文件）；插件会拦截这类写入，请主动把文件放到子目录。\n'
  + '2. .env 保护：禁止读取、修改、删除或搜索项目根目录下的 .env 文件，也禁止在命令中引用它（如 Get-Content .env、git diff .env）。插件会拦截所有针对根目录 .env 的访问并记录到 log/ 目录；一旦发生拦截，你必须立即在回复中告知用户发生了什么、是哪个工具触发的。\n'
  + '3. 代理设置：禁止修改系统代理设置以及 git、npm、yarn、pnpm、pip 等工具的 proxy 配置（如 git config http.proxy、npm config set proxy、$env:http_proxy、netsh winhttp set proxy 等），插件会拦截这类命令。\n'
  + '4. 操作留痕与复用：执行有实际效果的操作（安装依赖、构建、写文件、git 提交、网络请求、批处理等）前，先调用 find_operation 按关键词检索 scripts/ 下是否已有相同脚本；命中则直接运行已有脚本复用（省去重复执行与记录），未命中再执行，完成后调用 record_operation 把实际命令保存为 scripts/<会话名>/ 下可双击运行的脚本（提供 command、description，必要时 workdir）。通用流程（发布、构建、CI 触发、安装等）首次执行必记录，后续会话优先复用。纯查询命令（dir、git status、Get-Process 等）不需要记录。\n'
  + '5. 目录外确认：当需要修改或删除项目目录以外的文件（write/edit 工具，或 pwsh 的写入/删除命令）时，插件会弹出确认请求，你应等待用户确认后再继续；只读访问（read/grep/glob/读取命令）默认放行，无需确认。\n'
  + '6. 会话摘要与跨会话复用：每轮对话结束时，插件自动把当前会话总结写入 memory/<会话名>.txt（覆盖旧摘要），其中包含本会话已记录脚本清单，并自动过滤运行时噪音（runtime context 快照、system-reminder、checkpoint 等）。新开启的会话开始时，应先读取 memory/ 目录下相关历史摘要（可用 glob memory/*.txt 或 read 打开），了解之前会话的执行经验与可复用脚本；执行相同操作前先调用 find_operation 检索 scripts/ 下是否已有脚本，命中则直接复用。\n'
  + '7. 使用 grep/glob 遍历项目内容时，应主动排除 .env 文件，避免间接访问。\n'
  + '【Token 节约（软约束，保持能力不变，不拦截）】\n'
  + '8. 长输出落盘：命令可能产生大量输出时，先重定向到 log/<会话名>/ 下的文件（如 ... | Out-File log/xxx.txt），再按需 grep/read 关键片段；不要把整段大输出带入上下文。\n'
  + '9. 按需读取：读取大文件用 offset/limit 限定范围，先 grep 定位再读；同一文件内容未变时不要重复整读（直接复用本次已读内容）。\n'
  + '10. 合并命令：多个独立小命令合并为一次 pwsh 调用（用 ; 分隔），同批独立工具调用一次性并行发出，减少轮次与重复输出。\n'
  + '11. 简洁回复：回复用要点式短句，不重复规则原文、不整段回显命令输出（必要时只引文件名加一行结果），避免冗长表格与重复解释。\n'
  + '12. 避免重复验证：已确认过且无变化的状态（git status/log、已读文件内容）不重复执行与读取；确需复验时合并成一条命令完成。\n'
  + '13. 批量编辑：同一文件的多次小修改合并为一次 read + 多次 edit，不反复整读；相关改动合并为一次 git 提交，不为每个微调单独提交推送。\n'
  + '14. 失败收敛：同一目标操作因沙箱/环境失败时，最多尝试 2 种替代方式，之后停止并询问用户或改策略，不无限换命令重试。'

export function apply(ctx) {
  const fsSvc = ctx.get('fs')
  const policySvc = ctx.get('sandboxPolicy')
  const sp = ctx.get('systemPrompt')
  const titleSvc = ctx.get('sessionTitle')
  const tools = ctx.get('tools')

  let seq = 0
  let settingsScope

  // ---- 设置命名空间（设置菜单开关写入这里） ----
  try {
    const settingsSvc = ctx.get('settings')
    if (settingsSvc !== undefined) {
      settingsScope = settingsSvc.register(NS, Schema)
    }
  } catch (e) {
    // 没有 settings 提供者（罕见部署）时仅作“始终启用”处理
  }
  const enabled = () => {
    try {
      const snap = settingsScope ? settingsScope.get() : undefined
      const raw = snap && typeof snap === 'object' && 'value' in snap ? snap.value : snap
      return raw && typeof raw.enabled === 'boolean' ? raw.enabled : true
    } catch (e) {
      return true
    }
  }

  // ---- 路径/会话辅助 ----
  const join = (a, b) => {
    const base = String(a)
    return base.endsWith('\\') || base.endsWith('/') ? base + String(b) : base + '\\' + String(b)
  }
  const normalizePath = (p) => String(p).replace(/[\\/]+$/, '').replace(/\//g, '\\')
  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200)
  const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const slugify = (cmd) => {
    const first = String(cmd).trim().split(/\s+/)[0] || 'op'
    const slug = first.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    return (slug || 'op').slice(0, 24)
  }
  const sanitizeName = (s) => {
    const cleaned = String(s).replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/^[\s.\-]+|[\s.\-]+$/g, '')
    return cleaned.length === 0 ? 'session' : cleaned.slice(0, 60)
  }
  const rootOf = (agent) => {
    let root
    try {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      if (typeof cwd === 'string' && cwd.length > 0) root = cwd
    } catch (e) { /* ignore */ }
    if (!root && policySvc) root = policySvc.workspaceRoot
    if (!root) return undefined
    return normalizePath(root)
  }
  const sessionNameOf = (agent) => {
    try {
      if (titleSvc && agent && agent.session) {
        const snap = titleSvc.get(agent.session)
        if (snap && typeof snap.title === 'string' && snap.title.length > 0) return sanitizeName(snap.title)
      }
    } catch (e) { /* ignore */ }
    return agent && agent.id ? sanitizeName(String(agent.id)) : 'session'
  }
  const policyFor = (agent) => (policySvc && agent && agent.session
    ? policySvc.resolve({ session: agent.session })
    : (policySvc ? policySvc.resolve() : undefined))

  const writeFile = async (absPath, content, root, agent) => {
    if (!fsSvc || !policySvc) throw new Error('fs/sandboxPolicy service unavailable')
    const policy = policyFor(agent)
    if (!policy) throw new Error('无法解析沙箱策略')
    const target = await fsSvc.resolve(absPath, { cwd: root })
    await fsSvc.writeText(target, content, undefined, undefined, policy)
  }
  const appendLog = async (agent, file, line) => {
    if (!fsSvc || !policySvc) return
    try {
      const root = rootOf(agent)
      if (!root) return
      const policy = policyFor(agent)
      if (!policy) return
      const dir = join(root, 'log\\' + sessionNameOf(agent))
      const target = await fsSvc.resolve(join(dir, file), { cwd: root })
      let existing = ''
      try { existing = await fsSvc.readText(target) } catch (e) { /* first write */ }
      await fsSvc.writeText(target, existing + '[' + new Date().toISOString() + '] ' + line + '\r\n', undefined, undefined, policy)
    } catch (err) {
      console.error('[restrict-discipline] appendLog failed:', String(err && err.message || err))
    }
  }

  // ---- 规则 1/2/3/5：pre-execute 裁决 ----
  const enforce = buildEnforcer({
    fs: fsSvc,
    sandboxPolicy: policySvc,
    sessionTitle: titleSvc,
    rootOf,
    sessionNameOf,
    log: appendLog,
    enabled,
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const decision = await enforce(exec)
      if (decision) return decision
    } catch (err) {
      console.error('[restrict-discipline] pre-execute error:', String(err && err.message || err))
    }
    return next()
  })

  // ---- 规则 6：轮次结束自动生成会话摘要（status -> idle） ----
  ctx.on('agent/status', (payload) => {
    try {
      if (!enabled()) return
      const agent = payload && payload.agent
      if (!agent || !payload || payload.status !== 'idle') return
      void (async () => {
        try {
          await writeMemory(agent, await buildDigest(agent))
        } catch (err) {
          console.error('[restrict-discipline] auto digest failed:', String(err && err.message || err))
        }
      })()
    } catch (err) {
      console.error('[restrict-discipline] status listener error:', String(err && err.message || err))
    }
  })

  // ---- 规则 6 辅助 ----
  // 摘要净化：消息截断（150 字符）、噪音过滤（runtime context / system-reminder / checkpoint）、
  // 脚本清单去重，均来自 lib/digest.js（纯逻辑，可独立测试）。
  const buildDigest = async (agent) => {
    let id = 'unknown'
    let title = 'session'
    let userCount = 0
    let assistantCount = 0
    let toolCount = 0
    const recent = []
    try {
      const session = agent && agent.session
      if (session && session.id) id = String(session.id)
      title = sessionNameOf(agent)
      const events = session && session.events ? [...session.events] : []
      for (const ev of events) {
        if (!ev || typeof ev.type !== 'string') continue
        if (ev.type === 'user/message') {
          const t = textOf(ev.data && ev.data.content)
          if (isNoise(t)) continue
          userCount++
          if (t) recent.push('[用户] ' + clip(t))
        } else if (ev.type === 'assistant/message') {
          assistantCount++
          const t = textOf(ev.data && ev.data.message && ev.data.message.content)
          if (t) recent.push('[助手] ' + clip(t))
        } else if (ev.type === 'tool/result') {
          toolCount++
        }
      }
    } catch (e) { /* ignore */ }
    const lines = recent.slice(-6)
    // 读取本会话 scripts/<会话名>/index.md 的脚本清单，方便新会话复用（已去重）
    let scriptLines = []
    try {
      const root = rootOf(agent)
      if (fsSvc && root) {
        const idxPath = join(root, 'scripts\\' + sessionNameOf(agent) + '\\index.md')
        const target = await fsSvc.resolve(idxPath, { cwd: root })
        const idx = await fsSvc.readText(target)
        scriptLines = pickScriptLines(idx)
      }
    } catch (e) { /* 无 index.md */ }
    return '# 会话摘要 — ' + title + '\n'
      + '会话 ID: ' + id + '\n'
      + '更新时间: ' + new Date().toISOString() + '\n'
      + '摘要来源: restrict-discipline 自动生成\n'
      + '\n消息统计：用户 ' + userCount + ' 条 / 助手 ' + assistantCount + ' 条 / 工具调用 ' + toolCount + ' 次\n'
      + (scriptLines.length > 0
        ? '\n本会话已记录脚本（可复用，见 scripts/' + sessionNameOf(agent) + '/）：\n' + scriptLines.join('\n') + '\n'
        : '')
      + '\n最近对话（最多 6 条）：\n'
      + (lines.length > 0 ? lines.join('\n\n') : '(无)') + '\n'
  }
  const writeMemory = async (agent, content) => {
    const root = rootOf(agent)
    if (!fsSvc || !policySvc || !root) return false
    const file = join(root, 'memory\\' + sessionNameOf(agent) + '.txt')
    await writeFile(file, content, root, agent)
    return true
  }

  // ---- 规则 4 + 6：工具（仅启用时可用） ----
  if (tools !== undefined) {
    const requireEnabled = (toolName) => {
      if (!enabled()) throw new Error('restrict-discipline 已被禁用（设置 → 插件 → restrict-discipline 开启后可用）')
    }

    // ---- 规则 4：执行前检索可复用的已记录脚本 ----
    ctx.effect(() => tools.register({
      name: 'find_operation',
      description: '在 scripts/ 目录（含各会话子目录）下按关键词检索是否已有相同/相似的已记录操作脚本，便于复用：命中则直接运行已有脚本（省去重复执行与重复记录，节省 token）。执行有实际效果的操作前先调用本工具：keyword 传命令或描述中的关键词（如 build、install、git、push），返回匹配脚本的会话目录、文件名、描述与命令预览。未命中再执行操作，完成后用 record_operation 记录。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '检索关键词，匹配脚本描述或命令内容' },
        },
        required: ['keyword'],
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: String(value) }] },
      },
      async execute(args, exec) {
        requireEnabled('find_operation')
        const agent = exec && exec.agent
        const root = rootOf(agent)
        if (!fsSvc || !policySvc || !root) {
          throw new Error('find_operation 不可用：缺少 fs/sandboxPolicy 服务或无法确定工作目录')
        }
        const keyword = String(args.keyword || '').trim()
        if (!keyword) throw new Error('keyword 不能为空')
        const { count, matches } = await searchScripts({
          resolve: (p, o) => fsSvc.resolve(p, o),
          listDir: (t) => fsSvc.listDir(t),
          readText: (t) => fsSvc.readText(t),
          cwd: root,
          keyword,
          limit: 8,
        })
        if (count === 0) {
          return '未找到与 "' + keyword + '" 匹配的已记录脚本。请执行该操作后调用 record_operation 记录，便于下次复用。'
        }
        const lines = matches.map((m, i) =>
          (i + 1) + '. scripts\\' + m.session + '\\' + m.base + '.cmd'
          + '\n   描述: ' + (m.description || '(无)')
          + '\n   命令: ' + (m.command || '(无)'))
        return '找到 ' + count + ' 个匹配脚本（显示前 ' + Math.min(8, count) + ' 个）：\n'
          + lines.join('\n')
          + '\n\n复用方式：用 pwsh 运行 scripts\\<会话>\\<文件名>.cmd（或双击）。'
      },
    }))

    ctx.effect(() => tools.register({
      name: 'record_operation',
      description: '把刚完成的一个有实际效果的操作保存为可双击运行的脚本，存入 scripts/<会话名>/ 目录（同时生成同名 .cmd 与 .ps1，.cmd 双击即运行 .ps1，并维护 index.md）。每次完成安装、构建、写文件、git 提交、网络操作等有实际效果的任务后都应调用本工具记录：command 传实际执行的命令原文，description 说明用途，workdir 传命令执行时的工作目录（可选，默认项目根目录）。纯查询命令（dir、git status、Get-Process 等）不需要记录。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          workdir: { type: 'string' },
        },
        required: ['command', 'description'],
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: String(value) }] },
      },
      async execute(args, exec) {
        requireEnabled('record_operation')
        const agent = exec && exec.agent
        const root = rootOf(agent)
        if (!fsSvc || !policySvc || !root) {
          throw new Error('record_operation 不可用：缺少 fs/sandboxPolicy 服务或无法确定工作目录')
        }
        const command = String(args.command || '').trim()
        if (!command) throw new Error('command 不能为空')
        const description = String(args.description || '').trim() || '(无描述)'
        const workdir = typeof args.workdir === 'string' && args.workdir.trim().length > 0 ? args.workdir.trim() : root
        const sName = sessionNameOf(agent)
        const dir = join(root, 'scripts\\' + sName)
        const base = stampNow() + '-' + String(++seq).padStart(2, '0') + '-' + slugify(command)
        const iso = new Date().toISOString()

        const ps1 = '# ' + oneLine(description) + '\n'
          + '# recorded at ' + iso + ' by restrict-discipline\n'
          + 'Set-Location -LiteralPath "' + String(workdir).replace(/"/g, '`"') + '"\n'
          + command + '\n'
        const cmd = '@echo off\r\n'
          + 'rem ' + oneLine(description) + '\r\n'
          + 'pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + base + '.ps1"\r\n'
          + 'pause\r\n'

        await writeFile(join(dir, base + '.ps1'), ps1, root, agent)
        await writeFile(join(dir, base + '.cmd'), cmd, root, agent)

        const idxPath = join(dir, 'index.md')
        let existing = ''
        try {
          const t = await fsSvc.resolve(idxPath, { cwd: root })
          existing = await fsSvc.readText(t)
        } catch (e) { /* first entry */ }
        const header = existing.length === 0 ? '# 会话脚本索引\n\n本目录下每个 .cmd 双击即可运行（会调用同名的 .ps1）。\n\n' : ''
        await writeFile(idxPath, header + existing + '- [' + base + '.cmd](' + base + '.cmd) — ' + oneLine(description) + '\n', root, agent)

        return '已将操作保存为可双击运行的脚本：\n'
          + 'scripts\\' + sName + '\\' + base + '.cmd\n'
          + '（同名 .ps1 与 index.md 已一并生成）\n'
          + '说明：' + oneLine(description)
      },
    }))
  }

  // ---- 系统提示中的行为规范章节（禁用时为空） ----
  if (sp) {
    ctx.effect(() => sp.section({
      name: 'restrict-discipline',
      order: 90,
      text: () => (enabled() ? RULES_TEXT : ''),
    }))
  }
}
