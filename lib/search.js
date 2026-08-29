// lib/search.js — 操作脚本检索（规则 4 复用）。
// 纯逻辑、无依赖，可在 test/smoke-host.mjs 中独立测试。
//
// 设计目的：Agent 执行有实际效果的操作前，先按关键词检索 scripts/ 下是否
// 已有相同/相似的已记录脚本；命中则直接运行已有脚本（复用），从而避免重复
// 执行与重复记录，节省 token。
//
// P0 优化（2026-08）：从"每次全量读文件 + 子串匹配"升级为「内存倒排索引 +
// BM25 相关性排序」：
//   - 首次查询扫描 scripts/ 建索引：中文 bigram 分词、ASCII 小写分词（长度≥2）、
//     字段加权（文件名×2 / 描述×1.5 / 命令×1）；之后查询零文件读取；
//   - scripts/ 树签名（顶层条目名 + 各会话子目录文件名集合）变化时自动重建索引，
//     覆盖 record_operation 新增脚本与手工增删；
//   - 关键词分词为空（如纯符号）时回退旧的全量子串扫描路径，保持原行为；
//   - 模块级缓存（上限 8 个工作区，FIFO 淘汰）。
// 已知限制：已记录的 .ps1 视为不可变（写入只新增）；手工修改既有脚本内容且不改
// 文件名时，索引不感知，需等下一次树签名变化或插件重启。

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

// ---------------- 分词 ----------------
// ASCII：小写后取连续字母数字串（长度≥2，滤掉盘符/单字符噪音）；
// CJK：连续汉字段拆成 bigram（单字段保留单字）。无需分词库即可让
// "打包发布" 与 "发布编译" 共享 "发布" bigram 而互相命中。
const ASCII_TOKEN_RE = /[a-z0-9]+/g
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g

/** 文本 → 词元数组（小写；ASCII 长度≥2；CJK bigram）。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const tokens = []
  for (const m of s.matchAll(ASCII_TOKEN_RE)) {
    if (m[0].length >= 2) tokens.push(m[0])
  }
  for (const m of s.matchAll(CJK_RUN_RE)) {
    const run = m[0]
    if (run.length === 1) tokens.push(run)
    else for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

// ---------------- BM25 倒排索引 ----------------
const FIELD_WEIGHTS = { name: 2, description: 1.5, command: 1 }
const K1 = 1.5
const B = 0.75

/**
 * 从记录集合构建倒排索引。
 * @param {object[]} records - [{ session, base, name, description, command }]
 * @returns {{ postings: Map<string, Map<number, number>>, docLens: number[], avgdl: number, docs: object[] }}
 *   postings: term -> Map(docIdx -> 加权词频 tf)；docs 供查询结果按 docIdx 回填。
 */
export function buildSearchIndex(records) {
  const postings = new Map()
  const docLens = []
  let totalLen = 0
  const add = (term, docIdx, weight) => {
    let byDoc = postings.get(term)
    if (!byDoc) postings.set(term, byDoc = new Map())
    byDoc.set(docIdx, (byDoc.get(docIdx) || 0) + weight)
  }
  records.forEach((rec, docIdx) => {
    let len = 0
    for (const field of ['name', 'description', 'command']) {
      const tokens = tokenize(rec[field])
      len += tokens.length
      const w = FIELD_WEIGHTS[field]
      for (const t of tokens) add(t, docIdx, w)
    }
    docLens.push(len)
    totalLen += len
  })
  return { postings, docLens, avgdl: records.length > 0 ? totalLen / records.length : 0, docs: records }
}

/** BM25+ IDF：ln(1 + (N - n + 0.5) / (n + 0.5)) */
function idf(n, N) {
  return Math.log(1 + (N - n + 0.5) / (n + 0.5))
}

/**
 * 在索引上查询关键词，返回按分数降序的 [{ docIdx, score }]（分数>0）。
 * 加权 tf（字段权重已并入）参与 BM25 饱和项与长度归一。
 */
export function querySearchIndex(index, keyword) {
  const terms = tokenize(keyword)
  const N = index.docs.length
  const scores = new Map()
  for (const t of terms) {
    const byDoc = index.postings.get(t)
    if (!byDoc) continue
    const idfT = idf(byDoc.size, N)
    for (const [docIdx, tf] of byDoc) {
      const dl = index.docLens[docIdx]
      const denom = tf + K1 * (1 - B + B * (dl / index.avgdl))
      const add = idfT * (tf * (K1 + 1)) / denom
      scores.set(docIdx, (scores.get(docIdx) || 0) + add)
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .map(([docIdx, score]) => ({ docIdx, score }))
}

// ---------------- 引擎与缓存 ----------------
// 模块级缓存：key = JSON 化的 resolve 结果（多工作区各占一条，FIFO 淘汰）。
const MAX_CACHE = 8
const cache = new Map() // key -> { sig, index }

/** scripts/ 树签名：顶层条目名 + 各会话子目录文件名集合（仅目录列举，不读文件内容）。 */
async function treeSig(listDir, top) {
  const parts = []
  for (const e of top) {
    if (e.type !== 'directory') { parts.push('F:' + e.name); continue }
    try {
      const sub = await listDir(e.target)
      const files = sub.filter((f) => f.type === 'file').map((f) => f.name).sort().join(',')
      parts.push('D:' + e.name + '[' + files + ']')
    } catch {
      parts.push('D:' + e.name + '[?]')
    }
  }
  return parts.sort().join('|')
}

/** 全量扫描 scripts/ 并构建索引（仅在缓存缺失或树签名变化时调用）。 */
async function buildTree({ listDir, readText }, top) {
  const records = []
  const consider = async (session, target, name) => {
    if (!/\.ps1$/i.test(name)) return
    let text
    try {
      text = await readText(target)
    } catch {
      return
    }
    const { description, command } = parsePs1(text)
    records.push({ session, base: name.replace(/\.ps1$/i, ''), name, description, command })
  }
  await Promise.all(top.filter((e) => e.type === 'file').map((e) => consider('(根目录)', e.target, e.name)))
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
  return buildSearchIndex(records)
}

/** 旧路径：全量读文件 + 子串匹配（仅关键词分词为空时回退使用）。 */
async function scanFallback({ listDir, readText, top, kw, limit }) {
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
  await Promise.all(top.filter((e) => e.type === 'file').map((e) => consider('(根目录)', e.target, e.name)))
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

/**
 * 检索 scripts/ 目录（含根目录散落脚本与各会话子目录）下与关键词匹配的
 * 已记录 .ps1 脚本。deps 注入 fs 能力以便测试：
 *   resolve(path, { cwd }) -> target
 *   listDir(target) -> [{ name, type, target }]
 *   readText(target) -> string
 * 返回 { count, matches }，matches 每项：
 *   { session, base, description, command }（command 截断到 200 字符）
 * count 为全部命中数，matches 最多 limit（默认 8）条，按 BM25 相关度降序。
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

  // 关键词分词为空（纯符号/单字符）→ 回退旧全量子串扫描，保持原行为
  if (tokenize(kw).length === 0) {
    return scanFallback({ listDir, readText, top, kw, limit })
  }

  let key
  try {
    key = JSON.stringify(scriptsDir)
  } catch {
    key = String(scriptsDir)
  }

  const sig = await treeSig(listDir, top)
  let entry = cache.get(key)
  if (!entry || entry.sig !== sig) {
    entry = { sig, index: await buildTree({ listDir, readText }, top) }
    cache.set(key, entry)
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  }

  const scored = querySearchIndex(entry.index, kw)
  const docs = entry.index.docs
  const matches = scored.map(({ docIdx }) => {
    const d = docs[docIdx]
    return { session: d.session, base: d.base, description: d.description, command: d.command.slice(0, 200) }
  })
  return { count: scored.length, matches: matches.slice(0, limit) }
}
