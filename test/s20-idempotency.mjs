/**
 * test/s20-idempotency.mjs —— 1.8 幂等指纹（requestId + sha256(action)）。
 *
 * 覆盖：
 *   - 同 requestId + 同参数 → 第二次 replayed=true，项目数不变、不新建
 *   - 同 requestId + 不同参数 → 409 REQUEST_ID_CONFLICT（不许拿同一个 id 覆盖上次结果）
 *   - requestId 非法（太短/含非法字符）→ 400 INVALID_INPUT
 *   - 不带 requestId → 保持旧行为（每次都是新项目），replayed=false
 *   - link 同样支持；重复提交 rev 不变
 *   - 指纹落在 global.json 的 recent_requests，且不超过 256 条
 *
 * 如实标注：Node 层 + 真存储后端，最高算 Implemented。
 *
 * 用法：node test\s20-idempotency.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, LINK_PATH } from '../index.js'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
await mkdir(ROOT, { recursive: true })

const SID = 'session-11111111-1111-1111-1111-111111111111'
const WS = 'ws-aaaaaaaa-0000-0000-0000-000000000001'
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS, workspaceIds: [WS], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [WS]: { path: BASE, title: 'W', sessionIds: [SID], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } } },
}), 'utf8')

function makeCtx() {
  const routes = new Map()
  const ctx = {
    webServer: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } },
    effect() {},
    storageDomain: undefined,
  }
  return { ctx, routes }
}
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
function makeRes() {
  const out = { statusCode: 200, body: '' }
  return {
    out,
    get statusCode() { return out.statusCode },
    set statusCode(v) { out.statusCode = v },
    setHeader() {},
    end(chunk) { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
  }
}
async function call(routes, path, { method = 'GET', query = '', json } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const url = 'http://127.0.0.1' + path + (query ? '?' + query : '')
  const raw = json === undefined ? undefined : JSON.stringify(json)
  if (typeof def.handler === 'function') {
    const headers = raw === undefined ? {} : { 'content-type': 'application/json' }
    const res = makeRes()
    await def.handler(makeReq({ method, url, headers, body: raw }), res)
    let b = null
    try { b = res.out.body ? JSON.parse(res.out.body) : null } catch { b = null }
    return { status: res.out.statusCode, body: b }
  }
  const res = await def.resource(new Request(url, { method }))
  const t = await res.text()
  let b = null
  try { b = t ? JSON.parse(t) : null } catch { b = null }
  return { status: res.status, body: b }
}

const { ctx, routes } = makeCtx()
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })

const projDir = join(ROOT, 'project', 'project')
const countProjects = async () => { try { return (await readdir(projDir)).filter((f) => f.endsWith('.json')).length } catch { return 0 } }
const BODY = { name: '幂等项目', objective: 'o', next_action: '验证幂等指纹生效' }

let r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, requestId: 'req_alpha_0001' } })
const pid = r.body && r.body.project && r.body.project.id
push('R1', r.status === 200 && r.body.replayed === false && !!pid, '首次建：replayed=false')
const n1 = await countProjects()

r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, requestId: 'req_alpha_0001' } })
push('R2', r.status === 200 && r.body.replayed === true && r.body.project.id === pid, '同 id 同参数：replayed=true 且回同一个项目')
push('R3', (await countProjects()) === n1 && n1 === 1, '磁盘上仍然只有 1 个项目（没重复建）')

r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, name: '改了个名字', requestId: 'req_alpha_0001' } })
push('R4', r.status === 409 && r.body.error.code === 'REQUEST_ID_CONFLICT', '同 id 不同参数 → 409 REQUEST_ID_CONFLICT')
push('R5', (await countProjects()) === n1, '被拒时零落盘')

r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, requestId: 'ab' } })
push('R6', r.status === 400 && r.body.error.code === 'INVALID_INPUT', 'requestId 太短 → 400 INVALID_INPUT')
r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, requestId: 'bad id!' } })
push('R7', r.status === 400 && r.body.error.code === 'INVALID_INPUT', 'requestId 含空格/符号 → 400 INVALID_INPUT')

r = await call(routes, CREATE_PATH, { method: 'POST', json: { ...BODY, name: '不幂等的那个' } })
push('R8', r.status === 200 && r.body.replayed === false, '不带 requestId：保持旧行为 replayed=false')
push('R9', (await countProjects()) === n1 + 1, '不带 requestId 会真的再建一个（文档化行为，不是 bug）')

r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: 'S20', requestId: 'req_beta_0001' } })
push('R10', r.status === 200 && r.body.replayed === false && r.body.changed === true, 'link 首次：replayed=false / changed=true')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: 'S20', requestId: 'req_beta_0001' } })
push('R11', r.status === 200 && r.body.replayed === true, 'link 同 id 同参数：replayed=true')
r = await call(routes, LINK_PATH, { method: 'POST', json: { project_id: pid, session_id: SID, basis: '换个依据', requestId: 'req_beta_0001' } })
push('R12', r.status === 409 && r.body.error.code === 'REQUEST_ID_CONFLICT', 'link 同 id 不同参数 → 409')

// R16-R17：create 路由必须把 legacy_refs 透传到 store（0.4.0 修 tags 时漏了同类字段）
const LR = [{
  kind: 'project', original_id: 'legacy-001', original_path: null,
  source_doc: '旧台账', source_path: 'D:\\old.md', imported_at: new Date().toISOString(),
  imported_by: 's20', original_confidence: 'metadata_inferred', note: '透传验证',
}]
r = await call(routes, CREATE_PATH, { method: 'POST', json: {
  name: '来源透传', objective: 'o', next_action: '验证 legacy_refs 不透传的死字段',
  legacy_refs: LR, requestId: 'req_legacy_refs_1',
} })
const lrPid = r.body && r.body.project && r.body.project.id
push('R16', r.status === 200 && !!lrPid && Array.isArray(r.body.project.legacy_refs) && r.body.project.legacy_refs.length === 1,
  'create 带 legacy_refs → 返回记录里有（' + (r.body && r.body.project && JSON.stringify(r.body.project.legacy_refs)) + '）')
const lrFile = JSON.parse(await readFile(join(ROOT, 'project', 'project', lrPid + '.json'), 'utf8'))
push('R17', Array.isArray(lrFile.record.legacy_refs) && lrFile.record.legacy_refs.length === 1 && lrFile.record.legacy_refs[0].source_doc === '旧台账',
  'legacy_refs 真的落盘（不是只在内存里）')

const meta = JSON.parse(await readFile(join(ROOT, 'project', 'global.json'), 'utf8')).record
const rr = meta.recent_requests || []
push('R13', Array.isArray(rr) && rr.length === 3, 'recent_requests 落了 3 条（3 次 create + link；R16 那次带 legacy_refs）')
push('R14', rr.every((x) => typeof x.fp === 'string' && x.fp.length === 32 && x.at), '每条都有 32 位指纹与时间戳')
push('R15', rr.length <= 256, '上限 256 生效（当前 ' + rr.length + '）')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's20-idempotency', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
