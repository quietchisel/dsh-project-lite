/**
 * core/spec.mjs — 项目域的数据模型（第一版：5 张表 + 1 个全局）。
 *
 * 与《DSH-Data-Model-v2.md》§4 逐字对应：
 *   tables: project, project_session, changelog, project_workspace, deliverable
 *   延后: work_package, domain, project_task, automation_run（不声明 = 磁盘上不会有目录）
 *
 * 硬约束（来自源码，不是偏好）：
 *   1. layout 必须是 'per-record'：只有它有 backupRecord，坏一条不毁全库。
 *   2. 记录键必须是 [a-zA-Z0-9_-]+：per-record 把键当文件名（per-record-unit.ts L40）。
 *   3. 任何 version 提升必须同时写 compatibleVersions，否则旧记录静默消失（format.ts L126）。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const VERSION = 1

const Iso = z.string().min(10)
const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/** 历史来源引用：每条记录上的数组，不建表（§12）。 */
export const LegacyRefSchema = z.object({
  kind: z.enum(['project', 'session', 'workspace', 'deliverable']),
  original_id: z.string().min(1),
  original_path: z.string().nullable().optional(),
  source_doc: z.string().min(1),
  source_path: z.string().min(1),
  imported_at: Iso,
  imported_by: z.string().min(1),
  original_confidence: z.enum(['confirmed', 'metadata_inferred']),
  note: z.string().nullable().optional(),
})

export const ProjectSchema = z.object({
  id: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/),
  legacy_id: z.string().nullable().optional(),
  name: z.string().min(1).max(40),
  objective: z.string().min(1),
  /** 必填：空串或态度词在应用层先被拒，这里再兜一层。 */
  next_action: z.string().min(4).max(60),
  done_when: z.array(z.string()).optional(),
  kind: z.enum(['project', 'pipeline']),
  /** 0.12：deleted = 软删除，进回收站；不物理删记录，计数不变、基线不破，可恢复。 */
  status: z.enum(['active', 'paused', 'done', 'archived', 'deleted']),
  tags: z.array(z.string()).max(3).optional(),
  confidence: z.enum(['confirmed', 'inferred']),
  basis: z.string().min(1),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  created_at: Iso,
  updated_at: Iso,
  updated_by: z.string().min(1),
  rev: z.number().int().positive(),
})

export const ProjectSessionSchema = z.object({
  id: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}__session-[0-9a-f-]+$/),
  project_id: z.string().min(1),
  session_id: z.string().regex(/^session-[0-9a-f-]+$/),
  role: z.enum(['primary', 'supporting']),
  confidence: z.enum(['confirmed', 'inferred']),
  basis: z.string().min(1),
  /** suggestion 已删除：只有"人点的"和"历史接入的"两种（§13.5）。 */
  source: z.enum(['manual', 'legacy']),
  /** 0.12：true = 已解除关联（软删除）。旧记录没有此字段，按 linked 处理。 */
  unlinked: z.boolean().optional(),
  unlinked_at: Iso.optional(),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  created_at: Iso,
  rev: z.number().int().positive(),
})

export const ProjectWorkspaceSchema = z.object({
  id: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}__[0-9a-f-]{36}$/),
  project_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_title: z.string().optional(),
  // 0.13：path 与软删除标记。旧记录没有这些字段也能读。
  workspace_path: z.string().optional(),
  unlinked: z.boolean().optional(),
  unlinked_at: Iso.optional(),
  confidence: z.enum(['confirmed', 'inferred']),
  basis: z.string().min(1),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  created_at: Iso,
  rev: z.number().int().positive(),
})

export const DeliverableSchema = z.object({
  id: z.string().regex(/^dlv_[0-9A-HJKMNP-TV-Z]{26}$/),
  /**
   * S1-B：project_id 由"必填"改为"可空"。
   * 源数据是 Task → Deliverable，没有 Task → Project 的证据；为了挂上 Project 而猜归属是错的。
   * 已有带 project_id 的记录完全不受影响（字段没删、语义没改）。
   */
  project_id: z.string().min(1).nullable().optional(),
  /**
   * 任务归属（本轮新增）：Deliverable 真正能证明的关系是"某任务产出了它"。
   * 台账里存在**同一个文件被多个任务引用**（18 条路径），所以权威字段是数组；
   * task_id 保留给早期单引用记录，不因为它放弃多对多。
   */
  task_ids: z.array(z.string()).optional(),
  task_id: z.string().optional(),
  /** 被谁取代（台账未记录取代者时留 null，不猜） */
  superseded_by: z.string().nullable().optional(),
  title: z.string().min(1),
  kind: z.enum(['doc', 'zip', 'code', 'media', 'data']),
  locator: z.object({
    // url：台账里确实有以 https:// 登记的交付物（例如 release 链接），原样保留，不硬塞成文件路径
    type: z.enum(['workspace', 'absolute', 'url']),
    url: z.string().optional(),
    workspace_id: z.string().optional(),
    rel: z.string().optional(),
    path: z.string().optional(),
    base_snapshot: z.string().optional(),
    registered_at: Iso.optional(),
  }),
  state: z.enum(['ok', 'missing', 'unreachable']),
  /** 来源可解释性（R-11 补齐）：为什么信它、置信度 */
  basis: z.string().optional(),
  confidence: z.enum(['confirmed', 'inferred']).optional(),
  /** 迁移溯源 */
  source_domain: z.string().optional(),
  source_path: z.string().optional(),
  source_status: z.string().optional(),
  import_batch_id: z.string().optional(),
  imported_at: Iso.optional(),
  size: z.number().nullable().optional(),
  mtime: z.string().nullable().optional(),
  checked_at: z.string().nullable().optional(),
  sha256: z.string().nullable().optional(),
  is_final: z.boolean(),
  // 0.14：软删除标记。旧记录没有也能读。
  unlinked: z.boolean().optional(),
  unlinked_at: Iso.optional(),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  rev: z.number().int().positive(),
})

export const ChangelogSchema = z.object({
  id: z.string().regex(/^log_[0-9A-HJKMNP-TV-Z]{26}$/),
  at: Iso,
  actor: z.string().min(1),
  op: z.enum(['create', 'update', 'link', 'unlink', 'archive', 'restore', 'delete']),
  target_table: z.string().min(1),
  target_key: z.string().min(1),
  summary: z.string().min(1),
  before_rev: z.number().int().nullable(),
  after_rev: z.number().int().nullable(),
  /**
   * 1.9 声明 vs 证据：这条变更是"人点的"还是"程序跑的"。
   * 可选——旧记录没有这个字段也能解析（不加版本戳）。缺省语义按 manual 处理。
   */
  source: z.enum(['manual', 'run']).optional(),
  /**
   * S1-B 历史迁移：原始 Changelog 是历史事实，不能伪装成迁移时发生的事件。
   * 这五个字段可选；旧记录没有也照常解析（不加版本戳）。
   *   source_domain      这条历史来自哪个域（例如 C:\Users\...\storages）
   *   source_changelog_id 原始记录 ID（目标 ID 冲突时目标会另生成，原始 ID 留在这里）
   *   import_batch_id    本次迁移批次（例如 s1b-b2）
   *   imported_at        导入动作的真实时间
   *   migration_event    true = 本次迁移产生的事件（不是历史）
   */
  source_domain: z.string().optional(),
  source_changelog_id: z.string().optional(),
  import_batch_id: z.string().optional(),
  imported_at: Iso.optional(),
  migration_event: z.boolean().optional(),
})

/**
 * S1-B：Task / TaskSession（台账迁移目标模型）。
 *
 * 设计约束（v0.3.1 决策）：
 *   - 生命周期（lifecycle）与验收状态（acceptance）**分开**，不降维成一个 status；
 *   - Task 可以**独立于 Project**（project_id = null）；
 *   - TaskSession 记录会话在任务里的角色，primary 只表示"主执行会话"，不是权限；
 *   - 原始台账字段全部保留可追溯（source_id / source_domain / source_path）。
 */
export const TaskSchema = z.object({
  id: z.string().regex(/^task_[0-9A-HJKMNP-TV-Z]{26}$/),
  /** 原始台账编号，例如 T-0026（迁移幂等键用它 + 来源域） */
  source_id: z.string().min(1),
  source_domain: z.string().min(1),
  source_path: z.string().min(1),
  title: z.string().min(1).max(200),
  objective: z.string().min(1),
  /** 生命周期：active=在做/待做，closed=已结束（delivered 或 cancelled 都算结束） */
  lifecycle: z.enum(['active', 'closed']),
  /** 验收状态：与 lifecycle 正交 */
  acceptance: z.enum(['pending', 'implemented_unverified', 'accepted', 'cancelled']),
  next_action: z.string().optional(),
  /**
   * 独立任务允许 null。
   * S1-C：归属可以来自「主会话的项目关联」继承，但那是**推断**，不是事实；
   * 所以必须同时带上溯源（project_basis / project_confidence / project_evidence），
   * 让人一眼看出这条归属是 confirmed 还是 inferred。没有证据就留 null。
   */
  project_id: z.string().nullable().optional(),
  /** 归属依据（谁、按什么规则挂的） */
  project_basis: z.string().optional(),
  /** 归属置信度：confirmed=人确认过；inferred=按会话关联继承 */
  project_confidence: z.enum(['confirmed', 'inferred']).optional(),
  /** 归属的证据指针（例如 link rev / 原始台账位置） */
  project_evidence: z.string().optional(),
  primary_session_id: z.string().nullable().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  note: z.string().optional(),
  /**
   * 台账块自己的 updated_at（不是文件头时间）。
   * 早期迁移把所有任务都写成台账文件头的时刻，等于宣布"33 个任务是同一秒更新的"——那不是事实。
   * 台账只有 10 个块带这个字段，其余留空；缺证据不编。
   */
  source_updated_at: Iso.optional(),
  updated_at: Iso,
  rev: z.number().int().positive(),
})

export const TaskSessionSchema = z.object({
  id: z.string().regex(/^task_[0-9A-HJKMNP-TV-Z]{26}__session-[0-9a-f-]+$/),
  task_id: z.string().min(1),
  session_id: z.string().regex(/^session-[0-9a-f-]+$/),
  role: z.enum(['primary', 'branch', 'supporting']),
  basis: z.string().min(1),
  source_domain: z.string().optional(),
  created_at: Iso,
  rev: z.number().int().positive(),
})

/** 全局单例。注意 defineDomain 拒绝"能接受 null 的 global schema"。 */
export const MetaSchema = z.object({
  schema_version: z.number().int().nonnegative(),
  created_at: z.string(),
  writer: z.string().min(1),
  /** 对账基线；null = 从未登记过（新库）。只有完整性被证明时才允许写（铁律一）。 */
  expected_counts: z.record(z.string(), z.number()).nullable(),
  last_reconcile_at: z.string().nullable(),
  /** pass/fail/skipped 分列；三个新字段可选，旧记录仍能解析（不加版本戳）。 */
  last_reconcile_stats: z
    .object({
      ok: z.number(), orphans: z.number(), dangling: z.number(), degraded: z.boolean(),
      pass: z.number().optional(), fail: z.number().optional(), skipped: z.number().optional(),
    })
    .nullable(),
  /** 降级那次实测到的计数与判据编号；降级时只写这里，绝不覆盖 expected_counts。 */
  last_degraded_snapshot: z.any().nullable(),
  prefs: z.object({
    suppress_suggest: z.boolean(),
    suppress_until: z.string().nullable(),
  }),
  /**
   * 1.8 幂等指纹：最近 256 次写请求的 {id, fp, at, value}。
   * 可选——旧 global.json 没有这个字段也能解析（不加版本戳，避免旧库被迫迁移）。
   */
  recent_requests: z.array(z.object({
    id: z.string(),
    fp: z.string(),
    at: z.string(),
    value: z.any().nullable(),
  })).optional(),
})

export const initialMeta = (writer) => ({
  schema_version: VERSION,
  created_at: '',
  writer,
  expected_counts: null,
  last_reconcile_at: null,
  last_reconcile_stats: null,
  last_degraded_snapshot: null,
  prefs: { suppress_suggest: false, suppress_until: null },
})

export const TABLES = ['project', 'project_session', 'changelog', 'project_workspace', 'deliverable', 'task', 'task_session']

/**
 * @param extraProject 仅用于版本兼容实验：给 project 增加可选字段（模拟"v2 新增字段"）。
 */
export function buildSpec({ version = VERSION, compatibleVersions, writer = 'dsh-project-core@0.1.0-s0', extraProject } = {}) {
  const spec = {
    name: 'project',
    version,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    global: { schema: MetaSchema, initial: initialMeta(writer) },
    tables: {
      project: domainTable(extraProject ? ProjectSchema.extend(extraProject) : ProjectSchema),
      project_session: domainTable(ProjectSessionSchema),
      changelog: domainTable(ChangelogSchema),
      project_workspace: domainTable(ProjectWorkspaceSchema),
      deliverable: domainTable(DeliverableSchema),
      task: domainTable(TaskSchema),
      task_session: domainTable(TaskSessionSchema),
    },
  }
  if (compatibleVersions !== undefined) spec.compatibleVersions = compatibleVersions
  return defineDomain(spec)
}

export const SPEC = buildSpec()
