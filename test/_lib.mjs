/**
 * test/_lib.mjs —— 测试公用小工具（从本项目的旧测试目录搬进仓库，供 CI 直接跑）。
 * 核心用途只有一个：整棵目录快照 + 逐项比对，用来证明"真的没写盘"。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

/** 整棵目录 → { 相对路径: {size, mtimeMs, sha256} }。mtime 用精确值，任何一次写盘都会变。 */
export async function snapshotTree(root) {
  const out = {}
  async function walk(dir) {
    let ents
    try { ents = await readdir(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else {
        const [buf, st] = await Promise.all([readFile(p), stat(p)])
        out[relative(root, p)] = { size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(buf).digest('hex') }
      }
    }
  }
  await walk(root)
  return out
}

/** 两份快照逐项比对，返回差异数组（空 = 完全一致）。 */
export function diffSnapshot(a, b) {
  const diffs = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[k]) { diffs.push({ file: k, kind: 'added' }); continue }
    if (!b[k]) { diffs.push({ file: k, kind: 'removed' }); continue }
    if (a[k].sha256 !== b[k].sha256) diffs.push({ file: k, kind: 'content', before: a[k].sha256.slice(0, 12), after: b[k].sha256.slice(0, 12) })
    else if (a[k].mtimeMs !== b[k].mtimeMs) diffs.push({ file: k, kind: 'mtime', before: a[k].mtimeMs, after: b[k].mtimeMs })
  }
  return diffs
}

export function makePush(steps) {
  return (id, name, ok, detail) => {
    steps.push({ id, name, ok, detail })
    console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + ' :: ' + detail)
  }
}

export const SID = (n) => 'session-' + String(n).repeat(8) + '-0000-0000-0000-000000000000'
