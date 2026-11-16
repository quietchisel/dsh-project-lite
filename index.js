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
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './core/store.mjs'
import { createReadService } from './core/read.mjs'

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

  async function evidence(obj) {
    if (!evidencePath) return
    try {
      await mkdir(join(evidencePath, '..'), { recursive: true })
      await appendFile(evidencePath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...obj }) + '\n', 'utf8')
    } catch { /* 证据写不进去不能影响主功能 */ }
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
      const r = await s.reconcile()
      out.reconcile = {
        pass: r.pass, fail: r.fail, skipped: r.skipped, total: r.total,
        persisted: r.persisted, coreUnavailable: r.coreUnavailable,
        checks: r.checks,
      }
    }
    return out
  }

  const disposers = []

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
          const data = def.serve(createReadService(s), url.searchParams)
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
        const out = await s.createProject({
          name: body.name,
          objective: body.objective,
          next_action: body.next_action,
          done_when: body.done_when,
          session_id: body.session_id,
          basis: body.basis,
          confidence: body.confidence,
          kind: body.kind,
          status,
        })
        await evidence({ phase: 'create-served', project_id: out.project.id })
        return writeJson(res, 200, { ok: true, at: new Date().toISOString(), project: out.project, link: out.link })
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'INTERNAL_ERROR'
        const message = String(error && error.message ? error.message : error)
        const httpStatus = code === 'READONLY_DEGRADED' ? 409 : (code === 'INTERNAL_ERROR' ? 500 : 400)
        await evidence({ phase: 'create-error', code, message })
        // RECORD_INVALID 带上逐字段 issues：调用方要能自己看出是哪个字段不合法。
        const extra = Array.isArray(error && error.issues) ? { issues: error.issues } : {}
        return writeJson(res, httpStatus, { ...errorBody(code, message), ...extra })
      }
    },
  }))

  // 卸载/关闭：先撤全部路由，再关自己的域（共享 facility 时绝不 closeAll）。
  ctx.effect(() => async () => {
    for (const d of disposers) { try { d() } catch {} }
    if (store) {
      try { await store.close(); await evidence({ phase: 'closed' }) } catch {}
    }
    store = null
    opening = null
  })

  evidence({ phase: 'applied', root, evidencePath, readPaths: Object.values(READ_PATHS) })
}
