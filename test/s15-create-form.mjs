/**
 * test/s15-create-form.mjs —— 1.3 新建项目表单的 Node 层渲染回归。
 *
 * 用 vm 加载真实 client.js（不是复制逻辑），注入 mock React / fetch / slots：
 *   - 健康态：表单在、四个字段在、按钮可用、空态文案已改（不再说"不提供新建入口"）
 *   - 提交成功：POST 到 api/project/create、body 正确、成功后立刻重拉 overview、表单清空
 *   - 提交失败：后端 {code,message} 显示出来，主面板不白屏
 *   - 降级态：表单 readonly、按钮 disabled、写明原因，且**点也不发请求**（前端闸）
 *   - 静态边界：3 个 slot；写端点只有 create 与 link 两个
 *
 * 如实标注：本套件是 Node 层渲染回归，不是真实 Desktop 截图。
 *
 * 用法：node test\s15-create-form.mjs <OUT.json>
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

/** 深度遍历找满足条件的 vnode。 */
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  if (node.children) for (const c of node.children) findAll(c, pred, out)
  return out
}
const byAttr = (tree, k, v) => findAll(tree, (n) => n.props && n.props[k] === v)

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
  return { React, effects, intervals, reset() { cursor = 0 }, setSlot(i, v) { slots[i] = v }, getSlot(i) { return slots[i] } }
}

const statePayload = {
  ok: true, root: 'ROOT', writable: true, metaState: 'ok',
  degradation: { degraded: false, writable: true, kind: 'ok', title: '', reason: '', blocks: [] },
  reconcile: { pass: 8, fail: 0, skipped: 1, total: 9, persisted: true, coreUnavailable: false, checks: [] },
}
let ovPayload = { ok: true, writable: true, degraded: false, total: 0, counts: {}, groups: [], degradation: { degraded: false } }
let createMode = 'ok'          // ok | fail409 | badjson | throw
const calls = []

async function fakeFetch(url, init) {
  const u = String(url)
  const method = (init && init.method) || 'GET'
  calls.push({ url: u, method, body: init && init.body ? String(init.body) : null })
  if (u.includes('create')) {
    if (createMode === 'throw') throw new Error('network down')
    if (createMode === 'fail409') return { status: 409, json: async () => ({ ok: false, error: { code: 'READONLY_DEGRADED', message: '域处于只读降级，拒绝新建' } }) }
    if (createMode === 'badjson') return { status: 500, json: async () => { throw new Error('not json') } }
    return { status: 200, json: async () => ({ ok: true, at: 'T', project: { id: 'prj_NEW', name: '新项目甲', next_action: '跑一次回归', status: 'active' }, link: null }) }
  }
  if (u.includes('overview')) return { status: 200, json: async () => ovPayload }
  if (u.includes('state')) return { status: 200, json: async () => statePayload }
  throw new Error('unexpected url ' + u)
}

const harness = makeHarness()
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
let currentSlot = null
const ctx = { slots: {
  inject(slot, fn) { currentSlot = slot; fn() },
  register(meta, Comp) { captured[currentSlot === 'main' ? 'main' : 'sidebar'] = Comp },
} }
plugin.apply(ctx)
assert.equal(typeof captured.main, 'function', 'main slot 应注册面板组件')

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
function render() { harness.reset(); harness.effects.length = 0; return captured.main() }

// --- 挂载 ---
let tree = render()
harness.effects.forEach((fn) => fn())
await flush()
tree = render()

// E1-E4 健康态表单
let flat = flatten(tree)
push('E1', flat.attrs['data-create-form'] === '1' && flat.attrs['data-create-state'] === 'ready',
  '健康态：表单在且 state=ready（' + flat.attrs['data-create-state'] + '）')
const fields = ['name', 'objective', 'next_action', 'done_when']
push('E2', fields.every((f) => byAttr(tree, 'data-field', f).length === 1), '四个字段都在：' + fields.join('/'))
const btns = byAttr(tree, 'data-action', 'create-project')
push('E3', btns.length === 1 && !btns[0].props.disabled, '提交按钮在且可用')
push('E4', !flat.text.some((t) => t.includes('不提供新建入口')) && flat.text.some((t) => t.includes('暂无项目记录')),
  '空态文案已改（不再说不提供新建入口）')

// --- 填表 + 提交成功 ---
const setField = (key, val) => {
  const el = byAttr(tree, 'data-field', key)[0]
  el.props.onChange({ target: { value: val } })
}
setField('name', '新项目甲')
setField('objective', '验证写入口')
setField('next_action', '跑一次完整回归')
setField('done_when', '一次回归全绿')
tree = render()
const ovCallsBefore = calls.filter((c) => c.url.includes('overview')).length
const btn = byAttr(tree, 'data-action', 'create-project')[0]
btn.props.onClick()
await flush()
tree = render(); flat = flatten(tree)

const postCalls = calls.filter((c) => c.method === 'POST')
const post = postCalls[0]
push('E5', postCalls.length === 1 && post.url.includes('api/project/create'), '只发了一次 POST 且路径正确：' + (post && post.url))
let bodyOk = false
try {
  const b = JSON.parse(post.body)
  bodyOk = b.name === '新项目甲' && b.objective === '验证写入口' && b.next_action === '跑一次完整回归'
} catch { bodyOk = false }
push('E6', bodyOk, 'POST body 三个必填字段都带上了')
let dwOk = false
try { const b = JSON.parse(post.body); dwOk = Array.isArray(b.done_when) && b.done_when.length === 1 && b.done_when[0] === '一次回归全绿' } catch { dwOk = false }
push('E6b', dwOk, 'done_when 以 string[] 提交（不是裸字符串）')
let rid = null
try { rid = JSON.parse(post.body).requestId } catch { rid = null }
push('E6c', typeof rid === 'string' && /^req_[a-z0-9_]+$/i.test(rid), '新建提交带 requestId（' + rid + '）')
push('E7', calls.filter((c) => c.url.includes('overview')).length === ovCallsBefore + 1, '成功后立刻重拉了一次 overview')
push('E8', flat.text.some((t) => t.includes('已建项目：新项目甲')), '成功提示可见')
const nameInput = byAttr(tree, 'data-field', 'name')[0]
push('E9', nameInput.props.value === '', '成功后表单已清空')

// --- 提交失败 409：错误可见且不白屏 ---
createMode = 'fail409'
setField('name', '第二个')
setField('objective', 'x')
setField('next_action', '跑一次回归')
tree = render()
byAttr(tree, 'data-action', 'create-project')[0].props.onClick()
await flush()
tree = render(); flat = flatten(tree)
push('E10', flat.text.some((t) => t.includes('新建失败：') && t.includes('只读降级')), '409 后端 message 显示出来')
push('E11', flat.text.includes('项目') && flat.attrs['data-project-lite'] === 'panel', '失败时主面板不白屏')
push('E12', !flat.text.some((t) => t.includes('项目面板：读不到数据域状态')), '失败没有升级成主面板整体错误')

// --- 非 JSON 响应也不崩 ---
createMode = 'badjson'
tree = render()
byAttr(tree, 'data-action', 'create-project')[0].props.onClick()
await flush()
tree = render(); flat = flatten(tree)
push('E13', flat.text.some((t) => t.includes('新建失败：')), '响应不是 JSON 时也给出错误行')

// --- 降级态：readonly + 禁用 + 写明原因 + 点也不发请求 ---
createMode = 'ok'
ovPayload = {
  ok: true, writable: false, degraded: true, total: 1, counts: { active: 1 },
  groups: [{ key: 'active', count: 1, items: [{ id: 'prj_1', name: 'Alpha', objective: 'o', next_action: 'n', status: 'active' }] }],
  degradation: { degraded: true, writable: false, kind: 'meta_missing', title: '项目数据只读：元数据文件（global.json）缺失', reason: '元数据不见了', blocks: ['create_project'] },
}
harness.intervals[1](); await flush()
tree = render(); flat = flatten(tree)
const postsBefore = calls.filter((c) => c.method === 'POST').length
push('E14', flat.attrs['data-create-state'] === 'readonly', '降级态表单 state=readonly')
const btn2 = byAttr(tree, 'data-action', 'create-project')[0]
push('E15', btn2.props.disabled === true, '降级态提交按钮 disabled')
push('E16', flat.attrs['data-create-blocked'] === '1' && flat.text.some((t) => t.startsWith('只读：') && t.includes('元数据文件')),
  '降级态写明原因（只读：+ 降级标题）')
btn2.props.onClick()
await flush()
push('E17', calls.filter((c) => c.method === 'POST').length === postsBefore, '降级态即使触发 onClick 也不发请求（前端闸）')

// --- 静态边界 ---
push('E18', (src.match(/slots\.inject\(/g) || []).length === 5, '注入 5 个 slot（main + sidebar.panellist + 2×shell.overlay + 会话头徽标）')
push('E19', (src.match(/method\s*:\s*['"]POST['"]/g) || []).length === 10
  && src.includes("API_CREATE = 'api/project/create'") && src.includes("API_LINK = 'api/project/link'")
  && src.includes("API_ARCHIVE = 'api/project/archive'") && src.includes("API_RESTORE = 'api/project/restore'")
  && src.includes("API_UNLINK = 'api/project/unlink'") && src.includes("API_DELETE = 'api/project/delete'")
  && src.includes("API_LINK_WORKSPACE = 'api/project/link-workspace'") && src.includes("API_UNLINK_WORKSPACE = 'api/project/unlink-workspace'"),
  '十处 POST 调用点（含工作区右键浮层），端点八个')
push('E20', src.includes("const API_CREATE = 'api/project/create'"), '写路径常量就是 api/project/create')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's15-create-form', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
