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

侧栏「项目」面板，三块：

1. **降级红条**：标题 + 原因 + 「已禁止：create_project、link_session、archive_project」；健康时显示「项目数据完整，可写。」
2. **检查状态**：通过 / 失败 / 未检查三个数字 + 未检查项的名称与原因（区分「核心 · 降级」与「外部 · 未验证」）。
3. **项目列表 + 新建表单**：按 `active → paused → done → archived` 四组展示；空库有空态；降级时列表只读、表单禁用并写明原因。

## 安装

本插件是 DSH profile 的本地插件，通过 `link:` 挂载。**两处都要改，只改一处不生效**（实测）：

1. 编辑 `<DSH_HOME>/profiles/<profile>/package.json`，在 `dependencies` 里加：

   ```json
   "dsh-project-lite": "link:<本仓库的绝对路径>"
   ```

2. 在 `<DSH_HOME>/profiles/<profile>/node_modules/` 下建一个指向同一目录的 Junction（Windows）：

   ```bat
   mklink /J "<DSH_HOME>\profiles\<profile>\node_modules\dsh-project-lite" "<本仓库的绝对路径>"
   ```

3. 完全退出 DSH 再启动（`index.js` 是 Host 半，必须重启才加载；`client.js` 改动刷新页面即可）。

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
| GET | `/api/project/overview` | — | 四组项目 + 计数 + `writable` / `degradation` |
| GET | `/api/project/get` | `id` | 单项目详情（关联会话/工作区/交付物/changelog）；找不到返回 `found:false`，不是 500 |
| GET | `/api/project/links-of-session` | `session_id` | 某会话属于哪些项目 |
| GET | `/api/project/search` | `q`，`status`（可选） | 在 name/objective/next_action/tags 里大小写不敏感匹配 |
| POST | `/api/project/create` | JSON body | 建项目。**唯一写入口** |

`POST /api/project/create` 的 body：

```json
{ "name": "必填，≤40 字", "objective": "必填", "next_action": "必填，4-60 字", "done_when": "可选" }
```

错误码：`METHOD_NOT_ALLOWED`(405) / `BAD_JSON`(400) / `INVALID_INPUT`(400) / `NEXT_ACTION_INVALID`(400) / `READONLY_DEGRADED`(409) / `INTERNAL_ERROR`(500)。

`next_action` 会被拒的情形：空、短于 4 字、长于 60 字、命中态度词黑名单（`继续推进` / `推进` / `待定` / `深入研究` / `tbd` / `todo` 等）。**「下一步」必须是能直接执行的动作，不是态度。**

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
index.js            Host 半：6 条 exact 路由 + storageDomain 接入
client.js           Client 半：面板（main slot + sidebar.panellist 入口）
cordis.patch.yml    DSH 插件补丁声明
core/
  spec.mjs          表结构与版本
  guard.mjs         磁盘扫描 + 判据（含 .deleting 语义）
  store.mjs         存储层 + 写原语 + reconcile
  read.mjs          只读服务层（同步读内存）
  util.mjs          ULID / 时间 / next_action 校验
  zip.mjs           备份打包
test/               回归（见下节）
```

## 开发与测试

```bash
npm run check      # 两个入口的语法门禁
npm test           # 界面层 48 条（s13 渲染 28 + s15 新建表单 20）——零依赖，任何机器可跑
npm run test:core  # core 层 53 条（s12 只读路由 32 + s14 新建路由 21）——需要 DSH 提供 @deepseek-ai/*
npm run test:all   # 全部 101 条
```

**为什么拆成两档**：`core/spec.mjs` 静态 import 了 `@deepseek-ai/dsh-storage-domain` 与 `zod`，这两个包由 DSH 运行时提供、不在公共 npm 上。所以：

- `npm test` 用 `vm` 加载真实 `client.js`，不需要任何依赖 → **GitHub Actions 里跑的就是这一档**；
- `npm run test:core` 需要在装了 DSH 的机器上跑。

测试全部不需要启动 DSH。

## 已知限制

1. **关联会话的 UI 还没做**（后端 `linkSession` 与 `links-of-session` 路由都在，但界面上没有入口）。
2. **归档/删除没有 UI 入口**，也没有对应路由。
3. 对账第 3 条（`session_id` 是否在 DSH 会话注册表里存在）**恒为 `skipped`**，因为还没接注册表。
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
