// lib/memfile.js — memory/*.md 记忆文件的纯逻辑（无依赖、可独立测试）。
//
// 会话摘要与显式记忆统一存为 Markdown 文档：memory/<会话id>_<标题>.md。
// 文件结构（分节，按出现顺序）：
//   # 会话摘要 — <标题>          ← digest 每次会话 idle 重写（合并保留下列分节）
//   ## 消息统计 / ## 脚本清单 / ## 最近对话   ← digest 内容
//   ## 记忆条目                   ← remember 工具追加（append-only）
//   ## 已归档条目                 ← forget 移入 / GC 保留（软删可恢复）
//
// 条目行格式：- [<id>] <ISO时间> <内容>（来源: <会话id> · 轮次 <turn>）[ · 标签 <tags>]

export const ENTRIES_H = '## 记忆条目'
export const ARCHIVED_H = '## 已归档条目'

/** 摘取 Markdown 一级标题文本（首行 `# xxx`），无则返回 ''。 */
export function firstTitle(text) {
  const m = String(text || '').match(/^\s*#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : ''
}

/** 解析一条条目行的 when（ISO 前缀），返回毫秒时间戳；无法解析返回 0。 */
export function parseWhen(line) {
  const m = String(line || '').match(/-\s*\[[^\]]+\]\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  if (!m) return 0
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? t : 0
}

/** 解析条目行 → { id, when, content, raw }；非条目行返回 null。 */
export function parseEntryLine(line) {
  const m = String(line || '').match(/^\s*-\s*\[([^\]]+)\]\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*(.*?)\s*$/)
  if (!m) return null
  return { id: m[1], when: m[2], content: m[3], raw: line }
}

/**
 * 组装一条记忆条目文本行。
 * @param {object} p - { id, iso, content, source, turn, tags? }
 * @returns {string} 条目行（不含结尾换行）
 */
export function entryLine(p) {
  let tail = '（来源: ' + (p.source || '?')
  if (typeof p.turn === 'number' && p.turn > 0) tail += ' · 轮次 ' + p.turn
  tail += '）'
  if (Array.isArray(p.tags) && p.tags.length > 0) tail += ' · 标签 ' + p.tags.join(',')
  return '- [' + p.id + '] ' + p.iso + ' ' + String(p.content).replace(/\s+/g, ' ').trim() + tail
}

/** 按分节切分文件 → { digest, entries[], archived[] }（各为行数组，去结尾空行）。 */
export function splitFile(text) {
  const lines = String(text || '').split(/\r?\n/)
  const digest = []
  const entries = []
  const archived = []
  let section = 0 // 0=digest 1=entries 2=archived
  for (const raw of lines) {
    const t = raw.trimEnd()
    if (t === ENTRIES_H) { section = 1; continue }
    if (t === ARCHIVED_H) { section = 2; continue }
    if (t.trim() === '') continue
    if (section === 0) digest.push(t)
    else if (section === 1) entries.push(t)
    else archived.push(t)
  }
  return { digest, entries, archived }
}

/** 从分节结果重组成完整文件文本（digest 部分为空时仍写 entries/archived）。 */
export function rebuildFile({ digest, entries, archived }) {
  const parts = []
  const head = (digest || []).map((l) => l.trimEnd()).filter(Boolean)
  const es = (entries || []).map((l) => l.trim()).filter(Boolean)
  const as = (archived || []).map((l) => l.trim()).filter(Boolean)
  if (head.length > 0) parts.push(head.join('\n'))
  if (es.length > 0) parts.push(ENTRIES_H + '\n' + es.join('\n'))
  if (as.length > 0) parts.push(ARCHIVED_H + '\n' + as.join('\n'))
  return parts.length > 0 ? parts.join('\n\n') + '\n' : ''
}

/** 追加一条条目到「记忆条目」节（不存在则创建）。 */
export function appendEntry(text, line) {
  const s = splitFile(text)
  if (String(line || '').trim()) s.entries.push(String(line).trim())
  return rebuildFile(s)
}

/**
 * 追加一条条目到 Markdown 文件的「## 记忆条目」节（项目记忆文件专用追加器）：
 * 保留原文件其余内容**原样**（含空行与任意结构）。与 appendEntry（splitFile 路线，
 * 重建时会滤空行）不同——项目记忆文件的正文（# 条目 / 段落 / 列表）不允许被重建破坏。
 * 节不存在时在文件尾创建。
 */
export function appendMemoryEntry(text, line) {
  const entry = String(line || '').trim()
  const s = String(text || '').replace(/\r\n/g, '\n')
  if (!entry) return s
  const lines = s.split('\n')
  const entIdx = lines.findIndex((l) => l.trim() === ENTRIES_H)
  if (entIdx === -1) {
    const tail = s === '' ? '' : (s.endsWith('\n') ? '\n' : '\n\n')
    return s + tail + ENTRIES_H + '\n' + entry + '\n'
  }
  const arcIdx = lines.findIndex((l) => l.trim() === ARCHIVED_H)
  const insertAt = arcIdx !== -1 && arcIdx > entIdx ? arcIdx : lines.length
  // 找到节内最后一个非空行，紧跟其后插入（保留节尾空行分隔）
  let lastContent = entIdx
  for (let i = entIdx + 1; i < insertAt; i++) {
    if (lines[i].trim() !== '') lastContent = i
  }
  const out = lines.slice()
  out.splice(lastContent + 1, 0, entry)
  return out.join('\n') + '\n'
}

/** 活动（未归档）条目数。 */
export function countEntries(text) {
  return splitFile(text).entries.length
}

/**
 * 软删除（forget）：把「记忆条目」中匹配 id（精确）或内容子串（大小写不敏感）
 * 的条目移入「已归档条目」。返回 { text, moved, ids }。
 */
export function forgetEntry(text, idOrQuery) {
  const q = String(idOrQuery || '').trim().toLowerCase()
  if (!q) return { text, moved: 0, ids: [] }
  const s = splitFile(text)
  const movedIds = []
  const keep = []
  for (const line of s.entries) {
    const p = parseEntryLine(line)
    const hit = p && (q === String(p.id).toLowerCase() || String(p.content).toLowerCase().includes(q))
    if (hit) { movedIds.push(p.id); s.archived.push(line) }
    else keep.push(line)
  }
  s.entries = keep
  return { text: rebuildFile(s), moved: movedIds.length, ids: movedIds }
}

/**
 * 记忆 GC（只归档不硬删的相反面是：已归档条目超期才物理清除）。
 * 把「已归档条目」中 when 早于 now-retention 的条目物理删除。
 * @param {string} text
 * @param {number} nowMs
 * @param {number} retentionDays - 保留天数
 * @returns {{ text: string, purged: number, preview: string[] }}
 */
export function purgeArchived(text, nowMs, retentionDays) {
  const cutoff = nowMs - Number(retentionDays || 0) * 86400000
  const s = splitFile(text)
  const keep = []
  const gone = []
  for (const line of s.archived) {
    const when = parseWhen(line)
    if (when > 0 && when < cutoff) gone.push(line)
    else keep.push(line)
  }
  s.archived = keep
  return { text: rebuildFile(s), purged: gone.length, preview: gone }
}
