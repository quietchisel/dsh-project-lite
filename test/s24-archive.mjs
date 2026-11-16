/**
 * test/s24-archive.mjs —— 归档路由（POST /api/project/archive）。
 *
 * 覆盖：
 *   - 正常归档：status→archived、rev+1、changelog 记一条、列表从 active 移到 archived
 *   - 重复归档：零副作用（already_archived=true，不写第二条 changelog）
 *   - requestId 幂等：同 id 同参数回上次结果
 *   - expected_rev 冲突 → 409 REV_CONFLICT，零落盘
 *   - 项目不存在 → 404；降级库 → 409 READONLY_DEGRADED 且零落盘
 *   - 非 POST → 405；非 JSON → 415
 *
 * 用法：node test\s24-archive.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, ARCHIVE_PATH, READ_PATHS } from '../index.js'
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
async function call(routes, path, { method = 'GET', query = '', json, contentType = 'application/json' } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const url = 'http://127.0.0.1' + path + (query ? '?' + query : '')
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const headers = raw === undefined ? {} : { 'content-type': contentType }
    const res = makeRes()
    await def.handler(makeReq({ method, url, headers, body: raw }), res)
    let b = null
    try { b = res.out.body ? JSON.parse(res.out.body) : null } catch { b = null }
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request(url, { method }))
  const t2 = await res.text()
  let b = null
  try { b = t2 ? JSON.parse(t2) : null } catch { b = null }
  return { status: res.status, body: b }
}

const { ctx, routes } = makeCtx()
apply(ctx, { root: GOOD, evidencePath: join(BASE, 'ev.jsonl') })

let r = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '归档测试', objective: 'o', next_action: '验证归档路由' } })
const pid = r.body.project.id
const rev0 = r.body.project.rev
push('G1', r.status === 200 && !!pid, '先建项目 ' + pid)

const snapA = await snapshotTree(join(GOOD, 'project'))
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid, expected_rev: rev0, requestId: 'req_arch_1' } })
push('G2', r.status === 200 && r.body.ok && r.body.project.status === 'archived' && r.body.project.rev === rev0 + 1,
  '归档成功：status=archived rev=' + (r.body.project && r.body.project.rev))
push('G3', r.body.replayed === false && r.body.already_archived === false, '首次归档 replayed=false already_archived=false')

const ov = await call(routes, READ_PATHS.overview)
const active = ov.body.groups.find(g => g.key === 'active').items
const archived = ov.body.groups.find(g => g.key === 'archived').items
push('G4', !active.some(p => p.id === pid) && archived.some(p => p.id === pid), '列表从 active 移到 archived')

const logsDir = join(GOOD, 'project', 'changelog')
const logs1 = (await readdir(logsDir)).filter(f => f.endsWith('.json')).length
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid, expected_rev: rev0 + 1, requestId: 'req_arch_2' } })
push('G5', r.status === 200 && r.body.already_archived === true, '重复归档 → already_archived=true（不报错）')
const logs2 = (await readdir(logsDir)).filter(f => f.endsWith('.json')).length
push('G6', logs1 === logs2, '重复归档不再写 changelog（' + logs1 + ' → ' + logs2 + '）')

// requestId 幂等：同一个 id 重放（这次目标已是 archived，但请求本身也应记成回放）
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid, expected_rev: rev0, requestId: 'req_arch_1' } })
push('G7', r.status === 200 && (r.body.replayed === true || r.body.already_archived === true), '同 requestId 重放 → replayed/already_archived')

// 冲突与不存在
// 另建一条未归档项目，用错的 expected_rev 验真冲突（上面那条已归档，走不到冲突判定）
const r2 = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '冲突测试', objective: 'o', next_action: '验证并发覆盖防护' } })
const pid2 = r2.body.project.id
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid2, expected_rev: rev0 + 99, requestId: 'req_arch_3' } })
push('G8', r.status === 409 && r.body.error.code === 'REV_CONFLICT', '错的 expected_rev → 409 REV_CONFLICT（防并发覆盖）')
const p2 = JSON.parse(await readFile(join(GOOD, 'project', 'project', pid2 + '.json'), 'utf8'))
push('G8b', p2.record.status === 'active' && p2.record.rev === 1, '冲突被拒后目标仍是 active / rev 1（零副作用）')
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: 'prj_01M7GT9SB8PTSQMDBH6SHDNR0A', requestId: 'req_arch_4' } })
push('G9', r.status === 404 && r.body.error.code === 'PROJECT_NOT_FOUND', '不存在的项目 → 404')
r = await call(routes, ARCHIVE_PATH, { method: 'GET' })
push('G10', r.status === 405, 'GET → 405')
r = await call(routes, ARCHIVE_PATH, { method: 'POST', json: { id: pid }, contentType: 'text/plain' })
push('G11', r.status === 415 && r.body.error.code === 'JSON_REQUIRED', '非 JSON → 415')

// 降级库
const { ctx: ctx2, routes: routes2 } = makeCtx()
apply(ctx2, { root: BAD, evidencePath: join(BASE, 'ev2.jsonl') })
// 先建再破坏：用 GOOD 拷贝（含数据）后删 global.json
const { cp } = await import('node:fs/promises')
await cp(GOOD, BAD, { recursive: true })
await (await import('node:fs/promises')).rm(join(BAD, 'project', 'global.json'), { force: true })
const snapB = await snapshotTree(join(BAD, 'project'))
r = await call(routes2, ARCHIVE_PATH, { method: 'POST', json: { id: pid, requestId: 'req_arch_bad' } })
push('G12', r.status === 409 && r.body.error.code === 'READONLY_DEGRADED', '降级库归档 → 409 READONLY_DEGRADED')
const snapB2 = await snapshotTree(join(BAD, 'project'))
push('G13', diffSnapshot(snapB, snapB2).length === 0, '降级被拒后零落盘')

const pass = steps.filter(s => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's24-archive', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
