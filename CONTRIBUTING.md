# 贡献指南

## 报问题

开 issue 时请给：**你做了什么 → 期望什么 → 实际什么**，以及面板截图（红条内容很关键）。

如果是数据损坏类问题，请附上脱敏后的目录结构（`tree` 输出即可，**不要**贴记录文件里的业务内容）。

## 提 PR

1. 一个 PR 只做一件事。
2. 改 Core（`core/*.mjs`）必须带一条**负例回归**：断言"修复后应有的行为"，而不是把现状写成断言。
3. 改 `client.js` 必须保证：任何一处请求失败都**不能**让整个面板变成错误页（局部错误只能落在局部）。
4. 提交前跑：

   ```bash
   node --check index.js && node --check client.js
   node test/s14-create-route.mjs /tmp/base /tmp/out14.json
   node test/s15-create-form.mjs /tmp/out15.json
   ```

## 不要做的事

- 不要新增 UI slot。本插件只注册 `main` + `sidebar.panellist` 两个（后者是框架必需：keyed `main` 没有侧栏入口就永远打不开）。
- 不要绕过 `assertWritable()` 写数据。降级时"帮用户先存下来"是本插件最不能接受的错误。
- 不要在降级态写 `global.json` 的任何字段——那会把"元数据曾经缺失"的证据补掉。
