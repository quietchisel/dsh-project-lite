/**
 * test/s19-detail-ui.mjs —— 详情页六分区的 Node 层渲染回归。
 *
 * 用 vm 加载真实 client.js（不复制逻辑），注入 mock React / fetch / slots：
 *   - 点项目名 → 发 GET api/project/get?id=… → 渲染六个 data-section
 *   - 每区空态都有文案（路线图硬约束：空态不许空白）
 *   - inferred → 出现「未确认」徽标（data-badge=inferred）
 *   - found:false → missing 态，不白屏
 *   - 读取失败 → 错误只落在详情块，主面板不白屏
 *
 * 如实标注：Node 层渲染回归，不是真实 Desktop 截图。
 *
 * 用法：node test\s19-detail-ui.mjs <OUT.json>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'client.js')
const OUT = process.argv[2]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

const src = await readFile(SRC, 'utf8')

function flatten(node, out = { text: [], attrs: {}, sections: [], badges: [] }) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'object' && node.props) {
    if (node.props['data-section']) out.sections.push(node.props['data-section'])
    if (node.props['data-badge']) out.badges.push(node.props['data-badge'])
    for (const k of Object.keys(node.props)) if (k.startsWith('data-')) out.attrs[k] = node.props[k]
    flatten(node.children, out)
  }
  return out
}
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  if (node.children) for (const c of node.children) findAll(c, pred, out)
  return out
}
const byAttr = (tree, k, v) => findAll(tree, (n) => n.props && n.props[k] === v)

const OVERVIEW = {
  ok: true, writable: true, degraded: false, metaState: 'ok', total: 1,
  counts: { active: 1, paused: 0, done: 0, archived: 0 },
  groups: [{ key: 'active', count: 1, items: [{ id: 'prj_A', name: '详情项目', objective: 'o', next_action: 'n', status: 'active', confidence: 'inferred', basis: '推断依据', legacy_refs: [{ kind: 'project', original_id: 'old_1', source_doc: '旧台账', note: '迁移过来' }] }] }],
  degradation: { degraded: false, writable: true },
}
const STATE = { ok: true, root: 'R', writable: true, metaState: 'ok', counts: {}, degradation: { degraded: false },
  reconcile: { pass: 9, fail: 0, skipped: 0, total: 9, persisted: true, checks: [] } }
const DETAIL_OK = {
  ok: true, found: true,
  project: { id: 'prj_A', name: '详情项目', objective: '目标甲', next_action: '下一步甲', status: 'active', kind: 'project', confidence: 'inferred', basis: '推断依据', rev: 3, done_when: ['判据一', '判据二'], tags: ['甲', '乙'], legacy_refs: [] },
  sessions: [{ id: 'l1', project_id: 'prj_A', session_id: 'session-aaaa', role: 'primary', confidence: 'confirmed', basis: '确认依据', rev: 1 }],
  workspaces: [],
  deliverables: [],
  logs: [{ id: 'g1', at: '2026-11-16T01:00:00.000Z', op: 'create', summary: '建项目' }],
  counts: { sessions: 1, workspaces: 0, deliverables: 0, logs: 1, unconfirmed: 1 },
  unconfirmed: [{ kind: 'project', id: 'prj_A', basis: '推断依据' }],
  degradation: { degraded: false, writable: true },
}

let detailMode = 'ok'
const calls = []
function fakeFetch(url, init) {
  const method = (init && init.method) || 'GET'
  calls.push({ url: String(url), method, body: init && init.body })
  let payload = OVERVIEW
  const u = String(url)
  if (u.includes('api/project/state')) payload = STATE
  else if (u.includes('api/project/overview')) payload = OVERVIEW
  else if (u.includes('api/project/archive')) payload = { ok: true, project: { ...DETAIL_OK.project, status: 'archived' }, replayed: false }
  else if (u.includes('api/project/sessions')) payload = { ok: true, total: 0, matched: 0, limit: 50, sessions: [] }
  else if (u.includes('api/project/get')) {
    if (detailMode === 'archived') payload = { ...DETAIL_OK, project: { ...DETAIL_OK.project, status: 'archived' } }
    else if (detailMode === 'missing') payload = { ok: true, found: false, project: null, sessions: [], workspaces: [], deliverables: [], logs: [], counts: { sessions: 0, workspaces: 0, deliverables: 0, logs: 0, unconfirmed: 0 }, unconfirmed: [], degradation: { degraded: false } }
    else if (detailMode === 'fail') payload = { ok: false, error: { code: 'INTERNAL_ERROR', message: '炸了' } }
    else payload = DETAIL_OK
  }
  return Promise.resolve({ status: payload.ok === false ? 500 : 200, json: () => Promise.resolve(payload) })
}

function makeHarness() {
  const slots = []
  let cursor = 0
  const effects = []
  const intervals = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) } },
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useCallback(fn) { return fn },
    useEffect(fn) { effects.push(fn) },
  }
  return { React, effects, intervals, reset() { cursor = 0 } }
}

const captured = {}
const harness = makeHarness()
const sandbox = {
  window: { __ModuleLoader__: { load(spec) { captured.spec = spec } } },
  fetch: fakeFetch, console,
  setInterval: (fn) => { harness.intervals.push(fn); return harness.intervals.length },
  clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  Promise, JSON, Object, Array, Number, String, Date, Error, Math, encodeURIComponent,
}
vm.runInNewContext(src, sandbox, { filename: 'client.js' })
const plugin = captured.spec.factory((name) => { if (name === 'react') return harness.React; throw new Error('unexpected require ' + name) })
let currentSlot = null
const ctx = { slots: { inject(slot, fn) { currentSlot = slot; fn() }, register(meta, Comp) { if (currentSlot === 'main') captured.main = Comp } } }
plugin.apply(ctx)

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const render = () => { harness.reset(); harness.effects.length = 0; return captured.main() }

let tree = render()
harness.effects.forEach((fn) => fn())
await flush()
tree = render()
let flat = flatten(tree)

push('T1', flat.sections.length === 0 && !flat.attrs['data-detail'], '未点开时没有详情块')
const btn = byAttr(tree, 'data-action', 'open-detail')[0]
push('T2', !!btn && btn.props['data-for'] === 'prj_A', '项目名是可点入口（data-for=prj_A）')

btn.props.onClick()
await flush()
tree = render(); flat = flatten(tree)
push('T3', calls.some((c) => c.url.includes('api/project/get?id=prj_A') && c.method === 'GET'), '点了之后发 GET api/project/get?id=prj_A')
push('T4', flat.attrs['data-detail-state'] === 'ready', '详情块进入 ready 态')
const want = ['project', 'sessions', 'workspaces', 'deliverables', 'logs', 'basis']
push('T5', want.every((k) => flat.sections.includes(k)), '六个 data-section 都在（' + flat.sections.join(',') + '）')
// 夹具里只有项目是 inferred（会话是 confirmed）→ 依据区恰好 1 个徽标；多一个少一个都算错。
push('T6', flat.badges.filter((b) => b === 'inferred').length === 1, 'inferred 出现「未确认」徽标且只有该出现的那 1 个（' + flat.badges.length + ' 个）')
push('T7', flat.text.some((x) => x.includes('判据一；判据二')), '完成判据按数组渲染（用；连接）')
push('T8', flat.text.some((x) => x.includes('甲 / 乙')), '标签渲染')
push('T9', flat.text.some((x) => x.includes('还没有登记工作区')), '工作区空态有文案（不是空白）')
push('T10', flat.text.some((x) => x.includes('还没有交付物')), '交付物空态有文案')
push('T11', flat.text.some((x) => x.includes('推断依据')), '依据区把 basis 显示出来')

detailMode = 'missing'
byAttr(tree, 'data-action', 'open-detail')[0].props.onClick()
await flush()
tree = render(); flat = flatten(tree)
push('T12', flat.attrs['data-detail-state'] === 'missing' && flat.text.some((x) => x.includes('已经不在了')), 'found:false → missing 态且有一句话')

detailMode = 'fail'
byAttr(tree, 'data-action', 'open-detail')[0].props.onClick()
await flush()
tree = render(); flat = flatten(tree)
push('T13', flat.attrs['data-detail-state'] === 'error' && flat.text.some((x) => x.includes('详情读取失败')), '读取失败 → error 态')
push('T14', flat.attrs['data-project-lite'] === 'panel' && flat.text.includes('项目'), '失败时主面板不白屏')

// --- 响应式（2026-11-16 全屏反馈：右边全空 + 详情看不到下半截）---
detailMode = 'ok'
byAttr(tree, 'data-action', 'open-detail')[0].props.onClick()
await flush()
tree = render()
const dn = findAll(tree, (n) => n.props && n.props['data-detail'] === '1')[0]
push('T15', !!dn && String(dn.props.style.overflowY) === 'auto' && String(dn.props.style.maxHeight).length > 0, '详情块自身可滚动（overflowY=auto + maxHeight）')
push('T16', !!dn && String(dn.props.style.gridTemplateColumns).includes('auto-fit'), '宽屏自动多列（grid auto-fit），窄窗回落 1 列')
const wrapNode = findAll(tree, (n) => n.props && n.props['data-project-lite'] === 'panel')[0]
push('T17', !!wrapNode && String(wrapNode.props.style.maxWidth) === 'none' && String(wrapNode.props.style.width) === '100%', '外层容器随窗口流式（maxWidth=none / width=100%）')
push('T19', !!wrapNode && String(wrapNode.props.style.overflowY) === 'auto' && String(wrapNode.props.style.maxHeight).length > 0, '面板整体可滚（窗口缩小时能看下面）')

// --- 列表行「未确认」徽标 + 依据浮层 ---
tree = render()
const badge = byAttr(tree, 'data-action', 'show-basis')[0]
push('T20', !!badge && badge.props['data-for'] === 'prj_A', 'inferred 项目行有「未确认」徽标（可点）')
badge.props.onClick()
await flush()
tree = render()
const bo = findAll(tree, (n) => n.props && n.props['data-basis-overlay'] === '1')[0]
const botxt = bo ? JSON.stringify(bo) : ''
push('T21', !!bo && botxt.includes('推断依据') && botxt.includes('旧台账'), '点徽标弹出依据浮层，显示 basis 与 legacy_refs')
const closeB = bo ? findAll(bo, (n) => n && n.type === 'button' && Array.isArray(n.children) && n.children.includes('关闭'))[0] : null
push('T22', !!closeB, '依据浮层有关闭按钮')
closeB && closeB.props.onClick()
await flush()
tree = render()
push('T23', !findAll(tree, (n) => n.props && n.props['data-basis-overlay'] === '1').length, '关闭后浮层消失')

// --- 归档：按钮 → 二次确认 → POST → 详情刷新 ---
tree = render()
byAttr(tree, 'data-action', 'open-detail')[0].props.onClick()
await flush()
tree = render()
const askBtn = byAttr(tree, 'data-action', 'ask-archive')[0]
push('T24', !!askBtn, '详情页有「归档」按钮（未归档项目）')
askBtn.props.onClick()
await flush()
tree = render()
push('T25', !!byAttr(tree, 'data-archive-confirm', '1').length, '点归档先出二次确认，不直接发请求')
const postsBeforeArch = calls.filter(c => c.url.includes('archive')).length
byAttr(tree, 'data-action', 'confirm-archive')[0].props.onClick()
await flush()
push('T26', calls.filter(c => c.url.includes('archive') && c.method === 'POST').length === postsBeforeArch + 1, '点确认才发 POST archive')

// 归档项目不再显示「关联会话」按钮：Node mock 无法真实重渲染 overview 状态（ovData 是挂载时的旧快照），
// 这条留给真实桌面截图验证；后端写入口已由 s24 G14/G15 拦住（409 PROJECT_ARCHIVED + 零落盘）。

// --- 关联会话选择器也要能滚（50 条候选会撑爆面板）---
byAttr(tree, 'data-action', 'open-link')[0].props.onClick()
await flush()
tree = render()
const pick = findAll(tree, (n) => n.props && n.props['data-link-form'] === '1')[0]
push('T18', !!pick && String(pick.props.style.overflowY) === 'auto' && String(pick.props.style.maxHeight).length > 0, '关联会话选择器自身可滚动（overflowY=auto + maxHeight）')


const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's19-detail-ui', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
