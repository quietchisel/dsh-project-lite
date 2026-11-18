/**
 * test/s1a-journal.mjs —— S1-A 操作日志实跑测试
 * 崩溃用真实子进程强杀（Windows TerminateProcess），不是抛错模拟。
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { openStore } from '../core/store.mjs'
import { createJournal } from '../core/journal.mjs'
import { snapshotTree, diffSnapshot, SID } from './_lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || '.tmp/base-s1a'
const OUT = process.argv[3] || '.tmp/s1a.json'
const SELF = join(HERE, 's1a-journal.mjs')
const steps = []
// 本地 push：明确 (id, ok, detail) 三参，避免和 _lib 的四参版本搞混（曾导致“全部假 PASS”）
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const out = (s) => process.stdout.write(String(s) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = async (p) => { await rm(p, { recursive: true, force: true }); await mkdir(p, { recursive: true }) }
const jdir = (root) => join(root, 'project', '_journal', 'ops')
const journals = (root) => (existsSync(jdir(root)) ? readdirSync(jdir(root)).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(jdir(root), n), 'utf8'))) : [])
const byCrid = (root, crid) => journals(root).find((j) => j.client_request_id === crid) || null
const projFiles = (root) => (existsSync(join(root, 'project', 'project')) ? readdirSync(join(root, 'project', 'project')).filter((n) => n.endsWith('.json')) : [])
const logFiles = (root) => (existsSync(join(root, 'project', 'changelog')) ? readdirSync(join(root, 'project', 'changelog')).filter((n) => n.endsWith('.json')) : [])
const projRecords = (root) => projFiles(root).map((n) => JSON.parse(readFileSync(join(root, 'project', 'project', n), 'utf8')).record)
const named = (root, name) => projRecords(root).filter((p) => p.name === name)

// ============ 子进程模式 ============
const MODE = process.argv[2]
if (MODE === '__create') {
  const root = process.argv[3]; const crid = process.argv[4]; const name = process.argv[5] || 'child-proj'
  const s = await openStore({ root, actor: 's1a-child' })
  out('opened')
  try {
    const r = await s.createProject({ name, objective: 'crash case', next_action: 'finish the test', client_request_id: crid })
    out('created ' + r.project.id)
  } catch (e) { out('ERR ' + (e.code || e.message)) }
  await s.close(); process.exit(0)
}
if (MODE === '__archive') {
  const root = process.argv[3]; const pid = process.argv[4]; const crid = process.argv[5]
  const s = await openStore({ root, actor: 's1a-child' })
  out('opened')
  try { await s.archiveProject(pid, { client_request_id: crid }); out('archived') } catch (e) { out('ERR ' + (e.code || e.message)) }
  await s.close(); process.exit(0)
}
if (MODE === '__recover') {
  const root = process.argv[3]
  const s = await openStore({ root, actor: 's1a-recover' })
  out('opened')
  try { const r = await s.recover({ authorized: true, reason: 'test recovery' }); out('recovered ' + JSON.stringify(r.recovered.map((x) => x.state))) }
  catch (e) { out('ERR ' + (e.code || e.message)) }
  await s.close(); process.exit(0)
}
if (MODE === '__hold') {
  const root = process.argv[3]
  const s = await openStore({ root, actor: 's1a-hold' })
  s.journal.ensureDirs()
  const lock = await s.journal.acquire()
  out('LOCKED')
  await sleep(Number(process.argv[4] || 6000))
  lock.release(); out('RELEASED'); process.exit(0)
}
if (MODE === '__compete') {
  const root = process.argv[3]; const tag = process.argv[4]
  const s = await openStore({ root, actor: 's1a-' + tag })
  let ok = 0, fail = 0, lastErr = null
  for (let i = 0; i < 8; i++) {
    try { await s.createProject({ name: tag + '-' + i, objective: 'compete', next_action: 'write it now', client_request_id: tag + '-crid-' + i }); ok++ }
    catch (e) { fail++; lastErr = e.code || e.message }
  }
  out('RESULT ' + JSON.stringify({ tag, ok, fail, lastErr })); process.exit(0)
}

function runChild(cmd, args = [], { env = {}, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, cmd, ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let so = '', se = ''
    child.stdout.on('data', (d) => { so += d })
    child.stderr.on('data', (d) => { se += d })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, so, se, pid: child.pid }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, so, se: String(e), pid: child.pid }) })
  })
}
// ============ J：Journal + 幂等 ============
await clean(ROOT);
{
  const s = await openStore({ root: ROOT, actor: 's1a' })
  const r1 = await s.createProject({ name: 'j1', objective: 'o', next_action: 'keep going', client_request_id: 'crid-j1' })
  const j1 = byCrid(ROOT, 'crid-j1')
  push('J1', !!j1 && j1.state === 'COMMITTED' && j1.result_ref === 'record:' + r1.project.id,
    '建项目落一条 COMMITTED journal，result_ref 指向记录（' + (j1 && j1.state) + '）')
  const stepTables = (j1.steps || []).map((x) => x.table)
  push('J2', stepTables.includes('project') && stepTables.includes('changelog') && stepTables.includes('global') && j1.steps.every((x) => x.after !== undefined),
    '计划包含 project + changelog + 基线，全部带 after 快照（' + stepTables.join(',') + '）')
  const snapBefore = await snapshotTree(join(ROOT, 'project'))
  const r2 = await s.createProject({ name: 'j1', objective: 'o', next_action: 'keep going', client_request_id: 'crid-j1' })
  const snapAfter = await snapshotTree(join(ROOT, 'project'))
  push('J3', r2.project.id === r1.project.id && r2.replayed === true, '同 crid 同参数 → 回放原结果（replayed=true）')
  push('J4', diffSnapshot(snapBefore, snapAfter).length === 0, '回放零副作用（整域快照逐文件一致）')
  let e5 = null
  try { await s.createProject({ name: 'j1-different', objective: 'o', next_action: 'keep going', client_request_id: 'crid-j1' }) } catch (e) { e5 = e }
  push('J5', e5 && e5.code === 'REQUEST_ID_CONFLICT', '同 crid 不同参数 → REQUEST_ID_CONFLICT（' + (e5 && e5.code) + '）')
  const r6 = await s.createProject({ name: 'j1', objective: 'o', next_action: 'keep going', client_request_id: 'crid-j6' })
  push('J6', r6.project.id !== r1.project.id && r6.replayed === false, '不同 crid 同参数 → 允许独立执行（新 id）')
  await s.close()
}

// ============ C：8 个崩溃点（真实强杀） ============
const CRASH_POINTS = ['prepared', 'step-recorded', 'record-written', 'step-completed', 'pre-commit', 'post-commit']
for (const point of CRASH_POINTS) {
  const root = join(ROOT, 'crash-' + point)
  await clean(root)
  const crid = 'crid-crash-' + point
  const ch = await runChild('__create', [root, crid, 'crash-' + point], { env: { S1A_CRASH_AT: point } })
  const killed = ch.code !== 0 || ch.signal !== null
  const beforeRecover = byCrid(root, crid)
  const s = await openStore({ root, actor: 's1a-crash' })
  // 进程被杀 = 锁留在盘上。规则是“未经授权不得自动接管”，所以这里显式接管再恢复。
  let tookOver = null
  try { tookOver = s.takeOverStaleLock({ authorized: true, reason: 'crashed at ' + point, by: 's1a-test' }) } catch (e) { tookOver = { error: e.code } }
  let rec = null, err = null
  try { rec = await s.recover({ authorized: true, reason: 'after crash at ' + point }) } catch (e) { err = e }
  const j = byCrid(root, crid)
  const named1 = named(root, 'crash-' + point)
  const logs = logFiles(root).length
  const dup = named1.length
  const expectNothingApplied = point === 'prepared'
  const stateOk = j && (j.state === 'COMMITTED' || j.state === 'FAILED_RETRYABLE' || j.state === 'FAILED_ARBITRATION' || j.state === 'ROLLED_BACK')
  push('C-' + point + '-takeover', tookOver && (tookOver.takenOver === true || tookOver.reason === 'no-lock'), '崩溃遗留的锁被显式接管（' + JSON.stringify(tookOver && (tookOver.takenOver ?? tookOver.reason ?? tookOver.error)) + '）')
  push('C-' + point + '-killed', killed, '子进程被真实终止（code=' + ch.code + ' signal=' + ch.signal + '）')
  push('C-' + point + '-state', stateOk, '恢复后 journal 状态确定（' + (j && j.state) + '，崩溃前状态 ' + (beforeRecover && beforeRecover.state) + '）')
  push('C-' + point + '-nodupe', dup <= 1, '无重复业务记录（同名记录数 ' + dup + '）')
  const expectLogs = expectNothingApplied ? 0 : 1
  push('C-' + point + '-audit', logs === expectLogs, 'changelog 条数符合语义（期望 ' + expectLogs + '，实际 ' + logs + '）')
  const replay = await s.createProject({ name: 'crash-' + point, objective: 'crash case', next_action: 'finish the test', client_request_id: crid })
  const named2 = named(root, 'crash-' + point)
  const expectReplay = !expectNothingApplied
  push('C-' + point + '-replay', replay.replayed === expectReplay && named2.length === 1 && (expectReplay ? named2[0].id === named1[0].id : true),
    '同 crid 重试语义正确（期望 replayed=' + expectReplay + '，实际 ' + replay.replayed + '；记录数 ' + named2.length + '）')
  await s.close()
}

// 恢复过程中再次崩溃（第 7/8 个边界）
for (const point of ['recovery-before-write', 'recovery-after-write']) {
  const root = join(ROOT, 'crash-' + point)
  await clean(root)
  const crid = 'crid-' + point
  await runChild('__create', [root, crid, 'crash-' + point], { env: { S1A_CRASH_AT: 'record-written' } })
  const ch = await runChild('__recover', [root], { env: { S1A_CRASH_AT: point } })
  const s = await openStore({ root, actor: 's1a-crash2' })
  // 恢复执行器被杀同样留下锁：显式接管，绝不自动抢
  try { s.takeOverStaleLock({ authorized: true, reason: 'recovery executor crashed', by: 's1a-test' }) } catch {}
  let err = null; try { await s.recover({ authorized: true, reason: 'second recovery' }) } catch (e) { err = e }
  const j = byCrid(root, crid);
  const n = named(root, 'crash-' + point).length
  const logs = logFiles(root).length
  push('C-' + point, !err && j && j.state === 'COMMITTED' && n === 1 && logs === 1,
    '恢复执行器自身崩溃后可再次恢复收敛（state=' + (j && j.state) + ' records=' + n + ' logs=' + logs + '）')
  await s.close()
}

// ============ L：锁 ============
{
  const root = join(ROOT, 'lock-held'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' }); await seed.close()
  process.env.S1A_LOCK_TIMEOUT_MS = '800'
  const child = spawn(process.execPath, [SELF, '__hold', root, '4000'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let locked = ''
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => { locked += d; if (locked.includes('LOCKED')) resolve() })
    setTimeout(resolve, 4000)
  })
  const s = await openStore({ root, actor: 'contender' })
  let e = null
  const t0 = Date.now()
  try { await s.createProject({ name: 'blocked', objective: 'o', next_action: 'should fail', client_request_id: 'crid-blocked' }) } catch (x) { e = x }
  const waited = Date.now() - t0
  push('L1', e && e.code === 'LOCK_HELD', '别人持锁时写入被拒 LOCK_HELD（等了 ' + waited + 'ms，' + (e && e.code) + '）')
  delete process.env.S1A_LOCK_TIMEOUT_MS
  await s.close()
  await new Promise((r) => { child.on('exit', r); try { child.kill('SIGKILL') } catch {} })
}
{
  const root = join(ROOT, 'lock-stale'); await clean(root)
  process.env.S1A_LOCK_STALE_MS = '1500'
  process.env.S1A_LOCK_TIMEOUT_MS = '600'
  const seed = await openStore({ root, actor: 'seed' }); await seed.close()
  const child = spawn(process.execPath, [SELF, '__hold', root, '30000'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let locked = ''
  await new Promise((resolve) => { child.stdout.on('data', (d) => { locked += d; if (locked.includes('LOCKED')) resolve() }); setTimeout(resolve, 4000) })
  try { child.kill('SIGKILL') } catch {}
  await new Promise((r) => child.on('exit', r));
  await sleep(1200)
  const s = await openStore({ root, actor: 'survivor' })
  let e1 = null
  try { await s.createProject({ name: 'stale-a', objective: 'o', next_action: 'try it now', client_request_id: 'crid-stale-a' }) } catch (x) { e1 = x }
  const staleSeen = e1 && (e1.code === 'LOCK_STALE' || e1.code === 'LOCK_METADATA_UNREADABLE')
  let e2 = null
  try { await s.createProject({ name: 'stale-b', objective: 'o', next_action: 'try it now', client_request_id: 'crid-stale-b' }) } catch (x) { e2 = x }
  push('L2', staleSeen && e2 && (e2.code === 'LOCK_STALE' || e2.code === 'LOCK_HELD'), '持锁进程被杀 → 不自动接管，重复被拒（' + (e1 && e1.code) + ' / ' + (e2 && e2.code) + '）')
  const tk = s.takeOverStaleLock({ authorized: true, reason: 'holder pid was killed in test', by: 's1a-test' })
  const after = await s.createProject({ name: 'stale-c', objective: 'o', next_action: 'try it now', client_request_id: 'crid-stale-c' })
  delete process.env.S1A_LOCK_STALE_MS
  delete process.env.S1A_LOCK_TIMEOUT_MS
  push('L3', tk.takenOver === true && after.project.id, '显式接管（authorized+reason）后写入成功，接管留审计');
  let e4 = null
  try { s.takeOverStaleLock({ reason: 'x' }) } catch (x) { e4 = x }
  push('L4', e4 && e4.code === 'LOCK_TAKEOVER_UNAUTHORIZED', '未授权接管被拒（' + (e4 && e4.code) + '）')
  await s.close()
}
{
  const root = join(ROOT, 'lock-corrupt'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' }); await seed.close()
  const jd = join(root, 'project', '_journal')
  await mkdir(jd, { recursive: true })
  await writeFile(join(jd, 'domain.lock'), '{ not json', 'utf8')
  const old = new Date(Date.now() - 60000)
  const { utimes } = await import('node:fs/promises')
  await utimes(join(jd, 'domain.lock'), old, old)
  const s = await openStore({ root, actor: 'probe' })
  let e = null
  try { await s.createProject({ name: 'corrupt', objective: 'o', next_action: 'try it now', client_request_id: 'crid-corrupt' }) } catch (x) { e = x }
  push('L5', e && e.code === 'LOCK_METADATA_UNREADABLE', '锁元数据不可读 → 拒绝自动接管（' + (e && e.code) + '）')
  await s.close()
}
{
  const root = join(ROOT, 'lock-compete'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' }); await seed.close()
  const [a, b] = await Promise.all([
    runChild('__compete', [root, 'A'], { timeoutMs: 60000 }),
    runChild('__compete', [root, 'B'], { timeoutMs: 60000 }),
  ]);
  const parse = (o) => { const m = /RESULT (\{.*\})/.exec(o); return m ? JSON.parse(m[1]) : null }
  const ra = parse(a.so), rb = parse(b.so);
  const total = projFiles(root).length
  const committed = journals(root).filter((j) => j.state === 'COMMITTED').length
  push('L6', ra && rb && ra.ok === 8 && rb.ok === 8 && total === 16 && committed === 16,
    '两进程各写 8 条全部成功、无丢失无重复（ok=' + (ra && ra.ok) + '/' + (rb && rb.ok) + ' files=' + total + ' committed=' + committed + '）')
}

// ============ V：读可见性 ============
{
  const root = join(ROOT, 'vis'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' })
  const p = await seed.createProject({ name: 'vis-base', objective: 'o', next_action: 'stay active', client_request_id: 'crid-vis-base' })
  await seed.close()
  const marker = join(root, 'paused.marker'); const release = join(root, 'paused.release')
  const child = spawn(process.execPath, [SELF, '__create', root, 'crid-vis-new', 'vis-new'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, S1A_PAUSE_AT: 'record-written', S1A_PAUSE_MARKER: marker, S1A_PAUSE_RELEASE: release },
  });
  let seen = false
  for (let i = 0; i < 100; i++) { if (existsSync(marker)) { seen = true; break } await sleep(100) }
  const reader = await openStore({ root, actor: 'reader' })
  const during = reader.projects().map((x) => x.name)
  const onDisk = named(root, 'vis-new').length
  push('V1', seen && onDisk === 1 && !during.includes('vis-new'),
    'APPLYING 期间：磁盘已有记录，读接口看不到（disk=' + onDisk + ' visible=' + during.includes('vis-new') + '）')
  await reader.close()
  await writeFile(release, 'go', 'utf8')
  await new Promise((r) => child.on('exit', r))
  const after = await openStore({ root, actor: 'reader2' })
  push('V2', after.projects().some((x) => x.name === 'vis-new'), 'COMMITTED 后立即可见（after 状态）')
  const jv = byCrid(root, 'crid-vis-new');
  push('V3', jv && jv.state === 'COMMITTED', 'journal 收尾为 COMMITTED（' + (jv && jv.state) + '）')
  await after.close()
}
{
  const root = join(ROOT, 'vis-mod'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' })
  const p = await seed.createProject({ name: 'vis-mod', objective: 'o', next_action: 'stay active', client_request_id: 'crid-vis-mod' })
  await seed.close()
  const marker = join(root, 'm2'); const release = join(root, 'r2')
  const child = spawn(process.execPath, [SELF, '__archive', root, p.project.id, 'crid-vis-arch'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, S1A_PAUSE_AT: 'record-written', S1A_PAUSE_MARKER: marker, S1A_PAUSE_RELEASE: release },
  });
  let seen = false
  for (let i = 0; i < 100; i++) { if (existsSync(marker)) { seen = true; break } await sleep(100) }
  const reader = await openStore({ root, actor: 'reader' })
  const r = reader.project(p.project.id);
  push('V4', seen && r && r.status === 'active', 'APPLYING 期间改已有记录：读到 before 快照（status=' + (r && r.status) + '）')
  await reader.close()
  await writeFile(release, 'go', 'utf8')
  await new Promise((res) => child.on('exit', res))
  const after = await openStore({ root, actor: 'reader2' })
  push('V5', after.project(p.project.id).status === 'archived', 'COMMITTED 后读到 after（archived）')
  await after.close()
}

// ============ R：只读打开 ============
{
  const root = join(ROOT, 'ro'); await clean(root)
  const seed = await openStore({ root, actor: 'seed' })
  await seed.createProject({ name: 'ro-a', objective: 'o', next_action: 'stay put', client_request_id: 'crid-ro' })
  await seed.close()
  const before = await snapshotTree(join(root, 'project'))
  const ro = await openStore({ root, mode: 'read' })
  const cnt = ro.projects().length;
  await ro.close()
  const after = await snapshotTree(join(root, 'project'))
  push('R1', diffSnapshot(before, after).length === 0 && cnt === 1, '只读打开前后整域哈希完全一致（读 ' + cnt + ' 条）')
  let e2 = null
  const missing = join(ROOT, 'ro-missing')
  try { await openStore({ root: missing, mode: 'read' }) } catch (x) { e2 = x }
  push('R2', e2 && e2.code === 'STORE_NOT_FOUND' && !existsSync(join(missing, 'project')), '目录缺失时只读打开报错且不建目录')
  const ro2 = await openStore({ root, mode: 'read' })
  let e3 = null
  try { await ro2.createProject({ name: 'x', objective: 'o', next_action: 'nope' }) } catch (x) { e3 = x }
  push('R3', e3 && e3.code === 'READONLY_MODE', '只读实例拒绝写（' + (e3 && e3.code) + '）')
  await ro2.close()
}

// ============ I：主会话身份 ============
{
  const root = join(ROOT, 'id'); await clean(root)
  const setup = await openStore({ root, actor: 'setup' })
  const a = await setup.createProject({ name: 'id-a', objective: 'o', next_action: 'authoritative', manual: { authorized: true, by: 's1a-test', reason: 'setup fixture' } })
  await setup.linkSession({ project_id: a.project.id, session_id: SID(1), role: 'primary', basis: 'fixture' });
  await setup.linkSession({ project_id: a.project.id, session_id: SID(2), role: 'supporting', basis: 'fixture' });
  await setup.close()
  const s = await openStore({ root, actor: 'id', enforceIdentity: true })
  let e1 = null
  try { await s.archiveProject(a.project.id, { client_request_id: 'crid-id-nosession' }) } catch (x) { e1 = x }
  push('I1', e1 && e1.code === 'IDENTITY_UNAVAILABLE', '拿不到宿主身份 → fail-closed（' + (e1 && e1.code) + '）')
  await s.close()
  const s2 = await openStore({ root, actor: 'id2', sessionId: SID(1), enforceIdentity: true })
  let e2 = null
  try { await s2.archiveProject(a.project.id, { client_request_id: 'crid-id-spoof', actor: 'someone-else' }) } catch (x) { e2 = x }
  push('I2', e2 && e2.code === 'ACTOR_SPOOF_REJECTED', '参数里自报 actor → 拒绝（' + (e2 && e2.code) + '）')
  const ok = await s2.archiveProject(a.project.id, { client_request_id: 'crid-id-primary' })
  push('I3', ok && ok.status === 'archived', 'primary 会话可以写权威状态（status=' + (ok && ok.status) + '）')
  await s2.close()
  const s3 = await openStore({ root, actor: 'id3', sessionId: SID(2), enforceIdentity: true })
  let e4 = null
  try { await s3.restoreProject(a.project.id, { client_request_id: 'crid-id-branch' }) } catch (x) { e4 = x }
  push('I4', e4 && e4.code === 'NOT_PRIMARY', '分支会话不能覆盖权威状态（' + (e4 && e4.code) + '）')
  await s3.close()
  const s4 = await openStore({ root, actor: 'id4', sessionId: SID(9), enforceIdentity: true })
  let e5 = null
  try { await s4.restoreProject(a.project.id, { client_request_id: 'crid-id-stranger' }) } catch (x) { e5 = x }
  push('I5', e5 && e5.code === 'NOT_PRIMARY', '未关联会话（unconfirmed）不能写（' + (e5 && e5.code) + '）')
  let e6 = null
  try { await s4.restoreProject(a.project.id, { client_request_id: 'crid-id-manual-bad', manual: { authorized: true } }) } catch (x) { e6 = x }
  push('I6', e6 && e6.code === 'MANUAL_AUTH_INCOMPLETE', '人工授权缺 by/reason → 拒绝（' + (e6 && e6.code) + '）')
  const m = await s4.restoreProject(a.project.id, { client_request_id: 'crid-id-manual-ok', manual: { authorized: true, by: 'user', reason: 'manual repair' } })
  push('I7', m && m.status === 'active' && s4.lastAuthorization && s4.lastAuthorization.mode === 'manual',
    '人工路径需 by+reason，且记录授权来源（mode=' + (s4.lastAuthorization && s4.lastAuthorization.mode) + '）')
  await s4.close()
  // I8：宿主真实形状 exec.agent.session.id（依据 app.asar 内 run_code 的用法）
  const { resolveHostSessionId } = await import('../core/identity.mjs')
  const nested = resolveHostSessionId({ agent: { session: { id: SID(1) } } })
  const flatOld = resolveHostSessionId({ agent: { sessionId: SID(1) } })
  const missing = resolveHostSessionId({ agent: { session: {} } })
  const noAgent = resolveHostSessionId({})
  push('I8', nested === SID(1) && flatOld === SID(1) && missing === null && noAgent === null,
    '身份解析认 exec.agent.session.id（宿主实际形状），拿不到就返回 null（' + String(nested).slice(0, 16) + '…）')
}

// ============ B：回滚边界 ============
{
  const root = join(ROOT, 'rb'); await clean(root)
  const s = await openStore({ root, actor: 'rb' })
  const r = await s.createProject({ name: 'rb-a', objective: 'o', next_action: 'keep it', client_request_id: 'crid-rb' })
  const j = byCrid(root, 'crid-rb');
  const plan = s.rollbackPlan(j.operation_id);
  push('B1', plan.allowed === false && plan.code === 'ROLLBACK_FORBIDDEN', '含 changelog 的操作 → 计划即拒绝无损回滚（' + plan.code + '）')
  let e = null
  try { await s.rollback({ operation_id: j.operation_id, authorized: true, reason: 'try' }) } catch (x) { e = x }
  push('B2', e && e.code === 'ROLLBACK_FORBIDDEN' && e.steps && e.steps.some((x) => x.table === 'changelog'),
    '实跑回滚被拒，并指明不可逆步骤（' + (e && e.code) + '）')
  let e2 = null
  try { await s.rollback({ operation_id: j.operation_id }) } catch (x) { e2 = x }
  push('B3', e2 && e2.code === 'ROLLBACK_UNAUTHORIZED', '无授权回滚被拒（' + (e2 && e2.code) + '）')
  await s.close()
}
// 不可逆标记与业务写同源：崩溃在“changelog 已写、completed_steps 未写”时标记必须已在盘上
{
  const root = join(ROOT, 'rb-window'); await clean(root)
  const ch = await runChild('__create', [root, 'crid-rb-window', 'rb-window'], { env: { S1A_CRASH_AT: 'record-written-changelog' } });
  const logs = logFiles(root).length;
  const j = byCrid(root, 'crid-rb-window');
  const marked = j && (j.steps || []).some((x) => x.table === 'changelog' && x.irreversible === true);
  push('B4', logs === 1 && marked, '业务不可逆写已落盘时，不可逆标记必然已落盘（logs=' + logs + ' marked=' + marked + '）')
  const s = await openStore({ root, actor: 'rb2' });
  try { s.takeOverStaleLock({ authorized: true, reason: 'crashed writer', by: 's1a-test' }) } catch {}
  await s.recover({ authorized: true, reason: 'converge' });
  const j2 = byCrid(root, 'crid-rb-window');
  push('B5', j2 && j2.state === 'COMMITTED', '崩溃后的分区可向前收敛（' + (j2 && j2.state) + '）')
  await s.close()
}
// 低层可逆回滚（域层禁止物理删，因此只验证“恢复到 before 快照”这条机械路径）
{
  const root = join(ROOT, 'rb-low'); await clean(root)
  const jr = createJournal({ root });
  jr.ensureDirs()
  const store = new Map([['k1', { id: 'k1', v: 1 }]]);
  const writer = {
    readStep: (s) => store.get(s.key) || null,
    writeStep: async (s) => { store.set(s.key, s.after) },
  };
  const begun = await jr.begin({ client_request_id: 'crid-low', fingerprint: 'fp-low', op: 'lowlevel' });
  const j = begun.journal;
  j.state = 'APPLYING';
  j.steps.push({ kind: 'record', table: 'project', key: 'k1', before_exists: true, before: { id: 'k1', v: 1 }, after: { id: 'k1', v: 2 } });
  store.set('k1', { id: 'k1', v: 2 });
  j.state = 'COMMITTED';
  jr.writeJsonAtomic(jr.opPath(j), j);
  const rb = await jr.rollbackOp(jr.findJournal(j.operation_id), writer, { authorized: true, reason: 'unit drill', actor: 's1a' });
  push('B6', rb.state === 'ROLLED_BACK' && store.get('k1').v === 1, '低层可逆回滚真的把 before 写回去了（v=' + store.get('k1').v + '）')
}


// ============ S：R-04（rev 语义 / strictRev） ============
{
  const root = join(ROOT, 'strict'); await clean(root)
  const s = await openStore({ root, actor: 'strict' })
  const a = await s.createProject({ name: 'strict-a', objective: 'o', next_action: 'archive me', client_request_id: 'crid-strict-a' })
  await s.linkSession({ project_id: a.project.id, session_id: SID(3), role: 'primary', basis: 'fixture' })
  const first = await s.archiveProject(a.project.id, { client_request_id: 'crid-arch-1' })
  // 只比业务表：带 crid 的幂等记录必须留在盘上，所以排除 _journal
  const snapNoJournal = async (r) => { const all = await snapshotTree(join(r, 'project')); const out = {}; for (const k of Object.keys(all)) if (!k.startsWith('_journal')) out[k] = all[k]; return out }
  const snapMid = await snapNoJournal(root)
  const second = await s.archiveProject(a.project.id, { client_request_id: 'crid-arch-2' })
  const snapEnd = await snapNoJournal(root)
  push('S1', first.status === 'archived' && second.status === 'archived' && second.changed === false && second.rev === first.rev,
    '重复归档幂等：changed=false 且 rev 不再上推（rev=' + second.rev + '）')
  push('S2', diffSnapshot(snapMid, snapEnd).length === 0, '重复归档对业务表零写盘（_journal 幂等记录除外）')
  await s.close()

  const st = await openStore({ root, actor: 'strict2', strictRev: true })
  let e1 = null
  try { await st.restoreProject(a.project.id, { client_request_id: 'crid-strict-norev' }) } catch (x) { e1 = x }
  push('S3', e1 && e1.code === 'EXPECTED_REV_REQUIRED' && typeof e1.actual_rev === 'number',
    'strictRev：状态迁移不带 rev → EXPECTED_REV_REQUIRED 并回传 actual_rev（' + (e1 && e1.actual_rev) + '）')
  const got = await st.project(a.project.id)
  const okRestore = await st.restoreProject(a.project.id, { expected_rev: got.rev, client_request_id: 'crid-strict-ok' })
  push('S4', okRestore.status === 'active' && okRestore.rev === got.rev + 1, 'strictRev：带正确 rev → 成功且 rev+1')
  let e2 = null
  try { await st.unlinkSession({ project_id: a.project.id, session_id: SID(3), client_request_id: 'crid-strict-unlink' }) } catch (x) { e2 = x }
  push('S5', e2 && e2.code === 'EXPECTED_REV_REQUIRED', 'strictRev：unlinkSession 不带 rev 同样被拒（' + (e2 && e2.code) + '）')
  let e3 = null
  try { await st.archiveProject(a.project.id, { expected_rev: 1, client_request_id: 'crid-strict-stale' }) } catch (x) { e3 = x }
  push('S6', e3 && e3.code === 'REV_CONFLICT', 'strictRev：带过期 rev → REV_CONFLICT（不会被静默覆盖）')
  await st.close()
}


// ============ P：身份走**真实插件写入路径**（agent-tools → store） ============
{
  const { registerAgentTools } = await import('../core/agent-tools.mjs')
  const { createReadService } = await import('../core/read.mjs').catch(() => ({}))
  const readMod = await import('../core/read.mjs')
  const makeSvc = readMod.createReadService || readMod.default || ((s) => readMod.readService ? readMod.readService(s) : null)

  const root = join(ROOT, 'plugin-path'); await clean(root)
  // 夹具阶段先不强制身份；工具阶段换一个 enforceIdentity 的实例
  const seed = await openStore({ root, actor: 'plugin-seed' })
  const A = await seed.createProject({ name: 'pp-a', objective: 'o', next_action: 'stay alive', client_request_id: 'crid-pp-a' })
  await seed.linkSession({ project_id: A.project.id, session_id: SID(1), role: 'primary', basis: 'fixture' })
  await seed.linkSession({ project_id: A.project.id, session_id: SID(2), role: 'supporting', basis: 'fixture' })
  await seed.close()
  const store = await openStore({ root, actor: 'plugin', enforceIdentity: true })

  const captured = []
  const tools = { register: (spec) => { captured.push(spec); return () => {} } }
  const evidence = () => {}
  const deps = { defineTool: (x) => x, getStore: async () => store, readService: (s, o) => {
    const svc = typeof readMod.readService === 'function' ? readMod.readService(s, o) : null
    return svc || svc
  }, evidence, tools }
  const dispose = registerAgentTools({ tools }, deps)
  const byName = (n) => captured.find((x) => x.name === n)
  const execOf = (sid) => (sid ? { agent: { session: { id: sid } } } : {})
  const callTool = async (name, args, exec) => {
    try { return await byName(name).execute(args, exec) } catch (e) { return { ok: false, error: e.code || 'THROWN', message: String(e.message) } }
  }

  // P1 正常 primary：link 自己的会话 → 允许（幂等，changed=false）
  const r1 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture' }, execOf(SID(1)))
  push('P1', r1.ok === true, 'primary 宿主身份：写入被允许（ok=' + r1.ok + '）')

  // P2 supporting：拒绝
  const r2 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture' }, execOf(SID(2)))
  push('P2', r2.ok === false && r2.error === 'NOT_PRIMARY', 'supporting 宿主身份：拒绝（' + r2.error + '）')

  // P3 未关联：拒绝
  const r3 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture' }, execOf(SID(9)))
  push('P3', r3.ok === false && r3.error === 'NOT_PRIMARY', '未关联宿主身份：拒绝（' + r3.error + '）')

  // P4 没有宿主身份：fail-closed
  const r4 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture' }, {})
  push('P4', r4.ok === false && r4.error === 'IDENTITY_UNAVAILABLE', '没有宿主 exec.agent：fail-closed（' + r4.error + '）')

  // P5 参数伪造 __identity 指向 primary，调用方是 supporting → 必须仍被拒
  const r5 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture', __identity: { session_id: SID(1) } }, execOf(SID(2)))
  push('P5', r5.ok === false && r5.error === 'ACTOR_SPOOF_REJECTED', '参数伪造 __identity 被拒（' + r5.error + '）')

  // P6 参数伪造 actor
  const r6 = await callTool('project_link_session', { project_id: A.project.id, basis: 'fixture', actor: 'boss' }, execOf(SID(1)))
  push('P6', r6.ok === false && r6.error === 'ACTOR_SPOOF_REJECTED', '参数伪造 actor 被拒（' + r6.error + '）')

  // P7 参数把 session_id 指向 primary，但调用方是 supporting → 仍拒
  const r7 = await callTool('project_link_session', { project_id: A.project.id, session_id: SID(1), basis: 'fixture', role: 'primary' }, execOf(SID(2)))
  push('P7', r7.ok === false && r7.error === 'NOT_PRIMARY', '参数把目标 session 指向 primary 也不能冒充身份（' + r7.error + '）')

  // P8 建项目：primary 宿主身份成功
  const r8 = await callTool('project_create', { name: 'pp-new', objective: 'o', next_action: '写一个能跑的东西' }, execOf(SID(1)))
  push('P8', r8.ok === true && r8.project && r8.project.id, '建项目走宿主身份（' + (r8.project && r8.project.id) + '）')

  const d2 = dispose(); void d2
  void makeSvc; void createReadService
  await store.close()
}

// ============ 汇总 ============
const pass = steps.filter((s) => s.ok).length
const fail = steps.length - pass
const result = {
  at: new Date().toISOString(), total: steps.length, pass, fail,
  verdict: fail === 0 ? 'PASS' : 'FAIL',
  groups: steps.reduce((m, s) => { const g = String(s.id).split('-')[0]; m[g] = m[g] || { pass: 0, fail: 0 }; s.ok ? m[g].pass++ : m[g].fail++; return m }, {}),
  steps,
}
await mkdir(join(OUT, '..'), { recursive: true })
await writeFile(OUT, JSON.stringify(result, null, 1), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + result.verdict)
