/**
 * test/s29-session-title.mjs —— v0.13.2 会话标题读取回归（双文件名 + 随进度变化）。
 *
 * 覆盖：
 *   - projcache 混着裸 uuid 与 session- 前缀两种文件名，两种都读到标题
 *   - 标题随任务进度变化（projcache 被重写、mtime 变）→ 缓存失效、读到新标题
 *   - 文件不存在 / 无 title 字段 → null（不编造）
 *
 * 用法：node test\s29-session-title.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionRegistry, SESSION_PREFIX } from '../core/sessions.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const cacheDir = join(BASE, 'session_projcache', 'sessions')
await mkdir(cacheDir, { recursive: true })
const SID_BARE = 'session-11111111-1111-1111-1111-111111111111'
const SID_PREFIXED = 'session-22222222-2222-2222-2222-222222222222'
const SID_NONE = 'session-33333333-3333-3333-3333-333333333333'

function titleDoc(title) {
  return { version: 7, record: { rows: { title: { ver: 1, seq: 1, val: title } } } }
}
function fileFor(sid, withPrefix) {
  const uuid = sid.startsWith(SESSION_PREFIX) ? sid.slice(SESSION_PREFIX.length) : sid
  return join(cacheDir, (withPrefix ? SESSION_PREFIX : '') + uuid + '.json')
}
await writeFile(fileFor(SID_BARE, false), JSON.stringify(titleDoc('裸文件名会话标题')), 'utf8')
await writeFile(fileFor(SID_PREFIXED, true), JSON.stringify(titleDoc('带前缀会话标题')), 'utf8')
// SID_NONE 不写缓存

const reg = createSessionRegistry({ root: BASE })

// T1/T2：两种文件名都读到
push('T1', (await reg.titleOf(SID_BARE)) === '裸文件名会话标题', '裸 uuid 文件名读到标题')
push('T2', (await reg.titleOf(SID_PREFIXED)) === '带前缀会话标题', 'session- 前缀文件名读到标题（旧版读不到→显示id 的 bug）')

// T3：没文件 → null，不编造
push('T3', (await reg.titleOf(SID_NONE)) === null, '无缓存文件 → null（不编造标题）')

// T4：标题随进度变化——重写 projcache 并显式推后 mtime（避免同毫秒写盘漏判，错误账本硬规矩4）→ 缓存失效读到新标题
const fBare = fileFor(SID_BARE, false)
const m0 = (await stat(fBare)).mtimeMs
await writeFile(fBare, JSON.stringify(titleDoc('改过的新标题')), 'utf8')
await utimes(fBare, new Date(m0 + 2000), new Date(m0 + 2000))
push('T4', (await reg.titleOf(SID_BARE)) === '改过的新标题', '标题变化后 mtime 失效缓存、读到新标题（随任务进度变化）')

// T5：titlesOf 批量也走同一修复
const map = await reg.titlesOf([SID_BARE, SID_PREFIXED, SID_NONE])
push('T5', map.get(SID_BARE) === '改过的新标题' && map.get(SID_PREFIXED) === '带前缀会话标题' && map.get(SID_NONE) === null,
  'titlesOf 批量读取两种文件名 + null 都对')

const pass = steps.filter(s => s.ok).length
await writeFile(OUT, JSON.stringify({ pass, total: steps.length, steps }, null, 2))
console.log('RESULT ' + pass + '/' + steps.length)
if (pass !== steps.length) process.exitCode = 1
