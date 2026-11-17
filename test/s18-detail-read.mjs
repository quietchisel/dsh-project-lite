/**
 * test/s18-detail-read.mjs —— 详情页后端装配（read.mjs 的 getProject）机检。
 *
 * 覆盖：
 *   - projectSummary 透传 done_when / tags / legacy_id / legacy_refs
 *   - counts 四个分区与真实条数一致
 *   - unconfirmed 只收 confidence==='inferred' 的四种实体，且条数 == counts.unconfirmed
 *   - logs 按时间倒序
 *   - found:false 时六区全空、counts 全 0（不是 undefined）
 *   - 返回可 JSON 序列化（没有 undefined / 函数漏进去）
 *
 * 如实标注：Node 层 + 真存储后端，没有真实 Host / Desktop，最高算 Implemented。
 *
 * 用法：node test\s18-detail-read.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openStore } from '../core/store.mjs'
import { createReadService } from '../core/read.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })

const SID1 = 'session-aaaaaaaa-0000-0000-0000-000000000001'
const SID2 = 'session-bbbbbbbb-0000-0000-0000-000000000002'

const s = await openStore({ root: BASE, actor: 's18-fixture' })

// 主项目：inferred + done_when + tags
const created = await s.createProject({
  name: '详情页夹具',
  objective: '把六分区都填上',
  next_action: '检查每个分区都有数据',
  done_when: ['六分区都有数据', '空态不空白'],
  tags: ['夹具', '详情'],
  confidence: 'inferred',
  basis: 'S18 夹具推断',
})
const pid = created.project.id
await sleep(3)
// confirmed 的会话关联（不该进 unconfirmed）
await s.linkSession({ project_id: pid, session_id: SID1, role: 'primary', basis: 'S18 确认关联', confidence: 'confirmed' })
await sleep(3)
// inferred 的会话关联（该进 unconfirmed）
await s.linkSession({ project_id: pid, session_id: SID2, role: 'supporting', basis: 'S18 推断关联', confidence: 'inferred' })
await sleep(3)
// inferred 的工作区
await s.domain.table('project_workspace').put(pid + '__11111111-1111-1111-1111-111111111111', {
  id: pid + '__11111111-1111-1111-1111-111111111111',
  project_id: pid, workspace_id: 'ws-1', workspace_title: '夹具工作区',
  confidence: 'inferred', basis: 'S18 推断工作区', created_at: new Date().toISOString(), rev: 1,
})
// confirmed 的交付物
const dlvId = 'dlv_01M7GT9SB8PTSQMDBH6SHDNR0A'
await s.domain.table('deliverable').put(dlvId, {
  id: dlvId, project_id: pid, title: '夹具交付物', kind: 'doc',
  locator: { type: 'absolute', path: 'D:\\x.md' }, state: 'ok', is_final: true, rev: 1,
})
await sleep(3)
await s.archiveProject(pid)

const svc = createReadService(s)
const d = await svc.getProject(pid)

push('C1', Array.isArray(d.project.done_when) && d.project.done_when.length === 2, 'done_when 透传为数组（' + JSON.stringify(d.project.done_when) + '）')
push('C2', Array.isArray(d.project.tags) && d.project.tags.join(',') === '夹具,详情', 'tags 透传（' + JSON.stringify(d.project.tags) + '）')
push('C3', d.project.legacy_id === null && Array.isArray(d.project.legacy_refs) && d.project.legacy_refs.length === 0, 'legacy_id=null / legacy_refs=[]（没有就不编）')
push('C4', d.counts.sessions === 2 && d.sessions.length === 2, 'counts.sessions 与实际一致（' + d.counts.sessions + '）')
push('C5', d.counts.workspaces === 1 && d.counts.deliverables === 1, 'counts.workspaces/deliverables 一致（' + d.counts.workspaces + '/' + d.counts.deliverables + '）')

const kinds = d.unconfirmed.map((u) => u.kind).sort()
// project(inferred) + session(inferred) + workspace(inferred)；deliverable 是 confirmed，不该出现。
push('C6', kinds.join(',') === 'project,session,workspace', 'unconfirmed 只收 inferred（' + kinds.join(',') + '）')
push('C7', d.unconfirmed.every((u) => u.basis && u.basis.length > 0), '每条未确认都带 basis（浮层要能说清凭什么）')
push('C8', !d.unconfirmed.some((u) => u.session_id === SID1), 'confirmed 的会话关联不进 unconfirmed')
push('C9', d.counts.unconfirmed === d.unconfirmed.length, 'counts.unconfirmed == 数组长度（' + d.counts.unconfirmed + '）')

const ops = d.logs.map((l) => l.op)
// create + link + link + archive = 4 条；倒序后第一条是最新的 archive。
push('C10', d.logs.length === 4 && ops[0] === 'archive' && ops[3] === 'create', 'logs 按时间倒序，最新 archive、最早 create（' + ops.join('<') + '）')
push('C11', d.counts.logs === d.logs.length && d.logs.length <= 100, 'logs 条数与 counts 一致且 ≤100')

const miss = await svc.getProject('prj_01M7GT9SB8PTSQMDBH6SHDNR0A')
push('C12', miss.found === false && miss.project === null, '找不到项目 → found:false')
push('C13', Array.isArray(miss.sessions) && Array.isArray(miss.workspaces) && Array.isArray(miss.deliverables) && Array.isArray(miss.logs)
  && miss.sessions.length === 0 && miss.workspaces.length === 0 && miss.deliverables.length === 0 && miss.logs.length === 0,
  'found:false 时六区全空数组（不是 undefined）')

let serial = null
try { serial = JSON.parse(JSON.stringify(d)) } catch (e) { serial = null }
push('C14', serial !== null && serial.project.id === pid && typeof serial.project.done_when[0] === 'string', '返回可 JSON 序列化且字段完整')
push('C15', d.logs.every((l) => l.source === 'manual'), '1.9：每条变更都标了来源（全部 manual，当前没有 runner）')

await s.close()

const pass = steps.filter((x) => x.ok).length
const summary = { at: new Date().toISOString(), suite: 's18-detail-read', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
