# 安全策略

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的 [Private vulnerability reporting](../../security/advisories/new) 或直接联系维护者。

请说明：影响范围、复现步骤、你的环境（DSH 版本 / 操作系统 / 数据根目录结构）。

## 这个插件会碰什么数据

1. 只读写 DSH 存储域下的 `project` 目录（默认 `<DSH_HOME>/storages`）。
2. 不联网、不上传任何数据、不引入第三方运行时依赖。
3. 会写一个本地证据文件 `<DSH_HOME>/project-lite/evidence.jsonl`（每次请求一行，用于排障）。

## 设计上的安全边界

1. **降级即只读**：完整性判据不过时，所有写入口抛 `READONLY_DEGRADED`，不做"尽力而为"的写入。
2. **元数据不可信时零写入**：`global.json` 缺失/损坏/版本不兼容时，连降级快照都不写。
3. **不自动修复**：损坏的文件原样保留作证据，不自动重建、不自动覆盖。
