/**
 * test/s21-link-admission.mjs —— 1.10 关联前的 fail-closed 三校验。
 *
 * 为什么要有：会话还在、但它所在的工作区文件夹被删了，关联进来就是一条"指向空气"的引用——
 * 详情里只显示一个路径，点过去什么都没有。宁可现在拒，也不要留假引用。
 *
 * 覆盖：
 *   1. 会话在注册表里 + 工作区在列表里 + 目录存在 → 200
 *   2. 会话不在注册表 → 400 SESSION_NOT_FOUND
 *   3. 工作区被移出 global.workspaceIds → 400 WORKSPACE_GONE
 *   4. 工作区目录不存在 → 400 WORKSPACE_PATH_MISSING
 *   5. 注册表本身读不到 → 放行但 registryChecked=false（不假装校验过）
 *   6. 四个拒绝场景全部零落盘
 *
 * 用法：node test\s21-link-admission.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, LINK_PATH } from '../index.js'
import { snapshotTree, diffSnapshot } from './_lib.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
await mkdir(ROOT, { recursive: true })

const SID = 'session-33333333-3333-3333-3333-333333333333'
const WS = 'ws-cccccccc-0000-0000-0000-000000000003'
const GOOD_DIR = join(BASE, 'real-workspace')
await mkdir(GOOD_DIR, { recursive: true })

const doc = (opts = {}) => ({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS, workspaceIds: opts.dropWs ? [] : [WS], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [WS]: { path: opts.path ?? GOOD_DIR, title: '真工作区', sessionIds: [SID], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } } },
})
const writeWs = (opts) => writeFile(join(ROOT, 'workspace.json'), JSON.stringify(doc(opts)), 'utf8')

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
async function call(routes, path, { method = 'GET', json } = {}) {
  const def = routes.get(path)
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const res = makeRes()
    await def.handler(makeReq({ method, url: 'http://127.0.0.1' + path, headers: raw === undefined ? {} : { 'content-type': 'application/json' }, body: raw }), res)
    let b = null
    try { b = res.out.body ? JSON.parse(res.out.body) : null } catch { b = null }
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request('http://127.0.0.1' + path, { method }))
  const t = await res.text()
  let b = null
  try { b = t ? JSON.parse(t) : null } catch { b = null }
  return { status: res.status, body: b }
}

await writeWs({})
const { ctx, routes } = makeCtx()
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })

let r = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '准入项目', objective: 'o', next_action: '验证三校验生效' } })
const pid = r.body.project.id
push('A0', r.status === 200 && !!pid, '先建一个项目')

// 1 正常
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: 'S21' } })
push('A1', r.status === 200 && r.body.changed === true && r.body.registryChecked === true, '三校验全过 → 200 且 registryChecked=true')

// 2 会话不存在
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: 'session-99999999-9999-9999-9999-999999999999', basis: 'S21' } })
push('A2', r.status === 400 && r.body.error.code === 'SESSION_NOT_FOUND', '会话不在注册表 → SESSION_NOT_FOUND')

// 3 工作区被移出列表
await writeWs({ dropWs: true })
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: 'S21' } })
push('A3', r.status === 400 && r.body.error.code === 'WORKSPACE_GONE', '工作区被移出列表 → WORKSPACE_GONE（' + (r.body.error && r.body.error.message) + '）')

// 4 工作区目录不存在（A4 修缓存：verify() 必须 snapshot({force:true})，
//    否则 mtime 同毫秒连续改 workspace.json 会读到旧路径，本条偶发失败）
await writeWs({ path: join(BASE, 'this-dir-does-not-exist') })
const snapBefore = await snapshotTree(join(ROOT, 'project'))
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: 'S21' } })
push('A4', r.status === 400 && r.body.error.code === 'WORKSPACE_PATH_MISSING', '工作区目录不存在 → WORKSPACE_PATH_MISSING')
const snapAfter = await snapshotTree(join(ROOT, 'project'))
push('A5', diffSnapshot(snapBefore, snapAfter).length === 0, '两个拒绝场景之后零落盘')

// 5 注册表读不到 → 放行但标 registryChecked=false
await rename(join(ROOT, 'workspace.json'), join(ROOT, 'workspace.json.moved'))
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: 'session-88888888-8888-8888-8888-888888888888', basis: 'S21' } })
push('A6', r.status === 200 && r.body.registryChecked === false, '注册表读不到 → 放行但 registryChecked=false（不假装校验过）')

const links = await readdir(join(ROOT, 'project', 'project_session'))
push('A7', links.length === 2, '最终落盘 2 条 link（正常那条 + 放行那条）')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's21-link-admission', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
