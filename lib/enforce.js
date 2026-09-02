// lib/enforce.js — restrict-discipline 行为规则核心（无任何 import，便于独立测试）。
//
// 本文件只做纯逻辑：给定一次工具调用（exec）与服务依赖，返回应采取的决策
// （{ kind: 'deny' | 'ask', ... } 或 undefined=放行）。真正的 DSH 插件壳
// （lib/index.js）负责把它接到运行时的 tools/pre-execute 事件上。
//
// 规则：
//   1. 禁止在项目根目录创建文件
//   2. 禁止访问/修改/删除项目根目录下的 .env
//   3. 禁止修改系统代理设置或 git/npm 等工具的 proxy 配置
//   5. 修改/删除项目目录以外的文件需要用户确认（只读访问默认放行）
// （规则 4 操作留痕、规则 6 会话摘要由 lib/index.js 以工具形式提供）

// ---------------- tiny path helpers ----------------
export function normalizePath(p) {
  return String(p).replace(/[\\/]+$/, '').replace(/\//g, '\\')
}
function lower(s) {
  return String(s).toLowerCase()
}
function normRoot(r) {
  return lower(String(r).replace(/[\\/]+$/, ''))
}
function basename(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i === -1 ? s : s.slice(i + 1)
}
function dirname(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i === -1 ? '' : s.slice(0, i)
}
function join(a, b) {
  const base = String(a)
  return base.endsWith('\\') || base.endsWith('/') ? base + String(b) : base + '\\' + String(b)
}
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function collapseDots(p) {
  const out = []
  for (const part of String(p).split('\\')) {
    if (part === '.' || part === '') continue
    if (part === '..') { if (out.length > 0) out.pop(); continue }
    out.push(part)
  }
  return out.join('\\')
}
function trimToken(t) {
  return String(t).replace(/[;,.()]+$/, '').trim()
}

/**
 * 剥离 PowerShell here-string（@'...'@ / @"..."@）内容，替换为单个空格。
 * here-string 用于承载多行文档/脚本片段，其中的文本（如文档里写到 .env、
 * 代理命令示例）只是内容，不应触发 .env / 代理 / 根目录写入等规则判定。
 */
function stripHereStrings(s) {
  return String(s)
    .replace(/@'[\s\S]*?'@/g, ' ')
    .replace(/@"[\s\S]*?"@/g, ' ')
}

// ---------------- rule patterns ----------------
// Rule 2: 精确的 .env 文件（不含 .env.example / .env.local / $env:NAME）。
// 仅当 .env 作为命令末尾令牌（后接行尾/引号/重定向/管道/分号）时判定为真实
// 文件访问；普通文本（"the root .env file"、commit message ".env/proxy"、
// here-string 文档）中提及 .env 字样不触发拦截，避免误判。
const ENV_TOKEN_RE = /(?:^|[\s"'=([{`\\/])\.env(?=\s*$)|(?:^|[\s"'=([{`\\/])\.env(?=\s+[;&|>]|["'\r\n])/i
const ENV_PATTERN_RE = /(^|[\\/])\.env(?![a-zA-Z0-9_.\\/-])/

// Rule 3: 修改代理设置的命令（git / npm / yarn / pnpm / bun / pip / 系统）
const PROXY_PATTERNS = [
  /git\s+config\s+(--global|--system|--local|--worktree)?\s*(http|https)\.proxy/i,
  /git\s+config\s+--unset(-all)?\s*(http|https)\.proxy/i,
  /git\s+-c\s*(http|https)\.proxy=/i,
  /(npm|yarn|pnpm|bun)\s+config\s+(set|delete|rm|unset)\s+(proxy|https?-proxy|https?Proxy)/i,
  /\b(set|export)\s+(http_proxy|https_proxy|all_proxy)\s*=/i,
  /\$env:(http_proxy|https_proxy|all_proxy)\s*=/i,
  /\[Environment\]::SetEnvironmentVariable\s*\(\s*['"](http|https|all)_proxy/i,
  /netsh\s+winhttp\s+(set|reset)\s+proxy/i,
  /reg\s+add\s+[^\r\n]*(ProxyEnable|ProxyServer)/i,
  /(Set-ItemProperty|New-ItemProperty)\s+[^\r\n]*(ProxyEnable|ProxyServer)/i,
  /pip\s+config\s+set\s+global\.proxy/i,
]

// Rule 1（pwsh 途径）：根目录级文件目标 + 写入动词出现在其之前
function rootWriteCheck(root) {
  const r = esc(normalizePath(root))
  // 注意：字符串构造正则，反斜杠需双重转义 —— '[\\\\/]' 值才是 {backslash, slash}；
  // 负向前瞻里 '\w' 必须是词类（单层反斜杠+w），否则会误把子目录前缀当根级文件。
  const directTarget = new RegExp(r + '[\\\\/][^\\\\/]+(?![\\\\/\\w.])', 'i')
  const writeVerbs = /(?:New-Item|Set-Content|Add-Content|Out-File|(?:^|\s)>+|2>+)/i
  return (cmd) => {
    const text = String(cmd)
    const m = text.match(directTarget)
    if (!m || typeof m.index !== 'number') return false
    return writeVerbs.test(text.slice(0, m.index))
  }
}

// Rule 5：目录外绝对路径令牌（盘符 / UNC / 常见 $env 家目录 / ~）
const ABS_TOKEN_RES = [
  /[A-Za-z]:\\[^\s'";]+/g,
  /\\\\[^\s'";]+/g,
  /\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOME|TEMP|TMP)\\[^\s'";]+/g,
  /~\\[^\s'";]+/g,
]
// Rule 5：修改/删除类动词（只读命令不触发确认）
const MODIFY_VERBS = /(?:New-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|Rename-Item|Clear-Content|Set-Item|del\b|erase\b|rmdir\b|rd\b|ren\b|copy\b|xcopy\b|robocopy\b|mkdir\b|md\b|rm\b|move\b|(?:^|\s)>+|2>+)/i

// ---------------- enforcer ----------------
/**
 * 构建规则执行器。
 * @param {object} deps 运行期服务依赖（由插件壳注入，测试可传桩）
 * @param {object|undefined} deps.fs - { resolve(path, {cwd}), processPath(target) }
 * @param {object|undefined} deps.sandboxPolicy - { resolve(), workspaceRoot }
 * @param {object|undefined} deps.sessionTitle - { get(session) }
 * @param {(agent) => string|undefined} deps.rootOf - 会话工作区根目录
 * @param {(agent) => string} deps.sessionNameOf - 会话名（用于日志目录）
 * @param {(agent, file, line) => void} [deps.log] - 日志追加（fire-and-forget）
 * @param {() => boolean} [deps.enabled] - 插件开关；false 时一律放行
 * @returns {(exec: object) => Promise<object|undefined>}
 */
export function buildEnforcer(deps) {
  const { fs, sandboxPolicy, sessionTitle, rootOf, sessionNameOf, log } = deps
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => true

  const isUnder = (abs, root) => {
    if (!abs || !root) return false
    const a = normalizePath(abs)
    const r = normalizePath(root)
    return lower(a) === lower(r) || lower(a).startsWith(lower(r) + '\\')
  }

  const resolveAbs = async (p, cwd) => {
    if (!fs) return undefined
    try {
      const t = await fs.resolve(String(p), { cwd })
      return fs.processPath(t)
    } catch (e) {
      return undefined
    }
  }

  const envFileAtRoot = (absPath, root) => {
    if (!absPath || !root) return false
    return lower(basename(absPath)) === '.env' && lower(dirname(absPath)) === normRoot(root)
  }

  const summarize = (args) => {
    try {
      const s = JSON.stringify(args)
      return s.length > 240 ? s.slice(0, 240) + '…' : s
    } catch (e) {
      return String(args)
    }
  }

  // Rule 2：各类工具对根目录 .env 的访问检测
  const isEnvAttempt = async (name, args, root) => {
    const nRootEnv = lower(join(root, '.env'))
    if (name === 'read' || name === 'write' || name === 'edit' || name === 'read_image') {
      if (typeof args.file_path === 'string') {
        const abs = await resolveAbs(args.file_path, root)
        if (abs && envFileAtRoot(abs, root)) return true
      }
    }
    if ((name === 'glob' || name === 'grep') && typeof args.pattern === 'string') {
      if (ENV_PATTERN_RE.test(args.pattern)) {
        const base = typeof args.path === 'string' ? args.path : '.'
        const abs = await resolveAbs(base, root)
        if (abs && (lower(abs) === normRoot(root) || envFileAtRoot(abs, root))) return true
      } else if (name === 'grep' && typeof args.path === 'string') {
        const abs = await resolveAbs(args.path, root)
        if (abs && envFileAtRoot(abs, root)) return true
      }
    }
    if (name === 'pwsh') {
      const cmd = stripHereStrings(String(args.command || ''))
      const workdir = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : root
      const wdAbs = await resolveAbs(workdir, root)
      const wdIsRoot = wdAbs ? lower(wdAbs) === normRoot(root) : lower(workdir) === normRoot(root)
      if (ENV_TOKEN_RE.test(cmd) && wdIsRoot) return true
      if (cmd.toLowerCase().includes(nRootEnv)) return true
    }
    try {
      if (JSON.stringify(args).toLowerCase().includes(nRootEnv)) return true
    } catch (e) { /* ignore */ }
    return false
  }

  // Rule 5：仅“修改/删除”目录外文件需要确认；只读默认放行
  const outsideModifyTarget = async (name, args, root) => {
    if (name === 'write' || name === 'edit') {
      if (typeof args.file_path === 'string') {
        const abs = await resolveAbs(args.file_path, root)
        if (abs && !isUnder(abs, root)) return String(args.file_path)
      }
      return undefined
    }
    if (name === 'pwsh') {
      const cmd = stripHereStrings(String(args.command || ''))
      if (typeof args.workdir === 'string' && args.workdir.length > 0) {
        const wdAbs = await resolveAbs(args.workdir, root)
        if (wdAbs && !isUnder(wdAbs, root) && MODIFY_VERBS.test(cmd)) return 'workdir=' + String(args.workdir)
      }
      for (const re of ABS_TOKEN_RES) {
        const toks = cmd.match(re)
        if (!toks) continue
        for (const raw of toks) {
          const tok = trimToken(collapseDots(raw))
          if (!tok) continue
          const abs = await resolveAbs(tok, root)
          const outside = abs ? !isUnder(abs, root) : !isUnder(tok, root)
          if (!outside) continue
          const idx = cmd.indexOf(raw)
          const prefix = idx >= 0 ? cmd.slice(0, idx) : cmd
          if (MODIFY_VERBS.test(prefix)) return tok
        }
      }
      return undefined
    }
    return undefined
  }

  /**
   * 对一次工具调用作出裁决。
   * @param {object} exec - { name, arguments, agent, ... }
   * @returns {Promise<{ kind: 'deny', reason: string } | { kind: 'ask', reason: string } | undefined>}
   */
  return async function enforce(exec) {
    if (!enabled()) return undefined
    const agent = exec && exec.agent
    if (!agent) return undefined
    const root = rootOf(agent)
    if (!root) return undefined
    const name = exec.name
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    const nRoot = normRoot(root)

    // Rule 2：根目录 .env 一律拦截并告知
    if (await isEnvAttempt(name, args, root)) {
      if (log) log(agent, 'env-access.log', 'DENIED 工具 ' + name + ' 试图访问/修改/删除项目根目录 .env: ' + summarize(args))
      return { kind: 'deny', reason: '【restrict-discipline · 规则 1.2 .env 保护】检测到对项目根目录 .env 文件的访问/修改/删除尝试（工具：' + name + '）。已阻止，并已记录到 log/ 目录。请立即在回复中告知用户发生了此事件。' }
    }

    if (name === 'pwsh') {
      const cmd = stripHereStrings(String(args.command || ''))
      // Rule 3：禁止修改代理设置
      if (PROXY_PATTERNS.some(re => re.test(cmd))) {
        if (log) log(agent, 'denials.log', 'DENIED pwsh 试图修改系统/工具代理设置: ' + String(cmd).replace(/\s+/g, ' ').trim().slice(0, 200))
        return { kind: 'deny', reason: '【restrict-discipline · 规则 1.3 代理保护】禁止修改系统代理设置或 git/npm 等工具的 proxy 配置。已阻止该命令。' }
      }
      // Rule 1（pwsh 途径）：根目录直接建文件
      if (rootWriteCheck(root)(cmd)) {
        return { kind: 'deny', reason: '【restrict-discipline · 规则 1.1 文件分类】禁止在项目根目录创建文件。请把文件放入对应的分类子目录（如 scripts/、log/）。' }
      }
    }

    // Rule 1（write 工具途径）：根目录直接建文件
    if (name === 'write' && typeof args.file_path === 'string') {
      const abs = await resolveAbs(args.file_path, root)
      if (abs && lower(dirname(abs)) === nRoot) {
        return { kind: 'deny', reason: '【restrict-discipline · 规则 1.1 文件分类】禁止在项目根目录创建文件：' + args.file_path + '。请放入对应的分类子目录（如 scripts/、log/）。' }
      }
    }

    // Rule 5：仅“修改/删除”目录外文件需确认
    const outside = await outsideModifyTarget(name, args, root)
    if (outside) {
      return { kind: 'ask', reason: '【restrict-discipline · 规则 1.5 目录外确认】检测到对项目目录以外文件的修改/删除：' + outside + '（工具：' + name + '）。是否允许执行？' }
    }

    return undefined
  }
}
