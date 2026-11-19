# dsh-project-lite

DSH（DeepSeek Harness）的轻量项目面板插件：**在项目数据可能已经损坏时，宁可只读，也不静默覆盖。**

> 兼容性：DSH `>= 0.2.2-rc.3` ｜ Node `>= 20` ｜ 已在 Windows 11 实测，macOS / Linux 未测
>
> A minimal project panel plugin for DSH. The point is not the CRUD — it is the integrity gate:
> when project data on disk and in memory disagree, the plugin refuses to write and tells you why.

## 为什么需要它

本地 JSON 存储最危险的故障不是"报错"，而是**看起来一切正常**：

1. 记录文件被静默跳过（坏 JSON、版本戳不对、写到一半）→ 内存里少了几条，界面上却是一片健康的绿灯；
2. `global.json` 被误删 → 程序把旧数据当成"全新空库"，第一次写入就把证据补成了正常基线；
3. 完整性检查本身跑不起来（目录不可读）→ 被当成"没问题"。

这三种都会导致**下一次写入把真实数据覆盖掉**。本插件的做法是：每次打开域、每次请求前都重新数一遍磁盘，和内存里的记录数比对；只要对不上，就进入**只读降级**并给出具体原因，而不是继续写。

## 核心机制

1. **完整性闸（integrity gate）**：`scanUnit` 数磁盘 → `evaluate` 比对内存 → `degradationReport()` 出人话原因 → 所有写入口先过 `assertWritable()`。
2. **降级即只读**：不是把按钮藏起来，是后端直接抛 `READONLY_DEGRADED`，HTTP 返回 409。
3. **元数据不可信时一个字节都不写**：`global.json` 缺失/损坏/版本不兼容时，连"降级快照"都不写——写下去等于亲手把证据补掉。
4. **判据实时重算**：store 长期存活，判据不能停在"打开那一刻"；每次请求前 `refresh()`。

## 界面

侧栏「项目」面板，从上到下：

1. **降级红条**：标题 + 原因 + 已禁止的写操作；健康时显示「项目数据完整，可写。」
2. **检查状态**：通过 / 失败 / 未检查三个数字 + 未检查项的名称与原因（区分「核心 · 降级」与「外部 · 未验证」）。
3. **项目列表 + 新建表单**：按 `active → paused → done → archived` 四组展示，另有折叠的「回收站」（deleted）；空库有空态；降级时列表只读、表单禁用并写明原因。`inferred` 项目名后带「未确认」徽标，点开看依据浮层（basis + legacy_refs）。
4. **项目详情**：点项目名展开六分区（项目 / 关联会话 / 工作区 / 交付物 / 变更记录 / 依据），再点一次收起。非归档项目显示「归档」「删除」按钮，归档/回收站项目显示「恢复」按钮，均有二次确认；关联会话行可「移除」。第 3 区「工作区」可「关联工作区」（从 DSH 真实工作区勾选）、可「移除」（软标记可复活），工作区标题可点击打开文件夹。第 4 区「交付物」可「加交付物」（手填或右键）、可「移除」，显示 ✅/❌/⚠ 三态与大小/修改时间，点标题打开所在目录，失效的单独一块。
5. **关联会话选择器**：项目行点「关联会话」展开，搜索并挂载会话；「收起」按钮固定在标题行，滚动候选列表时不会滚走。归档项目不显示此按钮（后端也拒绝，409）。

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
4. 完全退出 DSH 再启动（`index.js` 是 Host 半，必须重启才加载；`client.js` 改动刷新页面即可）。

`<DSH_HOME>` 默认是 `~/.dsh`，可用环境变量 `DSH_HOME` 覆盖。

## 数据落在哪 / 它碰什么

1. 只读写 DSH 存储域下的 `project` 目录（默认 `<DSH_HOME>/storages`）。
2. 会写一个本地证据文件 `<DSH_HOME>/project-lite/evidence.jsonl`（每次请求一行，用于排障；不含业务内容）。
3. **不联网、不上传任何数据、不引入第三方运行时依赖**（`zod` 与 `@deepseek-ai/*` 由 DSH 宿主提供）。
4. 损坏的文件原样保留作证据，**不自动修复、不自动重建**。

## HTTP API

全部 `kind: 'exact'` 路由。错误形状统一：

```json
{ "ok": false, "error": { "code": "READONLY_DEGRADED", "message": "域处于只读降级，拒绝新建：…" } }
```

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/project/state` | `reconcile=1`（可选） | 降级原因 + 检查状态；带 `reconcile=1` 会跑一次对账并落盘 `last_reconcile_*` |
| GET | `/api/project/overview` | — | 四组项目 + 计数 + `writable` / `degradation`；另有 `deleted` 回收站组 |
| GET | `/api/project/get` | `id` | 单项目详情（六分区：项目/会话/工作区/交付物/变更记录/依据）+ `counts` + `unconfirmed`；`logs` 倒序上限 100；找不到返回 `found:false`，不是 500 |
| GET | `/api/project/links-of-session` | `session_id` | 某会话属于哪些项目 |
| GET | `/api/project/search` | `q`，`status`（可选） | 在 name/objective/next_action/tags 里大小写不敏感匹配 |
| POST | `/api/project/create` | JSON body | 建项目。写入口之一 |
| GET | `/api/project/sessions` | `q`，`limit`（≤200，默认 50） | 会话候选：归属读 `workspace.json`，标题读会话缓存（读不到给 `null`，不编造） |
| POST | `/api/project/link` | JSON body | 把会话挂到项目。**幂等**：同一条重复提交零副作用 |
| POST | `/api/project/archive` | JSON body | 归档（active→archived）。需 `expected_rev` 防覆盖；重复归档 `already_archived:true` 零副作用 |
| POST | `/api/project/restore` | JSON body | 恢复归档/回收站（archived→active 或 deleted→active）。需 `expected_rev`；其它状态 `409 NOT_ARCHIVED` |
| POST | `/api/project/unlink` | JSON body | 解除会话关联。软标记 `unlinked`（不物理删记录，可重新关联复活），重复解除零副作用 |
| POST | `/api/project/delete` | JSON body | 软删除项目（active→deleted 进回收站）。不删记录、可恢复；重复删除 `already_deleted:true` |
| GET | `/api/project/workspaces` | `q`，`limit`（≤200） | DSH 工作区候选（id/title/path/session_count），供关联选择器 |
| POST | `/api/project/link-workspace` | JSON body | 关联工作区（软标记，可复活）；重复零副作用。建项目传 `workspace_id` 也会调它 |
| POST | `/api/project/unlink-workspace` | JSON body | 解除工作区关联（软标记 unlinked，不物理删） |
| POST | `/api/project/deliverable` | JSON body | 登记交付物（只索引不搬运）。locator: workspace 相对路径(workspace_id+rel)或 absolute(path)；自动算 base_snapshot |
| POST | `/api/project/unlink-deliverable` | JSON body | 解除交付物索引（软标记 unlinked，不删文件） |

`POST /api/project/create` 的 body：

```json
{ "name": "必填，≤40 字", "objective": "必填", "next_action": "必填，4-60 字", "done_when": ["可选", "字符串数组"] }
```

`done_when` 传字符串也行（含多行会按行拆成多项），服务端统一归一化成 `string[]`；空值不落盘。

**所有写入在落盘前都会用读路径同一份 schema 校验**（`spec.tables[*].valueSchema`）：不合法直接 `RECORD_INVALID`，一个字节都不写。这一层不能省——域层只在开库时校验磁盘记录，`put` 不校验，漏了这一层就会出现「写得进去、下次开库被隔离、整库降级只读」（0.2.1 修的就是这个）。

八个写入口（create / link / archive / restore / unlink / delete / link-workspace / unlink-workspace）都接受可选 `requestId`（4-64 位字母数字 `_-`）：同 id 同参数 → 回上次结果且 `replayed:true`；同 id 不同参数 → `409 REQUEST_ID_CONFLICT`。

`POST /api/project/link` 的 body：`{ "project_id": "prj_…", "session_id": "session-…", "role": "primary|supporting", "basis": "必填，依据" }`。会话必须先在 DSH 注册表里存在，否则 `400 SESSION_NOT_FOUND`。

错误码：`METHOD_NOT_ALLOWED`(405) / `JSON_REQUIRED`(415) / `BAD_JSON`(400) / `INVALID_INPUT`(400) / `NEXT_ACTION_INVALID`(400) / `RECORD_INVALID`(400，带 `issues`) / `REQUEST_ID_CONFLICT`(409) / `SESSION_NOT_FOUND`(400) / `WORKSPACE_GONE`(400) / `WORKSPACE_PATH_MISSING`(400) / `BASIS_REQUIRED`(400) / `REGISTRY_UNAVAILABLE`(200 但 `ok:false`) / `READONLY_DEGRADED`(409) / `REV_CONFLICT`(409) / `PROJECT_ARCHIVED`(409) / `NOT_ARCHIVED`(409) / `INTERNAL_ERROR`(500)。

`next_action` 会被拒的情形：空、短于 4 字、长于 60 字、命中态度词黑名单（`继续推进` / `推进` / `待定` / `深入研究` / `tbd` / `todo` 等）。**「下一步」必须是能直接执行的动作，不是态度。**

## 给 Agent 用（工具）

插件向 DSH 的 Agent 注册 5 个工具（`project_` 前缀，避免与任务看板撞名）：

| 工具 | 用途 | 权限 |
|---|---|---|
| `project_list` | 我有哪些项目（摘要 + 四组计数） | 只读 |
| `project_get` | 这事到哪了（六分区详情 + 变更记录） | 只读 |
| `project_links_of_session` | 这个会话属于哪个项目（含依据/置信度） | 只读 |
| `project_create` | 建项目——仅当使用者明确要求；`next_action` 必须是人确认过的动作 | 受控写 |
| `project_link_session` | 把会话挂到项目——须先取得人同意，`basis` 必填 | 受控写 |

三角色分工：**Agent 负责「看懂」，插件负责「记住」，你负责「点头」。** 工具不提供删除、批量导入或状态修改——那些是人的决定。

会话头部徽标：打开任一旧会话，标题旁会显示它归属的项目（◆ 项目名 + 置信度），不用主动打开项目面板。这是这套机制真正的使用入口——总览页只是补充。

## 五种降级状态

| `kind` | 触发条件 | 判定优先级 |
|---|---|---|
| `meta_missing` | 磁盘上有记录，但 `global.json` 不见了 | 1 |
| `meta_corrupt` | `global.json` 无法解析（原文件保留作证据） | 1 |
| `version_incompatible` | 数据版本戳不在接受范围内（通常是插件被降级过） | 1 |
| `core_check_unavailable` | 数据目录不可读，完整性判据跑不起来 | 2 |
| `data_loss` | 磁盘记录数 > 内存可读记录数，或计数低于已登记基线 | 3 |

> **查不到 ≠ 没问题**：检查跑不起来时按最坏情况处理（只读），不按"空库"处理。

## 目录结构

```
index.js            Host 半：15 条 exact 路由 + storageDomain 接入
client.js           Client 半：面板（main slot + sidebar.panellist 入口）
cordis.patch.yml    DSH 插件补丁声明
core/
  spec.mjs          表结构与版本
  guard.mjs         磁盘扫描 + 判据（含 .deleting 语义）
  store.mjs         存储层 + 写原语 + reconcile
  agent-tools.mjs   Agent 工具（S4：3 只读 + 2 受控写）
  hostdeps.mjs      defineTool 宿主树解析（optional peer 兜底）
  read.mjs          只读服务层（同步读内存）
  util.mjs          ULID / 时间 / next_action 校验
  zip.mjs           备份打包
test/               回归（见下节）
```

## 开发与测试

```bash
npm run check      # 两个入口的语法门禁
npm test           # 界面层 3 套 / 84 条——零依赖，任何机器可跑
npm run test:core  # core 层 21 套 / 348 条——需要 DSH 提供 @deepseek-ai/*
npm run test:all   # 全部 24 套 / 432 条

> **测试数字与套件清单的唯一权威见 [TEST-SUITES.md](TEST-SUITES.md)**。
> 全量运行器（含 s1a/s1b 等额外 3 套）为 27 套 / 555 条，27/27 全绿。
```

**为什么拆成两档**：`core/spec.mjs` 静态 import 了 `@deepseek-ai/dsh-storage-domain` 与 `zod`，这两个包由 DSH 运行时提供、不在公共 npm 上。所以：

- `npm test` 用 `vm` 加载真实 `client.js`，不需要任何依赖 → **GitHub Actions 里跑的就是这一档**；
- `npm run test:core` 需要在装了 DSH 的机器上跑。

测试全部不需要启动 DSH。

## 已知限制

1. **物理删除未做**：删除项目走软删除（status→deleted 回收站，可恢复），解除关联走软标记（unlinked，可复活）——都不物理删记录，因为删记录会破基线导致整库只读（E-10）。真正的物理抹除不提供。见上方 API 表。
2. 交付物区已可登记/解除（v0.14）：只索引不搬运，详情第 4 区手填或文件/文件夹右键「加入交付物…」，打开项目时现场 stat 校验三态。工作区区已可关联/解除（v0.13），候选来自 DSH `workspace.json`；也可在工作区右键「加入项目…」反向挂（v0.13.1）。
3. 对账第 3 条已接 DSH 会话注册表：健康域 `9/0/0`；夹具域（无 `workspace.json`）`8/0/1`（那 1 项按设计 skipped）——两者都属正常。
4. 没有做真实 IO 故障注入（权限拒绝、磁盘满）的自动化测试。
5. 公共 CI 只覆盖界面层（原因见上节），core 层改动**不能只靠 CI**。
6. 版本 `0.x` 期间 API 可能变，不承诺兼容。

## 参与

1. 报问题：[Issues](https://github.com/quietchisel/dsh-project-lite/issues/new/choose)（有模板；**数据损坏/安全问题请走私密渠道**，见 [SECURITY.md](SECURITY.md)）
2. 提 PR：[CONTRIBUTING.md](CONTRIBUTING.md)
3. 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
4. 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证

[MIT](LICENSE) © 2026 quietchisel
