# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

`0.x` 期间 minor 版本可能包含破坏性变更。

## [Unreleased]

（暂无）

## [0.13.0] - 2026-11-18

### 新增（工作区维度：第 3 区从只读占位变成真能用）

- **关联工作区**（POST `/api/project/link-workspace`）：详情第 3 区加「关联工作区」，从 DSH `workspace.json` 的真实工作区里搜索勾选（id / 标题 / 路径）。不手打 id，不会写错。
- **解除关联**（POST `/api/project/unlink-workspace`）：软标记 `unlinked`，不物理删记录；重新关联自动复活。与会话解绑同一套安全逻辑。
- **点开文件夹**：第 3 区的工作区标题可点击，调宿主 shell 打开对应路径；环境不支持时显示路径可复制，不静默失败。
- **建项目带出初始工作区**：新建表单加可选「初始工作区」下拉（挂载时从 DSH 拉取候选），建项目时一并关联，返回体带 `workspaceLink`。
- registry 新增 `listWorkspaces()`（只读快照，毫秒级）；ProjectWorkspaceSchema 加可选 `workspace_path` / `unlinked` / `unlinked_at`。

### 兼容性

- 仅加可选字段；旧记录可读。`createProject` 新增可选 workspace 参数，老调用不受影响。

### 测试

- 新增 s28（15 项：列工作区/关联/解绑/复活/建项目带出/重开不降级/405-415）；同步 s12/s14 路由总数 12→15、s13/s15 POST 调用点 7→9、s19 工作区空态文案（错误账本硬规矩第 5 条）。
- **316/316**（17 套全绿）。

## [0.12.0] - 2026-11-18

### 新增（使用者第一次真用后暴露的缺口：只能加不能减）

- **解除会话关联**（POST `/api/project/unlink`）：界面详情第 2 区每条会话加「移除」按钮，二次确认后解除。走**软标记** `unlinked:true`，不物理删记录——避免删记录导致计数低于基线、整库只读（错误账本 E-10）。重新关联自动复活；changelog 用预留的 `unlink` op 留审计。
- **软删除项目 / 回收站**（POST `/api/project/delete`）：界面加「删除」按钮，二次确认后项目 status→`deleted`，从主列表移入「回收站」折叠区，可一键恢复。不删任何记录、子记录零改动，计数不变、基线不破。
- 读层过滤：`getProject` / `linksOfSession` 不再返回 unlinked 关联——解绑后会话头部徽标同步消失。
- 危险操作按 UI 技能规范：红色语义按钮始终带「移除/删除」文字，不只靠颜色表意；全部二次确认。

### 兼容性

- schema 仅加可选字段（`unlinked`/`unlinked_at`）与 enum 值（`deleted`/`delete`）；旧记录全部可读，已用探针证明，无需数据迁移。

### 测试

- 新增 s27（19 项：解绑/复活/软删/回收站/恢复/关掉重开不降级/405-415）；同步 s12/s14 路由总数 10→12、s13/s15 POST 调用点 5→7（错误账本硬规矩第 5 条）。
- **301/301**（16 套全绿）。

## [0.11.1] - 2026-11-17

### 修复（UI/UX 重设计，按 ui-ux-pro-max 规则）

- **关联会话显示人能认的标题**：后端 `linkView` 经 `registry.titlesOf()` 补会话标题（读不到留空、不编造）；详情第 2 区与关联选择器从「role · 一长串 session id · basis」改为「标题为主 + 工作区/角色为辅 + 短 id 退到末尾 + 未确认语义色徽标」。
- 会话行加 hover 反馈、类型层级（13px 标题 / 11px 元数据）、空态引导。
- 修真机抓到的工具注册失败：`output.schema.type` 从非法的 `json` 改为 `object`；本地 defineTool 加同口径校验防再漏。

### 测试

- s19 新增 T32（详情会话行显示标题）；s12 适配 getProject/linksOfSession 异步化；**282/282**（15 套全绿）

### 追加修复（同版本）

- 修 `[object Object]`：会话副行把 React 元素与字符串用 `+` 拼接，改为 JSX 数组分项。
- 标题读不到时回落**工作区名**（registry 注册表几乎总有），不再只显示机器味短 id——真实夹具里两条会话的 projcache 标题文件都不存在，`title:null` 是数据现实，不编造。
- 真机确认：5 个 Agent 工具已成功注册（evidence `agent-tools-registered`），上一轮 schema 修复生效。

## [0.11.0] - 2026-11-17


### 新增：兑现原始设想的核心（S4）

- **Agent 工具（3 只读 + 2 受控写）**：`project_list` / `project_get` / `project_links_of_session`（只读）；`project_create` / `project_link_session`（只在人明确要求时调，`next_action` 与 `basis` 有硬约束）。工具经 `ctx.tools.register` 注册，走官方 `defineTool`（拿不到则用本地等价），拿不到 tools 服务时插件照常只跑面板。
- **会话头部项目徽标**：注册到 `conversation.session.header.actions`（list/session scope），打开任一旧会话，标题旁显示它归属的项目 + 置信度；无归属或任何异常则静默不显示（低打扰）。这是原设想里「如果只能做一件事」的那枚徽标。
- `defineTool` 解析借鉴同 profile 的 `dsh-bili-scroll/lib/hostdeps.mjs`（optional peer 不装会让插件不激活）。

### 测试

- 新增 `s26-agent-tools`（17 项）：注册、只读、写约束、幂等、dispose；**281/281**（15 套全绿）

### 注意

- 工具/徽标是 Host 与 Client 双重改动，**需重启 DSH** 才生效；重启后 evidence 里应有 `agent-tools-registered` 一条。

## [0.10.2] - 2026-11-16

### 修复（纯界面交互，client.js）

- 详情内嵌到被点项目行正下方：项目名多时，详情不再游离在列表最底部、与标题分离。
- 关联会话选择器标题行消除滚动时透出的「缝」：picker 上内边距移进 sticky 标题行 + 负 margin 铺满宽度，背景连续遮住滚动内容。

### 测试

- `s19` 新增 2 项（T30/T31）：详情内嵌位置 + 无透明 margin；**264/264**（十四套全绿）

## [0.10.1] - 2026-11-16

### 修复（纯界面交互，client.js）

- 项目名 toggle：点已展开的项目名 → 收起详情，再点 → 重新展开（之前只能展开，收起要点底部按钮）。
- 关联会话选择器标题行 `position: sticky; top: 0`：滚候选列表时「收起」按钮固定在顶部，不用滚回最上面。

### 测试

- `s19` 新增 3 项（T27/T28/T29）：toggle 双向 + sticky；**262/262**（十四套全绿）

## [0.10.0] - 2026-11-16

### 新增：恢复（unarchive，与归档配对）

- `POST /api/project/restore`：把 `archived` 改回 `active`，与归档完全对称——`expected_rev` 防覆盖、`requestId` 幂等、写前 schema 校验、changelog 记 `op=restore`、基线刷新。
- 详情页：归档项目显示「恢复」按钮 + 二次确认；恢复后回到 active 组，可再次归档（往返闭环）。
- 非归档项目恢复 → `409 NOT_ARCHIVED`；不存在 → 404；降级 → 409 且零落盘。

### 测试

- 新增 `s25-restore`（13 项）：往返闭环、rev 递增、重复/冲突/非归档拒绝、404/405/415、降级零落盘
- **261/261**（十四套）

### 注意

- 恢复是 Host 半（`index.js`）+ core 改动，需重启 DSH 才在界面生效。
## [0.9.0] - 2026-11-16

### 新增：归档（把 core 已有的能力接到界面）

- `POST /api/project/archive`：复用 core 里早就有的 `store.archiveProject`（写前校验 + changelog + 基线刷新）。
- **二层防误操作**：`expected_rev` 防并发覆盖（错了 `409 REV_CONFLICT`，零落盘）+ `requestId` 幂等（重复提交回上次结果）。
- 已归档的项目重复归档 → `already_archived: true`，**零副作用**（不写第二条 changelog）。
- 详情页标题行加「归档」按钮 + **二次确认**（确认才发 POST）；归档后项目从 `active` 组移到 `archived` 组，详情立刻刷新。

### 明确不做

- **恢复（unarchive）没有做**——那是另一个功能，不混在归档里。归档数据没删，只是改了 `status`，随时可以查。
- 删除仍然不做（不可逆，且不经过项目域）。

### 测试

- 新增 `s24-archive`（14 项）：成功 / 重复 / 幂等 / 冲突 / 不存在 / 降级 / 405 / 415，冲突与降级均零落盘
- s19 加 T24–T26（按钮 → 二次确认 → 才发 POST）；**246/246**
## [0.8.2] - 2026-11-16

### 修复：`legacy_refs` 是路由层死字段（与 0.4.0 的 tags 同类）

- `schema` 声明了 `legacy_refs`、`store.createProject` 也会写它，但 `POST /api/project/create` **路由层没把 `body.legacy_refs` 传给 store**，幂等指纹也没算它。结果：前端传来历史来源，落盘时悄悄消失。
- 这暴露了 0.4.0 修 `tags` 时的漏——当时只补了 store 签名 + 路由透传，没有扫一遍 schema 里**其他可选数组字段**是不是也走了同一条路。

### 测试

- `s20` 加 R16/R17：带 `legacy_refs` 建项目，验证**返回体和落盘文件**里都在；`recent_requests` 期望从 2 改 3。
- **229/229**（s20 17 项）

### 注意

- 这条修复在 Host 半（`index.js`），**需要重启 DSH** 才生效。重启前已建的项目仍缺 `legacy_refs`。
## [0.8.1] - 2026-11-16

### 修复：关联校验偶发读到旧注册表

- `verify()` 改用 `snapshot({force: true})`，不再吃 mtime + TTL 缓存。

**起因**：`s21` 的 A4（工作区目录被删后拒绝关联）在全量回归里偶发失败，连跑 5 次中 2 次失败。根因是 `workspace.json` 的 mtime 是毫秒粒度，测试在**同一毫秒内连续改两次**，缓存误判"没变"，拿到旧路径（仍存在）→ 校验通过。

**为什么这是真缺陷而不是测试问题**：真实场景里用户可能在极短时间内改工作区配置，缓存同样会漏；而且关联是**写操作**，本来就该拿最新注册表，不该吃缓存。

### 测试

- 修复后 `s21` 连跑 5 次 **5/5 稳定通过**；全量 227/227
## [0.8.0] - 2026-11-16

### 新增：列表行「未确认」徽标 → 依据浮层

- `inferred` 项目在列表行的名字后面显示「未确认」徽标，点开弹出依据浮层：`basis` + `legacy_refs`（历史来源）。
- 与详情页第 6 区**同源数据**（都来自 `overview` 已有的 `confidence / basis / legacy_refs`），后端零改动。
- 这补上了 0.4.0 记下的偏离：当时依据只做进详情页，列表行徽标点不开。

### 测试

- **227/227**：s19 从 19 加到 23（新增徽标可点、浮层显示 basis+legacy_refs、关闭按钮、关闭后消失）
## [0.7.2] - 2026-11-16

### 测试：底层互斥核查（原 1.12 计划的等价替代）

- 新增 `s23-storage-exclusivity`（5 项）：证明 `DomainFacility` 同域重复 open 抛 `already-open`、`writeAtomic` 的 `wx` 对已存在文件抛 `EEXIST`、不同 root 互不干扰、我们不引入 `project.lock`。

### 为什么不加 project.lock

核查发现底层已有两层互斥（域层 `reserved` Set + 文件层 `wx` 原子写），且 DSH 是单实例、域由宿主注入。在插件里加锁是重复劳动，还可能导致测试里多 store 实例互锁。详见路线图附录 A 的 1.12 结论。

### 测试

- **221/221**（新增 s23 5 项）
## [0.7.1] - 2026-11-16

### 测试：损坏隔离回归（原 1.11 计划的等价替代）

- 新增 `s22-corrupt-isolation`（8 项）：证明损坏的 `global.json` 在 open + reconcile 全程后**字节完全不变**、判据 `G_GLOBAL_CORRUPT`、不误判新库、reconcile 拒绝落盘（`META_UNSAFE`）。

### 为什么不把坏文件改名成 `.corrupt-<ts>`

核查后发现这个动作有三害：①目标已达成（原字节不动）②改名会把诊断从「损坏」降成「缺失」③在只读域里做写操作，违背「降级零写盘」。所以改为**用测试钉死现状**——防止以后被改坏，而不是加多余动作。详见路线图附录 A 的 1.11 结论。

### 测试

- **216/216**（新增 s22 8 项）
## [0.7.0] - 2026-11-16

### 新增：关联前的 fail-closed 三校验

`POST /api/project/link` 在写入前依次检查，任一不过就 `400` + 人话原因、**零落盘**：

1. 会话在 DSH 注册表里（原有）；
2. 会话所属工作区**还在工作区列表**里（`global.workspaceIds`）；
3. 工作区目录**在磁盘上真实存在**。

### 为什么加 2、3

会话还在、但它所在的工作区文件夹被删了，关联进来就是一条**指向空气的引用**——详情里只显示一个路径，点过去什么都没有。宁可现在拒，也不要留假引用。

### 错误码

- `SESSION_NOT_FOUND`：会话不在注册表
- `WORKSPACE_GONE`：工作区已被移出列表
- `WORKSPACE_PATH_MISSING`：工作区没记路径，或目录已不存在
- 注册表本身读不到时**放行**，但响应里 `registryChecked: false`——不假装校验过。

### 测试

- **208/208**：新增 `s21-link-admission`（8 项），含"字段缺失 vs 空数组"的区分
- 顺带修：s17 / s20 夹具原来把工作区路径写成不存在的目录，新校验会正确拒绝——夹具改成真实存在的临时目录
## [0.6.0] - 2026-11-16

### 新增：变更来源标记（声明 vs 证据）

- `ChangelogSchema` 加可选字段 `source: "manual" | "run"`——这条变更是**人点的**还是**程序跑的**。
- 字段可选，旧记录没有它也能解析（不加版本戳，无需迁移）；缺省按 `manual` 处理。
- 详情页「变更记录」每条后面标「人工 / 程序」。

### 为什么现在做

现在所有写入口都是人点的，所以全是 `manual`——**这个字段眼下不会改变任何行为**，它的价值是给将来的 runner（卡 → 自动开会话 → 回写结论）留一个不会被忽略的位置。等 runner 接进来再补这个字段，历史记录就永远分不清哪条是谁干的。

### 测试

- **200/200**：s18 从 14 加到 15（新增「每条变更都标了来源」断言）
## [0.5.1] - 2026-11-16

### 修复

- **窗口缩小时整块面板无法滚动**，下面的内容看不到。之前只给详情块和关联选择器加了滚动，外层容器没加。现在面板自身 `maxHeight: 100vh` + `overflowY: auto`——不依赖宿主容器是否给了确定高度。

### 测试

- **199/199**：s19 从 18 加到 19（新增「面板整体可滚」断言）
## [0.5.0] - 2026-11-16

### 新增：写入口幂等指纹（requestId + sha256(动作)）

- `POST /api/project/create` 与 `POST /api/project/link` 接受可选 `requestId`（4-64 位字母数字 `_-`）。
- **同 id + 同参数** → 直接回上次结果，`replayed: true`，**不重复执行**（项目数不变、rev 不变、changelog 不增）。
- **同 id + 不同参数** → `409 REQUEST_ID_CONFLICT`，拒绝复用同一个 id 覆盖上次结果。
- 不带 `requestId` → 保持旧行为（每次都是新动作），响应里 `replayed: false`。
- 指纹存 `global.json` 的 `recent_requests`（最近 256 条，含 `{id, fp, at, value}`）；字段可选，旧库无需迁移。

### 为什么

`link` 靠确定性键天然幂等，但 **`create` 每点一次就是一个新项目**：界面重复提交、网络重试、agent 重放都会留下两条"看起来一样"的记录。指纹把「同一个意图」和「两次真实意图」区分开。

### 测试

- **197/197**（s12 32 / s13 28 / s14 21 / s15 21 / s16 19 / s17 29 / s18 14 / s19 18 / s20 15）
- 新增 `s20-idempotency`（15 项）：同 id 同参数回放、同 id 异参数 409、非法 id 400、无 id 保持旧行为、指纹落盘与上限

### 已知边界

- `recent_requests` 只保留最近 256 条：更早的 requestId 会被淘汰，重放它会真的再执行一次。
- 指纹只覆盖 `create` / `link` 两个写入口；归档走 store 直调，没有路由也没有指纹。
## [0.4.0] - 2026-11-16

### 新增：项目详情页（六分区）

- 项目名可点 → 六个分区：**项目 / 关联会话 / 工作区 / 交付物 / 变更记录 / 依据**。每区空态都有一句话，不留空白。
- `GET /api/project/get` 补 `counts`（各区条数）与 **`unconfirmed`**：所有 `confidence === "inferred"` 的项目/会话/工作区/交付物收成一个数组，`inferred` 一律渲染成「未确认」徽标。
- `logs` 改为按时间**倒序 + 上限 100**（详情页只回答"最近发生了什么"，不做全量导出）。

### 修复

- **`tags` 是死字段**：schema 声明了 `tags: string[]`（最多 3 个），`assertRecord` 也校验它，但 `createProject` 的签名里根本没有 `tags` —— 通过 API 建项目永远写不进标签。现在补上归一化与透传。

### 为什么 `unconfirmed` 在后端算

徽标与依据展示都需要判断"哪些没确认"。如果前端各判一遍，两处规则一定会漂移——`done_when` 那次就是写路径与读路径各有一套规则，代价是一条记录被隔离、整库降级只读。后端算一次，前端只渲染。

### 测试

- **178/178**（s12 32 / s13 28 / s14 21 / s15 21 / s16 19 / s17 29 / s18 14 / s19 14）
- 新增 `s18-detail-read`（14 项，后端装配）与 `s19-detail-ui`（14 项，vm 加载真实 client.js 渲染六分区）

### 已知边界

- 「依据」做成了详情页第 6 区，**不是列表页徽标点开的浮层**；列表行上的徽标暂时点不开。
- 工作区与交付物两区**只读**，不做自动发现、不做注册写入口（留给后续版本）。
- 详情页**未在真实桌面验证**（只有 Node 层渲染回归）。
## [0.3.0] - 2026-11-16

### 新增：1.4 关联会话

- `GET /api/project/sessions`：会话候选列表。**会话归属**读 `<storages>/workspace.json`（25 个工作区 / 221 条 sessionIds / 约 50KB，毫秒级）；**会话标题**读 `session_projcache/sessions/<uuid>.json`，按 mtime 缓存、只在真要显示时才读（546 个文件共 25.7MB，不全量扫）。缓存里没有标题就返回 `null`，界面回落到 session id，**不编造标题**。
- `POST /api/project/link`：把会话挂到项目上。幂等由 `store.linkSession` 保证（确定性键 + 内容相同则零副作用），路由层不重复实现。负例闸：会话不在注册表 → `400 SESSION_NOT_FOUND`，不许手拼 id 造孤儿；缺 `basis` → `400 BASIS_REQUIRED`。
- 面板：项目行「关联会话」→ 选择器（搜索 + 候选 + 「已经关联过了，零副作用」提示）。
- 会话右键「加入项目…」→ 浮层选项目。该入口包在 `try` 里：`shell.overlay` 或 `contextMenus` 不可用时只少一个入口，**不影响面板本身**。
- 对账第 3 条（`link.session_id` 在 DSH 注册表里存在）从**恒 `skipped`** 变为真实判定：会话都在 → `pass`；会话被删 → `fail` 但 `scope=external`，**不降级**（删会话是正常操作，不该把库锁成只读）；注册表读不到 → 仍 `skipped`，绝不报 `pass`。

### 变更
- 对账计数预期从 `8/0/1` 变为 `9/0/0`（第 3 条不再恒为未检查）
- 新增 `test/s17-link-session.mjs`（29 项）：真幂等三次零写盘、四个负例零写盘、会话被删 fail 不降级、注册表缺失 skipped 不报 pass

### 测试
- 150/150 通过（s12 32 / s13 28 / s14 21 / s15 21 / s16 19 / s17 29）

### 已知边界
- 刚建的会话在 `workspace.json` 里立刻有，但 `projcache` 的标题文件可能还没落盘 → 标题为 `null`（界面回落，不编造）
- 真实桌面已验证（2026-11-16，DSH 0.2.2-rc.3 / Windows）：面板 `通过 9 · 失败 0 · 未检查 0`，项目行「关联会话」按钮在，会话右键出现「加入项目…」
## [0.2.1] - 2026-11-16

### 修复
- **写路径不校验记录，导致下次开库被隔离、整库降级只读。** 新建表单把 `done_when` 当字符串写进盘，schema 要的是 `string[]`；域层只在 `open` 时校验磁盘记录、`put` 不校验，于是写入当刻成功、下次开库该记录被 `backup-and-skip` 隔离，计数 1→0 触发 `D3_BASELINE_REGRESSION`，面板变成「检测到记录丢失或基线回退」。
  - `store` 四条写入路径（`createProject` / `linkSession` ×2 / `archiveProject` / `writeLog`）改为**写前用读路径同一份 `valueSchema` 校验**，不合法抛 `RECORD_INVALID`，一个字节都不落盘
  - `done_when` 归一化：字符串（含多行）→ `string[]`，空值 → 字段不落盘；前端也改成提交数组
  - `POST /api/project/create` 的 `RECORD_INVALID` 响应带上逐字段 `issues`
- 新增 `test/s16-write-read-agree.mjs`（19 项）：`close` 后真重开、计数仍为 1、无 `.bak` 隔离；非法入参零写盘；绕过 store 直接塞坏记录仍会被隔离（反向对照）

## [0.2.0] - 2026-11-16

### 新增
- `POST /api/project/create`：唯一写入口，两层闸（路由层 `writable` 判定 + `store.createProject` 的 `assertWritable`）
- 面板「新建项目」表单：`ready / submitting / readonly / loading` 四态；降级时禁用并写明原因；提交失败只显示局部错误，不白屏
- 项目列表：四组（`active/paused/done/archived`）+ 计数 + 空态 + 降级只读 + 局部错误保留上次数据

### 修复
- 面板 5 秒只读轮询会覆盖掉带 `reconcile` 的完整响应，界面永远停在「对账结果读取中…」

## [0.1.0] - 2026-11-14

### 新增
- 降级红条（五种 `kind`：`meta_missing` / `meta_corrupt` / `version_incompatible` / `core_check_unavailable` / `data_loss`）
- 检查状态面板（通过 / 失败 / 未检查，未检查项带「核心 · 降级」「外部 · 未验证」标签）
- 四条只读路由：`overview` / `get` / `links-of-session` / `search`
- `GET /api/project/state`：降级原因 + 检查状态

### 修复
- `.deleting` 暂存文件被误判成「合法新库」，导致元数据缺失时仍可写
- 扫描不可用时 `reconcile()` 假绿（第 6/8 条本应 `skipped` 却报 `pass`）
