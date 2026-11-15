# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

`0.x` 期间 minor 版本可能包含破坏性变更。

## [Unreleased]

### 计划中
- 关联会话的界面入口（后端 `linkSession` 与 `links-of-session` 已就绪）
- 归档 / 恢复
- 接入 DSH 会话注册表，让对账第 3 条不再恒为 `skipped`

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
