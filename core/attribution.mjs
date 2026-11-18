/**
 * S1-C：Task → Project 归属规则（纯函数，不碰磁盘）。
 *
 * 为什么要单独一层：
 *   台账是**工作区级**的，没有任何一条 Task 自带 project_id。能站得住的唯一结构化证据是
 *   「这个任务的主会话，被人工关联到了某个项目」。但这是一条**继承**关系，不是事实本身，
 *   所以结论只能标 inferred，永远不许冒充 confirmed。
 *
 * 规则（确定性、可复算、每条都带 reason）：
 *   R1 只认 primary_session；分支持久会话不参与继承（没有证据说明分支代表任务归属）。
 *   R2 关联必须是**有效**的：unlinked !== true（软解绑后不再继承）。
 *   R3 关联自身的 confidence 必须是 confirmed —— inferred 不传递（否则一次猜测会被二次放大）。
 *   R4 一个会话同时关联多个活跃项目 → 冲突，不猜，留 null。
 *   R5 候选项目必须存在且不在回收站（status !== 'deleted'）。
 *   R6 时间窗：任务的**最后来源写入时间**早于项目创建时间 → 任务在项目存在前就结束了，不归属。
 *      （没有来源时间戳的任务不套用这条，缺证据不等于否决。）
 *
 * 注意 R6 只做否决，不做推断：不会因为"时间在项目期内"就认为属于它。
 */

export const ATTRIBUTION_RULE = 'attr-v1'

export const ATTR_REASON_TEXT = {
  OK: '按主会话的项目关联继承（inferred）',
  NO_PRIMARY_SESSION: '任务没有主会话，无法继承',
  NO_PROJECT_LINK: '主会话没有有效的项目关联',
  MULTI_PROJECT: '主会话同时关联多个活跃项目，冲突不猜',
  LINK_UNCONFIRMED: '项目关联本身只是 inferred，不传递',
  LINK_DANGLING: '项目关联指向不存在的项目',
  PROJECT_DELETED: '候选项目在回收站（status=deleted）',
  PREDATES_PROJECT: '任务最后来源写入时间早于项目创建时间',
  OVERRIDE: '人工判定覆盖：按判定表指定项目',
  OVERRIDE_INVALID: '人工判定指向的项目不存在或在回收站',
}

const isActiveLink = (l) => l && typeof l === 'object' && l.unlinked !== true && typeof l.project_id === 'string' && l.project_id.length > 0

/**
 * @param {{tasks?: object[], projects?: object[], links?: object[], overrides?: object[]}} input
 *   overrides：**人工判定表**。规则只能推断"主会话挂了谁"，推断不出"业务上该挂谁"；
 *   人工判定必须能覆盖规则，而且必须可重放（否则脚本一跑就把人手改的覆盖回去）。
 *   每项形如 {source_id|task_id, project_id, confidence, basis, evidence?}。
 * @returns {{rule: string, decisions: object[], summary: object, overrides_applied: number}}
 */
export function planTaskAttribution({ tasks = [], projects = [], links = [], overrides = [] } = {}) {
  const projById = new Map(projects.map((p) => [p && p.id, p]))
  const ovBySource = new Map()
  for (const o of overrides) {
    if (!o || typeof o !== 'object') continue
    const key = o.source_id || o.task_id
    if (key) ovBySource.set(key, o)
  }
  const linksBySession = new Map()
  for (const l of links) {
    if (!isActiveLink(l)) continue
    if (!linksBySession.has(l.session_id)) linksBySession.set(l.session_id, [])
    linksBySession.get(l.session_id).push(l)
  }

  const decisions = []
  for (const t of tasks) {
    const sid = t && t.primary_session_id ? t.primary_session_id : null
    const base = { task_id: t && t.id, source_id: (t && t.source_id) || null, primary_session_id: sid }
    const deny = (reason, extra = {}) => decisions.push({ ...base, project_id: null, confidence: null, basis: null, reason, ...extra })

    // 人工判定优先于任何推断（包括"没有会话关联"这种否决）
    const ov = ovBySource.get(base.source_id) || ovBySource.get(base.task_id)
    if (ov) {
      const p = projById.get(ov.project_id)
      if (!p || p.status === 'deleted') { deny('OVERRIDE_INVALID', { candidates: [ov.project_id] }); continue }
      decisions.push({
        ...base,
        project_id: ov.project_id,
        confidence: ov.confidence === 'confirmed' ? 'confirmed' : 'inferred',
        reason: 'OVERRIDE',
        basis: String(ov.basis || '人工判定（判定表未写依据）'),
        override: true,
        link_basis: null,
        link_rev: null,
      })
      continue
    }

    if (!sid) { deny('NO_PRIMARY_SESSION'); continue }
    const ls = linksBySession.get(sid) || []
    if (ls.length === 0) { deny('NO_PROJECT_LINK'); continue }

    const candidateIds = [...new Set(ls.map((l) => l.project_id))]
    if (candidateIds.length > 1) { deny('MULTI_PROJECT', { candidates: candidateIds }); continue }

    const pid = candidateIds[0]
    const p = projById.get(pid)
    if (!p) { deny('LINK_DANGLING', { candidates: [pid] }); continue }
    if (p.status === 'deleted') { deny('PROJECT_DELETED', { candidates: [pid] }); continue }

    const link = ls.find((l) => l.project_id === pid)
    if (link.confidence && link.confidence !== 'confirmed') { deny('LINK_UNCONFIRMED', { candidates: [pid] }); continue }

    // R6：只否决，不推断。两段时间都必须可解析才判。
    const srcTs = t.source_updated_at || null
    if (srcTs && p.created_at) {
      const a = Date.parse(srcTs)
      const b = Date.parse(p.created_at)
      if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
        deny('PREDATES_PROJECT', { candidates: [pid], task_time: srcTs, project_created_at: p.created_at })
        continue
      }
    }

    decisions.push({
      ...base,
      project_id: pid,
      confidence: 'inferred',
      reason: 'OK',
      basis: '主会话关联继承：' + sid + ' ↔ ' + pid + '（关联依据：' + (link.basis || '未记录') + '；link rev ' + (link.rev ?? '?') + '）',
      link_basis: link.basis || null,
      link_rev: link.rev ?? null,
    })
  }

  return { rule: ATTRIBUTION_RULE, decisions, summary: summarizeAttribution(decisions), overrides_applied: decisions.filter((d) => d.override).length }
}

export function summarizeAttribution(decisions = []) {
  const attributed = decisions.filter((d) => d.project_id)
  const byProject = {}
  for (const d of attributed) byProject[d.project_id] = (byProject[d.project_id] || 0) + 1
  const byReason = {}
  for (const d of decisions) byReason[d.reason] = (byReason[d.reason] || 0) + 1
  return {
    total: decisions.length,
    attributed: attributed.length,
    unassigned: decisions.length - attributed.length,
    by_project: byProject,
    by_reason: byReason,
  }
}

/**
 * 归属写入的最小校验（store 与迁移脚本共用，避免两处判据漂移）。
 * 返回 { ok, code, message }。
 */
export function validateAttributionTarget({ project_id, project, confidence }) {
  if (!project_id) return { ok: true, code: null, message: null } // 允许显式清空
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在：' + project_id }
  if (project.status === 'deleted') return { ok: false, code: 'PROJECT_DELETED', message: '项目在回收站（status=deleted），不能挂任务' }
  if (confidence !== 'confirmed' && confidence !== 'inferred') {
    return { ok: false, code: 'INVALID_CONFIDENCE', message: 'confidence 只能是 confirmed / inferred' }
  }
  return { ok: true, code: null, message: null }
}
