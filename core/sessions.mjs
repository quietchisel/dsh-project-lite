/**
 * core/sessions.mjs —— DSH 会话注册表的只读适配器（1.4 关联会话用）。
 *
 * 两个来源，各管一件事：
 *   1. <storages>/workspace.json
 *        → 会话归属：属于哪个工作区、工作区标题与路径；也是"这个 session 到底存不存在"的判据。
 *          实测 25 个工作区 / 221 条 sessionIds / 约 50KB，读一次毫秒级。
 *   2. <storages>/session_projcache/sessions/<uuid>.json
 *        → 会话标题（record.rows.title.val）。单文件平均 48KB，546 个共 25.7MB。
 *          所以**只在真要显示时才读**，并且按 mtime 缓存；绝不全量扫。
 *
 * 为什么存在性判定不扫缓存：
 *   一次请求读完 25.7MB 要秒级，而这个判定会被对账第 3 条用到（每次 reconcile 都跑）。
 *   workspace.json 已经足够——DSH 里每个会话都挂在某个工作区的 sessionIds 里。
 *
 * 已知边界（如实写在 README，不藏）：
 *   - 刚建的会话在 workspace.json 里立刻有，但 projcache 的标题文件可能还没落盘 → 标题为 null，
 *     界面回落到「工作区标题 + session id 前 8 位」，不假装有标题。
 *   - 会话被删后从 sessionIds 消失 → 关联会变成 orphan（第 3 条 fail，但**不降级**）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 会话 id 一律带 `session-` 前缀；projcache 的文件名是裸 uuid。 */
export const SESSION_PREFIX = 'session-'

export function sessionUuid(sessionId) {
  const s = String(sessionId || '')
  return s.startsWith(SESSION_PREFIX) ? s.slice(SESSION_PREFIX.length) : s
}

/**
 * @param root  storages 根目录（与项目域同一个 root，不另配路径）
 * @param ttlMs workspace.json 快照的进程内缓存时长（默认 5 秒，够界面点两下）
 */
export function createSessionRegistry({ root, ttlMs = 5000, titleConcurrency = 12 } = {}) {
  if (!root) throw new Error('createSessionRegistry: root is required')
  const workspaceFile = join(root, 'workspace.json')
  const cacheDir = join(root, 'session_projcache', 'sessions')

  /** @type {{ at: number, mtimeMs: number, ids: Set<string>, byId: Map<string, object>, total: number } | null} */
  let snap = null
  /** @type {Map<string, { mtimeMs: number, title: string | null }>} */
  const titleCache = new Map()

  function parseWorkspace(text) {
    const doc = JSON.parse(text)
    const tables = doc && doc.tables ? doc.tables : {}
    const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {}
    const byId = new Map()
    for (const [workspaceId, rec] of Object.entries(workspaces)) {
      if (!rec || typeof rec !== 'object') continue
      const ids = Array.isArray(rec.sessionIds) ? rec.sessionIds : []
      for (const sid of ids) {
        if (typeof sid !== 'string' || sid === '') continue
        // 同一会话出现在两个工作区是 DSH 自己的事，这里保留第一次出现（不替它裁决）。
        if (byId.has(sid)) continue
        byId.set(sid, {
          session_id: sid,
          workspace_id: workspaceId,
          workspace_title: typeof rec.title === 'string' ? rec.title : '',
          workspace_path: typeof rec.path === 'string' ? rec.path : '',
        })
      }
    }
    const rawIds = doc?.global?.workspaceIds
    // 0.13：工作区列表（id/title/path/session 数）。与 byId 同一份快照，不另扫盘。
    const workspaceRows = Object.entries(workspaces).map(([wid, rec]) => ({
      workspace_id: wid,
      title: typeof rec?.title === 'string' ? rec.title : '',
      path: typeof rec?.path === 'string' ? rec.path : '',
      session_count: Array.isArray(rec?.sessionIds) ? rec.sessionIds.length : 0,
    }))
    return {
      byId,
      workspaceRows,
      workspaceIds: new Set(Array.isArray(rawIds) ? rawIds : []),
      // 区分"字段缺失"（未知，不强制）与"字段是空数组"（明确没有任何工作区，必须拦）。
      workspaceIdsKnown: Array.isArray(rawIds),
    }
  }

  /**
   * 读一次 workspace.json（带 mtime + TTL 缓存）。
   * 读不到不抛：返回 ok:false 与原因，调用方据此把第 3 条判成 skipped（"没查"），不判 pass。
   */
  async function snapshot({ force = false } = {}) {
    const now = Date.now()
    let mtimeMs = null
    try { mtimeMs = (await stat(workspaceFile)).mtimeMs } catch { mtimeMs = null }
    if (!force && snap && snap.mtimeMs === mtimeMs && now - snap.at < ttlMs) return snap
    if (mtimeMs === null) {
      snap = { at: now, mtimeMs: null, ids: new Set(), byId: new Map(), workspaceRows: [], total: 0, ok: false, reason: 'workspace.json 不存在：' + workspaceFile }
      return snap
    }
    let parsed
    try {
      parsed = parseWorkspace(await readFile(workspaceFile, 'utf8'))
    } catch (error) {
      snap = { at: now, mtimeMs, ids: new Set(), byId: new Map(), workspaceRows: [], workspaceIds: new Set(), total: 0, ok: false, reason: 'workspace.json 读不出来：' + String(error && error.message ? error.message : error) }
      return snap
    }
    snap = { at: now, mtimeMs, ids: new Set(parsed.byId.keys()), byId: parsed.byId, workspaceRows: parsed.workspaceRows, workspaceIds: parsed.workspaceIds, workspaceIdsKnown: parsed.workspaceIdsKnown, total: parsed.byId.size, ok: true, reason: null }
    return snap
  }

  /**
   * 单条会话的标题；文件不在 / 读不动 / 没这个字段 → null（不编造）。
   * 0.13.2：DSH 的 projcache 目录混着两种文件名——裸 uuid 与 session- 前缀（实测 301 + 288），
   * 旧版只拼裸 uuid，带前缀的会话标题永远读不到 → 界面回落成 id。两个候选都试。
   * 缓存按 mtime 失效：会话标题随任务进度变化、DSH 重写 projcache 时 mtime 变 → 自动重读，
   * 所以标题更新会自然反映到项目面板，不需要我们另存快照（存了反而会过期）。
   */
  async function titleOf(sessionId) {
    const uuid = sessionUuid(sessionId)
    if (!/^[0-9a-fA-F-]+$/.test(uuid)) return null
    // 两个候选文件名；取第一个真实存在且能 stat 到的。
    const candidates = [join(cacheDir, uuid + '.json'), join(cacheDir, SESSION_PREFIX + uuid + '.json')]
    let file = null
    let mtimeMs = null
    for (const c of candidates) {
      try { mtimeMs = (await stat(c)).mtimeMs; file = c; break } catch { /* 试下一个 */ }
    }
    if (!file) return null
    const hit = titleCache.get(uuid)
    if (hit && hit.mtimeMs === mtimeMs) return hit.title
    let title = null
    try {
      const doc = JSON.parse(await readFile(file, 'utf8'))
      const rows = doc && doc.record && doc.record.rows ? doc.record.rows : {}
      const raw = rows.title && rows.title.val
      if (typeof raw === 'string' && raw.trim() !== '') title = raw.trim()
    } catch { title = null }
    titleCache.set(uuid, { mtimeMs, title })
    return title
  }

  /** 按 id 列表并发取标题，限流，避免一次打开选择器把磁盘读满。 */
  async function titlesOf(ids) {
    const out = new Map()
    let cursor = 0
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++
        const id = ids[i]
        try { out.set(id, await titleOf(id)) } catch { out.set(id, null) }
      }
    }
    const n = Math.max(1, Math.min(titleConcurrency, ids.length))
    await Promise.all(Array.from({ length: n }, worker))
    return out
  }

  /**
   * 候选会话列表。
   * @param q     大小写不敏感子串，匹配 session_id / 工作区标题 / 工作区路径
   * @param limit 默认 50、上限 200（标题要读盘，必须封顶）
   */
  async function list({ q = '', limit = 50 } = {}) {
    const s = await snapshot()
    const needle = String(q || '').trim().toLowerCase()
    const max = Math.max(1, Math.min(Number(limit) || 50, 200))
    let rows = [...s.byId.values()]
    if (needle !== '') {
      rows = rows.filter((r) =>
        r.session_id.toLowerCase().includes(needle)
        || (r.workspace_title || '').toLowerCase().includes(needle)
        || (r.workspace_path || '').toLowerCase().includes(needle))
    }
    // 同工作区的排一起，方便肉眼找；工作区内按 id 稳定排序（不按时间猜，注册表没给）。
    rows.sort((a, b) => {
      const wa = (a.workspace_title || '') + '\u0000' + a.workspace_id
      const wb = (b.workspace_title || '') + '\u0000' + b.workspace_id
      return wa < wb ? -1 : wa > wb ? 1 : (a.session_id < b.session_id ? -1 : 1)
    })
    const matched = rows.length
    const page = rows.slice(0, max)
    const titles = await titlesOf(page.map((r) => r.session_id))
    return {
      ok: s.ok,
      reason: s.reason,
      total: s.total,
      matched,
      limit: max,
      sessions: page.map((r) => ({ ...r, title: titles.get(r.session_id) ?? null })),
    }
  }

  /**
   * 0.13 候选工作区列表（关联工作区用）。来自 workspace.json 的 tables.workspaces，
   * 只读快照、不读 projcache，毫秒级。q 匹配 id / 标题 / 路径；上限 200。
   * 返回的工作区带 path，供界面「点开文件夹」用。
   */
  async function listWorkspaces({ q = '', limit = 200 } = {}) {
    const s = await snapshot()
    const needle = String(q || '').trim().toLowerCase()
    const max = Math.max(1, Math.min(Number(limit) || 200, 200))
    let rows = Array.isArray(s.workspaceRows) ? s.workspaceRows : []
    if (needle !== '') {
      rows = rows.filter((r) =>
        String(r.workspace_id).toLowerCase().includes(needle)
        || (r.title || '').toLowerCase().includes(needle)
        || (r.path || '').toLowerCase().includes(needle))
    }
    rows = rows.slice().sort((a, b) => (a.title || a.workspace_id) < (b.title || b.workspace_id) ? -1 : 1)
    const matched = rows.length
    return {
      ok: s.ok, reason: s.reason,
      total: Array.isArray(s.workspaceRows) ? s.workspaceRows.length : 0,
      matched, limit: max, workspaces: rows.slice(0, max),
    }
  }

  /**
   * 1.10 fail-closed 三校验（关联前必过，任一不过就零落盘）：
   *   1. 会话在注册表里；
   *   2. 会话所属工作区还在工作区列表里（没被移出）；
   *   3. 工作区目录在磁盘上真实存在。
   *
   * 为什么第 2、3 条要查：会话还在、但它所在的工作区文件夹被删了，关联进来的就是一条
   * "指向空气"的引用——事后看详情只会显示一个路径，点过去什么都没有。
   * 宁可现在拒，也不要留一条假引用。
   */
  async function verify(sessionId) {
    // 关联是写操作，必须拿最新注册表。mtime 是毫秒粒度，同一毫秒内连续改文件会
    // 让缓存误判"没变"（s21 A4 实测偶发），所以这里强制重读，不吃缓存。
    const s = await snapshot({ force: true })
    if (!s.ok) return { ok: false, code: 'REGISTRY_UNAVAILABLE', reason: s.reason || '读不到 DSH 会话注册表' }
    const id = String(sessionId || '')
    const row = s.byId.get(id)
    if (!row) return { ok: false, code: 'SESSION_NOT_FOUND', reason: '会话不在 DSH 注册表里：' + id }
    if (s.workspaceIdsKnown && !s.workspaceIds.has(row.workspace_id)) {
      return { ok: false, code: 'WORKSPACE_GONE', reason: '会话所属工作区已不在工作区列表里：' + row.workspace_id }
    }
    if (!row.workspace_path) {
      return { ok: false, code: 'WORKSPACE_PATH_MISSING', reason: '会话所属工作区没有记录路径，无法确认它落在哪' }
    }
    try { await stat(row.workspace_path) } catch {
      return { ok: false, code: 'WORKSPACE_PATH_MISSING', reason: '会话所属工作区目录不存在：' + row.workspace_path }
    }
    return { ok: true, session_id: id, workspace_id: row.workspace_id, workspace_path: row.workspace_path }
  }

  /** 存在性：同步判定，给 reconcile 用（先 await snapshot() 再取这个闭包）。 */
  function existsFn(s) {
    const ids = s && s.ids ? s.ids : new Set()
    return (sessionId) => ids.has(String(sessionId || ''))
  }

  return { snapshot, list, listWorkspaces, titleOf, titlesOf, existsFn, verify, paths: { workspaceFile, cacheDir } }
}
