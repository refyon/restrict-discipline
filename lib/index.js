// lib/index.js — restrict-discipline：DSH 行为规范插件（Host 半边）。
//
// 通过 bundle patch（cordis.patch.yml）作为 host 行加载，进程级常驻；设置菜单
// 中可在“插件”页启用/禁用（命名空间 restrict-discipline.enabled）。规则核心在
// lib/enforce.js（无依赖，便于测试）。
//
// 规则（v0.6 起固定 4 条主规则，原 16 条细规则收编为子项；文本见 lib/rules.js）：
//   1. 强制约束（1.1 文件分类 1.2 .env 保护 1.3 代理保护 1.4 操作留痕与复用
//                  1.5 目录外确认 1.6 会话摘要 1.7 遍历排除）—— tools/pre-execute 拦截
//   2. Token 节约（2.1–2.7 长输出落盘/按需读取/合并命令/简洁回复/避免重复验证/批量编辑/失败收敛）—— 纯文本引导
//   3. 会话记忆（3.1 CLAUDE.md 启动自动加载 3.2 # 快捷召回 3.3 会话摘要 3.4 remember 便捷追加）
//      —— v0.7 起参考 Claude Code 的 CLAUDE.md 机制：「文件即记忆、确定性加载、手动召回」，
//      删除 v0.6 的 BM25 检索注入（lib/memory.js 检索层与 5 个检索/管理工具已移除）
//   4. 编码纪律（Karpathy 准则）

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { buildEnforcer } from './enforce.js'
import { searchScripts } from './search.js'
import { isNoise, textOf, clip, pickScriptLines } from './digest.js'
import { renderLoadBlock, recallSections, detectShortcuts, renderRecallBlock, DEFAULT_MAX_CHARS } from './memload.js'
import { RULES_TEXT } from './rules.js'
import { splitFile, rebuildFile, appendMemoryEntry, entryLine } from './memfile.js'
import { redactSecrets } from './redact.js'

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
  memoryTools: z.boolean().default(true), // remember 工具开关（3.4）
  autoLoad: z.boolean().default(true), // 会话启动自动加载 memory/CLAUDE.md（3.1）
  maxLoadChars: z.number().default(DEFAULT_MAX_CHARS), // 自动加载注入上限（字符，默认约 25KB）
  shortcutRecall: z.boolean().default(true), // 用户消息「#条目名」定向召回开关（3.2）
})

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
  const cfg = (key, dflt) => {
    try {
      const snap = settingsScope ? settingsScope.get() : undefined
      const raw = snap && typeof snap === 'object' && 'value' in snap ? snap.value : snap
      const v = raw && typeof raw === 'object' ? raw[key] : undefined
      if (typeof v === 'boolean') return v
      if (typeof v === 'number' && Number.isFinite(v)) return v
    } catch (e) { /* 兜底默认值 */ }
    return dflt
  }
  const enabled = () => cfg('enabled', true)

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

  // ---- v0.6 memory/*.md 记忆库（规则 3）----
  // 记忆文件统一为 Markdown 文档：memory/<会话id>_<标题前24字>.md。
  // 全部读写经进程内写锁串行，避免 digest(规则 1.6) 与 remember/forget/GC 并发写竞态。
  let memSeq = 0
  const memQueue = { p: Promise.resolve() }
  const memLock = (fn) => {
    const r = memQueue.p.then(fn, fn)
    memQueue.p = r.then(() => {}, () => {})
    return r
  }
  const memoryNameOf = (agent) => {
    // 稳定会话 id（session.header.id，跨重启/恢复不丢）作前缀，标题只作可读后缀：
    // 标题漂移/会话改名不会造成摘要孤儿。
    const title = sessionNameOf(agent)
    let sid = ''
    try {
      const s = agent && agent.session && agent.session.id
      if (typeof s === 'string' && s.length > 0 && s !== 'session') sid = sanitizeName(s)
    } catch (e) { /* ignore */ }
    return sid ? sid + '_' + String(title).slice(0, 24) : title
  }
  const memAbsOf = async (agent, name) => {
    const root = rootOf(agent)
    if (!fsSvc || !root) return null
    return fsSvc.resolve(join(root, 'memory\\' + name), { cwd: root })
  }
  const readMemFile = async (agent, name) => {
    try {
      const a = await memAbsOf(agent, name)
      if (!a) return ''
      return await fsSvc.readText(a)
    } catch (e) { return '' }
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

  // ---- 规则 1.6：轮次结束自动生成会话摘要（status -> idle） ----
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

  // ---- 规则 1.6 辅助 ----
  // 摘要净化：消息截断（150 字符）、噪音过滤（runtime context / system-reminder / checkpoint）、
  // 脚本清单去重，均来自 lib/digest.js（纯逻辑，可独立测试）。
  const buildDigest = async (agent) => {
    let title = 'session'
    let userCount = 0
    let assistantCount = 0
    let toolCount = 0
    const recent = []
    try {
      const session = agent && agent.session
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
    const sid = (() => {
      try { return agent && agent.session && agent.session.id || title } catch (e) { return title }
    })()
    let digest = '# 会话摘要 — ' + title + '\n'
      + '\n> 会话: ' + sid + ' · 更新: ' + new Date().toISOString() + '\n'
      + '\n## 消息统计\n\n用户 ' + userCount + ' 条 / 助手 ' + assistantCount + ' 条 / 工具调用 ' + toolCount + ' 次\n'
      + (scriptLines.length > 0
        ? '\n## 脚本清单（可复用，见 scripts/' + sessionNameOf(agent) + '/）\n\n' + scriptLines.join('\n') + '\n'
        : '')
      + '\n## 最近对话\n\n' + (lines.length > 0 ? lines.join('\n\n') : '(无)') + '\n'
    return digest
  }
  const writeMemory = async (agent, content) => {
    const root = rootOf(agent)
    if (!fsSvc || !policySvc || !root) return false
    // 覆盖式摘要 + 保留「记忆条目/已归档条目」分节（remember/forget 的沉淀不丢）
    return memLock(async () => {
      const name = memoryNameOf(agent) + '.md'
      const old = await readMemFile(agent, name)
      const s = splitFile(old)
      const text = rebuildFile({ digest: [String(content).trim()], entries: s.entries, archived: s.archived })
      await writeFile(join(root, 'memory\\' + name), text, root, agent)
      return true
    })
  }

  // ---- 规则 3.1：会话启动自动加载项目记忆 memory/CLAUDE.md ----
  // v0.7 起替代 v0.6 的 system-prompt/assemble BM25 检索注入（claude-code 式确定性加载）：
  // agent/session-start 在 fresh 与 resume 均触发，每次会话生命周期加载一次——
  // 读 memory/CLAUDE.md → agent.inject() 以 user 消息注入（logged channel，随历史保留；
  // 框架同类先例：dsh-session 文档明示 agent.inject() 用于 subdir AGENTS.md 等合成上下文）。
  // 路径固定为 memory/CLAUDE.md（官方教训 issue #36973：记忆路径由系统注入，不让模型猜）。
  // global:true 与旧 system-prompt/assemble 相同理由：host 层监听 agent-scoped 事件必须 global。
  ctx.on('agent/session-start', (payload) => {
    try {
      if (!enabled() || !cfg('autoLoad', true)) return
      const agent = payload && payload.agent
      if (!agent || typeof agent.inject !== 'function' || !agent.session) return
      const sid = String(agent.session.id || 's')
      void (async () => {
        try {
          const root = rootOf(agent)
          if (!root || !fsSvc) return
          const text = await readMemFile(agent, 'CLAUDE.md')
          if (!String(text || '').trim()) return
          const block = renderLoadBlock(text, cfg('maxLoadChars', DEFAULT_MAX_CHARS))
          if (!block) return
          agent.inject({
            id: 'rd-memory-load-' + sid + '-' + Date.now(),
            role: 'user',
            content: [{ type: 'text', text: block }],
            source: { kind: 'plugin', plugin: 'restrict-discipline', form: 'instructions' },
          })
        } catch (err) {
          console.error('[restrict-discipline] memory auto-load failed:', String(err && err.message || err))
        }
      })()
    } catch (err) {
      console.error('[restrict-discipline] session-start listener error:', String(err && err.message || err))
    }
  }, { global: true })

  // ---- 规则 3.2：# 快捷召回 ----
  // 用户消息含「#条目名」时，把 memory/CLAUDE.md 中对应一级标题区块注入会话表面
  // （Claude Code memory shortcuts 机制，issue #14743 佐证）。
  // 只对真实用户输入（source.kind === 'user'）检测，避免对插件自身注入内容递归召回。
  ctx.on('session/event', (session, event) => {
    try {
      if (!enabled() || !cfg('shortcutRecall', true)) return
      if (!event || event.type !== 'user/message') return
      const msg = event.data
      if (!msg || !msg.source || msg.source.kind !== 'user') return
      const tokens = detectShortcuts(textOf(msg.content))
      if (tokens.length === 0) return
      void (async () => {
        try {
          const cwd = session && session.header && session.header.cwd
          if (!cwd || !fsSvc) return
          const root = normalizePath(cwd)
          const target = await fsSvc.resolve(join(root, 'memory\\CLAUDE.md'), { cwd: root })
          let content = ''
          try { content = await fsSvc.readText(target) } catch (e) { return }
          const hits = []
          for (const t of tokens) hits.push.apply(hits, recallSections(content, t))
          if (hits.length === 0) return
          const block = renderRecallBlock(hits, tokens.join('、'))
          if (typeof session.append !== 'function') return
          session.append('user/message', {
            id: 'rd-memory-recall-' + (session.id || 's') + '-' + Date.now(),
            role: 'user',
            content: [{ type: 'text', text: block }],
            source: { kind: 'plugin', plugin: 'restrict-discipline', form: 'recall' },
          }, { surfaceOp: 'append' })
        } catch (err) {
          console.error('[restrict-discipline] shortcut recall failed:', String(err && err.message || err))
        }
      })()
    } catch (err) {
      console.error('[restrict-discipline] session/event listener error:', String(err && err.message || err))
    }
  })

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

    // ---- 规则 3.4：remember —— 追加到 memory/CLAUDE.md「## 记忆条目」分节 ----
    // v0.7 起项目记忆收敛为单文件 memory/CLAUDE.md（claude-code 式「文件即记忆」）：
    // 该文件每次会话启动自动注入（规则 3.1），agent 可直接 read/edit 维护；
    // remember 是唯一保留的记忆工具，写入路径固定（杜绝模型猜路径——官方教训 issue #36973）。
    const reg = (def) => ctx.effect(() => tools.register(def))
    const textOut = () => ({
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    })
    const requireMem = (toolName) => {
      requireEnabled(toolName)
      if (!cfg('memoryTools', true)) {
        throw new Error('记忆工具已关闭：restrict-discipline.memoryTools=false（设置 → 插件 可开启）')
      }
    }

    reg({
      name: 'remember',
      description: '把需要长期记住的决策/偏好/结论追加到 memory/CLAUDE.md 的「## 记忆条目」分节（Markdown 项目记忆，机制参考 Claude Code 的 CLAUDE.md；该文件在每次新会话启动时自动注入上下文）。写入自动带时间戳与来源审计（会话 id · 轮次），并脱敏密钥/令牌。只记需要跨会话复用的信息；文件其余内容可用 read/edit 直接维护。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容（自动截断 500 字、自动脱敏密钥）' },
          tags: { type: 'string', description: '可选标签，逗号分隔' },
        },
        required: ['content'],
      },
      output: textOut(),
      async execute(args, exec) {
        const agent = exec && exec.agent
        requireMem('remember')
        const root = rootOf(agent)
        if (!fsSvc || !policySvc || !root) throw new Error('remember 不可用：缺少 fs/sandboxPolicy 服务或无法确定工作目录')
        const content = clip(String(args.content || '').trim(), 500)
        if (!content) throw new Error('remember：content 不能为空')
        const red = redactSecrets(content)
        let turn = 0
        try {
          const events = agent.session && agent.session.events ? [...agent.session.events] : []
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') { turn = ev.data.turn; break }
          }
        } catch (e) { /* ignore */ }
        const source = (() => { try { return agent.session.id } catch (e) { return 'session' } })()
        const id = 'mem-' + Date.now().toString(36) + '-' + String(++memSeq).padStart(3, '0')
        const iso = new Date().toISOString()
        const tags = String(args.tags || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8)
        const line = entryLine({ id, iso, content: red.text, source, turn, tags })
        return memLock(async () => {
          const text = appendMemoryEntry(await readMemFile(agent, 'CLAUDE.md'), line)
          await writeFile(join(root, 'memory\\CLAUDE.md'), text, root, agent)
          return '已记住 ' + id + ' → memory\\CLAUDE.md'
            + (red.count > 0 ? '（写入前已脱敏 ' + red.count + ' 处密钥/令牌）' : '')
            + (turn > 0 ? '（来源: ' + source + ' · 轮次 ' + turn + '）' : '')
        })
      },
    })
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
