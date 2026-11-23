# dsh-project-lite

**在 DSH 里，让 Agent 和人都管得了项目。** 完整性闸管住数据安全，Agent 工具让主对话一键派活给多分支，回执闭环让每次交付可追溯。

> 兼容性：DSH `>= 0.2.2-rc.3` ｜ Node `>= 20` ｜ 已在 Windows 11 实测，macOS / Linux 未测
>
> 本地优先、不联网、不上传。当前版本 `0.22.0`。

## 为什么需要它

本地 JSON 存储最危险的故障不是"报错"，而是**看起来一切正常**：

1. 记录文件被静默跳过（坏 JSON、版本戳不对、写到一半）→ 内存里少了几条，界面上却是一片健康的绿灯；
2. `global.json` 被误删 → 程序把旧数据当成"全新空库"，第一次写入就把证据补成了正常基线；
3. 完整性检查本身跑不起来（目录不可读）→ 被当成"没问题"。

这三种都会导致**下一次写入把真实数据覆盖掉**。本插件每次打开域、每次请求前都重新数一遍磁盘、和内存比对；只要对不上，就进入**只读降级**并给出具体原因，而不是继续写。

**它不只是"防写坏"，这套数据层还支撑了三件真正省时的事**：

- **人和 Agent 共用一套项目记忆**：13 个 Agent 工具让助手能查项目、恢复上下文、建任务、交回执；项目 ↔ 会话 ↔ 工作区 ↔ 交付物四维关联，打开旧会话标题旁就能看到它归属哪个项目。
- **主对话一键派活给新分支**：`task_dispatch_spawn` 一次调用完成"建子 agent → 挂成 supporting → 建任务派单"，免除手动开对话、聊一轮、挂项目、指出是哪个会话四步。
- **交付可追溯**：分支交回执（不可直接生效），primary 在面板接受/拒绝，正式状态由人裁定；长期项目可跨会话恢复上下文并提交待确认检查点。

## 能力一览

- **完整性闸（integrity gate）**：磁盘 ↔ 内存实时比对，降级即后端拒绝写入（`READONLY_DEGRADED` / HTTP 409），不靠藏按钮。
- **五种降级状态**带人话原因；元数据不可信时一个字节都不写，损坏文件原样留作证据。
- **四维关联**：项目挂会话（含角色与依据）、挂工作区（软关联可复活）、登记交付物（只索引不搬运，现场三态校验）；软删除进回收站，可恢复。
- **13 个 Agent 工具**：只读查项目、恢复上下文、受控建项目/挂会话/收敛状态、派单、交回执、裁定。
- **一键派活 + 回执闭环**：主对话派给新分支，分支交回执，primary 裁定；任务进度、回执、检查点都在项目详情里。
- **完成候选**：任务全 accepted 时系统提示"完成候选"，由 primary 人工确认收敛，绝不自动宣布完成。

## 安装

本插件是 DSH profile 的本地插件，通过 `link:` 挂载。**三处都要改，只改一处不生效**（实测；漏掉 lockfile 会在下次依赖安装时被静默回退）：

1. 编辑 `<DSH_HOME>/profiles/<profile>/package.json`，在 `dependencies` 里加：

   ```json
   "dsh-project-lite": "link:<本仓库的绝对路径>"
   ```

2. 在 `<DSH_HOME>/profiles/<profile>/node_modules/` 下建一个指向同一目录的 Junction（Windows）：

   ```bat
   mklink /J "<DSH_HOME>\profiles\<profile>\node_modules\dsh-project-lite" "<本仓库的绝对路径>"
   ```

3. 若 profile 有 `pnpm-lock.yaml`，同步该包的 `specifier` / `version` 两行为同一路径（本机曾因 lockfile 钉住旧路径，依赖安装时把 Junction 掀回旧目录）。
4. 完全退出 DSH 再启动：`index.js` 是 Host 半，必须重启才加载；`client.js` 改动刷新页面即可。Agent 工具与会话徽标也是 Host 改动，重启后 `evidence.jsonl` 里应有 `agent-tools-registered` 一条。

`<DSH_HOME>` 默认是 `~/.dsh`，可用环境变量 `DSH_HOME` 覆盖。

## 快速上手

1. 装好后重启 DSH，侧栏出现「项目」面板；顶部红条会告诉你数据是否完整、可不可写。
2. 点「新建项目」填名称、目标、下一步（下一步必须是能直接执行的动作，态度词会被拒）；可顺带选初始工作区。
3. 在项目行点「关联会话」挂上负责它的会话——挂上后，那个会话的任务会自动出现在详情第 4 区；打开该会话时标题旁显示项目徽标。
4. 详情里点项目名展开九个分区，做这些事：关联工作区、登记交付物、确认检查点、裁定分支回执。
5. 让 Agent 接手：在主对话问"我有哪些项目"或"这事到哪了"，它会调 `project_list` / `project_get`；要派活就说"派个新分支做 X"，它调 `task_dispatch_spawn`。

## 界面（项目详情九分区）

点项目名展开，再点一次收起（弹窗内走 Esc / 关闭）：

1. **项目**：目标 / 下一步 / 完成判据 / 标签 / 状态。
2. **关联会话**：人能认的标题为主，工作区与角色为辅；行内可「移除」（软标记，可复活）。
3. **工作区**：从 DSH 真实工作区勾选关联，标题可点开文件夹，可「移除」；建项目时可带出初始工作区。
4. **任务进度**：环形图（在做 / 做完待验 / 已完成）+ 任务列表；任务从关联会话自动反查，不另建数据。
5. **交付物**：按产出类型分组 + 横条榜；✅存在 / ❌失效 / ⚠不可达三态现场校验，可「加交付物」（手填或文件右键）/「解除索引」；失效的单独一块，只跳转不删。
6. **变更记录**：最近 10 条，每条标「人工 / 程序」来源。
7. **系统推断的归属**：`inferred` 的关系收成"未确认"清单（审计信息，默认收起）；列表行同名徽标点开看依据浮层。
8. **工作进展检查点**：Agent 提交的待确认进展，primary「确认并保存」或「拒绝」；已确认的默认收起。
9. **任务回执**：分支提交的成果，primary 可直接「接受 / 拒绝」（走同一个权威裁定服务）；已裁定的默认收起。

任务全部完成且无未裁事项时，顶部另出「项目完成候选」提示块，由 primary 一键确认收敛——系统只提示，不自动完成。列表上方有 6 张 KPI 卡，数字全部来自真实计数，不编造。

## 给 Agent 用（13 个工具）

插件向 DSH 的 Agent 注册工具（`project_` / `task_` 前缀，避免与任务看板撞名）。**只读 5 个、受控写 8 个**：

| 工具 | 用途 | 权限 |
|---|---|---|
| `project_list` | 我有哪些项目（摘要 + 四组计数） | 只读 |
| `project_get` | 这事到哪了（九分区详情 + 变更记录；找不到返回 `found:false`） | 只读 |
| `project_links_of_session` | 这个会话属于哪个项目（含依据/置信度） | 只读 |
| `project_resume` | 恢复长期项目上下文（高信号摘要，新会话接续用；不传 id 按会话/工作区解析） | 只读 |
| `task_receipts` | 查任务回执（可按项目/任务过滤） | 只读 |
| `project_create` | 建项目——仅当使用者明确要求；`next_action` 必须是人确认过的动作 | 受控写 |
| `project_link_session` | 把会话挂到项目——须先取得人同意，`basis` 必填 | 受控写 |
| `project_update` | 收敛项目状态/下一步——**仅 primary**，只收 `status`/`next_action`，字段白名单 + CAS + 枚举校验 | 受控写 |
| `propose_checkpoint` | 提交待确认进展检查点——来源身份取自宿主，不自我审批 | 受控写 |
| `task_dispatch` | 建任务派给已有 supporting 分支——**仅 primary**，须使用者明确要求 | 受控写 |
| `task_dispatch_spawn` | 一句话派活给全新分支：建子 agent → 挂 supporting → 建任务派单，失败自动回滚；**仅 primary** | 受控写 |
| `task_receipt_submit` | 分支交回执——只能交派给自己的任务；身份取自宿主，不可冒充 | 受限写 |
| `task_receipt_decide` | primary 裁定回执 accepted/rejected——正式任务状态的唯一入口 | 受控写 |

**三角色分工：Agent 负责「看懂」，插件负责「记住」，你负责「点头」。** 工具不提供删除、批量导入或状态自动完成——那些是人的决定。

会话头部徽标：打开任一旧会话，标题旁显示它归属的项目（◆ 项目名 + 置信度），不用主动打开项目面板。这是这套机制真正的使用入口——总览页只是补充。

## 核心机制

1. **完整性闸**：`scanUnit` 数磁盘 → `evaluate` 比对内存 → `degradationReport()` 出人话原因 → 所有写入口先过 `assertWritable()`。
2. **降级即只读**：不是把按钮藏起来，是后端直接抛 `READONLY_DEGRADED`，HTTP 返回 409。
3. **元数据不可信时一个字节都不写**：`global.json` 缺失/损坏/版本不兼容时，连"降级快照"都不写——写下去等于亲手把证据补掉。
4. **判据实时重算**：store 长期存活，判据不能停在"打开那一刻"；每次请求前 `refresh()`。
5. **写前读同 schema 校验**：四条写路径落盘前用读路径同一份 `valueSchema` 校验，不合法抛 `RECORD_INVALID`，一个字节都不写（否则"写得进去、下次开库被隔离、整库只读"）。
6. **幂等指纹**：写入口接受可选 `requestId`（4–64 位字母数字 `_-`），同 id 同参数回放、同 id 异参数 `409 REQUEST_ID_CONFLICT`，区分"同一意图"与"两次真实意图"。

五种降级状态：

| `kind` | 触发条件 | 判定优先级 |
|---|---|---|
| `meta_missing` | 磁盘上有记录，但 `global.json` 不见了 | 1 |
| `meta_corrupt` | `global.json` 无法解析（原文件保留作证据） | 1 |
| `version_incompatible` | 数据版本戳不在接受范围内（通常是插件被降级过） | 1 |
| `core_check_unavailable` | 数据目录不可读，完整性判据跑不起来 | 2 |
| `data_loss` | 磁盘记录数 > 内存可读记录数，或计数低于已登记基线 | 3 |

> **查不到 ≠ 没问题**：检查跑不起来时按最坏情况处理（只读），不按"空库"处理。

## 数据落在哪 / 它碰什么

1. 只读写 DSH 存储域下的 `project` 目录（默认 `<DSH_HOME>/storages`）。
2. 会写一个本地证据文件 `<DSH_HOME>/project-lite/evidence.jsonl`（每次请求一行，用于排障；不含业务内容）。
3. **不联网、不上传任何数据、不引入第三方运行时依赖**（`zod` 与 `@deepseek-ai/*` 由 DSH 宿主提供，标为 optional peer）。
4. 损坏的文件原样保留作证据，**不自动修复、不自动重建**。

## HTTP API

全部 `kind: 'exact'` 路由（9 条 GET + 14 条 POST = 23 条）。错误形状统一：

```json
{ "ok": false, "error": { "code": "READONLY_DEGRADED", "message": "域处于只读降级，拒绝新建：…" } }
```

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/project/state` | `reconcile=1`（可选） | 降级原因 + 检查状态；带 `reconcile=1` 跑一次对账并落盘 `last_reconcile_*` |
| GET | `/api/project/overview` | — | 四组项目 + 计数 + `writable` / `degradation`，另有 `deleted` 回收站组 |
| GET | `/api/project/get` | `id` | 单项目九分区详情 + `counts` + `unconfirmed` + `receipts`；`logs` 倒序上限 100；找不到 `found:false` |
| GET | `/api/project/links-of-session` | `session_id` | 某会话属于哪些项目（含依据/置信度） |
| GET | `/api/project/search` | `q`，`status`（可选） | 在 name/objective/next_action/tags 里大小写不敏感匹配 |
| GET | `/api/project/sessions` | `q`，`limit`（≤200，默认 50） | 会话候选：归属读 `workspace.json`，标题读会话缓存（读不到给 `null`，不编造） |
| GET | `/api/project/workspaces` | `q`，`limit`（≤200） | DSH 工作区候选（id/title/path/session_count） |
| GET | `/api/project/checkpoints` | `id` | 项目检查点列表（带来源会话标题） |
| GET | `/api/project/inbox` | `session_id` | 当前会话的待办任务（共享收件箱，读现有任务权威，不另建数据） |
| POST | `/api/project/create` | JSON body | 建项目（写入口之一） |
| POST | `/api/project/link` | JSON body | 挂会话，幂等；会话须先在 DSH 注册表存在 |
| POST | `/api/project/archive` | JSON body | 归档（active→archived），需 `expected_rev`；重复 `already_archived:true` |
| POST | `/api/project/restore` | JSON body | 恢复归档/回收站，需 `expected_rev`；否则 `409 NOT_ARCHIVED` |
| POST | `/api/project/unlink` | JSON body | 解除会话关联（软标记 unlinked，可复活），重复零副作用 |
| POST | `/api/project/delete` | JSON body | 软删除项目进回收站，可恢复；重复 `already_deleted:true` |
| POST | `/api/project/link-workspace` | JSON body | 关联工作区（软标记可复活）；建项目传 `workspace_id` 也会调它 |
| POST | `/api/project/unlink-workspace` | JSON body | 解除工作区关联（软标记，不物理删） |
| POST | `/api/project/deliverable` | JSON body | 登记交付物（只索引不搬运）；locator 用 workspace 相对路径或 absolute，自动算 `base_snapshot` |
| POST | `/api/project/unlink-deliverable` | JSON body | 解除交付物索引（软标记，不删文件） |
| POST | `/api/project/checkpoint-confirm` | JSON body | 人工确认检查点（不开放 Agent 工具，杜绝自我审批） |
| POST | `/api/project/checkpoint-reject` | JSON body | 人工拒绝检查点 |
| POST | `/api/project/receipt-decide` | JSON body | primary 裁定回执 accepted/rejected（正式状态唯一入口） |
| POST | `/api/project/update` | JSON body | 受控更新 status/next_action（白名单 + 单 primary + CAS + 枚举；archived/deleted 走专属路由） |

`POST /api/project/create` 的 body：

```json
{ "name": "必填，≤40 字", "objective": "必填", "next_action": "必填，4-60 字", "done_when": ["可选", "字符串数组"], "workspace_id": "可选" }
```

`done_when` 传字符串也行（含多行按行拆），服务端统一归一化成 `string[]`；空值不落盘。`next_action` 会被拒的情形：空、短于 4 字、长于 60 字、命中态度词黑名单（`继续推进` / `推进` / `待定` / `深入研究` / `tbd` / `todo` 等）——**「下一步」必须是能直接执行的动作，不是态度。**

`POST /api/project/link` 的 body：`{ "project_id": "prj_…", "session_id": "session-…", "role": "primary|supporting", "basis": "必填，依据" }`。八个写入口都接受可选 `requestId`（语义见上文幂等指纹）。

错误码：`METHOD_NOT_ALLOWED`(405) / `JSON_REQUIRED`(415) / `BAD_JSON`(400) / `INVALID_INPUT`(400) / `NEXT_ACTION_INVALID`(400) / `RECORD_INVALID`(400，带 `issues`) / `REQUEST_ID_CONFLICT`(409) / `SESSION_NOT_FOUND`(400) / `WORKSPACE_GONE`(400) / `WORKSPACE_PATH_MISSING`(400) / `BASIS_REQUIRED`(400) / `REGISTRY_UNAVAILABLE`(200 但 `ok:false`) / `READONLY_DEGRADED`(409) / `REV_CONFLICT`(409) / `PROJECT_ARCHIVED`(409) / `NOT_ARCHIVED`(409) / `INTERNAL_ERROR`(500)。

## 目录结构

```
index.js            Host 半：23 条 exact 路由 + storageDomain 接入
client.js           Client 半：面板（main slot + sidebar.panellist 入口）
cordis.patch.yml    DSH 插件补丁声明
core/
  spec.mjs          表结构与版本
  guard.mjs         磁盘扫描 + 判据（含 .deleting 语义）
  store.mjs         存储层 + 写原语 + reconcile
  agent-tools.mjs   Agent 工具（13 个：5 只读 + 8 受控/受限写）
  hostdeps.mjs      defineTool 宿主树解析（optional peer 兜底）
  read.mjs          只读服务层（同步读内存）
  util.mjs          ULID / 时间 / next_action 校验
  zip.mjs           备份打包
test/               回归（见下节）
```

## 开发与测试

```bash
npm run check      # 两个入口的语法门禁
npm test           # 界面层 3 套——零依赖，任何机器可跑
npm run test:core  # core 层——需要 DSH 提供 @deepseek-ai/*
npm run test:all   # 界面 + core
npm run test:full  # 全量 38 套（额外含 s1a/s1b 等）——当前 38/38 全绿

> **测试数字与套件清单的唯一权威见 [TEST-SUITES.md](TEST-SUITES.md)。**
```

**为什么拆成两档**：`core/spec.mjs` 静态 import 了 `@deepseek-ai/dsh-storage-domain` 与 `zod`，这两个包由 DSH 运行时提供、不在公共 npm 上。所以：

- `npm test` 用 `vm` 加载真实 `client.js`，不需要任何依赖 → **GitHub Actions 里跑的就是这一档**；
- `npm run test:core` 需要在装了 DSH 的机器上跑。

测试全部不需要启动 DSH。

## 已知限制

1. **物理删除未做**：删除项目走软删除（→`deleted` 回收站，可恢复），解除关联走软标记（`unlinked`，可复活）——都不物理删记录，因为删记录会破基线导致整库只读（E-10）。
2. 工作区、交付物都可关联/解除；交付物只索引不搬运，打开项目时现场 stat 校验三态；文件/文件夹和工作区都可右键反向挂。
3. 对账第 3 条已接 DSH 会话注册表：健康域 `9/0/0`；夹具域（无 `workspace.json`）`8/0/1`（那 1 项按设计 skipped）——两者都属正常。
4. 没有做真实 IO 故障注入（权限拒绝、磁盘满）的自动化测试。
5. 公共 CI 只覆盖界面层（原因见上节），core 层改动**不能只靠 CI**。
6. `0.x` 期间 API 可能变，不承诺兼容。
7. `task_dispatch_spawn` 依赖宿主 `ctx.subagents` 服务：profile 没挂该服务时工具不可用（面板照常），且需 primary 身份；真机全链已验证（v0.22.0），其它宿主版本未测。

## 参与

1. 报问题：[Issues](https://github.com/quietchisel/dsh-project-lite/issues/new/choose)（有模板；**数据损坏/安全问题请走私密渠道**，见 [SECURITY.md](SECURITY.md)）
2. 提 PR：[CONTRIBUTING.md](CONTRIBUTING.md)
3. 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
4. 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证

[MIT](LICENSE) © 2026 quietchisel
