/**
 * test/s25-restore.mjs —— 恢复路由（POST /api/project/restore）。
 *
 * 覆盖：归档→恢复闭环、rev 递增、列表回 active、重复恢复拒绝、非归档拒绝、expected_rev 冲突、
 * 不存在 404、降级 409 零落盘、405/415、恢复后可再归档（往返）。
 *
 * 用法：node test\s25-restore.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, ARCHIVE_PATH, RESTORE_PATH, READ_PATHS } from '../index.js'
import { snapshotTree, diffSnapshot } from './_lib.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const GOOD = join(BASE, 'good')
const BAD = join(BASE, 'bad')
await mkdir(GOOD, { recursive: true })

function makeCtx() {
  const routes = new Map()
  return { routes, ctx: { webServer: { register(d) { routes.set(d.path, d); return () => routes.delete(d.path) } }, effect() {}, storageDomain: undefined } }
}
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
function makeRes() {
  const out = { statusCode: 200, body: '' }
  return { out, get statusCode() { return out.statusCode }, set statusCode(v) { out.statusCode = v }, setHeader() {}, end(c) { if (c != null) out.body += String(c) } }
}
async function call(routes, path, { method = 'GET', json, contentType = 'application/json' } = {}) {
  const def = routes.get(path)
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const headers = raw === undefined ? {} : { 'content-type': contentType }
    const res = makeRes()
    await def.handler(makeReq({ method, url: 'http://127.0.0.1' + path, headers, body: raw }), res)
    let b = null
    try { b = res.out.body ? JSON.parse(res.out.body) : null } catch { b = null }
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request('http://127.0.0.1' + path, { method }))
  const t2 = await res.text()
  let b = null
  try { b = t2 ? JSON.parse(t2) : null } catch { b = null }
  return { status: res.status, body: b }
}

const { ctx, routes } = makeCtx()
apply(ctx, { root: GOOD, evidencePath: join(BASE, 'ev.jsonl') })

let r = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '恢复测试', objective: 'o', next_action: '验证归档恢复往返' } })
const pid = r.body.project.id
const rev0 = r.body.project.rev

// 归档 → 恢复闭环
await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid, expected_rev: rev0, requestId: 'rs_arch_1' } })
r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: pid, expected_rev: rev0 + 1, requestId: 'rs_restore_1' } })
push('R1', r.status === 200 && r.body.project.status === 'active' && r.body.project.rev === rev0 + 2,
  '恢复成功：status=active rev=' + (r.body.project && r.body.project.rev))
const ov = await call(routes, READ_PATHS.overview)
const active = ov.body.groups.find(g => g.key === 'active').items
const archived = ov.body.groups.find(g => g.key === 'archived').items
push('R2', active.some(p => p.id === pid) && !archived.some(p => p.id === pid), '列表从 archived 回到 active')

const logsDir = join(GOOD, 'project', 'changelog')
const logs = (await readdir(logsDir)).filter(f => f.endsWith('.json'))
const logTexts = await Promise.all(logs.map(f => readFile(join(logsDir, f), 'utf8')))
// 再读一次原文（上面的 Promise.all 有些运行时返回 Buffer，这里统一转字符串）
const logStrs = logTexts.map(x => typeof x === 'string' ? x : String(x))
push('R3', logStrs.some(t => t.includes('"op":"restore"') || t.includes('"op": "restore"')), 'changelog 记了 op=restore')

// 非归档项目不能恢复
r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: pid, requestId: 'rs_restore_2' } })
push('R4', r.status === 409 && r.body.error.code === 'NOT_ARCHIVED', 'active 项目恢复 → 409 NOT_ARCHIVED')

// 另建一条归档，测冲突与往返
const r2 = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '往返测试', objective: 'o', next_action: '验证多次往返 rev 正确' } })
const pid2 = r2.body.project.id
await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid2, expected_rev: 1, requestId: 'rs_arch_2' } })
const snapBefore = await snapshotTree(join(GOOD, 'project'))
r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: pid2, expected_rev: 99, requestId: 'rs_restore_3' } })
push('R5', r.status === 409 && r.body.error.code === 'REV_CONFLICT', '错 expected_rev → 409 REV_CONFLICT')
push('R6', diffSnapshot(snapBefore, await snapshotTree(join(GOOD, 'project'))).length === 0, '冲突被拒后零落盘')
r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: pid2, expected_rev: 2, requestId: 'rs_restore_4' } })
push('R7', r.status === 200 && r.body.project.status === 'active', '正确 rev 恢复成功')
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid2, expected_rev: 3, requestId: 'rs_arch_3' } })
push('R8', r.status === 200 && r.body.project.status === 'archived', '恢复后可再归档（往返闭环）')

r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: 'prj_01M7GT9SB8PTSQMDBH6SHDNR0A', requestId: 'rs_restore_5' } })
push('R9', r.status === 404 && r.body.error.code === 'PROJECT_NOT_FOUND', '不存在 → 404')
r = await call(routes, RESTORE_PATH, { method: 'GET' })
push('R10', r.status === 405, 'GET → 405')
r = await call(routes, RESTORE_PATH, { method: 'POST', json: { id: pid }, contentType: 'text/plain' })
push('R11', r.status === 415 && r.body.error.code === 'JSON_REQUIRED', '非 JSON → 415')

// 降级库
const { ctx: ctx2, routes: routes2 } = makeCtx()
apply(ctx2, { root: BAD, evidencePath: join(BASE, 'ev2.jsonl') })
await cp(GOOD, BAD, { recursive: true })
await (await import('node:fs/promises')).rm(join(BAD, 'project', 'global.json'), { force: true })
const snapB = await snapshotTree(join(BAD, 'project'))
r = await call(routes2, RESTORE_PATH, { method: 'POST', json: { id: pid, requestId: 'rs_restore_bad' } })
push('R12', r.status === 409 && r.body.error.code === 'READONLY_DEGRADED', '降级库恢复 → 409 READONLY_DEGRADED')
push('R13', diffSnapshot(snapB, await snapshotTree(join(BAD, 'project'))).length === 0, '降级被拒后零落盘')

const pass = steps.filter(s => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's25-restore', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await (await import('node:fs/promises')).writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
