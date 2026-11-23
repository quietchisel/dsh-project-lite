/**
 * test/s44-reduction.mjs —— v0.21 减负改造：第一批 A-D + 第二批三件的后端逻辑。
 * 覆盖：project_update 工具（白名单/CAS/权限）、completionCandidate、getProject.receipts、
 * inbox 数据源（assigned_session_id）、overview.primary_count、不能绕过状态枚举。
 * 用法：node test/s44-reduction.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2], OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok: !!ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + d) }
const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { createReadService } = await import(pathToFileURL(INST + '/core/read.mjs').href)
const { openStore } = await import(pathToFileURL(INST + '/core/store.mjs').href)
const { createSessionRegistry } = await import(pathToFileURL(INST + '/core/sessions.mjs').href)
const { registerAgentTools, TOOL_NAMES } = await import(pathToFileURL(INST + '/core/agent-tools.mjs').href)
const { runAsCaller } = await import(pathToFileURL(INST + '/core/identity.mjs').href)

const P = 'session-10000000-0000-4000-8000-000000000001'
const S = 'session-20000000-0000-4000-8000-000000000002'
const exec = (sid) => ({ agent: { session: { id: sid } } })
const as = (sid, fn) => runAsCaller({ sessionId: sid, source: 's44' }, fn)
await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store'); await mkdir(ROOT, { recursive: true })
const st = await openStore({ root: ROOT, actor: 's44' })

// T0：工具已注册
push('T0', TOOL_NAMES.includes('project_update') && TOOL_NAMES.includes('task_dispatch_spawn') && TOOL_NAMES.length === 13, 'TOOL_NAMES 含 project_update/task_dispatch_spawn，共 13 个工具')

// 建项目 + 关联 primary + supporting
const p = (await as(P, () => st.createProject({ name: '减负测试', objective: '验证七项', next_action: '派一个任务给分支', session_id: P }))).project
// createProject 已自动把 P 关联为 primary（与 s42 同口径）；补一个 supporting 分支。
await as(P, () => st.linkSession({ project_id: p.id, session_id: S, role: 'supporting', basis: '会话右键关联' }))

// T1：overview 带 primary_count（A 右键智能默认数据源）
const read = createReadService(st)
const ov = read.overview()
const psum = ov.groups.flatMap(g => g.items).find(x => x.id === p.id)
push('T1', psum && psum.primary_count === 1, 'overview 项目带 primary_count=1（右键默认 supporting）')

// T1b：会话右键回归——固定 basis 重复关联同一会话+项目 → changed=false，不因内容变化报错。
// （动态 basis 会让 linkSession 判为内容变化 → EXPECTED_REV_REQUIRED，真机 2026-11-21 踩过。）
const relink = await as(P, () => st.linkSession({ project_id: p.id, session_id: S, role: 'supporting', basis: '会话右键关联' }))
push('T1b', relink.changed === false && relink.rev === 1, '固定 basis 重复关联 → changed=false 零副作用（防动态basis回归）')

// T1c：真机回归——unlinked 记录（历史 basis/role 与提交不同）复活，不带 expected_rev 应成功。
// 真机 2026-11-21：历史记录 basis='使用者授权关联…' role=primary unlinked=true，前端用新 basis 复活成 supporting 报错。
const OTHER = 'session-30000000-0000-4000-8000-000000000003'
await as(P, () => st.linkSession({ project_id: p.id, session_id: OTHER, role: 'supporting', basis: '历史长文案授权 2026-11-17' }))
await as(P, () => st.unlinkSession({ project_id: p.id, session_id: OTHER, expected_rev: 1 }))
let reviveErr = null, revived = null
try { revived = await as(P, () => st.linkSession({ project_id: p.id, session_id: OTHER, role: 'supporting', basis: '会话右键关联' })) } catch (x) { reviveErr = x }
const revivedRec = st.links().find((l) => l.session_id === OTHER && l.project_id === p.id)
push('T1c', !reviveErr && revived && revived.changed === true && revivedRec && revivedRec.basis === '会话右键关联' && revivedRec.unlinked !== true,
  'unlinked 记录用不同 basis 复活（不带rev）成功，basis 按本次提交 → ' + (reviveErr ? reviveErr.code : 'ok'))

// T2：completionCandidate 初始为 false（有项目但无 accepted 任务）
let cc = read.completionCandidate(p.id)
push('T2', cc.applicable === true && cc.candidate === false && cc.counts.total === 0, '无任务时完成候选=false')

// T3：派单 + 提交回执 + 裁定 accepted → 完成候选 true
const tk = (await as(P, () => st.createTask({ project_id: p.id, title: '算 2+2', objective: '得 4', assigned_session_id: S }))).task
await as(P, () => st.assignTask({ task_id: tk.id, assigned_session_id: S }))
const rc = (await as(S, () => st.submitTaskReceipt({ project_id: p.id, task_id: tk.id, source_session_id: S, source_session_role: 'supporting', summary: '结果是4', result: 'completed' }))).receipt
await as(P, () => st.decideTaskReceipt({ id: rc.id, decision: 'accepted' }))
cc = read.completionCandidate(p.id)
push('T3', cc.candidate === true && cc.counts.accepted === 1 && cc.counts.total === 1, '全部任务 accepted → 完成候选=true')

// T4：getProject 带 receipts（B 面板按钮数据源）
const det = await read.getProject(p.id)
push('T4', Array.isArray(det.receipts) && det.receipts.length === 1 && det.receipts[0].status === 'accepted', 'getProject.receipts 含裁定后的回执')

// T5：inbox 数据源——assigned_session_id 过滤（共享收件箱）
// 再派一个未完成任务给 S
const tk2 = (await as(P, () => st.createTask({ project_id: p.id, title: '算 3+3', objective: '得 6', assigned_session_id: S }))).task
await as(P, () => st.assignTask({ task_id: tk2.id, assigned_session_id: S }))
const inbox = st.tasks().filter(t => t.assigned_session_id === S && t.lifecycle === 'active' && t.acceptance !== 'accepted')
push('T5', inbox.length === 1 && inbox[0].id === tk2.id, 'inbox 按 assigned_session_id 筛出唯一待办')

// T6：新增完成候选后不再是 candidate（还有 active 任务）
cc = read.completionCandidate(p.id)
push('T6', cc.candidate === false && cc.counts.active === 1, '新增 active 任务 → 完成候选回落 false')

// T7：project_update 工具——primary 收敛 status=done + next_action
const reg = new Map()
const ctx = { tools: { register(spec) { reg.set(spec.name, spec); return () => {} } } }
registerAgentTools(ctx, { defineTool: (o) => o, tools: ctx.tools, getStore: async () => st, readService: createReadService, titlesOf: async()=>new Map(), registry: null, evidence: () => {} })
await new Promise(r => setTimeout(r, 40))
const upd = reg.get('project_update')
const rev = st.project(p.id).rev
const u1 = await upd.execute({ project_id: p.id, status: 'done', next_action: '归档项目交付物到知识库', expected_rev: rev }, exec(P))
push('T7', u1.ok === true && u1.project.status === 'done' && u1.changed === true, 'primary project_update status=done 成功')

// T8：非 primary 不能 update（authorizeWrite 拒绝）
const rev2 = st.project(p.id).rev
const u2 = await upd.execute({ project_id: p.id, status: 'active', next_action: '恢复推进这个项目', expected_rev: rev2 }, exec(S))
push('T8', u2.ok === false && u2.error === 'NOT_PRIMARY', 'supporting project_update 被拒 → ' + u2.error)

// T9：CAS 冲突——旧 rev 被拒
const cur = st.project(p.id).rev
const u3 = await upd.execute({ project_id: p.id, status: 'active', next_action: '用过期版本号尝试覆盖', expected_rev: cur - 5 }, exec(P))
push('T9', u3.ok === false && u3.error === 'REV_CONFLICT', '过期 rev → REV_CONFLICT，不覆盖')

// T10：状态枚举——不能通过工具写 archived/deleted
const u4 = await upd.execute({ project_id: p.id, status: 'archived', next_action: '试图绕过归档路由', expected_rev: st.project(p.id).rev }, exec(P))
push('T10', u4.ok === false && u4.error === 'INVALID_STATUS', 'archived 被拒（须走专属路由）→ ' + u4.error)

// T11：白名单——store.updateProject 拒非法字段
let fieldErr = null
try { await as(P, () => st.updateProject({ project_id: p.id, status: 'active', owner_override: 'hack', expected_rev: st.project(p.id).rev })) } catch (e) { fieldErr = e.code }
push('T11', fieldErr === 'FIELD_NOT_ALLOWED', 'updateProject 拒非法字段 → ' + fieldErr)

// T12：done 状态后完成候选不再提示
cc = read.completionCandidate(p.id)
push('T12', cc.applicable === false && cc.reason === 'already_terminal', '项目 done 后完成候选不再提示')

await st.close()
const pass = steps.filter(x => x.ok).length
const sum = { at: new Date().toISOString(), suite: 's44-reduction', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(sum, null, 2), 'utf8')
console.log('\nRESULT ' + sum.verdict + ' ' + pass + '/' + steps.length)
process.exit(sum.verdict === 'PASS' ? 0 : 1)
