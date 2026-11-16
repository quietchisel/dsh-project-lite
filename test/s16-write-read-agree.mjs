/**
 * test/s16-write-read-agree.mjs —— 写路径与读路径必须用同一份 schema。
 *
 * 起因（2026-11-16 真实事故，错误账本 E-10）：
 *   新建表单把 done_when 当字符串写进盘，schema 要的是 string[]。
 *   域层只在 open 时校验磁盘记录，put 不校验，于是——
 *     写入那一刻：成功，界面显示"已建项目"；
 *     下一次开库：记录被 backup-and-skip 隔离，计数 1→0，D3 基线回退，整库降级只读。
 *   结论：非法记录必须在**写的那一刻**被拒，而不是等下次开库才爆。
 *
 * 覆盖：
 *   - done_when 归一化（字符串 / 多行 / 空 / 数组）
 *   - 写进去的记录能过读路径的 ProjectSchema
 *   - close 再 open（真重开，不是内存里自嗨）→ 项目还在、计数 1、无 .bak 隔离
 *   - 非法入参 → RECORD_INVALID，且一个字节都不写（目录快照逐文件一致）
 *   - linkSession / archiveProject 同样受校验保护，重开后仍可读
 *   - 反向对照：绕过 store 直接塞坏记录 → 重开时确实被隔离（证明这道闸还在）
 *
 * 如实标注：Node 层 + 真存储后端，没有真实 Host / Desktop，最高算 Implemented。
 *
 * 用法：node test\s16-write-read-agree.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openStore, normalizeDoneWhen } from '../core/store.mjs'
import { ProjectSchema } from '../core/spec.mjs'
import { snapshotTree, diffSnapshot, SID } from './_lib.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
// 注意：makePush 的签名是 (id, name, ok, detail)，本套件用 (id, ok, detail)，
// 混用会把描述字符串当成 ok → 恒 PASS（2026-11-16 自摆一道，记在这里）。
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
await mkdir(BASE, { recursive: true })

const MAIN = join(BASE, 'main')
const BAD = join(BASE, 'bad')

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- P1 归一化 ---
push('P1', eq(normalizeDoneWhen('一句话判据'), ['一句话判据']), '字符串 → 单元素数组')
push('P2', eq(normalizeDoneWhen(' 甲 \n 乙 \n\n 丙 '), ['甲', '乙', '丙']), '多行 → 多项且去空白/空行')
push('P3', normalizeDoneWhen('') === undefined && normalizeDoneWhen('   ') === undefined && normalizeDoneWhen(undefined) === undefined && normalizeDoneWhen(null) === undefined, '空值 → undefined（字段不落盘）')
push('P4', eq(normalizeDoneWhen(['x', ' y ']), ['x', 'y']), '数组 → 原样（去空白）')

// --- P5 建项目：字符串 done_when ---
const s1 = await openStore({ root: MAIN, actor: 's16-fixture' })
const created = await s1.createProject({
  name: '写读一致验证',
  objective: '证明写进去的东西下次开库还读得出来',
  next_action: '关掉重开再数一遍',
  done_when: '重开后仍是 1 条',
  session_id: SID(7),
  basis: 'S16 夹具',
})
push('P5', eq(created.project.done_when, ['重开后仍是 1 条']), '返回记录里 done_when 已是数组')
const parsed = ProjectSchema.safeParse(created.project)
push('P6', parsed.success, '记录能过读路径同一份 ProjectSchema' + (parsed.success ? '' : ' :: ' + JSON.stringify(parsed.error.issues)))

// 布局：<root>/<unit=project>/<table>/<key>.json（root 就是数据根，unit 名和表名都叫 project）
const diskFile = join(MAIN, 'project', 'project', created.project.id + '.json')
const disk = JSON.parse(await readFile(diskFile, 'utf8'))
push('P7', eq(disk.record.done_when, ['重开后仍是 1 条']), '磁盘上落的就是数组')
await s1.close()

// --- P8 真重开 ---
const s2 = await openStore({ root: MAIN, actor: 's16-reopen' })
const files = await readdir(join(MAIN, 'project', 'project'))
push('P8', s2.counts.project === 1, '重开后计数仍是 1（' + s2.counts.project + '）')
push('P9', s2.projects().length === 1 && s2.projects()[0].id === created.project.id, '重开后那条项目还在')
push('P10', !files.some((f) => f.includes('.bak.')), '重开后没有 .bak 隔离文件')
push('P11', s2.writable === true && s2.verdict.degraded === false, '重开后仍可写、未降级')

// --- P12 非法入参：必须写前被拒，一个字节都不写 ---
const snapA = await snapshotTree(MAIN)
let err = null
try {
  await s2.createProject({ name: '坏项目', objective: 'o', next_action: '这是一句合格的下步动作', kind: 'bogus', basis: 'S16' })
} catch (e) { err = e }
const snapB = await snapshotTree(MAIN)
push('P12', err && err.code === 'RECORD_INVALID', '非法 kind 被拒：' + (err && err.code))
push('P13', Array.isArray(err && err.issues) && err.issues.some((i) => i.path === 'kind'), '错误里带逐字段 issues（kind）')
push('P14', diffSnapshot(snapA, snapB).length === 0, '被拒时一个字节都没写（快照逐文件一致）')

// --- P15 linkSession / archiveProject 也受保护 ---
let err2 = null
try { await s2.linkSession({ project_id: created.project.id, session_id: SID(8), role: 'boss', basis: 'S16' }) } catch (e) { err2 = e }
push('P15', err2 && err2.code === 'RECORD_INVALID', '非法 role 被拒：' + (err2 && err2.code))
const archived = await s2.archiveProject(created.project.id)
push('P16', archived.status === 'archived' && archived.rev === 2, '归档仍能成功（rev 2）')
await s2.close()

const s3 = await openStore({ root: MAIN, actor: 's16-reopen2' })
push('P17', s3.counts.project === 1 && s3.project(created.project.id).status === 'archived', '归档后重开仍读得到（status=archived）')
await s3.close()

// --- P18 反向对照：绕过 store 直接塞坏记录，重开必须被隔离 ---
const s4 = await openStore({ root: BAD, actor: 's16-bad' })
await s4.createProject({ name: '好项目', objective: 'o', next_action: '作为基线那一条', basis: 'S16' })
const goodId = s4.projects()[0].id
// 直接往域里塞一条 schema 不认的记录（模拟历史事故：done_when 写成字符串）
await s4.domain.table('project').put(goodId, { ...s4.project(goodId), done_when: '裸字符串' })
await s4.close()
const s5 = await openStore({ root: BAD, actor: 's16-bad-reopen' })
const badFiles = await readdir(join(BAD, 'project', 'project'))
push('P18', s5.counts.project === 0 && badFiles.some((f) => f.includes('.bak.')), '绕过 store 的坏记录在重开时被隔离（闸仍在）')
push('P19', s5.writable === false && s5.verdict.criteria.some((c) => c.code === 'D3_BASELINE_REGRESSION'), '并被判成 D3 基线回退 → 只读')
await s5.close()

const pass = steps.filter((s) => s.ok).length
const summary = { at: new Date().toISOString(), suite: 's16-write-read-agree', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
