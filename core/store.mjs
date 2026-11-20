/**
 * core/store.mjs — 最小可运行 core（只存储层，不接 UI、不接 Agent）。
 *
 * 对外只暴露"人能点的那几个动作"：建项目 / 挂会话 / 归档 / 对账 / 读。
 * 所有写入口先过完整性闸（guard.writable），降级时抛 READONLY_DEGRADED —— 不是只把按钮藏起来。
 */
import { mkdir } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildSpec, TABLES, VERSION, MetaSchema, initialMeta } from './spec.mjs'
import { scanUnit, evaluate, META_STATE } from './guard.mjs'
import { newProjectId, newDeliverableId, newLogId, newCheckpointId, newReceiptId, newTaskId, linkKey, nowIso, validateNextAction } from './util.mjs'
import { createJournal, fingerprintOf, canon, STATES as JOURNAL_STATES } from './journal.mjs'
import { assertNoSpoofedActor, authorizeWrite, authorizeTaskReceipt, callerContext } from './identity.mjs'
import { crashPoint, pausePoint } from './fault.mjs'
import { validateAttributionTarget } from './attribution.mjs'

/**
 * done_when 归一化：表单只给一个输入框（字符串），schema 要的是 string[]。
 *
 * 不归一化就会把字符串原样落盘 → 下次开库时被域层 backup-and-skip 隔离
 * → 计数对不上基线 → 整库降级只读。2026-11-16 真实发生（错误账本 E-10）。
 */
export function normalizeDoneWhen(v) {
  if (v === undefined || v === null) return undefined
  const list = Array.isArray(v) ? v : String(v).split(/\r?\n/)
  const items = list.map((s) => String(s).trim()).filter((s) => s.length > 0)
  return items.length > 0 ? items : undefined
}

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 返回"那条记录"的形状，另挂不可枚举的 changed 标记（不改老调用方的读法，也不进 JSON）。
 * @param record 域里的记录（或即将返回的副本）
 * @param changed 本次调用是否真的改了数据
 */
function decorateLink(record, changed) {
  const out = { ...record }
  Object.defineProperty(out, 'changed', { value: changed, enumerable: false })
  return out
}

/**
 * @param root 域根目录（= backend 的 storages 根）。**完整性闸要数磁盘，所以即使注入 facility 也必须给**。
 * @param facility 可选：宿主已经开好的 DomainFacility（插件里用 `ctx.storageDomain` 传进来）。
 *   给了就**不再自己 new 后端、也不再 import @deepseek-ai/* 包**——这条是为了让自制插件不依赖
 *   peer 解析（S1.0 遗留问题 B-2），同时避免 close 时把别人的域一起关掉。
 */
export async function openStore({ root, facility: injectedFacility, actor = 's0-harness', writer = 'dsh-project-core@0.1.0-s0', version = VERSION, compatibleVersions, extraProject, mode = 'rw', sessionId = null, enforceIdentity = false, journal: journalEnabled = true, strictRev = false } = {}) {
  // 只读模式：绝不 mkdir、绝不建域、绝不写 global；只读磁盘。T41 用文件哈希前后比对验证。
  if (mode === 'read') {
    return openStoreReadOnly({ root, writer, version, compatibleVersions, extraProject })
  }
  await mkdir(root, { recursive: true })
  const spec = buildSpec({ version, compatibleVersions, writer, extraProject })
  const acceptedVersions = [spec.version, ...(spec.compatibleVersions ?? [])]

  // 打开前先数一遍磁盘：这是唯一能发现"静默消失"的时机（打开后文件已被跳过）。
  // 扫描失败不抛错、也不当成空库：返回 null，交给 guard 判成"核心检查不可用 → 保守降级"。
  const safeScan = async () => {
    try { return await scanUnit(root, { tables: TABLES, acceptedVersions }) } catch { return null }
  }
  let scanBefore = await safeScan()

  // 后端与 facility：优先用宿主注入的（插件路径），否则自己建（独立运行路径）。
  // 动态 import 是刻意的：走注入路径时完全不加载 @deepseek-ai/* 包。
  let backend = null
  let facility = injectedFacility
  if (!facility) {
    const [{ JsonStorageBackend }, { DomainFacility }] = await Promise.all([
      import('@deepseek-ai/dsh-storage-json'),
      import('@deepseek-ai/dsh-storage-domain'),
    ])
    backend = new JsonStorageBackend(root)
    const ctx = {
      storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
      emit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    facility = new DomainFacility(ctx, { backend: 'json' })
  }
  const domain = await facility.open(spec)
  let scanAfter = await safeScan()

  // S1-A：操作日志。所有业务写都走 withOp → journal（PREPARED/APPLYING/COMMITTED）。
  const journal = journalEnabled ? createJournal({ root }) : null
  let currentOp = null

  const meta0 = domain.global.get()
  const expected = meta0.expected_counts ?? null
  let verdict = evaluate({ scanBefore, scanAfter, domain, tables: TABLES, expectedCounts: expected, acceptedVersions })

  // 降级时把"这次看到了什么"记下来（只写 last_degraded_snapshot，绝不碰 expected_counts）。
  // 收紧：只有 meta 本身可信（ok / 全新空库）才允许写。
  // global.json 缺失 / 损坏 / 版本不兼容时，内存里的 meta 是 initial——写下去等于亲手把证据
  // 补成一个正常基线，下次打开就再也看不出"元数据曾经缺失"。
  if (verdict.degraded && verdict.metaSafeToWrite) {
    await domain.global.set({ ...meta0, last_degraded_snapshot: { at: nowIso(), counts: verdict.counts, criteria: verdict.criteria } })
  }

  const store = {
    root, spec, domain, facility,
    get scanBefore() { return scanBefore },
    get scanAfter() { return scanAfter },
    get verdict() { return verdict },
    get writable() { return verdict.writable },
    get metaState() { return verdict.metaState },
    get metaSafeToWrite() { return verdict.metaSafeToWrite },
    get counts() { return verdict.counts },
    refresh,
    /**
     * 降级原因 → 界面契约（core 侧）。
     * 每一种降级都必须给出 kind / title / reason，界面据此显示红条；
     * **不允许出现"降级了但说不出原因"的状态**（那就是把不确定说成确定的反面）。
     */
    degradationReport,
  }

  const assertWritable = () => {
    if (!verdict.writable) {
      throw new StoreError('READONLY_DEGRADED', '域处于只读降级：' + verdict.criteria.map(c => c.code).join(','), { criteria: verdict.criteria })
    }
  }

  /**
   * 写前校验：用**读路径同一份 schema**（spec.tables[t].valueSchema）校验待写记录。
   *
   * 为什么必须有这一层：域层只在 open 时校验磁盘上的记录，put 不校验。
   * 于是"写的时候不合法"要等到下次开库才暴露，代价是那条记录被隔离 + 整库降级只读。
   * 这一层把失败挪到写的那一刻：抛 RECORD_INVALID，一个字节都不落盘。
   */
  function assertRecord(table, record) {
    const schema = spec.tables[table]?.valueSchema
    if (schema === undefined) throw new StoreError('RECORD_INVALID', `表 ${table} 没有声明 schema`)
    const res = schema.safeParse(record)
    if (!res.success) {
      const issues = res.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }))
      throw new StoreError(
        'RECORD_INVALID',
        `${table} 记录未通过 schema 校验：` + issues.map((i) => `${i.path} ${i.message}`).join('；'),
        { issues, table },
      )
    }
    return res.data
  }

  /**
   * 1.8 幂等指纹：同 requestId + 同动作 → 回上次结果（不重复执行）；同 id 不同动作 → 拒。
   *
   * 为什么需要：link 靠确定性键天然幂等，但 create 每点一次就是一个新项目。
   * 界面重复提交、网络重试、agent 重放都会造成两条"看起来一样"的记录。
   *
   * 指纹用动作参数的 canonical JSON 算 sha256：参数改了就说明是另一个意图，必须拒，
   * 不许拿同一个 requestId 覆盖上一次的结果。
   */
  // 审计 A：把「查 → 执行 → 记录」整体串行化。原实现查在锁外、记录在业务写之后，
  // 10 个并发同 requestId 会全部通过首次查询、各自建一条业务事实（实测 10 项目 + 10 changelog）。
  // runExclusive 用与 domain.lock 不同的键，避免与 withOp 内 journal.acquire 自锁。
  async function claimRequest(requestId, actionKey, exec) {
    const claim = async () => {
      const id = String(requestId)
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
        throw new StoreError('INVALID_INPUT', 'requestId 只允许 4-64 位字母数字与 _-')
      }
      const fp = createHash('sha256').update(String(actionKey)).digest('hex').slice(0, 32)
      const cur = meta()
      const list = Array.isArray(cur.recent_requests) ? cur.recent_requests : []
      const hit = list.find((r) => r && r.id === id)
      if (hit) {
        if (hit.fp !== fp) {
          throw new StoreError('REQUEST_ID_CONFLICT', 'requestId ' + id + ' 已用于另一个动作（指纹不同），拒绝复用', { request_id: id })
        }
        return { replayed: true, value: hit.value ?? null }
      }
      const value = await exec()
      const plain = JSON.parse(JSON.stringify(value ?? null))
      const next = [...list.filter((r) => r && r.id !== id), { id, fp, at: nowIso(), value: plain }].slice(-256)
      await patchMeta((m) => ({ ...m, recent_requests: next }))
      return { replayed: false, value }
    }
    if (requestId === undefined || requestId === null || requestId === '') {
      return { replayed: false, value: await exec() }
    }
    // journal 关闭时没有进程锁可用，退回原语义（仍顺序安全）。
    if (!journal || typeof journal.runExclusive !== 'function') return claim()
    return journal.runExclusive(claim)
  }

  /**
   * 重新数磁盘 + 重算判据（必须的）。
   *
   * 为什么：verdict 是"打开那一刻"的快照。插件里的 store 是长期存活的，
   * 它会活过它所验证的那些条件——磁盘上 global.json 被删掉后，内存里仍然是 ok，
   * 于是 reconcile 的元数据写入会把文件重新造出来，等于**用读路径把证据补掉**。
   * （2026-11-14 桌面实测踩到：面板 5 秒一次的对账把删掉的 global.json 又写回来了。）
   *
   * 只读：只重算，不写任何东西。
   */
  async function refresh() {
    scanBefore = await safeScan()
    scanAfter = await safeScan()
    const expectedNow = domain.global.get()?.expected_counts ?? null
    verdict = evaluate({ scanBefore, scanAfter, domain, tables: TABLES, expectedCounts: expectedNow, acceptedVersions })
    return verdict
  }

  /**
   * 把 verdict 翻译成界面能直接渲染的降级契约。
   * kind 只有 5 种 + ok：meta_missing / meta_corrupt / version_incompatible /
   * core_check_unavailable / data_loss。判定优先级：meta 三态最具体 → 检查不可用 → 数据丢失。
   */
  function degradationReport() {
    const codes = verdict.criteria.map(c => c.code)
    if (!verdict.degraded) {
      return {
        degraded: false, writable: true, kind: 'ok', title: '', reason: '',
        evidence: { metaState: verdict.metaState, codes: [] },
        blocks: [], canStill: ['read', 'create_project', 'link_session', 'archive_project', 'reconcile'],
      }
    }
    let kind
    if (verdict.metaState === 'missing_with_data') kind = 'meta_missing'
    else if (verdict.metaState === 'corrupt') kind = 'meta_corrupt'
    else if (verdict.metaState === 'version_incompatible') kind = 'version_incompatible'
    else if (verdict.metaState === 'unavailable' || codes.includes('CORE_CHECK_UNAVAILABLE')) kind = 'core_check_unavailable'
    else kind = 'data_loss'
    const T = {
      meta_missing: [
        '项目数据只读：元数据文件（global.json）缺失',
        '磁盘上有项目记录，但记录版本与基线的元数据文件不见了。这不等于新库——为避免把旧数据当新库覆盖，已进入只读。',
      ],
      meta_corrupt: [
        '项目数据只读：元数据文件损坏',
        'global.json 无法解析。原始文件被保留作为证据，不会被自动修复或覆盖。',
      ],
      version_incompatible: [
        '项目数据只读：数据版本不兼容',
        '数据文件的版本戳不在本插件接受的范围内（通常是插件被降级过）。请升级插件或恢复备份，不要手改版本号。',
      ],
      core_check_unavailable: [
        '项目数据只读：完整性检查无法执行',
        '无法读取项目数据目录，核心完整性判据跑不起来。查不到不等于没问题，因此按最坏情况处理。',
      ],
      data_loss: [
        '项目数据只读：检测到记录丢失或基线回退',
        '磁盘记录数多于内存可读记录数，或计数低于已登记基线。可能有坏记录被静默丢弃。',
      ],
    }
    const [title, reason] = T[kind]
    return {
      degraded: true, writable: false, kind, title, reason,
      evidence: { metaState: verdict.metaState, codes, criteria: verdict.criteria, counts: verdict.counts },
      blocks: ['create_project', 'link_session', 'archive_project'],
      canStill: ['read', 'reconcile'],
    }
  }

  const meta = () => domain.global.get()
  async function patchMeta(fn) {
    const cur = meta()
    const next = fn({ ...cur, prefs: { ...cur.prefs } })
    const parsed = MetaSchema.parse(next)
    await dview.global.set(parsed)
    return parsed
  }

  // ---------- S1-A：写缓冲 + 覆盖读 ----------
  // 一次操作里的所有写先记成 step（含 before/after），跑完再一次性落盘。
  // 这样 journal 里保存的是**完整计划**，恢复时能前滚到终点，而不是只知道“写到哪算哪”。
  let overlay = null // Map<'table:key'| 'global', value>
  const dview = {
    global: {
      get: () => (overlay && overlay.has('global') ? overlay.get('global') : domain.global.get()),
      set: async (v) => {
        // 元数据写也进计划：崩溃后能一并前滚，不会出现“业务写了基线没跟上”。
        if (!currentOp) { await domain.global.set(v); return }
        recordGlobalStep(v)
      },
    },
    table: (tName) => ({
      get: (k) => (overlay && overlay.has(tName + ':' + k) ? overlay.get(tName + ':' + k) : domain.table(tName).get(k)),
      entries: () => {
        if (!overlay) return domain.table(tName).entries()
        const m = new Map(domain.table(tName).entries())
        for (const [k, v] of overlay) { const p = k.split(':'); if (p[0] === tName) m.set(p[1], v) }
        return m.entries()
      },
      get size() {
        if (!overlay) return domain.table(tName).size
        let n = domain.table(tName).size
        for (const k of overlay.keys()) { const p = k.split(':'); if (p[0] === tName && !domain.table(tName).get(p[1])) n++ }
        return n
      },
      put: async (k, v) => { throw new StoreError('USE_PUTJ', '业务写必须走 putJ（直接 put 会绕过 journal）') },
      delete: async () => { throw new StoreError('NO_PHYSICAL_DELETE', '域层禁止物理删除（错误账本 E-10）') },
    }),
  }

  function recordGlobalStep(v) {
    const j = currentOp
    const idx = j.j.steps.findIndex((s) => s.kind === 'global')
    const step = { kind: 'global', table: 'global', key: 'global', before_exists: true, before: j.j.steps[idx]?.before ?? domain.global.get(), after: v }
    if (idx >= 0) j.j.steps[idx] = step; else j.j.steps.push(step)
    overlay.set('global', v)
  }

  // ---------- S1-A 操作日志（Operation Journal） ----------
  const stepIO = {
    readStep(step) {
      if (step.kind === 'global') return domain.global.get()
      const tb = domain.table(step.table)
      if (!tb) return null
      const rec = tb.get(step.key)
      return rec === undefined ? null : rec
    },
    async writeStep(step) {
      // 恢复执行器直接写真域：它不得走 dview/withOp，否则就是递归进 journal。
      if (step.kind === 'global') { await domain.global.set(MetaSchema.parse(step.after)); return }
      await domain.table(step.table).put(step.key, step.after)
    },
  }

  /** 业务写只进计划（内存 + journal），不落盘；真正落盘由 applyPlan 统一做。 */
  async function putJ(table, key, record) {
    if (!currentOp) { await domain.table(table).put(key, record); return }
    const before = currentOp.overlay.has(table + ':' + key) ? currentOp.overlay.get(table + ':' + key) : domain.table(table).get(key)
    const step = {
      kind: 'record', table, key,
      before_exists: before !== undefined,
      before: before === undefined ? null : before,
      after: record,
      // 不可逆标记与业务事实写在**同一份计划**里，且计划先于任何业务落盘。
      ...(table === 'changelog' ? { irreversible: true, irreversible_reason: 'changelog 是 append-only 审计证据' } : {}),
    }
    currentOp.j.steps.push(step)
    currentOp.overlay.set(table + ':' + key, record)
  }

  /** 把计划真正写到磁盘：逐步落盘 + 进度游标；崩溃后 recover 按同一计划前滚。 */
  async function applyPlan(j) {
    for (const step of j.steps) {
      crashPoint('step-recorded')
      crashPoint('step-recorded-' + step.table)
      await stepIO.writeStep(step)
      crashPoint('record-written')
      crashPoint('record-written-' + step.table)
      await pausePoint('record-written')
      j.completed_steps.push({ table: step.table, key: step.key })
      j.updated_at = nowIso()
      currentOp.flush()
      crashPoint('step-completed')
    }
  }
  /** replayed 用不可枚举属性挂上去：调用方能读，但不进 JSON、不改既有返回形状。 */
  function markReplayed(value, flag) {
    if (value && typeof value === 'object') {
      try { Object.defineProperty(value, 'replayed', { value: flag, enumerable: false, configurable: true }) } catch {}
    }
    return value
  }

  function resultRefOf(value) {
    if (!value || typeof value !== 'object') return null
    const obj = value.project && typeof value.project === 'object' ? value.project : value
    return typeof obj.id === 'string' ? 'record:' + obj.id : null
  }

  /**
   * 一次业务写 = 一个操作。同一 client_request_id 重放：返回原结果、零副作用；指纹不同则拒。
   * 嵌套调用（createProject 里调 linkSession）不新开操作，属于同一 journal。
   */
  async function withOp(name, args, fn) {
    if (currentOp) return fn()
    if (!journal) return fn()
    assertNoSpoofedActor(args)
    const crid = args && args.client_request_id ? String(args.client_request_id) : null
    const clean = { ...(args || {}) }
    delete clean.client_request_id
    delete clean.manual
    const fp = fingerprintOf(name, clean)
    // 身份只来自调用方上下文（runAsCaller）或 openStore 显式注入；绝不从 args 取。
    const caller = callerContext()
    const effectiveSession = (caller && caller.sessionId) || sessionId
    const enforce = (caller && caller.enforce === true) || enforceIdentity
    if (enforce) {
      if (name === 'submitTaskReceipt') {
        // 0.19 受限回执写：走独立授权，绝不进入 authorizeWrite 权威写闸。
        // task 由 store 按 task_id 取（不信任参数）；project_id 必须和 task 一致由授权函数校验。
        const task = (typeof store.task === 'function' ? store.task(args && args.task_id) : null) || (args && args.task)
        store.lastAuthorization = authorizeTaskReceipt({
          links: store.links(), task,
          projectId: args && args.project_id, sessionId: effectiveSession, op: name,
        })
      } else if (name === 'assignTask') {
        // 派单按 task 所属项目走权威写闸（参数只有 task_id）。
        const tk = (typeof store.task === 'function' ? store.task(args && args.task_id) : null)
        const pid = tk ? tk.project_id : null
        if (!pid) throw Object.assign(new Error('任务不存在，无法派单'), { code: 'TASK_NOT_FOUND' })
        store.lastAuthorization = authorizeWrite({ links: store.links(), projectId: pid, sessionId: effectiveSession, op: name, manual: args && args.manual })
      } else if (name === 'decideTaskReceipt') {
        // 裁定回执按回执所属项目走权威写闸（参数只有 id，需反查 project_id）。
        const rec = (typeof store.receipt === 'function' ? store.receipt(args && args.id) : null)
        const pid = rec ? rec.project_id : null
        if (!pid) throw Object.assign(new Error('回执不存在，无法裁定'), { code: 'RECEIPT_NOT_FOUND' })
        store.lastAuthorization = authorizeWrite({ links: store.links(), projectId: pid, sessionId: effectiveSession, op: name, manual: args && args.manual })
      } else {
        const pid = projectIdOf(name, args)
        if (pid) {
          store.lastAuthorization = authorizeWrite({ links: store.links(), projectId: pid, sessionId: effectiveSession, op: name, manual: args && args.manual })
        } else if (name === 'createProject' && !effectiveSession && !(args && args.manual && args.manual.authorized === true)) {
          authorizeWrite({ links: [], projectId: null, sessionId: effectiveSession, op: name })
        }
      }
    }
    const lock = await journal.acquire()
    let j = null
    try {
      const begun = await journal.begin({ client_request_id: crid, fingerprint: fp, op: name, actor, session_id: sessionId, writer: stepIO })
      if (begun.replayed) return markReplayed(begun.result, true)
      j = begun.journal
      currentOp = { j, overlay: new Map(), flush: () => journal.writeJsonAtomic(journal.opPath(j), j) }
      overlay = currentOp.overlay
      // 阶段一：在内存里把这次操作要写的**全部**记录算出来（不碰磁盘）。
      const value = await fn()
      if (!crid && (j.steps || []).length === 0 && value && value.changed === false) {
        // 无 client_request_id 且真的零改动：不留 journal 文件，保住“重复点一次零写盘”。
        currentOp = null
        overlay = null
        try { unlinkSync(journal.opPath(j)) } catch {}
        return value
      }
      // 阶段二：完整计划先落盘（APPLYING），再逐条写业务记录；崩溃后按同一计划前滚。
      j.state = JOURNAL_STATES.APPLYING
      j.updated_at = nowIso()
      currentOp.flush()
      crashPoint('plan-written')
      await applyPlan(j)
      crashPoint('pre-commit')
      j.state = JOURNAL_STATES.COMMITTED
      j.result = value === undefined ? null : JSON.parse(JSON.stringify(value))
      j.result_ref = resultRefOf(value)
      j.updated_at = nowIso()
      currentOp.flush()
      crashPoint('post-commit')
      currentOp = null
      overlay = null
      return markReplayed(value, false)    } catch (e) {
      if (j) {
        // 走到这里说明还没开始 applyPlan（业务零落盘）：计划作废，删掉 journal。
        // 若是在 applyPlan 中途抛错，则由 recover 前滚——那时 j.state 已经是 APPLYING。
        if (j.state !== JOURNAL_STATES.APPLYING) {
          try { unlinkSync(journal.opPath(j)) } catch {}
        } else {
          j.state = JOURNAL_STATES.FAILED_RETRYABLE
          j.error = { code: e && e.code ? e.code : 'ERROR', message: String(e && e.message ? e.message : e) }
          j.updated_at = nowIso()
          try { journal.writeJsonAtomic(journal.opPath(j), j) } catch {}
        }
      }
      throw e
    } finally {
      currentOp = null
      overlay = null
      lock.release()
    }
  }

  function projectIdOf(name, args) {
    if (!args) return null
    if (args.project_id) return args.project_id
    if (name === 'archiveProject' || name === 'restoreProject' || name === 'deleteProject') return args.id || null
    if (name === 'unlinkDeliverable') {
      const d = dview.table('deliverable').get(args.id)
      return d ? d.project_id : null
    }
    return null
  }

  /** 某个 project 的**有效** primary（unlinked 不算）。 */
  function activePrimaryOf(projectId) {
    return [...dview.table('project_session').entries()]
      .map(([, v]) => v)
      .filter((l) => l && l.project_id === projectId && l.role === 'primary' && l.unlinked !== true)
  }

  /** 读可见性：per-record committed visibility —— APPLYING 期间返回 before / 隐藏新建。 */
  function visibleRecord(table, key, rec) {
    if (!journal) return rec
    const hit = journal.pendingIndex().get('record:' + table + ':' + key)
    if (!hit) return rec
    return hit.before_exists ? hit.before : null
  }
  function visibleAll(table) {
    const idx = journal ? journal.pendingIndex() : new Map()
    const out = []
    for (const [k, v] of dview.table(table).entries()) {
      const hit = idx.get('record:' + table + ':' + k)
      if (hit) { if (hit.before_exists) out.push(hit.before); continue }
      out.push(v)
    }
    return out
  }

  /**
   * 基线只在完整性被证明时写（铁律一）；降级时只写 last_degraded_snapshot。
   * 再加一道：meta 本身不可信（缺失/损坏/版本不兼容）时**一个字节都不写**。
   */
  async function refreshBaseline() {
    const counts = Object.fromEntries(TABLES.map(t => [t, dview.table(t).size]))
    if (!verdict.metaSafeToWrite) return counts
    if (verdict.writable) {
      await patchMeta(m => ({ ...m, schema_version: spec.version, created_at: m.created_at || nowIso(), expected_counts: counts }))
    } else {
      await patchMeta(m => ({ ...m, last_degraded_snapshot: { at: nowIso(), counts, criteria: verdict.criteria } }))
    }
    return counts
  }

  async function writeLog(op, targetTable, targetKey, summary, beforeRev, afterRev, source = 'manual', extra = null) {
    const id = newLogId()
    const rec = {
      id, at: nowIso(), actor, op, target_table: targetTable, target_key: targetKey,
      summary, before_rev: beforeRev ?? null, after_rev: afterRev ?? null,
      // 1.9：现在所有写入口都是人点的（manual）；runner 接进来后由它传 'run'。
      source,
      ...(extra && typeof extra === 'object' ? extra : {}),
    }
    assertRecord('changelog', rec)
    await putJ('changelog', id, rec)
  }

  Object.assign(store, {
    meta,
    claimRequest,
    /** 建项目：被引用者先写（project → link → changelog），符合顺序协议 §8.3。 */
    async createProject({ name, objective, next_action, done_when, tags, kind = 'project', status = 'active', session_id, basis, confidence = 'confirmed', legacy_refs, workspace_id, workspace_title, workspace_path }) {
      assertWritable()
      const na = validateNextAction(next_action)
      if (!na.ok) throw new StoreError(na.code, 'next_action 不合格：' + na.reason, { reason: na.reason })
      if (!name || !objective) throw new StoreError('INVALID_INPUT', 'name / objective 必填')
      const now = nowIso()
      const id = newProjectId()
      const record = {
        id, name: String(name).slice(0, 40), objective: String(objective), next_action: na.value,
        kind, status, confidence, basis: basis ?? ('用户确认 ' + now.slice(0, 10)),
        created_at: now, updated_at: now, updated_by: actor, rev: 1,
      }
      const dw = normalizeDoneWhen(done_when)
      if (dw) record.done_when = dw
      // tags 在 schema 里是 string[]（最多 3 个）；归一化后交给 assertRecord 把关。
      const tg = normalizeDoneWhen(tags)
      if (tg) record.tags = tg.slice(0, 3)
      if (legacy_refs) record.legacy_refs = legacy_refs
      assertRecord('project', record)
      await putJ('project', id, record)
      let link = null
      if (session_id) {
        link = await store.linkSession({ project_id: id, session_id, role: 'primary', basis: record.basis, confidence, source: 'manual' })
      }
      // 0.13：建项目时带工作区（会话右键预选 / 表单手选），一并关联。
      let workspaceLink = null
      if (workspace_id) {
        workspaceLink = await store.linkWorkspace({ project_id: id, workspace_id, workspace_title, workspace_path, basis: record.basis, confidence })
      }
      await writeLog('create', 'project', id, '建项目：' + record.name, null, 1)
      await refreshBaseline()
      return { project: record, link, workspaceLink }
    },

    /**
     * Continuity 0.1：工作进展检查点（正式表，纳入 expected_counts/Journal/幂等）。
     * proposed 只是 Agent 建议，不改 Project 权威字段；confirmed/rejected 由人工确认路由调用。
     * 确认后内容不可变：再次操作直接拒绝（要改就新建一条）。
     */
    async proposeCheckpoint({ project_id, source_session_id, source_session_role = 'primary', summary, completed, findings, next_action, open_questions, client_request_id } = {}) {
      assertWritable()
      const proj = dview.table('project').get(project_id)
      if (!proj) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (proj.status === 'deleted') throw new StoreError('PROJECT_DELETED', '回收站项目不能提交检查点：' + project_id)
      if (!source_session_id) throw new StoreError('SESSION_ID_REQUIRED', '检查点必须带来源会话（由 exec 注入）')
      if (!['primary', 'supporting', 'branch'].includes(source_session_role)) throw new StoreError('INVALID_ROLE', 'source_session_role 只能是 primary/supporting/branch')
      const s = String(summary ?? '').trim()
      if (s.length < 2 || s.length > 500) throw new StoreError('INVALID_INPUT', 'summary 必填且 2-500 字')
      const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : []
      const id = newCheckpointId()
      const now = nowIso()
      const rec = {
        id, project_id, source_session_id, source_session_role: source_session_role === 'branch' ? 'supporting' : source_session_role,
        summary: s, status: 'proposed', created_at: now, rev: 1,
      }
      const c = arr(completed); if (c.length) rec.completed = c
      const f2 = arr(findings); if (f2.length) rec.findings = f2
      const oq = arr(open_questions); if (oq.length) rec.open_questions = oq
      if (next_action && String(next_action).trim()) rec.next_action = String(next_action).trim().slice(0, 200)
      assertRecord('checkpoint', rec)
      await putJ('checkpoint', id, rec)
      await writeLog('create', 'checkpoint', id, '提交检查点（待确认）：' + s.slice(0, 40), null, 1)
      await refreshBaseline()
      return { checkpoint: rec, changed: true }
    },

    /** 人工确认：proposed → confirmed，记录确认时间与来源；confirmed 后不可变。 */
    async confirmCheckpoint({ id, confirmed_by } = {}) {
      assertWritable()
      const before = dview.table('checkpoint').get(id)
      if (!before) throw new StoreError('CHECKPOINT_NOT_FOUND', '检查点不存在：' + id)
      if (before.status !== 'proposed') throw new StoreError('CHECKPOINT_NOT_PROPOSED', '只有 proposed 状态可确认（当前 ' + before.status + '）；确认后不可变')
      const next = { ...before, status: 'confirmed', confirmed_at: nowIso(), confirmed_by: String(confirmed_by || 'local-human-confirm'), rev: before.rev + 1 }
      assertRecord('checkpoint', next)
      await putJ('checkpoint', id, next)
      await writeLog('update', 'checkpoint', id, '人工确认检查点', before.rev, next.rev)
      await refreshBaseline()
      return { checkpoint: next, changed: true }
    },

    /** 人工拒绝：proposed → rejected，保留原始内容与来源；不进 Resume 已确认进展。 */
    async rejectCheckpoint({ id, rejected_by } = {}) {
      assertWritable()
      const before = dview.table('checkpoint').get(id)
      if (!before) throw new StoreError('CHECKPOINT_NOT_FOUND', '检查点不存在：' + id)
      if (before.status !== 'proposed') throw new StoreError('CHECKPOINT_NOT_PROPOSED', '只有 proposed 状态可拒绝（当前 ' + before.status + '）')
      const next = { ...before, status: 'rejected', rejected_at: nowIso(), rev: before.rev + 1 }
      assertRecord('checkpoint', next)
      await putJ('checkpoint', id, next)
      await writeLog('update', 'checkpoint', id, '人工拒绝检查点' + (rejected_by ? '：' + String(rejected_by) : ''), before.rev, next.rev)
      await refreshBaseline()
      return { checkpoint: next, changed: true }
    },

    /**
     * 0.19 多分支协作：primary 建任务（权威写，走 authorizeWrite）。
     * 只有 primary 能建任务；assigned_session_id 可空（todo）。
     */
    async createTask({ project_id, title, objective, assigned_session_id, source_id, workflow, acceptance_criteria, note, client_request_id } = {}) {
      assertWritable()
      if (!project_id) throw new StoreError('INVALID_INPUT', 'project_id 必填')
      const proj = dview.table('project').get(project_id)
      if (!proj || proj.status === 'deleted') throw new StoreError('PROJECT_NOT_FOUND', '项目不存在或在回收站：' + project_id)
      const t = String(title ?? '').trim(), o = String(objective ?? '').trim()
      if (!t || !o) throw new StoreError('INVALID_INPUT', 'title / objective 必填')
      const id = newTaskId()
      const rec = {
        id, source_id: source_id ? String(source_id) : id, source_domain: 'manual', source_path: 'manual:' + id,
        title: t, objective: o, lifecycle: 'active', acceptance: 'pending',
        project_id, project_confidence: 'confirmed', project_basis: 'primary 建任务派单',
        assigned_session_id: assigned_session_id ? String(assigned_session_id) : null,
        updated_at: nowIso(), rev: 1,
      }
      if (workflow) rec.workflow = workflow
      if (Array.isArray(acceptance_criteria)) rec.acceptance_criteria = acceptance_criteria.slice(0, 20).map(String)
      if (note) rec.note = String(note)
      assertRecord('task', rec)
      await putJ('task', id, rec)
      await writeLog('create', 'task', id, '建任务：' + t.slice(0, 40), null, 1)
      await refreshBaseline()
      return { task: rec, changed: true, client_request_id: client_request_id || null }
    },

    /**
     * 0.19：primary 派单 / 改派（权威写）。只能把任务派给该项目的有效 supporting 会话。
     * assigned_session_id = null 表示撤销派单。
     */
    async assignTask({ task_id, assigned_session_id, expected_rev, client_request_id } = {}) {
      assertWritable()
      const before = dview.table('task').get(task_id)
      if (!before) throw new StoreError('TASK_NOT_FOUND', '任务不存在：' + task_id)
      if (before.acceptance === 'accepted' || before.acceptance === 'cancelled' || before.lifecycle === 'closed') {
        throw new StoreError('TASK_NOT_ASSIGNABLE', '已结束/已接受/已取消的任务不能派单')
      }
      if (expected_rev != null && Number(expected_rev) !== before.rev) {
        throw new StoreError('REV_CONFLICT', '任务 rev 冲突：expected ' + expected_rev + ' actual ' + before.rev)
      }
      const sid = assigned_session_id ? String(assigned_session_id) : null
      if (sid) {
        const all = store.links()
        const link = all.find((l) => l && l.project_id === before.project_id && l.session_id === sid && l.unlinked !== true && (l.role === 'supporting' || l.role === 'branch'))
        if (!link) throw new StoreError('ASSIGNEE_NOT_SUPPORTING', '只能派给该项目的有效 supporting/branch 会话')
      }
      const next = { ...before, assigned_session_id: sid, updated_at: nowIso(), rev: before.rev + 1 }
      assertRecord('task', next)
      await putJ('task', task_id, next)
      await writeLog('update', 'task', task_id, sid ? '派单给 ' + sid : '撤销派单', before.rev, next.rev)
      await refreshBaseline()
      return { task: next, changed: true, client_request_id: client_request_id || null }
    },

    /**
     * 0.19：supporting 提交任务回执（受限授权，withOp 里走 authorizeTaskReceipt）。
     * 回执落 submitted，任务置 implemented_unverified（做完待验）——不等于 accepted。
     */
    async submitTaskReceipt({ task_id, project_id, source_session_id, source_session_role, summary, deliverables, result, client_request_id } = {}) {
      assertWritable()
      const before = dview.table('task').get(task_id)
      if (!before) throw new StoreError('TASK_NOT_FOUND', '任务不存在：' + task_id)
      const dup = store.receipts().find((r) => r && r.task_id === task_id && r.source_session_id === source_session_id && r.status === 'submitted')
      if (dup) throw new StoreError('RECEIPT_ALREADY_SUBMITTED', '该会话已对本任务提交过待裁定回执：' + dup.id)
      const rr = String(result ?? 'completed')
      if (!['completed', 'blocked', 'needs_revision'].includes(rr)) throw new StoreError('INVALID_INPUT', 'result 只能是 completed/blocked/needs_revision')
      const sm = String(summary ?? '').trim()
      if (sm.length < 2 || sm.length > 500) throw new StoreError('INVALID_INPUT', 'summary 必填且 2-500 字')
      const id = newReceiptId(), now = nowIso()
      const rec = {
        id, task_id, project_id, source_session_id,
        source_session_role: source_session_role === 'branch' ? 'branch' : 'supporting',
        summary: sm, result: rr, status: 'submitted', created_at: now, rev: 1,
      }
      const dv = Array.isArray(deliverables) ? deliverables.slice(0, 20).map((x) => String(x).trim()).filter(Boolean) : []
      if (dv.length) rec.deliverables = dv
      assertRecord('task_receipt', rec)
      await putJ('task_receipt', id, rec)
      const nextTask = { ...before, acceptance: 'implemented_unverified', updated_at: now, rev: before.rev + 1 }
      assertRecord('task', nextTask)
      await putJ('task', task_id, nextTask)
      await writeLog('update', 'task_receipt', id, '提交回执（待裁定）：' + sm.slice(0, 40), null, 1)
      await writeLog('update', 'task', task_id, '回执触发：做完待验（非 accepted）', before.rev, nextTask.rev)
      await refreshBaseline()
      return { receipt: rec, task: nextTask, changed: true, client_request_id: client_request_id || null }
    },

    /** 0.19：primary 裁定回执（权威写）——accepted/rejected，并同步任务正式状态。 */
    async decideTaskReceipt({ id, decision, note, expected_rev, client_request_id } = {}) {
      assertWritable()
      const before = dview.table('task_receipt').get(id)
      if (!before) throw new StoreError('RECEIPT_NOT_FOUND', '回执不存在：' + id)
      if (before.status !== 'submitted') throw new StoreError('RECEIPT_NOT_SUBMITTED', '只有 submitted 回执可裁定（当前 ' + before.status + '）')
      if (decision !== 'accepted' && decision !== 'rejected') throw new StoreError('INVALID_INPUT', 'decision 只能是 accepted/rejected')
      if (expected_rev != null && Number(expected_rev) !== before.rev) throw new StoreError('REV_CONFLICT', '回执 rev 冲突')
      const now = nowIso()
      const next = { ...before, status: decision, rev: before.rev + 1 }
      if (decision === 'accepted') { next.confirmed_at = now; next.confirmed_by = 'primary-decision' }
      else { next.rejected_at = now; next.rejected_by = 'primary-decision' }
      if (note) { if (decision === 'accepted') next.accepted_note = String(note); else next.rejected_note = String(note) }
      assertRecord('task_receipt', next)
      await putJ('task_receipt', id, next)
      const taskBefore = dview.table('task').get(before.task_id)
      if (taskBefore) {
        const tnext = decision === 'accepted'
          ? { ...taskBefore, lifecycle: 'closed', acceptance: 'accepted', updated_at: now, rev: taskBefore.rev + 1 }
          : { ...taskBefore, lifecycle: 'active', acceptance: 'pending', assigned_session_id: null, updated_at: now, rev: taskBefore.rev + 1 }
        assertRecord('task', tnext)
        await putJ('task', before.task_id, tnext)
        await writeLog('update', 'task', before.task_id, '回执裁定 ' + decision, taskBefore.rev, tnext.rev)
      }
      await writeLog('update', 'task_receipt', id, '裁定回执：' + decision, before.rev, next.rev)
      await refreshBaseline()
      return { receipt: next, changed: true, client_request_id: client_request_id || null }
    },

    /**
     * 挂会话：确定性键 → **真幂等**。
     *
     * 三种情形，行为必须完全不同：
     *   1. 键不存在             → 新建：rev=1，写 1 条 changelog，刷新基线。
     *   2. 键存在且内容完全相同 → 直接返回现有记录，**零副作用**：
     *      不 put、不增 rev、不写 changelog、不刷新基线、不改任何文件 mtime。
     *      （S0 版在这里无条件 put + refreshBaseline，重复点一次 rev 就 +1 且没有 changelog，
     *        等于产生了一次无审计的更新。）
     *   3. 键存在但内容变化     → 必须提供 expected_rev 且等于现有 rev，否则
     *      EXPECTED_REV_REQUIRED / REV_CONFLICT；成功后 rev+1 并写 changelog。
     *      不允许无条件覆盖。
     *
     * 返回值仍是"那条记录"本身（老调用方读 .id 不变），另挂一个不可枚举的 changed 标记。
     */
    async linkSession({ project_id, session_id, role = 'primary', basis, confidence = 'confirmed', source = 'manual', expected_rev }) {
      assertWritable()
      if (!dview.table('project').get(project_id)) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (!basis || !String(basis).trim()) throw new StoreError('BASIS_REQUIRED', 'basis 必填')
      const proj = dview.table('project').get(project_id)
      if (proj && proj.status === 'deleted') {
        throw new StoreError('PROJECT_DELETED', '项目在回收站（status=deleted），不允许新增或改写会话角色', { project_id })
      }
      // P0：一个 Project 最多一个有效 primary（unlinked 的历史记录不计入）
      if (role === 'primary') {
        const other = activePrimaryOf(project_id).filter((l) => l.session_id !== session_id)
        if (other.length > 0) {
          throw new StoreError('PROJECT_PRIMARY_CONFLICT', '该项目的有效 primary 已是 ' + other[0].session_id + '，不能再加一个 primary（要换请用 transferPrimary）', { project_id, existing: other.map((l) => l.session_id) })
        }
      }
      const id = linkKey(project_id, session_id)
      const existing = dview.table('project_session').get(id)
      const basisText = String(basis)

      if (existing) {
        // 字段全同：幂等返回（不因 unlinked 而变）
        const sameFields = existing.project_id === project_id
          && existing.session_id === session_id
          && existing.role === role
          && existing.confidence === confidence
          && existing.basis === basisText
          && existing.source === source
        if (sameFields && !existing.unlinked) return decorateLink(existing, false)
        /**
         * 复活（0.12 契约）：unlinked 记录从界面消失、看不到 rev 与历史 basis/role。
         * 所以「重新挂上来」这个动作本身一律视为复活——不管提交的角色/依据和旧记录是否相同，
         * 都不要求 expected_rev（要求等于堵死复活路：界面无从得知那个 rev）。
         * 2026-11-21 真机踩坑：历史记录 basis 是长文案且 role=primary、已 unlinked，前端用新 basis 复活成
         * supporting，被旧逻辑 sameFields&&unlinked 判为内容变化 → EXPECTED_REV_REQUIRED。
         * 边界：复活后用提交的新字段覆盖旧字段（角色/依据以本次为准），rev+1、清 unlinked、写 changelog；
         * 之后记录重新可见，再改角色/依据仍须 expected_rev（下方活跃记录分支不变）。
         */
        const reviveOnly = existing.unlinked === true
        if (!reviveOnly && expected_rev === undefined) {
          throw new StoreError('EXPECTED_REV_REQUIRED', '同一确定性键的内容发生变化时必须提供 expected_rev（不允许无条件覆盖）', { id, actual_rev: existing.rev })
        }
        if (!reviveOnly && existing.rev !== expected_rev) {
          throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + existing.rev, { expected_rev, actual: existing.rev })
        }
        const next = { ...existing, role, confidence, basis: basisText, source, rev: existing.rev + 1 }
        // 0.12 复活：解除过关联的记录被重新关联时，清掉软删除标记。
        delete next.unlinked
        delete next.unlinked_at
        assertRecord('project_session', next)
        await putJ('project_session', id, next)
        await writeLog('link', 'project_session', id, (existing.unlinked ? '重新关联' : '改挂会话') + ' ' + session_id.slice(0, 16) + '… → ' + role, existing.rev, next.rev)
        await refreshBaseline()
        return decorateLink(next, true)
      }

      const record = {
        id, project_id, session_id, role, confidence, basis: basisText, source,
        created_at: nowIso(), rev: 1,
      }
      assertRecord('project_session', record)
      await putJ('project_session', id, record)
      await writeLog('link', 'project_session', id, '挂会话 ' + session_id.slice(0, 16) + '… → ' + role, null, 1)
      await refreshBaseline()
      return decorateLink(record, true)
    },

    /**
     * 0.21 受控项目更新：只允许改 status / next_action 两个字段（字段白名单，其余一概忽略并拒绝）。
     * 只服务「任务全 accepted 后的人工收敛」——系统只提示完成候选，最终状态由 primary 点按钮或 Agent
     * 在拿到人确认后调用本方法。权限走 withOp 标准 authorizeWrite（project_id 在 args 里，单 primary）。
     * 安全边界：
     *   1. status 只允许 active/paused/done；archived/deleted 必须走 archiveProject/deleteProject 专属路由，不许绕过。
     *   2. 必须给 expected_rev 且等于当前 rev（CAS），杜绝覆盖并发更新。
     *   3. next_action 过 validateNextAction（非态度词），与建项目同口径。
     *   4. 至少一个字段真变化，否则 changed=false 零副作用（幂等）。
     */
    async updateProject({ project_id, id, status, next_action, expected_rev, client_request_id } = {}) {
      assertWritable()
      const pid = project_id || id
      if (!pid) throw new StoreError('PROJECT_ID_REQUIRED', 'project_id 必填')
      const before = dview.table('project').get(pid)
      if (!before) throw new StoreError('PROJECT_NOT_FOUND', '项目不存在：' + pid)
      if (before.status === 'deleted') throw new StoreError('PROJECT_DELETED', '回收站项目不可更新：' + pid)
      // 字段白名单：出现任何不允许的字段（除白名单元数据）直接拒绝，防止通用写工具扩大权限。
      const allowed = ['project_id', 'id', 'status', 'next_action', 'expected_rev', 'client_request_id', 'manual']
      const extra = Object.keys(arguments[0] || {}).filter((k) => !allowed.includes(k))
      if (extra.length) throw new StoreError('FIELD_NOT_ALLOWED', 'updateProject 只允许 status / next_action，收到非法字段：' + extra.join(','))
      if (expected_rev === undefined) throw new StoreError('EXPECTED_REV_REQUIRED', '项目状态更新必须带 expected_rev（CAS 防覆盖）', { id: pid, actual_rev: before.rev })
      if (Number(expected_rev) !== before.rev) throw new StoreError('REV_CONFLICT', '项目 rev 冲突：expected ' + expected_rev + ' actual ' + before.rev)
      const next = { ...before }
      let changed = false
      if (status !== undefined) {
        if (!['active', 'paused', 'done'].includes(status)) throw new StoreError('INVALID_STATUS', 'status 只允许 active/paused/done；archived/deleted 走专属路由', { got: status })
        if (status !== before.status) { next.status = status; changed = true }
      }
      if (next_action !== undefined) {
        const v = validateNextAction(next_action)
        if (!v.ok) throw new StoreError(v.code, 'next_action 不合法：' + v.reason)
        if (v.value !== before.next_action) { next.next_action = v.value; changed = true }
      }
      if (!changed) return { project: before, changed: false, client_request_id: client_request_id || null }
      next.updated_at = nowIso()
      next.updated_by = actor
      next.rev = before.rev + 1
      assertRecord('project', next)
      await putJ('project', pid, next)
      const parts = []
      if (next.status !== before.status) parts.push('status ' + before.status + '→' + next.status)
      if (next.next_action !== before.next_action) parts.push('next_action 更新')
      await writeLog('update', 'project', pid, '受控更新：' + parts.join('；'), before.rev, next.rev)
      await refreshBaseline()
      return { project: next, changed: true, client_request_id: client_request_id || null }
    },

    /**
     * 归档：只改一条 project 记录，不动任何子记录。
     *
     * R-04：这里以前无条件是“读当前 → 写 archived”，重复归档会把 rev 一路推高（并发下更明显）。
     * 现在两条规矩：
     *   1. 已经是 archived → 直接返回 changed=false，零副作用（幂等）。
     *   2. strictRev 打开时，状态迁移必须带 expected_rev（给迁移/Agent 用；界面默认关，避免破坏现有契约）。
     */
    async archiveProject(id, { expected_rev } = {}) {
      assertWritable()
      if (!dview.table('project').get(id)) throw new StoreError('PROJECT_NOT_FOUND', id)
      const before = dview.table('project').get(id)
      if (before.status === 'archived') return { ...before, changed: false }
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '状态迁移必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, status: 'archived', updated_at: nowIso(), updated_by: actor, rev: before.rev + 1 }
      assertRecord('project', next)
      await putJ('project', id, next)
      await writeLog('archive', 'project', id, '归档（子记录零改动）', before.rev, next.rev)
      await refreshBaseline()
      return next
    },

    /**
     * 恢复：把 archived 改回 active，只改一条 project 记录。
     * 与 archiveProject 完全对称：expected_rev 防覆盖、写前 schema 校验、changelog、基线刷新。
     */
    async restoreProject(id, { expected_rev } = {}) {
      assertWritable()
      const before = dview.table('project').get(id)
      if (!before) throw new StoreError('PROJECT_NOT_FOUND', id)
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '状态迁移必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      // 0.12：恢复同时服务「归档」与「软删除回收站」两种状态。
      if (before.status !== 'archived' && before.status !== 'deleted') {
        throw new StoreError('NOT_ARCHIVED', '项目不是归档/回收站状态，无需恢复（当前 ' + before.status + '）')
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, status: 'active', updated_at: nowIso(), updated_by: actor, rev: before.rev + 1 }
      assertRecord('project', next)
      await putJ('project', id, next)
      await writeLog('restore', 'project', id, (before.status === 'deleted' ? '从回收站恢复' : '恢复归档') + '（子记录零改动）', before.rev, next.rev)
      await refreshBaseline()
      return next
    },

    /**
     * P0：把 primary 从 A 转移到 B（唯一被允许的换主方式）。
     *
     * 两条写入（B 升 primary、A 降 supporting）在**同一个 journal 计划**里：
     *   - 要么都落盘，要么都不落盘；
     *   - 未提交期间读接口看到的是 before（A 仍是 primary），不会出现“两个 primary 同时可见”；
     *   - 只写 1 条 changelog（op=update），带 before/after rev。
     */
    async transferPrimary({ project_id, to_session_id, basis, confidence = 'confirmed' } = {}) {
      assertWritable()
      if (!project_id || !to_session_id) throw new StoreError('INVALID_INPUT', 'project_id / to_session_id 必填')
      const proj = dview.table('project').get(project_id)
      if (!proj) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (proj.status === 'deleted') throw new StoreError('PROJECT_DELETED', '项目在回收站，不能转移 primary', { project_id })
      const all = [...dview.table('project_session').entries()].map(([, v]) => v)
      const targetId = linkKey(project_id, to_session_id)
      const target = all.find((l) => l.id === targetId)
      if (target && target.role === 'primary' && target.unlinked !== true) {
        return { ...target, changed: false }
      }
      const current = all.find((l) => l.project_id === project_id && l.session_id !== to_session_id && l.role === 'primary' && l.unlinked !== true)
      const now = nowIso()
      let promoted
      if (target) {
        promoted = { ...target, role: 'primary', confidence, rev: target.rev + 1 }
        if (basis) promoted.basis = String(basis)
        delete promoted.unlinked
        delete promoted.unlinked_at
      } else {
        if (!basis || !String(basis).trim()) throw new StoreError('BASIS_REQUIRED', '新建 primary 关联必须给 basis')
        promoted = { id: targetId, project_id, session_id: to_session_id, role: 'primary', confidence, basis: String(basis), source: 'manual', created_at: now, rev: 1 }
      }
      assertRecord('project_session', promoted)
      await putJ('project_session', targetId, promoted)
      let demoted = null
      if (current) {
        demoted = { ...current, role: 'supporting', rev: current.rev + 1 }
        if (!demoted.basis || !String(demoted.basis).trim()) demoted.basis = 'primary 转移到 ' + to_session_id.slice(0, 16) + '…（自动降级）'
        assertRecord('project_session', demoted)
        await putJ('project_session', current.id, demoted)
      }
      await writeLog('update', 'project_session', targetId,
        '转移 primary：' + (current ? current.session_id.slice(0, 16) + '…（降 supporting） → ' : '（无原 primary） → ') + to_session_id.slice(0, 16) + '…（升 primary）',
        current ? current.rev : null, promoted.rev)
      await refreshBaseline()
      return { ...promoted, changed: true, demoted: demoted ? demoted.id : null }
    },

    /**
     * 0.12 解除关联：软删除一条 project_session，不物理删记录。
     * 为什么不物理删：域层 delete 在 Node 层无法验证（asar 打包），且删记录会让计数低于
     * expected_counts → D3 基线回退 → 整库只读（错误账本 E-10）。加 unlinked 标记计数不变，
     * read 层过滤掉即可；重新 linkSession 时自动复活。旧记录没有 unlinked 字段，按 linked 处理。
     */
    async unlinkSession({ project_id, session_id, expected_rev } = {}) {
      assertWritable()
      if (!project_id || !session_id) throw new StoreError('INVALID_INPUT', 'project_id / session_id 必填')
      if (!dview.table('project').get(project_id)) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      const id = linkKey(project_id, session_id)
      const before = dview.table('project_session').get(id)
      if (!before) throw new StoreError('LINK_NOT_FOUND', '这条关联不存在：' + id)
      if (before.unlinked) return { ...before, changed: false }  // 幂等：已解除，零副作用
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '解除关联必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, unlinked: true, unlinked_at: nowIso(), rev: before.rev + 1 }
      assertRecord('project_session', next)
      await putJ('project_session', id, next)
      await writeLog('unlink', 'project_session', id, '解除关联 ' + session_id.slice(0, 16) + '…', before.rev, next.rev)
      await refreshBaseline()
      return decorateLink(next, true)
    },

    /**
     * 0.13 关联工作区：确定性键 project_id + '__' + workspace_id（workspace_id 是 36 位 uuid，
     * 正好匹配 ProjectWorkspaceSchema 的 id 正则）。软标记、不物理删；重复关联零副作用；
     * 改内容需 expected_rev；解绑后重新关联自动复活。与 linkSession 同一套安全逻辑。
     */
    async linkWorkspace({ project_id, workspace_id, workspace_title, workspace_path, basis, confidence = 'confirmed', expected_rev } = {}) {
      assertWritable()
      if (!project_id || !workspace_id) throw new StoreError('INVALID_INPUT', 'project_id / workspace_id 必填')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspace_id)) {
        throw new StoreError('INVALID_INPUT', 'workspace_id 必须是 36 位 uuid：' + workspace_id)
      }
      if (!dview.table('project').get(project_id)) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (!basis || !String(basis).trim()) throw new StoreError('BASIS_REQUIRED', 'basis 必填')
      const id = project_id + '__' + workspace_id
      const existing = dview.table('project_workspace').get(id)
      const basisText = String(basis)
      const titleText = typeof workspace_title === 'string' ? workspace_title : undefined
      const pathText = typeof workspace_path === 'string' ? workspace_path : undefined

      if (existing) {
        const sameFields = existing.project_id === project_id && existing.workspace_id === workspace_id
          && existing.workspace_title === titleText && existing.workspace_path === pathText
          && existing.confidence === confidence && existing.basis === basisText
        if (sameFields && !existing.unlinked) return { ...existing, changed: false }
        // 复活路径同会话关联：字段没变、只是被软标记 → 允许直接复活，不要 expected_rev
        const reviveOnly = sameFields && existing.unlinked === true
        if (!reviveOnly && expected_rev === undefined) {
          throw new StoreError('EXPECTED_REV_REQUIRED', '同一确定性键内容变化时必须提供 expected_rev', { id, actual_rev: existing.rev })
        }
        if (!reviveOnly && existing.rev !== expected_rev) {
          throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + existing.rev, { expected_rev, actual: existing.rev })
        }
        const next = { ...existing, workspace_title: titleText, workspace_path: pathText, confidence, basis: basisText, rev: existing.rev + 1 }
        delete next.unlinked; delete next.unlinked_at  // 复活
        assertRecord('project_workspace', next)
        await putJ('project_workspace', id, next)
        await writeLog('link', 'project_workspace', id, (existing.unlinked ? '重新关联工作区' : '改挂工作区') + ' ' + (titleText || workspace_id.slice(0, 8)), existing.rev, next.rev)
        await refreshBaseline()
        return { ...next, changed: true }
      }

      const record = { id, project_id, workspace_id, confidence, basis: basisText, created_at: nowIso(), rev: 1 }
      if (titleText !== undefined) record.workspace_title = titleText
      if (pathText !== undefined) record.workspace_path = pathText
      assertRecord('project_workspace', record)
      await putJ('project_workspace', id, record)
      await writeLog('link', 'project_workspace', id, '关联工作区 ' + (titleText || workspace_id.slice(0, 8)), null, 1)
      await refreshBaseline()
      return { ...record, changed: true }
    },

    /** 0.13 解除工作区关联：软标记 unlinked，零物理删、可恢复。 */
    async unlinkWorkspace({ project_id, workspace_id, expected_rev } = {}) {
      assertWritable()
      if (!project_id || !workspace_id) throw new StoreError('INVALID_INPUT', 'project_id / workspace_id 必填')
      const id = project_id + '__' + workspace_id
      const before = dview.table('project_workspace').get(id)
      if (!before) throw new StoreError('LINK_NOT_FOUND', '这条工作区关联不存在：' + id)
      if (before.unlinked) return { ...before, changed: false }
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '解除工作区关联必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, unlinked: true, unlinked_at: nowIso(), rev: before.rev + 1 }
      assertRecord('project_workspace', next)
      await putJ('project_workspace', id, next)
      await writeLog('unlink', 'project_workspace', id, '解除工作区关联 ' + (before.workspace_title || workspace_id.slice(0, 8)), before.rev, next.rev)
      await refreshBaseline()
      return { ...next, changed: true }
    },

    /**
     * 0.12 软删除项目：status → deleted（进回收站），零物理删除、零子记录改动。
     * 与 archiveProject 完全对称：expected_rev 防覆盖、写前 schema 校验、changelog、基线刷新。
     * 已 deleted 再删 → 幂等零副作用。恢复走 restoreProject（已放宽接受 deleted）。
     */
    async deleteProject(id, { expected_rev } = {}) {
      assertWritable()
      const before = dview.table('project').get(id)
      if (!before) throw new StoreError('PROJECT_NOT_FOUND', id)
      if (before.status === 'deleted') return { ...before, changed: false }
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '状态迁移必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, status: 'deleted', updated_at: nowIso(), updated_by: actor, rev: before.rev + 1 }
      assertRecord('project', next)
      await putJ('project', id, next)
      await writeLog('delete', 'project', id, '软删除进回收站（子记录零改动）', before.rev, next.rev)
      await refreshBaseline()
      return next
    },

    /**
     * S1-B 迁移导入：按原生键写入一条既有记录。
     *
     * 幂等规则（R-29）：
     *   - 键不存在 → 写入（走同一个 journal，带 changelog）
     *   - 键存在且内容完全相同 → changed:false，零写盘
     *   - 键存在但内容不同 → MIGRATION_CONFLICT（绝不覆盖）
     * 同一 client_request_id 再来一次，由 journal 直接回放，连比较都不会发生。
     */
    async importRecord({ table, key, record, client_request_id, emit_changelog = true, changelog_extra = null } = {}) {
      assertWritable()
      if (!TABLES.includes(table)) throw new StoreError('INVALID_INPUT', '未知表：' + table)
      if (!key) throw new StoreError('INVALID_INPUT', 'key 必填')
      const parsed = assertRecord(table, record)
      const existing = dview.table(table).get(key)
      if (existing) {
        if (canon(existing) === canon(parsed)) return { ...existing, changed: false, imported: true }
        throw new StoreError('MIGRATION_CONFLICT', '目标已有同键记录且内容不同，拒绝覆盖：' + table + '/' + key, { table, key })
      }
      await putJ(table, key, parsed)
      // 历史记录导入不产生“迁移事件”行：历史自带 at/actor/source，另写一条就等于伪造事件。
      if (emit_changelog) await writeLog('create', table, key, '迁移导入（S1-B）：' + key, null, parsed.rev ?? 1, 'run', changelog_extra)
      await refreshBaseline()
      return { ...parsed, changed: true, imported: true }
    },

    /**
     * 0.14 登记交付物：只索引不搬运（ADR-12）。locator 由路由层按 B1 算好（workspace 相对 + base_snapshot
     * 绝对路径快照），store 只做 schema 校验 + 落盘 + changelog，不拼本机路径、不搬运文件。
     * 降级只读时抛 READONLY_DEGRADED；重复 id 拒绝。
     */
    async addDeliverable({ project_id, title, kind = 'doc', locator, is_final = false, state = 'ok', size = null, mtime = null, sha256 = null, basis, confidence = 'confirmed' } = {}) {
      assertWritable()
      if (!project_id || !title) throw new StoreError('INVALID_INPUT', 'project_id / title 必填')
      if (!dview.table('project').get(project_id)) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (!locator || typeof locator !== 'object' || !locator.type) throw new StoreError('INVALID_INPUT', 'locator 必填（type: workspace|absolute）')
      if (locator.type === 'workspace' && (!locator.workspace_id || !locator.rel)) {
        throw new StoreError('INVALID_INPUT', 'locator.type=workspace 需 workspace_id + rel')
      }
      if (locator.type === 'absolute' && !locator.path) {
        throw new StoreError('INVALID_INPUT', 'locator.type=absolute 需 path')
      }
      if (locator.type === 'url' && !locator.url) {
        throw new StoreError('INVALID_INPUT', 'locator.type=url 需 url')
      }
      const id = newDeliverableId()
      const record = {
        id, project_id, title: String(title).slice(0, 120), kind,
        locator: {
          type: locator.type,
          ...(locator.workspace_id ? { workspace_id: locator.workspace_id } : {}),
          ...(locator.rel ? { rel: locator.rel } : {}),
          ...(locator.path ? { path: locator.path } : {}),
          ...(locator.base_snapshot ? { base_snapshot: locator.base_snapshot } : {}),
          ...(locator.registered_at ? { registered_at: locator.registered_at } : { registered_at: nowIso() }),
        },
        state, is_final: !!is_final, rev: 1,
      }
      if (size !== null) record.size = size
      if (mtime !== null) record.mtime = mtime
      if (sha256 !== null) record.sha256 = sha256
      if (basis) record.basis = basis
      if (confidence) record.confidence = confidence
      assertRecord('deliverable', record)
      await putJ('deliverable', id, record)
      await writeLog('create', 'deliverable', id, '登记交付物：' + record.title, null, 1)
      await refreshBaseline()
      return { ...record, changed: true }
    },

    /** 0.14 解除交付物关联：软标记 unlinked，零物理删、可恢复；重复解绑零副作用。 */
    async unlinkDeliverable(id, { expected_rev } = {}) {
      assertWritable()
      const before = dview.table('deliverable').get(id)
      if (!before) throw new StoreError('LINK_NOT_FOUND', '交付物不存在：' + id)
      if (before.unlinked) return { ...before, changed: false }
      if (strictRev && expected_rev === undefined) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '解除交付物必须带 expected_rev（strictRev 已开启）', { id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, unlinked: true, unlinked_at: nowIso(), rev: before.rev + 1 }
      assertRecord('deliverable', next)
      await putJ('deliverable', id, next)
      await writeLog('unlink', 'deliverable', id, '解除交付物索引：' + before.title, before.rev, next.rev)
      await refreshBaseline()
      return { ...next, changed: true }
    },

    /**
     * S1-C 任务归属：把任务挂到项目（或显式清空）。
     *
     * 与 linkSession 的区别：这条写的是**任务的属性**，不是关系表；
     * 所以必须同时写清依据与置信度，禁止出现"有 project_id 但说不清凭什么"的记录。
     * 守卫：项目必须存在、不在回收站；不允许把 confirmed 降级成 inferred（要降请显式传 allow_downgrade）。
     * 幂等：目标相同且置信度相同 → changed:false，零写盘。
     */
    async attributeTask({ task_id, project_id = null, basis, confidence = 'inferred', evidence = null, allow_downgrade = false, expected_rev } = {}) {
      assertWritable()
      if (!task_id) throw new StoreError('INVALID_INPUT', 'task_id 必填')
      const before = dview.table('task').get(task_id)
      if (!before) throw new StoreError('TASK_NOT_FOUND', '任务不存在：' + task_id)
      const target = project_id === null ? null : dview.table('project').get(project_id)
      const v = validateAttributionTarget({ project_id, project: target, confidence: project_id ? confidence : 'inferred' })
      if (!v.ok) throw new StoreError(v.code, v.message, { task_id, project_id })

      if ((before.project_id ?? null) === project_id && (before.project_confidence ?? null) === (project_id ? confidence : null)) {
        return { ...before, changed: false }
      }
      if (project_id && before.project_confidence === 'confirmed' && confidence === 'inferred' && !allow_downgrade) {
        throw new StoreError('ATTRIBUTION_DOWNGRADE', '已确认的归属不允许被推断覆盖（要降级请显式 allow_downgrade）', { task_id, project_id })
      }
      if (strictRev && expected_rev === undefined && project_id !== null && before.project_id) {
        throw new StoreError('EXPECTED_REV_REQUIRED', '改写已有归属必须带 expected_rev（strictRev 已开启）', { task_id, actual_rev: before.rev })
      }
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }

      const next = { ...before, project_id, updated_at: nowIso(), rev: before.rev + 1 }
      if (project_id) {
        next.project_basis = String(basis || '未记录依据')
        next.project_confidence = confidence
        if (evidence) next.project_evidence = String(evidence)
      } else {
        delete next.project_basis
        delete next.project_confidence
        delete next.project_evidence
      }
      assertRecord('task', next)
      await putJ('task', task_id, next)
      const label = project_id ? (target && target.name) || project_id : '（清空）'
      await writeLog('link', 'task', task_id, '任务归属 → ' + label + '（' + (project_id ? confidence : 'null') + '）', before.rev, next.rev)
      await refreshBaseline()
      return { ...next, changed: true }
    },

    /**
     * 补台账来源时间（迁移专用）：只写 source_updated_at 一个字段。
     *
     * 为什么单独开一个方法：早期迁移把 33 个任务的 updated_at 全写成台账文件头的时刻，
     * 等于在记录里宣布"33 个任务同一秒更新过"——那不是事实。这里只补真实的那个字段，
     * 不顺手改别的（改别的请走 attributeTask / 专门的业务方法）。
     */
    async setTaskSourceTime({ task_id, source_updated_at, expected_rev } = {}) {
      assertWritable()
      if (!task_id) throw new StoreError('INVALID_INPUT', 'task_id 必填')
      const before = dview.table('task').get(task_id)
      if (!before) throw new StoreError('TASK_NOT_FOUND', '任务不存在：' + task_id)
      if (!source_updated_at) throw new StoreError('INVALID_INPUT', 'source_updated_at 必填')
      if ((before.source_updated_at ?? null) === source_updated_at) return { ...before, changed: false }
      if (expected_rev === undefined) throw new StoreError('EXPECTED_REV_REQUIRED', '补来源时间必须带 expected_rev', { task_id, actual_rev: before.rev })
      if (before.rev !== expected_rev) throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      const next = { ...before, source_updated_at, updated_at: nowIso(), rev: before.rev + 1 }
      assertRecord('task', next)
      await putJ('task', task_id, next)
      await writeLog('update', 'task', task_id, '补台账来源时间：' + source_updated_at, before.rev, next.rev)
      await refreshBaseline()
      return { ...next, changed: true }
    },

    project: (id) => visibleRecord('project', id, dview.table('project').get(id)),
    projects: () => visibleAll('project'),
    tasks: () => visibleAll('task'),
    taskSessions: () => visibleAll('task_session'),
    links: () => visibleAll('project_session'),
    logs: () => visibleAll('changelog'),
    checkpoints: () => visibleAll('checkpoint'),
    checkpoint: (id) => visibleRecord('checkpoint', id, dview.table('checkpoint').get(id)),
    receipts: () => visibleAll('task_receipt'),
    receipt: (id) => visibleRecord('task_receipt', id, dview.table('task_receipt').get(id)),
    task: (id) => visibleRecord('task', id, dview.table('task').get(id)),
    deliverables: () => visibleAll('deliverable'),
    workspaces: () => visibleAll('project_workspace'),
    visibleAll,
    journal,

    /**
     * 显式恢复：只由人/受控入口调用，必须 authorized:true。
     * 恢复执行器不调用 withOp（不递归进 withJournal），只走 stepIO 直接写。
     */
    async recover({ authorized, reason } = {}) {
      if (authorized !== true) throw new StoreError('RECOVERY_UNAUTHORIZED', '恢复必须显式 authorized:true 并说明 reason')
      if (!journal) throw new StoreError('JOURNAL_DISABLED', '本 store 未启用操作日志')
      const lock = await journal.acquire()
      try {
        const results = await journal.recoverAll(stepIO)
        let baselineRefreshed = false
        for (const r of results) {
          if (r.state === 'COMMITTED' && verdict.writable) { await refreshBaseline(); baselineRefreshed = true }
        }
        return { reason: reason ?? null, recovered: results, baselineRefreshed }
      } finally { lock.release() }
    },
    /** 回滚：只允许技术上可逆的操作；含 changelog 的一律 ROLLBACK_FORBIDDEN（向前修复）。 */
    async rollback({ operation_id, authorized, reason, by } = {}) {
      if (!journal) throw new StoreError('JOURNAL_DISABLED', '本 store 未启用操作日志')
      const j = journal.findJournal(operation_id)
      if (!j) throw new StoreError('OPERATION_NOT_FOUND', '找不到操作 ' + operation_id)
      const lock = await journal.acquire()
      try { return await journal.rollbackOp(j, stepIO, { authorized, reason, actor: by ?? actor }) }
      finally { lock.release() }
    },
    rollbackPlan: (operation_id) => {
      if (!journal) throw new StoreError('JOURNAL_DISABLED', '本 store 未启用操作日志')
      const j = journal.findJournal(operation_id)
      if (!j) throw new StoreError('OPERATION_NOT_FOUND', '找不到操作 ' + operation_id)
      return journal.planRollback(j)
    },
    /** 双主检测（只读）：返回 [{project_id, sessions:[...]}]，空数组=没有冲突。 */
    primaryConflicts: () => {
      const byProject = {}
      for (const l of store.links()) {
        if (l.role !== 'primary' || l.unlinked === true) continue
        ;(byProject[l.project_id] = byProject[l.project_id] || []).push(l.session_id)
      }
      return Object.entries(byProject).filter(([, v]) => v.length > 1).map(([project_id, sessions]) => ({ project_id, sessions }))
    },
    pendingOperations: () => (journal ? journal.listJournals().filter((j) => j.state === 'PREPARED' || j.state === 'APPLYING').map((j) => ({ operation_id: j.operation_id, op: j.op, state: j.state, steps: (j.steps || []).length })) : []),
    staleLock: () => (journal ? journal.holderInfo() : null),
    takeOverStaleLock: ({ authorized, reason, by } = {}) => {
      if (!journal) throw new StoreError('JOURNAL_DISABLED', '本 store 未启用操作日志')
      return journal.recoverStaleLock({ authorized, reason, actor: by ?? actor })
    },

    /**
     * 九条对账（状态三分 + 降级严格只读）。
     *
     * 与"打开域时的完整性闸"分工：
     *   闸（openStore → guard.evaluate）只回答"能不能写"，判据是 D1/D2/D2b/D3/G_* /S_*；
     *   对账（本方法）回答"数据关系是否自洽"，包含 9 条，其中第 3 条要外部注册表。
     *
     * 状态只有三种：pass / fail / skipped。
     *   skipped = 依赖不在，**不是通过**；不许把空数组当成"检查成功"。
     * 统计分列 pass/fail/skipped/total，skipped 不计入 pass。
     *
     * 只读语义：降级状态下只检查、只出报告，不写 last_reconcile_at / last_reconcile_stats；
     * 元数据本身不可信（缺失/损坏/版本不兼容）时同样不写。返回 persisted 说明有没有落盘。
     */
    async reconcile({ sessionExists } = {}) {
      // 先看现在的磁盘：reconcile 是"状态检查"，不能拿打开时的快照下结论，
      // 更不能在快照说 ok 时把已经消失的元数据写回去。
      await refresh()
      // 核心扫描是否真的跑过。
      // 扫描失败时 evaluate() 会推 CORE_CHECK_UNAVAILABLE，且 metaState 会是 unavailable；
      // 两者任一成立，就说明所有"依赖磁盘计数"的检查都没有执行过。
      const scanUnavailable = verdict.metaState === META_STATE.UNAVAILABLE
        || verdict.criteria.some(c => c.code === 'CORE_CHECK_UNAVAILABLE')
      const checks = []
      const projects = store.projects()
      const links = store.links()
      const ids = new Set(projects.map(p => p.id))
      const projById = new Map(projects.map(p => [p.id, p]))
      /**
       * @param scope 'core'（核心数据完整性）| 'external'（外部引用，如 DSH 注册表）
       * 两类 skipped 的含义不同：external 只是"没查"，core 才是"可能坏了"。
       */
      const add = (id, name, status, detail, scope = 'core') => checks.push({
        id, name, status, detail, scope,
        ...(status === 'skipped' ? { severity: scope === 'external' ? 'unverified' : 'degraded' } : {}),
      })
      const byCount = (bad) => (bad === 0 ? 'pass' : 'fail')

      const legacyIds = projects.map(p => p.legacy_id).filter(Boolean)
      const check1Ok = ids.size === projects.length
        && new Set(legacyIds).size === legacyIds.length
        && projects.every(p => p.next_action && p.next_action.trim().length >= 4)
      add(1, 'project.id 唯一 / legacy_id 不重复 / next_action 非空', check1Ok ? 'pass' : 'fail', 'projects=' + projects.length)

      const orphanLinks = links.filter(l => !ids.has(l.project_id))
      add(2, 'link.project_id 都能找到 project', byCount(orphanLinks.length), 'orphans=' + orphanLinks.length)

      const hasRegistry = typeof sessionExists === 'function'
      const dangling = hasRegistry ? links.filter(l => !sessionExists(l.session_id)) : []
      add(3, 'link.session_id 在 DSH 注册表里存在',
        hasRegistry ? byCount(dangling.length) : 'skipped',
        hasRegistry ? 'dangling=' + dangling.length : '未检查：未接入 DSH 注册表 / session_projcache（不是数据损坏）',
        'external')

      const prim = {}
      for (const l of links) if (l.role === 'primary') prim[l.session_id] = (prim[l.session_id] ?? 0) + 1
      const badPrim = Object.entries(prim).filter(([, n]) => n > 1)
      add(4, '同一 session 的 primary ≤ 1', byCount(badPrim.length), 'violations=' + badPrim.length)

      const sup = {}
      for (const l of links) if (l.role === 'supporting') sup[l.session_id] = (sup[l.session_id] ?? 0) + 1
      const badSup = Object.entries(sup).filter(([, n]) => n > 2)
      add(5, '同一 session 的 supporting ≤ 2', byCount(badSup.length), 'violations=' + badSup.length)

      const d1 = verdict.criteria.filter(c => c.code === 'D1_SILENT_LOSS')
      // 磁盘没数成 = 这条检查没执行，绝不允许报 pass。
      // 状态 skipped 由 add() 自动补 scope=core / severity=degraded。
      if (scanUnavailable) {
        add(6, '磁盘文件数 vs 内存记录数（D1）', 'skipped', '未执行：磁盘扫描失败，无法对比磁盘与内存记录数', 'core')
      } else {
        add(6, '磁盘文件数 vs 内存记录数（D1）', byCount(d1.length), d1.length ? JSON.stringify(d1) : 'disk=mem')
      }

      const deliv = [...dview.table('deliverable').entries()].map(([, v]) => v)
      // S1-B 起 project_id 可空（交付物只证明"某任务产出了它"，没有项目归属证据）。
      // 原来的写法把**合法的 null** 也算成悬挂引用，等于让"如实留空"变成对账红条。
      const badDeliv = deliv.filter((d) => {
        if (!d || !d.project_id) return false
        const p = projById.get(d.project_id)
        return !p || p.status === 'deleted'
      })
      add(7, 'deliverable.project_id 有效（空合法；指向必须在场且不在回收站）', byCount(badDeliv.length), 'deliverables=' + deliv.length)

      const d2 = verdict.criteria.filter(c => c.code.startsWith('D2') || c.code === 'D3_BASELINE_REGRESSION')
      // 同第 6 条：基线比对也依赖磁盘计数，扫描不可用时必须 skipped。
      if (scanUnavailable) {
        add(8, '计数 vs 基线（D2/D3）', 'skipped', '未执行：磁盘扫描失败，无法与基线 expected_counts 比对', 'core')
      } else {
        add(8, '计数 vs 基线（D2/D3）', byCount(d2.length), d2.length ? JSON.stringify(d2) : 'ok')
      }

      const primByProject = {}
      for (const l of links) if (l.role === 'primary' && l.unlinked !== true) (primByProject[l.project_id] = primByProject[l.project_id] || []).push(l.session_id)
      const doublePrim = Object.entries(primByProject).filter(([, v]) => v.length > 1)
      add(10, '每个 project 的有效 primary ≤ 1（PROJECT_PRIMARY_CONFLICT）', byCount(doublePrim.length),
        doublePrim.length ? JSON.stringify(doublePrim.map(([p, s]) => ({ project_id: p, sessions: s }))) : 'ok')

      // S1-C 第 11 条：任务归属必须指得回一个活着的项目。
      // project_id 是可空字段，空不是错；指向不存在的项目、或指向回收站里的项目才是错。
      const tasksAll = [...dview.table('task').entries()].map(([, v]) => v)
      const badTaskProject = tasksAll.filter((t) => {
        if (!t || !t.project_id) return false
        const p = projById.get(t.project_id)
        return !p || p.status === 'deleted'
      })
      add(11, 'task.project_id 有效（可找回且不在回收站）', byCount(badTaskProject.length),
        badTaskProject.length ? JSON.stringify(badTaskProject.map((t) => ({ task_id: t.id, project_id: t.project_id }))) : 'tasks=' + tasksAll.length)

      const recent = store.logs().slice(-100)
      const badLog = recent.filter(l => l.target_table === 'project' && !ids.has(l.target_key))
      add(9, 'changelog 最近 100 条 target_key 可对上', byCount(badLog.length), 'checked=' + recent.length)

      const pass = checks.filter(c => c.status === 'pass').length
      const fail = checks.filter(c => c.status === 'fail').length
      const skipped = checks.filter(c => c.status === 'skipped').length
      // 核心检查被跳过 = 判据跑不了 = 保守降级（界面必须当"坏了"处理）；
      // 外部检查被跳过只是"未验证"，不改变 degraded。
      // 扫描不可用时也必须为 true，才能与 degradationReport().kind 一致。
      // 第 1/2/4/5/7/9 条只依赖内存，扫描失败时仍照常判 pass —— 它们不是"没执行"。
      const coreUnavailable = scanUnavailable
        || checks.some(c => c.scope === 'core' && c.status === 'skipped')
      const stats = {
        pass, fail, skipped, total: checks.length,
        orphans: orphanLinks.length, dangling: dangling.length,
        degraded: verdict.degraded, coreUnavailable,
      }

      // 落盘条件：域可写 且 meta 可信。降级或 meta 不可信时只出报告，一个字节都不写。
      let persisted = false
      let persistSkippedReason = null
      // 先报根因：元数据不可信比"只读降级"更具体，二者同时成立时报 META_UNSAFE。
      if (!verdict.metaSafeToWrite) persistSkippedReason = 'META_UNSAFE'
      else if (!verdict.writable) persistSkippedReason = 'READONLY_DEGRADED'
      if (persistSkippedReason === null) {
        await patchMeta(m => ({
          ...m,
          last_reconcile_at: nowIso(),
          last_reconcile_stats: { ok: pass, orphans: orphanLinks.length, dangling: dangling.length, degraded: verdict.degraded, pass, fail, skipped },
        }))
        persisted = true
      }

      return {
        ok: pass, pass, fail, skipped, total: checks.length, checks, stats,
        orphans: orphanLinks.map(l => l.id), persisted, persistSkippedReason,
        coreUnavailable,
        degradation: degradationReport(),
      }
    },

    /** 只关本 store 打开的域。共享 facility 时绝不 closeAll（那会关掉别人的域）。 */
    async close() {
      try { await domain.close() } finally { if (backend) await backend.close() }
    },
  })

  // S1-A：所有写入口统一走 journal。嵌套写自动合并成同一个操作（createProject → linkSession）。
  const JOURNALED = ['createProject', 'linkSession', 'archiveProject', 'restoreProject', 'unlinkSession', 'linkWorkspace', 'unlinkWorkspace', 'deleteProject', 'addDeliverable', 'unlinkDeliverable', 'importRecord', 'transferPrimary', 'attributeTask', 'setTaskSourceTime', 'proposeCheckpoint', 'confirmCheckpoint', 'rejectCheckpoint', 'createTask', 'assignTask', 'submitTaskReceipt', 'decideTaskReceipt', 'updateProject']
  for (const name of JOURNALED) {
    const impl = store[name]
    if (typeof impl !== 'function') continue
    store[name] = async function journaledWrite(...callArgs) {
      const meta = callArgs.find((a) => a && typeof a === 'object' && ('client_request_id' in a || 'manual' in a)) || {}
      const opArgs = { ...meta }
      if (typeof callArgs[0] === 'string') opArgs.id = callArgs[0]
      else if (callArgs[0] && typeof callArgs[0] === 'object') Object.assign(opArgs, callArgs[0])
      if (callArgs[1] && typeof callArgs[1] === 'object') Object.assign(opArgs, callArgs[1])
      return withOp(name, opArgs, () => impl.apply(store, callArgs))
    }
  }

  return store
}

/**
 * 只读打开：不 mkdir、不建域、不写 global.json，直接读磁盘 + 用同一份 schema 校验。
 * 目的：T41 能用“前后文件哈希完全一致”证明只读，而不是靠函数注释声明。
 */
export async function openStoreReadOnly({ root, writer = 'dsh-project-core@0.1.0-s0', version = VERSION, compatibleVersions, extraProject } = {}) {
  const spec = buildSpec({ version, compatibleVersions, writer, extraProject })
  const acceptedVersions = [spec.version, ...(spec.compatibleVersions ?? [])]
  const unitDir = join(root, 'project')
  if (!existsSync(unitDir)) throw new StoreError('STORE_NOT_FOUND', '数据域目录不存在：' + unitDir + '（只读模式不会自动创建）')
  const scan = await scanUnit(root, { tables: TABLES, acceptedVersions })
  let metaRaw = null
  let metaState = 'missing'
  const globalPath = join(unitDir, 'global.json')
  if (existsSync(globalPath)) {
    try {
      const doc = JSON.parse(readFileSync(globalPath, 'utf8'))
      // 盘上是 {version, record} 信封（域层写的就是这个形状），表记录已经拆过信封，
      // 全局元数据这里过去**没拆**——于是任何正常域在只读模式下都被判成 metaState=corrupt。
      // 只读模式恰恰是"看不出问题就别乱动"的那条路，它自己不能先报假损坏。
      metaRaw = doc && typeof doc === 'object' && doc.record && typeof doc.record === 'object' ? doc.record
        : (doc && typeof doc === 'object' && doc.value && typeof doc.value === 'object' ? doc.value : doc)
    } catch { metaState = 'corrupt' }
    if (metaRaw) { const p = MetaSchema.safeParse(metaRaw); if (p.success) metaState = 'ok'; else metaState = 'corrupt' }
  }
  const tables = {}
  const invalid = []
  for (const t of TABLES) {
    const map = new Map()
    const dir = join(unitDir, t)
    if (existsSync(dir)) {
      for (const n of readdirSync(dir)) {
        if (!n.endsWith('.json')) continue
        const key = n.slice(0, -5)
        try {
          const doc = JSON.parse(readFileSync(join(dir, n), 'utf8'))
          const rec = doc && typeof doc === 'object' && doc.record && typeof doc.record === 'object' ? doc.record
            : (doc && typeof doc === 'object' && doc.value && typeof doc.value === 'object' ? doc.value : doc)
          const parsed = spec.tables[t].valueSchema.safeParse(rec)
          if (parsed.success) map.set(key, parsed.data)
          else invalid.push({ table: t, key, issues: parsed.error.issues.map((i) => i.path.join('.')) })
        } catch (e) { invalid.push({ table: t, key, error: String(e && e.message ? e.message : e) }) }
      }
    }
    tables[t] = map
  }
  const meta = metaState === 'ok' ? metaRaw : initialMeta(writer)
  const domain = {
    global: { get: () => meta },
    table: (t) => ({ get: (k) => tables[t].get(k), entries: () => tables[t].entries(), size: tables[t].size }),
  }
  const expected = metaState === 'ok' ? meta.expected_counts ?? null : null
  const verdict = evaluate({ scanBefore: scan, scanAfter: scan, domain, tables: TABLES, expectedCounts: expected, acceptedVersions })
  const readonly = {
    root, spec, domain, mode: 'read', readonly: true,
    get verdict() { return verdict },
    get writable() { return false },
    get counts() { return verdict.counts },
    get invalidRecords() { return invalid },
    project: (id) => tables.project.get(id),
    projects: () => [...tables.project.values()],
    tasks: () => [...tables.task.values()],
    taskSessions: () => [...tables.task_session.values()],
    links: () => [...tables.project_session.values()],
    logs: () => [...tables.changelog.values()],
    deliverables: () => [...tables.deliverable.values()],
    workspaces: () => [...tables.project_workspace.values()],
    visibleAll: (t) => [...(tables[t] ? tables[t].values() : [])],
    meta: () => meta,
    async refresh() { return verdict },
    async close() {},
    degradationReport() {
      return { degraded: verdict.degraded, writable: false, kind: verdict.degraded ? 'readonly_mode' : 'ok', codes: verdict.criteria.map((c) => c.code), evidence: { metaState, invalid: invalid.length } }
    },
    _writeRefused(op) { throw new StoreError('READONLY_MODE', '只读打开：拒绝写操作 ' + op) },
  }
  for (const op of ['createProject', 'linkSession', 'archiveProject', 'restoreProject', 'unlinkSession', 'linkWorkspace', 'unlinkWorkspace', 'deleteProject', 'addDeliverable', 'unlinkDeliverable', 'updateProject']) {
    readonly[op] = async () => readonly._writeRefused(op)
  }
  return readonly
}