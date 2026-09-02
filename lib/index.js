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
//   3. 会话记忆（3.1 自动注入 3.2 摘要复用 3.3 记忆工具 3.4 自动捕获 3.5 GC）
//   4. 编码纪律（Karpathy 准则）

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { buildEnforcer } from './enforce.js'
import { searchScripts, tokenize } from './search.js'
import { isNoise, textOf, clip, pickScriptLines } from './digest.js'
import { rankMemoryFiles, renderMemoryIndex, buildRecallNotice } from './memory.js'
import { RULES_TEXT } from './rules.js'
import { splitFile, rebuildFile, appendEntry, forgetEntry, purgeArchived, countEntries, entryLine } from './memfile.js'
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
  memoryTools: z.boolean().default(true), // 记忆工具组开关（3.3/3.5）
  memoryTopK: z.number().default(3), // 注入条数（3.1）
  indexMaxChars: z.number().default(700), // 注入索引块字符预算
  recallLimit: z.number().default(6), // recall_memory 默认返回条数
  gcRetentionDays: z.number().default(90), // memory_gc 已归档清理天数
})

/** 在文件正文中挑选与 query 最相关的一行（词元重叠最多者；跳过标题/引用/空行，条目行参与）。 */
const pickEvidence = (text, query) => {
  const tokens = tokenize(query)
  if (tokens.length === 0) return ''
  let best = ''
  let bestScore = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.trim()
    if (!t || t.startsWith('#') || t.startsWith('>')) continue
    const lower = t.toLowerCase()
    let score = 0
    for (const tk of tokens) if (lower.includes(tk)) score++
    if (score > bestScore) { bestScore = score; best = t }
  }
  return bestScore > 0 ? best : ''
}

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
  // 记忆文件统一为 Markdown 文档：memory/<会话id>_<标题前24字>.md（旧命名 <标题>.txt 仍兼容读取）。
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
  /** 列表 memory/ 下全部记忆文档 → [{ name, text, ts }]（.md 优先；兼容旧 .txt）。 */
  const listMemFiles = async (agent) => {
    const root = rootOf(agent)
    if (!fsSvc || !root) return []
    try {
      const dir = await fsSvc.resolve(join(root, 'memory'), { cwd: root })
      const entries = await fsSvc.listDir(dir)
      const out = []
      for (const e of entries || []) {
        if (!e || e.type !== 'file' || !/\.(md|txt)$/i.test(e.name)) continue
        try {
          const ts = typeof e.mtimeMs === 'number' ? e.mtimeMs
            : (e.mtime && typeof e.mtime.getTime === 'function' ? e.mtime.getTime()
              : (typeof e.ts === 'number' ? e.ts : 0))
          out.push({ name: e.name, text: await fsSvc.readText(e.target), ts })
        } catch (err) { /* 跳过不可读文件 */ }
      }
      return out
    } catch (e) { return [] }
  }
  /** 判断文件名是否属于当前会话自己的记忆文档（防自我回放）。 */
  const isSelfMem = (agent) => (nm) => {
    const n = String(nm).toLowerCase()
    let idPrefix = ''
    try {
      const s = agent && agent.session && agent.session.id
      if (typeof s === 'string' && s.length > 0 && s !== 'session') idPrefix = sanitizeName(s).toLowerCase()
    } catch (e) { /* ignore */ }
    if (idPrefix && n.startsWith(idPrefix + '_')) return true
    const legacy = sessionNameOf(agent).toLowerCase()
    return n === legacy + '.txt' || n === legacy + '.md'
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

  // ---- 规则 3.1：新会话首次内容解析自动注入相关历史记忆（每会话仅一次） ----
  // 挂在 system-prompt/assemble 瀑布上：首轮组装提示词时异步检索 memory/，
  // 把 Top3 摘要追加进 assembly.contexts（自动进入 Current runtime context 快照，
  // 并随会话历史保留）。按会话 id 记一次性，后续轮次直接跳过不再检索（省 token）；
  // 会话销毁时清理标记。
  // 钩子以 { global: true } 注册：本插件是 host 级插件（patch 自述"覆盖所有会话"），
  // 而 dsh-scope 对 system-prompt/assemble 的分发按 agent 作用域过滤监听器，
  // 不加 global 时该钩子在生产环境从不触发（注入块与回忆注记均缺失）。
  const memoryInjected = new Set()
  ctx.on('session/disposed', (session) => {
    try { if (session && session.id) memoryInjected.delete(session.id) } catch (e) { /* ignore */ }
  })
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      if (!enabled()) return assembled
      const agent = context && context.agent
      if (!agent || !agent.session) return assembled
      const sessionId = agent.session.id
      if (!sessionId || memoryInjected.has(sessionId)) return assembled
      const root = rootOf(agent)
      if (!root || !fsSvc) return assembled
      // 查询文本：会话中最近一条用户消息（当前任务描述）
      let query = ''
      try {
        const events = agent.session.events ? [...agent.session.events] : []
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]
          if (ev && ev.type === 'user/message') {
            query = textOf(ev.data && ev.data.content)
            if (query) break
          }
        }
      } catch (e) { /* ignore */ }
      if (!query) return assembled
      const isSelf = isSelfMem(agent)
      const files = (await listMemFiles(agent)).filter((f) => !isSelf(f.name))
      if (files.length === 0) return assembled
      const selected = rankMemoryFiles(files, query, { limit: Math.max(1, cfg('memoryTopK', 3)) })
      const block = renderMemoryIndex(selected, { maxChars: Math.max(120, cfg('indexMaxChars', 700)) })
      if (!block) return assembled
      // 成功注入才记一次性：查询为空/过短、检索无果时不消耗标记，
      // 后续轮次仍可再次尝试。修复：首轮空查询（user message 尚未进入
      // session.events 的时序竞争）会烧毁 once-flag，导致整会话不再注入。
      memoryInjected.add(sessionId)
      const contexts = Array.isArray(assembled && assembled.contexts) ? [...assembled.contexts] : []
      contexts.push({ name: 'restrict-discipline:memory', text: block })
      // 追加"回忆提示"到会话：思考块（reasoning）+ 自标注文本，让首轮思考内容可见
      try {
        const session = agent.session
        if (session && typeof session.append === 'function') {
          const events = session.events ? [...session.events] : []
          let turn = 0
          let step = 1
          let stepTurn = 0
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (!ev || typeof ev.type !== 'string') continue
            if (turn === 0 && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') turn = ev.data.turn
            if (stepTurn === 0 && ev.type === 'step/start' && ev.data && typeof ev.data.step === 'number') {
              stepTurn = ev.data.turn
              if (stepTurn === turn) step = ev.data.step + 1
            }
            if (turn !== 0 && stepTurn !== 0) break
          }
          const notice = buildRecallNotice(selected)
          session.append('assistant/message', {
            turn: turn || 1,
            step,
            message: {
              role: 'assistant',
              id: 'rd-memory-recall-' + sessionId,
              source: { kind: 'model', provider: 'restrict-discipline', model: 'memory-recall' },
              content: [
                { type: 'reasoning', text: notice.reasoning },
                { type: 'text', text: notice.text },
              ],
            },
          }, { surfaceOp: 'append' })
        }
      } catch (err) {
        console.error('[restrict-discipline] memory recall notice append failed:', String(err && err.message || err))
      }
      return { ...assembled, contexts }
    } catch (err) {
      console.error('[restrict-discipline] memory inject failed:', String(err && err.message || err))
      return assembled
    }
  }, { global: true })

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

    // ---- 规则 3.3/3.5：记忆工具（memory/*.md Markdown 记忆库）----
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
    const needFs = (toolName, agent) => {
      requireMem(toolName)
      const root = rootOf(agent)
      if (!fsSvc || !policySvc || !root) throw new Error(toolName + ' 不可用：缺少 fs/sandboxPolicy 服务或无法确定工作目录')
      return root
    }

    // remember：显式记忆（自动来源审计 + 脱敏，500 字截断）
    reg({
      name: 'remember',
      description: '把需要长期记住的决策/偏好/结论保存到 memory/<会话>.md 的「记忆条目」节（Markdown 记忆库），自动带时间戳与来源审计（会话 id · 轮次），写入前自动脱敏密钥/令牌。只记需要跨会话复用的信息，纯一次性提示不需要。',
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
        const root = needFs('remember', agent)
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
          const name = memoryNameOf(agent) + '.md'
          const text = appendEntry(await readMemFile(agent, name), line)
          await writeFile(join(root, 'memory\\' + name), text, root, agent)
          return '已记住 ' + id + ' → memory\\' + name
            + (red.count > 0 ? '（写入前已脱敏 ' + red.count + ' 处密钥/令牌）' : '')
            + (turn > 0 ? '（来源: ' + source + ' · 轮次 ' + turn + '）' : '')
        })
      },
    })

    // recall_memory：BM25 + 时间衰减 检索记忆库（渐进披露下钻）
    reg({
      name: 'recall_memory',
      description: '按关键词在 memory/*.md 记忆库检索历史（BM25 + 时间衰减，排除本会话自身摘要），返回命中文件 + 证据行。与规则 3.1 注入的【历史记忆】索引配合做下钻：索引里只有一行摘要，细节用本工具检索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词（与当前问题相关的词）' },
          limit: { type: 'number', description: '最多返回条数（默认 6，上限 10）' },
        },
        required: ['query'],
      },
      output: textOut(),
      async execute(args, exec) {
        const agent = exec && exec.agent
        const root = needFs('recall_memory', agent)
        const query = String(args.query || '').trim()
        if (!query) throw new Error('recall_memory：query 不能为空')
        const limit = Math.min(10, Math.max(1, Math.floor(Number(args.limit)) || cfg('recallLimit', 6)))
        const isSelf = isSelfMem(agent)
        const files = (await listMemFiles(agent)).filter((f) => !isSelf(f.name))
        if (files.length === 0) return 'memory/ 下暂无其他会话的记忆文档'
        const ranked = rankMemoryFiles(files, query, { limit })
        if (ranked.length === 0) return '未找到与 "' + query + '" 相关的历史记忆'
        const lines = ranked.map((f, i) => {
          const title = firstTitle(f.text)
          const ev = pickEvidence(f.text, query)
          return (i + 1) + '. memory\\' + f.name + (title ? '（' + clip(title, 60) + '）' : '')
            + '\n   证据: ' + clip(ev || '(无直接命中行，见标题/条目)', 180)
        })
        return '找到 ' + ranked.length + ' 个相关记忆文件：\n' + lines.join('\n')
      },
    })

    // forget_memory：软删除（移入「已归档条目」，可恢复）
    reg({
      name: 'forget_memory',
      description: '软删除记忆条目：按 id（如 mem-xxx）精确匹配或按内容关键词匹配，把「记忆条目」中命中的行移入「已归档条目」（不物理删除，可恢复）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆条目 id（remember 返回的 mem-xxx）' },
          query: { type: 'string', description: '内容关键词（无 id 时使用）' },
        },
        required: [],
      },
      output: textOut(),
      async execute(args, exec) {
        const agent = exec && exec.agent
        const root = needFs('forget_memory', agent)
        const byId = String(args.id || '').trim()
        const q = String(args.query || '').trim()
        if (!byId && !q) throw new Error('forget_memory：id 与 query 至少提供一个')
        const files = await listMemFiles(agent)
        const changed = []
        let moved = 0
        const ids = []
        for (const f of files) {
          const r = forgetEntry(f.text, byId || q)
          if (r.moved > 0) {
            moved += r.moved
            ids.push.apply(ids, r.ids)
            changed.push({ name: f.name, text: r.text })
          }
        }
        if (moved === 0) return '未找到匹配的记忆条目' + (byId ? '（id=' + byId + '）' : '（"' + q + '"）')
        await memLock(async () => {
          for (const c of changed) await writeFile(join(root, 'memory\\' + c.name), c.text, root, agent)
        })
        return '已软删除 ' + moved + ' 条（' + ids.join('、') + '）→ 移入「已归档条目」：' + changed.map((c) => 'memory\\' + c.name).join('、')
      },
    })

    // memory_stats：记忆库统计
    reg({
      name: 'memory_stats',
      description: '查看 memory/*.md 记忆库统计：文件数、各文件活动记忆条目数、已归档数、体积概览。',
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOut(),
      async execute(_args, exec) {
        const agent = exec && exec.agent
        needFs('memory_stats', agent)
        const files = await listMemFiles(agent)
        if (files.length === 0) return 'memory/ 下暂无记忆文档'
        const rows = files.map((f) => {
          const s = splitFile(f.text)
          return 'memory\\' + f.name + '：活动条目 ' + s.entries.length + ' / 已归档 ' + s.archived.length + '（' + f.text.length + ' 字符）'
        })
        return 'memory/ 共 ' + files.length + ' 个记忆文档：\n' + rows.join('\n')
      },
    })

    // memory_export：导出全部记忆为单个 Markdown 文档（docs/ 下）
    reg({
      name: 'memory_export',
      description: '把 memory/ 全部记忆文档合并导出为 docs/memory-export-<时间>.md（不修改原记忆），返回文件路径与条目统计。',
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOut(),
      async execute(_args, exec) {
        const agent = exec && exec.agent
        const root = needFs('memory_export', agent)
        const files = await listMemFiles(agent)
        if (files.length === 0) throw new Error('memory_export：memory/ 下暂无记忆文档')
        const stamp = stampNow()
        const iso = new Date().toISOString()
        let total = 0
        const parts = ['# 记忆导出 — ' + iso + '\n', '> 由 restrict-discipline memory_export 生成，共 ' + files.length + ' 个文档\n']
        for (const f of files) {
          const s = splitFile(f.text)
          total += s.entries.length
          parts.push('\n## memory\\' + f.name + '\n\n' + f.text.trim() + '\n')
        }
        const file = join(root, 'docs\\memory-export-' + stamp + '.md')
        await writeFile(file, parts.join(''), root, agent)
        return '已导出 ' + files.length + ' 个记忆文档（活动条目 ' + total + ' 条）→ docs\\memory-export-' + stamp + '.md'
      },
    })

    // memory_gc：清理超期已归档条目（dry_run 默认预览；只清「已归档」，活动/记忆条目不碰）
    reg({
      name: 'memory_gc',
      description: '记忆 GC：清除「已归档条目」中超过保留期（默认 90 天，restrict-discipline.gcRetentionDays 可配）的条目。dry_run:true（默认）只预览不落库；false 才执行。活动记忆条目永不被清除。',
      parameters: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', description: 'true=只预览（默认）；false=实际清除' },
        },
        required: [],
      },
      output: textOut(),
      async execute(args, exec) {
        const agent = exec && exec.agent
        const root = needFs('memory_gc', agent)
        const dry = args.dry_run !== false
        const days = cfg('gcRetentionDays', 90)
        const files = await listMemFiles(agent)
        const changed = []
        let purged = 0
        const previews = []
        for (const f of files) {
          const r = purgeArchived(f.text, Date.now(), days)
          if (r.purged > 0) {
            purged += r.purged
            changed.push({ name: f.name, text: r.text })
            for (const l of r.preview.slice(0, 2)) previews.push('  - ' + clip(l, 120))
          }
        }
        if (!dry && changed.length > 0) {
          await memLock(async () => {
            for (const c of changed) await writeFile(join(root, 'memory\\' + c.name), c.text, root, agent)
          })
        }
        const head = dry ? '预览（dry_run，未落库）' : '已执行'
        return head + '：' + purged + ' 条超期已归档条目（保留 ' + days + ' 天）'
          + (changed.length > 0 ? '，涉及 ' + changed.length + ' 个文件\n' + previews.join('\n') : '，无需清理')
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
