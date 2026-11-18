/**
 * test/s1c-attribution.mjs —— Task → Project 归属规则与写入守卫
 *
 * 用法：node test/s1c-attribution.mjs [workdir] [out.json]
 *
 * 分两层：
 *   1) 纯规则（planTaskAttribution）：不碰磁盘，把 8 种拒绝理由逐个跑出来；
 *   2) store 写入口（attributeTask）：守卫、幂等、降级、对账第 11 条。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore, openStoreReadOnly } from '../core/store.mjs'
import { planTaskAttribution, summarizeAttribution, ATTRIBUTION_RULE, ATTR_REASON_TEXT } from '../core/attribution.mjs'
import { canon } from '../core/journal.mjs'
import { SID, snapshotTree, diffSnapshot } from './_lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || '.tmp/base-s1c-attr'
const OUT = process.argv[3] || '.tmp/s1c-attribution.json'
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const clean = async (p) => { await rm(p, { recursive: true, force: true }); await mkdir(p, { recursive: true }) }
const TASK_ID = (n) => 'task_' + String(n).padStart(26, '0')

// ---------- 纯规则 ----------
const T0 = '2026-11-16T00:00:00.000Z'
const P1 = { id: 'prj_A', name: 'P1', status: 'active', created_at: T0 }
const P2 = { id: 'prj_B', name: 'P2', status: 'active', created_at: T0 }
const PDEL = { id: 'prj_D', name: 'PD', status: 'deleted', created_at: T0 }
const L = (pid, sid, extra = {}) => ({ id: pid + '__' + sid, project_id: pid, session_id: sid, role: 'primary', confidence: 'confirmed', basis: '人工关联', rev: 1, ...extra })
const TK = (n, sid, extra = {}) => ({ id: TASK_ID(n), source_id: 'T-00' + n, primary_session_id: sid, ...extra })

function one(task, projects, links) {
  const r = planTaskAttribution({ tasks: [task], projects, links })
  return r.decisions[0]
}

{
  const d = one(TK(1, SID(1)), [P1], [L('prj_A', SID(1))])
  push('A1', d.project_id === 'prj_A' && d.confidence === 'inferred' && d.reason === 'OK', '正常继承：挂 prj_A、置信度 inferred（' + d.reason + '）')
  push('A2', typeof d.basis === 'string' && d.basis.includes(SID(1)) && d.basis.includes('人工关联'), '依据里写清会话与关联来源（' + d.basis + '）')
}
push('A3', one(TK(2, null), [P1], [L('prj_A', SID(1))]).reason === 'NO_PRIMARY_SESSION', '没有主会话 → 不归属')
push('A4', one(TK(3, SID(9)), [P1], [L('prj_A', SID(1))]).reason === 'NO_PROJECT_LINK', '主会话没有关联 → 不归属')
push('A5', one(TK(4, SID(1)), [P1], [L('prj_A', SID(1), { unlinked: true })]).reason === 'NO_PROJECT_LINK', '软解绑（unlinked）后不再继承')
push('A6', one(TK(5, SID(1)), [P1], [L('prj_A', SID(1), { confidence: 'inferred' })]).reason === 'LINK_UNCONFIRMED', '关联本身是 inferred → 不传递')
{
  const d = one(TK(6, SID(1)), [P1, P2], [L('prj_A', SID(1)), L('prj_B', SID(1))])
  push('A7', d.reason === 'MULTI_PROJECT' && d.project_id === null && d.candidates.length === 2, '一个会话两个活跃项目 → 冲突不猜（' + JSON.stringify(d.candidates) + '）')
}
push('A8', one(TK(7, SID(1)), [PDEL], [L('prj_D', SID(1))]).reason === 'PROJECT_DELETED', '候选项目在回收站 → 不挂')
push('A9', one(TK(8, SID(1)), [], [L('prj_X', SID(1))]).reason === 'LINK_DANGLING', '关联指向不存在的项目 → 不挂')
push('A10', one(TK(9, SID(1), { source_updated_at: '2026-11-14T09:24:00+08:00' }), [P1], [L('prj_A', SID(1))]).reason === 'PREDATES_PROJECT',
  '任务最后写入早于项目创建 → 不挂（T-0001 那种情形）')
push('A11', one(TK(10, SID(1), { source_updated_at: '2026-11-17T09:24:00+08:00' }), [P1], [L('prj_A', SID(1))]).reason === 'OK',
  '任务最后写入晚于项目创建 → 正常继承')
push('A12', one(TK(11, SID(1)), [P1], [L('prj_A', SID(1))]).reason === 'OK', '没有来源时间戳 → 不套用时间否决（缺证据不等于否决）')
{
  const tasks = [TK(1, SID(1)), TK(2, null), TK(3, SID(9))]
  const links = [L('prj_A', SID(1))]
  const r1 = planTaskAttribution({ tasks, projects: [P1], links })
  const r2 = planTaskAttribution({ tasks, projects: [P1], links })
  push('A13', r1.rule === ATTRIBUTION_RULE && r1.rule === 'attr-v1', '规则版本可追溯（' + r1.rule + '）')
  push('A14', canon(r1.decisions) === canon(r2.decisions), '纯函数：同样输入两次结果完全一致')
  const s = r1.summary
  push('A15', s.total === 3 && s.attributed === 1 && s.unassigned === 2 && s.by_project.prj_A === 1 && s.by_reason.OK === 1,
    '汇总计数正确（total=3 attributed=1 by_reason=' + JSON.stringify(s.by_reason) + '）')
  push('A16', Object.values(ATTR_REASON_TEXT).length >= 8, '每种拒绝理由都有中文解释（' + Object.keys(ATTR_REASON_TEXT).length + ' 条）')
}

// ---------- store 写入口 ----------
const seedTask = (s, id, sid) => s.importRecord({
  table: 'task', key: id, client_request_id: 'seed-' + id, emit_changelog: false,
  record: {
    id, source_id: 'T-TEST', source_domain: 'test', source_path: 'test:1',
    title: '测试任务 ' + id.slice(-2), objective: 'o', lifecycle: 'active', acceptance: 'pending',
    project_id: null, primary_session_id: sid, updated_at: T0, rev: 1,
  },
})

{
  const root = join(ROOT, 'attr'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'P1', objective: 'o', next_action: 'nothing here', client_request_id: 'c-p1' })
  const pid = p.project.id
  await s.linkSession({ project_id: pid, session_id: SID(1), role: 'primary', basis: '人工关联' })
  await seedTask(s, TASK_ID(20), SID(1))

  const r = await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '主会话关联继承', confidence: 'inferred', evidence: 'link rev 1', client_request_id: 'c-attr-1' })
  push('B1', r.changed === true && r.rev === 2 && r.project_id === pid && r.project_confidence === 'inferred' && r.project_basis === '主会话关联继承',
    '首次归属：rev 2、confidence/basis 一起落盘（rev=' + r.rev + '）')
  const logs = s.logs().filter((l) => l.target_table === 'task' && l.target_key === TASK_ID(20))
  push('B2', logs.length === 1 && logs[0].op === 'link' && logs[0].after_rev === 2, '写了一条 changelog（op=link，after_rev=2）')
  push('B3', s.tasks().length === 1 && s.tasks()[0].project_id === pid, 'tasks() 读得回这条归属（单一事实源）')
  push('B4', ATTR_REASON_TEXT.OK.length > 0 && r.project_basis !== undefined, '归属记录带得出依据（不是只有 project_id）')

  const before = await snapshotTree(root)
  const r2 = await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '主会话关联继承', confidence: 'inferred', evidence: 'link rev 1' })
  const after = await snapshotTree(root)
  push('B5', r2.changed === false && r2.rev === 2, '重复挂同样的归属：changed=false、rev 不动')
  push('B6', diffSnapshot(before, after).length === 0, '零写盘：整棵目录哈希与 mtime 完全一致（差异 ' + diffSnapshot(before, after).length + '）')

  const r3 = await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '主会话关联继承', confidence: 'inferred', evidence: 'link rev 1', client_request_id: 'c-attr-1' })
  const nowRec = s.tasks().find((t) => t.id === TASK_ID(20))
  push('B7', r3.replayed === true && nowRec.rev === 2 && s.logs().filter((l) => l.target_key === TASK_ID(20)).length === 1,
    '同一 client_request_id 重放：走 journal 回放（replayed=true），rev 与 changelog 都不增')

  let e = null
  try { await s.attributeTask({ task_id: TASK_ID(20), project_id: 'prj_不存在', basis: 'x' }) } catch (x) { e = x }
  push('B8', e && e.code === 'PROJECT_NOT_FOUND', '挂到不存在的项目：拒绝（' + (e && e.code) + '）')

  const dead = await s.createProject({ name: '死项目', objective: 'o', next_action: 'nothing here', client_request_id: 'c-p2' })
  await s.deleteProject(dead.project.id, { expected_rev: 1 })
  e = null
  try { await s.attributeTask({ task_id: TASK_ID(20), project_id: dead.project.id, basis: 'x', expected_rev: 2 }) } catch (x) { e = x }
  push('B9', e && e.code === 'PROJECT_DELETED', '挂到回收站里的项目：拒绝（' + (e && e.code) + '）')

  e = null
  try { await s.attributeTask({ task_id: TASK_ID(99), project_id: pid, basis: 'x' }) } catch (x) { e = x }
  push('B10', e && e.code === 'TASK_NOT_FOUND', '任务不存在：拒绝（' + (e && e.code) + '）')

  // 确认后再被推断覆盖 → 拒绝
  await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '人确认', confidence: 'confirmed', expected_rev: 2, client_request_id: 'c-attr-2' })
  e = null
  try { await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '推断', confidence: 'inferred', expected_rev: 3 }) } catch (x) { e = x }
  push('B11', e && e.code === 'ATTRIBUTION_DOWNGRADE', '已确认的归属不许被推断覆盖（' + (e && e.code) + '）')
  const r4 = await s.attributeTask({ task_id: TASK_ID(20), project_id: pid, basis: '推断', confidence: 'inferred', allow_downgrade: true, expected_rev: 3 })
  push('B12', r4.changed === true && r4.project_confidence === 'inferred' && r4.rev === 4, '显式 allow_downgrade 才允许降级（rev=4）')

  // 对账第 11 条
  let rec = await s.reconcile({})
  let c11 = rec.checks.find((c) => c.id === 11)
  push('B13', c11 && c11.status === 'pass', '对账第 11 条：归属都指得回活项目 → pass（' + (c11 && c11.detail) + '）')
  // 人为造一条指向回收站项目的任务，检查必须 fail
  await seedTask(s, TASK_ID(21), SID(1))
  await s.attributeTask({ task_id: TASK_ID(21), project_id: pid, basis: '临时' })
  await s.deleteProject(pid, { expected_rev: 1 })
  rec = await s.reconcile({})
  c11 = rec.checks.find((c) => c.id === 11)
  push('B14', c11 && c11.status === 'fail' && /task_/.test(c11.detail), '任务挂在回收站项目上 → 第 11 条 fail（' + (c11 && c11.status) + '）')

  // 来源时间补写：只写一个字段、必须带 expected_rev、重复补写零写盘
  const t20 = s.tasks().find((t) => t.id === TASK_ID(20))
  const st1 = await s.setTaskSourceTime({ task_id: TASK_ID(20), source_updated_at: '2026-11-14T09:24:00+08:00', expected_rev: t20.rev })
  push('B16', st1.changed === true && st1.source_updated_at === '2026-11-14T09:24:00+08:00' && st1.rev === t20.rev + 1,
    '补来源时间：写进去、rev +1（rev=' + st1.rev + '）')
  const st2 = await s.setTaskSourceTime({ task_id: TASK_ID(20), source_updated_at: '2026-11-14T09:24:00+08:00', expected_rev: st1.rev })
  push('B17', st2.changed === false && st2.rev === st1.rev, '重复补同一个时间：changed=false、rev 不动')
  let e2 = null
  try { await s.setTaskSourceTime({ task_id: TASK_ID(20), source_updated_at: '2026-11-13T00:00:00+08:00' }) } catch (x) { e2 = x }
  push('B18', e2 && e2.code === 'EXPECTED_REV_REQUIRED', '改写已有来源时间必须带 expected_rev（' + (e2 && e2.code) + '）')

  // 第 7 条：交付物 project_id 为空是**合法**的（S1-B 之后允许），不能算悬挂引用
  const DLV = 'dlv_' + '0'.repeat(26)
  await s.importRecord({ table: 'deliverable', key: DLV, emit_changelog: false, record: {
    id: DLV, project_id: null, title: '无归属交付物', kind: 'doc',
    locator: { type: 'absolute', path: 'D:/x.md' }, state: 'ok', is_final: false, rev: 1 } })
  rec = await s.reconcile({})
  const c7 = rec.checks.find((c) => c.id === 7)
  push('B19', c7 && c7.status === 'pass', 'project_id 留空的交付物不算悬挂引用（第 7 条 pass：' + (c7 && c7.detail) + '）')

  const r5 = await s.attributeTask({ task_id: TASK_ID(20), project_id: null, basis: '清空', client_request_id: 'c-attr-3' })
  push('B15', r5.changed === true && r5.project_id === null && r5.project_basis === undefined && r5.project_confidence === undefined,
    '显式清空：project_id 与溯源字段一起删掉（不留半条依据）')
  await s.close()
}

// ---------- 只读打开：必须看得懂盘上的 {version, record} 信封 ----------
{
  const root = join(ROOT, 'ro'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  await s.createProject({ name: 'RO', objective: 'o', next_action: 'nothing here', client_request_id: 'c-ro' })
  await seedTask(s, TASK_ID(30), SID(1))
  await s.close()
  const ro = await openStoreReadOnly({ root })
  push('B20', ro.verdict.metaState === 'ok' && ro.degradationReport().kind === 'ok',
    '只读打开正常域：metaState=ok、不误报损坏（拆得开 {version,record} 信封）')
  push('B21', ro.projects().length === 1 && ro.tasks().length === 1 && ro.taskSessions().length === 0,
    '只读打开能读到 project/task（projects=1 tasks=1）')
  push('B22', ro.meta() && ro.meta().expected_counts && typeof ro.meta().expected_counts.project === 'number',
    '只读打开读得到基线 expected_counts（' + JSON.stringify(ro.meta().expected_counts) + '）')
}

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's1c-attribution', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
const { writeFile } = await import('node:fs/promises')
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
