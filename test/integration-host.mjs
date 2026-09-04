// test/integration-host.mjs — host 半边集成自检（零依赖：mock ctx + 内存 fs）。
// 验证 lib/index.js 的 apply() 接线：工具注册（find/record/remember）、
// CLAUDE.md 自动加载（agent/session-start → inject）、# 快捷召回（session/event）、
// digest 落盘、规则文本注入、设置开关。运行：node test/integration-host.mjs
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
const check = (label, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 内存 fs 桩（root = C:\ws）----
const files = new Map() // 'C:\\ws\\a\\b' -> text
const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+/g, '\\')
const fsSvc = {
  async resolve(p, opts) {
    const base = opts && opts.cwd ? norm(opts.cwd) : 'C:\\ws'
    const abs = /^[A-Za-z]:\\/.test(norm(p)) ? norm(p) : norm(base + '\\' + p)
    return abs
  },
  processPath(t) { return t },
  async readText(abs) {
    const k = norm(abs)
    if (!files.has(k)) { const e = new Error('ENOENT ' + k); e.code = 'ENOENT'; throw e }
    return files.get(k)
  },
  async writeText(abs, content) { files.set(norm(abs), String(content)) },
  async listDir(abs) {
    const base = norm(abs)
    const names = new Set()
    const children = []
    for (const k of files.keys()) {
      if (!k.startsWith(base + '\\')) continue
      const rest = k.slice(base.length + 1)
      const idx = rest.indexOf('\\')
      const name = idx >= 0 ? rest.slice(0, idx) : rest
      if (!names.has(name)) {
        names.add(name)
        children.push(idx >= 0
          ? { name, type: 'directory', target: base + '\\' + name }
          : { name, type: 'file', target: k })
      }
    }
    return children
  },
}

// ---- 事件/服务桩 ----
const handlers = new Map()
const ctx = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {}
  },
  get(name) {
    if (name === 'fs') return fsSvc
    if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: 'C:\\ws' }), workspaceRoot: 'C:\\ws' }
    if (name === 'systemPrompt') return { section(def) { sections.push(def) } }
    if (name === 'sessionTitle') return { get: () => ({ title: '集成测试会话' }) }
    if (name === 'tools') return toolsSvc
    if (name === 'settings') return { register() { return settingsScope } }
    return undefined
  },
  effect(fn) { return fn() },
}
const sections = []
const toolsDefs = []
const toolsSvc = { register(def) { toolsDefs.push(def); return () => {} } }
const settingsScope = { get: () => ({ value: {} }), set: async () => {} }
const agent = {
  id: 'agent-1',
  inject: () => {},
  session: {
    id: 'session-int-1',
    header: { cwd: 'C:\\ws' },
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    ],
    append: async () => {},
  },
}
const execCtx = (a = agent) => ({ agent: a })

apply(ctx)

console.log('== restrict-discipline host 集成自检（v0.7 claude-code 记忆路线）==')

// 1) 工具注册与规则文本
{
  const names = toolsDefs.map((t) => t.name).sort()
  const expect = ['find_operation', 'record_operation', 'remember'].sort()
  check('注册 3 个工具（检索/管理类记忆工具已移除）', JSON.stringify(names) === JSON.stringify(expect))
  const texts = sections.map((s) => (typeof s.text === 'function' ? s.text() : '')).join('\n')
  check('系统提示规则文本为 4 条主规则', texts.includes('1. 强制约束') && texts.includes('4. 编码纪律') && !texts.includes('16. 会话记忆自动注入'))
  check('规则 3 描述 CLAUDE.md 机制', texts.includes('memory/CLAUDE.md') && texts.includes('# 快捷召回'))
}

const def = (n) => toolsDefs.find((t) => t.name === n)

// 2) remember → 固定路径写入 memory/CLAUDE.md（脱敏 + 来源审计）
{
  const out = await def('remember').execute(
    { content: '发布流程：先打 tag 再推送。密钥 sk-abcdef1234567890 勿外传', tags: '发布,流程' },
    execCtx())
  check('remember 返回 id 与脱敏提示', /已记住 mem-/.test(out) && out.includes('已脱敏') && out.includes('memory\\CLAUDE.md'))
  const text = files.get('C:\\ws\\memory\\CLAUDE.md')
  check('remember 写入 memory/CLAUDE.md 记忆条目节', !!text && text.includes('## 记忆条目') && text.includes('来源: session-int-1') && text.includes('轮次 2'))
  check('落盘前已脱敏密钥', !text.includes('sk-abcdef1234567890') && text.includes('<REDACTED:api_key>'))
}

// 3) digest：agent/status idle → 写摘要到 memory/<会话>.md，不覆盖 CLAUDE.md
{
  const statusListeners = handlers.get('agent/status') || []
  check('注册 agent/status 监听', statusListeners.length === 1)
  for (const h of statusListeners) h({ agent, status: 'idle' })
  await sleep(150)
  const digestFile = [...files.keys()].find((k) => /memory\\session-int-1_/.test(k) && k.endsWith('.md'))
  check('idle 摘要写入 memory/<会话>.md', !!digestFile)
  const text = files.get(digestFile)
  check('摘要含 Markdown 分节', text.includes('# 会话摘要 — 集成测试会话') && text.includes('## 消息统计') && text.includes('## 最近对话'))
  const cm = files.get('C:\\ws\\memory\\CLAUDE.md') || ''
  check('摘要不覆盖 CLAUDE.md', cm.includes('## 记忆条目') && cm.includes('发布流程'))
}

// 4) agent/session-start → 自动加载 memory/CLAUDE.md 并 agent.inject（claude-code 式确定性注入）
{
  const injected = []
  agent.inject = (msg) => injected.push(msg)
  const loadListeners = handlers.get('agent/session-start') || []
  check('注册 agent/session-start 监听', loadListeners.length === 1)
  for (const h of loadListeners) h({ agent })
  await sleep(150)
  check('CLAUDE.md 内容经 agent.inject 注入', injected.length >= 1 && injected[0].content[0].text.includes('【项目记忆') && injected[0].content[0].text.includes('发布流程'))
  check('注入 source 为 plugin + instructions form', injected[0].source.kind === 'plugin' && injected[0].source.plugin === 'restrict-discipline' && injected[0].source.form === 'instructions')
}

// 5) # 快捷召回：session/event 用户消息含 #条目名 → 注入对应区块
{
  const appended = []
  agent.session.append = async (type, data) => appended.push({ type, data })
  const evListeners = handlers.get('session/event') || []
  check('注册 session/event 监听', evListeners.length === 1)
  // CLAUDE.md 目前无一级标题条目 → 无命中不注入
  for (const h of evListeners) h(agent.session, { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '参考 #发布流程 的做法' }], source: { kind: 'user' } } })
  await sleep(150)
  check('无命中条目时不注入', appended.length === 0)
  // 预置带 # 一级标题的 CLAUDE.md
  files.set('C:\\ws\\memory\\CLAUDE.md', '# 发布流程\n先打 tag 再推送。\n\n## 记忆条目\n\n- 条目')
  for (const h of evListeners) h(agent.session, { type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '参考 #发布流程' }], source: { kind: 'user' } } })
  await sleep(150)
  check('命中条目注入 user/message 召回块', appended.length === 1 && appended[0].type === 'user/message'
    && appended[0].data.content[0].text.includes('【# 快捷召回：发布流程')
    && appended[0].data.source.kind === 'plugin' && appended[0].data.source.form === 'recall')
  // 插件自身注入（source.kind !== 'user'）不触发召回（防递归）
  for (const h of evListeners) h(agent.session, { type: 'user/message', data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '#发布流程 再来' }], source: { kind: 'plugin', plugin: 'restrict-discipline' } } })
  await sleep(150)
  check('非用户来源消息不触发召回（防递归）', appended.length === 1)
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
