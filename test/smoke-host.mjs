// test/smoke-host.mjs — restrict-discipline 规则核心（lib/enforce.js）冒烟测试。
// 零外部依赖：直接 import enforce.js 并注入桩服务。运行：node test/smoke-host.mjs
//
// 说明：测试使用通用占位路径（C:\workspace / D:\external），与任何真实机器无关。
import { buildEnforcer } from '../lib/enforce.js'
import { matchesKeyword, parsePs1, searchScripts, tokenize } from '../lib/search.js'
import { renderLoadBlock, renderRecallBlock, splitSections, detectShortcuts, recallSections, capLoad } from '../lib/memload.js'
import { isNoise, textOf, clip, pickScriptLines } from '../lib/digest.js'
import { RULES_TEXT } from '../lib/rules.js'
import { splitFile, rebuildFile, appendEntry, appendMemoryEntry, entryLine, parseWhen, parseEntryLine } from '../lib/memfile.js'
import { redactSecrets } from '../lib/redact.js'

const toAbs = (p, cwd) => {
  const s = String(p)
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\') || s.startsWith('/')) return s
  const base = cwd ? String(cwd).replace(/[\\/]+$/, '') : ''
  if (s === '.' || s === './') return base
  return base + '\\' + s
}
const fsStub = {
  async resolve(p, opts) { return { displayPath: toAbs(p, opts && opts.cwd) } },
  processPath(t) { return t.displayPath },
}

const logs = []
const makeEnforcer = (enabled = () => true) => buildEnforcer({
  fs: fsStub,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\workspace' }) },
  sessionTitle: { get: () => ({ title: 'smoke' }) },
  rootOf: () => 'C:\\workspace',
  sessionNameOf: () => 'smoke-session',
  log: (agent, file, line) => logs.push([file, line]),
  enabled,
})

const agent = { id: 'a1', session: { id: 'a1', header: { cwd: 'C:\\workspace' } } }
const exec = (name, arguments_, a = agent) => ({ name, arguments: arguments_, agent: a })

let pass = 0
let fail = 0
function check(label, decision, expectedKind) {
  const ok = (expectedKind === undefined && decision === undefined)
    || (expectedKind !== undefined && decision && decision.kind === expectedKind)
  if (ok) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + ' → got ' + JSON.stringify(decision)) }
}
function checkTrue(label, condition) {
  if (condition) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + ' → got false') }
}

console.log('== restrict-discipline enforce 冒烟测试 ==')

// 规则 4 复用：search 核心逻辑
{
  checkTrue('matchesKeyword 命中描述', matchesKeyword('build', 'run-build.cmd', '构建项目', 'npm run build'))
  checkTrue('matchesKeyword 命中命令', matchesKeyword('push', 'x.cmd', '推送', 'git push origin main'))
  checkTrue('matchesKeyword 大小写不敏感', matchesKeyword('GIT', 'x.cmd', '提交', 'git commit -m hi'))
  checkTrue('matchesKeyword 未命中返回 false', !matchesKeyword('install', 'x.cmd', '构建', 'npm run build'))
  checkTrue('parsePs1 提取描述与命令', (() => {
    const { description, command } = parsePs1('# 推送 GitHub\n$env:GIT_SSH_COMMAND = "ssh"\ngit push origin main')
    return description === '推送 GitHub' && command.includes('git push origin main')
  })())

  // searchScripts 用桩 fs 检索
  const memFs = {
    scripts: {
      'sess-a': {
        '01-push.cmd.ps1': '# 推送 GitHub\n$env:GIT_SSH_COMMAND = "ssh.exe"\ngit push origin main',
        '02-build.cmd.ps1': '# 构建项目\nnpm run build',
      },
      'sess-b': {
        '03-install.cmd.ps1': '# 安装依赖\npnpm install',
      },
    },
  }
  const flat = (dir) => {
    const out = []
    for (const name of Object.keys(dir)) {
      const v = dir[name]
      if (typeof v === 'string') out.push({ name, type: 'file', target: { displayPath: 'C:\\workspace\\scripts\\' + name, text: v } })
      else out.push({ name, type: 'directory', target: { displayPath: 'C:\\workspace\\scripts\\' + name, sub: v } })
    }
    return out
  }
  const fsStub2 = {
    async resolve(p, o) { return { displayPath: 'C:\\workspace\\' + p } },
    async listDir(t) {
      if (t.sub) return flat(t.sub)
      if (t.displayPath.endsWith('scripts')) return flat(memFs.scripts)
      return []
    },
    async readText(t) { return t.text || '' },
  }
  {
    const r = await searchScripts({ resolve: fsStub2.resolve, listDir: fsStub2.listDir, readText: fsStub2.readText, cwd: 'C:\\workspace', keyword: 'push', limit: 8 })
    checkTrue('searchScripts 命中 push（跨会话）', r.count === 1 && r.matches[0].session === 'sess-a' && r.matches[0].base === '01-push.cmd')
    const r2 = await searchScripts({ resolve: fsStub2.resolve, listDir: fsStub2.listDir, readText: fsStub2.readText, cwd: 'C:\\workspace', keyword: 'install', limit: 8 })
    checkTrue('searchScripts 命中 install（其他会话）', r2.count === 1 && r2.matches[0].session === 'sess-b')
    const r3 = await searchScripts({ resolve: fsStub2.resolve, listDir: fsStub2.listDir, readText: fsStub2.readText, cwd: 'C:\\workspace', keyword: '不存在的词', limit: 8 })
    checkTrue('searchScripts 未命中 count=0', r3.count === 0)
  }
}

// 规则 4 检索 P0：倒排索引 + BM25（分词 / 排名 / 缓存失效 / 空关键词回退）
{
  checkTrue('tokenize ASCII 小写分词', JSON.stringify(tokenize('Npm Run Build')) === JSON.stringify(['npm', 'run', 'build']))
  checkTrue('tokenize 中文 bigram', JSON.stringify(tokenize('打包发布')) === JSON.stringify(['打包', '包发', '发布']))
  checkTrue('tokenize 过滤符号与单字符 ASCII', JSON.stringify(tokenize('a b12! 中')) === JSON.stringify(['b12', '中']))

  // 迷你 fs：resolve 返回稳定对象（缓存 key 稳定）；holder.tree 可变，用于失效测试
  const mkFs = (holder, pathKey, counter) => ({
    async resolve(p) { return { pathKey: pathKey + '\\' + p } },
    async listDir(t) {
      const dir = (t && t.sub !== undefined) ? t.sub : holder.tree
      if (!dir || typeof dir !== 'object') return []
      return Object.keys(dir).map((name) => {
        const v = dir[name]
        if (typeof v === 'string') return { name, type: 'file', target: { text: v } }
        return { name, type: 'directory', target: { sub: v } }
      })
    },
    async readText(t) { if (counter) counter.reads++; return (t && t.text) || '' },
  })

  // 排名：文件名字段权重(×2)高于命令字段(×1)，同词命中应把文件名命中排前面
  {
    const holder = { tree: {
      '04-build.cmd.ps1': '# 构建项目\necho hi',
      '05-x.cmd.ps1': '# 无关\nnpm run build',
    } }
    const fs = mkFs(holder, 'C:\\bench1')
    const r = await searchScripts({ resolve: fs.resolve, listDir: fs.listDir, readText: fs.readText, cwd: 'C:\\bench1', keyword: 'build', limit: 8 })
    checkTrue('BM25 文件名命中排名优先', r.count === 2 && r.matches[0].base === '04-build.cmd')
  }

  // 中文 bigram 跨词命中：旧子串匹配失配（"打包发布" ⊄ "发布编译"），分词后共享 "发布" 命中
  {
    const holder = { tree: { '06-release.cmd.ps1': '# 发布编译环境脚本\necho hi' } }
    const fs = mkFs(holder, 'C:\\bench2')
    const r = await searchScripts({ resolve: fs.resolve, listDir: fs.listDir, readText: fs.readText, cwd: 'C:\\bench2', keyword: '打包发布', limit: 8 })
    checkTrue('中文 bigram 跨词命中', r.count === 1 && r.matches[0].base === '06-release.cmd')
  }

  // 缓存：内容未变时零文件读取；新增文件触发索引重建
  {
    const holder = { tree: { '07-a.cmd.ps1': '# 构建\nnpm run build' } }
    const counter = { reads: 0 }
    const fs = mkFs(holder, 'C:\\bench3', counter)
    const dep = { resolve: fs.resolve, listDir: fs.listDir, readText: fs.readText }
    const r1 = await searchScripts({ ...dep, cwd: 'C:\\bench3', keyword: 'build', limit: 8 })
    const afterFirst = counter.reads
    checkTrue('首次查询建索引并读取文件', r1.count === 1 && afterFirst >= 1)
    const r2 = await searchScripts({ ...dep, cwd: 'C:\\bench3', keyword: 'build', limit: 8 })
    checkTrue('缓存命中零文件读取', r2.count === 1 && counter.reads === afterFirst)
    holder.tree['08-install.cmd.ps1'] = '# 安装依赖\npnpm install'
    const r3 = await searchScripts({ ...dep, cwd: 'C:\\bench3', keyword: 'install', limit: 8 })
    checkTrue('新增文件触发重建并可检索', r3.count === 1 && r3.matches[0].base === '08-install.cmd')
  }

  // 空关键词分词（纯符号）回退旧全量子串扫描
  {
    const holder = { tree: { '09-x.cmd.ps1': '# 特殊\necho !!' } }
    const fs = mkFs(holder, 'C:\\bench4')
    const r = await searchScripts({ resolve: fs.resolve, listDir: fs.listDir, readText: fs.readText, cwd: 'C:\\bench4', keyword: '!', limit: 8 })
    checkTrue('纯符号关键词回退子串扫描', r.count === 1)
  }

  // limit 截断返回、count 为全部命中数
  {
    const holder = { tree: {
      '10-a.cmd.ps1': '# 一\nnode test a',
      '11-a.cmd.ps1': '# 二\nnode test a',
      '12-a.cmd.ps1': '# 三\nnode test a',
    } }
    const fs = mkFs(holder, 'C:\\bench5')
    const r = await searchScripts({ resolve: fs.resolve, listDir: fs.listDir, readText: fs.readText, cwd: 'C:\\bench5', keyword: 'test', limit: 2 })
    checkTrue('limit 截断且 count 为全部命中', r.count === 3 && r.matches.length === 2)
  }
}

// 规则 6 摘要净化（lib/digest.js）
{
  checkTrue('isNoise 识别 runtime context 快照', isNoise('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'))
  checkTrue('isNoise 识别 system-reminder', isNoise('<system-reminder> A skill is a reusable set of task-specific instructions.'))
  checkTrue('isNoise 识别 checkpoint', isNoise('This is an automatically generated checkpoint condensing an earlier span.'))
  checkTrue('isNoise 放行正常对话', !isNoise('请把结果保存为excel格式文件'))
  checkTrue('textOf 提取文本块', textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]) === 'a b')
  checkTrue('clip 长文本截断到 150 字符', clip('x'.repeat(200)).length <= 151)
  checkTrue('clip 短文本不截断', clip('hello') === 'hello')
  const idx = [
    '- [a.cmd](a.cmd) — 第一条',
    '- [b.cmd](b.cmd) — 第二条',
    '- [a.cmd](a.cmd) — 重复条目（应去重）',
    '其他行',
  ].join('\n')
  const picked = pickScriptLines(idx)
  checkTrue('pickScriptLines 提取并去重', picked.length === 2 && picked[0].includes('a.cmd') && picked[1].includes('b.cmd') && !picked[0].includes('重复'))
}

// 规则 1：根目录建文件
{
  const e = makeEnforcer()
  check('write 工具写根目录 → deny', await e(exec('write', { file_path: 'root-test.txt', content: 'x' })), 'deny')
  check('write 工具写子目录 → 放行', await e(exec('write', { file_path: 'lib\\demo\\x.txt', content: 'x' })), undefined)
  check('pwsh New-Item 根目录 → deny', await e(exec('pwsh', { command: 'New-Item -ItemType File -Path C:\\workspace\\direct.txt' })), 'deny')
  check('pwsh Set-Content 根目录 → deny', await e(exec('pwsh', { command: 'Set-Content -Path C:\\workspace\\a.txt -Value hi' })), 'deny')
  check('pwsh 重定向根目录 → deny', await e(exec('pwsh', { command: 'echo hi > C:\\workspace\\f.txt' })), 'deny')
  check('pwsh New-Item 子目录 → 放行（防误报）', await e(exec('pwsh', { command: 'New-Item -ItemType Directory -Force -Path C:\\workspace\\lib\\demo' })), undefined)
}

// 规则 2：根目录 .env
{
  const e = makeEnforcer()
  check('pwsh Get-Content .env → deny', await e(exec('pwsh', { command: 'Get-Content -Path .env' })), 'deny')
  check('read .env → deny', await e(exec('read', { file_path: 'C:\\workspace\\.env' })), 'deny')
  check('edit .env → deny', await e(exec('edit', { file_path: 'C:\\workspace\\.env', old_string: 'a', new_string: 'b' })), 'deny')
  check('read .env.example → 放行', await e(exec('read', { file_path: 'C:\\workspace\\.env.example' })), undefined)
  check('grep pattern .env → deny', await e(exec('grep', { pattern: '.env', path: '.' })), 'deny')
}

// 规则 2/3/1/5 误判回归：here-string（多行文档）内的 .env / 代理示例 / 根目录写入示例
// 属于文档内容，不应触发拦截（此前 ENV_TOKEN_RE 对命令文本全局匹配导致误伤）
{
  const e = makeEnforcer()
  const notesCmd = "$notes = @'\n## 功能\n\n2. **敏感文件保护** — 禁止读取/修改/删除/搜索项目根目录的 `.env` 文件\n'@\nSet-Content -Path C:\\workspace\\log\\notes.md -Value $notes"
  check('here-string 文档含 .env 字样 → 放行', await e(exec('pwsh', { command: notesCmd })), undefined)
  const proxyDoc = "$doc = @'\n# 教程\nnpm config set proxy http://127.0.0.1:8888\n'@\nSet-Content -Path C:\\workspace\\docs\\t.md -Value $doc"
  check('here-string 文档含代理示例 → 放行', await e(exec('pwsh', { command: proxyDoc })), undefined)
  const rootDoc = "$doc = @'\n# 说明\n创建文件 C:\\workspace\\root-test.txt\n'@\nWrite-Output $doc"
  check('here-string 文档含根目录写入示例 → 放行', await e(exec('pwsh', { command: rootDoc })), undefined)
  // 单行 commit message / echo 文本中提及 .env（后接路径分隔符或普通文本）不应误判
  const commitMsg = 'git -C C:\\workspace commit -m "docs: mention .env/proxy handling in README"'
  check('commit message 含 .env/proxy → 放行', await e(exec('pwsh', { command: commitMsg })), undefined)
  const echoText = 'Write-Output "the root .env file should stay protected"'
  check('echo 文本含 .env → 放行', await e(exec('pwsh', { command: echoText })), undefined)
  // 真实访问仍拦截：.env 作为独立路径参数
  check('git diff .env → deny', await e(exec('pwsh', { command: 'git diff .env' })), 'deny')
  check('Get-ChildItem .env → deny', await e(exec('pwsh', { command: 'Get-ChildItem -Path .env' })), 'deny')
}

// 规则 3：代理设置
{
  const e = makeEnforcer()
  check('git config http.proxy → deny', await e(exec('pwsh', { command: 'git config --global http.proxy http://127.0.0.1:8888' })), 'deny')
  check('npm config set proxy → deny', await e(exec('pwsh', { command: 'npm config set proxy http://127.0.0.1:8888' })), 'deny')
  check('$env:http_proxy= → deny', await e(exec('pwsh', { command: '$env:http_proxy = "http://x"' })), 'deny')
  check('正常命令 → 放行', await e(exec('pwsh', { command: 'npm run build' })), undefined)
}

// 规则 5：目录外修改确认 / 只读放行
{
  const e = makeEnforcer()
  check('write 目录外 → ask', await e(exec('write', { file_path: 'D:\\external\\file.txt', content: 'x' })), 'ask')
  check('pwsh Set-Content 目录外 → ask', await e(exec('pwsh', { command: 'Set-Content -Path D:\\external\\file.txt -Value hi' })), 'ask')
  check('pwsh Remove-Item 目录外 → ask', await e(exec('pwsh', { command: 'Remove-Item D:\\external\\file.txt' })), 'ask')
  check('read 目录外 → 放行', await e(exec('read', { file_path: 'D:\\external\\sample.ini' })), undefined)
  check('pwsh Get-Content 目录外 → 放行', await e(exec('pwsh', { command: 'Get-Content D:\\external\\sample.ini' })), undefined)
  check('pwsh 无路径 → 放行', await e(exec('pwsh', { command: 'Get-Location' })), undefined)
}

// 禁用开关
{
  const e = makeEnforcer(() => false)
  check('禁用时 write 根目录 → 放行', await e(exec('write', { file_path: 'root.txt', content: 'x' })), undefined)
  check('禁用时 .env → 放行', await e(exec('pwsh', { command: 'Get-Content .env' })), undefined)
  check('禁用时 代理 → 放行', await e(exec('pwsh', { command: 'git config --global http.proxy http://x' })), undefined)
}

// 规则文本（lib/rules.js，4 条主规则）
{
  checkTrue('规则文本含 4 条主规则', ['1. 强制约束', '2. Token 节约', '3. 会话记忆', '4. 编码纪律'].every((h) => RULES_TEXT.includes(h)))
  checkTrue('规则文本不再描述旧检索机制', !RULES_TEXT.includes('BM25') && !RULES_TEXT.includes('自动检索') && !RULES_TEXT.includes('memoryTopK') && !RULES_TEXT.includes('recall_memory 检索'))
  checkTrue('规则文本含项目记忆说明', RULES_TEXT.includes('memory/MEMORY.md') && RULES_TEXT.includes('# 快捷召回') && RULES_TEXT.includes('会话摘要'))
  checkTrue('规则文本声明旧工具已移除', RULES_TEXT.includes('已删除'))
  checkTrue('规则文本子项编号 3.1–3.4', ['3.1 项目记忆文件', '3.2 # 快捷召回', '3.3 会话摘要', '3.4 旧机制已移除'].every((s) => RULES_TEXT.includes(s)))
}

// memory/*.md 记忆文档纯逻辑（lib/memfile.js）+ 项目记忆文件追加器
{
  const iso = '2026-09-02T00:00:00.000Z'
  const line = entryLine({ id: 'mem-a1', iso, content: '决策：用 Markdown 存记忆', source: 'sess-1', turn: 3, tags: ['决策'] })
  checkTrue('entryLine 生成条目行', line.startsWith('- [mem-a1] 2026-09-02T00:00:00.000Z 决策：用 Markdown 存记忆（来源: sess-1 · 轮次 3） · 标签 决策'))
  checkTrue('parseWhen 解析时间', parseWhen(line) === Date.parse(iso))
  const p = parseEntryLine(line)
  checkTrue('parseEntryLine 解析字段', !!p && p.id === 'mem-a1' && p.content.includes('Markdown'))
  const base = '# 会话摘要 — A\n\n## 消息统计\n\n用户 1 条\n'
  let t = appendEntry(base, line)
  checkTrue('appendEntry 追加到记忆条目节', t.includes('## 记忆条目') && t.includes('- [mem-a1]') && t.includes('## 消息统计'))
  const s = splitFile(t)
  checkTrue('splitFile 分节', s.digest.length > 0 && s.entries.length === 1 && s.archived.length === 0)
  checkTrue('rebuildFile 全空返回空串', rebuildFile({ digest: [], entries: [], archived: [] }) === '')
  const merged = rebuildFile({ digest: ['# 会话摘要 — A2'], entries: s.entries, archived: s.archived })
  checkTrue('digest 重写保留记忆条目节', merged.includes('# 会话摘要 — A2') && merged.includes('- [mem-a1]'))
  const legacy = rebuildFile({ digest: [], entries: ['- [mem-x] 2026-09-01T00:00:00.000Z 只有条目'], archived: [] })
  checkTrue('rebuildFile 无 digest 时仍保留条目', legacy.startsWith('## 记忆条目'))

  // appendMemoryEntry：项目记忆文件追加器——保留原文件任意结构（含空行）
  const doc = '# 部署流程\n打 tag 推送触发 CI。\n\n## 记忆条目\n\n- 旧条目\n'
  const after = appendMemoryEntry(doc, line)
  checkTrue('appendMemoryEntry 追加条目且保留正文空行', after.includes('打 tag 推送触发 CI。\n\n') && after.includes('- 旧条目') && after.includes('- [mem-a1]'))
  checkTrue('appendMemoryEntry 无记忆节时在尾创建', (() => {
    const r = appendMemoryEntry('# 只有正文\n段落内容', '- [mem-x] 2026-09-01T00:00:00.000Z 新条目')
    return r.includes('## 记忆条目') && r.includes('- [mem-x]') && r.includes('段落内容')
  })())
  checkTrue('appendMemoryEntry 空行返回原文', appendMemoryEntry(doc, '  ') === doc.replace(/\r\n/g, '\n'))
}

// 秘密脱敏（lib/redact.js）
{
  const c = redactSecrets('api key: sk-abcdef1234567890 和 Bearer xyz1234567890abcde')
  checkTrue('redactSecrets 脱敏 sk-/Bearer', !c.text.includes('sk-abcdef') && !c.text.includes('xyz1234567') && c.count >= 2 && c.text.includes('<REDACTED:'))
  const kv = redactSecrets('export SECRET="hunter2token" ok')
  checkTrue('redactSecrets 掩码 key=value 保留键名', kv.text.includes('SECRET=') && !kv.text.includes('hunter2token'))
  const jwt = redactSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
  checkTrue('redactSecrets 掩码 JWT', !jwt.text.includes('eyJhbGciOiJIUzI1NiJ9') && jwt.count >= 1)
  const pem = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB\n-----END PRIVATE KEY-----')
  checkTrue('redactSecrets 掩码 PEM 块', pem.count === 1 && !pem.text.includes('MIIEvQIBADANB'))
  checkTrue('redactSecrets 明文原样返回', redactSecrets('npm run build 正常文本').text === 'npm run build 正常文本')
}

// 项目记忆纯逻辑（lib/memload.js：确定性加载 + # 快捷召回）
{
  const doc = '# 部署流程\n打 tag 推送触发 CI。\n\n## 记忆条目\n\n- 条目一\n'
  const { preamble, sections } = splitSections(doc)
  checkTrue('splitSections 切分一级标题条目', preamble === '' && sections.length === 1 && sections[0].token === '部署流程' && sections[0].text.includes('打 tag'))
  checkTrue('detectShortcuts 提取 #token 并去重', JSON.stringify(detectShortcuts('请参考 #部署流程 和 #部署流程 以及 #a')) === JSON.stringify(['部署流程']))
  checkTrue('detectShortcuts 忽略过短 token 与标题语法', JSON.stringify(detectShortcuts('# 部署流程')) === JSON.stringify([]))
  checkTrue('detectShortcuts 大小写不敏感去重', JSON.stringify(detectShortcuts('#Build 与 #build')) === JSON.stringify(['Build']))
  const hits = recallSections(doc, '部署流程')
  checkTrue('recallSections 精确命中条目', hits.length === 1 && hits[0].text.startsWith('# 部署流程'))
  checkTrue('recallSections 大小写不敏感', recallSections('# Build\nnpm run build', 'BUILD').length === 1)
  checkTrue('recallSections 未命中返回空', recallSections(doc, '不存在').length === 0)
  const cap = capLoad('x'.repeat(100), 60)
  checkTrue('capLoad 超限截断并标注', cap.truncated && cap.text.length === 60 && cap.total === 100)
  checkTrue('capLoad 未超限原样', capLoad('hello', 60).text === 'hello' && !capLoad('hello', 60).truncated)
  const blk = renderLoadBlock('# 部署流程\n内容', 1000)
  checkTrue('renderLoadBlock 注入块含头与内容', blk.startsWith('【项目记忆') && blk.includes('memory/MEMORY.md') && blk.includes('内容'))
  checkTrue('renderLoadBlock 旧名回退时附重命名提示', renderLoadBlock(doc, 1000, true).includes('memory/CLAUDE.md'))
  checkTrue('renderLoadBlock 空输入返回空', renderLoadBlock('', 1000) === '')
  checkTrue('renderLoadBlock 超限加截断注记', renderLoadBlock('x'.repeat(300), 100).includes('截断'))
  const rblk = renderRecallBlock(hits, '部署流程')
  checkTrue('renderRecallBlock 召回块含条目名', rblk.startsWith('【# 快捷召回：部署流程') && rblk.includes('打 tag'))
  checkTrue('renderRecallBlock 空命中返回空', renderRecallBlock([], 'x') === '')
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
