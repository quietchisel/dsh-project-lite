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

const TOOL_NAMES = ['project_list', 'project_get', 'project_links_of_session', 'project_link_session', 'project_create']

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

  return () => { for (const d of disposers) { try { d() } catch {} } }
}
