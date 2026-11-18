/**
 * test/s17-link-session.mjs —— 1.4 关联会话（Node 层机检）。
 *
 * 覆盖：
 *   - 会话候选：读 workspace.json 定归属 + 读会话缓存补标题；q 过滤；上限封顶
 *   - 关联成功：project_session 落盘，rev=1，changelog 记一条
 *   - **真幂等**：同一条重复点 3 次 → changed=false，rev 仍 1，changelog 不增，基线不动，零写盘
 *   - 负例：会话不在注册表 → 400 SESSION_NOT_FOUND，且一个字节都不写
 *   - 负例：缺 project_id / session_id → 400；role 非法 → 400；GET → 405；非 JSON → 415
 *   - 对账第 3 条：会话都在 → pass（10/0/0；第 10 条是 S1-B 新增的 PROJECT_PRIMARY_CONFLICT）；会话被删 → fail 但**不降级**；注册表读不到 → skipped（不报 pass）
 *
 * 如实标注：Node 层跑假 webServer + 真存储后端 + 真注册表读取，没有真实 Host / Desktop，
 * 按状态矩阵 v2 规则 1/3，成果最高算 Implemented。
 *
 * 用法：node test\s17-link-session.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, SESSIONS_PATH, LINK_PATH, STATE_PATH, CREATE_PATH } from '../index.js'
import { snapshotTree, diffSnapshot } from './_lib.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')       // = storages 根：既放 workspace.json 也放 project/
const EVIDENCE = join(BASE, 'evidence.jsonl')
await mkdir(ROOT, { recursive: true })

const SID_A = 'session-11111111-1111-1111-1111-111111111111'
const SID_B = 'session-22222222-2222-2222-2222-222222222222'
const WS_ID = 'ws-aaaaaaaa-0000-0000-0000-000000000001'

function workspaceDoc(sessionIds) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: WS_ID, workspaceIds: [WS_ID], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [WS_ID]: {
          path: BASE,
          title: '夹具工作区甲',
          sessionIds,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
      },
    },
  }
}

async function writeCache(sessionId, title) {
  const uuid = sessionId.replace(/^session-/, '')
  const dir = join(ROOT, 'session_projcache', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, uuid + '.json'), JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 4, createdAt: 1, cwd: 'D:\\夹具工作区', isSeeded: false, inheritedEventCount: 0 }, rows: { title: { ver: 1, seq: 1, val: title } } },
  }), 'utf8')
}

await writeFile(join(ROOT, 'workspace.json'), JSON.stringify(workspaceDoc([SID_A, SID_B])), 'utf8')
await writeCache(SID_A, '夹具会话甲的标题')
// SID_B 故意不写缓存：验证"没有标题就回落，不编造"

// ---- 假 ctx / req / res（照抄宿主真实形状） ----
function makeCtx() {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } },
    effect(fn) { effects.push(fn()) },
    storageDomain: undefined,
  }
  return { ctx, routes }
}
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
function makeRes() {
  const out = { statusCode: 200, headers: {}, body: '' }
  return {
    out,
    get statusCode() { return out.statusCode },
    set statusCode(v) { out.statusCode = v },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v },
    end(chunk) { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
  }
}
async function call(routes, path, { method = 'GET', query = '', json, contentType = 'application/json' } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const url = 'http://127.0.0.1' + path + (query ? '?' + query : '')
  const rawBody = json === undefined ? undefined : (typeof json === 'string' ? json : JSON.stringify(json))
  if (typeof def.handler === 'function') {
    const headers = {}
    if (rawBody !== undefined && contentType) headers['content-type'] = contentType
    const res = makeRes()
    await def.handler(makeReq({ method, url, headers, body: rawBody }), res)
    let parsed = null
    try { parsed = res.out.body ? JSON.parse(res.out.body) : null } catch { parsed = null }
    return { status: res.out.statusCode, body: parsed, raw: res.out.body }
  }
  const res = await def.resource(new Request(url, { method, headers: rawBody === undefined ? {} : { 'content-type': contentType }, body: rawBody }))
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: res.status, body: parsed, raw: text }
}

const { ctx, routes } = makeCtx()
apply(ctx, { root: ROOT, evidencePath: EVIDENCE })

// ---- S1 会话候选 ----
let r = await call(routes, SESSIONS_PATH)
push('S1', r.status === 200 && r.body && r.body.ok === true, 'GET sessions → 200 ok')
push('S2', r.body && r.body.sessions && r.body.sessions.length === 2 && r.body.total === 2, '返回 2 条候选（total=' + (r.body && r.body.total) + '）')
const a = r.body.sessions.find((s) => s.session_id === SID_A)
push('S3', a && a.title === '夹具会话甲的标题' && a.workspace_title === '夹具工作区甲', '缓存里有标题就带出来（' + (a && a.title) + '）')
const b = r.body.sessions.find((s) => s.session_id === SID_B)
push('S4', b && b.title === null, '缓存里没有标题 → null（不编造）')
r = await call(routes, SESSIONS_PATH, { query: 'q=11111111' })
push('S5', r.body && r.body.matched === 1 && r.body.sessions[0].session_id === SID_A, 'q 过滤生效（matched=' + (r.body && r.body.matched) + '）')
r = await call(routes, SESSIONS_PATH, { query: 'q=' + encodeURIComponent('夹具工作区甲') })
push('S5b', r.body && r.body.matched === 2, 'q 也能匹配工作区标题（matched=' + (r.body && r.body.matched) + '）')
r = await call(routes, SESSIONS_PATH, { method: 'POST' })
push('S6', r.status === 405, 'POST sessions → 405')

// ---- 建一个项目 ----
r = await call(routes, CREATE_PATH, { method: 'POST', json: { name: '关联测试项目', objective: 'o', next_action: '把夹具会话挂上来' } })
const pid = r.body && r.body.project && r.body.project.id
push('S7', r.status === 200 && !!pid, '先建一个项目（' + pid + '）')

// ---- S2 关联 ----
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: 'S17 夹具' } })
push('S8', r.status === 200 && r.body.ok === true && r.body.changed === true, '首次关联 → changed=true')
const linkDir = join(ROOT, 'project', 'project_session')
let linkFiles = await readdir(linkDir)
push('S9', linkFiles.length === 1, 'project_session 落盘 1 条（' + linkFiles.length + '）')
let linkRec = JSON.parse(await readFile(join(linkDir, linkFiles[0]), 'utf8')).record
push('S10', linkRec.session_id === SID_A && linkRec.rev === 1 && linkRec.role === 'primary', '记录内容正确（role=primary rev=1）')

const logDir = join(ROOT, 'project', 'changelog')
const logsBefore = (await readdir(logDir)).length
const metaBefore = JSON.parse(await readFile(join(ROOT, 'project', 'global.json'), 'utf8')).record.expected_counts
const snapBefore = await snapshotTree(join(ROOT, 'project'))

// ---- S3 真幂等：再点 2 次 ----
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: 'S17 夹具' } })
const second = r.body
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: 'S17 夹具' } })
const third = r.body
push('S11', second.changed === false && third.changed === false, '重复两次都 changed=false')
linkFiles = await readdir(linkDir)
linkRec = JSON.parse(await readFile(join(linkDir, linkFiles[0]), 'utf8')).record
push('S12', linkFiles.length === 1 && linkRec.rev === 1, '仍然只有 1 条且 rev 仍 1')
const logsAfter = (await readdir(logDir)).length
push('S13', logsAfter === logsBefore, 'changelog 不增（' + logsBefore + ' → ' + logsAfter + '）')
const metaAfter = JSON.parse(await readFile(join(ROOT, 'project', 'global.json'), 'utf8')).record.expected_counts
push('S14', JSON.stringify(metaAfter) === JSON.stringify(metaBefore), '基线 expected_counts 不动')
const snapAfter = await snapshotTree(join(ROOT, 'project'))
push('S15', diffSnapshot(snapBefore, snapAfter).length === 0, '重复点两次零写盘（快照逐文件一致）')

// ---- S4 负例 ----
const snapNeg = await snapshotTree(join(ROOT, 'project'))
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: 'session-99999999-9999-9999-9999-999999999999' } })
push('S16', r.status === 400 && r.body.error.code === 'SESSION_NOT_FOUND', '会话不在注册表 → 400 SESSION_NOT_FOUND')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid } })
push('S17', r.status === 400 && r.body.error.code === 'MISSING_PARAM', '缺 session_id → 400 MISSING_PARAM')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_B } })
push('S17b', r.status === 400 && r.body.error.code === 'BASIS_REQUIRED', '缺 basis → 400 BASIS_REQUIRED（依据必填，不许无凭据关联）')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_B, role: 'boss', basis: 'S17' } })
push('S18', r.status === 400 && r.body.error.code === 'INVALID_INPUT', 'role 非法 → 400 INVALID_INPUT')
r = await call(routes, LINK_PATH, { method: 'GET' })
push('S19', r.status === 405, 'GET link → 405')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID_A, basis: 'S17' }, contentType: 'text/plain' })
push('S20', r.status === 415 && r.body.error.code === 'JSON_REQUIRED', '非 JSON content-type → 415')
const snapNegAfter = await snapshotTree(join(ROOT, 'project'))
push('S21', diffSnapshot(snapNeg, snapNegAfter).length === 0, '四个负例之后零写盘')

// ---- S5 对账第 3 条 ----
r = await call(routes, STATE_PATH, { query: 'reconcile=1' })
const c3 = (r.body.reconcile.checks || []).find((c) => c.id === 3)
push('S22', c3 && c3.status === 'pass', '会话都在 → 第 3 条 pass（' + (c3 && c3.detail) + '）')
// S1-B：对账新增第 10 条（PROJECT_PRIMARY_CONFLICT），通过数由 9 变 10
// S1-C：对账新增第 11 条（task.project_id 有效），通过数再由 10 变 11
push('S23', r.body.reconcile.pass === 11 && r.body.reconcile.fail === 0 && r.body.reconcile.skipped === 0, '11/0/0（pass=' + r.body.reconcile.pass + ' fail=' + r.body.reconcile.fail + ' skipped=' + r.body.reconcile.skipped + '）')

// ---- S6 会话被删：第 3 条 fail，但不降级 ----
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify(workspaceDoc([SID_B])), 'utf8')
r = await call(routes, STATE_PATH, { query: 'reconcile=1' })
const c3b = (r.body.reconcile.checks || []).find((c) => c.id === 3)
push('S24', c3b && c3b.status === 'fail' && c3b.scope === 'external', '会话被删 → 第 3 条 fail（scope=external）')
push('S25', r.body.writable === true && r.body.degradation && r.body.degradation.degraded !== true, '但仍然可写、未降级（删会话是正常操作）')

// ---- S7 注册表读不到：第 3 条 skipped，不报 pass ----
await rename(join(ROOT, 'workspace.json'), join(ROOT, 'workspace.json.moved'))
r = await call(routes, STATE_PATH, { query: 'reconcile=1' })
const c3c = (r.body.reconcile.checks || []).find((c) => c.id === 3)
push('S26', c3c && c3c.status === 'skipped' && c3c.severity === 'unverified', '注册表缺失 → 第 3 条 skipped（不是 pass）')
r = await call(routes, SESSIONS_PATH)
push('S27', r.status === 200 && r.body.ok === false && r.body.error.code === 'REGISTRY_UNAVAILABLE', '候选列表返回 REGISTRY_UNAVAILABLE（不假装空列表）')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's17-link-session', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
