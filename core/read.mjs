/**
 * core/read.mjs —— S1 的 1.1 工作包：只读服务层。
 *
 * 契约（对应 00-今日推进计划.md §3）：
 *   1. 四个方法全部同步读内存（domain.table 的 entries），不写盘、不写元数据、不触发 reconcile。
 *   2. 返回值一律是可 JSON 序列化的纯数据快照；路由层直接 JSON.stringify，不另算一遍。
 *   3. 降级态下照常可读（degradationReport().canStill 含 read），但绝不提供任何写入口。
 *   4. 分组顺序写死 active → paused → done → archived，不做智能排序（路线图 v2 §1.3）。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，也不 import store.mjs —— 只依赖传入的 store 对象，
 * 因此 Node 层可独立机检，不依赖宿主 Host。
 */

/** 四组固定顺序。 */
export const STATUS_GROUPS = ['active', 'paused', 'done', 'archived']

/** 统一过一遍 JSON，保证「服务层直出」与「路由 body」逐字段相等（丢掉 undefined / 函数 / 原型）。 */
const snapshot = (x) => JSON.parse(JSON.stringify(x))

function tableAll(store, name) {
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
    created_at: p.created_at,
    updated_at: p.updated_at,
    rev: p.rev,
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
 * @param store openStore() 返回的 store（长期存活，verdict 由路由层 refresh() 保鲜）
 * @returns {{overview:Function, getProject:Function, linksOfSession:Function, search:Function}}
 */
export function createReadService(store) {
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
  function getProject(id) {
    const p = store.project(id)
    if (!p) {
      return snapshot({
        ok: true, found: false, project: null,
        sessions: [], workspaces: [], deliverables: [], logs: [],
        ...common(),
      })
    }
    const links = tableAll(store, 'project_session').filter((l) => l.project_id === id).map(linkView)
    const workspaces = tableAll(store, 'project_workspace').filter((w) => w.project_id === id)
    const deliverables = tableAll(store, 'deliverable').filter((d) => d.project_id === id)
    const keys = new Set([id, ...links.map((l) => l.id)])
    const logs = store.logs().filter((l) => keys.has(l.target_key))
    return snapshot({
      ok: true, found: true,
      project: projectSummary(p),
      sessions: links, workspaces, deliverables, logs,
      ...common(),
    })
  }

  /** 某会话属于哪些项目：links 原样 + 对应项目摘要（含 basis / confidence，供徽标与依据浮层用）。 */
  function linksOfSession(sessionId) {
    const links = tableAll(store, 'project_session')
      .filter((l) => l.session_id === sessionId)
      .map(linkView)
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
