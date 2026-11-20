/**
 * test/s41-receipt-state-machine.mjs —— 0.19 任务状态机（外审 §7）。
 * todo → assigned → submitted → accepted/rejected；rejected 退回 todo 可重做。
 * 验证：回执≠完成、裁定前不 accepted、裁定后才 closed/accepted、重新分配旧会话失效。
 * 用法：node test/s41-receipt-state-machine.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2], OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok: !!ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + d) }
const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { openStore } = await import(pathToFileURL(INST + '/core/store.mjs').href)
const { runAsCaller } = await import(pathToFileURL(INST + '/core/identity.mjs').href)
const P = 'session-10000000-0000-4000-8000-000000000001'
const S1 = 'session-20000000-0000-4000-8000-000000000002'
const S2 = 'session-30000000-0000-4000-8000-000000000003'
await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store'); await mkdir(ROOT, { recursive: true })
const s = await openStore({ root: ROOT, actor: 's41' })
const as = (sid, fn) => runAsCaller({ sessionId: sid, source: 's41' }, fn)
const p = (await as(P, () => s.createProject({ name: 'P', objective: 'o', next_action: '验证状态机', session_id: P }))).project
await as(P, () => s.linkSession({ project_id: p.id, session_id: S1, role: 'supporting', basis: 'b1' }))
await as(P, () => s.linkSession({ project_id: p.id, session_id: S2, role: 'supporting', basis: 'b2' }))

// S1 todo：建任务不派单
const t = (await as(P, () => s.createTask({ project_id: p.id, title: '音频', objective: '配音' }))).task
let cur = await s.task(t.id)
push('S1', cur.assigned_session_id === null && cur.acceptance === 'pending' && cur.lifecycle === 'active', 'todo：未派单、pending、active')
// S2 assigned
await as(P, () => s.assignTask({ task_id: t.id, assigned_session_id: S1 }))
cur = await s.task(t.id)
push('S2', cur.assigned_session_id === S1 && cur.acceptance === 'pending', 'assigned：派给 S1、仍 pending')
// S3 submitted：回执后 implemented_unverified ≠ accepted
const sub = await as(S1, () => s.submitTaskReceipt({ project_id: p.id, task_id: t.id, source_session_id: S1, source_session_role: 'supporting', summary: '配音完成', result: 'completed' }))
cur = await s.task(t.id)
push('S3', sub.receipt.status === 'submitted' && cur.acceptance === 'implemented_unverified' && cur.lifecycle === 'active', 'submitted：任务仅 implemented_unverified，非 accepted')
// S4 rejected：裁定拒绝退回 todo（pending + 撤销派单）
await as(P, () => s.decideTaskReceipt({ id: sub.receipt.id, decision: 'rejected', note: '音质不合格' }))
cur = await s.task(t.id)
const rec1 = await s.receipt(sub.receipt.id)
push('S4', rec1.status === 'rejected' && cur.acceptance === 'pending' && cur.lifecycle === 'active' && cur.assigned_session_id === null, 'rejected：退回 todo，可重新派单')
// S5 重新分配给 S2 + 旧会话 S1 回执失效
await as(P, () => s.assignTask({ task_id: t.id, assigned_session_id: S2 }))
let r
try { await as(S1, () => s.submitTaskReceipt({ project_id: p.id, task_id: t.id, source_session_id: S1, summary: '旧会话再交', result: 'completed' })); r = 'ALLOWED' } catch (e) { r = e.code }
push('S5', r === 'NOT_ASSIGNED', '重新分配后旧会话 S1 回执 → ' + r)
// S6 新会话 S2 提交 + accepted
const sub2 = await as(S2, () => s.submitTaskReceipt({ project_id: p.id, task_id: t.id, source_session_id: S2, summary: '重做完成', result: 'completed' }))
await as(P, () => s.decideTaskReceipt({ id: sub2.receipt.id, decision: 'accepted' }))
cur = await s.task(t.id)
push('S6', cur.lifecycle === 'closed' && cur.acceptance === 'accepted', 'accepted：任务 closed/accepted')
// S7 blocked 结果标记（另一个任务）
const t2 = (await as(P, () => s.createTask({ project_id: p.id, title: '图片', objective: '配图' }))).task
await as(P, () => s.assignTask({ task_id: t2.id, assigned_session_id: S1 }))
const bl = await as(S1, () => s.submitTaskReceipt({ project_id: p.id, task_id: t2.id, source_session_id: S1, summary: '缺素材受阻', result: 'blocked' }))
push('S7', bl.receipt.result === 'blocked' && bl.receipt.status === 'submitted', 'blocked：结果建议保留，仍待裁定不自动生效')
// S8 cancelled 任务不可派单/回执
const t3 = (await as(P, () => s.createTask({ project_id: p.id, title: '取消', objective: 'x' }))).task
await as(P, () => s.assignTask({ task_id: t3.id, assigned_session_id: S1 }))
try { await as(P, () => s.assignTask({ task_id: t3.id, assigned_session_id: null })); } catch {}
// 用 decide rejected 使任务回 pending 再模拟取消：直接改 acceptance 需正规路径，这里验证 accepted 后不可再派
try { await as(P, () => s.assignTask({ task_id: t.id, assigned_session_id: S1 })); r = 'ALLOWED' } catch (e) { r = e.code }
push('S8', r === 'TASK_NOT_ASSIGNABLE', '已 accepted 任务不可再派单 → ' + r)

await s.close()
const pass = steps.filter(x => x.ok).length
const sum = { at: new Date().toISOString(), suite: 's41-state-machine', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(sum, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + sum.verdict)
process.exit(pass === steps.length ? 0 : 1)
