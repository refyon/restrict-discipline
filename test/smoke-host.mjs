// test/smoke-host.mjs — restrict-discipline 规则核心（lib/enforce.js）冒烟测试。
// 零外部依赖：直接 import enforce.js 并注入桩服务。运行：node test/smoke-host.mjs
//
// 说明：测试使用通用占位路径（C:\workspace / D:\external），与任何真实机器无关。
import { buildEnforcer } from '../lib/enforce.js'
import { matchesKeyword, parsePs1, searchScripts, tokenize } from '../lib/search.js'
import { rankMemoryFiles, renderMemoryBlock, renderMemoryIndex, stripDigestBoilerplate, normalizeMemoryQuery, buildRecallNotice } from '../lib/memory.js'
import { isNoise, textOf, clip, pickScriptLines } from '../lib/digest.js'
import { RULES_TEXT } from '../lib/rules.js'
import { splitFile, rebuildFile, appendEntry, forgetEntry, purgeArchived, countEntries, entryLine, parseWhen, parseEntryLine, firstTitle } from '../lib/memfile.js'
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

// 规则 16 会话记忆注入（lib/memory.js）
{
  const files = [
    { name: '发布相关.txt', text: '# 摘要 A\n发布 v0.4.0 流程：tag、push、gh release create' },
    { name: '构建相关.txt', text: '# 摘要 B\nnpm run build 与 CI 发布方式' },
    { name: '本会话.txt', text: '# 摘要 C\n当前会话自身内容（应被排除）' },
  ]
  const ranked = rankMemoryFiles(files, '如何发布 release', { limit: 3, excludeName: '本会话.txt' })
  checkTrue('rankMemoryFiles 排除本会话并按相关度排序', ranked.length === 2 && ranked[0].name === '发布相关.txt')
  checkTrue('rankMemoryFiles 纯符号查询返回空', rankMemoryFiles(files, '!!', { limit: 3 }).length === 0)
  checkTrue('rankMemoryFiles 空文件集返回空', rankMemoryFiles([], '发布').length === 0)
  checkTrue('rankMemoryFiles 排除项不参与', rankMemoryFiles(files, '发布', { limit: 3, excludeName: '发布相关.txt' }).every((f) => f.name !== '发布相关.txt'))
  const block = renderMemoryBlock(ranked, { maxChars: 40 })
  checkTrue('renderMemoryBlock 含标题且截断', block.includes('【历史记忆') && block.includes('发布相关.txt') && block.length < 300)
  checkTrue('renderMemoryBlock 空输入返回空串', renderMemoryBlock([]) === '')

  // 命中质量：样板行剥离 + 查询停用词（样板词不得主导排名）
  const boiler = '# 会话摘要 — 无关\n会话 ID: x-123\n更新时间: 2026-08-30T00:00:00.000Z\n摘要来源: restrict-discipline 自动生成\n消息统计：用户 1 条\n最近对话（最多 6 条）：\n[用户] 黑苹果 QEMU 安装'
  const topical = '# 会话摘要 — 部署发布\n会话 ID: y-456\n更新时间: 2026-08-30T00:00:00.000Z\n摘要来源: restrict-discipline 自动生成\n最近对话（最多 6 条）：\n[用户] 重启服务验证部署效果'
  const r = rankMemoryFiles([{ name: '样板A.txt', text: boiler }, { name: '部署会话.txt', text: topical }], '重启服务 验证 restrict-discipline 是否已更新', { limit: 3 })
  checkTrue('样板词不主导排名（命中部署会话）', r.length === 1 && r[0].name === '部署会话.txt')
  checkTrue('纯样板查询返回空', rankMemoryFiles([{ name: '样板A.txt', text: boiler }], '更新时间 消息统计', { limit: 3 }).length === 0)
  checkTrue('stripDigestBoilerplate 剥离样板行', (() => {
    const s = stripDigestBoilerplate(boiler)
    return s.includes('[用户] 黑苹果 QEMU 安装') && !s.includes('摘要来源') && !s.includes('更新时间') && !s.includes('会话 ID')
  })())
  checkTrue('normalizeMemoryQuery 剔除停用词', normalizeMemoryQuery('重启服务 验证 是否已更新') === '重启服务 验证 是否已')
  const notice = buildRecallNotice(ranked)
  checkTrue('buildRecallNotice 含文件清单与注记', notice.reasoning.includes('发布相关.txt') && notice.reasoning.includes('构建相关.txt') && notice.text.length > 0)
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

// v0.6 规则四元重构（lib/rules.js）
{
  checkTrue('规则文本含 4 条主规则', ['1. 强制约束', '2. Token 节约', '3. 会话记忆', '4. 编码纪律'].every((h) => RULES_TEXT.includes(h)))
  checkTrue('规则文本不再含旧 16 条编号', !RULES_TEXT.includes('16. 会话记忆自动注入') && !RULES_TEXT.includes('【Token 节约补充'))
  checkTrue('规则文本含新旧子项编号', RULES_TEXT.includes('1.1 文件分类') && RULES_TEXT.includes('1.7 遍历排除') && RULES_TEXT.includes('2.7 失败收敛') && RULES_TEXT.includes('3.3 显式记忆工具') && RULES_TEXT.includes('4.4 目标驱动'))
  checkTrue('规则文本含记忆 Markdown 说明', RULES_TEXT.includes('memory/*.md'))
}

// v0.6 memory/*.md 记忆文档纯逻辑（lib/memfile.js）
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
  checkTrue('countEntries 计数', countEntries(t) === 1)
  const s = splitFile(t)
  checkTrue('splitFile 分节', s.digest.length > 0 && s.entries.length === 1 && s.archived.length === 0)
  checkTrue('firstTitle 提取标题', firstTitle(t) === '会话摘要 — A')
  const r = forgetEntry(t, 'mem-a1')
  checkTrue('forgetEntry 软删移入归档', r.moved === 1 && r.text.includes('## 已归档条目') && countEntries(r.text) === 0)
  const g = purgeArchived(r.text, Date.parse('2026-12-01T00:00:00.000Z'), 30)
  checkTrue('purgeArchived 超期清除', g.purged === 1 && !g.text.includes('mem-a1'))
  const keep = purgeArchived(r.text, Date.parse('2026-09-10T00:00:00.000Z'), 30)
  checkTrue('purgeArchived 未超期保留', keep.purged === 0 && keep.text.includes('mem-a1'))
  checkTrue('rebuildFile 全空返回空串', rebuildFile({ digest: [], entries: [], archived: [] }) === '')
  const merged = rebuildFile({ digest: ['# 会话摘要 — A2'], entries: s.entries, archived: s.archived })
  checkTrue('digest 重写保留记忆条目节', merged.includes('# 会话摘要 — A2') && merged.includes('- [mem-a1]'))
  const legacy = rebuildFile({ digest: [], entries: ['- [mem-x] 2026-09-01T00:00:00.000Z 只有条目'], archived: [] })
  checkTrue('rebuildFile 无 digest 时仍保留条目', legacy.startsWith('## 记忆条目'))
}

// v0.6 秘密脱敏（lib/redact.js）
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

// v0.6 渐进披露索引块 + 扩展名兼容排除 + 时间衰减（lib/memory.js）
{
  const files = [
    { name: '发布相关.md', text: '# 会话摘要 — 发布 v0.4\n## 最近对话\n[用户] 打 tag 推送触发 CI' },
    { name: '本会话.md', text: '# 会话摘要 — 本会话自身\n内容' },
    { name: '旧会话.txt', text: '# 会话摘要 — 旧会话\n其他内容' },
  ]
  const r = rankMemoryFiles(files, '如何发布 tag 并推送触发 CI', { limit: 3, excludeName: '本会话.md' })
  checkTrue('excludeName 忽略扩展名排除', r.length === 1 && r[0].name === '发布相关.md')
  const blk = renderMemoryIndex(r)
  checkTrue('renderMemoryIndex 渐进披露：只注标题一行', blk.startsWith('【历史记忆') && blk.includes('发布相关.md') && blk.length < 700 && !blk.includes('打 tag 推送触发 CI'))
  checkTrue('renderMemoryIndex 空输入返回空串', renderMemoryIndex([]) === '')
  const oldF = { name: '旧文件.md', text: '# A\n发布 v0.4.0 的旧流程细节', ts: Date.now() - 200 * 86400000 }
  const newF = { name: '新文件.md', text: '# B\n发布 v0.4.0 的新流程', ts: Date.now() }
  const ranked2 = rankMemoryFiles([oldF, newF], '发布 v0.4.0 流程', { limit: 2 })
  checkTrue('时间衰减：新记忆排前', ranked2.length === 2 && ranked2[0].name === '新文件.md')
  checkTrue('rankMemoryFiles 无 ts 不衰减（旧行为）', rankMemoryFiles([oldF], '发布 v0.4.0 流程', { limit: 1 }).length === 1)
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
