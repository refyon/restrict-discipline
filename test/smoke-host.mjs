// test/smoke-host.mjs — restrict-discipline 规则核心（lib/enforce.js）冒烟测试。
// 零外部依赖：直接 import enforce.js 并注入桩服务。运行：node test/smoke-host.mjs
//
// 说明：测试使用通用占位路径（C:\workspace / D:\external），与任何真实机器无关。
import { buildEnforcer } from '../lib/enforce.js'

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

console.log('== restrict-discipline enforce 冒烟测试 ==')

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
