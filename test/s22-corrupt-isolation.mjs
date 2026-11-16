/**
 * test/s22-corrupt-isolation.mjs —— 1.11「损坏隔离」的正确落地：
 *
 * 结论先行：**不改名、不新建 .corrupt 文件**。核查（2026-11-16）证明现有实现已经做到
 * "损坏文件原字节不动、不误判新库、reconcile 拒绝落盘"；改名反而会
 *   ① 把诊断从"损坏"降成"缺失" ② 在只读域里做写操作，违背"降级零写盘"。
 *
 * 所以本套件把这些**已成立的行为**用测试钉死，防止以后被改坏。
 *
 * 覆盖：
 *   - global.json 非法 JSON → metaState=corrupt / writable=false / metaSafeToWrite=false
 *   - 判据 G_GLOBAL_CORRUPT，而不是误判 new_legit
 *   - open + reconcile 全程后 global.json 字节 sha256 不变
 *   - 数据目录里没冒出 .corrupt-* / global.json.bak.*
 *   - reconcile 拒绝落盘（persisted=false / META_UNSAFE）
 *   - 对照：正常库 open+reconcile 后 global.json 正常更新（证明测试没坏）
 *
 * 用法：node test\s22-corrupt-isolation.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openStore } from '../core/store.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }
const sha = (b) => createHash('sha256').update(b).digest('hex')

await rm(BASE, { recursive: true, force: true })
const BAD = join(BASE, 'bad')
const GOOD = join(BASE, 'good')
await mkdir(BAD, { recursive: true })

// --- 坏库：先建一个正常库，再把 global.json 写坏（模拟真实损坏，保留数据文件）---
const seed = await openStore({ root: BAD, actor: 's22-seed' })
await seed.createProject({ name: '损坏前的项目', objective: '作为基线', next_action: '验证损坏隔离' })
await seed.close()
// 布局：<root>/project/global.json——和 s16 一样的层级，别少写一层
const gf = join(BAD, 'project', 'global.json')
const beforeBuf = await readFile(gf)
await writeFile(gf, '{ this is not json', 'utf8')
const before = await readFile(gf)
const beforeHash = sha(before)

const s = await openStore({ root: BAD, actor: 's22-probe' })
push('I1', s.metaState === 'corrupt', '非法 JSON → metaState=corrupt（' + s.metaState + '）')
push('I2', s.writable === false && s.metaSafeToWrite === false, '只读且 meta 不可信（writable=' + s.writable + ' metaSafe=' + s.metaSafeToWrite + '）')
push('I3', s.verdict.criteria.some((c) => c.code === 'G_GLOBAL_CORRUPT'), '判据 G_GLOBAL_CORRUPT（不是 new_legit）')
push('I4', !s.verdict.criteria.some((c) => c.code === 'S_AUTHORITY_RECORD_SKIPPED' && c.authority), '没有把坏元数据当作"新库跳过权威记录"')

const rec = await s.reconcile()
push('I5', rec.persisted === false && rec.persistSkippedReason === 'META_UNSAFE', 'reconcile 拒绝落盘（persisted=' + rec.persisted + ' reason=' + rec.persistSkippedReason + '）')
await s.close()

const after = await readFile(gf)
push('I6', sha(after) === beforeHash, 'open + reconcile 全程后 global.json 字节完全不变（sha 一致）')
const rootFiles = await readdir(join(BAD, 'project'))
push('I7', !rootFiles.some((f) => f.startsWith('.corrupt-')) && !rootFiles.some((f) => f.startsWith('global.json.bak')),
  '没有改名成 .corrupt-* / global.json.bak.*（' + rootFiles.join(', ') + '）')

// --- 对照：正常库能正常落盘，证明上面的"拒绝"不是因为测试环境坏了 ---
const good = await openStore({ root: GOOD, actor: 's22-good' })
await good.createProject({ name: '正常项目', objective: 'o', next_action: '作为对照组' })
const grec = await good.reconcile()
push('I8', grec.persisted === true && good.metaSafeToWrite === true, '对照：正常库 reconcile 正常落盘（证明测试环境没坏）')
await good.close()

const pass = steps.filter((x) => x.ok).length
const summary = { at: new Date().toISOString(), suite: 's22-corrupt-isolation', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
