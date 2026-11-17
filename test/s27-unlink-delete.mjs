/**
 * test/s27-unlink-delete.mjs —— v0.12 解除关联 + 软删除回收站（Node 层回归）。
 *
 * 覆盖：
 *   - unlink：rev+1、changelog op=unlink、详情/links-of-session 不再返回该会话、记录仍在（软标记）
 *   - 重复 unlink 幂等（零副作用）；重新 link 复活（unlinked 清除）
 *   - delete：status→deleted、changelog op=delete、overview 进 deleted 组、计数不变（基线不破）
 *   - 重复 delete 幂等；restore 把 deleted→active
 *   - 关掉重开（新 apply 指向同一根）：不降级、数据还在（E-10 教训的必验项）
 *   - 405 / 415 形状
 *
 * 用法：node test\s27-unlink-delete.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, LINK_PATH, UNLINK_PATH, DELETE_PATH, ARCHIVE_PATH, RESTORE_PATH, READ_PATHS, SESSIONS_PATH } from '../index.js'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'root')
await mkdir(ROOT, { recursive: true })
const SID_A = 'session-aabbccdd-1234-5678-abcd-0123456789ab'
const SID_B = 'session-11223344-5566-7788-99aa-bbccddeeff00'

function makeCtx() {
  const routes = new Map()
  return { routes, ctx: { webServer: { register(d) { routes.set(d.path, d); return () => routes.delete(d.path) } }, effect() {}, storageDomain: undefined }, effects: [] }
}
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
function makeRes() {
  const out = { statusCode: 200, body: '' }
  return { out, get statusCode() { return out.statusCode }, set statusCode(v) { out.statusCode = v }, setHeader() {}, end(c) { if (c != null) out.body += String(c) } }
}
async function call(routes, path, { method = 'GET', query = '', json, contentType = 'application/json' } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const headers = raw === undefined ? {} : { 'content-type': contentType }
    const res = makeRes()
    await def.handler(makeReq({ method, url: 'http://127.0.0.1' + path + (query ? '?' + query : ''), headers, body: raw }), res)
    let b = null; try { b = res.out.body ? JSON.parse(res.out.body) : null } catch {}
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request('http://127.0.0.1' + path + (query ? '?' + query : ''), { method }))
  const t2 = await res.text(); let b = null; try { b = t2 ? JSON.parse(t2) : null } catch {}
  return { status: res.status, body: b }
}
async function readLogs() {
  const dir = join(ROOT, 'project', 'changelog')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const texts = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8')))
  return texts.map(x => { try { const j = JSON.parse(String(x)); return j.record || j } catch { return null } }).filter(Boolean)
}

const ctxPack = makeCtx()
apply(ctxPack.ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
const R = ctxPack.routes

// ---- 建项目 + 挂两条会话 ----
let r = await call(R, CREATE_PATH, { method: 'POST', json: { name: '解绑删除测试', objective: 'o', next_action: '验证解绑与软删除' } })
push('G1', r.status === 200 && !!r.body.project?.id, '建项目 ' + r.body.project?.id)
const pid = r.body.project.id
r = await call(R, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: '夹具A' } })
push('G2', r.status === 200 && r.body.ok, '挂会话A')
r = await call(R, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_B, basis: '夹具B' } })
push('G3', r.status === 200 && r.body.ok, '挂会话B')

// 会话A关联记录的 rev（从详情拿）
let det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
const linkA = det.body.sessions.find(s => s.session_id === SID_A)
push('L0', !!linkA, '详情可见会话A rev=' + (linkA && linkA.rev))
const revA = linkA.rev

// ---- unlink 会话A ----
r = await call(R, UNLINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, expected_rev: revA, requestId: 'req_unlink_a' } })
push('L1', r.status === 200 && r.body.ok && r.body.changed === true, '解除关联成功 changed=true')

det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('L2', !det.body.sessions.some(s => s.session_id === SID_A) && det.body.sessions.some(s => s.session_id === SID_B),
  '详情不再显示会话A，会话B仍在（read 层过滤 unlinked）')

let bySess = await call(R, READ_PATHS.linksOfSession, { query: 'session_id=' + encodeURIComponent(SID_A) })
push('L3', bySess.body.total === 0, 'links-of-session 不再返回会话A（徽标会消失）')

// 记录仍在（软标记）
const linkFile = (await readdir(join(ROOT, 'project', 'project_session'))).find(f => f.includes('session-aabbccdd'))
let softMarked = false
if (linkFile) {
  const j = JSON.parse(String(await readFile(join(ROOT, 'project', 'project_session', linkFile), 'utf8')))
  const rec = j.record || j
  softMarked = rec.unlinked === true && !!rec.unlinked_at && rec.rev === revA + 1
}
push('L4', !!linkFile && softMarked, '关联记录物理仍在，带 unlinked=true 软标记（不删记录、不碰基线）')

// 重复 unlink 幂等
r = await call(R, UNLINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, requestId: 'req_unlink_a2' } })
push('L5', r.status === 200 && r.body.changed === false, '重复解除零副作用（changed=false，记录 rev 不涨）')

// 重新 link 复活
r = await call(R, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: '夹具A', expected_rev: revA + 1 } })
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('L6', r.status === 200 && det.body.sessions.some(s => s.session_id === SID_A), '重新关联后会话A复活')

// ---- 软删除项目 ----
const revBeforeDelete = det.body.project.rev
const ovBefore = await call(R, READ_PATHS.overview)
const totalBefore = ovBefore.body.total
r = await call(R, DELETE_PATH, { method: 'POST', json: { id: pid, expected_rev: revBeforeDelete, requestId: 'req_del_1' } })
push('D1', r.status === 200 && r.body.ok && r.body.project.status === 'deleted' && r.body.project.rev === revBeforeDelete + 1,
  '软删除成功 status=deleted rev=' + (r.body.project && r.body.project.rev))

det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('D2', det.body.found === true && det.body.project.status === 'deleted', '删后详情仍可读（软删除，记录没丢）')

const ovAfter = await call(R, READ_PATHS.overview)
const delGroup = ovAfter.body.groups.find(g => g.key === 'deleted')
push('D3', !!delGroup && delGroup.items.some(p => p.id === pid) && ovAfter.body.total === totalBefore,
  'deleted 组含该项目，且总数不变（计数不变→基线不破）')

const logs = await readLogs()
push('D4', logs.some(l => l.op === 'unlink') && logs.some(l => l.op === 'delete'),
  'changelog 含 unlink + delete 两条审计')

// 重复 delete 幂等
r = await call(R, DELETE_PATH, { method: 'POST', json: { id: pid, requestId: 'req_del_2' } })
push('D5', r.status === 200 && r.body.already_deleted === true && r.body.replayed === true, '重复删除零副作用')

// ---- restore 从回收站恢复 ----
r = await call(R, RESTORE_PATH, { method: 'POST', json: { id: pid, expected_rev: revBeforeDelete + 1, requestId: 'req_rs_1' } })
push('D6', r.status === 200 && r.body.project.status === 'active', '从回收站恢复 status=active')

// ---- 关掉重开：同一根重新 apply，不降级、数据还在（E-10 必验）----
const ctxPack2 = makeCtx()
apply(ctxPack2.ctx, { root: ROOT, evidencePath: join(BASE, 'ev2.jsonl') })
const R2 = ctxPack2.routes
const ovReopen = await call(R2, READ_PATHS.overview)
push('D7', ovReopen.body.degraded === false && ovReopen.body.writable === true && ovReopen.body.total === totalBefore,
  '关掉重开不降级、可写、数据完整（E-10：物理删记录才会踩，软标记不踩）')

// ---- 形状：405 / 415 ----
r = await call(R, UNLINK_PATH, { method: 'GET' })
push('S1', r.status === 405, 'unlink 非 POST → 405')
r = await call(R, DELETE_PATH, { method: 'POST', contentType: 'text/plain', json: {} })
push('S2', r.status === 415, 'delete 非 JSON → 415')

const pass = steps.filter(s => s.ok).length
await import('node:fs/promises').then(m => m.writeFile(OUT, JSON.stringify({ pass, total: steps.length, steps }, null, 2)))
console.log('RESULT ' + pass + '/' + steps.length)
if (pass !== steps.length) process.exitCode = 1
