/**
 * core/guard.mjs — 完整性闸（ADR-34 / ADR-35）+ global.json 四态判定（S0.7）。
 *
 * 为什么需要它：per-record 布局的读路径对"JSON 坏"和"版本戳不被接受"一律返回 undefined
 * （dsh-storage-json/src/format.ts L117-128），loadAll 直接当这条记录不存在。
 * invalidRecords:'backup-and-skip' 只在 zod 校验失败时触发，**拦不到这两种情况**。
 * 所以"版本不兼容 = 空库"在域层眼里是合法的空库，只能靠数磁盘文件发现。
 *
 * S0.7 新增：global.json 缺失时的保护。
 * 域层在 global.json 缺失/损坏时会把 global 回落成 initial（created_at 空、expected_counts null），
 * 从内存看与"全新库"完全一样。两者只能靠磁盘事实区分，所以这里把 meta 状态判成四态：
 *   ok                    global.json 在、可解析、版本戳被接受        → 唯一可写元数据的状态
 *   new_legit             global.json 不在、且一条数据文件/备份都没有 → 合法新库，允许初始化
 *   missing_with_data     global.json 不在、但有数据文件 / .bak / .deleting → 只读降级（不许当成新库）
 *   corrupt               global.json 在但解析失败                   → 只读降级（不许覆盖证据）
 *   version_incompatible  global.json 在、可解析、版本戳不在接受集合内 → 只读降级
 *
 * 铁律：metaState 不是 ok / new_legit 时，**一个字节都不许写进 global.json**。
 * 否则"缺失"会被我们自己补成一个正常基线，证据当场销毁（这正是 S0.7 要堵的洞）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const isJson = (n) => n.endsWith('.json') && !n.includes('.json.bak.') && !n.endsWith('.deleting')
const isBak = (n) => n.includes('.json.bak.')

/** meta 四态（+ 一个"ok"），字符串常量便于测试与日志直接比对。 */
export const META_STATE = {
  OK: 'ok',
  NEW_LEGIT: 'new_legit',
  MISSING_WITH_DATA: 'missing_with_data',
  CORRUPT: 'corrupt',
  VERSION_INCOMPATIBLE: 'version_incompatible',
  /** 扫描本身失败：核心检查跑不了 → 保守降级（S1-lite 0a 要求）。 */
  UNAVAILABLE: 'unavailable',
}

/** 数磁盘：每张表的记录文件数 / 备份文件数 / 残留文件数，以及 global.json 的四态原料。 */
export async function scanUnit(root, { unitName = 'project', tables, acceptedVersions }) {
  const unitDir = join(root, unitName)
  const out = {
    unitDir, exists: true,
    global: { exists: false, parseOk: null, stampOk: null, version: null, raw: null, error: null },
    tables: {},
  }
  let entries
  try {
    entries = await readdir(unitDir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') {
      out.exists = false
      for (const t of tables) out.tables[t] = { json: 0, bak: 0, deleting: 0, dirExists: false }
      return out
    }
    throw e
  }
  for (const ent of entries) {
    if (ent.isFile() && ent.name === 'global.json') {
      out.global.exists = true
      try {
        const doc = JSON.parse(await readFile(join(unitDir, 'global.json'), 'utf8'))
        out.global.raw = doc
        out.global.parseOk = true
        out.global.version = typeof doc.version === 'number' ? doc.version : null
        out.global.stampOk = typeof doc.version === 'number' && acceptedVersions.includes(doc.version)
      } catch (e) {
        // 解析失败与"版本戳被拒"是两件事，必须分开记（S0.7 任务书 §二.1 D）。
        out.global.parseOk = false
        out.global.stampOk = false
        out.global.error = String(e?.message ?? e)
      }
    }
  }
  for (const t of tables) {
    const rec = { json: 0, bak: 0, deleting: 0, dirExists: false }
    try {
      const files = await readdir(join(unitDir, t), { withFileTypes: true })
      rec.dirExists = true
      for (const f of files) {
        if (!f.isFile()) continue
        if (isBak(f.name)) rec.bak++
        else if (f.name.endsWith('.deleting')) rec.deleting++
        else if (isJson(f.name)) rec.json++
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    out.tables[t] = rec
  }
  return out
}

/**
 * 只凭"打开前"的磁盘事实判 meta 四态。纯函数，便于单测。
 * @param scan scanUnit() 的结果（用 openStore 里的 scanBefore，不是 scanAfter）
 */
export function classifyMeta(scan, { acceptedVersions = [] } = {}) {
  // 扫描本身失败（目录不可读、权限、瞬时 IO）：不能当成"空库"，要单独报 unavailable。
  if (!scan || !scan.tables || !scan.global) {
    return { state: META_STATE.UNAVAILABLE, dataFiles: null, bakFiles: null, deletingFiles: null, detail: '打开前磁盘扫描失败' }
  }
  const dataFiles = Object.values(scan.tables).reduce((n, t) => n + t.json, 0)
  const bakFiles = Object.values(scan.tables).reduce((n, t) => n + t.bak, 0)
  const deletingFiles = Object.values(scan.tables).reduce((n, t) => n + t.deleting, 0)
  const g = scan.global
  const base = { dataFiles, bakFiles, deletingFiles }
  if (g.exists) {
    if (g.parseOk !== true) return { ...base, state: META_STATE.CORRUPT, detail: g.error ?? 'global.json 不可解析' }
    if (g.stampOk !== true) {
      return { ...base, state: META_STATE.VERSION_INCOMPATIBLE, version: g.version, acceptedVersions: [...acceptedVersions] }
    }
    return { ...base, state: META_STATE.OK, version: g.version }
  }
  // .deleting 同样是"这里曾经有记录"的磁盘证据（S1-lite 缺陷 1）：
  // per-record 删除先把 <key>.json rename 成 <key>.json.deleting，再 unlink；
  // unlink 走 Promise.allSettled 且失败被吞（dsh-storage-json per-record-unit.ts L293-295），
  // 所以 .deleting 可以长期残留，而它已经不在可读集里（open 只读 *.json）。
  // 只凭 .deleting 也必须按"缺失但有残留"处理，否则会把"删除没做完"当成空库重新初始化。
  if (dataFiles > 0 || bakFiles > 0 || deletingFiles > 0) return { ...base, state: META_STATE.MISSING_WITH_DATA }
  return { ...base, state: META_STATE.NEW_LEGIT }
}

/**
 * 三条判据 + 一条 global 判据 + 空库合法性判定。
 * @returns {{writable:boolean, degraded:boolean, criteria:Array, counts:Object, legitEmpty:boolean,
 *            metaState:string, metaClass:Object, metaSafeToWrite:boolean}}
 */
export function evaluate({ scanBefore, scanAfter, domain, tables, expectedCounts, acceptedVersions = [] }) {
  const criteria = []
  const counts = {}
  for (const t of tables) counts[t] = domain.table(t).size

  // 核心判据（D1/D2/D3）依赖磁盘扫描。扫描失败 = 判据跑不了 = 保守降级，
  // 绝不允许"查不到"被当成"没问题"（S1-lite 0a / 使用者 2026-11-14 拍板）。
  const scanOk = !!(scanAfter && scanAfter.tables && scanBefore && scanBefore.tables)
  if (!scanOk) {
    criteria.push({
      code: 'CORE_CHECK_UNAVAILABLE', table: '',
      detail: '磁盘扫描失败，核心完整性判据（D1/D2/D3/S_*）无法执行 → 保守降级',
    })
  }
  const diskOf = (scan, t, k) => (scan && scan.tables && scan.tables[t]) ? scan.tables[t][k] : null

  // D1 静默消失：磁盘有、内存没有
  for (const t of tables) {
    const disk = diskOf(scanAfter, t, 'json')
    if (disk === null) continue
    const mem = counts[t]
    if (disk > mem) criteria.push({ code: 'D1_SILENT_LOSS', table: t, disk, mem, lost: disk - mem })
  }

  // D2 权威表丢失：project 有文件但一条都读不出
  const pDisk = diskOf(scanAfter, 'project', 'json')
  if (pDisk !== null && pDisk > 0 && counts.project === 0) {
    criteria.push({ code: 'D2_AUTHORITY_LOST', table: 'project', disk: pDisk, mem: 0 })
  }
  // D2b 权威表空但引用表非空
  if (pDisk === 0 && counts.project === 0 && (counts.project_session > 0 || counts.deliverable > 0)) {
    criteria.push({ code: 'D2B_AUTHORITY_EMPTY_LINKS_PRESENT', table: 'project', links: counts.project_session, deliverables: counts.deliverable })
  }

  // D3 基线回退
  if (expectedCounts) {
    for (const t of tables) {
      const exp = expectedCounts[t]
      if (typeof exp === 'number' && counts[t] < exp) {
        criteria.push({ code: 'D3_BASELINE_REGRESSION', table: t, expected: exp, actual: counts[t] })
      }
    }
  }

  // ---- global.json 四态（S0.7）----
  // 判据来源是"打开前"的磁盘事实：打开动作本身会建目录，用 scanAfter 会污染判断。
  const metaClass = classifyMeta(scanBefore, { acceptedVersions })
  if (metaClass.state === META_STATE.UNAVAILABLE) {
    criteria.push({ code: 'G_GLOBAL_UNREADABLE', table: '', detail: '打开前无法读取单元目录，meta 状态未知（不当作新库）' })
  } else if (metaClass.state === META_STATE.MISSING_WITH_DATA) {
    criteria.push({
      code: 'G_GLOBAL_MISSING_WITH_DATA', table: '',
      detail: 'global.json 缺失但磁盘有数据或删除残留（.json / .bak / .deleting），域层会把 meta 回落成 initial——必须只读降级，不许当成新库',
      dataFiles: metaClass.dataFiles, bakFiles: metaClass.bakFiles, deletingFiles: metaClass.deletingFiles,
    })
  } else if (metaClass.state === META_STATE.CORRUPT) {
    criteria.push({
      code: 'G_GLOBAL_CORRUPT', table: '',
      detail: 'global.json 存在但解析失败，meta 回落成 initial；不许覆盖这份完整性证据',
      parseError: metaClass.detail,
    })
  } else if (metaClass.state === META_STATE.VERSION_INCOMPATIBLE) {
    criteria.push({
      code: 'G_GLOBAL_STAMP_REJECTED', table: '',
      detail: 'global.json 版本戳不在接受集合内，meta 回落为 initial',
      version: metaClass.version, acceptedVersions: metaClass.acceptedVersions,
    })
  }

  // schema 跳过（打开期间新增 .bak）：记录被"跳过并备份"而不是报错。
  // 权威表（project）发生这件事，严重程度等同于权威数据丢失。
  for (const t of tables) {
    if (!scanOk) break
    const bakDelta = scanAfter.tables[t].bak - scanBefore.tables[t].bak
    if (bakDelta > 0) {
      criteria.push({ code: t === 'project' ? 'S_AUTHORITY_RECORD_SKIPPED' : 'S_RECORD_SKIPPED', table: t, bakDelta, authority: t === 'project' })
    }
  }

  const anyDisk = tables.some(t => (diskOf(scanAfter, t, 'json') ?? 0) > 0)
  const anyBak = tables.some(t => (diskOf(scanAfter, t, 'bak') ?? 0) > 0)
  // 删除残留也算"这里不是空库"：legitEmpty 只允许在四种计数全 0 时成立（S1-lite 缺陷 1）。
  const anyDeleting = tables.some(t => (diskOf(scanAfter, t, 'deleting') ?? 0) > 0)
  const anyMem = tables.some(t => counts[t] > 0)
  const expectedAllZeroOrNull = !expectedCounts || Object.values(expectedCounts).every(v => v === 0)
  const legitEmpty = metaClass.state === META_STATE.NEW_LEGIT && !anyDisk && !anyBak && !anyDeleting && !anyMem && expectedAllZeroOrNull

  // 只有"global.json 在且可信"或"全新空库"这两种情况允许写元数据；
  // 缺失/损坏/版本不兼容时写下去就是把证据覆盖掉。
  const metaSafeToWrite = metaClass.state === META_STATE.OK || metaClass.state === META_STATE.NEW_LEGIT

  const degraded = criteria.length > 0
  return { writable: !degraded, degraded, criteria, counts, legitEmpty, metaState: metaClass.state, metaClass, metaSafeToWrite }
}
