/**
 * test/s31-task-section.mjs —— 0.15.0 详情第 4 区（任务）与交付物按 task_ids 反查
 *
 * 覆盖：
 *   - 任务按 project_id 归到项目，按台账编号排序
 *   - 交付物两条归属路：① d.project_id 直挂 ② d.task_ids 命中本项目任务（derived）
 *   - derived=true 的交付物不冒充"本项目记录"（前端据此不给「移除」）
 *   - 任务归属是 inferred 时进「未确认」清单，confirmed 不进
 *   - found:false 时 tasks 是空数组、counts.tasks=0（不是 undefined）
 *   - 前端：分区编号 4 任务 / 5 交付物 / 6 变更 / 7 依据，且任务行有 data-task-row
 *
 * 用法：node test/s31-task-section.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { openStore } from '../core/store.mjs'
import { createReadService } from '../core/read.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })

const T = (n) => 'task_' + String(n).padStart(26, '0')
const DLV = (n) => 'dlv_' + String(n).padStart(26, '0')
const SID = 'session-aaaaaaaa-0000-0000-0000-000000000001'

const s = await openStore({ root: BASE, actor: 's31-fixture' })
const created = await s.createProject({ name: '任务区夹具', objective: 'o', next_action: '检查第 4 区', confidence: 'confirmed' })
const pid = created.project.id
await s.linkSession({ project_id: pid, session_id: SID, role: 'primary', basis: 'S31 夹具', confidence: 'confirmed' })

const mkTask = (n, sid, extra = {}) => s.importRecord({
  table: 'task', key: T(n), client_request_id: 's31-task-' + n, emit_changelog: false,
  record: {
    id: T(n), source_id: 'T-000' + n, source_domain: 's31', source_path: 's31:1',
    title: '任务 ' + n, objective: 'o', lifecycle: 'active', acceptance: 'pending',
    project_id: null, primary_session_id: sid, updated_at: '2026-11-18T00:00:00+00:00', rev: 1, ...extra,
  },
})
await mkTask(1, SID)
await mkTask(2, SID)
await mkTask(3, SID)
// 0.15.1 动态归属：任务 1、2 不落库，靠主会话现算；任务 3 人工钉住（解绑也不走）
await s.attributeTask({ task_id: T(3), project_id: pid, basis: '人工判定：这条确实属于本项目', confidence: 'confirmed' })

const mkDlv = (n, extra) => s.importRecord({
  table: 'deliverable', key: DLV(n), client_request_id: 's31-dlv-' + n, emit_changelog: false,
  record: {
    id: DLV(n), project_id: null, title: '交付物 ' + n, kind: 'doc',
    locator: { type: 'absolute', path: 'D:/s31/' + n + '.md' }, state: 'ok', is_final: false, rev: 1, ...extra,
  },
})
await mkDlv(1, { task_ids: [T(1)] })            // 经任务 1（跟随会话）反查 → 本项目
await mkDlv(2, { task_ids: [T(1), T(2)] })      // 两个任务都属本项目 → 仍一条
await mkDlv(3, { task_ids: [T(3)] })            // 任务 3 是人工钉住的 → 也属于本项目
await mkDlv(4, { task_ids: [T(9)] })            // 引用了不存在的任务 → 不属于本项目
await sleep(3)
// 老数据：直接挂项目（不经任务）
await s.domain.table('deliverable').put(DLV(5), {
  id: DLV(5), project_id: pid, title: '交付物 5（直挂）', kind: 'doc',
  locator: { type: 'absolute', path: 'D:/s31/5.md' }, state: 'ok', is_final: false, rev: 1,
})

const svc = createReadService(s, {})
const d = await svc.getProject(pid)
const srcIds = (d.tasks || []).map((t) => t.source_id)
push('T1', srcIds.length === 3 && srcIds.join(',') === 'T-0001,T-0002,T-0003',
  '任务区只收本项目的任务，按台账编号排序（' + srcIds.join(',') + '）')
push('T2', d.counts.tasks === 3, 'counts.tasks 与真实条数一致（' + d.counts.tasks + '）')
push('T3', (d.tasks || []).every((t) => t.project_id === pid && (t.project_source === 'session' || t.project_source === 'confirmed')),
  '任务行带 project_id + project_source（session=跟随会话 / confirmed=人工钉住）')
const bySrc = (d.tasks || []).reduce((m, t) => { m[t.project_source] = (m[t.project_source] || 0) + 1; return m }, {})
push('T3b', bySrc.session === 2 && bySrc.confirmed === 1, '归属来源分得清：跟随会话 2 条、人工钉住 1 条（' + JSON.stringify(bySrc) + '）')

const dlIds = (d.deliverables || []).map((x) => x.id).sort()
push('D1', dlIds.length === 4 && dlIds.includes(DLV(1)) && dlIds.includes(DLV(2)) && dlIds.includes(DLV(3)) && dlIds.includes(DLV(5)),
  '交付物并集：任务反查 3 条（含人工钉住那条）+ 直挂 1 条 = 4（实到 ' + dlIds.length + '）')
push('D2', !dlIds.includes(DLV(4)), '引用不存在任务的交付物不出现')
push('D3', d.deliverables.find((x) => x.id === DLV(5)).derived === false
  && d.deliverables.find((x) => x.id === DLV(1)).derived === true,
  'derived 区分得清：直挂=false，任务反查=true')
push('D4', d.deliverables.find((x) => x.id === DLV(2)).task_ids.length === 2,
  '一条交付物被两个任务引用时仍是一条（task_ids 长度 2）')

const taskUnc = (d.unconfirmed || []).filter((u) => u.kind === 'task')
push('U1', taskUnc.length === 0, '动态归属不再往「未确认」里塞任务（跟随会话是规则，不是猜测）（' + taskUnc.length + ' 条）')
push('U2', d.counts.unconfirmed === (d.unconfirmed || []).length, 'counts.unconfirmed 与清单一致')

const miss = await svc.getProject('prj_不存在')
push('M1', Array.isArray(miss.tasks) && miss.tasks.length === 0 && miss.counts.tasks === 0,
  'found:false 时 tasks 是空数组、counts.tasks=0（不是 undefined）')
push('M2', JSON.stringify(JSON.parse(JSON.stringify(d))) === JSON.stringify(d), '详情可 JSON 序列化（无 undefined/函数漏进去）')

// ---- 动态归属：会话挂上/解绑，任务自动跟着进出 ----
push('S1', d.counts.tasks === 3, '会话挂着时：跟随会话的 2 条 + 人工钉住的 1 条 = 3（' + d.counts.tasks + '）')
await s.unlinkSession({ project_id: pid, session_id: SID, expected_rev: 1 })
const d2 = await svc.getProject(pid)
const remain = (d2.tasks || []).map((t) => t.source_id)
push('S2', d2.counts.sessions === 0 && d2.counts.tasks === 1 && remain[0] === 'T-0003',
  '解绑会话后：跟随会话的 2 条自动离开，只剩人工钉住的 1 条（剩 ' + remain.join(',') + '）')
push('S3', d2.counts.tasks === 1
  && (d2.deliverables || []).some((x) => x.id === DLV(3))
  && !(d2.deliverables || []).some((x) => x.id === DLV(1) || x.id === DLV(2)),
  '交付物跟着任务走：跟随会话那两条任务的交付物离开，只剩钉住任务的 + 直挂的（' + (d2.deliverables || []).length + ' 条）')
// 0.15.2：复活不需要 expected_rev（界面拿不到 unlinked 记录的 rev，要求它等于堵死复活）
await s.linkSession({ project_id: pid, session_id: SID, role: 'primary', basis: 'S31 夹具', confidence: 'confirmed' })
const revived = s.links().find((l) => l.session_id === SID && l.project_id === pid)
push('R1', !!revived && revived.unlinked !== true && revived.rev === 3,
  '解绑后重新关联：不带 expected_rev 也能复活（unlinked 已清、rev=' + (revived && revived.rev) + '）')
let e3 = null
try { await s.linkSession({ project_id: pid, session_id: SID, role: 'supporting', basis: '改了角色', confidence: 'confirmed' }) } catch (x) { e3 = x }
push('R2', e3 && e3.code === 'EXPECTED_REV_REQUIRED',
  '真的改内容（换角色）仍然要 expected_rev（复活宽松 ≠ 允许静默覆盖）')
const d3 = await svc.getProject(pid)
push('S4', d3.counts.tasks === 3, '重新关联后，跟随会话的 2 条自动回来（' + d3.counts.tasks + ' 条）')
push('S5', d3.counts.tasks_stale === 0 && (d3.tasks || []).every((t) => t.evidence_stale === false),
  '动态归属下不存在"依据失效"状态（依据没了它就走了）')
// 库里不留推断值：跟随会话的任务 project_id 必须是 null（纯推导）
const raw = s.tasks().filter((t) => t.project_id)
push('S6', raw.length === 1 && raw[0].id === T(3),
  '库里只存人工钉住的归属，跟随会话的不落库（' + raw.length + ' 条）')

// ---- 会话标题注入：titlesOf 返回 Map 时必须取得到（0.15.1 修的真 bug） ----
{
  const svcMap = createReadService(s, { titlesOf: async (ids) => new Map(ids.map((i) => [i, '来自 Map 的标题'])) })
  const dMap = await svcMap.getProject(pid)
  push('N1', dMap.sessions.length === 1 && dMap.sessions[0].title === '来自 Map 的标题',
    'titlesOf 返回 Map 时标题能注入（原来写成 map[id]，Map 上永远 undefined → 界面回落成「会话 + id」）')
  const svcObj = createReadService(s, { titlesOf: async (ids) => Object.fromEntries(ids.map((i) => [i, '来自对象的标题'])) })
  const dObj = await svcObj.getProject(pid)
  push('N2', dObj.sessions[0] && dObj.sessions[0].title === '来自对象的标题',
    'titlesOf 返回普通对象也兼容（不绑死一种实现）')
  const svcNone = createReadService(s, { titlesOf: async () => new Map() })
  const dNone = await svcNone.getProject(pid)
  push('N3', dNone.sessions[0] && dNone.sessions[0].title === undefined,
    '读不到标题时不编造：字段不出现（前端自己回落成 id）')
}
await s.close()

// ---- 前端静态断言 ----
const client = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
push('F1', client.includes("sec('tasks', '4 · 任务进度'"), '前端有第 4 区「任务进度」')
push('F2', client.includes("sec('deliverables', '5 · 交付物'") && client.includes("sec('logs', '6 · 变更记录")
  && client.includes("sec('basis', '7 · 系统推断的归属'"), '后续分区顺延为 5/6/7，没有重号')
push('F3', client.includes("'data-task-row'"), '任务行有 data-task-row（可被测试与选择器定位）')
push('F6', client.includes('data-task-progress') && client.includes('在做 ') && client.includes('已完成 '),
  '任务区顶部给进度摘要（共 N · 在做 X · 已完成 Y），不是只堆清单')
push('F7', client.includes('taskWord') && client.includes("'已完成'") && client.includes("'做完待验'") && client.includes("'在做'"),
  '状态说人话：在做 / 做完待验 / 已完成（不直接摆 lifecycle·acceptance）')
push('F8', client.includes("'data-basis-details'") && client.includes('默认收起'),
  '依据区默认收起（审计信息，不占日常视线）')
push('F9', client.includes('系统推断的归属') && client.includes('不是你确认过的'),
  '依据区标题与说明说清"这是系统推断，不是用户确认"')
push('F10', client.includes("'data-task-source-kind'") && client.includes('跟随会话') && client.includes('人工确认'),
  '任务行标出归属来源：跟随会话 / 人工确认')
push('F11', client.includes("'data-dl-group'") && client.includes('dlGroupHead'),
  '交付物按类型分组渲染（data-dl-group）')
push('F12', client.includes("'data-dl-summary'") && client.includes('共 ') && client.includes(' 条 · '),
  '交付物区顶部给一行分类统计')
push('F4', client.includes('!x.derived'), 'derived 的交付物不给「移除」按钮（避免影响别的项目）')
push('F5', client.includes('个任务共用'), '交付物行显示被几个任务共用')

const pass = steps.filter((x) => x.ok).length
const summary = { at: new Date().toISOString(), suite: 's31-task-section', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
