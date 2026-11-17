/**
 * test/s14-create-route.mjs —— 1.3 新建项目（POST /api/project/create）的 Node 层机检。
 *
 * 覆盖范围：
 *   - 正常库能建：200 + project 记录 + 列表立刻 +1 + changelog 落盘 + global.json 基线更新
 *   - 降级库必须被拒：409 READONLY_DEGRADED，且**一个字节都不写**（目录快照逐文件一致）
 *   - 入参不合格：缺字段 / next_action 黑名单 / 过短 / status 非 active / 非法 JSON → 400 且 code 明确
 *   - 方法不对：GET → 405
 *   - 错误形状统一 {ok:false, error:{code,message}}
 *
 * 如实标注：本套件在 Node 层跑假 webServer + 真存储后端，**没有真实 Host、没有 Desktop**，
 * 按状态矩阵 v2 规则 1/3，成果最高算 Implemented，不得冒充 Verified。
 *
 * 用法：node test\s14-create-route.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, unlink, cp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, CREATE_PATH, READ_PATHS, STATE_PATH, SESSIONS_PATH, LINK_PATH, ARCHIVE_PATH, RESTORE_PATH, UNLINK_PATH, DELETE_PATH, WORKSPACES_PATH, LINK_WORKSPACE_PATH, UNLINK_WORKSPACE_PATH, DELIVERABLE_PATH, UNLINK_DELIVERABLE_PATH } from '../index.js'
import { openStore } from '../core/store.mjs'
import { snapshotTree, diffSnapshot, makePush, SID } from './_lib.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = makePush(steps)

await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })

const GOOD = join(BASE, 'good')
const DEGRADED = join(BASE, 'degraded')
const EVIDENCE = join(BASE, 'evidence.jsonl')

/** 造一个健康库：1 条已有项目。 */
async function makeGoodLib(root) {
  const s = await openStore({ root, actor: 's14-fixture' })
  await s.createProject({ name: '既有项目', objective: '作为新建前的基数', next_action: '建第二条项目', session_id: SID(1), basis: 'S14 夹具' })
  await s.close()
}

await makeGoodLib(GOOD)
await cp(GOOD, DEGRADED, { recursive: true })
await unlink(join(DEGRADED, 'project', 'global.json'))

function makeCtx() {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } },
    effect(fn) { effects.push(fn()) },
    storageDomain: undefined,
  }
  return { ctx, routes, effects }
}

/**
 * 假请求/响应：宿主给写路由传的是 Node 原生 req/res（IncomingMessage / ServerResponse），
 * 不是 Fetch 的 Request/Response。测试必须照着真形状造，否则测的是假世界。
 */
function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}

function makeRes() {
  const out = { statusCode: 200, headers: {}, body: '' }
  return {
    out,
    // writeJson 是直接赋值 res.statusCode，所以这里必须是 getter/setter，否则状态码会被吞掉。
    get statusCode() { return out.statusCode },
    set statusCode(v) { out.statusCode = v },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v },
    end(chunk) { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
  }
}

async function call(routes, path, { method = 'GET', query = '', json, contentType = 'application/json' } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const url = 'http://127.0.0.1' + path + (query ? '?' + query : '')
  const rawBody = json === undefined ? undefined : (typeof json === 'string' ? json : JSON.stringify(json))

  if (typeof def.handler === 'function') {
    const headers = {}
    if (rawBody !== undefined && contentType) headers['content-type'] = contentType
    const req = makeReq({ method, url, headers, body: rawBody })
    const res = makeRes()
    await def.handler(req, res)
    let body = null
    try { body = JSON.parse(res.out.body) } catch { /* 非 JSON */ }
    return { status: res.out.statusCode, body, headers: res.out.headers }
  }

  const init = { method }
  if (rawBody !== undefined) {
    init.headers = { 'content-type': contentType || 'application/json' }
    init.body = rawBody
  }
  const req = new Request(url, init)
  const res = await def.resource(req)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body }
}

const VALID = { name: '新项目甲', objective: '验证写入口', next_action: '跑一次完整回归' }

async function runHealthy() {
  const { ctx, routes, effects } = makeCtx()
  apply(ctx, { root: GOOD, evidencePath: EVIDENCE })

  // ---- 1 注册契约 ----
  const expected = [STATE_PATH, ...Object.values(READ_PATHS), CREATE_PATH, SESSIONS_PATH, LINK_PATH, ARCHIVE_PATH, RESTORE_PATH, UNLINK_PATH, DELETE_PATH, WORKSPACES_PATH, LINK_WORKSPACE_PATH, UNLINK_WORKSPACE_PATH, DELIVERABLE_PATH, UNLINK_DELIVERABLE_PATH]
  push('A-1', '17 条路由全部注册（+0.14 deliverable/unlink-deliverable）',
    expected.every((p) => routes.has(p)) && routes.size === 17,
    'registered=' + [...routes.keys()].join(','))
  push('A-2', 'create 路由是 kind:exact', routes.get(CREATE_PATH)?.kind === 'exact',
    'kind=' + routes.get(CREATE_PATH)?.kind)

  // ---- 2 方法 ----
  const get = await call(routes, CREATE_PATH)
  push('A-3', 'GET create → 405 且错误形状统一',
    get.status === 405 && get.body?.ok === false && get.body?.error?.code === 'METHOD_NOT_ALLOWED' && typeof get.body?.error?.message === 'string',
    'status=' + get.status + ' code=' + get.body?.error?.code)

  // ---- 3 入参负例 ----
  const badJson = await call(routes, CREATE_PATH, { method: 'POST', json: '{not json' })
  push('A-4', '非法 JSON → 400 BAD_JSON',
    badJson.status === 400 && badJson.body?.error?.code === 'BAD_JSON',
    'status=' + badJson.status + ' code=' + badJson.body?.error?.code)

  const noCtype = await call(routes, CREATE_PATH, { method: 'POST', json: VALID, contentType: null })
  push('A-4b', '缺 content-type: application/json → 415 JSON_REQUIRED（同时是 CSRF 闸）',
    noCtype.status === 415 && noCtype.body?.error?.code === 'JSON_REQUIRED',
    'status=' + noCtype.status + ' code=' + noCtype.body?.error?.code)

  const noName = await call(routes, CREATE_PATH, { method: 'POST', json: { objective: 'x', next_action: '跑一次回归' } })
  push('A-5', '缺 name → 400 INVALID_INPUT',
    noName.status === 400 && noName.body?.error?.code === 'INVALID_INPUT',
    'status=' + noName.status + ' code=' + noName.body?.error?.code)

  const badNext = await call(routes, CREATE_PATH, { method: 'POST', json: { name: 'a', objective: 'b', next_action: '继续推进' } })
  push('A-6', 'next_action 命中黑名单「继续推进」→ 400 NEXT_ACTION_INVALID',
    badNext.status === 400 && badNext.body?.error?.code === 'NEXT_ACTION_INVALID',
    'status=' + badNext.status + ' code=' + badNext.body?.error?.code)

  const shortNext = await call(routes, CREATE_PATH, { method: 'POST', json: { name: 'a', objective: 'b', next_action: '做' } })
  push('A-7', 'next_action 过短 → 400 NEXT_ACTION_INVALID',
    shortNext.status === 400 && shortNext.body?.error?.code === 'NEXT_ACTION_INVALID',
    'status=' + shortNext.status + ' code=' + shortNext.body?.error?.code)

  const badStatus = await call(routes, CREATE_PATH, { method: 'POST', json: { ...VALID, status: 'done' } })
  push('A-8', 'status=done → 400 INVALID_INPUT（新建只能 active）',
    badStatus.status === 400 && badStatus.body?.error?.code === 'INVALID_INPUT',
    'status=' + badStatus.status + ' code=' + badStatus.body?.error?.code)

  // 负例不得写盘：到这里磁盘应仍只有夹具那 1 条项目
  const afterBad = await snapshotTree(GOOD)
  const projFiles = Object.keys(afterBad).filter((k) => k.includes('project' + '\\') && k.endsWith('.json') && !k.includes('global'))
  push('A-9', '4 个入参负例之后磁盘项目文件数仍是 1（负例零写盘）',
    projFiles.filter((k) => k.includes('\\project\\')).length === 1,
    'projectFiles=' + projFiles.filter((k) => k.includes('\\project\\')).length)

  // ---- 4 正常建 ----
  const beforeCount = (await call(routes, READ_PATHS.overview)).body.total
  const ok = await call(routes, CREATE_PATH, { method: 'POST', json: VALID })
  push('A-10', '正常建 → 200 + ok:true + project.id/name/next_action 正确',
    ok.status === 200 && ok.body?.ok === true && typeof ok.body?.project?.id === 'string'
      && ok.body.project.name === VALID.name && ok.body.project.next_action === VALID.next_action
      && ok.body.project.status === 'active' && typeof ok.body?.at === 'string',
    'status=' + ok.status + ' id=' + ok.body?.project?.id)

  const afterOv = (await call(routes, READ_PATHS.overview)).body
  push('A-11', '建完列表立刻 +1，且新项目在 active 组',
    afterOv.total === beforeCount + 1
      && afterOv.groups.find((g) => g.key === 'active').items.some((p) => p.id === ok.body.project.id),
    'before=' + beforeCount + ' after=' + afterOv.total)

  const after = await snapshotTree(GOOD)
  const newProjectFile = Object.keys(after).find((k) => k.endsWith(ok.body.project.id + '.json'))
  push('A-12', '新项目记录真的落盘', !!newProjectFile, 'file=' + newProjectFile)

  const logs = Object.keys(after).filter((k) => k.includes('changelog'))
  // 注意：存储层落盘时把记录包了一层 { version, record }，直接读顶层会全是 undefined。
  let hasCreateLog = false
  for (const k of logs) {
    try {
      const j = JSON.parse(await readFile(join(GOOD, k), 'utf8'))
      const rec = j && j.record ? j.record : j
      if (rec.op === 'create' && rec.target_key === ok.body.project.id) hasCreateLog = true
    } catch { /* 坏文件跳过 */ }
  }
  push('A-13', 'changelog 记了一条 op=create 且 target_key=新项目 id', hasCreateLog, 'logs=' + logs.length)

  let baselineOk = false
  try {
    const g = JSON.parse(await readFile(join(GOOD, 'project', 'global.json'), 'utf8'))
    const rec = g && g.record ? g.record : g
    baselineOk = !!rec.expected_counts && rec.expected_counts.project === afterOv.total
  } catch { baselineOk = false }
  push('A-14', 'global.json 的 expected_counts.project 已随新建更新', baselineOk,
    'expected=' + afterOv.total)

  for (const d of effects) { try { await d() } catch {} }
}

async function runDegraded() {
  const { ctx, routes, effects } = makeCtx()
  apply(ctx, { root: DEGRADED, evidencePath: EVIDENCE })

  // 预热一次：把"打开域"的副作用排除在零写盘窗口之外
  const warm = await call(routes, READ_PATHS.overview)
  push('B-1', '降级库 overview 可读且 writable=false',
    warm.status === 200 && warm.body?.writable === false && warm.body?.degraded === true,
    'writable=' + warm.body?.writable + ' kind=' + warm.body?.degradation?.kind)

  const beforeCount = (await call(routes, READ_PATHS.overview)).body.total
  const before = await snapshotTree(DEGRADED)
  const r = await call(routes, CREATE_PATH, { method: 'POST', json: VALID })
  const after = await snapshotTree(DEGRADED)
  const diffs = diffSnapshot(before, after)

  push('B-2', '降级库新建 → 409 READONLY_DEGRADED',
    r.status === 409 && r.body?.ok === false && r.body?.error?.code === 'READONLY_DEGRADED',
    'status=' + r.status + ' code=' + r.body?.error?.code)
  push('B-3', '409 响应带 degradation（界面可直接显示原因）',
    typeof r.body?.degradation?.kind === 'string' && typeof r.body?.degradation?.title === 'string',
    'kind=' + r.body?.degradation?.kind)
  push('B-4', '降级被拒后域目录快照逐文件一致（零写盘）',
    diffs.length === 0, 'diffs=' + JSON.stringify(diffs.slice(0, 3)))

  const ov = (await call(routes, READ_PATHS.overview)).body
  push('B-5', '被拒后列表条数不变（没有偷偷建进去）', ov.total === beforeCount, 'before=' + beforeCount + ' after=' + ov.total)

  const ev = await readFile(EVIDENCE, 'utf8').catch(() => '')
  push('B-6', 'evidence.jsonl 记了 create-refused',
    ev.includes('"phase":"create-refused"') || ev.includes('create-refused'),
    'evidenceLines=' + ev.split('\n').filter(Boolean).length)

  for (const d of effects) { try { await d() } catch {} }
}

try {
  await runHealthy()
  await runDegraded()
} catch (e) {
  push('X', '套件未抛异常', false, String(e && e.stack ? e.stack : e))
}

const pass = steps.filter((s) => s.ok).length
const fail = steps.length - pass
const result = { at: new Date().toISOString(), suite: 's14-create-route', total: steps.length, pass, fail, verdict: fail === 0 ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8')
console.log('RESULT ' + result.verdict + ' total=' + result.total + ' pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
