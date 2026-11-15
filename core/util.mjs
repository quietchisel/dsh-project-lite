/**
 * core/util.mjs — ULID、时间、键构造。S0 实验代码，无第三方依赖。
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Crockford Base32 ULID（26 字符，时间有序，只含 [0-9A-Z] 去掉 I L O U）。 */
export function ulid(now = Date.now()) {
  let t = ''
  let ms = now
  for (let i = 0; i < 10; i++) { t = B32[ms % 32] + t; ms = Math.floor(ms / 32) }
  let r = ''
  for (let i = 0; i < 16; i++) r += B32[Math.floor(Math.random() * 32)]
  return t + r
}

export const newProjectId = () => 'prj_' + ulid()
export const newDeliverableId = () => 'dlv_' + ulid()
export const newLogId = () => 'log_' + ulid()

/** 连接表确定性键：<pid>__<sid>（不能含 # —— per-record 键必须是 [a-zA-Z0-9_-]+）。 */
export const linkKey = (projectId, sessionId) => projectId + '__' + sessionId
export const wsLinkKey = (projectId, workspaceId) => projectId + '__' + workspaceId

export const nowIso = () => new Date().toISOString().replace('Z', '+00:00')

/** next_action 的拒绝规则：空、过短、或命中"态度词"黑名单。 */
const BLACKLIST = ['继续推进', '推进', '再看看', '待定', '深入研究', '研究一下', '继续', 'tbd', 'todo']
export function validateNextAction(text) {
  const s = String(text ?? '').trim()
  if (s.length === 0) return { ok: false, code: 'NEXT_ACTION_INVALID', reason: 'empty' }
  if (s.length < 4) return { ok: false, code: 'NEXT_ACTION_INVALID', reason: 'too_short' }
  if (s.length > 60) return { ok: false, code: 'NEXT_ACTION_INVALID', reason: 'too_long' }
  const low = s.toLowerCase().replace(/[\s。，,.！!]/g, '')
  if (BLACKLIST.some(w => low === w || low === w.toLowerCase())) {
    return { ok: false, code: 'NEXT_ACTION_INVALID', reason: 'blacklist' }
  }
  return { ok: true, value: s }
}
