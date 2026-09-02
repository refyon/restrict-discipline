// lib/memory.js — 会话记忆自动注入（规则 3.1）纯逻辑，无副作用、可独立测试。
//
// 新会话首次内容解析时，把 memory/ 中与当前任务最相关的历史摘要注入上下文，
// 每会话仅一次（由 lib/index.js 按会话 id 记一次性，后续轮次不再检索）。
// 检索复用 lib/search.js 的 BM25（文件名×2 / 内容×1，中文 bigram 分词）+
// 时间衰减（更新的摘要加权）；v0.6 起渲染为「渐进披露索引块」（默认 ≤700 字符、
// 每文件一行摘要），细节由 agent 调 recall_memory 下钻，控制注入 token 预算。
import { buildSearchIndex, querySearchIndex } from './search.js'
import { clip } from './digest.js'
import { firstTitle } from './memfile.js'

// ---- 命中质量：摘要样板行剥离 + 查询停用词 ----
// 每个 memory 摘要都含固定样板行（# 会话摘要 / ## 消息统计 / ## 脚本清单 /
// ## 最近对话 / ## 记忆条目 / ## 已归档条目 / 会话ID / 更新时间 / 摘要来源等），
// 其词汇会让任何查询都与所有文件等权匹配，淹没真实相关度。索引前剥离这些行；
// 查询侧再滤掉结构类停用词，避免其参与匹配。
const BOILERPLATE_LINE_RE = /^(#\s*会话摘要|#+\s*(消息统计|脚本清单|最近对话|记忆条目|已归档条目)|>\s*(会话|更新)|会话\s*ID\s*:|更新时间\s*:|摘要来源\s*:|消息统计|最近对话（|最近对话\()/i
// 长词在前，避免被短词先吞掉（如 "更新时间" 先于 "更新"）
const MEMORY_STOPWORD_RE = /历史记忆|更新时间|自动生成|消息统计|最近对话|本会话|上一会话|会话|摘要|更新|自动|生成|统计|消息|最近|对话|历史|记忆|时间|来源/g

/** 剥离 memory 摘要中的固定样板行，保留实质内容（脚本清单、对话摘录等）。 */
export function stripDigestBoilerplate(text) {
  return String(text || '').split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return t.length > 0 && !BOILERPLATE_LINE_RE.test(t)
  }).join('\n')
}

/** 从查询文本剔除记忆检索停用词，返回清理后的查询串。 */
export function normalizeMemoryQuery(query) {
  return String(query || '').replace(MEMORY_STOPWORD_RE, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 查询信息量保护：信息量太少的短查询（如"请继续"）经 BM25 检索会命中
 * 与任务无关的摘要，宁可不注入。含 3+ 字母的 ASCII 词（如 restrict-discipline）
 * 视为信息充分；纯中文则要求过滤后至少 3 个 bigram 词元（约 4 个汉字）。
 */
export function hasEnoughQueryInfo(query) {
  const q = normalizeMemoryQuery(query)
  if (!q) return false
  if (/[A-Za-z0-9]{3,}/.test(q)) return true
  const zh = q.replace(/[A-Za-z0-9_ -]+/g, '').replace(/\s+/g, '')
  return zh.length >= 4
}

/**
 * 从 memory 文件集合中按 BM25（+时间衰减）选出与 query 最相关的 topN 条。
 * @param {object[]} files - [{ name, text, ts? }]（name 为文件名，text 为摘要全文，
 *   ts 为可选修改时间戳毫秒，参与时间衰减）
 * @param {string} query - 当前任务文本（通常为会话首条用户消息）
 * @param {object} [opts] - { limit = 3, excludeName, halfLifeDays = 60 }；
 *   excludeName 排除当前会话自己的摘要（如 '会话A.md'，比较时忽略扩展名），
 *   避免自我回放。
 * @returns {object[]} 保持原顺序按相关度降序的 [{ name, text, ts? }]；
 *   query 无有效词元（如纯符号）或无文件时返回 []。
 */
export function rankMemoryFiles(files, query, { limit = 3, excludeName, halfLifeDays = 60 } = {}) {
  const q = normalizeMemoryQuery(query)
  if (!q || !Array.isArray(files) || files.length === 0) return []
  if (!hasEnoughQueryInfo(q)) return []
  const excludeBase = String(excludeName || '').replace(/\.(md|txt)$/i, '').toLowerCase()
  const records = []
  const keep = []
  for (const f of files) {
    if (!f || typeof f.name !== 'string') continue
    const base = f.name.replace(/\.(md|txt)$/i, '').toLowerCase()
    if (excludeName && base === excludeBase) continue
    const digest = stripDigestBoilerplate(f.text).trim()
    if (!digest) continue
    const ts = typeof f.ts === 'number' && f.ts > 0 ? f.ts : 0
    // 检索用剥离版（digest）；返回同时带原文 text（供取标题/证据行）与剥离版 digest
    records.push({ session: '', base: f.name, name: f.name, description: '', command: digest, ts })
    keep.push({ name: f.name, text: f.text, digest, ts })
  }
  if (records.length === 0) return []
  const index = buildSearchIndex(records)
  const now = Date.now()
  const scored = querySearchIndex(index, q)
    .map(({ docIdx, score }) => {
      const ts = index.docs[docIdx] && index.docs[docIdx].ts
      const ageDays = ts ? Math.max(0, (now - ts) / 86400000) : 0
      return { docIdx, score: score * Math.exp(-ageDays / halfLifeDays) }
    })
    .sort((a, b) => (b.score - a.score) || (a.docIdx - b.docIdx))
  return scored.slice(0, limit).map(({ docIdx }) => keep[docIdx])
}

/**
 * 渲染记忆注入块。无内容时返回 ''（不注入，避免污染上下文）。
 * @param {object[]} selected - rankMemoryFiles 的结果
 * @param {object} [opts] - { maxChars = 600 } 每条摘要的截断长度
 * @deprecated v0.6 起默认改用 renderMemoryIndex（渐进披露，只注一行摘要）。
 */
export function renderMemoryBlock(selected, { maxChars = 600 } = {}) {
  if (!Array.isArray(selected) || selected.length === 0) return ''
  const lines = selected.map((f) => '- memory\\' + f.name + '：' + clip((f.digest || f.text || '').replace(/\r?\n/g, ' '), maxChars))
  return '【历史记忆（restrict-discipline 自动注入，本会话仅注入一次，请直接复用，勿重复读取 memory/ 目录）】\n' + lines.join('\n')
}

/**
 * 渲染渐进披露记忆索引块（v0.6 默认注入格式）：每文件只取标题（无标题取正文首行）
 * 一行，总量受 maxChars 预算约束；agent 需要细节时用 recall_memory 下钻。
 * @param {object[]} selected - rankMemoryFiles 的结果（保持相关度降序）
 * @param {object} [opts] - { maxChars = 700, limit = 3 }
 * @returns {string} '' 表示无内容可注入
 */
export function renderMemoryIndex(selected, { maxChars = 700, limit = 3 } = {}) {
  if (!Array.isArray(selected) || selected.length === 0) return ''
  const header = '【历史记忆（restrict-discipline 自动注入，本会话仅注入一次；细节可用 recall_memory 下钻）】'
  const names = selected.slice(0, limit)
  const usable = Math.max(60, Number(maxChars) - header.length - 20)
  const per = Math.max(40, Math.floor(usable / names.length))
  const lines = []
  let total = 0
  for (const f of names) {
    const raw = String(f.text || '')
    const t = firstTitle(raw) || clip((f.digest || raw).replace(/\s+/g, ' ').trim(), per)
    const line = '- memory\\' + f.name + '：' + clip(t.replace(/\r?\n/g, ' ').trim(), per)
    total += line.length
    lines.push(line)
    if (total > usable + per) break // 预算超限则停止（保留已生成的高相关行）
  }
  return header + '\n' + lines.join('\n')
}

/**
 * 生成"已回忆历史记忆"提示语：reasoning 为思考块内容（含命中文件清单），
 * text 为界面与模型可见的简短自标注注记（保持消息内容非空，兼容适配器序列化）。
 * @param {object[]} selected - rankMemoryFiles 的结果
 * @returns {{ reasoning: string, text: string }}
 */
export function buildRecallNotice(selected) {
  const names = Array.isArray(selected) && selected.length > 0
    ? selected.map((f) => f && f.name).filter(Boolean).join('、')
    : ''
  return {
    reasoning: '【回忆】已从 memory/ 检索到相关历史记忆并注入上下文' + (names ? '：' + names : '') + '。本会话仅注入一次，后续不再重复检索。',
    text: '（restrict-discipline 系统注记：已回忆并注入历史记忆，详见上方思考。）',
  }
}
