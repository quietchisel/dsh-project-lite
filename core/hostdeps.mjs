/**
 * core/hostdeps.mjs —— 从宿主树解析 defineTool（借鉴同 profile 的 dsh-bili-scroll/lib/hostdeps.mjs）
 *
 * 为什么：@deepseek-ai/dsh-tools 是 optional peer，桌面 profile autoInstallPeers=false 不装；
 * 裸 import 会让整条插件不激活。link: 插件的 Node 解析又落在工作区路径，更找不到。
 * 策略：① 按候选根找宿主那份 → ② 本地等价实现（我们的 spec 本来就是标准 JSON Schema）。
 * 底线：拿不到也返回可用 defineTool，插件照常加载。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try { for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai')) } catch {}
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  try { for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai')) } catch {}
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/**
 * 本地等价实现：原样返回作者 spec。
 * 我们的 spec 用官方作者 DSL（parameters 是属性 map、output.schema.type='json'），
 * 官方 defineTool 会把它编译成标准 JSON Schema；本地拿不到编译器时不强行转换，
 * 必需参数的校验已在各工具 execute 里手写，不依赖 schema 层。
 */
function localDefineTool(options) {
  if (!options || typeof options.name !== 'string' || typeof options.execute !== 'function') {
    throw new Error('defineTool: 需要 name 与 execute')
  }
  // 与官方 defineTool 同口径：output.schema.type 必须是 JSON Schema 合法类型。
  // 曾因写 'json' 导致真机注册失败、Node 测试却全绿——这里补上同样的校验。
  const validTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const ot = options.output && options.output.schema && options.output.schema.type
  if (ot && !validTypes.includes(ot)) {
    throw new Error('unsupported JSON schema: schema.type must be one of ' + validTypes.join('/') + ' (got ' + ot + ')')
  }
  return options
}

/** @returns {Promise<{defineTool:Function, source:string, notes:string[]}>} */
export async function loadDefineTool() {
  const notes = []
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, 'dsh-tools')
    if (!url) continue
    try {
      const mod = await import(url)
      if (typeof mod.defineTool === 'function') {
        notes.push('defineTool 从宿主树取到：' + url.replace(/^file:\/\/\//, ''))
        return { defineTool: mod.defineTool, source: 'host', notes }
      }
    } catch (e) { notes.push('宿主树导入失败：' + (e?.code || 'ERR') + ' ' + root) }
  }
  notes.push('宿主树无 dsh-tools —— 用本地等价 defineTool（工具 spec 已是标准 JSON Schema）')
  return { defineTool: localDefineTool, source: 'local', notes }
}
