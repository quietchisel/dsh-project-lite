/**
 * core/store.mjs — 最小可运行 core（只存储层，不接 UI、不接 Agent）。
 *
 * 对外只暴露"人能点的那几个动作"：建项目 / 挂会话 / 归档 / 对账 / 读。
 * 所有写入口先过完整性闸（guard.writable），降级时抛 READONLY_DEGRADED —— 不是只把按钮藏起来。
 */
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { buildSpec, TABLES, VERSION, MetaSchema } from './spec.mjs'
import { scanUnit, evaluate, META_STATE } from './guard.mjs'
import { newProjectId, newLogId, linkKey, nowIso, validateNextAction } from './util.mjs'

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
export async function openStore({ root, facility: injectedFacility, actor = 's0-harness', writer = 'dsh-project-core@0.1.0-s0', version = VERSION, compatibleVersions, extraProject } = {}) {
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
  async function claimRequest(requestId, actionKey, exec) {
    if (requestId === undefined || requestId === null || requestId === '') {
      return { replayed: false, value: await exec() }
    }
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
    await domain.global.set(parsed)
    return parsed
  }

  /**
   * 基线只在完整性被证明时写（铁律一）；降级时只写 last_degraded_snapshot。
   * 再加一道：meta 本身不可信（缺失/损坏/版本不兼容）时**一个字节都不写**。
   */
  async function refreshBaseline() {
    const counts = Object.fromEntries(TABLES.map(t => [t, domain.table(t).size]))
    if (!verdict.metaSafeToWrite) return counts
    if (verdict.writable) {
      await patchMeta(m => ({ ...m, schema_version: spec.version, created_at: m.created_at || nowIso(), expected_counts: counts }))
    } else {
      await patchMeta(m => ({ ...m, last_degraded_snapshot: { at: nowIso(), counts, criteria: verdict.criteria } }))
    }
    return counts
  }

  async function writeLog(op, targetTable, targetKey, summary, beforeRev, afterRev) {
    const id = newLogId()
    const rec = {
      id, at: nowIso(), actor, op, target_table: targetTable, target_key: targetKey,
      summary, before_rev: beforeRev ?? null, after_rev: afterRev ?? null,
    }
    assertRecord('changelog', rec)
    await domain.table('changelog').put(id, rec)
  }

  Object.assign(store, {
    meta,
    claimRequest,
    /** 建项目：被引用者先写（project → link → changelog），符合顺序协议 §8.3。 */
    async createProject({ name, objective, next_action, done_when, tags, kind = 'project', status = 'active', session_id, basis, confidence = 'confirmed', legacy_refs }) {
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
      await domain.table('project').put(id, record)
      let link = null
      if (session_id) {
        link = await store.linkSession({ project_id: id, session_id, role: 'primary', basis: record.basis, confidence, source: 'manual' })
      }
      await writeLog('create', 'project', id, '建项目：' + record.name, null, 1)
      await refreshBaseline()
      return { project: record, link }
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
      if (!domain.table('project').get(project_id)) throw new StoreError('PROJECT_NOT_FOUND', project_id)
      if (!basis || !String(basis).trim()) throw new StoreError('BASIS_REQUIRED', 'basis 必填')
      const id = linkKey(project_id, session_id)
      const existing = domain.table('project_session').get(id)
      const basisText = String(basis)

      if (existing) {
        const same = existing.project_id === project_id
          && existing.session_id === session_id
          && existing.role === role
          && existing.confidence === confidence
          && existing.basis === basisText
          && existing.source === source
        if (same) return decorateLink(existing, false)
        if (expected_rev === undefined) {
          throw new StoreError('EXPECTED_REV_REQUIRED', '同一确定性键的内容发生变化时必须提供 expected_rev（不允许无条件覆盖）', { id, actual_rev: existing.rev })
        }
        if (existing.rev !== expected_rev) {
          throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + existing.rev, { expected_rev, actual: existing.rev })
        }
        const next = { ...existing, role, confidence, basis: basisText, source, rev: existing.rev + 1 }
        assertRecord('project_session', next)
        await domain.table('project_session').put(id, next)
        await writeLog('link', 'project_session', id, '改挂会话 ' + session_id.slice(0, 16) + '… → ' + role, existing.rev, next.rev)
        await refreshBaseline()
        return decorateLink(next, true)
      }

      const record = {
        id, project_id, session_id, role, confidence, basis: basisText, source,
        created_at: nowIso(), rev: 1,
      }
      assertRecord('project_session', record)
      await domain.table('project_session').put(id, record)
      await writeLog('link', 'project_session', id, '挂会话 ' + session_id.slice(0, 16) + '… → ' + role, null, 1)
      await refreshBaseline()
      return decorateLink(record, true)
    },

    /** 归档：只改一条 project 记录，不动任何子记录。 */
    async archiveProject(id, { expected_rev } = {}) {
      assertWritable()
      if (!domain.table('project').get(id)) throw new StoreError('PROJECT_NOT_FOUND', id)
      const before = domain.table('project').get(id)
      if (expected_rev !== undefined && before.rev !== expected_rev) {
        throw new StoreError('REV_CONFLICT', 'rev 不一致：期望 ' + expected_rev + ' 实际 ' + before.rev, { expected_rev, actual: before.rev })
      }
      const next = { ...before, status: 'archived', updated_at: nowIso(), updated_by: actor, rev: before.rev + 1 }
      assertRecord('project', next)
      await domain.table('project').put(id, next)
      await writeLog('archive', 'project', id, '归档（子记录零改动）', before.rev, next.rev)
      await refreshBaseline()
      return next
    },

    project: (id) => domain.table('project').get(id),
    projects: () => [...domain.table('project').entries()].map(([, v]) => v),
    links: () => [...domain.table('project_session').entries()].map(([, v]) => v),
    logs: () => [...domain.table('changelog').entries()].map(([, v]) => v),

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

      const deliv = [...domain.table('deliverable').entries()].map(([, v]) => v)
      const badDeliv = deliv.filter(d => !ids.has(d.project_id))
      add(7, 'deliverable.project_id 有效', byCount(badDeliv.length), 'deliverables=' + deliv.length)

      const d2 = verdict.criteria.filter(c => c.code.startsWith('D2') || c.code === 'D3_BASELINE_REGRESSION')
      // 同第 6 条：基线比对也依赖磁盘计数，扫描不可用时必须 skipped。
      if (scanUnavailable) {
        add(8, '计数 vs 基线（D2/D3）', 'skipped', '未执行：磁盘扫描失败，无法与基线 expected_counts 比对', 'core')
      } else {
        add(8, '计数 vs 基线（D2/D3）', byCount(d2.length), d2.length ? JSON.stringify(d2) : 'ok')
      }

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

  return store
}