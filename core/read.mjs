/**
 * core/read.mjs —— S1 的 1.1 工作包：只读服务层。
 *
 * 契约：
 *   1. 四个方法全部同步读内存（domain.table 的 entries），不写盘、不写元数据、不触发 reconcile。
 *   2. 返回值一律是可 JSON 序列化的纯数据快照；路由层直接 JSON.stringify，不另算一遍。
 *   3. 降级态下照常可读（degradationReport().canStill 含 read），但绝不提供任何写入口。
 *   4. 分组顺序写死 active → paused → done → archived，不做智能排序。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，也不 import store.mjs —— 只依赖传入的 store 对象，
 * 因此 Node 层可独立机检，不依赖宿主 Host。
 */

// 0.14：交付物现场校验只读 stat，不写盘、不引入 now()（保证路由 body 与直出深度相等）。
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 四组固定顺序。 */
export const STATUS_GROUPS = ['active', 'paused', 'done', 'archived', 'deleted']

/** 统一过一遍 JSON，保证「服务层直出」与「路由 body」逐字段相等（丢掉 undefined / 函数 / 原型）。 */
const snapshot = (x) => JSON.parse(JSON.stringify(x))

function tableAll(store, name) {
  // S1-A：优先走 store 的可见性读口（APPLYING 期间隐藏未提交的新建记录 / 返回 before 快照）。
  if (typeof store.visibleAll === 'function') return store.visibleAll(name)
  return [...store.domain.table(name).entries()].map(([, v]) => v)
}

function projectSummary(p) {
  return {
    id: p.id,
    name: p.name,
    objective: p.objective,
    next_action: p.next_action,
    kind: p.kind,
    status: p.status,
    confidence: p.confidence,
    basis: p.basis,
    // 详情页「项目区」要显示完成判据与标签；徽标要能点开看到历史来源。
    done_when: p.done_when ?? null,
    tags: p.tags ?? [],
    legacy_id: p.legacy_id ?? null,
    legacy_refs: p.legacy_refs ?? [],
    created_at: p.created_at,
    updated_at: p.updated_at,
    rev: p.rev,
  }
}

/**
 * 0.15.0：任务视图（只读）。台账迁移进来的 Task，归属靠 project_id；
 * project_confidence 必须一起给出去——inferred 是"按会话继承推断"，不是"我确认它属于这个项目"。
 */
function taskView(t) {
  return {
    id: t.id,
    source_id: t.source_id,
    title: t.title,
    objective: t.objective,
    lifecycle: t.lifecycle,
    acceptance: t.acceptance,
    next_action: t.next_action ?? null,
    project_id: t.project_id ?? null,
    project_confidence: t.project_confidence ?? null,
    project_basis: t.project_basis ?? null,
    primary_session_id: t.primary_session_id ?? null,
    source_updated_at: t.source_updated_at ?? null,
    updated_at: t.updated_at,
    rev: t.rev,
  }
}

function linkView(l) {
  return {
    id: l.id,
    project_id: l.project_id,
    session_id: l.session_id,
    role: l.role,
    confidence: l.confidence,
    basis: l.basis,
    source: l.source,
    created_at: l.created_at,
    rev: l.rev,
  }
}

/**
 * 0.14 C1：现场只读校验一条交付物的路径，返回派生的 check 视图（不改记录、不落盘）。
 * B1：优先 workspace 相对路径 + 当前工作区根（可移植），失败回落登记时的绝对路径快照 base_snapshot。
 * 三态：ok / missing / unreachable —— 区分"文件没了"与"盘没插/目录改名"。
 * 不含 now()：校验时间用 stat.mtime，保证 s12「路由 body == 直出」深度相等。
 */
async function checkDeliverable(d, registrySnap) {
  const loc = d.locator || {}
  const primary = []
  if (loc.type === 'workspace' && loc.workspace_id && loc.rel) {
    const rows = (registrySnap && registrySnap.workspaceRows) || []
    const ws = rows.find((r) => r.workspace_id === loc.workspace_id)
    if (ws && ws.path) primary.push(join(ws.path, loc.rel))
  } else if (loc.type === 'absolute' && loc.path) {
    primary.push(loc.path)
  }
  // 回落：登记时的绝对路径快照（B1）
  if (loc.base_snapshot) primary.push(loc.base_snapshot)

  const statOne = async (p) => {
    try {
      const s = await stat(p)
      return { state: 'ok', resolved: p, size: s.size, mtime: s.mtime.toISOString() }
    } catch (e) {
      const code = e && e.code
      return { state: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreachable', resolved: p, size: null, mtime: null }
    }
  }
  if (!primary.length) return { state: 'unreachable', resolved: null, size: null, mtime: null, pathHint: null }
  let first = null
  for (const p of primary) {
    const r = await statOne(p)
    if (!first) first = r
    if (r.state === 'ok') return r
  }
  // 都失败：报第一个候选的状态，并给出快照当人工找回线索
  return { ...first, pathHint: loc.base_snapshot || null }
}

/**
 * @param store openStore() 返回的 store（长期存活，verdict 由路由层 refresh() 保鲜）
 * @returns {{overview:Function, getProject:Function, linksOfSession:Function, search:Function}}
 */
export function createReadService(store, options = {}) {
  const { titlesOf, registry } = options
  /**
   * 给一批 link 补身份信息：会话标题（projcache，读不到就没有）+ 工作区名（注册表，几乎总有）。
   * 前端据此显示「工作区名 / 标题」而不是裸 session id。查不到就不加字段，绝不编造。
   */
  async function withTitles(links) {
    if (!links.length) return links
    let map = null
    if (typeof titlesOf === 'function') {
      try { map = await titlesOf(links.map((l) => l.session_id)) } catch { map = null }
    }
    // 0.14.1 兜底：titlesOf 漏读/异常时，用 registry.titleOf 逐条重读（详情请求量小）。
    if (registry && typeof registry.titleOf === 'function') {
      for (const l of links) {
        if (!map || !map.get(l.session_id)) {
          try {
            const one = await registry.titleOf(l.session_id)
            if (one) { if (!map) map = new Map(); map.set(l.session_id, one) }
          } catch { /* 单条失败留空，不编造 */ }
        }
      }
    }
    let snap = null
    if (registry && typeof registry.snapshot === 'function') {
      try { snap = await registry.snapshot() } catch { snap = null }
    }
    // 0.15.1 修：titlesOf 返回的是 Map，原来写成 map[session_id]（对象下标），
    // Map 上永远是 undefined → 标题一次都没注入成功，界面一直回落成「会话 + id」。
    // 同时兼容 Map 与普通对象，免得以后换实现再踩一次。
    const titleOfId = (id) => {
      if (!map) return null
      if (typeof map.get === 'function') return map.get(id) || null
      return map[id] || null
    }
    return links.map((l) => {
      const t = titleOfId(l.session_id)
      const row = snap && snap.ok && snap.byId.get(l.session_id)
      const ws = row && row.workspace_title
      const extra = {}
      if (t) extra.title = t
      if (ws) extra.workspace_title = ws
      return Object.keys(extra).length ? { ...l, ...extra } : l
    })
  }
  /** 每条响应都带的可信度上下文：界面拿到就能直接判「能不能写」，不需要再猜。 */
  function common() {
    const d = store.degradationReport()
    return {
      writable: store.writable,
      degraded: d.degraded,
      metaState: store.metaState,
      degradation: d,
    }
  }

  /** 项目总览：四组 + 计数 + 摘要列表。 */
  function overview() {
    const projects = store.projects().map(projectSummary)
    const groups = STATUS_GROUPS.map((key) => {
      const items = projects.filter((p) => p.status === key)
      return { key, count: items.length, items }
    })
    return snapshot({
      ok: true,
      ...common(),
      total: projects.length,
      counts: Object.fromEntries(groups.map((g) => [g.key, g.count])),
      groups,
    })
  }

  /** 单项目详情：含关联会话 / 工作区 / 交付物 / 与它有关的 changelog。找不到也返回 200 + found:false。 */
  async function getProject(id) {
    const p = store.project(id)
    if (!p) {
      return snapshot({
        ok: true, found: false, project: null,
        sessions: [], workspaces: [], tasks: [], deliverables: [], logs: [],
        counts: { sessions: 0, workspaces: 0, tasks: 0, tasks_stale: 0, deliverables: 0, logs: 0, unconfirmed: 0 },
        ...common(),
      })
    }
    // 0.12：解除过关联的会话（unlinked）不出现在详情里；记录还在，重新关联可复活。
    const links = await withTitles(tableAll(store, 'project_session').filter((l) => l.project_id === id && !l.unlinked).map(linkView))
    // 0.13：解除过关联的工作区（unlinked）不出现在详情第3区；记录还在，重新关联可复活。
    const workspaces = tableAll(store, 'project_workspace').filter((w) => w.project_id === id && !w.unlinked)
    // 0.14：交付物现场只读校验（C1）；过滤 unlinked 软删除项；registry 快照取一次复用。
    let dSnap = null
    if (registry && typeof registry.snapshot === 'function') {
      try { dSnap = await registry.snapshot() } catch { dSnap = null }
    }
    /**
     * 0.15.1 任务归属改成**动态**：会话挂到项目 → 它的任务自动属于这个项目；解绑 → 自动离开。
     *
     * 两种归属并存，优先级不同：
     *   ① 人工钉住（project_confidence==='confirmed'）——存在任务记录里，永远优先，不随会话变；
     *   ② 跟随会话（没有钉住时）——**读的时候现算**：任务的主会话现在挂在哪个项目，它就属于哪个项目。
     * 库里即使存着 inferred 的 project_id，也一律以现算为准（存量脏值不会影响显示）。
     */
    const sessionProject = new Map()
    for (const l of tableAll(store, 'project_session')) {
      if (!l || l.unlinked === true) continue
      // 一个会话同时挂多个项目时不猜：置成 null，让这条任务失去归属（跟 attr-v1 的 MULTI_PROJECT 同一口径）。
      sessionProject.set(l.session_id, sessionProject.has(l.session_id) ? null : l.project_id)
    }
    const effectiveProjectOf = (t) => {
      if (t.project_confidence === 'confirmed' && t.project_id) return { pid: t.project_id, source: 'confirmed' }
      const derived = t.primary_session_id ? sessionProject.get(t.primary_session_id) : undefined
      return derived ? { pid: derived, source: 'session' } : { pid: null, source: null }
    }
    const tasks = tableAll(store, 'task')
      .map((t) => ({ t, eff: effectiveProjectOf(t) }))
      .filter((x) => x.eff.pid === id)
      .map(({ t, eff }) => {
        const v = taskView(t)
        v.project_id = id
        v.project_source = eff.source          // 'confirmed' | 'session'
        v.evidence_stale = false               // 动态归属不会"失效"：依据没了它就走了
        return v
      })
      .sort((a, b) => String(a.source_id || '~').localeCompare(String(b.source_id || '~')))
    const myTaskIds = new Set(tasks.map((t) => t.id))
    /**
     * 0.15.0：交付物按**两条路**归属到项目——
     *   ① 直接挂在本项目（d.project_id === id，老数据走这条）；
     *   ② 本项目的任务产出的（d.task_ids 命中本项目任务，新迁移的 123 条走这条）。
     * 只做并集，不改记录：交付物本身仍然 project_id=null，归属是从任务推出来的。
     */
    const deliverablesRaw = tableAll(store, 'deliverable').filter((d) => {
      if (d.unlinked) return false
      if (d.project_id === id) return true
      const ids = Array.isArray(d.task_ids) ? d.task_ids : (d.task_id ? [d.task_id] : [])
      return ids.some((t) => myTaskIds.has(t))
    })
    const deliverables = []
    for (const d of deliverablesRaw) {
      const check = await checkDeliverable(d, dSnap)
      // derived=true 表示"这条不属于本项目，是本项目任务产出的"——前端据此不给「移除」按钮。
      deliverables.push({ ...d, check, derived: d.project_id !== id })
    }
    const keys = new Set([id, ...links.map((l) => l.id)])
    // changelog 倒序 + 上限 100：详情页只用来"看最近发生了什么"，不做全量导出。
    const logs = store.logs()
      .filter((l) => keys.has(l.target_key))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 100)
    /**
     * 「未确认」清单：confidence === 'inferred' 的项目 / 会话 / 工作区 / 交付物。
     * 徽标与依据浮层只读这一个数组，不在前端各自判断一遍——两处判断一定会漂移。
     */
    const staleCount = 0 // 动态归属下不再有"依据失效"状态，字段保留只为兼容旧前端
    const unconfirmed = []
    const project = projectSummary(p)
    if (project.confidence === 'inferred') unconfirmed.push({ kind: 'project', id: project.id, basis: project.basis })
    for (const l of links) if (l.confidence === 'inferred') unconfirmed.push({ kind: 'session', id: l.id, session_id: l.session_id, basis: l.basis })
    for (const w of workspaces) if (w.confidence === 'inferred') unconfirmed.push({ kind: 'workspace', id: w.id, workspace_id: w.workspace_id, basis: w.basis })
    for (const d of deliverables) if (d.confidence === 'inferred') unconfirmed.push({ kind: 'deliverable', id: d.id, title: d.title, basis: d.basis })
    // 任务归属若是推断出来的，同样进「未确认」清单——别让 inferred 混在确认项里。
    for (const t of tasks) if (t.project_confidence === 'inferred') unconfirmed.push({ kind: 'task', id: t.id, title: (t.source_id || '') + ' ' + t.title, basis: t.project_basis })
    return snapshot({
      ok: true, found: true,
      project,
      sessions: links, workspaces, tasks, deliverables, logs,
      counts: {
        sessions: links.length,
        workspaces: workspaces.length,
        tasks: tasks.length,
        tasks_stale: staleCount,
        deliverables: deliverables.length,
        logs: logs.length,
        unconfirmed: unconfirmed.length,
      },
      unconfirmed,
      ...common(),
    })
  }

  /** 某会话属于哪些项目：links 原样 + 对应项目摘要（含 basis / confidence，供徽标与依据浮层用）。 */
  async function linksOfSession(sessionId) {
    const links = await withTitles(tableAll(store, 'project_session')
      .filter((l) => l.session_id === sessionId && !l.unlinked)
      .map(linkView))
    const byId = new Map(store.projects().map((p) => [p.id, p]))
    const items = links.map((l) => {
      const p = byId.get(l.project_id)
      return { ...l, project: p ? projectSummary(p) : null }
    })
    return snapshot({ ok: true, session_id: sessionId, total: items.length, links: items, ...common() })
  }

  /** 搜索：name / objective / next_action / tags 大小写不敏感包含匹配；可按 status 过滤。 */
  function search(q, filter = {}) {
    const needle = String(q ?? '').toLowerCase()
    const status = filter.status || null
    const hits = []
    if (needle.length > 0) {
      for (const p of store.projects()) {
        if (status && p.status !== status) continue
        const matchedIn = []
        if (String(p.name ?? '').toLowerCase().includes(needle)) matchedIn.push('name')
        if (String(p.objective ?? '').toLowerCase().includes(needle)) matchedIn.push('objective')
        if (String(p.next_action ?? '').toLowerCase().includes(needle)) matchedIn.push('next_action')
        if (Array.isArray(p.tags) && p.tags.some((t) => String(t).toLowerCase().includes(needle))) matchedIn.push('tags')
        if (matchedIn.length) hits.push({ project: projectSummary(p), matched_in: matchedIn })
      }
    }
    return snapshot({ ok: true, q: String(q ?? ''), status, total: hits.length, hits, ...common() })
  }

  return { overview, getProject, linksOfSession, search }
}
