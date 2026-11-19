/**
 * test/s32-concurrent-idempotency.mjs —— 审计 A：requestId 并发幂等回归。
 *
 * s20 只测顺序请求；并发同 requestId 曾实测创建 10 个项目（claimRequest 查在锁外）。
 * 本套用合成数据 + 真 apply() 路由，覆盖：
 *   C1 同 id 同参数 10 并发 → 只建 1 个项目、1 条 changelog、9 个 replayed
 *   C2 同 id 同参数 2 并发 → 只建 1 个
 *   C3 同 id 不同参数并发 → 一个成功、其余 REQUEST_ID_CONFLICT
 *   C4 不同 id 并发 → 各自建（互不干扰）
 *   C5 recent_requests 不丢更新（10 并发后账本仍有该 id 且结果一致）
 *
 * 如实标注：Node 层 + 进程内并发（Promise.all），真存储后端，最高 Implemented。
 * 跨物理进程场景见 04-风险与未完成事项.md。
 *
 * 用法：node test/s32-concurrent-idempotency.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH } from '../index.js'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
await mkdir(ROOT, { recursive: true })
const SID = 'session-33333333-3333-3333-3333-333333333333'
const WS = 'ws-cccccccc-0000-0000-0000-000000000003'
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS, workspaceIds: [WS], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [WS]: { path: BASE, title: 'W', sessionIds: [SID], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } } },
}), 'utf8')

const routes = new Map()
const ctx = { webServer: { register(d) { routes.set(d.path, d); return () => routes.delete(d.path) } }, effect() {}, storageDomain: undefined }
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
const def = routes.get(CREATE_PATH)

function mkReq(body) {
  const raw = JSON.stringify(body)
  return { method: 'POST', url: 'http://x' + CREATE_PATH, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8') } }
}
function mkRes() {
  const out = { statusCode: 200, body: '' }
  return { out, get statusCode() { return out.statusCode }, set statusCode(v) { out.statusCode = v }, setHeader() {}, end(c) { if (c != null) out.body += String(c) } }
}
async function call(body) {
  const res = mkRes()
  await def.handler(mkReq(body), res)
  let b = null
  try { b = res.out.body ? JSON.parse(res.out.body) : null } catch {}
  return { status: res.out.statusCode, body: b }
}
const projDir = join(ROOT, 'project', 'project')
const countProjects = async () => { try { return (await readdir(projDir)).filter((f) => f.endsWith('.json')).length } catch { return 0 } }
const countChangelog = async () => { try { return (await readdir(join(ROOT, 'project', 'changelog'))).filter((f) => f.endsWith('.json')).length } catch { return 0 } }

// C1：同 id 同参数 10 并发
const B1 = { name: '并发幂等C1', objective: 'o', next_action: '验证并发重复提交只建一次', requestId: 'req_s32_c1_0001' }
const r1 = await Promise.all(Array.from({ length: 10 }, () => call(B1)))
const id1 = r1.find((x) => x.body && x.body.project)?.body.project.id
const replay1 = r1.filter((x) => x.body && x.body.replayed === true).length
push('C1a', r1.every((x) => x.status === 200) && (await countProjects()) === 1, '同 id 10 并发 → 只建 1 个项目')
push('C1b', replay1 === 9 && !!id1 && r1.every((x) => !x.body?.project || x.body.project.id === id1), '10 并发中 9 个 replayed，返回的 id 全部一致')
push('C1c', (await countChangelog()) === 1, '同 id 10 并发 → 只写 1 条 changelog（正常重复不产生额外变更）')

// C2：同 id 同参数 2 并发（另一个 id）
const B2 = { ...B1, name: '并发幂等C2', requestId: 'req_s32_c2_0002' }
const r2 = await Promise.all([call(B2), call(B2)])
push('C2', (await countProjects()) === 2 && r2.filter((x) => x.body?.replayed === true).length === 1, '同 id 2 并发 → 只增 1 个项目、1 个 replayed')

// C3：同 id 不同参数并发 → 冲突拒绝
const B3a = { name: '并发幂等C3a', objective: 'o', next_action: '验证不同参数冲突', requestId: 'req_s32_c3_0003' }
const B3b = { ...B3a, name: '并发幂等C3b', objective: '改了目标' }
const r3 = await Promise.all([call(B3a), call(B3b)])
const conflicts = r3.filter((x) => x.status === 409 && x.body && x.body.error && x.body.error.code === 'REQUEST_ID_CONFLICT').length
push('C3', conflicts >= 1 && (await countProjects()) === 3, '同 id 不同参数并发 → 至少 1 个 REQUEST_ID_CONFLICT，只增 1 个项目')

// C4：不同 id 并发 → 各自建
const B4a = { name: '并发幂等C4a', objective: 'o', next_action: '不同 id 并发甲', requestId: 'req_s32_c4a_004' }
const B4b = { name: '并发幂等C4b', objective: 'o', next_action: '不同 id 并发乙', requestId: 'req_s32_c4b_005' }
const r4 = await Promise.all([call(B4a), call(B4b)])
push('C4', r4.every((x) => x.status === 200 && x.body?.replayed === false) && (await countProjects()) === 5, '不同 id 并发 → 各自建项目，互不干扰')

// C5：账本不丢更新
const globalPath = join(ROOT, 'project', 'global.json')
let recent = []
try { const gj = JSON.parse(await readFile(globalPath, 'utf8')); recent = gj.record?.recent_requests || gj.recent_requests || [] } catch {}
const hasC1 = recent.some((x) => x && x.id === 'req_s32_c1_0001')
push('C5', hasC1, '10 并发后 recent_requests 仍保留该 id（无丢失更新）')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's32-concurrent-idempotency', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
