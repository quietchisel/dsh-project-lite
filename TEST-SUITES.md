# dsh-project-lite 测试套件清单（唯一可信来源）

> 本文件是测试套件与断言数的唯一权威。README / 评审材料凡涉及测试数字，一律以此为准。
> 更新于 2026-11-20（审计响应轮）。运行口径：`_tmp/跑测试-运行树.mjs`（Node 运行时 v24.21.0）。

## 分档

| 命令 | 套件 | 断言 | 依赖 | 说明 |
|---|---|---|---|---|
| `npm test` | 3 套 | 84 条 | 零依赖（vm 加载 client.js） | 界面层；GitHub Actions 跑这档 |
| `npm run test:core` | 21 套 | 348 条 | 需要 DSH 宿主 `@deepseek-ai/*` 或自建后端 | core 层 |
| `npm run test:all` | 24 套 | 432 条 | 同上 | = test + test:core |
| 运行器额外 | 3 套 | 123 条 | 同上 | s1a/s1b-primary/s1b-role-default，不在 npm 脚本内 |
| **运行器全量** | **27 套** | **555 条** | 同上 | `node _tmp/跑测试-运行树.mjs`，27/27 全绿 |

> 说明：test 目录有 27 个 `s*.mjs` 套件 + `_lib.mjs`（共享库，非套件）。`npm test` 3 套 = s13/s15/s19；其余 24 套走 core 档。运行器 27 套 = test:all 的 24 套 + 额外 3 套。

## 逐套断言数（本次实测 2026-11-20）

| 套件 | 断言 | 档 | 套件 | 断言 | 档 |
|---|---|---|---|---|---|
| s13-overview-panel | 28 | test | s12-read-routes | 32 | core |
| s15-create-form | 22 | test | s14-create-route | 21 | core |
| s19-detail-ui | 34 | test | s16-write-read-agree | 19 | core |
| s17-link-session | 29 | core | s18-detail-read | 15 | core |
| s20-idempotency | 17 | core | s21-link-admission | 8 | core |
| s22-corrupt-isolation | 8 | core | s23-storage-exclusivity | 5 | core |
| s24-archive | 16 | core | s25-restore | 13 | core |
| s26-agent-tools | 20 | core | s27-unlink-delete | 19 | core |
| s28-workspace | 18 | core | s29-session-title | 5 | core |
| s30-deliverable | 13 | core | s1c-attribution | 38 | core |
| s31-task-section | 35 | core | s32-concurrent-idempotency | 7 | core |
| s33-lock-takeover | 6 | core | s34-evidence-log | 4 | core |
| s1a-journal（额外） | 86 | extra | s1b-primary（额外） | 17 | extra |
| s1b-role-default（额外） | 20 | extra | | | |

合计：27 套 / 555 条断言，全量运行 27/27 PASS、0 FAIL。

## 新增测试（审计响应轮）

| 套件 | 覆盖 | 对应整改 |
|---|---|---|
| s32-concurrent-idempotency | 同 requestId 10/2 并发、同 id 不同参数、不同 id 并发、账本不丢更新 | A：claimRequest 原子化 |
| s33-lock-takeover | 活跃锁拒接管、死锁可接管、并发接管单选、损坏元数据、授权闸 | B：recoverStaleLock 新鲜度复核 |
| s34-evidence-log | 容量轮转、历史上限、session_id 脱敏、写失败不影响主流程 | E：evidence 轮转+脱敏 |
| s26 新增 T18/T19/T20 | 非法 role 拒绝且不产生归属 | C：role 严格校验 |

## 口径说明

- 每套断言数从各套件运行时输出的 `SUMMARY pass/total verdict` 取数，汇总于 `证据/测试日志/full-run.log`。
- 部分 core 套件（s12/s14/s27/s28/s29/s30）输出 PASS 但不打印 SUMMARY 行（沿用旧格式），其退出码 0 即判通过；断言数见各自源码的 `push(...)` 调用数。上表这些套件的数字来自源码计数，非 SUMMARY。
- 不以"删测试/改统计口径"方式美化数字；本清单随每次测试变更同步更新。
