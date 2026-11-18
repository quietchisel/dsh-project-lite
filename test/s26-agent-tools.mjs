/**
 * test/s26-agent-tools.mjs —— S4 Agent 工具的 Node 层回归。
 *
 * 用真实 apply() + 夹具域，注入假 ctx.get('tools') 与本地 defineTool（原样返回），
 * 收集注册的 5 个工具，逐个直接调 execute 验证只读与受控写入。
 * 不 import @deepseek-ai/dsh-tools（本机 optional peer 没装），走本地等价。
 *
 * 用法：node test\s26-agent-tools.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../index.js'
import { TOOL_NAMES } from '../core/agent-tools.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const ROOT = join(BASE, 'root')
await mkdir(ROOT, { recursive: true })

const registered = new Map()
let ctxEffect
const ctx = {
  storageDomain: undefined,
  webServer: { register() { return () => {} } },
  get(name) { return name === 'tools' ? { register(spec) { registered.set(spec.name, spec); return () => registered.delete(spec.name) } } : null },
  effect(fn) { ctxEffect = fn },
}
apply(ctx, { root: ROOT, evidencePath: join(BASE, 'ev.jsonl') })
await new Promise((r) => setTimeout(r, 900)) // 等 loadDefineTool().then 注册完（它要遍历候选路径）

push('T1', registered.size === 5 && TOOL_NAMES.every((n) => registered.has(n)), '五个工具都注册成功（实际 ' + [...registered.keys()].join(',') + '）')
push('T2', !!registered.get('project_list')?.description && !!registered.get('project_get')?.description, '工具有 description（Agent 据此判断何时用）')

const list = registered.get('project_list')
const get = registered.get('project_get')
const links = registered.get('project_links_of_session')
const create = registered.get('project_create')
const link = registered.get('project_link_session')

// 空库只读
const r0 = await list.execute({})
push('T3', r0.ok === true && r0.total === 0 && Array.isArray(r0.projects), '空库 project_list 返回 ok + total=0')

// 写工具拒态度词（不落库）
const bad = await create.execute({ name: 'X', objective: 'o', next_action: '继续推进' })
push('T4', bad.ok === false && bad.error === 'NEXT_ACTION_INVALID', 'create 拒态度词 next_action')
const bad2 = await create.execute({ name: 'X', objective: 'o', next_action: '短' })
push('T5', bad2.ok === false && bad2.error === 'NEXT_ACTION_INVALID', 'create 拒过短 next_action')

// 建项目（exec.agent 提供当前会话）
const SID = 'session-aabbccdd-1234-5678-abcd-0123456789ab'
const exec = { agent: { sessionId: SID }, signal: undefined }
const c1 = await create.execute({ name: '工具建的项目', objective: '验证 Agent 写工具', next_action: '打开项目面板确认这条记录' }, exec)
push('T6', c1.ok === true && !!c1.project?.id, 'create 成功返回新项目 id（' + (c1.project && c1.project.id) + '）')
const pid = c1.project && c1.project.id

// 只读查回
const r1 = await list.execute({})
push('T7', r1.ok === true && r1.total === 1 && r1.projects[0].id === pid, 'create 后 project_list 查得到（单一事实源）')
const g1 = await get.execute({ project_id: pid })
push('T8', g1.ok === true && g1.found === true && g1.project.name === '工具建的项目', 'project_get 返回详情')
const g2 = await get.execute({})
push('T9', g2.ok === false && g2.error === 'PROJECT_ID_REQUIRED', 'project_get 缺 id 返回明确错误')

// 关联会话（写工具，exec 提供 session）
// create 已自动把当前会话挂上（primary）；这里由 primary 把「另一个会话」挂成 supporting。
// 注意：S1-A 之后写工具要求调用方是该项目 primary，所以不能用 SID2 当调用方（那是越权，见 S1-A P2/P3）。
const SID2 = 'session-11223344-5566-7788-99aa-bbccddeeff00'
const l1 = await link.execute({ project_id: pid, session_id: SID2, role: 'supporting', basis: '第二个会话验证关联工具' }, exec)
push('T10', l1.ok === true && l1.changed === true, 'link 新会话首次关联 changed=true')
const l2 = await link.execute({ project_id: pid, session_id: SID2, role: 'supporting', basis: '第二个会话验证关联工具' }, exec)
push('T11', l2.ok === true && l2.changed === false, 'link 重复关联 changed=false（幂等）')
const l3 = await link.execute({ project_id: pid, role: 'primary', basis: '' }, exec)
push('T12', l3.ok === false && l3.error === 'BASIS_REQUIRED', 'link 缺 basis 被拒')
const l4 = await link.execute({ project_id: pid, role: 'supporting', basis: '短' }, exec)
push('T13', l4.ok === false && l4.error === 'SUPPORTING_NEEDS_REASON', 'supporting 理由过短被拒')

// links_of_session 查回
const ls1 = await links.execute({}, exec)
push('T14', ls1.ok === true && ls1.total === 1 && ls1.links[0].project.id === pid, 'links_of_session 缺省 session_id 用当前会话，查到一条')
const ls2 = await links.execute({ session_id: 'session-ffffffff-ffff-ffff-ffff-ffffffffffff' })
push('T15', ls2.ok === true && ls2.total === 0, 'links_of_session 陌生会话返回 0 条')

// 磁盘落盘核对（写得进去也要读得出来）
const pdir = join(ROOT, 'project', 'project')
const files = (await readdir(pdir)).filter((x) => x.endsWith('.json'))
const raw = await readFile(join(pdir, files[0]), 'utf8')
const rec = JSON.parse(typeof raw === 'string' ? raw : String(raw)).record
push('T16', rec.next_action === '打开项目面板确认这条记录' && rec.done_when === undefined, '落盘记录 next_action 正确、done_when 未写空数组')

// dispose 后工具撤销
if (ctxEffect) { const cleanup = await ctxEffect(); if (cleanup) await cleanup() }
push('T17', registered.size === 0, 'dispose 后工具全部撤销')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's26-agent-tools', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await (await import('node:fs/promises')).writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
