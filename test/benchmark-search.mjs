// test/benchmark-search.mjs — 真实 scripts/ 库上的检索引擎基准。
// 用法：node test/benchmark-search.mjs <工作区根目录>（默认 D:\agent-env\qtz）
// 只读：不修改任何文件。输出建索引耗时、缓存查询耗时与命中数。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { searchScripts } from '../lib/search.js'

const cwd = process.argv[2] || 'D:\\agent-env\\qtz'
const resolve = async (p, o) => path.resolve((o && o.cwd) || '.', p)
const listDir = async (t) => (await fs.readdir(t, { withFileTypes: true }))
  .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: path.join(t, e.name) }))
const readText = async (t) => fs.readFile(t, 'utf8')

const bench = async (keyword, limit) => {
  const t0 = performance.now()
  const r = await searchScripts({ resolve, listDir, readText, cwd, keyword, limit })
  return { ms: performance.now() - t0, count: r.count, top: r.matches.map((m) => m.description) }
}

const first = await bench('build', 8)
console.log(`build 建索引+首查: ${first.ms.toFixed(0)} ms, 命中 ${first.count}`)
for (const [kw, limit] of [['发布', 8], ['git', 5], ['commit', 5]]) {
  const r = await bench(kw, limit)
  console.log(`${kw} 缓存查询: ${r.ms.toFixed(0)} ms, 命中 ${r.count}`)
}
console.log('发布 前3条描述:', (await bench('发布', 3)).top.join(' | '))
