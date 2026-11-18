/**
 * core/fault.mjs —— 故障注入（仅测试用；未设置环境变量时零开销）
 *
 * S1A_CRASH_AT=<point>：命中即真实强杀当前进程（Windows 上是 TerminateProcess，
 * 不执行 finally / 不 flush / 不清理锁），用于验证崩溃恢复，而不是“模拟抛错”。
 * S1A_PAUSE_AT=<point>：命中后写 marker 文件并阻塞，等父进程创建 release 文件后继续，
 * 用于跨进程读可见性测试（真实 APPLYING 窗口）。
 */
import { existsSync, writeFileSync } from 'node:fs'

export function crashPoint(name) {
  if (process.env.S1A_CRASH_AT !== name) return
  try { process.kill(process.pid, 'SIGKILL') } catch {}
  process.exit(137)
}

export async function pausePoint(name) {
  if (process.env.S1A_PAUSE_AT !== name) return
  const marker = process.env.S1A_PAUSE_MARKER
  const release = process.env.S1A_PAUSE_RELEASE
  if (marker) { try { writeFileSync(marker, 'paused:' + name) } catch {} }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (release && existsSync(release)) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
