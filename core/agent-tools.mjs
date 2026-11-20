/**
 * dsh-project-lite · Agent 工具层（原设想 S4）
 *
 * 分工：Agent 负责「看懂」，插件负责「记住」，人负责「点头」。
 * 三个只读工具 + 两个写工具；写工具只做「建项目」和「关联会话」，
 * 其余写操作（改目标/归档/删）仍只在 UI 由人做。
 *
 * 接口形状来自本机 dsh-tool-working-directory / dsh-tool-session-query 真源码：
 *   inject: ['tools']；ctx.tools.register(defineTool({ name, description, parameters,
 *     output:{schema,render}, execute(args, exec) }))
 * exec.agent 拿调用会话；exec.signal 传递取消。
 *
 * 本模块不 import @deepseek-ai/dsh-tools（测试环境没有），由调用方注入 defineTool。
 * 这样 Node 层可用假 defineTool 测 execute 逻辑，真实 Host 传官方 defineTool。
 */

import { resolveHostSessionId, runAsCaller } from './identity.mjs'

const TOOL_NAMES = ['project_list', 'project_get', 'project_links_of_session', 'project_link_session', 'project_create', 'project_resume', 'propose_checkpoint', 'task_dispatch', 'task_receipts', 'task_receipt_submit', 'task_receipt_decide']

/**
 * 唯一身份来源：宿主 exec。写入类工具一律包在 runAsCaller 里，
 * 这样 Store 侧拿到的身份与工具参数完全无关（参数里的 actor / __identity 会被直接拒绝）。
 */
const callerSid = (exec) => resolveHostSessionId(exec)

/**
 * 写工具入口的“参数洁净”检查：身份类字段一律不许出现在业务参数里。
 * 工具会把参数重建成白名单对象，所以不拦就变成“静默忽略”——忽略虽然安全，但调用方会误以为
 * 自己的 actor 生效了。这里直接报错，语义明确。
 */
const FORBIDDEN_ARG_KEYS = ['actor', '__identity', '_identity', 'identity', 'auth', 'authorization']
function spoofedArgKey(args) {
  if (!args || typeof args !== 'object') return null
  return FORBIDDEN_ARG_KEYS.find((k) => Object.prototype.hasOwnProperty.call(args, k)) || null
}
export { TOOL_NAMES }

/** 态度词黑名单：next_action 必须是动作，不是态度（与 util.mjs / 路由层同口径）。 */
const ATTITUDE_WORDS = ['继续', '推进', '再看看', '待定', '深入研究', 'tbd', 'todo', '待办', '研究一下']

function nextActionInvalid(nextAction) {
  const s = String(nextAction ?? '').trim()
  if (s.length < 4) return '下一步太短（至少 4 个字）：要写成一个能直接执行的动作'
  if (ATTITUDE_WORDS.some((w) => s.toLowerCase().includes(w))) {
    return '下一步不能是态度词（继续/推进/待定/tbd 等）：要写成能直接执行的动作，例如「打开项目面板建第一个项目」'
  }
  return null
}

const textOutput = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * 注册全部工具。
 * @param ctx  Host 上下文，需有 ctx.tools.register
 * @param deps { defineTool, getStore, readService, evidence }
 * @returns 一个 dispose 函数（撤销注册）
 */
export function registerAgentTools(ctx, deps) {
  const { defineTool, getStore, readService, evidence, tools } = deps
  const disposers = []
  const toolSvc = tools || (ctx && ctx.tools)

  const reg = (spec) => {
    const d = toolSvc.register(defineTool(spec))
    if (d && typeof d === 'function') disposers.push(d)
    else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
  }

  // ---- 只读 1：我有哪些项目 ----
  reg({
    name: 'project_list',
    description: '列出 DSH 项目逻辑层里的项目（只读）。返回四组摘要：名称/状态/下一步/计数。数据域降级时照常返回但带 degraded 标记。',
    parameters: { status: { type: 'string', description: '按状态筛选：active/paused/done/archived，省略列全部' } },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args) {
      const s = await getStore()
      await s.refresh()
      const r = readService(s).overview()
      const items = []
      for (const g of r.groups) for (const p of g.items) items.push(p)
      const out = {
        ok: true, total: r.total, counts: r.counts,
        projects: (args && args.status ? items.filter((p) => p.status === args.status) : items)
          .map((p) => ({ id: p.id, name: p.name, status: p.status, next_action: p.next_action, confidence: p.confidence })),
        degraded: r.degraded, metaState: r.metaState,
      }
      if (evidence) evidence({ phase: 'tool-project-list', count: out.projects.length })
      return out
    },
  })

  // ---- 只读 2：这事到哪了 ----
  reg({
    name: 'project_get',
    description: '查一个项目的详情（只读）：目标/完成判据/下一步/关联会话/交付物/最近变更。找不到返回 found:false，不报错。',
    parameters: { project_id: { type: 'string', description: '项目 id，形如 prj_…' } },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args) {
      if (!args || !args.project_id) return { ok: false, error: 'PROJECT_ID_REQUIRED', message: '必须给 project_id' }
      const s = await getStore()
      await s.refresh()
      const r = await readService(s, { titlesOf: deps.titlesOf, registry: deps.registry }).getProject(args.project_id)
      if (evidence) evidence({ phase: 'tool-project-get', id: args.project_id, found: r.found })
      return r
    },
  })

  // ---- Continuity 0.1 只读：项目上下文恢复（高信号摘要，与 project_get 全量详情区分）----
  reg({
    name: 'project_resume',
    description: '恢复一个长期项目的工作上下文（只读）。返回高信号摘要：目标/完成判据/下一步(含过期提示)/最新已确认检查点/待确认数/未决信号/会话与最终交付物引用/可信度汇总。与 project_get 的区别：resume 是小摘要，用于新会话快速接续；project_get 是全量详情。不传 project_id 时先按当前会话的有效 primary 关联解析，再按当前会话所属工作区的项目关联解析；多候选/歧义/注册表不可用会明确返回，绝不猜项目。身份只来自宿主会话，不接受参数冒充。不用于查看全量变更历史或交付物正文。',
    parameters: {
      project_id: { type: 'string', description: '可选：项目 id（prj_…）。不传则按当前会话关联解析' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'ABORTED', message: '调用已取消' }
      const s = await getStore()
      await s.refresh()
      const sid = callerSid(exec)
      let pid = args && args.project_id ? String(args.project_id) : null
      let resolvedVia = pid ? 'explicit' : null
      // A2 项目解析：显式 id > 唯一 active primary > 当前会话工作区→项目（0.18）
      // 身份 sid 只来自宿主 exec；模型传的 workspace_id / session_id 一律不读，防冒充。
      if (!pid) {
        if (!sid) return { ok: true, found: false, state: 'no_identity', resolved_via: null, message: '未提供 project_id，且当前调用不在会话里，无法解析项目', candidates: [] }
        const projects = typeof s.projects === 'function' ? s.projects() : []
        const projectById = (id) => projects.find((p) => p.id === id)
        // ① 现有唯一 primary 解析（原样保留，确保 W7 不回归）
        const links = (typeof s.links === 'function' ? s.links() : []).filter((l) => l && l.session_id === sid && l.unlinked !== true && l.role === 'primary')
        const active = links.map((l) => projectById(l.project_id)).filter((p) => p && p.status === 'active')
        if (active.length === 1) {
          pid = active[0].id; resolvedVia = 'primary'
        } else if (active.length > 1) {
          return { ok: true, found: false, state: 'multiple_candidates', resolved_via: 'primary', message: '当前会话关联多个项目，请明确指定 project_id', candidates: active.map((p) => ({ id: p.id, name: p.name, status: p.status })) }
        } else {
          // ② primary 无结果 → 当前会话所属工作区 → 项目关联（只读解析）
          const reg = deps.registry
          if (!reg || typeof reg.workspaceIdsOf !== 'function') {
            return { ok: true, found: false, state: 'registry_unavailable', resolved_via: 'workspace', message: '无法解析当前会话所属工作区（注册表适配器不可用），不猜项目', candidates: [] }
          }
          let wr
          try { wr = await reg.workspaceIdsOf(sid) } catch (e) { wr = { ok: false, reason: String(e && e.message ? e.message : e) } }
          if (!wr || wr.ok !== true) {
            return { ok: true, found: false, state: 'registry_unavailable', resolved_via: 'workspace', message: 'DSH 工作区注册表不可用，拒绝猜测项目：' + (wr && wr.reason ? wr.reason : '未知原因'), candidates: [] }
          }
          const wsIds = Array.isArray(wr.workspace_ids) ? wr.workspace_ids : []
          if (wsIds.length === 0) {
            return { ok: true, found: false, state: 'no_association', resolved_via: 'workspace', message: '当前会话不在 DSH 工作区注册表里，无法按工作区解析项目', candidates: [] }
          }
          if (wsIds.length > 1) {
            return { ok: true, found: false, state: 'workspace_ambiguous', resolved_via: 'workspace', message: '当前会话同时属于多个工作区，无法唯一确定项目，请明确指定 project_id', candidates: wsIds.map((w) => ({ workspace_id: w })) }
          }
          const wsId = wsIds[0]
          const wsLinks = (typeof s.workspaces === 'function' ? s.workspaces() : [])
            .filter((w) => w && w.workspace_id === wsId && w.unlinked !== true)
          const wsProjects = wsLinks.map((w) => projectById(w.project_id))
            .filter((p) => p && p.status === 'active' && p.status !== 'deleted')
          if (wsProjects.length === 0) {
            return { ok: true, found: false, state: 'no_association', resolved_via: 'workspace', message: '当前工作区没有关联的 active 项目', candidates: [] }
          }
          if (wsProjects.length > 1) {
            return { ok: true, found: false, state: 'multiple_candidates', resolved_via: 'workspace', message: '当前工作区关联多个 active 项目，请明确指定 project_id', candidates: wsProjects.map((p) => ({ id: p.id, name: p.name, status: p.status })) }
          }
          pid = wsProjects[0].id; resolvedVia = 'workspace'
        }
      }
      // 存在性 + 状态检查（deleted 不恢复）
      const target = typeof s.project === 'function' ? s.project(pid) : null
      if (!target) return { ok: false, error: 'PROJECT_NOT_FOUND', message: '项目不存在：' + pid }
      if (target.status === 'deleted') return { ok: false, error: 'PROJECT_DELETED', message: '项目在回收站（deleted），不恢复上下文：' + pid }
      const checkpoints = typeof s.checkpoints === 'function' ? s.checkpoints() : []
      const svc = readService(s, { titlesOf: deps.titlesOf, registry: deps.registry })
      const out = await svc.resume(pid, { checkpoints, sessionId: sid })
      out.resolved_via = resolvedVia
      if (evidence) evidence({ phase: 'tool-project-resume', id: pid, found: out.found, resolved_via: resolvedVia })
      return out
    },
  })

  // ---- 只读 3：这个会话属于哪个项目（徽标的工具版）----
  reg({
    name: 'project_links_of_session',
    description: '查某个会话挂了哪些项目（只读），含依据与置信度。省略 session_id 时用当前调用会话。',
    parameters: { session_id: { type: 'string', description: '会话 id；省略=当前调用会话' } },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      const sid = (args && args.session_id) || callerSid(exec)
      if (!sid) return { ok: false, error: 'SESSION_ID_REQUIRED', message: '没有 session_id，且当前调用不在会话里' }
      const s = await getStore()
      await s.refresh()
      const r = await readService(s, { titlesOf: deps.titlesOf, registry: deps.registry }).linksOfSession(sid)
      return { ok: true, session_id: sid, total: r.total, links: r.links, degraded: r.degraded }
    },
  })

  // ---- 写 1：关联会话（人点头后才调）----
  reg({
    name: 'project_link_session',
    description: '把会话挂到项目（唯一写工具之一）。必须先取得使用者同意；basis 必填、写明依据。重复关联零副作用。不要自动调用。',
    parameters: {
      project_id: { type: 'string', description: '项目 id' },
      session_id: { type: 'string', description: '会话 id；省略=当前会话' },
      role: { type: 'string', description: 'primary 或 supporting；supporting 必须在 basis 里写理由' },
      basis: { type: 'string', description: '必填：为什么挂到这里（例如「用户确认 2026-11-17」或「同工作区」）' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      const spoof = spoofedArgKey(args)
      if (spoof) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '写工具不接受身份字段：' + spoof }
      if (!args || !args.project_id) return { ok: false, error: 'PROJECT_ID_REQUIRED' }
      const hostSid = callerSid(exec)
      // 目标会话：显式参数优先（把**别的**会话挂进来），否则就是当前会话。
      // 注意：这只决定“挂谁”，不决定“谁有权限”——权限永远看 hostSid。
      const sid = args.session_id || hostSid
      if (!hostSid) return { ok: false, error: 'IDENTITY_UNAVAILABLE', message: '拿不到宿主注入的会话身份，拒绝写入' }
      if (!sid) return { ok: false, error: 'SESSION_ID_REQUIRED' }
      const basis = String(args.basis ?? '').trim()
      if (!basis) return { ok: false, error: 'BASIS_REQUIRED', message: 'basis 必填：写清为什么挂到这里' }
      // 严格角色白名单：非法值不许静默升级成 primary（否则非法调用能拿到权威主会话归属）。
      const roleRaw = args.role === undefined || args.role === null || args.role === '' ? 'primary' : args.role
      if (roleRaw !== 'primary' && roleRaw !== 'supporting') {
        return { ok: false, error: 'INVALID_ROLE', message: 'role 只允许 primary / supporting，收到：' + String(roleRaw).slice(0, 40) }
      }
      const role = roleRaw
      if (role === 'supporting' && basis.length < 6) return { ok: false, error: 'SUPPORTING_NEEDS_REASON', message: 'supporting 角色的 basis 要写明理由' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级，拒绝写入' }
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:link' }, () =>
          s.linkSession({ project_id: args.project_id, session_id: sid, role, basis, confidence: 'confirmed' }))
        if (evidence) evidence({ phase: 'tool-link', project: args.project_id, session: sid, changed: r.changed })
        return { ok: true, changed: r.changed !== false, project_id: args.project_id, session_id: sid, rev: r.rev ?? null }
      } catch (e) {
        const code = e && e.code ? e.code : 'LINK_FAILED'
        return { ok: false, error: code, message: String(e && e.message ? e.message : e) }
      }
    },
  })

  // ---- 写 2：建项目（必须用户明确要求；next_action 由人确认）----
  reg({
    name: 'project_create',
    description: '建一个项目（唯一写工具之二）。只有使用者明确说「建个项目」才可调；next_action 必须是使用者确认过的动作，不能自己编。',
    parameters: {
      name: { type: 'string', description: '项目名（≤40 字）' },
      objective: { type: 'string', description: '一句话目标：为什么存在' },
      next_action: { type: 'string', description: '必填：使用者确认过的、可执行的下一步' },
      done_when: { type: 'string', description: '可选：完成条件' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      const spoof2 = spoofedArgKey(args)
      if (spoof2) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '写工具不接受身份字段：' + spoof2 }
      if (!args) return { ok: false, error: 'INVALID_INPUT' }
      const name = String(args.name ?? '').trim()
      const objective = String(args.objective ?? '').trim()
      const bad = nextActionInvalid(args.next_action)
      if (bad) return { ok: false, error: 'NEXT_ACTION_INVALID', message: bad }
      if (name.length === 0 || name.length > 40) return { ok: false, error: 'INVALID_INPUT', message: '名称必填且 ≤40 字' }
      if (objective.length === 0) return { ok: false, error: 'INVALID_INPUT', message: '目标必填' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级，拒绝写入' }
      const hostSid = callerSid(exec)
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:create' }, () => s.createProject({
          name, objective, next_action: String(args.next_action).trim(),
          done_when: args.done_when ? [String(args.done_when).trim()] : undefined,
          session_id: hostSid, basis: '用户明确要求建项目', confidence: 'confirmed',
        }))
        if (evidence) evidence({ phase: 'tool-create', name, id: r && r.project && r.project.id })
        return { ok: true, project: r && r.project ? { id: r.project.id, name: r.project.name, rev: r.project.rev } : null }
      } catch (e) {
        const code = e && e.code ? e.code : 'CREATE_FAILED'
        return { ok: false, error: code, message: String(e && e.message ? e.message : e) }
      }
    },
  })

  // ---- Continuity 0.1 受控写：提交工作进展检查点（人确认后才成为 Resume 权威进展）----
  reg({
    name: 'propose_checkpoint',
    description: '提交一份工作进展检查点（proposed 状态，需人工在面板确认或拒绝）。完成阶段工作后调用：总结做了什么、发现、下一步建议、未决问题。与 project_link_session/project_create 的区别：它不改项目权威字段，只追加一条待确认进展记录。来源会话身份自动取自执行上下文，不接受模型传入的 source_session_id。不要用于自我审批——确认必须由人在 UI 完成。重复调用相同内容（带相同 requestId）不会产生重复记录。',
    parameters: {
      project_id: { type: 'string', description: '项目 id（prj_…）' },
      summary: { type: 'string', description: '本次工作摘要（2-500 字）' },
      completed: { type: 'array', description: '已完成事项列表（可选）' },
      findings: { type: 'array', description: '重要发现列表（可选）' },
      next_action: { type: 'string', description: '建议的下一步（可选，需人工确认）' },
      open_questions: { type: 'array', description: '未决问题列表（可选）' },
      requestId: { type: 'string', description: '可选幂等 id，相同 id 重复提交不重复创建' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'ABORTED', message: '调用已取消' }
      const spoof = spoofedArgKey(args)
      if (spoof) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '不接受身份字段：' + spoof }
      if (!args || !args.project_id) return { ok: false, error: 'PROJECT_ID_REQUIRED' }
      const hostSid = callerSid(exec)
      if (!hostSid) return { ok: false, error: 'IDENTITY_UNAVAILABLE', message: '拿不到宿主会话身份，拒绝提交检查点' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级，拒绝写入' }
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:checkpoint' }, () =>
          s.proposeCheckpoint({
            project_id: args.project_id,
            source_session_id: hostSid,          // 身份只来自 exec，不信参数
            source_session_role: (() => {          // 实际角色查关联，不硬编码；查不到保守记 supporting
              const ls = (typeof s.links === 'function' ? s.links() : []).filter((l) => l && l.session_id === hostSid && l.project_id === args.project_id && l.unlinked !== true)
              const mine = ls.find((l) => l.role === 'primary') || ls[0]
              return mine ? mine.role : 'supporting'
            })(),
            summary: args.summary,
            completed: args.completed,
            findings: args.findings,
            next_action: args.next_action,
            open_questions: args.open_questions,
            client_request_id: args.requestId,
          }))
        if (evidence) evidence({ phase: 'tool-propose-checkpoint', project: args.project_id, id: r.checkpoint && r.checkpoint.id })
        return { ok: true, checkpoint: r.checkpoint, message: '检查点已提交（proposed），请在项目面板确认或拒绝' }
      } catch (e) {
        return { ok: false, error: e && e.code ? e.code : 'CHECKPOINT_FAILED', message: String(e && e.message ? e.message : e) }
      }
    },
  })


  // ---- 0.19 多分支协作：primary 派单（建任务并派给 supporting）----
  reg({
    name: 'task_dispatch',
    description: '建一个任务并派单给某个 supporting 会话（受控写，只有 primary 能调）。这是多分支协作的派单入口：主对话把图片/音频/文稿等子任务派给各分支。身份来自宿主会话。只有使用者明确要求时才建任务；assigned_session_id 必须是本项目的有效 supporting/branch 会话。重复调用相同 requestId 不重复创建。',
    parameters: {
      project_id: { type: 'string', description: '项目 id（prj_…）' },
      title: { type: 'string', description: '任务标题' },
      objective: { type: 'string', description: '任务目标：这一支要产出什么' },
      assigned_session_id: { type: 'string', description: '派给哪个会话（session-…）；省略=建 todo 任务暂时不派' },
      acceptance_criteria: { type: 'array', description: '可选：完成判据列表' },
      note: { type: 'string', description: '可选：备注' },
      requestId: { type: 'string', description: '可选幂等 id' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'ABORTED', message: '调用已取消' }
      const spoof = spoofedArgKey(args)
      if (spoof) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '不接受身份字段：' + spoof }
      if (!args || !args.project_id) return { ok: false, error: 'PROJECT_ID_REQUIRED' }
      const hostSid = callerSid(exec)
      if (!hostSid) return { ok: false, error: 'IDENTITY_UNAVAILABLE', message: '拿不到宿主会话身份，拒绝派单' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级' }
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:dispatch' }, () => s.createTask({
          project_id: args.project_id, title: args.title, objective: args.objective,
          assigned_session_id: args.assigned_session_id, acceptance_criteria: args.acceptance_criteria,
          note: args.note, client_request_id: args.requestId,
        }))
        if (r && r.task && r.task.assigned_session_id) {
          await runAsCaller({ sessionId: hostSid, source: 'tool:dispatch' }, () => s.assignTask({ task_id: r.task.id, assigned_session_id: r.task.assigned_session_id }))
        }
        if (evidence) evidence({ phase: 'tool-task-dispatch', id: r.task && r.task.id, project: args.project_id })
        return { ok: true, task: (await s.task(r.task.id)), message: '任务已建并派单' }
      } catch (e) { return { ok: false, error: e && e.code ? e.code : 'DISPATCH_FAILED', message: String(e && e.message ? e.message : e) } }
    },
  })

  // ---- 0.19 只读：查任务回执 ----
  reg({
    name: 'task_receipts',
    description: '查任务回执（只读）。可按 project_id 或 task_id 过滤；省略则列全部。回执是 supporting 分支交付的证据，状态 submitted/accepted/rejected，accepted 需 primary 裁定，不等于自动完成任务。',
    parameters: {
      project_id: { type: 'string', description: '可选：项目 id 过滤' },
      task_id: { type: 'string', description: '可选：任务 id 过滤' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args) {
      const s = await getStore()
      await s.refresh()
      let list = typeof s.receipts === 'function' ? s.receipts() : []
      if (args && args.task_id) list = list.filter((r) => r.task_id === args.task_id)
      if (args && args.project_id) list = list.filter((r) => r.project_id === args.project_id)
      return { ok: true, total: list.length, receipts: list, degraded: s.degradationReport().degraded }
    },
  })

  // ---- 0.19 受限写：supporting 提交任务回执 ----
  reg({
    name: 'task_receipt_submit',
    description: '提交一份任务回执（受限写）。只有被派单的 supporting/branch 会话能提交，且只能提交派给自己的任务；身份取自宿主会话，不接受参数冒充。回执落 submitted，不自动生效、不等于任务完成——正式状态由 primary 裁定。用于分支办完图片/音频/文稿后把成果交回项目。重复 requestId 不重复提交。',
    parameters: {
      project_id: { type: 'string', description: '项目 id' },
      task_id: { type: 'string', description: '派给本会话的任务 id' },
      summary: { type: 'string', description: '执行摘要（2-500 字）' },
      deliverables: { type: 'array', description: '可选：交付物引用列表（文件路径/链接，只索引不搬运）' },
      result: { type: 'string', description: '结果建议：completed / blocked / needs_revision' },
      requestId: { type: 'string', description: '可选幂等 id' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'ABORTED', message: '调用已取消' }
      const spoof = spoofedArgKey(args)
      if (spoof) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '不接受身份字段：' + spoof }
      if (!args || !args.project_id || !args.task_id) return { ok: false, error: 'PROJECT_TASK_REQUIRED' }
      const hostSid = callerSid(exec)
      if (!hostSid) return { ok: false, error: 'IDENTITY_UNAVAILABLE', message: '拿不到宿主会话身份，拒绝提交回执' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级' }
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:receipt-submit' }, () => s.submitTaskReceipt({
          project_id: args.project_id, task_id: args.task_id,
          source_session_id: hostSid, source_session_role: 'supporting',
          summary: args.summary, deliverables: args.deliverables, result: args.result || 'completed',
          client_request_id: args.requestId,
        }))
        if (evidence) evidence({ phase: 'tool-receipt-submit', id: r.receipt.id, task: args.task_id })
        return { ok: true, receipt: r.receipt, message: '回执已提交（submitted），待 primary 裁定；不自动完成任务' }
      } catch (e) { return { ok: false, error: e && e.code ? e.code : 'RECEIPT_SUBMIT_FAILED', message: String(e && e.message ? e.message : e) } }
    },
  })

  // ---- 0.19 权威写：primary 裁定回执 ----
  reg({
    name: 'task_receipt_decide',
    description: '裁定一份任务回执（受控写，只有 primary 能调）：accepted 或 rejected。这是正式任务状态的唯一入口——分支提交回执后任务停在"做完待验"，只有这里确认后才 accepted、任务才 closed。裁定前请核对回执内容与交付物；裁定后回执不可再改。不要用于自我审批。',
    parameters: {
      receipt_id: { type: 'string', description: '回执 id（rcp_…）' },
      decision: { type: 'string', description: 'accepted 或 rejected' },
      note: { type: 'string', description: '可选：裁定理由' },
      expected_rev: { type: 'number', description: '可选：乐观并发 rev' },
      requestId: { type: 'string', description: '可选幂等 id' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOutput(v) },
    async execute(args, exec) {
      if (exec && exec.signal && exec.signal.aborted) return { ok: false, error: 'ABORTED', message: '调用已取消' }
      const spoof = spoofedArgKey(args)
      if (spoof) return { ok: false, error: 'ACTOR_SPOOF_REJECTED', message: '不接受身份字段：' + spoof }
      if (!args || !args.receipt_id || !args.decision) return { ok: false, error: 'RECEIPT_DECISION_REQUIRED' }
      const hostSid = callerSid(exec)
      if (!hostSid) return { ok: false, error: 'IDENTITY_UNAVAILABLE', message: '拿不到宿主会话身份' }
      const s = await getStore()
      if (!s.writable) return { ok: false, error: 'READONLY_DEGRADED', message: '项目域只读降级' }
      try {
        const r = await runAsCaller({ sessionId: hostSid, source: 'tool:receipt-decide' }, () => s.decideTaskReceipt({
          id: args.receipt_id, decision: args.decision, note: args.note,
          expected_rev: args.expected_rev, client_request_id: args.requestId,
        }))
        if (evidence) evidence({ phase: 'tool-receipt-decide', id: args.receipt_id, decision: args.decision })
        return { ok: true, receipt: r.receipt, message: '回执已裁定 ' + args.decision }
      } catch (e) { return { ok: false, error: e && e.code ? e.code : 'RECEIPT_DECIDE_FAILED', message: String(e && e.message ? e.message : e) } }
    },
  })

  return () => { for (const d of disposers) { try { d() } catch {} } }
}
