/**
 * test/s30-deliverable.mjs —— v0.14 交付物后端回归（只索引不搬运 + B1 相对路径 + C1 现场校验）。
 *
 * 覆盖：
 *   - 登记交付物（workspace 相对路径 + 自动算 base_snapshot 绝对路径快照）
 *   - C1 现场校验三态：文件在→ok、删掉→missing
 *   - 校验不写盘（check 是派生视图，记录本身 state 不变）
 *   - 解除索引软标记（unlinked）、重开不降级、405/415
 *
 * 用法：node test\s30-deliverable.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, READ_PATHS, DELIVERABLE_PATH, UNLINK_DELIVERABLE_PATH } from '../index.js'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
const WS_DIR = join(BASE, 'ws')
await mkdir(ROOT, { recursive: true })
await mkdir(join(WS_DIR, '报告'), { recursive: true })
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const REL = '报告/交付.md'
const absFile = join(WS_DIR, '报告', '交付.md')
await writeFile(absFile, 'hello deliverable', 'utf8')

function workspaceDoc() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: WS_A, workspaceIds: [WS_A], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [WS_A]: { path: WS_DIR, title: '夹具工作区', sessionIds: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' } } },
  }
}
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify(workspaceDoc()), 'utf8')

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
  const raw = json === undefined ? undefined : JSON.stringify(json)
  const fullUrl = 'http://127.0.0.1' + path + (query ? '?' + query : '')
  if (typeof def.handler === 'function') {
    const headers = raw === undefined ? {} : { 'content-type': contentType }
    const res = makeRes()
    await def.handler(makeReq({ method, url: fullUrl, headers, body: raw }), res)
    let b = null; try { b = res.out.body ? JSON.parse(res.out.body) : null } catch {}
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request(fullUrl, { method }))
  const t2 = await res.text(); let b = null; try { b = t2 ? JSON.parse(t2) : null } catch {}
  return { status: res.status, body: b }
}

const pack = makeCtx()
apply(pack.ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
const R = pack.routes

let r = await call(R, CREATE_PATH, { method: 'POST', json: { name: '交付物测试', objective: 'o', next_action: '验证交付物' } })
const pid = r.body.project?.id
push('G1', r.status === 200 && !!pid, '建项目 ' + pid)

r = await call(R, DELIVERABLE_PATH, { method: 'POST', json: {
  project_id: pid, title: '交付文档', kind: 'doc',
  locator: { type: 'workspace', workspace_id: WS_A, rel: REL }, is_final: true,
} })
const did = r.body.deliverable?.id
push('D1', r.status === 200 && !!did && !!r.body.deliverable.locator.base_snapshot,
  '登记成功，自动算 base_snapshot 快照')

let det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('D2', det.body.deliverables.length === 1 && det.body.deliverables[0].check.state === 'ok' && det.body.deliverables[0].check.size === 17,
  '文件在 → check.state=ok，size 来自 stat')

const baseSnap = r.body.deliverable.locator.base_snapshot
push('D3', baseSnap && baseSnap.endsWith('报告/交付.md'.replace('/', '\\')) , 'B1：base_snapshot 是工作区根+相对路径拼出的绝对路径快照')

await unlink(absFile)
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('D4', det.body.deliverables[0].check.state === 'missing', '文件删除后 → check.state=missing（现场校验即时）')

const recRaw = JSON.parse(await readFile(join(ROOT, 'project', 'deliverable', did + '.json'), 'utf8'))
push('D5', (recRaw.record || recRaw).state === 'ok', 'C1 只读校验不改记录：落盘 state 仍是 ok')

r = await call(R, UNLINK_DELIVERABLE_PATH, { method: 'POST', json: { id: did, expected_rev: 1 } })
push('D6', r.status === 200 && r.body.changed === true, '解除索引成功 changed=true')
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('D7', det.body.deliverables.length === 0, '解除后详情第4区不可见（read 过滤 unlinked）')

const pack2 = makeCtx()
apply(pack2.ctx, { root: ROOT, evidencePath: join(BASE, 'ev2.jsonl') })
const ovReopen = await call(pack2.routes, READ_PATHS.overview)
push('D8', ovReopen.body.degraded === false && ovReopen.body.writable === true, '关掉重开不降级、可写')

r = await call(R, DELIVERABLE_PATH, { method: 'GET' })
push('S1', r.status === 405, 'deliverable 非 POST → 405')
r = await call(R, UNLINK_DELIVERABLE_PATH, { method: 'POST', contentType: 'text/plain', json: {} })
push('S2', r.status === 415, 'unlink-deliverable 非 JSON → 415')

// ---- 静态断言：0.14 交付物 UI（client 源码级）----
const clientSrc = await readFile(new URL('../client.js', import.meta.url), 'utf8')
push('X1', clientSrc.includes("target: kind") && clientSrc.includes("for (const kind of ['file', 'directory'])") && clientSrc.includes("data-dl-form-overlay': '1'"),
  'A1：文件/文件夹右键「加入交付物」+ 手填浮层存在（探测不通自动回退手填）')
push('X2', clientSrc.includes("'✅ 存在'") && clientSrc.includes("'❌ 失效'") && clientSrc.includes("'⚠ 不可达'") && clientSrc.includes("data-dead-deliverables': '1'"),
  'D1/C1：三态文字+色、失效单独块、点开目录')

const pass = steps.filter(s => s.ok).length
await writeFile(OUT, JSON.stringify({ pass, total: steps.length, steps }, null, 2))
console.log('RESULT ' + pass + '/' + steps.length)
if (pass !== steps.length) process.exitCode = 1
