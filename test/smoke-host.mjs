// test/smoke-host.mjs — restrict-discipline 规则核心（lib/enforce.js）冒烟测试。
// 零外部依赖：直接 import enforce.js 并注入桩服务。运行：node test/smoke-host.mjs
//
// 说明：测试使用通用占位路径（C:\workspace / D:\external），与任何真实机器无关。
import { buildEnforcer } from '../lib/enforce.js'
import { matchesKeyword, parsePs1, searchScripts } from '../lib/search.js'

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

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
