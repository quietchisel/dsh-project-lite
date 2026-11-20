/**
 * test/s40-receipt-permissions.mjs —— 0.19 任务回执权限反例（外审 §6.1 12 条中权限相关）。
 * 验证：authorizeTaskReceipt 独立授权，supporting 只能提交派给自己的回执；authorizeWrite 未被放宽。
 * 用法：node test/s40-receipt-permissions.mjs <BASE> <OUT.json>
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
const OUTSIDER = 'session-40000000-0000-4000-8000-000000000004'
await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store'); await mkdir(ROOT, { recursive: true })
const s = await openStore({ root: ROOT, actor: 's40' })
const as = (sid, fn) => runAsCaller({ sessionId: sid, source: 's40' }, fn)
const p = (await as(P, () => s.createProject({ name: 'P', objective: 'o', next_action: '验证回执权限', session_id: P }))).project
await as(P, () => s.linkSession({ project_id: p.id, session_id: S1, role: 'supporting', basis: '分支1' }))
await as(P, () => s.linkSession({ project_id: p.id, session_id: S2, role: 'supporting', basis: '分支2' }))
const p2 = (await as(P, () => s.createProject({ name: 'P2', objective: 'o', next_action: '验证跨项目', session_id: P }))).project
const t1 = (await as(P, () => s.createTask({ project_id: p.id, title: 'T1', objective: '任务1' }))).task
const t2 = (await as(P, () => s.createTask({ project_id: p.id, title: 'T2', objective: '任务2' }))).task
const t3 = (await as(P, () => s.createTask({ project_id: p.id, title: 'T3取消', objective: '任务3' }))).task
const tP2 = (await as(P, () => s.createTask({ project_id: p2.id, title: '跨项目任务', objective: 'x' }))).task
await as(P, () => s.assignTask({ task_id: t1.id, assigned_session_id: S1 }))
await as(P, () => s.assignTask({ task_id: t2.id, assigned_session_id: S2 }))
await as(P, () => s.assignTask({ task_id: t3.id, assigned_session_id: S1 }))
// tP2 属于 p2，不派给 p 的会话；跨项目校验在提交时触发
// 把 t3 取消
await as(P, () => s.assignTask({ task_id: t3.id, assigned_session_id: null }))
try { await as(P, () => s.decideTaskReceipt({ id: 'none', decision: 'accepted' })) } catch {}
const submit = (sid, args) => as(sid, () => s.submitTaskReceipt({ source_session_role: 'supporting', result: 'completed', ...args }))

// P1 反例1：未关联会话提交回执 → NOT_ASSOCIATED
let r
try { await submit(OUTSIDER, { project_id: p.id, task_id: t1.id, source_session_id: OUTSIDER, summary: 'outsider' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P1', r === 'NOT_ASSOCIATED', '未关联会话提交回执 → ' + r)
// P2 反例2：supporting 提交其他项目的任务回执 → TASK_PROJECT_MISMATCH
try { await submit(S1, { project_id: p.id, task_id: tP2.id, source_session_id: S1, summary: 'cross project' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P2', r === 'TASK_PROJECT_MISMATCH', '跨项目回执 → ' + r)
// P3 反例3：提交未派给自己的任务 → NOT_ASSIGNED
try { await submit(S1, { project_id: p.id, task_id: t2.id, source_session_id: S1, summary: 'not mine' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P3', r === 'NOT_ASSIGNED', '提交别人的任务 → ' + r)
// P4 反例4：primary 不提交回执 → RECEIPT_PRIMARY_NOT_ALLOWED
try { await submit(P, { project_id: p.id, task_id: t1.id, source_session_id: P, summary: 'primary submit' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P4', r === 'RECEIPT_PRIMARY_NOT_ALLOWED', 'primary 提交回执被拒 → ' + r)
// P5 正例：supporting 提交派给自己的任务 → 成功
let okRec
try { const x = await submit(S1, { project_id: p.id, task_id: t1.id, source_session_id: S1, summary: '我完成了T1' }); okRec = x.receipt; r = 'ALLOWED' } catch (e) { r = 'FAIL:' + e.code }
push('P5', r === 'ALLOWED' && okRec && okRec.status === 'submitted', 'supporting 提交自己的任务 → ' + r)
// P6 反例6：同一回执重复提交 → RECEIPT_ALREADY_SUBMITTED
try { await submit(S1, { project_id: p.id, task_id: t1.id, source_session_id: S1, summary: 'again' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P6', r === 'RECEIPT_ALREADY_SUBMITTED', '重复回执被拒 → ' + r)
// P7 反例：primary 裁定后 checkpoint 不变（职责分离）
const cpBefore = s.checkpoints().length
await as(P, () => s.decideTaskReceipt({ id: okRec.id, decision: 'accepted' }))
push('P7', s.checkpoints().length === cpBefore, '回执裁定后 checkpoint 数量不变（职责分离）')
// P8 反例：accepted 后任务不自动变？——裁定后才是 closed/accepted，验证裁定前后
const t1Now = await s.task(t1.id)
push('P8', t1Now.lifecycle === 'closed' && t1Now.acceptance === 'accepted', '裁定 accepted 后任务才 closed/accepted')
// P9 反例：二次裁定被拒
try { await as(P, () => s.decideTaskReceipt({ id: okRec.id, decision: 'rejected' })); r = 'ALLOWED' } catch (e) { r = e.code }
push('P9', r === 'RECEIPT_NOT_SUBMITTED', '二次裁定被拒 → ' + r)
// P10 反例：只有 primary 能裁定（supporting 裁定 → NOT_PRIMARY）
let r2
try { const x = await submit(S2, { project_id: p.id, task_id: t2.id, source_session_id: S2, summary: 'S2 done' }); await as(S2, () => s.decideTaskReceipt({ id: x.receipt.id, decision: 'accepted' })); r2 = 'ALLOWED' } catch (e) { r2 = e.code }
push('P10', r2 === 'NOT_PRIMARY', 'supporting 裁定回执 → ' + r2)
// P11：取消派单的任务不能提交回执（已撤派 → NOT_ASSIGNED）
try { await submit(S1, { project_id: p.id, task_id: t3.id, source_session_id: S1, summary: 'cancelled' }); r = 'ALLOWED' } catch (e) { r = e.code }
push('P11', r === 'NOT_ASSIGNED', '撤销派单后回执被拒 → ' + r)
// P12：权威写未被放宽——supporting 调 authorizeWrite 类操作（archiveProject）仍 NOT_PRIMARY
try { await as(S1, () => s.archiveProject(p.id)); r = 'ALLOWED' } catch (e) { r = e.code }
push('P12', r === 'NOT_PRIMARY', 'supporting 归档项目仍被拒（authorizeWrite 未放宽）→ ' + r)

await s.close()
const pass = steps.filter(x => x.ok).length
const sum = { at: new Date().toISOString(), suite: 's40-receipt-permissions', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(sum, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + sum.verdict)
process.exit(pass === steps.length ? 0 : 1)
