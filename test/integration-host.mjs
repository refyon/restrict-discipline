// test/integration-host.mjs — host 半边集成自检（零依赖：mock ctx + 内存 fs）。
// 验证 lib/index.js 的 apply() 接线：工具注册、记忆工具读写、digest 落盘合并、
// 规则文本注入、设置开关。运行：node test/integration-host.mjs
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

console.log('== restrict-discipline host 集成自检（v0.6）==')

// 1) 工具注册与规则文本
{
  const names = toolsDefs.map((t) => t.name).sort()
  const expect = ['find_operation', 'record_operation', 'remember', 'recall_memory', 'forget_memory', 'memory_stats', 'memory_export', 'memory_gc'].sort()
  check('注册 8 个工具（含 6 个记忆工具）', JSON.stringify(names) === JSON.stringify(expect))
  const texts = sections.map((s) => (typeof s.text === 'function' ? s.text() : '')).join('\n')
  check('系统提示规则文本为 4 条主规则', texts.includes('1. 强制约束') && texts.includes('4. 编码纪律') && !texts.includes('16. 会话记忆自动注入'))
}

const def = (n) => toolsDefs.find((t) => t.name === n)

// 2) remember → 落盘（脱敏 + 来源审计）
{
  const out = await def('remember').execute(
    { content: '发布流程：先打 tag 再推送。密钥 sk-abcdef1234567890 勿外传', tags: '发布,流程' },
    execCtx())
  check('remember 返回 id 与脱敏提示', /已记住 mem-/.test(out) && out.includes('已脱敏'))
  const memFile = [...files.keys()].find((k) => /memory\\session-int-1_/.test(k) && k.endsWith('.md'))
  check('remember 写入 memory/<id>_<title>.md', !!memFile)
  const text = files.get(memFile)
  check('落盘含记忆条目节与来源审计', text.includes('## 记忆条目') && text.includes('来源: session-int-1') && text.includes('轮次 2'))
  check('落盘前已脱敏密钥', !text.includes('sk-abcdef1234567890') && text.includes('<REDACTED:api_key>'))
}

// 3) memory_stats / recall / forget / export / gc
{
  const st = await def('memory_stats').execute({}, execCtx())
  check('memory_stats 报告 1 条活动条目', st.includes('活动条目 1'))
  const rc = await def('recall_memory').execute({ query: '发布流程 打 tag' }, execCtx())
  check('recall_memory 命中本会话刚记住的条目', rc.includes('发布流程') && rc.includes('证据'))
  const fo = await def('forget_memory').execute({ query: '打 tag' }, execCtx())
  check('forget_memory 软删 1 条', fo.includes('已软删除 1'))
  const st2 = await def('memory_stats').execute({}, execCtx())
  check('forget 后活动条目归零、已归档 1', st2.includes('活动条目 0') && st2.includes('已归档 1'))
  const ex = await def('memory_export').execute({}, execCtx())
  check('memory_export 生成 docs/memory-export-*.md', ex.includes('已导出') && /docs\\memory-export-/.test(ex))
  const gdry = await def('memory_gc').execute({ dry_run: true }, execCtx())
  check('memory_gc dry_run 只预览', gdry.includes('预览') && !gdry.includes('已执行'))
}

// 4) digest：agent/status idle → 写 Markdown 摘要并保留记忆条目/归档节；gc 非 dry 清超期归档
{
  // 重新记住一条活动条目（验证 digest 重写保留），并预置一条超期归档
  const memFile = [...files.keys()].find((k) => /memory\\session-int-1_/.test(k) && k.endsWith('.md'))
  const old = '- [mem-old] 2020-01-01T00:00:00.000Z 超期内容（来源: x）'
  files.set(memFile, files.get(memFile) + '\n' + old)
  await def('remember').execute({ content: '需要保留的活动记忆条目' }, execCtx())
  const statusListeners = handlers.get('agent/status') || []
  for (const h of statusListeners) h({ agent, status: 'idle' })
  await sleep(150)
  const text = files.get(memFile)
  check('idle 摘要写入 Markdown（# 会话摘要）', text.includes('# 会话摘要 — 集成测试会话'))
  check('摘要含消息统计/最近对话分节', text.includes('## 消息统计') && text.includes('## 最近对话'))
  check('digest 重写保留记忆条目节', text.includes('## 记忆条目') && text.includes('需要保留的活动记忆条目'))
  const g = await def('memory_gc').execute({ dry_run: false }, execCtx())
  check('memory_gc 非 dry 清除超期归档', g.includes('已执行') && g.includes('1 条'))
  const after = files.get(memFile)
  check('超期归档已物理清除', !after.includes('mem-old'))
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
