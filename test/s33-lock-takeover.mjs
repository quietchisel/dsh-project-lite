/**
 * test/s33-lock-takeover.mjs —— 审计 B：过期锁接管边界回归。
 *
 * 覆盖：
 *   L1 活跃锁（持锁进程存活 + 心跳新鲜）禁止普通接管（LOCK_ACTIVE）
 *   L2 持锁进程已死(pidAlive=false)即使心跳未超时也允许显式接管
 *   L3 两个接管者并发 → 只有一个成功（第二个 no-lock / race-lost）
 *   L4 锁元数据损坏 → acquire 抛 LOCK_METADATA_UNREADABLE，不静默当无锁
 *   L5 授权闸：缺 authorized/reason 一律拒绝
 *
 * 如实标注：Node 层 + 真 createJournal + 合成数据，Implemented。
 * 跨物理进程并发未实测（renameSync 原子性为代码推断），见 04-风险。
 *
 * 用法：node test/s33-lock-takeover.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { createJournal, STATES } = await import(pathToFileURL(INST + '/core/journal.mjs').href)
await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })

const jd = join(BASE, 'project', '_journal')
await mkdir(jd, { recursive: true })
const lockPath = join(jd, 'domain.lock')

// L1：写一个活跃锁（当前进程 pid + 新心跳 + 同主机）
const nowIso = () => new Date().toISOString()
await writeFile(lockPath, JSON.stringify({
  pid: process.pid, host: hostname(), domain: BASE, token: 'active-token',
  proc_start_epoch: Math.round(Date.now() - process.uptime() * 1000),
  created_at: nowIso(), heartbeat_at: nowIso(), kind: 'domain-lock', schema: 1,
}, null, 1), 'utf8')
let j = createJournal({ root: BASE })
let l1code = null
try { j.recoverStaleLock({ authorized: true, reason: 'L1 测试活跃锁', actor: 's33' }) } catch (e) { l1code = e.code }
push('L1', l1code === 'LOCK_ACTIVE', '活跃锁（进程存活+心跳新鲜）禁止普通接管（' + l1code + '）')
// 锁仍在（没被 rename）
push('L1b', (await readFile(lockPath, 'utf8')).includes('active-token'), '被拒后原锁未被改动')

// L2：持锁进程已死（不存在的 PID）+ 心跳新鲜 → 允许接管（pidAlive 参与判定）
await writeFile(lockPath, JSON.stringify({
  pid: 99999999, host: hostname(), domain: BASE, token: 'dead-token',
  proc_start_epoch: 1, created_at: nowIso(), heartbeat_at: nowIso(), kind: 'domain-lock', schema: 1,
}, null, 1), 'utf8')
let tk = null
try { tk = j.recoverStaleLock({ authorized: true, reason: 'L2 holder pid dead', actor: 's33' }) } catch (e) { tk = { error: e.code } }
push('L2', tk && tk.takenOver === true && tk.kind === 'dead-holder', '持锁进程已死（心跳仍新鲜）允许显式接管（kind=' + tk.kind + '）')

// L3：并发两个接管者 —— 先放一个死 PID 锁，两个同时接管
await writeFile(lockPath, JSON.stringify({
  pid: 99999998, host: hostname(), domain: BASE, token: 'race-token',
  proc_start_epoch: 1, created_at: nowIso(), heartbeat_at: nowIso(), kind: 'domain-lock', schema: 1,
}, null, 1), 'utf8')
const race = await Promise.allSettled([
  Promise.resolve().then(() => j.recoverStaleLock({ authorized: true, reason: 'race-A', actor: 'A' })),
  Promise.resolve().then(() => j.recoverStaleLock({ authorized: true, reason: 'race-B', actor: 'B' })),
])
const okCount = race.filter((r) => r.status === 'fulfilled' && r.value && r.value.takenOver === true).length
push('L3', okCount === 1, '两个并发接管者只有一个成功（成功数=' + okCount + '）')

// L4：元数据损坏 → acquire 不静默当无锁
const j2root = join(BASE, 'corrupt')
const j2 = createJournal({ root: j2root })
const lj = join(j2root, 'project', '_journal')
await mkdir(lj, { recursive: true })
await writeFile(join(lj, 'domain.lock'), '{ not json', 'utf8')
let l4code = null
try { await j2.acquire() } catch (e) { l4code = e.code }
push('L4', l4code === 'LOCK_METADATA_UNREADABLE', '锁元数据损坏 → LOCK_METADATA_UNREADABLE，不静默当无锁（' + l4code + '）')

// L5：授权闸
await writeFile(join(j2root, 'project', '_journal', 'domain.lock'), JSON.stringify({ pid: 99999997, host: hostname(), heartbeat_at: '2020-01-01T00:00:00.000Z' }), 'utf8')
let e5a = null, e5b = null
try { j2.recoverStaleLock({ reason: 'x' }) } catch (e) { e5a = e.code }
try { j2.recoverStaleLock({ authorized: true }) } catch (e) { e5b = e.code }
push('L5', e5a === 'LOCK_TAKEOVER_UNAUTHORIZED' && e5b === 'LOCK_TAKEOVER_UNAUTHORIZED', '缺 authorized 或缺 reason 一律拒绝接管')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's33-lock-takeover', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
