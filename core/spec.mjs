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
  status: z.enum(['active', 'paused', 'done', 'archived']),
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
  legacy_refs: z.array(LegacyRefSchema).optional(),
  created_at: Iso,
  rev: z.number().int().positive(),
})

export const ProjectWorkspaceSchema = z.object({
  id: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}__[0-9a-f-]{36}$/),
  project_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_title: z.string().optional(),
  confidence: z.enum(['confirmed', 'inferred']),
  basis: z.string().min(1),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  created_at: Iso,
  rev: z.number().int().positive(),
})

export const DeliverableSchema = z.object({
  id: z.string().regex(/^dlv_[0-9A-HJKMNP-TV-Z]{26}$/),
  project_id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['doc', 'zip', 'code', 'media', 'data']),
  locator: z.object({
    type: z.enum(['workspace', 'absolute']),
    workspace_id: z.string().optional(),
    rel: z.string().optional(),
    path: z.string().optional(),
    base_snapshot: z.string().optional(),
    registered_at: Iso.optional(),
  }),
  state: z.enum(['ok', 'missing', 'unreachable']),
  size: z.number().nullable().optional(),
  mtime: z.string().nullable().optional(),
  checked_at: z.string().nullable().optional(),
  sha256: z.string().nullable().optional(),
  is_final: z.boolean(),
  legacy_refs: z.array(LegacyRefSchema).optional(),
  rev: z.number().int().positive(),
})

export const ChangelogSchema = z.object({
  id: z.string().regex(/^log_[0-9A-HJKMNP-TV-Z]{26}$/),
  at: Iso,
  actor: z.string().min(1),
  op: z.enum(['create', 'update', 'link', 'unlink', 'archive']),
  target_table: z.string().min(1),
  target_key: z.string().min(1),
  summary: z.string().min(1),
  before_rev: z.number().int().nullable(),
  after_rev: z.number().int().nullable(),
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

export const TABLES = ['project', 'project_session', 'changelog', 'project_workspace', 'deliverable']

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
    },
  }
  if (compatibleVersions !== undefined) spec.compatibleVersions = compatibleVersions
  return defineDomain(spec)
}

export const SPEC = buildSpec()
