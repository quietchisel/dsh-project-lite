/**
 * core/identity.mjs —— 主会话身份校验（P0）
 *
 * 原则：
 *   1. 身份只来自宿主注入的 exec.agent.sessionId；工具参数里的 session_id / actor 一律不算身份。
 *   2. 分支（supporting）、未确认（无 link）会话不能覆盖权威字段。
 *   3. 人工路径（manual）不是认证，只是一条独立的、可审计的授权记录——谁授权、为什么、什么时候。
 *   4. 拿不到可信身份时 fail-closed（IDENTITY_UNAVAILABLE），不允许降级成“只记录不校验”还宣称通过。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 调用方身份上下文（AsyncLocalStorage）。
 *
 * 为什么用它而不是“把 sessionId 塞进 args”：
 *   args 是**调用方完全可控**的普通业务参数，任何从 args 取身份的实现都等于把认证交给对方。
 *   所以身份只能由插件入口从宿主 exec 解析后，用 runAsCaller 建立**不可从参数伪造**的上下文，
 *   Store 只读这个上下文；参数里出现 __identity / actor 一律拒绝。
 *
 * 用 ALS 而不是 Store 上的可变字段：工具调用是异步并发，可变量会被另一个调用覆盖。
 */
const als = new AsyncLocalStorage()

/** 在“可信调用方身份”下执行一段逻辑。sessionId 必须是宿主注入值（可为 null → 后续 fail-closed）。 */
export function runAsCaller({ sessionId, source = 'tool' }, fn) {
  return als.run({ sessionId: typeof sessionId === 'string' ? sessionId : null, source, enforce: true }, fn)
}

/** 取当前调用方上下文；不在任何 runAsCaller 里时返回 null（= 非工具路径，如 HTTP 路由）。 */
export function callerContext() {
  return als.getStore() || null
}

export class IdentityError extends Error {
  constructor(code, message, extra = {}) {
    super(message); this.name = 'IdentityError'; this.code = code; Object.assign(this, extra)
  }
}

/**
 * 只认宿主注入的 agent 身份；返回 null 表示拿不到可信身份。
 *
 * 读取顺序的依据来自 DSH 宿主自身实现（app.asar 内 run_code 工具）：
 *     exec.agent.session.id
 * 被宿主用作沙箱调用键，说明它是 Host 注入的、调用方无法伪造的会话标识。
 * 旧代码读 exec.agent.sessionId / exec.agent.id —— 实测这两个字段在宿主侧不存在，
 * 若照旧读，真实环境会永远 fail-closed（安全但不可用）。这里按宿主实际形状补齐。
 */
export function resolveHostSessionId(exec) {
  const agent = exec && exec.agent
  const candidates = [
    agent && agent.session && agent.session.id,
    agent && agent.sessionId,
    agent && agent.id,
  ]
  for (const sid of candidates) {
    if (typeof sid === 'string' && /^session-[0-9a-f-]+$/.test(sid)) return sid
  }
  return null
}

/** 调用方在参数里自带 actor / 自报身份 → 直接拒绝（不许“以参数为准”）。 */
export function assertNoSpoofedActor(args) {
  if (!args || typeof args !== 'object') return;
  for (const k of ['actor', '__identity', '_identity', 'identity', 'auth', 'authorization']) {
    if (Object.prototype.hasOwnProperty.call(args, k)) {
      throw new IdentityError('ACTOR_SPOOF_REJECTED', '写操作不接受调用方自报的身份字段（' + k + '）；身份只能来自宿主注入的会话上下文');
    }
  }
}

/**
 * 权威写授权。
 * @param links 当前 project_session 记录（含 unlinked）
 * @param projectId 目标项目
 * @param sessionId 宿主注入的会话 id（可为 null）
 * @param manual 人工授权 {authorized, by, reason, at}——只记录，不当认证
 */
export function authorizeWrite({ links, projectId, sessionId, op, manual } = {}) {
  if (manual && manual.authorized === true) {
    if (!manual.by || !String(manual.by).trim()) throw new IdentityError('MANUAL_AUTH_INCOMPLETE', '人工授权必须写明 by（谁授权）');
    if (!manual.reason || !String(manual.reason).trim()) throw new IdentityError('MANUAL_AUTH_INCOMPLETE', '人工授权必须写明 reason（为什么）');
    return { mode: 'manual', by: String(manual.by), reason: String(manual.reason), at: manual.at || new Date().toISOString(), op };
  }
  if (!sessionId) {
    throw new IdentityError('IDENTITY_UNAVAILABLE', '拿不到宿主注入的会话身份，权威写被拒绝（fail-closed）', { op, project_id: projectId });
  }
  const mine = (links || []).filter((l) => l && l.project_id === projectId && l.session_id === sessionId && !l.unlinked);
  if (mine.length === 0) {
    throw new IdentityError('NOT_PRIMARY', '当前会话不是该项目的关联会话，不能写权威字段', { op, project_id: projectId, session_id: sessionId });
  }
  const primary = mine.find((l) => l.role === 'primary');
  if (!primary) {
    throw new IdentityError('NOT_PRIMARY', '当前会话只是分支/参考会话（role≠primary），不能覆盖权威字段', { op, project_id: projectId, session_id: sessionId, role: mine[0].role });
  }
  return { mode: 'primary', session_id: sessionId, op };
}
