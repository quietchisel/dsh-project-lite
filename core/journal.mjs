/**
 * core/journal.mjs —— S1-A 操作日志（Operation Journal）原型
 *
 * 目标（只承诺做到这些，不吹 ACID）：
 *   1. 一次业务写 = 一条 journal 记录 + 若干 step；step 先落盘再写业务记录。
 *   2. 崩溃后恢复：已记录但未写的 step 可安全前滚；业务记录与 journal 矛盾时进人工裁决。
 *   3. 读可见性：per-record committed visibility —— APPLYING 期间读到 before 或隐藏新建记录。
 *   4. 跨进程互斥：<unit>/_journal/domain.lock（wx + 心跳 + 显式接管）。
 *
 * 明确不保证：跨表快照隔离、断电安全（只覆盖进程崩溃/异常退出）、网络文件系统。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { crashPoint } from './fault.mjs'

export const STATES = Object.freeze({
  PREPARED: 'PREPARED',
  APPLYING: 'APPLYING',
  COMMITTED: 'COMMITTED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_ARBITRATION: 'FAILED_ARBITRATION',
})

const ALIVE = new Set([STATES.PREPARED, STATES.APPLYING])

export class JournalError extends Error {
  constructor(code, message, extra = {}) {
    super(message); this.name = 'JournalError'; this.code = code; Object.assign(this, extra)
  }
}

/** 稳定序列化：对象键排序，用于比较 before/after 与计算指纹。 */
export function canon(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

export function fingerprintOf(op, args) {
  return createHash('sha256').update(canon({ op, args: args ?? null })).digest('hex')
}

function newOperationId() {
  const t = Date.now().toString(36)
  return 'op_' + t + '_' + randomBytes(8).toString('hex')
}

function fsyncPath(p) {
  try { const fd = openSync(p, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) } } catch {}
}

function writeJsonAtomic(path, obj) {
  const tmp = path + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex')
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, JSON.stringify(obj, null, 1), 'utf8')
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(tmp, path)
  fsyncPath(path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 进程内互斥：按 unit 目录规范化路径排队，跨 Store 实例共享同一队列。 */
const processQueues = new Map()
async function inProcessLock(key, fn) {
  const prev = processQueues.get(key) || Promise.resolve()
  let release
  const gate = new Promise((r) => { release = r })
  processQueues.set(key, prev.then(() => gate))
  await prev.catch(() => {})
  try { return await fn() } finally { release(); if (processQueues.get(key) === gate) processQueues.delete(key) }
}

export function createJournal({ root, unitName = 'project', staleMs, lockTimeoutMs } = {}) {
  // 测试旋钮：只影响等待时长，不改变语义。
  // 等锁默认 15s（原来是 5s）：实测在机器负载高时，16 次连续写（每次含 fsync）会超过 5s，
  // 导致并发测试出现 7/8 的偶发失败。等锁超时不是安全边界，放长只会让“排队”更耐心。
  staleMs = staleMs ?? Number(process.env.S1A_LOCK_STALE_MS || 10000)
  lockTimeoutMs = lockTimeoutMs ?? Number(process.env.S1A_LOCK_TIMEOUT_MS || 15000)
  const unitDir = join(root, unitName)
  const dir = join(unitDir, '_journal')
  const opsDir = join(dir, 'ops')
  const lockPath = join(dir, 'domain.lock')
  const auditPath = join(dir, 'lock-audit.log')

  function ensureDirs() { mkdirSync(opsDir, { recursive: true }) }

  function opPath(j) {
    if (j.client_request_id) return join(opsDir, 'idem_' + createHash('sha256').update(String(j.client_request_id)).digest('hex') + '.json')
    return join(opsDir, 'op_' + j.operation_id + '.json')
  }

  function readLock() {
    if (!existsSync(lockPath)) return null
    const meta = readJson(lockPath)
    let mtimeMs = null
    try { mtimeMs = statSync(lockPath).mtimeMs } catch {}
    return { meta, mtimeMs, raw: existsSync(lockPath) }
  }

  function holderInfo() {
    const cur = readLock()
    if (!cur) return null
    if (!cur.meta) return { corrupt: true, ageMs: cur.mtimeMs ? Date.now() - cur.mtimeMs : null }
    const hb = Date.parse(cur.meta.heartbeat_at || cur.meta.created_at || '')
    return {
      pid: cur.meta.pid, host: cur.meta.host, domain: cur.meta.domain, token: cur.meta.token,
      created_at: cur.meta.created_at, heartbeat_at: cur.meta.heartbeat_at,
      heartbeatAgeMs: Number.isFinite(hb) ? Date.now() - hb : null,
      pidAlive: pidAlive(cur.meta.pid),
    }
  }

  function isStale() {
    const h = holderInfo()
    if (!h) return false
    if (h.corrupt) return true
    if (h.heartbeatAgeMs === null) return true
    return h.heartbeatAgeMs > staleMs
  }

  async function acquire() {
    ensureDirs()
    return inProcessLock(unitDir, async () => {
      const token = randomBytes(12).toString('hex')
      const meta = {
        pid: process.pid, host: hostname(), domain: unitDir, token,
        proc_start_epoch: Math.round(Date.now() - process.uptime() * 1000),
        created_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
        kind: 'domain-lock', schema: 1,
      }
      const deadline = Date.now() + lockTimeoutMs
      for (;;) {
        try {
          const fd = openSync(lockPath, 'wx')
          try { writeFileSync(fd, JSON.stringify(meta, null, 1), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
          break
        } catch (e) {
          if (e.code !== 'EEXIST') throw e
          const h = holderInfo()
          if (h && h.corrupt) {
            const age = h.ageMs ?? 0
            if (age > 2000) throw new JournalError('LOCK_METADATA_UNREADABLE', '锁文件存在但元数据不可读（可能上次创建中断），需显式接管', { holder: h })
          } else if (isStale()) {
            throw new JournalError('LOCK_STALE', '锁已过期（心跳超时），必须显式接管后才可继续', { holder: h, stale_ms: staleMs })
          }
          if (Date.now() > deadline) throw new JournalError('LOCK_HELD', '等待域锁超时', { holder: h })
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      const heartbeat = setInterval(() => {
        try {
          const cur = readJson(lockPath)
          if (cur && cur.token === token) { cur.heartbeat_at = new Date().toISOString(); writeJsonAtomic(lockPath, cur) }
        } catch {}
      }, Math.max(200, Math.floor(staleMs / 3)))
      heartbeat.unref?.()
      return {
        token,
        release() {
          clearInterval(heartbeat)
          try { const cur = readJson(lockPath); if (cur && cur.token === token) unlinkSync(lockPath) } catch {}
        },
      }
    })
  }

  /** 显式接管过期锁：必须传 authorized + reason，写审计。绝不自动接管。 */
  function recoverStaleLock({ authorized, reason, actor } = {}) {
    if (authorized !== true) throw new JournalError('LOCK_TAKEOVER_UNAUTHORIZED', '接管过期锁必须显式 authorized:true 并说明 reason')
    if (!reason || !String(reason).trim()) throw new JournalError('LOCK_TAKEOVER_UNAUTHORIZED', '接管过期锁必须提供 reason');
    ensureDirs()
    const h = holderInfo()
    if (!existsSync(lockPath)) return { takenOver: false, reason: 'no-lock' }
    const archived = lockPath + '.stale.' + Date.now()
    renameSync(lockPath, archived)
    const line = JSON.stringify({ at: new Date().toISOString(), action: 'stale-lock-takeover', actor: actor ?? null, reason, holder: h, archived }) + '\n'
    try { writeFileSync(auditPath, line, { flag: 'a' }) } catch {}
    return { takenOver: true, archived, holder: h }
  }

  function listJournals() {
    if (!existsSync(opsDir)) return []
    return readdirSync(opsDir).filter((n) => n.endsWith('.json')).map((n) => readJson(join(opsDir, n))).filter(Boolean)
  }

  function readJournalByCrid(crid) {
    const p = join(opsDir, 'idem_' + createHash('sha256').update(String(crid)).digest('hex') + '.json')
    return readJson(p)
  }

  /** 读可见性索引：key = kind:table:key -> step */
  function pendingIndex() {
    const idx = new Map()
    for (const j of listJournals()) {
      if (!ALIVE.has(j.state)) continue
      for (const s of j.steps || []) {
        const k = s.kind === 'global' ? 'global::global' : 'record:' + s.table + ':' + s.key
        idx.set(k, { ...s, operation_id: j.operation_id, state: j.state })
      }
    }
    return idx
  }

  async function recoverOne(j, writer) {
    const steps = j.steps || []
    const rec = { at: new Date().toISOString(), from: j.state, actions: [] }
    const verdicts = steps.map((s) => {
      const actual = writer.readStep(s)
      if (actual === undefined || actual === null) return { s, state: s.before_exists ? 'missing-before' : 'absent' }
      if (canon(actual) === canon(s.after)) return { s, state: 'after' }
      if (s.before_exists && canon(actual) === canon(s.before)) return { s, state: 'before' }
      return { s, state: 'conflict' }
    })
    // 一个 step 都没有：这次操作什么都没写下去，不能“前滚成 COMMITTED”（那是凭空造事实），
    // 记为可重试失败，让调用方用同一个 client_request_id 重新执行。
    if (steps.length === 0) {
      j.state = STATES.FAILED_RETRYABLE
      j.error = { code: 'CRASHED_BEFORE_APPLY', message: '进程在业务写入前终止，未产生任何业务事实' }
      j.updated_at = rec.at
      j.recovery = [...(j.recovery || []), { ...rec, actions: ['nothing-to-apply'] }]
      writeJsonAtomic(opPath(j), j)
      return { operation_id: j.operation_id, state: j.state, actions: ['nothing-to-apply'] }
    }

    const conflicts = verdicts.filter((v) => v.state === 'conflict' || v.state === 'missing-before')
    if (conflicts.length > 0) {
      j.state = STATES.FAILED_ARBITRATION
      j.arbitration = { at: rec.at, reason: 'business record diverged from journal', steps: conflicts.map((c) => ({ key: c.s.key, table: c.s.table, state: c.state })) }
      rec.actions.push('arbitration');
    } else if (verdicts.every((v) => v.state === 'after')) {
      j.state = STATES.COMMITTED
      j.result = j.result ?? { recovered: true, operation_id: j.operation_id, result_ref: j.result_ref ?? null }
      rec.actions.push('roll-forward-commit');
    } else {
      for (const v of verdicts) {
        if (v.state === 'before') { await writer.writeStep(v.s); rec.actions.push('reapply:' + v.s.key) }
        if (v.state === 'absent') { await writer.writeStep(v.s); rec.actions.push('apply:' + v.s.key) }
      }
      j.state = STATES.COMMITTED
      j.result = j.result ?? { recovered: true, operation_id: j.operation_id, result_ref: j.result_ref ?? null }
      rec.actions.push('roll-forward-commit');
    }
    j.updated_at = rec.at
    j.recovery = [...(j.recovery || []), rec]
    crashPoint('recovery-before-write')
    writeJsonAtomic(opPath(j), j)
    crashPoint('recovery-after-write')
    return { operation_id: j.operation_id, state: j.state, actions: rec.actions }
  }

  async function recoverAll(writer) {
    const out = []
    for (const j of listJournals()) {
      if (!ALIVE.has(j.state)) continue
      out.push(await recoverOne(j, writer))
    }
    return out
  }

  /**
   * 开始一次操作。同一 client_request_id：
   *   同指纹 + COMMITTED → 重放（零副作用）
   *   同指纹 + 活跃     → 先恢复，再按恢复结果决定重放/重试
   *   不同指纹          → REQUEST_ID_CONFLICT
   *   FAILED_ARBITRATION → 拒绝自动继续，等人工裁决
   */
  async function begin({ client_request_id = null, fingerprint, op, actor = null, session_id = null, writer } = {}) {
    ensureDirs()
    const existing = client_request_id ? readJournalByCrid(client_request_id) : null
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new JournalError('REQUEST_ID_CONFLICT', 'client_request_id 已用于另一个操作（指纹不同），拒绝复用', { client_request_id, operation_id: existing.operation_id })
      }
      if (existing.state === STATES.COMMITTED) return { replayed: true, result: existing.result, journal: existing }
      if (ALIVE.has(existing.state)) {
        await recoverOne(existing, writer)
        const after = readJson(opPath(existing)) || existing
        if (after.state === STATES.COMMITTED) return { replayed: true, result: after.result, journal: after }
        if (after.state === STATES.FAILED_ARBITRATION) {
          throw new JournalError('OPERATION_ARBITRATION_REQUIRED', '上一次操作已进入人工裁决状态，不能自动重试', { operation_id: after.operation_id })
        }
        Object.assign(existing, after)
      }
      if (existing.state === STATES.FAILED_ARBITRATION) {
        throw new JournalError('OPERATION_ARBITRATION_REQUIRED', '上一次操作已进入人工裁决状态，不能自动重试', { operation_id: existing.operation_id })
      }
      existing.state = STATES.PREPARED
      existing.steps = []
      existing.completed_steps = []
      existing.result = null
      existing.result_ref = null
      existing.error = null
      existing.attempt = (existing.attempt || 1) + 1
      existing.updated_at = new Date().toISOString()
      writeJsonAtomic(opPath(existing), existing)
      return { replayed: false, journal: existing }
    }
    const now = new Date().toISOString()
    const j = {
      schema: 1,
      operation_id: newOperationId(),
      client_request_id: client_request_id || null,
      request_fingerprint: fingerprint,
      state: STATES.PREPARED,
      op, actor, session_id,
      created_at: now, updated_at: now, attempt: 1,
      steps: [], completed_steps: [],
      result: null, result_ref: null, error: null, recovery: [],
    }
    writeJsonAtomic(opPath(j), j)
    crashPoint('prepared')
    return { replayed: false, journal: j }
  }

  /**
   * 回滚计划：只允许“技术上可逆”的操作。
   * 判据不是“单据能不能改回去”，而是“这条业务事实是否已经作为证据对外生效”——
   * changelog 是 append-only 审计证据，删掉它等于把回滚本身做成一次无痕篡改。
   */
  function planRollback(j) {
    if (j.state !== STATES.COMMITTED) {
      return { allowed: false, code: 'ROLLBACK_NOT_COMMITTED', reason: '只有 COMMITTED 的操作才谈得上回滚（当前 ' + j.state + '）' }
    }
    const irreversible = (j.steps || []).filter((s) => s.irreversible === true)
    if (irreversible.length > 0) {
      return {
        allowed: false,
        code: 'ROLLBACK_FORBIDDEN',
        reason: '该操作已写入不可逆业务事实（append-only 证据），禁止无损回滚，只能向前修复',
        steps: irreversible.map((s) => ({ table: s.table, key: s.key, why: s.irreversible_reason || 'append-only' })),
      }
    }
    return { allowed: true, plan: [...(j.steps || [])].reverse() }
  }

  /** 真正执行回滚：逆序把 before 写回去。调用方必须已经拿到域锁与授权。 */
  async function rollbackOp(j, writer, { authorized, reason, actor } = {}) {
    if (authorized !== true) throw new JournalError('ROLLBACK_UNAUTHORIZED', '回滚必须显式 authorized:true 并说明 reason')
    if (!reason || !String(reason).trim()) throw new JournalError('ROLLBACK_UNAUTHORIZED', '回滚必须提供 reason')
    const plan = planRollback(j)
    if (!plan.allowed) throw new JournalError(plan.code, plan.reason, { operation_id: j.operation_id, steps: plan.steps })
    const done = []
    for (const s of plan.plan) {
      if (s.before_exists) { await writer.writeStep({ ...s, after: s.before }); done.push('restore:' + s.table + ':' + s.key) }
      else {
        // 回滚“新建”= 软删：域层不支持物理删（错误账本 E-10），所以改写成 unlinked/status 标记不合理时直接报不可逆。
        throw new JournalError('ROLLBACK_FORBIDDEN', '该操作包含“新建记录”，域层禁止物理删除，无法无损回滚', { operation_id: j.operation_id, step: s.key })
      }
    }
    j.state = 'ROLLED_BACK'
    j.rollback = { at: new Date().toISOString(), actor: actor ?? null, reason, actions: done }
    j.updated_at = j.rollback.at
    writeJsonAtomic(opPath(j), j)
    const line = JSON.stringify({ at: j.rollback.at, action: 'rollback', operation_id: j.operation_id, actor: actor ?? null, reason, actions: done }) + '\n'
    try { writeFileSync(join(dir, 'rollback-audit.log'), line, { flag: 'a' }) } catch {}
    return { operation_id: j.operation_id, state: j.state, actions: done }
  }

  function findJournal(operationId) {
    if (!existsSync(opsDir)) return null
    for (const n of readdirSync(opsDir)) {
      if (!n.endsWith('.json')) continue
      const j = readJson(join(opsDir, n))
      if (j && j.operation_id === operationId) return j
    }
    return null
  }

  return {
    dir, opsDir, lockPath, unitDir, planRollback, rollbackOp, findJournal,
    ensureDirs, acquire, recoverStaleLock, holderInfo, isStale, begin, planRollback, rollbackOp, findJournal,
    listJournals, readJournalByCrid, pendingIndex, recoverAll, recoverOne, writeJsonAtomic, readJson, opPath,
    STATES,
  }
}

export default createJournal
