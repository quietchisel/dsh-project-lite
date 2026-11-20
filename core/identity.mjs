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

/**
 * 0.19 受限回执授权（与 authorizeWrite 完全独立）。
 *
 * 它不是放宽权威写，而是一项范围极窄的新能力：让「已关联目标项目、被派单的 supporting/branch 会话」
 * 只能提交「派给自己的任务」的回执。它不碰项目权威字段、不碰 checkpoint、不碰 primary、
 * 不碰 transferPrimary、不自动确认任务完成。authorizeWrite 的规则在本函数里没有任何改动。
 *
 * @param links       project_session 记录（含 unlinked）
 * @param task        目标 task 记录（由 store 按 task_id 取，不由参数伪造）
 * @param projectId   宿主上下文已定的项目（来自 tool 的 args，但要与 task 核对）
 * @param sessionId   宿主注入的会话 id（callerContext），可为 null → fail-closed
 * @param op          操作名，仅用于审计
 */
export function authorizeTaskReceipt({ links, task, projectId, sessionId, op } = {}) {
  if (!sessionId) {
    throw new IdentityError('IDENTITY_UNAVAILABLE', '拿不到宿主注入的会话身份，回执写入被拒绝（fail-closed）', { op, project_id: projectId })
  }
  if (!task) {
    throw new IdentityError('TASK_NOT_FOUND', '任务不存在，拒绝提交回执', { op, project_id: projectId, session_id: sessionId })
  }
  if (!projectId || task.project_id !== projectId) {
    throw new IdentityError('TASK_PROJECT_MISMATCH', '任务不属于目标项目，拒绝跨项目回执', { op, project_id: projectId, task_id: task.id, session_id: sessionId })
  }
  // 会话必须是该项目的有效关联会话，且角色为 supporting/branch（primary 不需要回执）。
  const mine = (links || []).filter((l) => l && l.project_id === projectId && l.session_id === sessionId && l.unlinked !== true)
  if (mine.length === 0) {
    throw new IdentityError('NOT_ASSOCIATED', '当前会话未关联该项目，不能提交回执', { op, project_id: projectId, session_id: sessionId })
  }
  const supporting = mine.find((l) => l.role === 'supporting' || l.role === 'branch')
  if (!supporting) {
    throw new IdentityError('RECEIPT_PRIMARY_NOT_ALLOWED', 'primary 不提交任务回执（回执仅面向 supporting/branch 分支）', { op, project_id: projectId, session_id: sessionId })
  }
  // 任务必须派给当前会话（不允许提交别人的回执）。
  if (task.assigned_session_id !== sessionId) {
    throw new IdentityError('NOT_ASSIGNED', '该任务未派给当前会话，拒绝提交回执', { op, project_id: projectId, task_id: task.id, session_id: sessionId, assigned_to: task.assigned_session_id ?? null })
  }
  // 任务生命周期：只有 active 且验收未 accepted/cancelled 时能回执。
  const acc = task.acceptance
  if (task.lifecycle !== 'active' || acc === 'accepted' || acc === 'cancelled') {
    throw new IdentityError('TASK_NOT_RECEIVABLE', '任务当前状态不可提交回执（已结束/已接受/已取消）', { op, project_id: projectId, task_id: task.id, lifecycle: task.lifecycle, acceptance: acc })
  }
  return { mode: 'task-receipt', session_id: sessionId, task_id: task.id, project_id: projectId, op }
}
