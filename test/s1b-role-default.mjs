/**
 * test/s1b-role-default.mjs —— UI 默认角色策略（S1-B）
 *
 * 三部分：
 *   A. 从 client.js **原样提取**纯函数并执行（不是抄一份来测）。
 *   B. 源码断言：UI 提交时显式带 role、选择器与提示存在。
 *   C. 走真实路由的端到端：默认 primary / 默认 supporting / 明确选 primary 被拒 / 历史双主。
 */
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, CREATE_PATH, LINK_PATH } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.argv[2] || '.tmp/base-s1b-role'
const OUT = process.argv[3] || '.tmp/s1b-role.json'
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

// ---------- A. 提取 client.js 里的纯函数 ----------
const clientSrc = await readFile(join(HERE, '..', 'client.js'), 'utf8')
const start = clientSrc.indexOf('function activeLinksOf')
const end = clientSrc.indexOf("const API_STATE = 'api/project/state'")
if (start < 0 || end < 0) throw new Error('client.js 里找不到角色推断函数')
const fnSrc = clientSrc.slice(start, end)
const mod = new Function(fnSrc + '; return { activeLinksOf, activePrimariesOf, defaultLinkRole, linkRoleHint }')()
const { defaultLinkRole, linkRoleHint, activePrimariesOf } = mod

const A = (sid, role, extra) => Object.assign({ id: 'x__' + sid, session_id: sid, role }, extra || {})
const P1 = 'session-11111111-1111-1111-1111-111111111111'
const P2 = 'session-22222222-2222-2222-2222-222222222222'

push('A1', defaultLinkRole([]) === 'primary' && linkRoleHint([]).kind === 'none',
  '空项目：默认 primary，提示 kind=none（' + defaultLinkRole([]) + '）')
push('A2', defaultLinkRole([A(P1, 'primary')]) === 'supporting' && linkRoleHint([A(P1, 'primary')]).kind === 'one',
  '已有 1 个 primary：默认 supporting，提示 kind=one')
push('A3', defaultLinkRole([A(P1, 'primary', { unlinked: true })]) === 'primary',
  'unlinked 的历史 primary 不算（默认仍是 primary，与后端同口径）')
push('A4', defaultLinkRole([A(P1, 'primary'), A(P2, 'primary')]) === 'supporting' && linkRoleHint([A(P1, 'primary'), A(P2, 'primary')]).kind === 'conflict',
  '历史双主：默认 supporting，提示 kind=conflict（与“只有一个 primary”区分开）')
push('A5', linkRoleHint([A(P1, 'primary'), A(P2, 'primary')]).text.includes('2 个历史主会话'),
  '双主提示里写明数量（' + linkRoleHint([A(P1, 'primary'), A(P2, 'primary')]).text.slice(0, 24) + '…）')

// ---------- B. 源码断言：提交必须显式带 role ----------
const sendIdx = clientSrc.indexOf('const roleToSend = linkRole');
const bodyIdx = clientSrc.indexOf('role: roleToSend');
push('B1', sendIdx > 0 && bodyIdx > sendIdx, '提交体里显式带 role: roleToSend（不依赖后端默认）')
push('B2', clientSrc.includes("'data-field': 'link-role'") && clientSrc.includes("'data-link-role-hint'"),
  '表单有角色选择器与提示元素')
push('B3', clientSrc.includes('setLinkRole(defaultLinkRole(links))'), '打开表单时按现有会话计算默认角色')
push('B4', clientSrc.includes('JSON.stringify({ requestId: newRequestId(), project_id: linkFor.id, session_id: sessionId, role: roleToSend'),
  '关联请求体包含 project_id / session_id / role 三要素')

// ---------- C. 真实路由端到端 ----------
await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
await mkdir(ROOT, { recursive: true })
const WS = 'ws-role-0000-0000-0000-000000000001'
const GOOD = join(BASE, 'realdir')
await mkdir(GOOD, { recursive: true })
const SIDS = [
  'session-33333333-3333-3333-3333-333333333333',
  'session-44444444-4444-4444-4444-444444444444',
  'session-55555555-5555-5555-5555-555555555555',
]
const wsDoc = {
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS, workspaceIds: [WS], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [WS]: { path: GOOD, title: '角色测试工作区', sessionIds: SIDS, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } } },
}
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify(wsDoc), 'utf8')

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
  // 路由表按“无查询串的路径”注册；查询串只进 req.url
  const def = routes.get(path.split('?')[0])
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const res = makeRes()
    await def.handler(makeReq({ method, url: 'http://127.0.0.1' + path, headers: raw === undefined ? {} : { 'content-type': 'application/json' }, body: raw }), res)
    let b = null; try { b = res.out.body ? JSON.parse(res.out.body) : null } catch { b = null }
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request('http://127.0.0.1' + path, { method }))
  const t2 = await res.text()
  let b = null; try { b = t2 ? JSON.parse(t2) : null } catch { b = null }
  return { status: res.status, body: b }
}

// 预置"历史双主"项目：必须在 apply() 之前用独立 Store 写完再关掉，
// 否则同一个 root 上同时存在两个 Store 实例 → 磁盘比内存多 → D1 假降级（s23 已记录这条约束）。
const { openStore } = await import('../core/store.mjs')
const seedStore = await openStore({ root: ROOT, actor: 'seed' })
const seeded = await seedStore.createProject({ name: '双主项目', objective: 'o', next_action: '验证历史双主', client_request_id: 'seed-p2' })
const pid2 = seeded.project.id
for (const [i, sid] of [SIDS[0], SIDS[1]].entries()) {
  const key = pid2 + '__' + sid
  await seedStore.importRecord({ table: 'project_session', key, record: { id: key, project_id: pid2, session_id: sid, role: 'primary', confidence: 'confirmed', basis: '历史导入', source: 'legacy', created_at: new Date().toISOString(), rev: 1 }, client_request_id: 'seed-dp-' + i })
}
await seedStore.close()

const { ctx, routes } = makeCtx()
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })

let r = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '角色项目', objective: 'o', next_action: '验证默认角色' } })
const pid = r.body.project.id
push('C0', r.status === 200 && !!pid, '建一个空项目（0 个 primary）')

// C1 空项目：默认 primary → 提交成功
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SIDS[0], role: 'primary', basis: 'C1' } })
push('C1', r.status === 200 && r.body.changed === true, '空项目默认 primary：提交成功（' + r.status + '）')

// C2 已有 1 个 primary：默认 supporting → 成功
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SIDS[1], role: 'supporting', basis: 'C2' } })
push('C2', r.status === 200 && r.body.changed === true, '已有 primary 时默认 supporting：提交成功（' + r.status + '）')

// C3 明确选 primary → 409 PROJECT_PRIMARY_CONFLICT
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SIDS[2], role: 'primary', basis: 'C3' } })
push('C3', r.status === 409 && r.body.error && r.body.error.code === 'PROJECT_PRIMARY_CONFLICT',
  '已有 primary 时明确选 primary：409 PROJECT_PRIMARY_CONFLICT（' + r.status + '/' + (r.body.error && r.body.error.code) + '）')

// C4 supporting 不改变原 primary
const det = await call(routes, '/api/project/get?id=' + encodeURIComponent(pid))
const sess = (det.body && det.body.sessions) || []
const prim = sess.filter((s) => s.role === 'primary' && !s.unlinked)
push('C4', prim.length === 1 && prim[0].session_id === SIDS[0], 'supporting 关联后仍只有 1 个 primary，且是第一个会话')

// C5 历史双主项目：默认 supporting 成功；再选 primary 被拒
// pid2 已在 apply() 之前预置
const det2 = await call(routes, '/api/project/get?id=' + encodeURIComponent(pid2))
const sess2 = (det2.body && det2.body.sessions) || []
push('C5', activePrimariesOf(sess2).length === 2 && defaultLinkRole(sess2) === 'supporting' && linkRoleHint(sess2).kind === 'conflict',
  '历史双主项目：检出 2 个 primary，默认 supporting，提示 kind=conflict')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid2, session_id: SIDS[2], role: 'supporting', basis: 'C5' } })
push('C6', r.status === 200 && r.body.changed === true, '历史双主项目上默认 supporting：成功（' + r.status + '）')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid2, session_id: SIDS[2], role: 'primary', basis: 'C6' } })
push('C7', r.status === 409 && r.body.error.code === 'PROJECT_PRIMARY_CONFLICT', '历史双主项目上再选 primary：拒绝（' + r.status + '）')
const det3 = await call(routes, '/api/project/get?id=' + encodeURIComponent(pid2))
push('C8', activePrimariesOf((det3.body && det3.body.sessions) || []).length === 2, '历史双主没有被自动改动（仍 2 个 primary）')

// C9 API 不传 role 时仍是 primary（既有契约不变）
const pid3 = (await call(routes, CREATE_PATH, { method: 'POST', json: { name: '契约项目', objective: 'o', next_action: '验证默认契约' } })).body.project.id
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid3, session_id: SIDS[0], basis: 'C9' } })
const det4 = await call(routes, '/api/project/get?id=' + encodeURIComponent(pid3))
const p4 = ((det4.body && det4.body.sessions) || []).filter((s) => s.session_id === SIDS[0] && s.role === 'primary')
push('C9', r.status === 200 && p4.length === 1, 'API 不传 role 仍按 primary 处理（后端默认契约未变）')

// C10 Agent Tools：行为未被意外改变（默认 primary；有 primary 时拒绝）
{
  const { registerAgentTools } = await import('../core/agent-tools.mjs')
  const { readService } = await import('../core/read.mjs')
  const { openStore } = await import('../core/store.mjs')
  const st = await openStore({ root: ROOT, actor: 'tools', enforceIdentity: true })
  const captured = []
  const tools = { register: (spec) => { captured.push(spec); return () => {} } }
  registerAgentTools({ tools }, { defineTool: (x) => x, getStore: async () => st, readService: (s, o) => readService(s, o), evidence: () => {}, tools })
  const link = captured.find((x) => x.name === 'project_link_session')
  const exec = { agent: { session: { id: SIDS[0] } } }
  const ok = await link.execute({ project_id: pid3, session_id: SIDS[2], role: 'supporting', basis: '工具挂辅助会话' }, exec)
  const bad = await link.execute({ project_id: pid3, session_id: SIDS[1], role: 'primary', basis: '工具抢主会话' }, exec)
  push('C10', ok.ok === true && bad.ok === false && bad.error === 'PROJECT_PRIMARY_CONFLICT',
    'Agent Tools：supporting 成功、primary 被拒（' + bad.error + '）')
  await st.close()
}

const pass = steps.filter((s) => s.ok).length
const result = { at: new Date().toISOString(), total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await mkdir(join(OUT, '..'), { recursive: true })
await writeFile(OUT, JSON.stringify(result, null, 1), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + result.verdict)
