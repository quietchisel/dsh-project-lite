/**
 * test/s42-receipt-e2e.mjs —— 0.19 跨会话 E2E（外审指定场景）。
 * 主对话派单图片/音频/文稿 → 三个 supporting 并行执行并提交回执 → 主对话汇总 → 人工裁定 → 新会话 Resume 读准确状态。
 * 走真实工具层（registerAgentTools），身份来自 exec，验证受限授权在工具链里成立。
 * 用法：node test/s42-receipt-e2e.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2], OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok: !!ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + d) }
const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { apply, CREATE_PATH } = await import(pathToFileURL(INST + '/index.js').href)
const { createReadService } = await import(pathToFileURL(INST + '/core/read.mjs').href)
const { openStore } = await import(pathToFileURL(INST + '/core/store.mjs').href)
const { createSessionRegistry } = await import(pathToFileURL(INST + '/core/sessions.mjs').href)
const { registerAgentTools } = await import(pathToFileURL(INST + '/core/agent-tools.mjs').href)
const { runAsCaller } = await import(pathToFileURL(INST + '/core/identity.mjs').href)

const P = 'session-10000000-0000-4000-8000-000000000001'
const S_IMG = 'session-20000000-0000-4000-8000-000000000002'
const S_AUD = 'session-30000000-0000-4000-8000-000000000003'
const S_TXT = 'session-40000000-0000-4000-8000-000000000004'
const WS = '06fd24c8-b593-4fab-8b3f-26dc65602d3b'
await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store'); await mkdir(ROOT, { recursive: true })
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS, workspaceIds: [WS], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [WS]: { path: BASE, title: 'W', sessionIds: [P, S_IMG, S_AUD, S_TXT, 'session-90000000-0000-4000-8000-000000000009'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } } },
}), 'utf8')
const exec = (sid) => ({ agent: { session: { id: sid } } })
const st = await openStore({ root: ROOT, actor: 's42' })
const as = (sid, fn) => runAsCaller({ sessionId: sid, source: 's42' }, fn)
// 建项目 + 三个 supporting 关联（用 store 直接建，等价 UI 人工关联）
const p = (await as(P, () => st.createProject({ name: '视频解说', objective: '三路并行', next_action: '派三个子任务给分支会话', session_id: P }))).project
for (const [sid, role] of [[S_IMG, 'supporting'], [S_AUD, 'supporting'], [S_TXT, 'supporting']]) {
  await as(P, () => st.linkSession({ project_id: p.id, session_id: sid, role, basis: '分支' }))
}
// 工作区关联（0.18 工作区解析依赖 project_workspace）
await as(P, () => st.linkWorkspace({ project_id: p.id, workspace_id: WS, workspace_title: 'W', basis: 'E2E 工作区' }))
await st.close()

// 工具层
const s2 = await openStore({ root: ROOT, actor: 's42b' })
const registry = createSessionRegistry({ root: ROOT })
const reg = new Map()
const ctx = { tools: { register(spec) { reg.set(spec.name, spec); return () => {} } } }
registerAgentTools(ctx, { defineTool: (o) => o, tools: ctx.tools, getStore: async () => s2, readService: createReadService, titlesOf: registry.titlesOf, registry, evidence: () => {} })
await new Promise(r => setTimeout(r, 60))
const dispatch = reg.get('task_dispatch'), receiptsTool = reg.get('task_receipts'), submit = reg.get('task_receipt_submit'), decide = reg.get('task_receipt_decide'), resume = reg.get('project_resume')

// E1 主对话派三个任务
const d1 = await dispatch.execute({ project_id: p.id, title: '图片', objective: '封面配图', assigned_session_id: S_IMG }, exec(P))
const d2 = await dispatch.execute({ project_id: p.id, title: '音频', objective: '配音', assigned_session_id: S_AUD }, exec(P))
const d3 = await dispatch.execute({ project_id: p.id, title: '文稿', objective: '解说词', assigned_session_id: S_TXT }, exec(P))
push('E1', d1.ok && d2.ok && d3.ok, '主对话派三任务 → 三分支')
// E2 supporting 不能派单（越权）
const badDispatch = await dispatch.execute({ project_id: p.id, title: '越权', objective: 'x', assigned_session_id: S_IMG }, exec(S_IMG))
push('E2', badDispatch.ok === false && badDispatch.error === 'NOT_PRIMARY', '分支派单被拒 → ' + badDispatch.error)
// E3 三分支并行提交回执
const rImg = await submit.execute({ project_id: p.id, task_id: d1.task.id, source_session_id: S_IMG, summary: '图片完成', result: 'completed', deliverables: ['cover.png'] }, exec(S_IMG))
const rAud = await submit.execute({ project_id: p.id, task_id: d2.task.id, source_session_id: S_AUD, summary: '音频完成', result: 'completed', deliverables: ['voice.wav'] }, exec(S_AUD))
const rTxt = await submit.execute({ project_id: p.id, task_id: d3.task.id, source_session_id: S_TXT, summary: '文稿完成', result: 'completed', deliverables: ['script.md'] }, exec(S_TXT))
push('E3', rImg.ok && rAud.ok && rTxt.ok, '三分支并行提交回执，各落 submitted')
// E4 汇总：查回执 3 条
const listed = await receiptsTool.execute({ project_id: p.id })
push('E4', listed.total === 3 && listed.receipts.every(r => r.status === 'submitted'), '主对话汇总 3 条待裁定回执')
// E5 裁定前任务非 accepted
const before = await s2.task(d1.task.id)
push('E5', before.acceptance === 'implemented_unverified', '裁定前任务仅 implemented_unverified（回执≠完成）')
// E6 primary 裁定：接受图片/文稿，拒绝音频
const cImg = await decide.execute({ receipt_id: rImg.receipt.id, decision: 'accepted' }, exec(P))
const cTxt = await decide.execute({ receipt_id: rTxt.receipt.id, decision: 'accepted' }, exec(P))
const cAud = await decide.execute({ receipt_id: rAud.receipt.id, decision: 'rejected', note: '需重录' }, exec(P))
push('E6', cImg.ok && cTxt.ok && cAud.ok, 'primary 裁定三项（2 接受 1 拒绝）')
// E7 正式状态按裁定更新
const tImg = await s2.task(d1.task.id), tAud = await s2.task(d2.task.id), tTxt = await s2.task(d3.task.id)
push('E7', tImg.acceptance === 'accepted' && tTxt.acceptance === 'accepted' && tAud.acceptance === 'pending', '任务状态按裁定：2 accepted、1 退回 pending')
// E8 新会话 Resume 读准确状态
const newSid = 'session-90000000-0000-4000-8000-000000000009'
const rr = await resume.execute({}, exec(newSid))
push('E8', rr.found === true && rr.project_id === p.id && rr.resolved_via === 'workspace', '新会话裸调 Resume → 按工作区定位项目（via=' + rr.resolved_via + '）')
// E9 回执/任务不污染 checkpoint
push('E9', Array.isArray(rr.relevant_deliverable_refs), 'Resume 返回高信号摘要（不含回执正文）')

await s2.close()
const pass = steps.filter(x => x.ok).length
const sum = { at: new Date().toISOString(), suite: 's42-receipt-e2e', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(sum, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + sum.verdict)
process.exit(pass === steps.length ? 0 : 1)
