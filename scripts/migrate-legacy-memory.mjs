// scripts/migrate-legacy-memory.mjs — 一次性迁移（v0.6 → v0.7）：
// 把旧 memory/*.md 中「## 记忆条目」节的条目行并入 memory/CLAUDE.md 的
// 「## 记忆条目」节（保留来源审计行原样）；原文件不修改（保留历史摘要）。
// 用法：node scripts/migrate-legacy-memory.mjs <项目根目录>
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { splitFile, appendMemoryEntry } from '../lib/memfile.js'

const root = process.argv[2] ? String(process.argv[2]) : '.'
const memDir = join(root, 'memory')
const target = join(memDir, 'CLAUDE.md')

let targetText = ''
try { targetText = await readFile(target, 'utf8') } catch (e) { /* 目标不存在则新建 */ }

let entries = []
try { entries = await readdir(memDir) } catch (e) {
  console.error('无法读取 ' + memDir + '：' + String(e && e.message || e))
  process.exit(1)
}

let merged = 0
const movedFrom = []
for (const name of entries) {
  if (name === 'CLAUDE.md' || extname(name).toLowerCase() !== '.md') continue
  const p = join(memDir, name)
  let st
  try { st = await stat(p) } catch (e) { continue }
  if (!st.isFile()) continue
  const text = await readFile(p, 'utf8')
  const s = splitFile(text)
  if (s.entries.length === 0) continue
  for (const line of s.entries) {
    targetText = appendMemoryEntry(targetText, line)
    merged++
  }
  movedFrom.push(name + '（' + s.entries.length + ' 条）')
}

if (merged === 0) {
  console.log('未发现需要迁移的「记忆条目」（旧 memory/*.md 中无条目，或已迁移）')
  process.exit(0)
}

// 去尾随空行（只保留一个结尾换行）。编码安全：全程 node fs 以 UTF-8 读写；
// 切勿用 Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 处理本文件（会写坏中文）。
targetText = targetText.replace(/\n+$/, '\n')

await writeFile(target, targetText, 'utf8')
console.log('已迁移 ' + merged + ' 条 → memory/CLAUDE.md')
console.log('来源：' + movedFrom.join('、'))
console.log('原文件未修改（保留历史摘要；旧摘要不再参与自动注入，仅存归档）')
