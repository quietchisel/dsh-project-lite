/**
 * dsh-project-lite —— Host 半（1.1 版，2026-11-15）
 *
 * 保留 0a/0b：GET /api/project/state（降级原因 + 检查状态），client.js 一个字节未改。
 * 新增 1.1：4 条 exact GET 只读路由，把 core/read.mjs 的服务层结果原样交给调用方。
 *
 * 路由契约：
 *   /api/project/overview                     → service.overview()
 *   /api/project/get?id=<pid>                 → service.getProject(id)
 *   /api/project/links-of-session?session_id= → service.linksOfSession(sid)
 *   /api/project/search?q=<q>&status=<st>     → service.search(q, {status})
 *   全部 kind:'exact'；非 GET → 405；缺必填参数 → 400；错误形状统一 {ok:false,error:{code,message}}。
 *
 * 新增 1.3（2026-11-16）：唯一一个写入口 POST /api/project/create。
 *   两层闸：路由层先看 s.writable（refresh 后的实时判据），store.createProject 内部再 assertWritable 一次。
 *   降级 → 409 READONLY_DEGRADED 且一个字节都不写；入参不合格 → 400；其余 → 500。
 *
 * 刻意不做：恢复功能、UI 第三个 slot、任何删除/归档接口（archive 走 store 直调，不开路由）。
 */
import { appendFile, mkdir, stat, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './core/store.mjs'
import { createReadService } from './core/read.mjs'
import { createSessionRegistry } from './core/sessions.mjs'
import { registerAgentTools, TOOL_NAMES } from './core/agent-tools.mjs'
import { loadDefineTool } from './core/hostdeps.mjs'

export const name = 'project-lite'
/** storageDomain 来自 dsh-base；webServer 只有 web/desktop 应用层有（acp 没有，所以那里不激活）。 */
export const inject = ['storageDomain', 'webServer']

export const STATE_PATH = '/api/project/state'

/** 1.1 的四条只读路由。用 query 传参而非路径段：exact 路由不做路径参数匹配。 */
export const READ_PATHS = {
  overview: '/api/project/overview',
  get: '/api/project/get',
  linksOfSession: '/api/project/links-of-session',
  search: '/api/project/search',
}

/** 1.3 唯一的写入口。 */
export const CREATE_PATH = '/api/project/create'

/** 1.4：会话候选列表（只读）。 */
export const SESSIONS_PATH = '/api/project/sessions'
/** 1.4：第二个写入口——把会话挂到项目上（复用 store.linkSession 的真幂等）。 */
export const LINK_PATH = '/api/project/link'
/** 归档（只改 status，不删数据；恢复是后续功能）。 */
export const ARCHIVE_PATH = '/api/project/archive'
/** 恢复（archived → active；与归档对称）。 */
export const RESTORE_PATH = '/api/project/restore'

/** 0.12：解除会话关联 + 软删除项目（回收站）。写路由一律 handler 形状。 */
export const UNLINK_PATH = '/api/project/unlink'
export const DELETE_PATH = '/api/project/delete'

/** 0.13：工作区候选（GET）+ 关联/解除工作区（POST 写）。 */
export const WORKSPACES_PATH = '/api/project/workspaces'
export const LINK_WORKSPACE_PATH = '/api/project/link-workspace'
export const UNLINK_WORKSPACE_PATH = '/api/project/unlink-workspace'

/** 0.14：交付物登记 / 解除索引（只索引不搬运）。 */
export const DELIVERABLE_PATH = '/api/project/deliverable'
export const UNLINK_DELIVERABLE_PATH = '/api/project/unlink-deliverable'

/** Continuity 0.1：检查点列表（GET）+ 人工确认/拒绝（POST 写）。确认必须由人在 UI 触发，不开放 Agent 工具。 */
export const CHECKPOINTS_PATH = '/api/project/checkpoints'
export const CONFIRM_CHECKPOINT_PATH = '/api/project/checkpoint-confirm'
export const REJECT_CHECKPOINT_PATH = '/api/project/checkpoint-reject'
/** 0.21 减负：回执裁定 / 受控项目更新 / 共享收件箱（会话待办）。 */
export const RECEIPT_DECIDE_PATH = '/api/project/receipt-decide'
export const PROJECT_UPDATE_PATH = '/api/project/update'
export const INBOX_PATH = '/api/project/inbox'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 统一错误形状：所有 4xx / 5xx 都长这样，界面不需要分辨是哪条路由报的。 */
function errorBody(code, message) {
  return { ok: false, error: { code, message: String(message) } }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS })
}

/**
 * 写路由必须用 Node 原生 req/res 形状（`handler`），不能用 Fetch 形状的 `resource`：
 * 实测 2026-11-16 —— `resource` 注册的路由收到 POST 时被宿主直接挡成裸 405，根本进不到我们的代码。
 * 只读路由继续用 `resource`（工作正常），写路由走 `handler`。
 */
const BODY_LIMIT = 64 * 1024

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  // 域根：默认 = <home>/storages（dsh-base 的 root）；可用 env / config 指向夹具目录。
  const root = config.root || process.env.DSH_PROJECT_ROOT || join(dshHome(), 'storages')
  const evidencePath = config.evidencePath || join(dshHome(), 'project-lite', 'evidence.jsonl')
  // 1.4：会话注册表与项目域同根（都读 <home>/storages），不另配一个路径。
  const registry = createSessionRegistry({ root })

  /**
   * 0.21 P3：会话发现优先级——公开 sessionQuery seam 优先，拿不到回退 registry（projcache）。
   * 主程序 app.asar 有 sessionQuery ≠ 插件 ctx 能注入；运行时探测，绝不把未验证能力当既有。
   * 返回 {ok, sessions:[{session_id,title,cwd,live,persisted}], source:'sessionQuery'|'registry', degraded }.
   */
  let sqProbeDone = false
  let sqSvc = null
  async function discoverSessions({ q = '', limit = 50 } = {}) {
    if (!sqProbeDone) {
      sqProbeDone = true
      try { sqSvc = (typeof ctx.get === 'function') ? ctx.get('sessionQuery') : null } catch { sqSvc = null }
      await evidence({ phase: 'session-query-probe', available: !!(sqSvc && typeof sqSvc.listSessions === 'function') })
    }
    if (sqSvc && typeof sqSvc.listSessions === 'function') {
      try {
        const recs = await sqSvc.listSessions()
        let items = (Array.isArray(recs) ? recs : (recs && Array.isArray(recs.sessions) ? recs.sessions : []))
          .map((r) => {
            const h = r && r.header
            const sid = h && (h.id || h.session_id) || (r && r.id)
            return {
              session_id: sid,
              title: (h && (h.title || h.name)) || r.title || null,
              cwd: (h && h.cwd) || r.cwd || null,
              live: !!(r && r.live), persisted: !!(r && r.persisted),
            }
          }).filter((x) => x.session_id)
        if (q) items = items.filter((x) => String(x.session_id + ' ' + (x.title || '')).toLowerCase().includes(String(q).toLowerCase()))
        items = items.slice(0, limit)
        return { ok: true, sessions: items, source: 'sessionQuery', total: items.length, matched: items.length }
      } catch (e) {
        await evidence({ phase: 'session-query-error', message: String(e && e.message ? e.message : e) })
        // 公开 seam 调用失败 → 本次回退 registry，不中断
      }
    }
    const data = await registry.list({ q, limit })
    return { ...data, source: 'registry' }
  }


  // 审计 E：证据日志容量上限 + 少量轮转 + session_id 脱敏。
  // 不引第三方日志框架：超 MAX_BYTES 时 evidence.jsonl → .1 → .2（最多 2 个历史），再写新的。
  // 进程内用 promise 链串行化，避免并发请求同时触发轮转；写失败绝不影响主功能。
  const EV_MAX_BYTES = Number(process.env.DSH_EV_MAX_BYTES || 1048576) // 1MB
  const EV_KEEP = 2
  let evQueue = Promise.resolve()
  const maskSid = (v) => {
    if (typeof v !== 'string' || v.length <= 12) return v
    return v.slice(0, 12) + '…' + createHash('sha256').update(v).digest('hex').slice(0, 8)
  }
  async function evidence(obj) {
    if (!evidencePath) return
    const rec = { at: new Date().toISOString(), pid: process.pid, ...obj }
    // 脱敏：会话 id/hash 化，避免正文与完整 id 落盘。
    if (rec.session_id) rec.session_id = maskSid(rec.session_id)
    if (rec.session) rec.session = maskSid(rec.session)
    if (rec.error && typeof rec.error === 'string' && rec.error.length > 300) rec.error = rec.error.slice(0, 300) + '…'
    evQueue = evQueue.then(async () => {
      try {
        await mkdir(join(evidencePath, '..'), { recursive: true })
        let size = 0
        try { size = (await stat(evidencePath)).size } catch {}
        if (size > EV_MAX_BYTES) {
          // 轮转：删最老的 .2，.1→.2，当前→.1
          for (let i = EV_KEEP; i >= 1; i--) {
            try { await rename(i === 1 ? evidencePath : evidencePath + '.' + (i - 1), evidencePath + '.' + i) } catch {}
          }
        }
        await appendFile(evidencePath, JSON.stringify(rec) + '\n', 'utf8')
      } catch { /* 证据写不进去不能影响主功能 */ }
    }).catch(() => {})
    return evQueue
  }

  let store = null
  let opening = null
  async function getStore() {
    if (store) return store
    if (!opening) {
      opening = openStore({ root, facility: ctx.storageDomain, actor: 'project-lite' })
        .then((s) => { store = s; return s })
        .catch((e) => { opening = null; throw e })
    }
    return opening
  }

  /** 每次请求都先只读重算判据：store 长期存活，verdict 不能停在打开那一刻。 */
  async function payload(reconcile) {
    const s = await getStore()
    await s.refresh()
    const out = {
      ok: true,
      at: new Date().toISOString(),
      root,
      writable: s.writable,
      metaState: s.metaState,
      counts: s.counts,
      degradation: s.degradationReport(),
    }
    if (reconcile) {
      // 1.4：对账第 3 条要外部注册表。读不到就传 undefined —— 那条保持 skipped（"没查"），
      // 绝不因为"读不到"就报 pass。会话被删导致的 dangling 判 fail，但 scope=external，不降级。
      let sessionExists
      try {
        const snap = await registry.snapshot()
        if (snap.ok) sessionExists = registry.existsFn(snap)
      } catch { sessionExists = undefined }
      const r = await s.reconcile({ sessionExists })
      out.reconcile = {
        pass: r.pass, fail: r.fail, skipped: r.skipped, total: r.total,
        persisted: r.persisted, coreUnavailable: r.coreUnavailable,
        checks: r.checks,
      }
    }
    return out
  }

  const disposers = []

  // ---- S4 Agent 工具：加分项，拿不到 tools 服务就只跑面板，绝不让主功能不激活 ----
  let disposeTools = null
  try {
    const toolsSvc = typeof ctx.get === 'function' ? ctx.get('tools') : null
    if (toolsSvc && typeof toolsSvc.register === 'function') {
      loadDefineTool().then(({ defineTool, source, notes }) => {
        disposeTools = registerAgentTools(ctx, {
          defineTool,
          tools: toolsSvc,
          getStore,
          readService: createReadService,
          titlesOf: registry.titlesOf,
          registry,
          evidence: (o) => evidence({ ...o, toolSource: source }),
        })
        evidence({ phase: 'agent-tools-registered', source, tools: TOOL_NAMES, notes })
      }).catch((error) => evidence({ phase: 'agent-tools-failed', message: String(error && error.message ? error.message : error) }))
    } else {
      evidence({ phase: 'agent-tools-unavailable', message: 'ctx.tools 不存在，只启用面板' })
    }
  } catch (error) {
    evidence({ phase: 'agent-tools-unavailable', message: String(error && error.message ? error.message : error) })
  }

  // ---- 0a/0b 原有路由，保持行为不变 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    resource: async (request) => {
      const url = new URL(request.url)
      const wantReconcile = url.searchParams.get('reconcile') === '1'
      try {
        const data = await payload(wantReconcile)
        await evidence({ phase: 'state-served', reconcile: wantReconcile, ua: request.headers.get('user-agent') || '' })
        return jsonResponse(data)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        await evidence({ phase: 'state-error', reconcile: wantReconcile, error: message })
        return jsonResponse({ ok: false, error: message }, 500)
      }
    },
  }))

  // ---- 1.1 四条只读路由：路由只做参数校验 + 调服务层，不另算一遍 ----
  const READ_ROUTES = [
    {
      path: READ_PATHS.overview,
      required: [],
      serve: (svc) => svc.overview(),
    },
    {
      path: READ_PATHS.get,
      required: ['id'],
      serve: (svc, params) => svc.getProject(params.get('id')),
    },
    {
      path: READ_PATHS.linksOfSession,
      required: ['session_id'],
      serve: (svc, params) => svc.linksOfSession(params.get('session_id')),
    },
    {
      path: READ_PATHS.search,
      required: ['q'],
      serve: (svc, params) => svc.search(params.get('q'), { status: params.get('status') || null }),
    },
  ]

  for (const def of READ_ROUTES) {
    disposers.push(ctx.webServer.register({
      kind: def.kind || 'exact',
      path: def.path,
      resource: async (request) => {
        if (request.method && request.method !== 'GET') {
          return jsonResponse(errorBody('METHOD_NOT_ALLOWED', 'only GET is allowed: ' + def.path), 405)
        }
        const url = new URL(request.url)
        for (const key of def.required) {
          const v = url.searchParams.get(key)
          if (v === null || v === '') {
            return jsonResponse(errorBody('MISSING_PARAM', 'missing required query param: ' + key), 400)
          }
        }
        try {
          const s = await getStore()
          await s.refresh()
          const data = await def.serve(createReadService(s, { titlesOf: registry.titlesOf, registry }), url.searchParams)
          await evidence({ phase: 'read-served', path: def.path })
          // at 只由路由层加；服务层直出对象 == body 去掉 at 后的内容（验收判据 3）。
          return jsonResponse({ ...data, at: new Date().toISOString() })
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          await evidence({ phase: 'read-error', path: def.path, error: message })
          return jsonResponse(errorBody('INTERNAL_ERROR', message), 500)
        }
      },
    }))
  }

  // ---- 1.3 唯一写入口：建项目 ----
  // 路由层只做三件事：方法判定 / 入参形状 / 调 store。业务校验（next_action 黑名单、长度等）
  // 全留在 store.createProject 里，不在这里复制一份——两处规则一定会漂移。
  const CREATE_ALLOWED_STATUS = ['active']

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CREATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + CREATE_PATH))
      }
      // 只收 JSON：跨站表单发不出 application/json，这一条同时是 CSRF 闸（本路由不发 CORS 头）。
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) {
        return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'request body must be valid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'request body must be a JSON object'))
      }
      const status = (body.status === undefined || body.status === null) ? 'active' : String(body.status)
      if (!CREATE_ALLOWED_STATUS.includes(status)) {
        return writeJson(res, 400, errorBody('INVALID_INPUT', 'status 只允许 ' + CREATE_ALLOWED_STATUS.join('/') + '（新建只能是 active）'))
      }
      try {
        const s = await getStore()
        // 写之前必须 refresh：store 长期存活，verdict 不能停在"打开那一刻"。
        await s.refresh()
        // 第一层闸：路由层自己判，不依赖 store 内部实现。降级时一个字节都不写。
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'create-refused', kind: d.kind })
          return writeJson(res, 409, {
            ...errorBody('READONLY_DEGRADED', '域处于只读降级，拒绝新建：' + (d.title || d.kind)),
            degradation: d,
          })
        }
        // 1.8：指纹只取"决定结果"的字段；改一个字段就是另一个意图，同 requestId 必须被拒。
        const actKey = JSON.stringify({
          op: 'create', name: body.name, objective: body.objective, next_action: body.next_action,
          done_when: body.done_when ?? null, tags: body.tags ?? null, legacy_refs: body.legacy_refs ?? null, session_id: body.session_id ?? null,
          workspace_id: body.workspace_id ?? null, workspace_title: body.workspace_title ?? null, workspace_path: body.workspace_path ?? null,
          basis: body.basis ?? null, confidence: body.confidence ?? null, kind: body.kind ?? null, status,
        })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.createProject({
          name: body.name,
          objective: body.objective,
          next_action: body.next_action,
          done_when: body.done_when,
          tags: body.tags,
          legacy_refs: body.legacy_refs,
          session_id: body.session_id,
          workspace_id: body.workspace_id,
          workspace_title: body.workspace_title,
          workspace_path: body.workspace_path,
          basis: body.basis,
          confidence: body.confidence,
          kind: body.kind,
          status,
        }))
        const out = claimed.value
        await evidence({ phase: 'create-served', project_id: out.project.id, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out.project, link: out.link, workspaceLink: out.workspaceLink ?? null, replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT'
          ? 409
          : (code === 'INTERNAL_ERROR' ? 500 : 400)
        await evidence({ phase: 'create-error', code, message })
        // RECORD_INVALID 带上逐字段 issues：调用方要能自己看出是哪个字段不合法。
        const extra = Array.isArray(error && error.issues) ? { issues: error.issues } : {}
        return writeJson(res, httpStatus, { ...errorBody(code, message), ...extra })
      }
    },
  }))

  // ---- 1.4 只读：会话候选列表 ----
  // 只读路由继续用 resource（Fetch 形状）。注册表读不到时给 REGISTRY_UNAVAILABLE，
  // 让界面明说"读不到会话注册表"，而不是显示一个空列表假装"没有会话"。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: SESSIONS_PATH,
    resource: async (request) => {
      if (request.method && request.method !== 'GET') {
        return jsonResponse(errorBody('METHOD_NOT_ALLOWED', 'only GET is allowed: ' + SESSIONS_PATH), 405)
      }
      const url = new URL(request.url)
      try {
        const data = await discoverSessions({
          q: url.searchParams.get('q') || '',
          limit: url.searchParams.get('limit') || 50,
        })
        if (!data.ok) {
          await evidence({ phase: 'sessions-unavailable', reason: data.reason })
          return jsonResponse(errorBody('REGISTRY_UNAVAILABLE', data.reason || '读不到 DSH 会话注册表'), 200)
        }
        await evidence({ phase: 'sessions-served', matched: data.matched, returned: data.sessions.length, source: data.source })
        return jsonResponse({ ...data, at: new Date().toISOString() })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        await evidence({ phase: 'sessions-error', error: message })
        return jsonResponse(errorBody('INTERNAL_ERROR', message), 500)
      }
    },
  }))

  // ---- 0.13 只读：工作区候选列表（列出 DSH workspace.json 里的真实工作区） ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: WORKSPACES_PATH,
    resource: async (request) => {
      if (request.method && request.method !== 'GET') {
        return jsonResponse(errorBody('METHOD_NOT_ALLOWED', 'only GET is allowed: ' + WORKSPACES_PATH), 405)
      }
      const url = new URL(request.url)
      try {
        const data = await registry.listWorkspaces({
          q: url.searchParams.get('q') || '',
          limit: url.searchParams.get('limit') || 200,
        })
        if (!data.ok) {
          await evidence({ phase: 'workspaces-unavailable', reason: data.reason })
          return jsonResponse(errorBody('REGISTRY_UNAVAILABLE', data.reason || '读不到 DSH 工作区注册表'), 200)
        }
        await evidence({ phase: 'workspaces-served', matched: data.matched, returned: data.workspaces.length })
        return jsonResponse({ ...data, at: new Date().toISOString() })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        await evidence({ phase: 'workspaces-error', error: message })
        return jsonResponse(errorBody('INTERNAL_ERROR', message), 500)
      }
    },
  }))

  // ---- 1.4 写入口：把会话挂到项目 ----
  // 幂等由 store.linkSession 保证（确定性键 + 内容相同则零副作用），路由层不重复实现。
  const LINK_ALLOWED_ROLES = ['primary', 'supporting']

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LINK_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + LINK_PATH))
      }
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) {
        return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'request body must be valid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'request body must be a JSON object'))
      }
      const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      const session_id = typeof body.session_id === 'string' ? body.session_id.trim() : ''
      if (!project_id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: project_id'))
      if (!session_id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: session_id'))
      const role = (body.role === undefined || body.role === null) ? 'primary' : String(body.role)
      if (!LINK_ALLOWED_ROLES.includes(role)) {
        return writeJson(res, 400, errorBody('INVALID_INPUT', 'role 只允许 ' + LINK_ALLOWED_ROLES.join('/')))
      }
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'link-refused', kind: d.kind })
          return writeJson(res, 409, {
            ...errorBody('READONLY_DEGRADED', '域处于只读降级，拒绝关联：' + (d.title || d.kind)),
            degradation: d,
          })
        }
        // 负例闸：注册表里没有这个会话就拒绝，不许手工拼 id 造孤儿 link。
        // 注册表本身读不到时（workspace.json 缺失）不拦，但把 registryChecked=false 记进证据与响应，
        // 对账第 3 条随后会把真实孤儿标出来（external fail，不降级）。
        // 归档项目不能再挂新会话：归档是"收起"，不是"冻结"，但写入口必须关掉。
        const target = s.project(project_id)
        if (target && target.status === 'archived') {
          await evidence({ phase: 'link-refused', reason: 'PROJECT_ARCHIVED' })
          return writeJson(res, 409, errorBody('PROJECT_ARCHIVED', '项目已归档，不能再关联会话（先恢复项目）'))
        }
        // 1.10 fail-closed 三校验：会话在不在、工作区还在不在列表里、工作区目录还在不在。
        // 任一不过 → 400 + 人话原因，零落盘。注册表本身读不到时放行但记 registryChecked=false。
        let registryChecked = false
        try {
          const v = await registry.verify(session_id)
          if (v.ok) {
            registryChecked = true
          } else if (v.code === 'REGISTRY_UNAVAILABLE') {
            registryChecked = false
          } else {
            await evidence({ phase: 'link-refused', reason: v.code, session_id })
            return writeJson(res, 400, errorBody(v.code, v.reason))
          }
        } catch { registryChecked = false }
        const actKey = JSON.stringify({
          op: 'link', project_id, session_id, role,
          basis: body.basis ?? null, confidence: body.confidence ?? null, expected_rev: body.expected_rev ?? null,
        })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.linkSession({
          project_id,
          session_id,
          role,
          basis: body.basis,
          confidence: body.confidence,
          expected_rev: body.expected_rev,
        }))
        const out = claimed.value
        // changed 是 store 挂上去的不可枚举标记：内容完全相同 → false（零副作用）。
        const changed = out.changed === true
        await evidence({ phase: 'link-served', changed, registryChecked, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), link: out, changed, registryChecked, replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404
          // S1-B：双主/回收站属于“状态冲突”，用 409 与 REV_CONFLICT 同档，界面按冲突提示
          : code === 'REV_CONFLICT' || code === 'EXPECTED_REV_REQUIRED' || code === 'REQUEST_ID_CONFLICT'
            || code === 'PROJECT_PRIMARY_CONFLICT' || code === 'PROJECT_DELETED' ? 409
          : code === 'INTERNAL_ERROR' ? 500
          : 400
        await evidence({ phase: 'link-error', code, message })
        const extra = Array.isArray(error && error.issues) ? { issues: error.issues } : {}
        return writeJson(res, httpStatus, { ...errorBody(code, message), ...extra })
      }
    },
  }))

  // ---- 归档：第三个写入口，复用 core 里早就有的 archiveProject ----
  // 二层防误操作：expected_rev（防并发覆盖）+ requestId 幂等（防重复提交）。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ARCHIVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + ARCHIVE_PATH))
      }
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) {
        return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      }
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'body must be a JSON object'))
      }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: id'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'archive-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝归档：' + (d.title || d.kind)), degradation: d })
        }
        const cur = s.project(id)
        if (!cur) {
          return writeJson(res, 404, errorBody('PROJECT_NOT_FOUND', '项目不存在：' + id))
        }
        if (cur.status === 'archived') {
          // 已经归档：零副作用返回，不报错也不再写一条 changelog。
          return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: cur, replayed: true, already_archived: true })
        }
        const actKey = JSON.stringify({ op: 'archive', id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.archiveProject(id, { expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'archive-served', id, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out, replayed: claimed.replayed, already_archived: false })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404
          : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'archive-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 恢复：与归档对称，只改 status，不动子记录 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: RESTORE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed'))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: id'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'restore-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝恢复：' + (d.title || d.kind)), degradation: d })
        }
        const cur = s.project(id)
        if (!cur) return writeJson(res, 404, errorBody('PROJECT_NOT_FOUND', '项目不存在：' + id))
        if (cur.status !== 'archived' && cur.status !== 'deleted') {
          return writeJson(res, 409, errorBody('NOT_ARCHIVED', '项目不是归档/回收站状态（当前 ' + cur.status + '），无需恢复'))
        }
        const actKey = JSON.stringify({ op: 'restore', id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.restoreProject(id, { expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'restore-served', id, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out, replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' || code === 'NOT_ARCHIVED' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'restore-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.12 解除会话关联：第四个写入口，软标记 unlinked，不物理删记录 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: UNLINK_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + UNLINK_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      const session_id = typeof body.session_id === 'string' ? body.session_id.trim() : ''
      if (!project_id || !session_id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'project_id / session_id 必填'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'unlink-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝解除关联：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'unlink', project_id, session_id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.unlinkSession({ project_id, session_id, expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'unlink-served', project_id, session_id, replayed: claimed.replayed, changed: out?.changed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), link: out, replayed: claimed.replayed, changed: !!out?.changed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'LINK_NOT_FOUND' || code === 'PROJECT_NOT_FOUND' ? 404
          : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'unlink-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.12 软删除项目：第五个写入口，status→deleted 进回收站，可恢复 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DELETE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + DELETE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: id'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'delete-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝删除：' + (d.title || d.kind)), degradation: d })
        }
        const cur = s.project(id)
        if (!cur) return writeJson(res, 404, errorBody('PROJECT_NOT_FOUND', '项目不存在：' + id))
        if (cur.status === 'deleted') {
          return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: cur, replayed: true, already_deleted: true })
        }
        const actKey = JSON.stringify({ op: 'delete', id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.deleteProject(id, { expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'delete-served', id, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out, replayed: claimed.replayed, already_deleted: false })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'delete-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.13 写入口：关联 / 解除工作区（软标记，零物理删） ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LINK_WORKSPACE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + LINK_WORKSPACE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      const workspace_id = typeof body.workspace_id === 'string' ? body.workspace_id.trim() : ''
      if (!project_id || !workspace_id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'project_id / workspace_id 必填'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'link-workspace-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝关联工作区：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'link-workspace', project_id, workspace_id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.linkWorkspace({
          project_id, workspace_id,
          workspace_title: body.workspace_title, workspace_path: body.workspace_path,
          basis: body.basis || '界面手动关联工作区', confidence: body.confidence || 'confirmed',
          expected_rev: body.expected_rev,
        }))
        const out = claimed.value
        await evidence({ phase: 'link-workspace-served', project_id, workspace_id, replayed: claimed.replayed, changed: out?.changed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), link: out, replayed: claimed.replayed, changed: !!out?.changed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'link-workspace-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: UNLINK_WORKSPACE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + UNLINK_WORKSPACE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      const workspace_id = typeof body.workspace_id === 'string' ? body.workspace_id.trim() : ''
      if (!project_id || !workspace_id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'project_id / workspace_id 必填'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'unlink-workspace-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝解除工作区：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'unlink-workspace', project_id, workspace_id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.unlinkWorkspace({ project_id, workspace_id, expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'unlink-workspace-served', project_id, workspace_id, replayed: claimed.replayed, changed: out?.changed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), link: out, replayed: claimed.replayed, changed: !!out?.changed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'LINK_NOT_FOUND' || code === 'PROJECT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'unlink-workspace-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.14 交付物：登记（只索引不搬运）/ 解除索引（软标记） ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DELIVERABLE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + DELIVERABLE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!project_id || !title) return writeJson(res, 400, errorBody('MISSING_PARAM', 'project_id / title 必填'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'deliverable-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝登记交付物：' + (d.title || d.kind)), degradation: d })
        }
        // B1：workspace 相对路径 → 查工作区根拼绝对路径快照；absolute → 原样。
        const loc = body.locator || {}
        let locator = null
        if (loc.type === 'workspace' && loc.workspace_id && loc.rel) {
          const snap = await registry.snapshot()
          const ws = (snap.workspaceRows || []).find((w) => w.workspace_id === loc.workspace_id)
          const base = ws && ws.path ? join(ws.path, loc.rel) : null
          locator = { type: 'workspace', workspace_id: loc.workspace_id, rel: loc.rel, base_snapshot: base }
        } else if (loc.type === 'absolute' && loc.path) {
          locator = { type: 'absolute', path: loc.path, base_snapshot: loc.path }
        }
        if (!locator) return writeJson(res, 400, errorBody('INVALID_LOCATOR', 'locator 需 type=workspace(workspace_id+rel) 或 type=absolute(path)'))
        const actKey = JSON.stringify({ op: 'deliverable', project_id, title, locator, kind: body.kind ?? null, is_final: body.is_final ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.addDeliverable({
          project_id, title, kind: body.kind || 'doc', locator,
          is_final: !!body.is_final, size: body.size ?? null, mtime: body.mtime ?? null, sha256: body.sha256 ?? null,
        }))
        const out = claimed.value
        await evidence({ phase: 'deliverable-served', project_id, id: out?.id, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), deliverable: out, replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'PROJECT_NOT_FOUND' || code === 'INVALID_INPUT' || code === 'INVALID_LOCATOR' ? 400
          : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'deliverable-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: UNLINK_DELIVERABLE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + UNLINK_DELIVERABLE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: id'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          await evidence({ phase: 'unlink-deliverable-refused', kind: d.kind })
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝解除索引：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'unlink-deliverable', id, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () => s.unlinkDeliverable(id, { expected_rev: body.expected_rev }))
        const out = claimed.value
        await evidence({ phase: 'unlink-deliverable-served', id, replayed: claimed.replayed, changed: out?.changed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), deliverable: out, replayed: claimed.replayed, changed: !!out?.changed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'REV_CONFLICT' ? 409
          : code === 'LINK_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'unlink-deliverable-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- Continuity 0.1：检查点列表（GET）----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CHECKPOINTS_PATH,
    handler: async (req, res) => {
      const url = new URL(req.url || '', 'http://127.0.0.1')
      const projectId = url.searchParams.get('project_id') || ''
      const status = url.searchParams.get('status') || ''
      try {
        const s = await getStore()
        await s.refresh()
        let list = typeof s.checkpoints === 'function' ? s.checkpoints() : []
        if (projectId) list = list.filter((c) => c.project_id === projectId)
        if (status) list = list.filter((c) => c.status === status)
        // 补来源会话标题（人可读），复用 registry.titlesOf，不落盘、不编造。
        let titleMap = null
        if (registry && typeof registry.titlesOf === 'function' && list.length) {
          try { titleMap = await registry.titlesOf([...new Set(list.map((c) => c.source_session_id))]) } catch { titleMap = null }
        }
        const byId = (id) => titleMap ? (typeof titleMap.get === 'function' ? titleMap.get(id) : titleMap[id]) : null
        const items = list.map((c) => ({ ...c, source_session_title: byId(c.source_session_id) || null }))
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), total: items.length, checkpoints: items })
      } catch (error) {
        return writeJson(res, 500, errorBody('INTERNAL_ERROR', String(error && error.message ? error.message : error)))
      }
    },
  }))

  // 人工确认/拒绝：只接受 POST + JSON；本地人工标记来源，不编造用户 ID；走 claimRequest 幂等。
  for (const [path, phase, method] of [
    [CONFIRM_CHECKPOINT_PATH, 'checkpoint-confirm', 'confirmCheckpoint'],
    [REJECT_CHECKPOINT_PATH, 'checkpoint-reject', 'rejectCheckpoint'],
  ]) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + path))
        const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
        if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
        let body
        try { body = await readJsonBody(req) } catch (error) {
          return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: id'))
        try {
          const s = await getStore()
          await s.refresh()
          if (!s.writable) {
            const d = s.degradationReport()
            await evidence({ phase: phase + '-refused', kind: d.kind })
            return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝操作：' + (d.title || d.kind)), degradation: d })
          }
          const actKey = JSON.stringify({ op: phase, id })
          const human = 'local-human-confirm'
          const claimed = await s.claimRequest(body.requestId, actKey, () =>
            method === 'confirmCheckpoint'
              ? s.confirmCheckpoint({ id, confirmed_by: human })
              : s.rejectCheckpoint({ id, rejected_by: human }))
          const out = claimed.value
          await evidence({ phase: phase + '-served', id, replayed: claimed.replayed })
          return writeJson(res, 200, { ok: true, at: new Date().toISOString(), checkpoint: out.checkpoint, replayed: claimed.replayed })
        } catch (error) {
          const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
          const message = String(error && error.message ? error.message : error)
          const httpStatus = code === 'READONLY_DEGRADED' || code === 'REQUEST_ID_CONFLICT' || code === 'CHECKPOINT_NOT_PROPOSED' ? 409
            : code === 'CHECKPOINT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
          await evidence({ phase: phase + '-error', code, message })
          return writeJson(res, httpStatus, errorBody(code, message))
        }
      },
    }))
  }
  // ---- 0.21 B：回执裁定（面板按钮 → 复用 s.decideTaskReceipt 权威入口，服务端二次校验 primary）----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: RECEIPT_DECIDE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + RECEIPT_DECIDE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const decision = body.decision === 'accepted' || body.decision === 'rejected' ? body.decision : ''
      if (!id || !decision) return writeJson(res, 400, errorBody('MISSING_PARAM', 'need id and decision(accepted/rejected)'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝裁定：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'receipt-decide', id, decision })
        const claimed = await s.claimRequest(body.requestId, actKey, () =>
          s.decideTaskReceipt({ id, decision, note: body.note, expected_rev: body.expected_rev, client_request_id: body.requestId }))
        const out = claimed.value
        // 面板路径 = 人工确认本身（与 checkpoint-confirm 同口径）：openStore 未开 enforceIdentity，
        // 授权来自「人在 UI 点了」，写闸由 writable + claimRequest 幂等 + store 层状态校验把关。
        // Agent 路径（task_receipt_decide 工具）另有 runAsCaller + authorizeWrite 会话级校验，两条入口互不绕过。
        await evidence({ phase: 'receipt-decide-served', id, decision, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), receipt: out && out.receipt, replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'IDENTITY_UNAVAILABLE' || code === 'NOT_PRIMARY' || code === 'READONLY_DEGRADED' || code === 'REV_CONFLICT' || code === 'REQUEST_ID_CONFLICT' ? 409
          : code === 'RECEIPT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'receipt-decide-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.21 D：受控项目更新（面板完成候选收敛按钮 → 复用 s.updateProject）----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: PROJECT_UPDATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only POST is allowed: ' + PROJECT_UPDATE_PATH))
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!ctype.startsWith('application/json')) return writeJson(res, 415, errorBody('JSON_REQUIRED', 'content-type must be application/json'))
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return writeJson(res, 400, errorBody('BAD_JSON', 'invalid JSON: ' + String(error && error.message ? error.message : error)))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return writeJson(res, 400, errorBody('BAD_JSON', 'body must be an object'))
      const pid = typeof body.project_id === 'string' ? body.project_id.trim() : ''
      if (!pid) return writeJson(res, 400, errorBody('MISSING_PARAM', 'missing required body field: project_id'))
      try {
        const s = await getStore()
        await s.refresh()
        if (!s.writable) {
          const d = s.degradationReport()
          return writeJson(res, 409, { ...errorBody('READONLY_DEGRADED', '域只读，拒绝更新：' + (d.title || d.kind)), degradation: d })
        }
        const actKey = JSON.stringify({ op: 'project-update', pid, status: body.status ?? null, next_action: body.next_action ?? null, expected_rev: body.expected_rev ?? null })
        const claimed = await s.claimRequest(body.requestId, actKey, () =>
          s.updateProject({ project_id: pid, status: body.status, next_action: body.next_action, expected_rev: body.expected_rev, client_request_id: body.requestId }))
        const out = claimed.value
        await evidence({ phase: 'project-update-served', id: pid, status: body.status, replayed: claimed.replayed })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out && out.project, changed: !!(out && out.changed), replayed: claimed.replayed })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'IDENTITY_UNAVAILABLE' || code === 'NOT_PRIMARY' || code === 'READONLY_DEGRADED' || code === 'REV_CONFLICT' || code === 'FIELD_NOT_ALLOWED' || code === 'REQUEST_ID_CONFLICT' ? 409
          : code === 'PROJECT_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400
        await evidence({ phase: 'project-update-error', code, message })
        return writeJson(res, httpStatus, errorBody(code, message))
      }
    },
  }))

  // ---- 0.21 共享收件箱：按会话 id 列出派给它的待办任务（只读，读现有任务记录，不另建权威）----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: INBOX_PATH,
    resource: async (req, res) => {
      const url = new URL(req.url || '', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session_id') || ''
      if (!sessionId) return jsonResponse(errorBody('SESSION_ID_REQUIRED', 'need session_id'), 400)
      try {
        const s = await getStore()
        await s.refresh()
        const mine = (typeof s.tasks === 'function' ? s.tasks() : [])
          .filter((t) => t && t.assigned_session_id === sessionId && t.lifecycle === 'active' && t.acceptance !== 'accepted' && t.acceptance !== 'cancelled')
          .map((t) => ({
            id: t.id, source_id: t.source_id || null, title: t.title, objective: t.objective,
            acceptance: t.acceptance, project_id: t.project_id ?? null,
            acceptance_criteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [],
          }))
        await evidence({ phase: 'inbox-served', session: sessionId, count: mine.length })
        return jsonResponse({ ok: true, at: new Date().toISOString(), session_id: sessionId, total: mine.length, tasks: mine })
      } catch (error) {
        return jsonResponse(errorBody('INTERNAL_ERROR', String(error && error.message ? error.message : error)), 500)
      }
    },
  }))

  // 卸载/关闭：先撤全部路由，再关自己的域（共享 facility 时绝不 closeAll）。
  ctx.effect(() => async () => {
    if (disposeTools) { try { disposeTools() } catch {} }
    for (const d of disposers) { try { d() } catch {} }
    if (store) {
      try { await store.close(); await evidence({ phase: 'closed' }) } catch {}
    }
    store = null
    opening = null
  })

  evidence({ phase: 'applied', root, evidencePath, readPaths: Object.values(READ_PATHS) })
}
