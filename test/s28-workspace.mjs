/**
 * test/s28-workspace.mjs —— v0.13 工作区功能的 Node 层回归。
 *
 * 覆盖：
 *   - 列工作区（GET /api/project/workspaces）：来自 workspace.json，带 title/path/session_count
 *   - 关联工作区（软标记）：rev+1、changelog link、详情第3区可见、重复关联零副作用
 *   - 解除关联（unlinked）：详情不可见、记录仍在；重新关联复活
 *   - 建项目带 workspace_id：自动关联工作区
 *   - 关掉重开不降级（E-10 硬约束）；405/415
 *
 * 用法：node test\s28-workspace.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, READ_PATHS, WORKSPACES_PATH, LINK_WORKSPACE_PATH, UNLINK_WORKSPACE_PATH } from '../index.js'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')   // storages 根：workspace.json + project/
await mkdir(ROOT, { recursive: true })
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002'

function workspaceDoc() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: WS_A, workspaceIds: [WS_A, WS_B], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [WS_A]: { path: 'D:\\夹具\\工作区甲', title: '夹具工作区甲', sessionIds: ['session-11111111-1111-1111-1111-111111111111'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' },
        [WS_B]: { path: 'D:\\夹具\\工作区乙', title: '夹具工作区乙', sessionIds: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' },
      },
    },
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
async function readLogs() {
  const dir = join(ROOT, 'project', 'changelog')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const texts = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8')))
  return texts.map(x => { try { const j = JSON.parse(String(x)); return j.record || j } catch { return null } }).filter(Boolean)
}

const pack = makeCtx()
apply(pack.ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
const R = pack.routes

// ---- W1 列工作区 ----
let r = await call(R, WORKSPACES_PATH, { query: 'q=' + encodeURIComponent('甲') })
push('W1', r.status === 200 && r.body.ok && r.body.matched === 1 && r.body.workspaces[0].workspace_id === WS_A && r.body.workspaces[0].title === '夹具工作区甲',
  '列工作区返回夹具甲，带 title/path/session_count')

// ---- 建项目 ----
r = await call(R, CREATE_PATH, { method: 'POST', json: { name: '工作区测试', objective: 'o', next_action: '验证工作区关联' } })
push('G1', r.status === 200 && !!r.body.project?.id, '建项目 ' + r.body.project?.id)
const pid = r.body.project.id

// ---- W2 关联工作区 ----
r = await call(R, LINK_WORKSPACE_PATH, { method: 'POST', json: { project_id: pid, workspace_id: WS_A, workspace_title: '夹具工作区甲', workspace_path: 'D:\\夹具\\工作区甲', basis: '夹具关联' } })
push('W2', r.status === 200 && r.body.ok && r.body.changed === true, '关联工作区成功 changed=true')

let det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('W3', det.body.workspaces.length === 1 && det.body.workspaces[0].workspace_id === WS_A && det.body.workspaces[0].workspace_path === 'D:\\夹具\\工作区甲',
  '详情第3区可见该工作区（含 path 供点开）')
const revW = det.body.workspaces[0].rev

// 重复关联幂等
r = await call(R, LINK_WORKSPACE_PATH, { method: 'POST', json: { project_id: pid, workspace_id: WS_A, workspace_title: '夹具工作区甲', workspace_path: 'D:\\夹具\\工作区甲', basis: '夹具关联' } })
push('W4', r.status === 200 && r.body.changed === false, '重复关联零副作用（changed=false）')

// ---- W5 解绑软标记 ----
r = await call(R, UNLINK_WORKSPACE_PATH, { method: 'POST', json: { project_id: pid, workspace_id: WS_A, expected_rev: revW } })
push('W5', r.status === 200 && r.body.ok && r.body.changed === true, '解除关联成功')
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('W6', det.body.workspaces.length === 0, '解除后详情第3区不可见（read 过滤 unlinked）')
const linkFile = (await readdir(join(ROOT, 'project', 'project_workspace'))).find(f => f.includes(WS_A))
let softMarked = false
if (linkFile) {
  const j = JSON.parse(String(await readFile(join(ROOT, 'project', 'project_workspace', linkFile), 'utf8')))
  const rec = j.record || j
  softMarked = rec.unlinked === true && !!rec.unlinked_at
}
push('W7', !!linkFile && softMarked, '关联记录物理仍在、带 unlinked 软标记')

// ---- W8 重新关联复活 ----
r = await call(R, LINK_WORKSPACE_PATH, { method: 'POST', json: { project_id: pid, workspace_id: WS_A, workspace_title: '夹具工作区甲', workspace_path: 'D:\\夹具\\工作区甲', basis: '夹具关联', expected_rev: revW + 1 } })
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid) })
push('W8', r.status === 200 && det.body.workspaces.length === 1, '重新关联后工作区复活')

const logs = await readLogs()
push('W9', logs.some(l => l.op === 'link' && l.target_table === 'project_workspace') && logs.some(l => l.op === 'unlink' && l.target_table === 'project_workspace'),
  'changelog 含 project_workspace 的 link + unlink 审计')

// ---- W10 建项目带工作区自动关联 ----
r = await call(R, CREATE_PATH, { method: 'POST', json: { name: '带工作区建项目', objective: 'o', next_action: '验证建时自动带出', workspace_id: WS_B, workspace_title: '夹具工作区乙', workspace_path: 'D:\\夹具\\工作区乙' } })
const pid2 = r.body.project?.id
det = await call(R, READ_PATHS.get, { query: 'id=' + encodeURIComponent(pid2) })
push('W10', r.status === 200 && !!r.body.workspaceLink && det.body.workspaces.length === 1 && det.body.workspaces[0].workspace_id === WS_B,
  '建项目带 workspace_id 自动关联（会话右键预选的落点）')

// ---- W11 关掉重开不降级 ----
const pack2 = makeCtx()
apply(pack2.ctx, { root: ROOT, evidencePath: join(BASE, 'ev2.jsonl') })
const ovReopen = await call(pack2.routes, READ_PATHS.overview)
push('W11', ovReopen.body.degraded === false && ovReopen.body.writable === true, '关掉重开不降级、可写')

// ---- 形状 ----
r = await call(R, LINK_WORKSPACE_PATH, { method: 'GET' })
push('S1', r.status === 405, 'link-workspace 非 POST → 405')
r = await call(R, UNLINK_WORKSPACE_PATH, { method: 'POST', contentType: 'text/plain', json: {} })
push('S2', r.status === 415, 'unlink-workspace 非 JSON → 415')
r = await call(R, WORKSPACES_PATH, { method: 'POST' })
push('S3', r.status === 405, 'workspaces 非 GET → 405')

const pass = steps.filter(s => s.ok).length
await writeFile(OUT, JSON.stringify({ pass, total: steps.length, steps }, null, 2))
console.log('RESULT ' + pass + '/' + steps.length)
if (pass !== steps.length) process.exitCode = 1
