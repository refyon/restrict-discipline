// lib/digest.js — 会话摘要净化（规则 6）纯逻辑，无依赖、可独立测试。
//
// 目标：摘要只保留对跨会话复用有信息量的内容，剔除运行时噪音，降低新会话
// 读取摘要时的 token 消耗。识别并丢弃：
//   - 运行时上下文快照（"Current runtime context. ..."）
//   - 系统提醒块（"<system-reminder> ..."）
//   - 自动生成的 checkpoint 压缩块
// 另提供脚本清单去重与消息截断。

/** 判断一段文本是否为运行时噪音（上下文快照 / 系统提醒 / checkpoint）。 */
export function isNoise(text) {
  const s = String(text || '').trim()
  if (!s) return true
  return /^current runtime context/i.test(s)
    || /^<system-reminder>/i.test(s)
    || /^this is an automatically generated checkpoint/i.test(s)
}

/** 从 content blocks 提取纯文本（与 lib/index.js 原 textOf 一致）。 */
export function textOf(blocks) {
  try {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  } catch (e) {
    return ''
  }
}

/** 截断长文本到 maxLen（默认 150 字符），超出加省略号。 */
export function clip(text, maxLen = 150) {
  const s = String(text || '')
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

/**
 * 从 index.md 文本提取脚本清单行并去重。
 * 输入形如 "- [xxx.cmd](xxx.cmd) — 描述"；同名（同文件名）只保留首次出现。
 */
export function pickScriptLines(indexText) {
  const seen = new Set()
  const out = []
  for (const raw of String(indexText || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!/^- \[.+\.cmd\]/.test(line)) continue
    const m = line.match(/^- \[([^\]]+\.cmd)\]/)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.slice(0, 20)
}
