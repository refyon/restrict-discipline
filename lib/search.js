// lib/search.js — 操作脚本检索（规则 4 复用）。
// 纯逻辑、无依赖，可在 test/smoke-host.mjs 中独立测试。
//
// 设计目的：Agent 执行有实际效果的操作前，先按关键词检索 scripts/ 下是否
// 已有相同/相似的已记录脚本；命中则直接运行已有脚本（复用），从而避免重复
// 执行与重复记录，节省 token。

/** 关键词是否命中（匹配文件名 / 描述 / 命令内容，忽略大小写）。 */
export function matchesKeyword(keyword, name, description, command) {
  const k = String(keyword || '').trim().toLowerCase()
  if (!k) return false
  const hay = [name, description, command].join(' ').toLowerCase()
  return hay.includes(k)
}

/**
 * 解析一个 .ps1 记录脚本：第一段 # 注释为描述，其余可执行行为命令。
 * 返回 { description, command }。
 */
export function parsePs1(text) {
  const lines = String(text || '').split(/\r?\n/)
  let description = ''
  let command = ''
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('#')) {
      if (!description) description = t.replace(/^#+\s*/, '')
    } else if (t) {
      command = command ? command + '\n' + t : t
    }
  }
  return { description, command }
}

/**
 * 检索 scripts/ 目录（含根目录散落脚本与各会话子目录）下与关键词匹配的
 * 已记录 .ps1 脚本。deps 注入 fs 能力以便测试：
 *   resolve(path, { cwd }) -> target
 *   listDir(target) -> [{ name, type, target }]
 *   readText(target) -> string
 * 返回 { count, matches }，matches 每项：
 *   { session, base, description, command }（command 截断到 200 字符）
 */
export async function searchScripts({ resolve, listDir, readText, cwd, keyword, limit = 8 }) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return { count: 0, matches: [] }

  let scriptsDir
  try {
    scriptsDir = await resolve('scripts', { cwd })
  } catch {
    return { count: 0, matches: [] }
  }

  let top
  try {
    top = await listDir(scriptsDir)
  } catch {
    return { count: 0, matches: [] }
  }

  const matches = []
  const consider = async (session, target, name) => {
    if (!/\.ps1$/i.test(name)) return
    let text
    try {
      text = await readText(target)
    } catch {
      return
    }
    const { description, command } = parsePs1(text)
    if (matchesKeyword(kw, name, description, command)) {
      matches.push({
        session,
        base: name.replace(/\.ps1$/i, ''),
        description,
        command: command.slice(0, 200),
      })
    }
  }

  // 根目录散落脚本（session 记为 "(根目录)"）
  const rootFiles = top.filter((e) => e.type === 'file')
  await Promise.all(rootFiles.map((e) => consider('(根目录)', e.target, e.name)))

  // 各会话子目录
  for (const entry of top) {
    if (entry.type !== 'directory') continue
    let sub
    try {
      sub = await listDir(entry.target)
    } catch {
      continue
    }
    await Promise.all(sub.filter((f) => f.type === 'file').map((f) => consider(entry.name, f.target, f.name)))
  }

  return { count: matches.length, matches: matches.slice(0, limit) }
}
