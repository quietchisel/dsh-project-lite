/**
 * dsh-project-lite —— Client 半：只注册 main 一个 slot 的面板。
 * 0a：降级红条（持续显示 + 写明原因 + 列出被禁的写操作）
 * 0b：检查状态（pass/fail/skipped 分列 + skipped 的检查名与原因）
 * 1.2：项目列表（GET /api/project/overview，四组 + 计数 + 摘要行；空态 / 降级只读 / 错误不白屏）
 * 1.3：新建项目表单（POST /api/project/create）。降级时表单禁用并写明原因，提交失败显示后端错误形状。
 *
 * 刻意不做：删除/归档按钮、任何第三个 slot、恢复功能。
 * 关于 slot：keyed 的 main 没有 sidebar.panellist 入口就永远打不开（2026-11-14 桌面实测 0 次请求），
 * 所以这两个 slot 是"框架必需"，不是范围扩大；社区里同类面板插件也是这两个。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API_STATE = 'api/project/state'
    const API_FULL = 'api/project/state?reconcile=1'
    const API_OVERVIEW = 'api/project/overview'
    // 1.3 唯一写入口。方法必须是 POST；GET 会被后端 405。
    const API_CREATE = 'api/project/create'
    // 1.4：会话候选（只读）+ 关联（第二个写入口）。
    const API_GET = 'api/project/get'
    const API_SESSIONS = 'api/project/sessions'
    const API_LINK = 'api/project/link'
    const API_ARCHIVE = 'api/project/archive'
    const API_RESTORE = 'api/project/restore'

    /**
     * 1.8：一次"用户意图"一个 requestId。
     * 新建表单在**失败重试**时复用同一个 id（所以连点只算一次），成功后清空；
     * 关联每次点击都是新意图（幂等已由确定性键保证），每次新生成。
     */
    const newRequestId = () => 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)

    const C = {
      // 2026-11-16 使用者反馈：全屏时右边一片空白（原来写死 maxWidth 960px，只在小窗合适）。
      // 改成随窗口流式：宽度撑满、按内容自适应，不再固定上限。
      // 窗口缩小时整块面板必须能滚（之前只给详情块和选择器加了滚动，外层没有）。
      // maxHeight 用 100vh：不依赖宿主容器是否给了确定高度，内容超高就出滚动条。
      wrap: {
        padding: '16px 20px', width: '100%', maxWidth: 'none', boxSizing: 'border-box',
        fontFamily: 'inherit', maxHeight: '100vh', overflowY: 'auto',
      },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px' },
      red: { border: '1px solid #d93025', background: '#fdecea', color: '#7a1710', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' },
      redTitle: { fontWeight: 600, fontSize: '13px', marginBottom: '4px' },
      redBody: { fontSize: '12px', lineHeight: '18px' },
      ok: { border: '1px solid #1e8e3e', background: '#e6f4ea', color: '#0d652d', borderRadius: '8px', padding: '8px 12px', marginBottom: '12px', fontSize: '12px' },
      section: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '10px 12px' },
      row: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', marginBottom: '8px' },
      num: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
      item: { fontSize: '12px', lineHeight: '19px', padding: '2px 0' },
      tag: { display: 'inline-block', fontSize: '10px', lineHeight: '15px', padding: '0 5px', borderRadius: '999px', border: '1px solid currentColor', marginRight: '6px' },
      muted: { fontSize: '11px', opacity: 0.7, marginTop: '8px', wordBreak: 'break-all' },
      btn: { marginTop: '10px', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      list: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '10px 12px', marginTop: '12px' },
      listTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' },
      groupHead: { fontSize: '11px', opacity: 0.75, marginTop: '8px', marginBottom: '4px' },
      proj: { borderTop: '1px solid rgba(128,128,128,0.18)', padding: '6px 0', fontSize: '12px', lineHeight: '18px' },
      projName: { fontWeight: 600 },
      projMeta: { fontSize: '11px', opacity: 0.72 },
      notice: { fontSize: '11px', padding: '4px 8px', borderRadius: '6px', marginBottom: '8px' },
      warn: { background: 'rgba(217,48,37,0.08)', color: '#7a1710' },
      empty: { fontSize: '12px', opacity: 0.7, padding: '8px 0' },
      form: { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '10px 12px', marginTop: '12px' },
      formTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' },
      field: { display: 'block', marginBottom: '8px' },
      label: { display: 'block', fontSize: '11px', opacity: 0.75, marginBottom: '3px' },
      input: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 7px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', fontFamily: 'inherit' },
      inputOff: { opacity: 0.5 },
      submit: { fontSize: '12px', padding: '4px 12px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      submitOff: { opacity: 0.45, cursor: 'not-allowed' },
      err: { fontSize: '11px', padding: '4px 8px', borderRadius: '6px', marginBottom: '8px', background: 'rgba(217,48,37,0.08)', color: '#7a1710', wordBreak: 'break-all' },
      done: { fontSize: '11px', padding: '4px 8px', borderRadius: '6px', marginBottom: '8px', background: 'rgba(30,142,62,0.10)', color: '#0d652d', wordBreak: 'break-all' },
      hint: { fontSize: '11px', opacity: 0.7, marginTop: '6px' },
      pickBtn: { marginTop: '4px', fontSize: '11px', padding: '2px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      // 用 CSS 系统色（Canvas / CanvasText），跟随主题，不写死明暗。
      // 详情六分区：窄窗 1 列、宽窗自动多列（auto-fit），并给自身滚动条——
      // 之前全屏展开后下半截看不到，也没有滚动条（2026-11-16 反馈）。
      detail: {
        border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '10px 12px', marginTop: '12px',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        columnGap: '20px', rowGap: '2px',
        maxHeight: '62vh', overflowY: 'auto', boxSizing: 'border-box',
      },
      detailFull: { gridColumn: '1 / -1' },
      // 关联会话选择器：候选最多 50 条，必须自身滚动，否则下面全被裁掉（2026-11-16 全屏反馈）。
      picker: {
        border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '10px 12px', marginTop: '12px',
        maxHeight: '62vh', overflowY: 'auto', boxSizing: 'border-box',
      },
      // 列表行「未确认」徽标（点开看依据），与详情第 6 区同源数据。
      basisBadge: { display: 'inline-block', fontSize: '10px', lineHeight: '15px', padding: '0 5px', borderRadius: '999px', border: '1px solid #b06000', color: '#b06000', marginLeft: '6px', cursor: 'pointer' },
      overlayMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.38)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 },
      overlayBox: { background: 'Canvas', color: 'CanvasText', border: '1px solid rgba(128,128,128,0.4)', borderRadius: '10px', padding: '14px 16px', minWidth: '340px', maxWidth: '520px', maxHeight: '70vh', overflow: 'auto', boxShadow: '0 8px 28px rgba(0,0,0,0.28)' },
    }

    /**
     * 把后端 severity 显示出来。后端原始字段一个都不改，只在标签上拼后缀。
     *   external + unverified → 「外部 · 未验证」
     *   core + degraded      → 「核心 · 降级」
     */
    const skipTag = (c) => {
      const scope = c.scope === 'external' ? '外部' : '核心'
      const sev = c.severity === 'degraded' ? '降级' : (c.severity === 'unverified' ? '未验证' : '')
      return sev ? scope + ' · ' + sev : scope
    }

    /**
     * 1.4b：会话侧入口 ↔ 浮层 的共享请求。
     * 不引第三方 store：一个变量 + 订阅集合就够，也少一个依赖。
     */
    function createLinkRequest() {
      let value = null
      const subs = new Set()
      return {
        get: () => value,
        set: (v) => { value = v; for (const fn of subs) { try { fn(v) } catch (e) { /* 单个订阅者出错不影响别人 */ } } },
        subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
      }
    }
    const linkRequest = createLinkRequest()

    function Panel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      // 1.2：overview 用独立 state + 独立轮询，不与 0a/0b 的 data 共用，避免只读轮询把列表冲掉。
      const [ovData, setOvData] = useState(null)
      const [ovError, setOvError] = useState(null)

      // full=true 才跑对账（会对磁盘写 last_reconcile_*），轮询只读状态。
      const load = useCallback(async (full) => {
        setBusy(true)
        try {
          const res = await fetch(full ? API_FULL : API_STATE, { cache: "no-store" })
          const json = await res.json()
          // 竞态修复（2026-11-15）：挂载时 load(true) 带 reconcile 的完整响应，会被
          // 每 5 秒 load(false) 的只读响应覆盖掉，界面因此永远停在「对账结果读取中…」。
          // 轮询响应不含 reconcile 时沿用上一次的值；完整响应自带则以其为准。
          if (json && json.ok) {
            setData((prev) => ({ ...json, reconcile: json.reconcile ?? (prev && prev.reconcile) ?? null }))
            setError(null)
          }
          else setError((json && json.error) || ("HTTP " + res.status))
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [])

      /** 1.2：项目列表单独一条数据链。错误只落在 ovError，绝不触碰主面板的 error（否则整块被替换＝白屏）。 */
      const loadOverview = useCallback(async () => {
        try {
          const res = await fetch(API_OVERVIEW, { cache: "no-store" })
          const json = await res.json()
          if (json && json.ok) { setOvData(json); setOvError(null) }
          else {
            setOvError((json && json.error && (json.error.message || json.error.code)) || ("HTTP " + res.status))
            // 保留上一次成功的 ovData；不清空，也不触碰主面板的 error。
          }
        } catch (e) {
          setOvError(String(e && e.message ? e.message : e))
        }
      }, [])

      // 1.3：新建表单四个字段 + 三个提交态，与上面的只读链互不干扰。
      const [form, setForm] = useState({ name: '', objective: '', next_action: '', done_when: '' })
      const [submitting, setSubmitting] = useState(false)
      const [formError, setFormError] = useState(null)
      const [formDone, setFormDone] = useState(null)
      // 提交失败重试要复用同一个 requestId，否则"重试"在账本里会变成两次新意图。
      const [createReqId, setCreateReqId] = useState(null)

      // 1.4 关联会话：同时只服务一个项目；候选来自后端 /api/project/sessions。
      const [linkFor, setLinkFor] = useState(null)
      const [linkQ, setLinkQ] = useState('')
      const [linkData, setLinkData] = useState(null)
      const [linkBusy, setLinkBusy] = useState(false)
      const [linkErr, setLinkErr] = useState(null)
      const [linkDone, setLinkDone] = useState(null)

      // 详情页（六分区）：只服务一个项目，同时只开一个。
      const [detail, setDetail] = useState(null)
      // 列表行「未确认」徽标点开的依据浮层（只服务一条项目）。
      const [basisFor, setBasisFor] = useState(null)
      // 归档二次确认：存 {id, name, rev}，用户点确认才真发请求。
      const [archiveAsk, setArchiveAsk] = useState(null)
      const [archiveErr, setArchiveErr] = useState(null)
      // 恢复确认：与归档共用一套确认 UI，用 mode 区分。
      const [restoreAsk, setRestoreAsk] = useState(null)

      /**
       * 提交新建。三条铁律：
       *   1. 只在 writable 时发请求（按钮已 disabled，这里再挡一次，防止键盘回车绕过）；
       *   2. 成功后立刻 loadOverview()，不等下一个 5 秒轮询；
       *   3. 失败只写 formError，绝不触碰主面板 error（否则整块被替换＝白屏）。
       */
      const submitCreate = useCallback(async () => {
        if (submitting) return
        if (!(ovData && ovData.writable !== false && ovData.degraded !== true)) return
        setSubmitting(true); setFormError(null); setFormDone(null)
        const rid = createReqId || newRequestId()
        if (!createReqId) setCreateReqId(rid)
        try {
          const res = await fetch(API_CREATE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: rid,
              name: form.name,
              objective: form.objective,
              next_action: form.next_action,
              // schema 要 string[]（一个输入框 → 单元素数组）；服务端也会归一化，这里是第一道。
              done_when: form.done_when.trim() ? [form.done_when.trim()] : undefined,
            }),
          })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok && json.project) {
            setFormDone('已建项目：' + (json.project.name || json.project.id) + (json.replayed ? '（重放：这条请求之前已执行过，未重复建）' : ''))
            setForm({ name: '', objective: '', next_action: '', done_when: '' })
            setCreateReqId(null)
            await loadOverview()
          } else {
            const er = json && json.error
            setFormError((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setFormError(String(e && e.message ? e.message : e))
        } finally {
          setSubmitting(false)
        }
      }, [form, submitting, ovData, loadOverview, createReqId])

      /**
       * 1.4：读会话候选。失败只写 linkErr，绝不触碰主面板 error（否则整块白屏）。
       * 后端读不到注册表时返回 REGISTRY_UNAVAILABLE —— 照原话显示，不假装"没有会话"。
       */
      const loadSessions = useCallback(async (q) => {
        setLinkBusy(true); setLinkErr(null)
        try {
          const res = await fetch(API_SESSIONS + '?limit=50&q=' + encodeURIComponent(q || ''), { cache: 'no-store' })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) { setLinkData(json) }
          else {
            setLinkData(null)
            const er = json && json.error
            setLinkErr((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setLinkData(null)
          setLinkErr(String(e && e.message ? e.message : e))
        } finally {
          setLinkBusy(false)
        }
      }, [])

      /** 打开项目详情（六分区）。失败只写 detail.err，不动主面板。 */
      const openDetail = useCallback(async (p) => {
        setDetail({ id: p.id, data: null, err: null })
        try {
          const res = await fetch(API_GET + '?id=' + encodeURIComponent(p.id), { cache: 'no-store' })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) setDetail({ id: p.id, data: json, err: null })
          else {
            const er = json && json.error
            setDetail({ id: p.id, data: null, err: (er && (er.message || er.code)) || ('HTTP ' + res.status) })
          }
        } catch (e) {
          setDetail({ id: p.id, data: null, err: String(e && e.message ? e.message : e) })
        }
      }, [])

      /** 归档：先本地确认，再 POST；成功后立刻刷新详情与列表。 */
      const submitArchive = useCallback(async (ask) => {
        if (!ask) return
        setArchiveErr(null)
        try {
          const res = await fetch(API_ARCHIVE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: ask.id, expected_rev: ask.rev, requestId: newRequestId() }),
          })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) {
            setArchiveAsk(null)
            await loadOverview()
            // 重新拉详情，让归档后的 status 立刻可见。
            await openDetail({ id: ask.id })
          } else {
            const er = json && json.error
            setArchiveErr((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setArchiveErr(String(e && e.message ? e.message : e))
        }
      }, [loadOverview, openDetail])

      /** 恢复：与归档对称的二次确认流程。 */
      const submitRestore = useCallback(async (ask) => {
        if (!ask) return
        setArchiveErr(null)
        try {
          const res = await fetch(API_RESTORE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: ask.id, expected_rev: ask.rev, requestId: newRequestId() }),
          })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) {
            setRestoreAsk(null)
            await loadOverview()
            await openDetail({ id: ask.id })
          } else {
            const er = json && json.error
            setArchiveErr((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setArchiveErr(String(e && e.message ? e.message : e))
        }
      }, [loadOverview, openDetail])

      /** 打开某个项目的关联选择器（同时只开一个）。 */
      const openLink = useCallback((p) => {
        setLinkFor({ id: p.id, name: p.name || p.id })
        setLinkQ(''); setLinkData(null); setLinkErr(null); setLinkDone(null)
        loadSessions('')
      }, [loadSessions])

      /**
       * 1.4：关联。重复点同一条 → 后端 changed=false（真幂等：rev 不涨、changelog 不增、基线不动）。
       * 界面必须把这个区别显示出来，否则使用者会以为"点了两次 = 建了两条"。
       */
      const submitLink = useCallback(async (sessionId) => {
        if (!linkFor || linkBusy) return
        setLinkBusy(true); setLinkErr(null); setLinkDone(null)
        try {
          const res = await fetch(API_LINK, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: newRequestId(), project_id: linkFor.id, session_id: sessionId, basis: '界面手动关联' }),
          })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) {
            setLinkDone(json.changed
              ? ('已关联：' + sessionId)
              : ('已经关联过了，零副作用（rev / changelog / 基线都没动）：' + sessionId))
            await loadOverview()
          } else {
            const er = json && json.error
            setLinkErr((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setLinkErr(String(e && e.message ? e.message : e))
        } finally {
          setLinkBusy(false)
        }
      }, [linkFor, linkBusy, loadOverview])

      useEffect(() => {
        let alive = true
        // 首次进来跑一次完整对账（要有"通过/未检查"的数字），之后每 5 秒只读状态。
        load(true)
        loadOverview()
        const timer = setInterval(() => { if (alive) load(false) }, 5000)
        const ovTimer = setInterval(() => { if (alive) loadOverview() }, 5000)
        return () => { alive = false; clearInterval(timer); clearInterval(ovTimer) }
      }, [load, loadOverview])

      if (error) return h('div', { style: C.wrap, 'data-project-lite': 'panel' },
        h('div', { style: C.red },
          h('div', { style: C.redTitle }, '项目面板：读不到数据域状态'),
          h('div', { style: C.redBody }, error),
        ),
        h('button', { style: C.btn, onClick: () => load(true), disabled: busy }, busy ? '读取中…' : '重试'),
      )

      if (!data) return h('div', { style: C.wrap, 'data-project-lite': 'panel' }, h('div', { style: C.muted }, '读取中…'))

      const d = data.degradation || {}
      const r = data.reconcile || null
      const skipped = r ? (r.checks || []).filter((c) => c.status === "skipped") : []
      const failed = r ? (r.checks || []).filter((c) => c.status === "fail") : []

      const banner = d.degraded
        ? h('div', { style: C.red, role: 'alert', 'data-degraded': d.kind },
            h('div', { style: C.redTitle }, d.title),
            h('div', { style: C.redBody }, d.reason),
            h('div', { style: Object.assign({}, C.redBody, { marginTop: '6px' }) }, '已禁止：' + (d.blocks || []).join('、')),
          )
        : h('div', { style: C.ok }, '项目数据完整，可写。')

      const status = r
        ? h('div', { style: C.section },
            h('div', { style: C.row },
              h('span', null, '通过 ', h('span', { style: C.num }, String(r.pass))),
              h('span', null, '失败 ', h('span', { style: C.num, color: r.fail ? '#d93025' : 'inherit' }, String(r.fail))),
              h('span', null, '未检查 ', h('span', { style: C.num, color: r.skipped ? '#b06000' : 'inherit' }, String(r.skipped))),
              h('span', null, '共 ', h('span', { style: C.num }, String(r.total))),
              h('span', null, r.persisted ? '报告已落盘' : '报告未落盘'),
            ),
            skipped.length
              ? h('div', null,
                  h('div', { style: C.muted }, '未检查项（不是通过，也不是损坏）'),
                  skipped.map((c) => h('div', { key: "sk" + c.id, style: C.item },
                    h('span', { style: C.tag }, skipTag(c)),
                    '第 ' + c.id + ' 条 · ' + c.name + ' —— ' + c.detail,
                  )),
                )
              : null,
            failed.length
              ? h('div', null,
                  h('div', { style: C.muted }, '失败项'),
                  failed.map((c) => h('div', { key: "fa" + c.id, style: C.item },
                    h('span', { style: C.tag }, '失败'),
                    '第 ' + c.id + ' 条 · ' + c.name + ' —— ' + c.detail,
                  )),
                )
              : null,
            h('div', { style: C.muted }, '数据根目录：' + (data.root || '(未知)')),
          )
        : h('div', { style: C.muted }, '对账结果读取中…')

      /** 1.2 项目列表：四种状态都有明确渲染，任何一处失败都不会让整个面板消失。 */
      const ovNotice = ovError
        ? h('div', { style: Object.assign({}, C.notice, C.warn) }, '项目列表读取失败：' + ovError + '；下方显示的是上一次成功的数据。')
        : null

      const projectList = (() => {
        if (!ovData) {
          return h('div', { style: C.list, 'data-overview-state': 'loading' },
            h('div', { style: C.listTitle }, '项目列表'),
            ovNotice,
            h('div', { style: C.empty }, ovError ? '暂无可用数据' : '项目列表读取中…'),
          )
        }
        const groups = Array.isArray(ovData.groups) ? ovData.groups : []
        const total = Number(ovData.total) || 0
        const dg = ovData.degradation || {}
        const readOnly = ovData.degraded === true || ovData.writable === false
        const rows = []
        for (const g of groups) {
          const items = Array.isArray(g.items) ? g.items : []
          rows.push(h('div', { key: 'g' + g.key, style: C.groupHead }, (g.key || '?') + ' · ' + items.length))
          for (const p of items) {
            rows.push(h('div', { key: 'p' + p.id, style: C.proj, 'data-project-id': p.id },
              h('div', { style: C.projName },
                h('button', {
                  type: 'button',
                  style: { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'inherit', cursor: 'pointer', textAlign: 'left' },
                  'data-action': 'open-detail',
                  'data-for': p.id,
                  onClick: () => openDetail(p),
                }, p.name || '(未命名)'),
                p.confidence === 'inferred'
                  ? h('span', {
                      style: C.basisBadge,
                      'data-action': 'show-basis',
                      'data-for': p.id,
                      onClick: () => setBasisFor(p),
                    }, '未确认')
                  : null,
              ),
              h('div', { style: C.projMeta }, '目标：' + (p.objective || '—')),
              h('div', { style: C.projMeta }, '下一步：' + (p.next_action || '—')),
              p.status !== 'archived'
                ? h('button', {
                    type: 'button',
                    style: readOnly ? Object.assign({}, C.pickBtn, C.submitOff) : C.pickBtn,
                    disabled: readOnly,
                    'data-action': 'open-link',
                    'data-for': p.id,
                    onClick: () => openLink(p),
                  }, '关联会话')
                : null,
            ))
          }
        }
        return h('div', { style: C.list, 'data-overview-state': readOnly ? 'readonly' : (total === 0 ? 'empty' : 'ready') },
          h('div', { style: C.listTitle }, '项目列表（共 ' + total + ' 条）'),
          ovNotice,
          readOnly
            ? h('div', { style: Object.assign({}, C.notice, C.warn) },
                '只读：' + (dg.title || dg.reason || '当前数据域不可写') + (dg.reason && dg.title ? ' —— ' + dg.reason : ''))
            : null,
          total === 0
            ? h('div', { style: C.empty }, '暂无项目记录（空库）。用下面的表单建第一个项目。')
            : h('div', null, rows),
        )
      })()

      /**
       * 1.3 新建项目表单。
       * 降级时整个表单禁用并写明原因（不是只把按钮藏起来——藏起来等于不说为什么）。
       * 提交失败显示后端 {code,message}，与读链的错误互不影响。
       */
      const canCreate = !!ovData && ovData.writable !== false && ovData.degraded !== true
      const formState = !ovData ? 'loading' : (canCreate ? (submitting ? 'submitting' : 'ready') : 'readonly')
      const dgv = (ovData && ovData.degradation) || {}

      const mkField = (key, label, placeholder) => h('label', { style: C.field },
        h('span', { style: C.label }, label),
        h('input', {
          type: 'text',
          style: canCreate ? C.input : Object.assign({}, C.input, C.inputOff),
          value: form[key],
          placeholder,
          disabled: !canCreate || submitting,
          'data-field': key,
          onChange: (e) => {
            const v = e && e.target ? e.target.value : ''
            setForm((prev) => Object.assign({}, prev, { [key]: v }))
          },
        }),
      )

      const createForm = h('div', { style: C.form, 'data-create-form': '1', 'data-create-state': formState },
        h('div', { style: C.formTitle }, '新建项目'),
        formError ? h('div', { style: C.err, role: 'alert', 'data-create-error': '1' }, '新建失败：' + formError) : null,
        formDone ? h('div', { style: C.done, 'data-create-done': '1' }, formDone) : null,
        formState === 'readonly'
          ? h('div', { style: Object.assign({}, C.notice, C.warn), 'data-create-blocked': '1' },
              '只读：' + (dgv.title || dgv.reason || '当前数据域不可写') + '，新建已禁用。')
          : null,
        mkField('name', '名称（必填，最长 40 字）', '例如：DSH 工作区管理改造'),
        mkField('objective', '目标（必填）', '这件事要达成什么'),
        mkField('next_action', '下一步（必填，4-60 字，不能是「继续推进」「待定」这类词）', '例如：跑一次桌面截图验证'),
        mkField('done_when', '完成判据（可选）', '什么样算做完'),
        h('button', {
          type: 'button',
          style: (canCreate && !submitting) ? C.submit : Object.assign({}, C.submit, C.submitOff),
          disabled: !canCreate || submitting,
          'data-action': 'create-project',
          onClick: submitCreate,
        }, submitting ? '提交中…' : '新建项目'),
        h('div', { style: C.hint }, '写入口只有一个：POST ' + API_CREATE + '。降级时后端返回 409 并拒绝写入。'),
      )

      /**
       * 1.4 关联会话选择器。四态与新建表单一致：未开 / 读取中 / 有候选 / 出错。
       * 候选行的标题来自会话缓存，缓存里没有就显示 session id —— 不编造标题。
       */
      const linkPicker = linkFor ? h('div', { style: C.picker, 'data-link-form': '1', 'data-link-project': linkFor.id },
        // 「收起」必须固定在标题行：放到滚动区底部时，候选一多就滚出视野，收不起来（2026-11-16 反馈）。
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' } },
          h('div', { style: C.formTitle }, '关联会话到「' + (linkFor.name || linkFor.id) + '」'),
          h('button', {
            type: 'button',
            style: C.pickBtn,
            'data-action': 'close-link',
            onClick: () => { setLinkFor(null); setLinkData(null); setLinkErr(null); setLinkDone(null) },
          }, '收起'),
        ),
        linkErr ? h('div', { style: C.err, role: 'alert', 'data-link-error': '1' }, '关联失败：' + linkErr) : null,
        linkDone ? h('div', { style: C.done, 'data-link-done': '1' }, linkDone) : null,
        h('label', { style: C.field },
          h('span', { style: C.label }, '搜索会话（匹配 session id / 工作区标题 / 工作区路径）'),
          h('input', {
            type: 'text',
            style: C.input,
            value: linkQ,
            placeholder: '留空列出前 50 条',
            'data-field': 'link-q',
            onChange: (e) => {
              const v = e && e.target ? e.target.value : ''
              setLinkQ(v)
              loadSessions(v)
            },
          }),
        ),
        linkData
          ? h('div', null,
              h('div', { style: C.muted }, '匹配 ' + linkData.matched + ' 条 / 注册表共 ' + linkData.total + ' 条，显示前 ' + linkData.sessions.length + ' 条'),
              linkData.sessions.length === 0
                ? h('div', { style: C.empty }, '没有匹配的会话')
                : linkData.sessions.map((s) => h('div', { key: 's' + s.session_id, style: C.proj, 'data-session-id': s.session_id },
                    h('div', { style: C.projName }, s.title || (s.session_id.slice(0, 16) + '…')),
                    h('div', { style: C.projMeta }, (s.workspace_title || '(未知工作区)') + ' · ' + s.session_id),
                    h('button', {
                      type: 'button',
                      style: C.pickBtn,
                      disabled: linkBusy,
                      'data-action': 'link-session',
                      'data-session': s.session_id,
                      onClick: () => submitLink(s.session_id),
                    }, '关联'),
                  )),
            )
          : h('div', { style: C.empty }, linkBusy ? '读取会话列表…' : '（还没有候选）'),
        h('div', { style: C.hint }, '关联是幂等的：同一条重复点，rev / changelog / 基线都不会动。会话必须先在 DSH 注册表里存在。'),
      ) : null

      /** 列表行「未确认」徽标点开的依据浮层：basis + legacy_refs，与详情第 6 区同源。 */
      const basisOverlay = basisFor ? h('div', { style: C.overlayMask, 'data-basis-overlay': '1' },
        h('div', { style: C.overlayBox },
          h('div', { style: C.formTitle }, '依据：' + (basisFor.name || basisFor.id)),
          h('div', { style: C.projMeta }, 'confidence：' + (basisFor.confidence || '—')),
          h('div', { style: C.item }, '依据：' + (basisFor.basis || '—')),
          Array.isArray(basisFor.legacy_refs) && basisFor.legacy_refs.length
            ? h('div', null,
                h('div', { style: C.groupHead }, '历史来源（' + basisFor.legacy_refs.length + ' 条）'),
                basisFor.legacy_refs.map((r, i) => h('div', { key: 'br' + i, style: C.item },
                  (r.kind || '?') + ' · ' + (r.original_id || '') + ' · ' + (r.source_doc || '') + ' · ' + (r.note || ''))))
            : h('div', { style: C.empty }, '没有登记历史来源（legacy_refs 为空）。'),
          h('button', { type: 'button', style: C.btn, onClick: () => setBasisFor(null) }, '关闭'),
        )
      ) : null

      /**
       * 详情页六分区（路线图硬约束：每区空态都必须有一句话，不许空白）。
       * 徽标只认 confidence==='inferred'；未确认清单由后端算好（unconfirmed），前端不重算。
       */
      const detailView = detail ? (() => {
        const wrapStyle = C.form
        if (detail.err) {
          return h('div', { style: wrapStyle, 'data-detail': '1', 'data-detail-state': 'error' },
            h('div', { style: C.err, role: 'alert' }, '详情读取失败：' + detail.err))
        }
        const dd = detail.data
        if (!dd) {
          return h('div', { style: wrapStyle, 'data-detail': '1', 'data-detail-state': 'loading' },
            h('div', { style: C.empty }, '读取详情中…'))
        }
        if (dd.found === false) {
          return h('div', { style: wrapStyle, 'data-detail': '1', 'data-detail-state': 'missing' },
            h('div', { style: C.empty }, '这个项目已经不在了（可能被归档或删除）。'),
            h('button', { type: 'button', style: C.btn, onClick: () => setDetail(null) }, '收起'))
        }
        const p = dd.project || {}
        const badge = (conf) => (conf === 'inferred'
          ? h('span', { style: Object.assign({}, C.tag, { color: '#b06000' }), 'data-badge': 'inferred' }, '未确认')
          : null)
        const line = (k, v) => h('div', { style: C.projMeta }, k + '：' + (v || '—'))
        const sessions = (dd.sessions || []).map((l) => h('div', { key: 'ds' + l.id, style: C.item },
          badge(l.confidence), l.role + ' · ' + l.session_id + ' · ' + (l.basis || '—')))
        const workspaces = (dd.workspaces || []).map((w) => h('div', { key: 'dw' + w.id, style: C.item },
          badge(w.confidence), (w.workspace_title || w.workspace_id) + ' · ' + (w.basis || '—')))
        const deliverables = (dd.deliverables || []).map((x) => h('div', { key: 'dd' + x.id, style: C.item },
          badge(x.confidence), (x.title || x.id) + ' · ' + (x.kind || '?') + ' · ' + (x.state || '?')))
        const logs = (dd.logs || []).slice(0, 10).map((l) => h('div', { key: 'dl' + l.id, style: C.item },
          String(l.at || '').slice(0, 19).replace('T', ' ') + ' · ' + l.op
          + ' · ' + (l.source === 'run' ? '程序' : '人工')
          + ' · ' + (l.summary || '')))
        const unconf = (dd.unconfirmed || []).map((u) => h('div', { key: 'du' + u.kind + u.id, style: C.item },
          badge('inferred'), u.kind + ' · ' + (u.title || u.session_id || u.workspace_id || u.id) + ' · ' + (u.basis || '—')))
        const sec = (key, title, count, body, emptyText) => h('div', { 'data-section': key },
          h('div', { style: C.groupHead }, title + ' · ' + count),
          count === 0 ? h('div', { style: C.empty }, emptyText) : body)
        return h('div', { style: C.detail, 'data-detail': '1', 'data-detail-state': 'ready', 'data-detail-id': p.id },
          h('div', { style: Object.assign({}, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }, C.detailFull) },
            h('div', { style: C.formTitle }, '详情：' + (p.name || p.id) + ' · rev ' + p.rev),
            p.status !== 'archived'
              ? h('button', {
                  type: 'button', style: C.pickBtn,
                  'data-action': 'ask-archive', 'data-for': p.id,
                  onClick: () => { setArchiveErr(null); setArchiveAsk({ id: p.id, name: p.name || p.id, rev: p.rev }) },
                }, '归档')
              : h('button', {
                  type: 'button', style: C.pickBtn,
                  'data-action': 'ask-restore', 'data-for': p.id,
                  onClick: () => { setArchiveErr(null); setRestoreAsk({ id: p.id, name: p.name || p.id, rev: p.rev }) },
                }, '恢复'),
          ),
          archiveAsk && archiveAsk.id === p.id
            ? h('div', { style: Object.assign({}, C.notice, C.warn), 'data-archive-confirm': '1' },
                '确认归档「' + archiveAsk.name + '」？归档不删数据，可在 archived 组查看。',
                archiveErr ? h('div', { style: C.err }, '归档失败：' + archiveErr) : null,
                h('button', { type: 'button', style: C.pickBtn, 'data-action': 'confirm-archive', onClick: () => submitArchive(archiveAsk) }, '确认归档'),
                h('button', { type: 'button', style: C.pickBtn, onClick: () => setArchiveAsk(null) }, '取消'))
            : restoreAsk && restoreAsk.id === p.id
            ? h('div', { style: Object.assign({}, C.notice, C.warn), 'data-restore-confirm': '1' },
                '确认恢复「' + restoreAsk.name + '」？会移回 active 组。',
                archiveErr ? h('div', { style: C.err }, '恢复失败：' + archiveErr) : null,
                h('button', { type: 'button', style: C.pickBtn, 'data-action': 'confirm-restore', onClick: () => submitRestore(restoreAsk) }, '确认恢复'),
                h('button', { type: 'button', style: C.pickBtn, onClick: () => setRestoreAsk(null) }, '取消'))
            : null,
          sec('project', '1 · 项目', 1, h('div', null,
            line('目标', p.objective),
            line('下一步', p.next_action),
            line('完成判据', Array.isArray(p.done_when) && p.done_when.length ? p.done_when.join('；') : ''),
            line('标签', Array.isArray(p.tags) && p.tags.length ? p.tags.join(' / ') : ''),
            line('状态', (p.status || '') + ' · ' + (p.kind || '') + ' · ' + (p.confidence || '')),
          ), '—'),
          sec('sessions', '2 · 关联会话', sessions.length, sessions, '还没有关联会话。用项目行上的「关联会话」挂一个。'),
          sec('workspaces', '3 · 工作区', workspaces.length, workspaces, '还没有登记工作区。这一版只读，不做自动发现。'),
          sec('deliverables', '4 · 交付物', deliverables.length, deliverables, '还没有交付物。这一版只读，注册入口在后续版本。'),
          sec('logs', '5 · 变更记录（最多显示 10 条）', logs.length, logs, '还没有变更记录。'),
          sec('basis', '6 · 依据（未确认）', unconf.length, unconf, '所有依据都已确认，没有待确认项。'),
          h('div', { style: C.detailFull },
            h('button', { type: 'button', style: C.btn, onClick: () => setDetail(null) }, '收起详情')),
        )
      })() : null

      return h('div', { style: C.wrap, 'data-project-lite': 'panel', 'data-meta-state': data.metaState },
        h('h2', { style: C.h2 }, '项目'),
        banner,
        status,
        projectList,
        basisOverlay,
        detailView,
        linkPicker,
        createForm,
        h('button', { style: C.btn, onClick: () => load(true), disabled: busy }, busy ? '刷新中…' : '刷新'),
      )
    }

    /**
     * 1.4b：会话右键「加入项目…」打开的浮层。
     * 只做一件事：把这个 session 挂到选中的项目上。项目列表复用 overview，不另开接口。
     */
    function LinkOverlay() {
      const [req, setReq] = useState(linkRequest.get())
      const [rows, setRows] = useState(null)
      const [err, setErr] = useState(null)
      const [done, setDone] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => linkRequest.subscribe(setReq), [])

      useEffect(() => {
        if (!req) return undefined
        let alive = true
        fetch(API_OVERVIEW, { cache: 'no-store' })
          .then((res) => res.json())
          .then((json) => {
            if (!alive) return
            if (json && json.ok) {
              const items = []
              for (const g of (json.groups || [])) for (const p of (g.items || [])) items.push(p)
              setRows(items); setErr(null)
            } else {
              setRows(null); setErr('读不到项目列表')
            }
          })
          .catch((e) => { if (alive) { setRows(null); setErr(String(e && e.message ? e.message : e)) } })
        return () => { alive = false }
      }, [req])

      if (!req) return null
      const close = () => { linkRequest.set(null); setDone(null); setErr(null); setRows(null) }
      const link = async (p) => {
        setBusy(true); setErr(null); setDone(null)
        try {
          const res = await fetch(API_LINK, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: newRequestId(), project_id: p.id, session_id: req.sessionId, basis: '会话右键关联' }),
          })
          let json = null
          try { json = await res.json() } catch (e) { json = null }
          if (json && json.ok) {
            setDone((json.changed ? '已加入：' : '本来就在里面，零副作用：') + (p.name || p.id))
          } else {
            const er = json && json.error
            setErr((er && (er.message || er.code)) || ('HTTP ' + res.status))
          }
        } catch (e) {
          setErr(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: C.overlayMask, 'data-link-overlay': '1' },
        h('div', { style: C.overlayBox },
          h('div', { style: C.formTitle }, '把这个会话加入项目'),
          h('div', { style: C.projMeta }, req.displayTitle || req.sessionId),
          h('div', { style: C.muted }, req.sessionId),
          err ? h('div', { style: C.err, role: 'alert', 'data-overlay-error': '1' }, '失败：' + err) : null,
          done ? h('div', { style: C.done, 'data-overlay-done': '1' }, done) : null,
          rows === null
            ? h('div', { style: C.empty }, '读取项目列表…')
            : rows.length === 0
              ? h('div', { style: C.empty }, '还没有项目。先到侧栏「项目」里建一个。')
              : rows.map((p) => h('div', { key: 'op' + p.id, style: C.proj, 'data-overlay-project': p.id },
                  h('div', { style: C.projName }, p.name || p.id),
                  h('div', { style: C.projMeta }, p.next_action || '—'),
                  h('button', {
                    type: 'button',
                    style: C.pickBtn,
                    disabled: busy,
                    'data-action': 'overlay-link',
                    onClick: () => link(p),
                  }, '加入'),
                )),
          h('button', { type: 'button', style: C.btn, onClick: close }, '关闭'),
        ))
    }

    /** 侧栏行图标（12 行）。keyed main 没有入口就永远打不开——这是 2026-11-14 桌面实测的结论。 */
    function PanelIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 3.2, width: 12, height: 9.6, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M5 6.4h6M5 9.4h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 面板本体：keyed main，key 就是面板 id。
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'project-lite', order: 100 }, Panel))
        // 入口：侧栏一行（id 必须与 main 的 key 同值，否则面板打不开）。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'project-lite',
          order: 120,
          label: () => '项目',
        }, PanelIcon))

        /**
         * 1.4b：会话右键「加入项目…」。
         * 两段都包在 try 里——浮层 slot 或 contextMenus 不可用时，少一个入口而已，
         * 绝不能因此让「项目」面板本身打不开（面板是主功能，右键是加分项）。
         */
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'project-lite-link',
            order: 300,
          }, LinkOverlay))
        } catch (e) { /* 没有 shell.overlay 就只保留面板侧入口 */ }

        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['contextMenus'], (child) => {
              const menus = child.contextMenus
              if (!menus || typeof menus.register !== 'function') return
              child.effect(() => menus.register({
                id: 'project-lite.add-to-project',
                target: 'session',
                order: 260,
                resolve: (target) => {
                  const sessionId = target && target.sessionId
                  if (!sessionId) return []
                  return [{
                    id: 'project-lite.add-to-project',
                    label: '加入项目…',
                    run: () => {
                      linkRequest.set({
                        sessionId,
                        displayTitle: (target && target.displayTitle) || sessionId,
                      })
                    },
                  }]
                },
              }), 'project-lite: session menu')
            })
          }
        } catch (e) { /* contextMenus 不可用就少一个入口，面板不受影响 */ }
      },
    }
  },
})