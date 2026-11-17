/**
 * test/s13-overview-panel.mjs —— 1.2 项目列表的 Node 层渲染回归。
 *
 * 用 vm 加载真实 client.js（不是复制逻辑），注入 mock React / fetch / slots：
 *   - 空库显示空态、有数据渲染项目行与四组、降级时只读且给出原因
 *   - 【负例】overview 返回错误时不白屏：主面板 h2/红条/状态区仍在，列表区给局部错误
 *   - 5 秒只读轮询不冲掉列表（沿用独立 ovData state）
 *   - 不新增 slot、不含 POST / 写按钮
 * 如实标注：本套件是 Node 层渲染回归，不是真实 Desktop 截图。
 *
 * 用法：node test\s13-overview-panel.mjs <OUT.json>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'client.js')
const OUT = process.argv[2]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

const src = await readFile(SRC, 'utf8')

/** 把 vnode 树拍平成文本 + 收集 data-* 属性，便于断言。 */
function flatten(node, out = { text: [], attrs: {}, types: [] }) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'object') {
    out.types.push(node.type)
    if (node.props) for (const k of Object.keys(node.props)) if (k.startsWith('data-')) out.attrs[k] = node.props[k]
    flatten(node.children, out)
  }
  return out
}

/** 造一个最小 React：useState 按 slot 顺序持久化，useEffect 收集回调，useCallback 直返。 */
function makeHarness() {
  const slots = []
  let cursor = 0
  const effects = []
  const intervals = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) } },
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useCallback(fn) { return fn },
    useEffect(fn) { effects.push(fn) },
  }
  return {
    React, effects, intervals,
    reset() { cursor = 0 },
    setSlot(i, v) { slots[i] = v },
    getSlot(i) { return slots[i] },
  }
}

let statePayload = {
  ok: true, root: 'ROOT', writable: true, metaState: 'ok',
  degradation: { degraded: false, writable: true, kind: 'ok', title: '', reason: '', blocks: [] },
  reconcile: { pass: 8, fail: 0, skipped: 1, total: 9, persisted: true, coreUnavailable: false, checks: [
    { id: 3, name: 'link.session_id 在 DSH 注册表里存在', status: 'skipped', detail: '未检查：未接入', scope: 'external', severity: 'unverified' },
  ] },
}
let ovPayload = { ok: true, writable: true, degraded: false, total: 0, counts: {}, groups: [] }
let ovMode = 'ok'   // ok | badshape | http500 | throw

async function fakeFetch(url) {
  const u = String(url)
  if (u.includes('overview')) {
    if (ovMode === 'throw') throw new Error('network down')
    if (ovMode === 'http500') return { status: 500, json: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }) }
    if (ovMode === 'badshape') return { status: 200, json: async () => ({ ok: false, error: { code: 'BAD', message: 'bad shape' } }) }
    return { status: 200, json: async () => ovPayload }
  }
  if (u.includes('state')) return { status: 200, json: async () => statePayload }
  throw new Error('unexpected url ' + u)
}

function loadPanel(harness) {
  const captured = { main: null, sidebar: null }
  const windowMock = { __ModuleLoader__: { load(spec) { captured.spec = spec } } }
  const sandbox = {
    window: windowMock, fetch: fakeFetch, console,
    setInterval: (fn) => { harness.intervals.push(fn); return harness.intervals.length },
    clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    Promise, JSON, Object, Array, Number, String, Date, Error, Math,
  }
  vm.runInNewContext(src, sandbox, { filename: 'client.js' })
  const plugin = captured.spec.factory((name) => { if (name === 'react') return harness.React; throw new Error('unexpected require ' + name) })
  assert.ok(plugin && plugin.apply, 'factory 应返回带 apply 的插件对象')
  let currentSlot = null
  const ctx = { slots: {
    inject(slot, fn) { currentSlot = slot; fn() },
    register(meta, Comp) {
      const key = currentSlot === 'main' ? 'main' : 'sidebar'
      captured[key] = Comp
      captured[key === 'main' ? 'mainMeta' : 'sidebarMeta'] = meta
    },
  } }
  plugin.apply(ctx)
  assert.equal(typeof captured.main, 'function', 'main slot 应注册面板组件')
  return captured
}

const harness = makeHarness()
const captured = loadPanel(harness)
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function render() { harness.reset(); harness.effects.length = 0; return captured.main() }

// --- 挂载：先渲染一次以收集 useEffect，再执行 effect（load(true) + loadOverview() + 注册 2 个 interval） ---
let tree = render()
harness.effects.forEach((fn) => fn())
await flush()
tree = render()
let flat = flatten(tree)
push('A0', harness.intervals.length === 2, 'effect 注册了 2 个轮询（主状态 + 项目列表）')

push('A1', flat.text.includes('项目'), '主面板标题仍在')
push('A2', flat.attrs['data-project-lite'] === 'panel', '面板根标记仍在')
push('A3', flat.attrs['data-overview-state'] === 'empty', '空库 -> 空态区块')
push('A4', flat.text.some((t) => t.includes('暂无项目记录')), '空库显示空态文案')

// --- 有数据：四组 + 项目行 ---
ovPayload = {
  ok: true, writable: true, degraded: false, total: 2,
  counts: { active: 1, paused: 1, done: 0, archived: 0 },
  groups: [
    { key: 'active', count: 1, items: [{ id: 'prj_1', name: 'Alpha 改造', objective: '把列表做出来', next_action: '跑截图', status: 'active' }] },
    { key: 'paused', count: 1, items: [{ id: 'prj_2', name: 'Beta 实验', objective: '试渲染', next_action: '待反馈', status: 'paused' }] },
    { key: 'done', count: 0, items: [] }, { key: 'archived', count: 0, items: [] },
  ],
}
ovMode = 'ok'
harness.intervals[1]()   // overview 轮询
await flush()
tree = render(); flat = flatten(tree)
push('A5', flat.attrs['data-overview-state'] === 'ready', '有数据 -> ready')
push('A6', flat.attrs['data-project-id'] !== undefined, '渲染了项目行 data-project-id')
push('A7', flat.text.includes('Alpha 改造') && flat.text.includes('Beta 实验'), '两条项目名都在')
push('A8', flat.text.includes('项目列表（共 2 条）'), '总数显示 2')
push('A9', flat.text.includes('active · 1') && flat.text.includes('paused · 1'), '四组分组头与计数')

// --- 降级：只读 + 原因 ---
ovPayload = { ...ovPayload, writable: false, degraded: true, degradation: { degraded: true, writable: false, kind: 'meta_missing', title: '项目数据只读：元数据文件（global.json）缺失', reason: '磁盘上有记录但元数据不见了', blocks: ['create_project'] } }
harness.intervals[1](); await flush()
tree = render(); flat = flatten(tree)
push('A10', flat.attrs['data-overview-state'] === 'readonly', '降级 -> readonly')
push('A11', flat.text.some((t) => t.startsWith('只读：') && t.includes('元数据文件')), '只读提示含原因标题')
push('A12', flat.text.some((t) => t.includes('磁盘上有记录但元数据不见了')), '只读提示含原因正文')

// --- 【负例】overview 返回错误：不白屏，且保留上一次列表 ---
ovMode = 'http500'
harness.intervals[1](); await flush()
tree = render(); flat = flatten(tree)
push('B1', flat.text.includes('项目'), '错误时主面板标题仍在（不白屏）')
push('B2', flat.attrs['data-project-lite'] === 'panel', '错误时面板根仍在')
push('B3', flat.text.some((t) => t.includes('通过')), '错误时对账状态区仍在')
push('B4', flat.attrs['data-overview-state'] !== undefined, '错误时列表区块仍在')
push('B5', flat.text.some((t) => t.includes('项目列表读取失败')), '错误时给出局部错误提示')
push('B6', flat.text.includes('Alpha 改造'), '错误时保留上一次成功的项目行')
push('B7', !flat.text.some((t) => t.includes('项目面板：读不到数据域状态')), '错误没有升级成主面板整体错误')

// --- 【负例】fetch 抛异常 ---
ovMode = 'throw'
harness.intervals[1](); await flush()
tree = render(); flat = flatten(tree)
push('B8', flat.text.includes('项目') && flat.text.includes('Alpha 改造'), '网络异常也不白屏且保留列表')
push('B9', flat.text.some((t) => t.includes('network down')), '异常信息可见')

// --- 主轮询（state）不冲掉列表 ---
ovMode = 'ok'; ovPayload = { ...ovPayload, degraded: false, writable: true, degradation: { degraded: false } }
harness.intervals[1](); await flush()
for (let i = 0; i < 3; i++) { harness.intervals[0](); await flush() }  // 3 次 5 秒只读轮询
tree = render(); flat = flatten(tree)
push('C1', flat.text.includes('Alpha 改造'), '3 次主轮询后列表仍在')
push('C2', flat.text.some((t) => t.includes('通过')), '3 次主轮询后对账数字仍在（竞态修复未回退）')

// --- 静态边界：不新增 slot、不写 ---
push('D1', (src.match(/slots\.inject\(/g) || []).length === 6, '注入 6 个 slot（main + sidebar.panellist + 3×shell.overlay + 会话头徽标）')
// 1.3 起源码里**有**一个写入口（新建项目）。边界改成：写路径只能有一条，且只能是 POST api/project/create。
// 1.4 起：两个写端点（create / link），三处调用点（面板建项目、面板关联、右键浮层关联）。
push('D2', (src.match(/method\s*:\s*['"]POST['"]/g) || []).length === 13
  && src.includes("API_CREATE = 'api/project/create'") && src.includes("API_LINK = 'api/project/link'")
  && src.includes("API_ARCHIVE = 'api/project/archive'") && src.includes("API_RESTORE = 'api/project/restore'")
  && src.includes("API_UNLINK = 'api/project/unlink'") && src.includes("API_DELETE = 'api/project/delete'")
  && src.includes("API_LINK_WORKSPACE = 'api/project/link-workspace'") && src.includes("API_UNLINK_WORKSPACE = 'api/project/unlink-workspace'")
  && src.includes("API_DELIVERABLE = 'api/project/deliverable'") && src.includes("API_UNLINK_DELIVERABLE = 'api/project/unlink-deliverable'")
  && src.includes("data-action': 'confirm-delete'") && src.includes("data-recycle': '1'"),
  '十个写端点 / 十三处 POST 调用点（含工作区/交付物浮层）')
push('D3', src.includes("const API_OVERVIEW = 'api/project/overview'"), 'overview 走只读 GET 相对路径')
push('D4', src.includes('const [ovData, setOvData]') && src.includes('const [ovError, setOvError]'), 'overview 用独立 state')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's13-overview-panel', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
