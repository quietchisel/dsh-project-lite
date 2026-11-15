/**
 * test/s12-read-routes.mjs —— 1.1 只读服务 + 4 条 exact GET 路由的 Node 层机检。
 *
 * 覆盖范围：
 *   - 4 条路由 kind:'exact'；非 GET 405；缺参数 400；错误形状统一。
 *   - 路由 body 去掉 at 后，与 createReadService() 直出对象深度相等（路由不另算一遍）。
 *   - 空库四组为空；有数据四组计数与 JSON 一致；search / linksOfSession / getProject 结果可复核。
 *   - 降级库（删 global.json）4 条路由仍可读，degraded=true、writable=false、无写入口。
 *   - 零写盘：首次打开之后的连续请求，前后目录快照逐文件一致。
 *   - 服务层 4 个方法是同步函数，不是 Promise（对应「全部同步读内存」）。
 *
 * 如实标注：本套件全部在 Node 层跑假 webServer / 真存储后端，**没有真实 Host、没有 Desktop**，
 * 按状态矩阵 v2 的规则 1/3，本轮成果最高只能算 Implemented，不得冒充 Verified。
 *
 * 用法：node test\s12-read-routes.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, unlink, cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, READ_PATHS, STATE_PATH } from '../index.js'
import { openStore } from '../core/store.mjs'
import { createReadService, STATUS_GROUPS } from '../core/read.mjs'
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

/** 造一个有数据的库：4 个不同状态的项目 + 2 个会话关联。 */
async function makeGoodLib(root) {
  const s = await openStore({ root, actor: 's12-fixture' })
  await s.createProject({ name: 'Alpha 工作区改造', objective: '把项目逻辑层做出来', next_action: '完成四条只读路由机检', tags: ['S1'], session_id: SID(1), basis: 'S1 夹具' })
  await s.createProject({ name: 'Beta 界面实验', objective: '试 main slot 渲染', next_action: '跑一次桌面截图', tags: ['UI'], session_id: SID(2), basis: 'S1 夹具' })
  await s.createProject({ name: 'Gamma 归档件', objective: '已结束的事', next_action: '核对交付物清单', session_id: SID(3), basis: 'S1 夹具' })
  await s.createProject({ name: 'Delta 暂停件', objective: '等待外部反馈', next_action: '收到审计回执后定稿', session_id: SID(4), basis: 'S1 夹具' })
  const all = s.projects()
  // Beta → paused，Gamma → archived（用 domain 直改，避免 archiveProject 写额外 changelog 干扰基线）
  const beta = all.find((p) => p.name.startsWith('Beta'))
  const gamma = all.find((p) => p.name.startsWith('Gamma'))
  const delta = all.find((p) => p.name.startsWith('Delta'))
  await s.domain.table('project').update(beta.id, (p) => ({ ...p, status: 'paused' }))
  await s.domain.table('project').update(gamma.id, (p) => ({ ...p, status: 'archived' }))
  await s.domain.table('project').update(delta.id, (p) => ({ ...p, status: 'paused' }))
  const alpha = all.find((p) => p.name.startsWith('Alpha'))
  // createProject 不接收 tags 参数（见 store.mjs L210-232），tags 只能由 domain 直写补上。
  // 第一轮机检 A-10 失败即因此：夹具里写的 tags:['S1'] 被静默丢弃，不是 search 实现错。
  await s.domain.table('project').update(alpha.id, (p) => ({ ...p, tags: ['S1', '只读'] }))
  await s.linkSession({ project_id: alpha.id, session_id: SID(9), role: 'supporting', basis: 'S1 夹具：另一会话', confidence: 'confirmed', source: 'manual' })
  await s.close()
  return { alpha: alpha.id, beta: beta.id, gamma: gamma.id, delta: delta.id }
}

const IDS = await makeGoodLib(GOOD)

/** 造降级库：复制健康库后删掉 global.json（有数据 + 元数据缺失 → meta_missing）。 */
await cp(GOOD, DEGRADED, { recursive: true })
await unlink(join(DEGRADED, 'project', 'global.json'))

/** 假 webServer：把注册的路由收进 Map；effect 收集 disposer。 */
function makeCtx() {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register(def) {
        routes.set(def.path, def)
        return () => routes.delete(def.path)
      },
    },
    effect(fn) { effects.push(fn()) },
    storageDomain: undefined, // 让 openStore 走自建后端（独立运行路径），不依赖 Host
  }
  return { ctx, routes, effects }
}

async function call(routes, path, { method = 'GET', query = '' } = {}) {
  const def = routes.get(path)
  if (!def) throw new Error('route not registered: ' + path)
  const req = new Request('http://127.0.0.1' + path + (query ? '?' + query : ''), { method })
  const res = await def.resource(req)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 时留 null，由断言报出 */ }
  return { status: res.status, headers: res.headers, body }
}

async function runSuite(label, root, expectDegraded) {
  const { ctx, routes, effects } = makeCtx()
  apply(ctx, { root, evidencePath: EVIDENCE })

  // ---- 1 注册契约 ----
  const expected = [STATE_PATH, ...Object.values(READ_PATHS)]
  // 1.3 起多了 POST /api/project/create，所以总数是 6；本条只保证「1.1 的那 5 条都在」。
  push(label + '-1', 'state + 4 条只读路由全部注册（1.3 后总数为 6）',
    expected.every((p) => routes.has(p)) && routes.size === 6,
    'registered=' + [...routes.keys()].join(','))
  const newRoutes = Object.values(READ_PATHS).map((p) => routes.get(p))
  push(label + '-2', '新增 4 条均为 kind:exact',
    newRoutes.every((d) => d && d.kind === 'exact'),
    newRoutes.map((d) => d && d.kind).join(','))

  // ---- 2 方法 / 参数 / 错误形状 ----
  const post = await call(routes, READ_PATHS.overview, { method: 'POST' })
  push(label + '-3', '非 GET → 405 且错误形状统一',
    post.status === 405 && post.body && post.body.ok === false && typeof post.body.error?.code === 'string' && typeof post.body.error?.message === 'string',
    'status=' + post.status + ' body=' + JSON.stringify(post.body))
  const missing = await Promise.all([
    call(routes, READ_PATHS.get),
    call(routes, READ_PATHS.linksOfSession),
    call(routes, READ_PATHS.search),
  ])
  push(label + '-4', '三条缺必填参数 → 400 且 code=MISSING_PARAM、形状一致',
    missing.every((r) => r.status === 400 && r.body?.ok === false && r.body?.error?.code === 'MISSING_PARAM' && typeof r.body?.error?.message === 'string'),
    missing.map((r) => r.status + ':' + r.body?.error?.code).join(' '))

  // ---- 3 首次请求之后再拍快照：把「打开域」排除在零写盘窗口之外 ----
  const warm = await call(routes, READ_PATHS.overview)
  const before = await snapshotTree(root)

  // ---- 4 四条路由 body 与服务层直出深度相等 ----
  const s = await openStore({ root })
  const svc = createReadService(s)
  const cases = [
    { path: READ_PATHS.overview, query: '', direct: () => svc.overview() },
    { path: READ_PATHS.get, query: 'id=' + encodeURIComponent(IDS.alpha), direct: () => svc.getProject(IDS.alpha) },
    { path: READ_PATHS.linksOfSession, query: 'session_id=' + encodeURIComponent(SID(1)), direct: () => svc.linksOfSession(SID(1)) },
    { path: READ_PATHS.search, query: 'q=' + encodeURIComponent('Alpha'), direct: () => svc.search('Alpha') },
  ]
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const r = await call(routes, c.path, { query: c.query })
    const direct = c.direct()
    const stripped = { ...(r.body || {}) }
    delete stripped.at
    let eq = false
    try { assert.deepStrictEqual(stripped, direct); eq = true } catch { /* 下面报差异 */ }
    push(label + '-5.' + (i + 1), c.path + ' body(去 at) == 服务层直出',
      r.status === 200 && eq && typeof r.body?.at === 'string' && typeof direct.then !== 'function',
      'status=' + r.status + ' eq=' + eq + ' directIsPromise=' + (typeof direct.then === 'function'))
  }
  push(label + '-5.5', '服务层 4 个方法都是同步函数（不是 Promise）',
    [svc.overview(), svc.getProject(IDS.alpha), svc.linksOfSession(SID(1)), svc.search('x')]
      .every((v) => typeof v.then !== 'function'),
    'all sync')

  // ---- 5 四组与业务正确性 ----
  const ov = (await call(routes, READ_PATHS.overview)).body
  push(label + '-6', '四组顺序写死且 counts 与 items 长度一致',
    JSON.stringify(ov.groups.map((g) => g.key)) === JSON.stringify(STATUS_GROUPS)
      && ov.groups.every((g) => g.count === g.items.length)
      && ov.total === 4 && ov.counts.active === 1 && ov.counts.paused === 2 && ov.counts.done === 0 && ov.counts.archived === 1,
    'total=' + ov.total + ' counts=' + JSON.stringify(ov.counts))

  const got = (await call(routes, READ_PATHS.get, { query: 'id=' + encodeURIComponent(IDS.alpha) })).body
  push(label + '-7', 'getProject 命中：found=true 且带关联会话（Alpha 有 primary+supporting 两条）',
    got.found === true && got.project?.name.startsWith('Alpha') && got.sessions.length === 2,
    'found=' + got.found + ' sessions=' + got.sessions.length)
  const miss = (await call(routes, READ_PATHS.get, { query: 'id=prj_NOTEXIST' })).body
  push(label + '-8', 'getProject 未命中：200 + found=false（不是 500）',
    miss.status === undefined && miss.ok === true && miss.found === false && miss.project === null,
    'found=' + miss.found)

  const los = (await call(routes, READ_PATHS.linksOfSession, { query: 'session_id=' + encodeURIComponent(SID(9)) })).body
  push(label + '-9', 'linksOfSession 返回该会话的项目 + basis（依据）',
    los.total === 1 && los.links[0].project?.id === IDS.alpha && los.links[0].role === 'supporting' && los.links[0].basis.length > 0,
    'total=' + los.total + ' role=' + los.links[0]?.role)

  const byTag = (await call(routes, READ_PATHS.search, { query: 'q=S1' })).body
  const byStatus = (await call(routes, READ_PATHS.search, { query: 'q=' + encodeURIComponent('工作区') + '&status=paused' })).body
  const byNext = (await call(routes, READ_PATHS.search, { query: 'q=' + encodeURIComponent('四条只读') })).body
  push(label + '-10', 'search 命中 tags / next_action，status 过滤生效',
    byTag.total === 1 && byTag.hits[0].matched_in.includes('tags')
      && byNext.total === 1 && byNext.hits[0].matched_in.includes('next_action')
      && byStatus.total === 0,
    'tag=' + byTag.total + ' next=' + byNext.total + ' statusFiltered=' + byStatus.total)

  // ---- 6 可信度上下文 ----
  push(label + '-11', (expectDegraded ? '降级库' : '健康库') + '：writable / degraded 与 degradationReport 一致',
    ov.writable === (expectDegraded ? false : true)
      && ov.degraded === (expectDegraded ? true : false)
      && ov.degradation?.kind === (expectDegraded ? 'meta_missing' : 'ok')
      && (expectDegraded ? ov.degradation.blocks.includes('create_project') && !ov.degradation.canStill.includes('create_project') : true),
    'writable=' + ov.writable + ' degraded=' + ov.degraded + ' kind=' + ov.degradation?.kind)

  // ---- 7 零写盘 ----
  const after = await snapshotTree(root)
  const diffs = diffSnapshot(before, after)
  push(label + '-12', '连续 4 类路由请求前后域目录快照逐文件一致（零写盘）',
    diffs.length === 0, 'diffs=' + JSON.stringify(diffs.slice(0, 3)))

  // 清理：撤路由 + 关域
  for (const d of effects) { try { await d() } catch {} }
  await s.close()
}

try {
  await runSuite('A', GOOD, false)
  await runSuite('B', DEGRADED, true)
} catch (e) {
  push('X', '套件未抛异常', false, String(e && e.stack ? e.stack : e))
}

const pass = steps.filter((s) => s.ok).length
const fail = steps.length - pass
const result = { at: new Date().toISOString(), suite: 's12-read-routes', total: steps.length, pass, fail, verdict: fail === 0 ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8')
console.log('RESULT ' + result.verdict + ' total=' + result.total + ' pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
