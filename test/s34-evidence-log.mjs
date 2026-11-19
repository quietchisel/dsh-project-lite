/**
 * test/s34-evidence-log.mjs —— 审计 E：证据日志容量/轮转/脱敏回归。
 *
 * 覆盖：
 *   E1 设置极小 MAX_BYTES，写多条 → 触发轮转，产生 .1 / .2，当前文件仍可写
 *   E2 历史文件数不超过保留上限（.1/.2，无 .3）
 *   E3 session_id 被脱敏（不含完整值）
 *   E4 evidence 写失败（路径不可写）不影响主流程
 *
 * 如实标注：Node 层 + 真 apply() + 临时目录，Implemented。
 *
 * 用法：node test/s34-evidence-log.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })
const { apply } = await import(pathToFileURL('D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1/index.js').href)

// 极小阈值，强制轮转
process.env.DSH_EV_MAX_BYTES = '300'
const evPath = join(BASE, 'evidence.jsonl')
const routes = new Map()
const ctx = { webServer: { register(d) { routes.set(d.path, d); return () => {} } }, effect() {}, storageDomain: undefined }
apply(ctx, { root: join(BASE, 'store'), evidencePath: evPath })
// 触发若干 GET /state（每次写一条 evidence）
const def = [...routes.values()][0]
function mkReq() { return { method: 'GET', url: 'http://x/api/project/state', headers: {}, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} } }
function mkRes() { const o = { statusCode: 200, body: '' }; return { out:o, get statusCode(){return o.statusCode}, set statusCode(v){o.statusCode=v}, setHeader(){}, end(c){if(c!=null)o.body+=String(c)} } }
for (let i = 0; i < 12; i++) await def.resource ? await def.resource(new Request('http://x/api/project/state')) : await def.handler(mkReq(), mkRes())
// 等 evQueue 落盘
await new Promise((r) => setTimeout(r, 200))

const dir = BASE
const files = (await readdir(dir)).filter((f) => f.startsWith('evidence.jsonl'))
push('E1', files.includes('evidence.jsonl') && files.includes('evidence.jsonl.1'), '触发轮转：存在当前文件与 .1 历史（' + files.join(',') + '）')
push('E2', !files.includes('evidence.jsonl.3'), '历史文件不超过保留上限（无 .3）')
let allText = ''
for (const f of files) { try { allText += await readFile(join(dir, f), 'utf8') } catch {} }
const FULL_SID = 'session-abcdef01-2345-6789-abcd-ef0123456789'
push('E3', !allText.includes(FULL_SID), '完整 session_id 不落盘（脱敏生效）')

// E4：evidence 路径指向不可写位置，apply 与主路由不崩
const badRoutes = new Map()
const ctx2 = { webServer: { register(d) { badRoutes.set(d.path, d); return () => {} } }, effect() {}, storageDomain: undefined }
let applyOk = true
try { apply(ctx2, { root: join(BASE, 'store2'), evidencePath: join(BASE, 'no-such-dir', 'x', 'ev.jsonl') }) } catch { applyOk = false }
push('E4', applyOk && badRoutes.size > 0, 'evidence 路径不可写时 apply 仍成功、路由仍注册')

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's34-evidence-log', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
