// lib/memory.js — 会话记忆自动注入（规则 16）纯逻辑，无副作用、可独立测试。
//
// 新会话首次内容解析时，把 memory/ 中与当前任务最相关的历史摘要注入上下文，
// 每会话仅一次（由 lib/index.js 按会话 id 记一次性，后续轮次不再检索）。
// 检索复用 lib/search.js 的 BM25（文件名×2 / 内容×1，中文 bigram 分词），
// 渲染时用 lib/digest.js 的 clip 截断每条，控制注入的 token 预算。
import { buildSearchIndex, querySearchIndex } from './search.js'
import { clip } from './digest.js'

/**
 * 从 memory 文件集合中按 BM25 选出与 query 最相关的 topN 条。
 * @param {object[]} files - [{ name, text }]（name 为文件名，text 为摘要全文）
 * @param {string} query - 当前任务文本（通常为会话首条用户消息）
 * @param {object} [opts] - { limit = 3, excludeName }；excludeName 排除当前会话
 *   自己的摘要（如 '会话A.txt'），避免自我回放。
 * @returns {object[]} 保持原顺序按相关度降序的 [{ name, text }]；query 无有效词元
 *   （如纯符号）或无文件时返回 []。
 */
export function rankMemoryFiles(files, query, { limit = 3, excludeName } = {}) {
  const q = String(query || '').trim()
  if (!q || !Array.isArray(files) || files.length === 0) return []
  const records = []
  const keep = []
  for (const f of files) {
    if (!f || typeof f.name !== 'string') continue
    if (excludeName && f.name.toLowerCase() === String(excludeName).toLowerCase()) continue
    const text = String(f.text || '').trim()
    if (!text) continue
    records.push({ session: '', base: f.name, name: f.name, description: '', command: text })
    keep.push({ name: f.name, text })
  }
  if (records.length === 0) return []
  const index = buildSearchIndex(records)
  const scored = querySearchIndex(index, q)
  return scored.slice(0, limit).map(({ docIdx }) => keep[docIdx])
}

/**
 * 渲染记忆注入块。无内容时返回 ''（不注入，避免污染上下文）。
 * @param {object[]} selected - rankMemoryFiles 的结果
 * @param {object} [opts] - { maxChars = 600 } 每条摘要的截断长度
 */
export function renderMemoryBlock(selected, { maxChars = 600 } = {}) {
  if (!Array.isArray(selected) || selected.length === 0) return ''
  const lines = selected.map((f) => '- memory\\' + f.name + '：' + clip(f.text.replace(/\r?\n/g, ' '), maxChars))
  return '【历史记忆（restrict-discipline 自动注入，本会话仅注入一次，请直接复用，勿重复读取 memory/ 目录）】\n' + lines.join('\n')
}
