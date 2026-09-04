// lib/memload.js — memory/CLAUDE.md 项目记忆的纯逻辑（无依赖、可独立测试）。
//
// 参考 Claude Code 的 CLAUDE.md 记忆机制（docs/restrict-discipline-claude-code记忆重构评估.md 第 3 节）：
//  1. 文件即记忆：会话启动时全量加载 memory/CLAUDE.md（确定性加载，无 BM25 检索），
//     超 maxLoadChars（默认 25KB，参照 Claude Code 子代理记忆注入 200 行/25KB 上限先例）截断并注记。
//  2. # 快捷方式：文件中一级标题是记忆条目；用户消息里的「#条目名」触发定向召回，
//     把对应条目区块注入上下文（Claude Code 的 memory shortcuts，issue #14743 佐证）。
//  3. 路径固定：本模块只认 memory/CLAUDE.md 这一个路径，杜绝模型猜路径（官方教训 issue #36973）。

/** 默认注入上限（字符数）≈ 25KB，参照 Claude Code 官方 subagent 记忆注入上限先例。 */
export const DEFAULT_MAX_CHARS = 25600

/** 切分 CLAUDE.md 文本为条目：一级标题 = 条目 token；首个一级标题之前的内容为前导头。 */
export function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const preamble = []
  const sections = []
  let cur = null
  for (const raw of lines) {
    const m = raw.match(/^#\s+(.+?)\s*$/)
    if (m) {
      cur = { token: m[1].trim(), lines: [raw] }
      sections.push(cur)
    } else if (cur) {
      cur.lines.push(raw)
    } else {
      preamble.push(raw)
    }
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ token: s.token, text: s.lines.join('\n').trim() })),
  }
}

/** 从用户消息文本提取 #条目名 形式的快捷 token（Unicode 字母/数字/下划线/连字符，≥2 字符）。 */
export function detectShortcuts(message) {
  const out = []
  const seen = new Set()
  for (const m of String(message || '').matchAll(/#([\p{L}\p{N}_-]{2,})/gu)) {
    const t = m[1]
    const key = t.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

/** 按 token 定向召回条目：精确匹配（大小写不敏感）任一一级标题。 */
export function recallSections(text, token) {
  const q = String(token || '').trim().toLowerCase()
  if (!q) return []
  const { sections } = splitSections(text)
  return sections.filter((s) => s.token.toLowerCase() === q)
}

/** 全量加载裁剪：超过 maxChars 截断（保留头部），返回 { text, truncated, total }。 */
export function capLoad(text, maxChars) {
  const s = String(text || '')
  const max = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : DEFAULT_MAX_CHARS
  if (s.length <= max) return { text: s, truncated: false, total: s.length }
  return { text: s.slice(0, max), truncated: true, total: s.length }
}

/** 渲染项目记忆注入块（会话启动用）。text 为空时返回 ''。 */
export function renderLoadBlock(text, maxChars) {
  const { text: body, truncated, total } = capLoad(text, maxChars)
  if (!body.trim()) return ''
  const header = '【项目记忆 memory/CLAUDE.md（restrict-discipline 自动注入，需要细节时直接 read 该文件；用户消息中含「#条目名」可定向召回对应条目）】'
  const note = truncated ? '\n\n（文件共 ' + total + ' 字符，超出注入上限已截断到 ' + body.length + ' 字符；剩余部分请按需 read）' : ''
  return header + '\n' + body + note
}

/** 渲染 # 快捷召回块。hits 为 recallSections 结果；无命中返回 ''。 */
export function renderRecallBlock(hits, token) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const header = '【# 快捷召回：' + token + '（memory/CLAUDE.md 条目，restrict-discipline 注入）】'
  return header + '\n' + hits.map((h) => h.text).join('\n\n')
}
