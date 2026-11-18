/**
 * test/s1b-primary.mjs —— PROJECT_PRIMARY_CONFLICT（一个 Project 最多一个有效 primary）
 *
 * 用法：node test/s1b-primary.mjs [workdir] [out.json]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../core/store.mjs'
import { SID } from './_lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || '.tmp/base-s1b-primary'
const OUT = process.argv[3] || '.tmp/s1b-primary.json'
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const clean = async (p) => { await rm(p, { recursive: true, force: true }); await mkdir(p, { recursive: true }) }

// ---------- 1) 0 个 primary：通过 ----------
{
  const root = join(ROOT, 'zero'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'zero', objective: 'o', next_action: 'nothing here', client_request_id: 'c-zero' })
  await s.linkSession({ project_id: p.project.id, session_id: SID(1), role: 'supporting', basis: 'only supporting' })
  push('P1', s.primaryConflicts().length === 0, '0 个 primary：无冲突')
  await s.close()
}

// ---------- 2) 1 个 primary：通过；4) 再加 primary 拒绝；5) 加 supporting 允许 ----------
{
  const root = join(ROOT, 'one'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'one', objective: 'o', next_action: 'nothing here', client_request_id: 'c-one' })
  await s.linkSession({ project_id: p.project.id, session_id: SID(1), role: 'primary', basis: 'first primary' })
  push('P2', s.primaryConflicts().length === 0, '1 个 primary：无冲突')
  let e = null
  try { await s.linkSession({ project_id: p.project.id, session_id: SID(2), role: 'primary', basis: 'second primary' }) } catch (x) { e = x }
  push('P4', e && e.code === 'PROJECT_PRIMARY_CONFLICT', '已有 1 个 primary 再加 primary：拒绝（' + (e && e.code) + '）')
  const sup = await s.linkSession({ project_id: p.project.id, session_id: SID(2), role: 'supporting', basis: 'supporting ok' })
  push('P5', sup && sup.role === 'supporting' && sup.changed === true, '再加 supporting：允许（rev=' + sup.rev + '）')
  push('P6a', s.primaryConflicts().length === 0, '加了 supporting 仍只有 1 个 primary')
  await s.close()
}

// ---------- 3) 2 个 primary：检测到冲突（用 importRecord 绕过守卫，模拟历史数据） ----------
{
  const root = join(ROOT, 'two'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'two', objective: 'o', next_action: 'nothing here', client_request_id: 'c-two' })
  const pid = p.project.id
  for (const n of [1, 2]) {
    const key = pid + '__' + SID(n)
    await s.importRecord({ table: 'project_session', key, record: { id: key, project_id: pid, session_id: SID(n), role: 'primary', confidence: 'confirmed', basis: '历史导入', source: 'legacy', created_at: new Date().toISOString(), rev: 1 }, client_request_id: 'c-two-' + n })
  }
  const cf = s.primaryConflicts()
  push('P3', cf.length === 1 && cf[0].project_id === pid && cf[0].sessions.length === 2,
    '2 个 primary：检测到冲突（' + JSON.stringify(cf[0] && cf[0].sessions.map((x) => x.slice(0, 18))) + '）')
  const r = await s.reconcile({})
  const c10 = r.checks.find((c) => c.id === 10)
  push('P3b', c10 && c10.status === 'fail' && /PROJECT_PRIMARY_CONFLICT/.test(c10.name), '对账第 10 条报 fail（' + (c10 && c10.status) + '）')
  push('P3c', s.writable === true, '双主不把域降级成只读（历史冲突可继续存在）')
  // 7) 导入后不被自动修改
  const links = s.links().filter((l) => l.project_id === pid)
  push('P7', links.length === 2 && links.every((l) => l.role === 'primary' && l.unlinked !== true && l.rev === 1),
    '导入的双主原样保留，没有被自动降级/删除（' + links.length + ' 条，rev 都是 1）')
  await s.close()
}

// ---------- 6) unlinked 的旧 primary 不参与活动计数 ----------
{
  const root = join(ROOT, 'unlinked'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'unl', objective: 'o', next_action: 'nothing here', client_request_id: 'c-unl' })
  const pid = p.project.id
  await s.linkSession({ project_id: pid, session_id: SID(1), role: 'primary', basis: 'old primary' })
  const l1 = s.links().find((l) => l.session_id === SID(1))
  await s.unlinkSession({ project_id: pid, session_id: SID(1), expected_rev: l1.rev })
  const okNew = await s.linkSession({ project_id: pid, session_id: SID(2), role: 'primary', basis: 'new primary after unlink' })
  push('P6b', okNew && okNew.role === 'primary' && s.primaryConflicts().length === 0,
    'unlinked 的旧 primary 不计入：可以建立新 primary（' + okNew.session_id.slice(0, 18) + '）')
  await s.close()
}

// ---------- 8) 改角色字段也不能绕过 ----------
{
  const root = join(ROOT, 'bypass'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'byp', objective: 'o', next_action: 'nothing here', client_request_id: 'c-byp' })
  const pid = p.project.id
  await s.linkSession({ project_id: pid, session_id: SID(1), role: 'primary', basis: 'primary' })
  await s.linkSession({ project_id: pid, session_id: SID(2), role: 'supporting', basis: 'supporting' })
  const sup = s.links().find((l) => l.session_id === SID(2))
  let e = null
  try { await s.linkSession({ project_id: pid, session_id: SID(2), role: 'primary', basis: 'supporting', expected_rev: sup.rev }) } catch (x) { e = x }
  push('P8', e && e.code === 'PROJECT_PRIMARY_CONFLICT', '把 supporting 改成 primary 也被拒（' + (e && e.code) + '）')
  // 已删除项目不得新增角色
  await s.deleteProject(pid, { expected_rev: s.project(pid).rev })
  let e2 = null
  try { await s.linkSession({ project_id: pid, session_id: SID(3), role: 'supporting', basis: 'deleted project' }) } catch (x) { e2 = x }
  push('P8b', e2 && e2.code === 'PROJECT_DELETED', '回收站里的项目不再接受角色写入（' + (e2 && e2.code) + '）')
  await s.close()
}

// ---------- 9) transferPrimary：同一操作内完成降级+升级，无中间双主 ----------
{
  const root = join(ROOT, 'transfer'); await clean(root)
  const s = await openStore({ root, actor: 't' })
  const p = await s.createProject({ name: 'tr', objective: 'o', next_action: 'nothing here', client_request_id: 'c-tr' })
  const pid = p.project.id
  await s.linkSession({ project_id: pid, session_id: SID(1), role: 'primary', basis: 'A' })
  await s.linkSession({ project_id: pid, session_id: SID(2), role: 'supporting', basis: 'B' })
  const beforeLogs = s.logs().length
  const r = await s.transferPrimary({ project_id: pid, to_session_id: SID(2), basis: '交接' })
  const links = s.links().filter((l) => l.project_id === pid && l.unlinked !== true)
  const prim = links.filter((l) => l.role === 'primary')
  push('P9', prim.length === 1 && prim[0].session_id === SID(2), '转移后恰好 1 个 primary，且是 B（' + prim.map((l) => l.session_id.slice(0, 18)) + '）')
  push('P9b', links.find((l) => l.session_id === SID(1)).role === 'supporting', '原 primary 被降为 supporting')
  push('P9c', s.logs().length === beforeLogs + 1 && s.primaryConflicts().length === 0, '只写 1 条 changelog，且无冲突')
  const j = s.journal.listJournals().filter((x) => x.op === 'transferPrimary' && x.state === 'COMMITTED')
  push('P9d', j.length === 1 && j[0].steps.filter((st) => st.table === 'project_session').length === 2,
    '两条写入在同一个 COMMITTED journal 里（plan steps=' + (j[0] && j[0].steps.length) + '）')
  const again = await s.transferPrimary({ project_id: pid, to_session_id: SID(2), basis: '交接' })
  push('P9e', again.changed === false, '重复转移 = 零副作用（changed=false）')
  await s.close()
}

const pass = steps.filter((s) => s.ok).length
const result = { at: new Date().toISOString(), total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await mkdir(join(OUT, '..'), { recursive: true })
await writeFile(OUT, JSON.stringify(result, null, 1), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + result.verdict)
