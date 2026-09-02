// lib/redact.js — 记忆写入前的秘密脱敏（敏感内容绝不落盘）。
// 纯逻辑、无依赖、可独立测试。只处理传入的字符串（内存中），
// 绝不读取任何文件——包括根目录 .env（根 .env 的访问由 enforce.js 拦截）。

// 每条规则：正则整体为匹配目标；keepPrefix=true 时 g1 是前缀（如 "Bearer "）；
// keepKey=true 时 g1 是键名（key=value 形），回调里保留键名只掩码值；
// 其余规则 g1 == 整段匹配，整体替换为占位符。
const RULES = [
  // PEM 私钥块（放最前，避免内部内容被下面规则二次改写）
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, label: 'private_key' },
  // AWS Access Key
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, label: 'aws_access_key' },
  // GitHub tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ ...
  { re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, label: 'github_token' },
  // OpenAI-style sk-...
  { re: /\b(sk-[A-Za-z0-9_-]{8,})\b/g, label: 'api_key' },
  // JWT（三段 base64url，每段足够长）
  { re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, label: 'jwt' },
  // Bearer token（保留 "Bearer " 前缀）
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, label: 'bearer_token', keepPrefix: true },
  // key=value / key: value 形式的敏感键（保留键名）
  { re: /\b(api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"'`;&,)]+/gi, label: 'secret', keepKey: true },
]

/**
 * 把文本中的密钥/令牌替换为 <REDACTED:类型>。
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  let count = 0
  for (const r of RULES) {
    out = out.replace(r.re, (full, g1) => {
      count++
      if (r.keepPrefix) return g1 + '<REDACTED:' + r.label + '>'
      if (r.keepKey) {
        const sep = full.search(/[:=]/)
        const keyPart = full.slice(0, sep >= 0 ? sep + 1 : full.length)
        let val = sep >= 0 ? full.slice(sep + 1) : ''
        const opened = /^["']/.test(val) ? val[0] : ''
        if (opened) val = val.slice(1)
        return keyPart + opened + '<REDACTED:' + r.label + '>' + (opened || '')
      }
      return '<REDACTED:' + r.label + '>'
    })
  }
  return { text: out, count }
}

/** 便捷包装：仅返回脱敏文本。 */
export function redact(text) {
  return redactSecrets(text).text
}
