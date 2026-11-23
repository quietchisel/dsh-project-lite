/**
 * test/s45-dispatch-spawn.mjs —— 0.22 P0-1/P0-2 Node 层回归。
 * 验证：task_dispatch_spawn 成功链（spawn→挂supporting→建任务→派单）、
 *       失败回滚（dispose 不留孤儿）、越权/缺参反例、P0-2 回执 structured_result 指针。
 * 用真实 apply() + 夹具域 + 假 ctx.get('tools')/假 subagents；父身份由 exec.agent 注入。
 * 用法：node test/s45-dispatch-spawn.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../index.js'
import { TOOL_NAMES } from '../core/agent-tools.mjs'

const BASE = process.argv[2], OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok: !!ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + d) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'root')
await mkdir(ROOT, { recursive: true })

const P = 'session-50000000-0000-4000-8000-000000000001'
const execP = { agent: { session: { id: P }, id: P }, signal: undefined }
const childSid = (n) => 'session-60000000-0000-4000-8000-' + String(n).padStart(12, '0')

const registered = new Map()
let spawnCalls = []
let disposeCalls = 0
let spawnMode = 'ok' // ok | fail | nochild
const fakeSubagents = {
  async startActivation(spec) {
    spawnCalls.push(spec)
    if (spawnMode === 'fail') throw Object.assign(new Error('provider down'), { code: 'PROVIDER_CHANGED' })
    const childId = spawnMode === 'nochild' ? undefined : childSid(spawnCalls.length)
    return {
      childId,
      name: 'agent-' + spawnCalls.length,
      dispose: async () => { disposeCalls++ },
    }
  },
}
const ctx = {
  storageDomain: undefined,
  webServer: { register() { return () => {} } },
  get(name) {
    if (name === 'tools') return { register(spec) { registered.set(spec.name, spec); return () => registered.delete(spec.name) } }
    if (name === 'subagents') return fakeSubagents
    return null
  },
  effect(fn) {},
}
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
await new Promise((r) => setTimeout(r, 900))

const spawn = registered.get('task_dispatch_spawn')
const submitReceipt = registered.get('task_receipt_submit')

// T1：新工具已注册，且在所有工具名里
push('T1', !!spawn && TOOL_NAMES.includes('task_dispatch_spawn'), 'task_dispatch_spawn 注册成功且在 TOOL_NAMES')

// T2：缺参被拒（不 spawn）
let r = await spawn.execute({ project_id: 'prj_x', title: 't' }, execP)
push('T2', r.ok === false && r.error === 'REQUIRED_FIELDS' && spawnCalls.length === 0, '缺 objective/prompt 被拒且未 spawn')

// T3：越权——非 primary 会话调用（未挂项目关联）→ 建项目归属检查在 linkSession/createTask 处拒绝，且回滚
// 先建一个项目（primary=P），再用 OUTSIDER 调 spawn
const create = registered.get('project_create')
const c = await create.execute({ name: '派活测试', objective: 'o', next_action: '打开面板确认派活结果' }, execP)
const pid = c.project.id
const OUTSIDER = 'session-70000000-0000-4000-8000-000000000004'
const execOutsider = { agent: { session: { id: OUTSIDER }, id: OUTSIDER }, signal: undefined }
spawnCalls = []; disposeCalls = 0
r = await spawn.execute({ project_id: pid, title: '越权', objective: 'o', prompt: 'do' }, execOutsider)
push('T3', r.ok === false && r.rolled_back === true && disposeCalls === 1, '非 primary 派活被拒并 dispose 子分支（无孤儿）')

// T4：成功链——primary 派活：spawn→挂supporting→建任务→派单
spawnCalls = []; disposeCalls = 0
r = await spawn.execute({ project_id: pid, title: '写文稿', objective: '产出文稿', prompt: '写一篇文稿', acceptance_criteria: ['有正文'] }, execP)
const t4child = r.child_session_id
push('T4', r.ok === true && !!t4child && !!r.task?.id, 'primary 派活成功返回 child_session_id 与任务')
push('T5', r.ok === true && r.task.assigned_session_id === t4child, '任务已派给子会话（assigned_session_id=child）')
push('T6', spawnCalls.length === 1 && spawnCalls[0].provider === 'spawn' && spawnCalls[0].parent === execP.agent && spawnCalls[0].delivery === 'parent', 'startActivation 形状正确（provider/parent/delivery）')

// T7：挂关联——子会话确认为项目 supporting
const linksOf = registered.get('project_links_of_session')
const lk = await linksOf.execute({ session_id: t4child })
push('T7', lk.ok === true && lk.total === 1 && lk.links[0].role === 'supporting', '子会话已挂为项目 supporting')

// T8：spawn 抛错 → 明确错误、无 dispose（还没建成就没得回滚）
spawnMode = 'fail'; spawnCalls = []; disposeCalls = 0
r = await spawn.execute({ project_id: pid, title: '失败', objective: 'o', prompt: 'do' }, execP)
push('T8', r.ok === false && r.error === 'PROVIDER_CHANGED' && spawnCalls.length === 1, 'spawn 抛错返回原始错误码')

// T9：spawn 成功但无 childId → 回滚
spawnMode = 'nochild'; disposeCalls = 0
r = await spawn.execute({ project_id: pid, title: '无child', objective: 'o', prompt: 'do' }, execP)
push('T9', r.ok === false && r.error === 'CHILD_ID_MISSING', '无 childId 被拒')

// T10：P0-2 回执 structured_result 指针——supporting 提交回执返回里带 source_session_id
spawnMode = 'ok'
spawnCalls = []; disposeCalls = 0
const r2 = await spawn.execute({ project_id: pid, title: '回执测试', objective: 'o', prompt: 'do' }, execP)
const t2id = r2.task.id, child2 = r2.child_session_id
const execChild2 = { agent: { session: { id: child2 }, id: child2 }, signal: undefined }
const sub = await submitReceipt.execute({ project_id: pid, task_id: t2id, summary: '子分支完成', result: 'completed' }, execChild2)
push('T10', sub.ok === true && sub.structured_result?.source_session_id === child2 && sub.structured_result?.task_id === t2id, '回执返回 structured_result 指针（分支 sid + task id）')

const pass = steps.filter(x => x.ok).length
const sum = { at: new Date().toISOString(), suite: 's45-dispatch-spawn', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(sum, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + sum.verdict)
process.exit(pass === steps.length ? 0 : 1)
