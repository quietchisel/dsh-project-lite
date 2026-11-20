/**
 * test/s39-workspace-resume.mjs —— 0.18 工作区→项目只读解析（project_resume 裸调）。
 *
 * 审核授权 W1-W8：
 *   W1 无 primary，工作区唯一关联 active 项目 → 自动 Resume
 *   W2 工作区关联多个 active 项目 → multiple_candidates（不猜）
 *   W3 工作区无项目关联 / 会话不在注册表 → no_association
 *   W4 workspace registry 不可用 → registry_unavailable（拒绝猜测）
 *   W5 unlinked 工作区关系不参与解析
 *   W6 会话重复出现在多个工作区 → workspace_ambiguous
 *   W7 原有 primary 解析不回归（唯一 primary 直接定；多 primary 候选）
 *   W8 显式 project_id 优先于工作区歧义
 * 只读解析：不改项目归属、不调 transferPrimary、不碰权威写机制。
 * 用法：node test/s39-workspace-resume.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2], OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok: !!ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + d) }
const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { createReadService } = await import(pathToFileURL(INST + '/core/read.mjs').href)
const { openStore } = await import(pathToFileURL(INST + '/core/store.mjs').href)
const { createSessionRegistry } = await import(pathToFileURL(INST + '/core/sessions.mjs').href)
const { registerAgentTools } = await import(pathToFileURL(INST + '/core/agent-tools.mjs').href)
const { runAsCaller } = await import(pathToFileURL(INST + '/core/identity.mjs').href)

const WS1 = '11111111-0000-4000-8000-000000000001'
const WS2 = '22222222-0000-4000-8000-000000000002'
const WS3 = '33333333-0000-4000-8000-000000000003'
const WS4 = '44444444-0000-4000-8000-000000000004'
const BUILDER = 'session-f0000000-0000-4000-8000-000000000000'
const S_W1 = 'session-a1000000-0000-4000-8000-000000000001'
const S_W2 = 'session-a2000000-0000-4000-8000-000000000002'
const S_W5 = 'session-a5000000-0000-4000-8000-000000000005'
const S_W6 = 'session-a6000000-0000-4000-8000-000000000006'
const S_WS3 = 'session-a7000000-0000-4000-8000-000000000007'
const S_NONE = 'session-a9000000-0000-4000-8000-000000000009'
const S_PRI = 'session-b1000000-0000-4000-8000-000000000001'
const S_PRI2 = 'session-b2000000-0000-4000-8000-000000000002'

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'store')
await mkdir(ROOT, { recursive: true })
// S_W1 只在 WS1；S_W2 只在 WS2；S_W6 同时 WS2+WS3；S_W5 只在 WS4；S_WS3 只在 WS3
await writeFile(join(ROOT, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: WS1, workspaceIds: [WS1, WS2, WS3, WS4], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: {
    [WS1]: { path: BASE, title: 'W1', sessionIds: [S_W1], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    [WS2]: { path: BASE, title: 'W2', sessionIds: [S_W2, S_W6], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    [WS3]: { path: BASE, title: 'W3', sessionIds: [S_W6, S_WS3], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    [WS4]: { path: BASE, title: 'W4', sessionIds: [S_W5], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
  } },
}), 'utf8')

const store = await openStore({ root: ROOT, actor: 's39' })
// 项目统一由 BUILDER 建（BUILDER 是各项目 primary），被测会话不带任何 primary 关联
const mk = async (name) => (await runAsCaller({ sessionId: BUILDER, source: 's39' }, () =>
  store.createProject({ name, objective: '目标 ' + name, next_action: '验证工作区续接解析', session_id: BUILDER }))).project
const lw = (pid, ws) => runAsCaller({ sessionId: BUILDER, source: 's39' }, () =>
  store.linkWorkspace({ project_id: pid, workspace_id: ws, workspace_title: ws, basis: 's39 夹具' }))
const uw = (pid, ws) => runAsCaller({ sessionId: BUILDER, source: 's39' }, () =>
  store.unlinkWorkspace({ project_id: pid, workspace_id: ws }))

const p1 = await mk('P1唯一')
await lw(p1.id, WS1)
await lw(p1.id, WS2)
const p2 = await mk('P2多候选')
await lw(p2.id, WS2)
const p3 = await mk('P3已解绑')
await lw(p3.id, WS4)
await uw(p3.id, WS4)
// W7 用各自会话建，形成 primary 关联
const mkBy = async (name, sid) => (await runAsCaller({ sessionId: sid, source: 's39' }, () =>
  store.createProject({ name, objective: '目标 ' + name, next_action: '验证主会话解析不回归', session_id: sid }))).project
const p4 = await mkBy('P4primary', S_PRI)
const p5 = await mkBy('P5primary', S_PRI2)
const p6 = await mkBy('P6primary', S_PRI2)
await store.close()

const s2 = await openStore({ root: ROOT, actor: 's39b' })
const registry = createSessionRegistry({ root: ROOT })
const reg = new Map()
const toolCtx = { tools: { register(spec) { reg.set(spec.name, spec); return () => {} } } }
registerAgentTools(toolCtx, {
  defineTool: (o) => o, tools: toolCtx.tools, getStore: async () => s2,
  readService: createReadService, titlesOf: registry.titlesOf, registry, evidence: () => {},
})
await new Promise(r => setTimeout(r, 60))
const resume = reg.get('project_resume')
const exec = (sid) => ({ agent: { session: { id: sid } } })

const r1 = await resume.execute({}, exec(S_W1))
push('W1', r1.ok !== false && r1.found === true && r1.project_id === p1.id && r1.resolved_via === 'workspace', '无 primary + 工作区唯一 active 项目 → 自动 Resume（via=' + r1.resolved_via + '）')

const r2 = await resume.execute({}, exec(S_W2))
push('W2', r2.found === false && r2.state === 'multiple_candidates' && Array.isArray(r2.candidates) && r2.candidates.length >= 2, '工作区关联多个 active 项目 → multiple_candidates（' + (r2.candidates || []).length + ' 候选）')

const r3a = await resume.execute({}, exec(S_NONE))
push('W3a', r3a.found === false && r3a.state === 'no_association', '会话不在注册表 → no_association（不猜）')
const r3b = await resume.execute({}, exec(S_WS3))
push('W3b', r3b.found === false && r3b.state === 'no_association', '工作区无项目关联 → no_association')

const regNo = new Map(); const ctxNo = { tools: { register(spec) { regNo.set(spec.name, spec); return () => {} } } }
registerAgentTools(ctxNo, { defineTool: (o) => o, tools: ctxNo.tools, getStore: async () => s2, readService: createReadService, evidence: () => {} })
const r4 = await regNo.get('project_resume').execute({}, exec(S_W1))
push('W4', r4.found === false && r4.state === 'registry_unavailable', 'registry 不可用 → registry_unavailable（拒绝猜测）')

const r5 = await resume.execute({}, exec(S_W5))
push('W5', r5.found === false && r5.state === 'no_association', 'unlinked 工作区关系不参与解析 → no_association')

const r6 = await resume.execute({}, exec(S_W6))
push('W6', r6.found === false && r6.state === 'workspace_ambiguous' && Array.isArray(r6.candidates) && r6.candidates.length === 2, '会话多工作区 → workspace_ambiguous（' + (r6.candidates || []).length + ' 工作区）')

const r7a = await resume.execute({}, exec(S_PRI))
push('W7a', r7a.found === true && r7a.project_id === p4.id && r7a.resolved_via === 'primary', '唯一 primary 解析不回归（via=' + r7a.resolved_via + '）')
const r7b = await resume.execute({}, exec(S_PRI2))
push('W7b', r7b.found === false && r7b.state === 'multiple_candidates' && (r7b.candidates || []).length >= 2, '多 primary 候选不回归')

const r8 = await resume.execute({ project_id: p1.id }, exec(S_W6))
push('W8', r8.found === true && r8.project_id === p1.id && r8.resolved_via === 'explicit', '显式 project_id 优先于工作区歧义（via=' + r8.resolved_via + '）')

await s2.close()
const pass = steps.filter(s => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's39-workspace-resume', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
