## 改了什么

<!-- 一句话说清。 -->

## 影响哪一半

- [ ] Host（`index.js`）
- [ ] Client（`client.js`）
- [ ] core（`core/*.mjs`）
- [ ] 只动文档

## 怎么验的

<!-- 跑了哪几条命令 / 看到什么结果。不要写"应该没问题"。 -->

- [ ] `npm run check` 通过
- [ ] `npm test` 通过
- [ ] 改了 core → `npm run test:core` 通过，且带了**负例**（断言"修复后应有的行为"）
- [ ] 改了 client → 任何请求失败时面板不会变成错误页（有对应回归）

## 边界

- [ ] 没有新增 UI slot（本插件只注册 `main` + `sidebar.panellist`）
- [ ] 没有绕过 `assertWritable()`
- [ ] 没有把本机路径、会话 id、密钥写进代码或文档

## 关联

<!-- Closes #123 -->
