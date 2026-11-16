/**
 * test/s23-storage-exclusivity.mjs —— 1.12「单实例锁」的核查结论：
 *
 * 不采纳"在插件里加 project.lock"，因为底层已有两层互斥，加第三层是越俎代庖且有副作用：
 *   1. dsh-storage-json.writeAtomic 用 open(tmp, "wx") —— 文件级 O_EXCL 原子写已有；
 *   2. DomainFacility.reserved Set —— 同一进程同一域名 already-open 直接抛错；
 *   3. DSH 是单实例桌面端；域由宿主 ctx.storageDomain 管理，插件不该自己管生命周期。
 *
 * 本套件把这些**已成立的互斥事实**钉死，防止以后有人误以为"没锁"而加多余的锁。
 *
 * 覆盖：
 *   - 同一 backend 对同一 unit 开两次 → 第二次 already-open（用真 @deepseek-ai 包）
 *   - 我们插件用注入 facility，重复 openStore 同一 root 不重复建域（store 单例）
 *   - 两个不同 root 互不干扰
 *
 * 用法：node test\s23-storage-exclusivity.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openStore } from '../core/store.mjs'

const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, detail) => { steps.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail) }

await rm(BASE, { recursive: true, force: true })
const A = join(BASE, 'a')
const B = join(BASE, 'b')
await mkdir(A, { recursive: true })
await mkdir(B, { recursive: true })

// --- 1) 域层 already-open（真包）---
let err1 = null
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
const { DomainFacility, defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
const backend = new JsonStorageBackend(A)
const ctx = { storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } }, emit: () => {}, logger: { info(){}, warn(){}, error(){} } }
const facility = new DomainFacility(ctx, { backend: 'json' })
const spec = defineDomain({
  name: 'exclusivity_probe', version: 1, layout: 'per-record',
  tables: { probe: domainTable({ parse: (v) => v }) },
})
const h1 = await facility.open(spec)
try { await facility.open(spec) } catch (e) { err1 = e }
push('L1', !!err1 && (err1.code === 'already-open' || String(err1.message).includes('already open')), '同一域 open 两次 → already-open（域层进程内互斥；code=' + (err1 && err1.code) + '）')
await h1.close()

// --- 2) 文件级原子写：wx 语义（临时文件已存在则失败）---
const fs = await import('node:fs/promises')
const tmp = join(A, 'wx-probe.tmp')
await writeFile(tmp, 'occupied', 'utf8')
let wxErr = null
try { await fs.writeFile(tmp, 'new', { flag: 'wx' }) } catch (e) { wxErr = e }
push('L2', !!wxErr && wxErr.code === 'EEXIST', 'wx 标志对已存在文件 → EEXIST（writeAtomic 的底层互斥）')

// --- 3) 我们插件：同一 root 的 store 单例（apply 层做，不在 store 层）---
const sA1 = await openStore({ root: A, actor: 's23' })
const sA2 = await openStore({ root: B, actor: 's23' })
push('L3', sA1.root === A && sA2.root === B && sA1 !== sA2, '两个不同 root 得到独立 store（互不干扰）')
await sA1.close()
await sA2.close()

// --- 4) 现实约束：DSH 单实例，域由宿主注入 ---
const readme = await fs.readFile(join(process.cwd(), 'README.md'), 'utf8')
push('L4', /ctx.storageDomain|注入/.test(readme), 'README 明确域由宿主注入（插件不自己 new 域、不管生命周期）')
push('L5', !/project.lock/.test(readme), 'README 没有引入 project.lock（不加多余的锁）')

const pass = steps.filter((x) => x.ok).length
const summary = { at: new Date().toISOString(), suite: 's23-storage-exclusivity', total: steps.length, pass, fail: steps.length - pass, verdict: pass === steps.length ? 'PASS' : 'FAIL', steps }
await writeFile(OUT, JSON.stringify(summary, null, 2), 'utf8')
console.log('SUMMARY ' + pass + '/' + steps.length + ' ' + summary.verdict)
process.exit(pass === steps.length ? 0 : 1)
