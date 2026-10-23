/**
 * dsh-chime-alerts — Client 半体（静态 Web 版，经典脚本 + 模块工厂）
 *
 * 以 window.__ModuleLoader__.load 注册的懒加载 CJS 工厂（与 dsh-plugin-notify-sound
 * 相同的社区验证形态）。与动态版（lib/client.js，经 harness 桥拉取宿主事件）不同，
 * 静态版没有 host.call 桥，改为直接订阅 DSH 客户端运行时快照自行检测：
 *
 *   1. sessions.list 快照：
 *      - running true→false 且 origin ≠ 'subagent' → complete（回合结束；快照无
 *        reason 字段，无法区分 interrupted，静态版将其并入 complete）
 *      - running true→false 且 origin === 'subagent' → subcomplete（按 parentId
 *        链归属到非子代理祖先，深度上限 4）
 *      - projectionValues.goal.phase 进入 'blocked' → goalblocked
 *   2. 快照已丢失信号、必须由宿主转发的六类：
 *      - 需要授权 / Agent 提问 / 计划评审：pendingInteraction 不在 SessionSummary
 *        内（由 dsh-client-ui-session 单独维护，只经 slot 的
 *        useSessionPendingInteraction prop 暴露）
 *      - 插件授权：完全不产生会话快照
 *      - 后台任务完成 / 失败：jobsBySession 自 DSH 0.1.7 起不在 SessionListState
 *        内（作业列表迁到独立的 jobs 快照，见 dsh-client-ui-jobs），旧的快照自检
 *        分支恒为空、静默失效，v0.5.8 移除
 *      这六类由**宿主半检测后经 /dsh-chime-alerts/events?after=N 增量下发**，
 *      浏览器轮询播放（见 pollHostEvents）。宿主只对这六类入队，其余走快照自检，
 *      不会双响。
 *
 * 配置持久化：浏览器 localStorage（键 dsh-chime-alerts-v1，与动态版同键，直接继承
 * 既有设置；hostBeep/hostSounds/hostMuted 等宿主侧字段在静态版不适用，被忽略）。
 * 自定义音频以 data URL 存入 localStorage（键 dsh-chime-alerts-v1-audiolib），
 * 替代动态版的宿主磁盘音频库。
 *
 * v0.5.4：宿主设置 HTTP 请求（/dsh-chime-alerts/sysget|sysset）加 8s 超时兜底，
 * 端点异常挂起时设置页不会被拖住。
 * v0.5.5：宿主蜂鸣开启时每个事件展开「宿主音」行（选宿主音 / 单独静音 / 宿主试听），
 * 与动态版 UI 对齐；设置页底部标注版本号便于确认页面是否已加载新代码。
 * v0.5.6：修复设置页重渲染 bug——useVersion 的 setState 闭包捕获初值（恒 setState(1)），
 * 第一次重渲染后 React 吞掉后续全部 bump：切换开关后 UI 不再响应（"卡住/切不动"根因）。
 * 改为函数式更新 setState(x => x + 1)（与动态版一致）。
 * v0.5.8：四类事件的检测路径改由宿主 /events 端点转发，修掉依赖
 *   SessionSummary.pendingInteraction 的失效检测。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chime-alerts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /* ---------------- 样式（一次注入，HMR 重载去重） ---------------- */
    var CSS = [
      ".snd-page{display:flex;flex-direction:column;gap:11px;font-size:13px;color:var(--dsw-alias-label-primary,#e7e9f0);padding-bottom:8px}",
      ".snd-grow{flex:1}",
      ".snd-hero{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:13px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent),transparent);padding:11px 12px;display:flex;flex-direction:column;gap:9px}",
      ".snd-hero-top{display:flex;align-items:center;gap:10px}",
      ".snd-title{font-weight:700;font-size:13px}",
      ".snd-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8)}",
      ".snd-chips{display:flex;gap:7px;flex-wrap:wrap}",
      ".snd-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);padding:4px 10px 4px 8px;font-size:11.5px;cursor:pointer;color:var(--dsw-alias-label-primary,#e7e9f0);font-family:inherit}",
      ".snd-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#adb2b8);flex:none}",
      ".snd-chip-state{color:var(--dsw-alias-label-secondary,#9aa3b8);font-size:10.5px}",
      ".snd-chip.on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 55%,transparent)}",
      ".snd-chip.on .snd-chip-dot{background:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 18%,transparent)}",
      ".snd-chip.dis{opacity:.5;cursor:default}",
      ".snd-bulk{display:flex;gap:7px;flex-wrap:wrap;align-items:center}",
      ".snd-grp{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent)}",
      ".snd-grp-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 7%,transparent)}",
      ".snd-grp-caret{color:var(--dsw-alias-label-secondary,#9aa3b8);transition:transform .15s ease;display:inline-block;width:11px}",
      ".snd-grp.closed .snd-grp-caret{transform:rotate(-90deg)}",
      ".snd-grp-name{font-size:11.5px;font-weight:600}",
      ".snd-grp-count{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent);border-radius:999px;padding:0 6px}",
      ".snd-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:9px}",
      "@media (max-width:680px){.snd-grid{grid-template-columns:1fr}}",
      ".snd-row{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);padding:8px 9px}",
      ".snd-row.off{opacity:.6}",
      ".snd-row-hd{display:flex;align-items:center;gap:6px}",
      ".snd-row-name{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".snd-desc{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:28px}",
      ".snd-row-bd{display:flex;align-items:center;gap:5px}",
      ".snd-badge{font-size:9.5px;padding:0 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-label,#dd8629);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 35%,transparent);white-space:nowrap}",
      ".snd-switch{flex:none;display:flex;align-items:center;width:36px;height:20px;padding:2px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 18%,transparent);cursor:pointer;transition:background .15s ease,border-color .15s ease}",
      ".snd-knob{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:margin-left .16s ease}",
      ".snd-switch.on{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
      ".snd-switch.on .snd-knob{margin-left:auto}",
      ".snd-switch.dis{opacity:.45;cursor:default}",
      ".snd-select-wrap{position:relative;display:inline-flex;flex:1;min-width:0}",
      ".snd-select{appearance:none;-webkit-appearance:none;width:100%;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:11.5px;height:26px;padding:0 22px 0 7px;cursor:pointer;font-family:inherit}",
      ".snd-row-bd .snd-select-wrap{flex:1}",
      // 原生 select 的「弹出列表」由系统/UA 绘制，只改控件本身不够：
      // 真机上出现过白底白字 + 巨大浮层盖住整页。这里给弹出层显式配色并声明 color-scheme。
      ".snd-select{color-scheme:light}",
      "body[data-ds-dark-theme] .snd-select{color-scheme:dark}",
      ".snd-select option,.snd-select optgroup{background-color:var(--dsw-alias-bg-overlay,#2c2c2e);color:var(--dsw-alias-label-primary,#e7e9f0)}",
      ".snd-select-wrap::after{content:\"\";position:absolute;right:5px;top:50%;width:13px;height:13px;transform:translateY(-50%);background-color:var(--dsw-alias-label-secondary,#9aa3b8);-webkit-mask:url(\"data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E\") center/contain no-repeat;mask:url(\"data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E\") center/contain no-repeat;pointer-events:none}",
      ".snd-ib{width:27px;height:27px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;flex:none;transition:background .12s ease,color .12s ease}",
      ".snd-ib:hover{color:var(--dsw-alias-label-primary,#e7e9f0);background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent)}",
      ".snd-ib svg{width:14px;height:14px;fill:currentColor}",
      ".snd-ib.play svg{width:17px;height:17px;transform:translateX(1px)}",
      ".snd-ib.off{color:var(--dsw-alias-state-warn-label,#dd8629);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent)}",
      ".snd-vol{display:flex;align-items:center;gap:6px;margin-top:2px}",
      ".snd-vol input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
      ".snd-vol-val{flex:none;width:30px;text-align:right;font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);font-variant-numeric:tabular-nums}",
      ".snd-hostrow{display:flex;align-items:center;gap:4px;padding-top:5px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(120,132,160,.3))}",
      ".snd-host-label{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa3b8);white-space:nowrap;flex:none}",
      ".snd-hostrow .snd-select{height:24px;font-size:11px}",
      ".snd-hostrow .snd-ib{width:24px;height:24px}",
      ".snd-hostrow .snd-ib svg{width:13px;height:13px}",
      ".snd-hostrow .snd-ib.play svg{width:15px;height:15px}",
      ".snd-btn{display:inline-flex;align-items:center;justify-content:center;height:27px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:11.5px;padding:0 9px;cursor:pointer;transition:background .12s ease;font-family:inherit;white-space:nowrap}",
      ".snd-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent)}",
      ".snd-btn-mini{height:22px;padding:0 7px;font-size:10.5px;border-radius:6px}",
      ".snd-diag{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent)}",
      ".snd-diag-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8)}",
      ".snd-diag.closed .snd-grp-caret{transform:rotate(-90deg)}",
      ".snd-diag-bd{padding:0 10px 10px}",
      ".snd-kv{display:grid;grid-template-columns:96px 1fr;gap:3px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8)}",
      ".snd-kv-k{color:var(--dsw-alias-label-secondary,#9aa3b8)}",
      ".snd-kv-v{color:var(--dsw-alias-label-primary,#e7e9f0)}",
      ".snd-note{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.5}",
      ".snd-ws-marks{position:fixed;inset:0;pointer-events:none;z-index:2147482000}",
      ".snd-ws-mark{position:absolute;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;color:var(--dsw-alias-state-warn-label,#dd8629);pointer-events:none}",
      ".snd-ws-mark svg{width:14px;height:14px;fill:currentColor;display:block}",
      ".snd-tip{position:fixed;z-index:2147483000;max-width:240px;background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:6px;padding:4px 8px;font-size:11px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none;opacity:0;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease;white-space:nowrap;font-family:inherit}",
      ".snd-tip.on{opacity:1;transform:none}",
      '.YDXeBa_projectRow.snd-keep-open.snd-keep-open .YDXeBa_rowActions{display:inline-flex}',
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) > svg{display:none}',
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel{display:inline-flex;align-items:center;gap:8px}',
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel::before{content:" ";width:16px;height:16px;flex:none;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}',
    ].join('\n')
    var cssTagId = 'dsh-chime-alerts/style'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTagId + '"]') === null) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-chime-alerts'
      styleTag.dataset.pluginCss = cssTagId
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /* ---------------- i18n ---------------- */
    var navLang = (typeof navigator !== 'undefined' && navigator.language) ? String(navigator.language).toLowerCase() : 'zh'
    var LANG = navLang.indexOf('zh') === 0 ? 'zh' : 'en'
    // v0.5.9：语言以 DSH 的 locale 服务为准。navigator.language 在「英文界面 + 中文系统」
    // 下会误判成中文，导致英文用户看到中文设置页。
    var localeSvc = null
    function syncLang() {
      try {
        if (localeSvc === null) return
        var snap = localeSvc.getLocale()
        if (snap !== null && snap !== undefined && typeof snap.active === 'string') {
          LANG = snap.active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch (err) {}
    }
    function T(zh, en) { return LANG === 'zh' ? zh : en }
    // locale 服务可能晚于本插件挂载：任何时机都能接上（每 1.5s 的同步会用 bindLocale 重试）
    var localeBound = false
    function bindLocale(ctx) {
      try {
        if (localeSvc === null) {
          // locale 已在 inject 列表里，直接读 ctx.locale 即可（此前用 ctx.get 探测，
          // 服务晚挂载时会一直取不到，于是永远退回 navigator.language）
          if (typeof ctx.get === 'function') {
            var viaGet = ctx.get('locale')
            if (viaGet !== undefined && viaGet !== null) localeSvc = viaGet
          }
          if (localeSvc === null) {
            var direct = ctx.locale
            if (direct !== undefined && direct !== null) localeSvc = direct
          }
        }
        if (localeSvc === null || localeSvc === undefined) return
        var before = LANG
        syncLang()
        if (!localeBound && typeof localeSvc.subscribe === 'function') {
          ctx.effect(() => localeSvc.subscribe(() => {
            syncLang()
            try { if (typeof registerSettings === 'function') registerSettings() } catch (err) {}
            bump()
          }))
        }
        localeBound = true
        if (LANG !== before) {
          try { if (typeof registerSettings === 'function') registerSettings() } catch (e) {}
          bump()
        }
      } catch (err) {}
    }
    // 文案改为 getter：切换语言后无需重建对象即可生效
    function metaText(zhLabel, enLabel, zhDesc, enDesc) {
      return {
        get label() { return T(zhLabel, enLabel) },
        get desc() { return T(zhDesc, enDesc) }
      }
    }

    /* ---------------- 事件元数据（十类；静态版可检测 8 类） ---------------- */
    var KIND_META = {
      complete: metaText('任务完成', 'Task completed', 'Agent 完整结束一轮任务（回合正常完成）', 'Agent finished a full turn (normal completion)'),
      subcomplete: metaText('子任务完成', 'Subagent completed', '并行子代理任务完成（默认关闭，需要时打开）', 'A parallel subagent task finished (off by default, enable if needed)'),
      jobdone: metaText('后台任务完成', 'Background job done', '后台作业（如 shell 后台任务）执行完成', 'A background job (e.g. a shell background task) finished'),
      approval: metaText('需要授权', 'Approval needed', '出现需要你手动批准的操作时', 'When an operation requires your manual approval'),
      pluginapproval: metaText('插件授权', 'Plugin approval', '动态 Cordis 插件等待你批准运行/更新', 'A dynamic Cordis plugin is awaiting your approval to run / update'),
      question: metaText('Agent 提问', 'Agent question', 'Agent 调用提问工具询问你时', 'When the agent asks you via the question tool'),
      planreview: metaText('计划评审', 'Plan review', 'Agent 提交计划等待你批准（退出计划模式）', 'Agent submitted a plan awaiting your approval (left plan mode)'),
      goalblocked: metaText('目标受阻', 'Goal blocked', '长期目标被阻塞，需要你处理', 'A long-term goal is blocked and needs your attention'),
      interrupt: metaText('其他打断', 'Interrupted', '运行被停止 / 出错 / 目标阻塞 / 超出 token 上限', 'Run stopped / error / goal blocked / token limit exceeded'),
      jobfail: metaText('后台任务失败', 'Background job failed', '后台作业（如 shell 后台任务）执行失败', 'A background job (e.g. a shell background task) failed')
    }
    var KIND_GROUPS = [
      { id: 'main', get label() { return T('主要通知', 'Primary notifications') }, kinds: ['complete', 'subcomplete', 'jobdone'] },
      { id: 'other', get label() { return T('其他通知', 'Other notifications') }, kinds: ['jobfail', 'interrupt'] },
      { id: 'human', get label() { return T('需要人介入时', 'Human action needed') }, kinds: ['approval', 'pluginapproval', 'question', 'planreview', 'goalblocked'] }
    ]

    // 事件顺序（与分组一致；批量操作与计数按此遍历）
    var KIND_ORDER = ['complete', 'subcomplete', 'jobdone', 'jobfail', 'interrupt', 'approval', 'pluginapproval', 'question', 'planreview', 'goalblocked']
    // 必须是函数：写在这里的 T(...) 会在脚本加载瞬间求值，之后切语言永不更新
    // （真机症状：英文界面里设置页底部仍显示「静态版 v0.5.8」）。
    function versionText() { return T('静态版 v0.5.8', 'Static build v0.5.8') }
    // 宿主诊断信息（设置页「诊断信息」区展示；由 pollHostEvents 更新）
    var HOST_INFO = { boot: null, seq: 0 }
    /* ---------------- 配置（localStorage；键与动态版一致，自动继承） ---------------- */
    var STORE_KEY = 'dsh-chime-alerts-v1'
    var AUDIO_LIB_KEY = 'dsh-chime-alerts-v1-audiolib'
    function defaultKinds() {
      var kinds = {}
      var list = ['complete', 'subcomplete', 'jobdone', 'approval', 'pluginapproval', 'question', 'planreview', 'goalblocked', 'interrupt', 'jobfail']
      for (var i = 0; i < list.length; i++) {
        kinds[list[i]] = { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null }
      }
      kinds.subcomplete.enabled = false
      return kinds
    }
    var store = {
      master: true,
      webBeep: true,
      notifyEnabled: true,
      hostBeep: null,
      hostBeepCapable: null,
      hostSounds: {},
      hostMuted: {},
      platform: null,
      muted: [],
      audioLib: {},
      kinds: defaultKinds()
    }
    function readJson(key) {
      try {
        var raw = window.localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch (err) { return null }
    }
    function loadStore() {
      try {
        var saved = readJson(STORE_KEY)
        if (!saved || typeof saved !== 'object') return
        if (typeof saved.master === 'boolean') store.master = saved.master
        if (typeof saved.webBeep === 'boolean') store.webBeep = saved.webBeep
        else if (saved.sysMode === 'off') store.webBeep = false
        if (typeof saved.notifyEnabled === 'boolean') store.notifyEnabled = saved.notifyEnabled
        if (Array.isArray(saved.muted)) store.muted = saved.muted.filter(function (s) { return typeof s === 'string' })
        if (saved.kinds && typeof saved.kinds === 'object') {
          for (var kind in store.kinds) {
            if (!Object.prototype.hasOwnProperty.call(store.kinds, kind)) continue
            var k = saved.kinds[kind]
            if (!k || typeof k !== 'object') continue
            if (typeof k.enabled === 'boolean') store.kinds[kind].enabled = k.enabled
            if (typeof k.sound === 'string') store.kinds[kind].sound = k.sound
            if (typeof k.volume === 'number' && isFinite(k.volume)) store.kinds[kind].volume = Math.max(0, Math.min(1, k.volume))
          }
        }
        var lib = readJson(AUDIO_LIB_KEY)
        if (lib && typeof lib === 'object') {
          for (var id in lib) {
            if (Object.prototype.hasOwnProperty.call(lib, id) && lib[id] && typeof lib[id].url === 'string' && lib[id].url.indexOf('data:') === 0) {
              store.audioLib[id] = { name: typeof lib[id].name === 'string' ? lib[id].name : 'custom', url: lib[id].url }
            }
          }
        }
      } catch (err) {}
    }
    function persist() {
      try {
        var kinds = {}
        for (var kind in store.kinds) {
          if (!Object.prototype.hasOwnProperty.call(store.kinds, kind)) continue
          var k = store.kinds[kind]
          kinds[kind] = { enabled: k.enabled, sound: k.sound, volume: k.volume }
        }
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ master: store.master, webBeep: store.webBeep, notifyEnabled: store.notifyEnabled, muted: store.muted.slice(), kinds: kinds }))
        window.localStorage.setItem(AUDIO_LIB_KEY, JSON.stringify(store.audioLib))
      } catch (err) {}
    }
    loadStore()

    /* ---------------- 宿主设置同步（静态：DSH webServer 端点；动态：不存在时静默） ---------------- */
    var HOST_API_BASE = '/dsh-chime-alerts'
    var hostApiAvailable = null
    // v0.5.8：宿主桥的失败退避。旧实现一旦失败就把 hostApiAvailable 置 false，
    // 而 pollHostEvents 开头据此直接 return —— 任何一次瞬时失败（启动瞬间端点
    // 尚未就绪、请求超时、资源暂时不可用）都会把整条宿主桥永久关闭，
    // approval / question / planreview / pluginapproval / jobdone / jobfail
    // 全部静默，直到刷新页面。这正是「有些时候不会出声」的随机性来源之一。
    // 现在改为退避重试：连续失败越多间隔越长（上限 30s），成功一次立刻清零。
    var hostApiFailures = 0
    var hostProbeAfter = 0
    function noteHostApiFailure() {
      hostApiFailures += 1
      var backoff = 1500 * Math.pow(2, Math.min(hostApiFailures, 5))
      if (backoff > 30000) backoff = 30000
      hostProbeAfter = Date.now() + backoff
      // 连续失败才在 UI 上标记不可用；但通道仍会按退避重试，不会永久关闭
      if (hostApiFailures >= 3) {
        hostApiAvailable = false
        store.hostBeepCapable = false
      }
      return null
    }
    function hostFetch(path, opts) {
      try {
        if (typeof fetch !== 'function') return Promise.reject(new Error('no-fetch'))
        // v0.5.4：8s 超时兜底——端点异常挂起时绝不拖住设置页、不堆积僵尸请求
        var init = Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {})
        var timer = null
        if (typeof AbortController === 'function') {
          var ctrl = new AbortController()
          init.signal = ctrl.signal
          timer = setTimeout(function () { try { ctrl.abort() } catch (err) {} }, 8000)
        }
        var p = fetch(HOST_API_BASE + path, init)
        if (timer !== null) {
          p.then(function () { clearTimeout(timer) }, function () { clearTimeout(timer) })
        }
        return p
      } catch (err) { return Promise.reject(err) }
    }
    function loadHostBeep() {
      return hostFetch('/sysget', { method: 'GET' }).then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status)
        return r.json()
      }).then(function (data) {
        hostApiAvailable = true
        if (typeof data.boot === 'string') HOST_INFO.boot = data.boot
        if (typeof data.seq === 'number') HOST_INFO.seq = data.seq
        if (data && typeof data.hostBeep === 'boolean') { store.hostBeep = data.hostBeep; bump() }
        if (data && typeof data.capBeep === 'boolean') store.hostBeepCapable = data.capBeep
        if (data && typeof data.platform === 'string') store.platform = data.platform
        // v0.5.5：每事件宿主音与宿主静音（hostSounds/hostMuted，缺失用默认）
        if (data && data.hostSounds !== null && typeof data.hostSounds === 'object') {
          var hs = {}
          for (var k in hostSoundDefaults()) {
            if (Object.prototype.hasOwnProperty.call(hostSoundDefaults(), k) && typeof data.hostSounds[k] === 'string' && data.hostSounds[k] !== '') hs[k] = data.hostSounds[k]
          }
          store.hostSounds = hs
        }
        if (data && data.hostMuted !== null && typeof data.hostMuted === 'object') {
          var hm = {}
          for (var k2 in hostSoundDefaults()) {
            if (Object.prototype.hasOwnProperty.call(hostSoundDefaults(), k2) && data.hostMuted[k2] === true) hm[k2] = true
          }
          store.hostMuted = hm
        }
        return data
      }).catch(function () {
        store.hostBeepCapable = false
        return noteHostApiFailure()
      })
    }
    function saveHostBeep(enabled) {
      store.hostBeep = enabled
      bump()
      return hostFetch('/sysset', { method: 'POST', body: JSON.stringify({ hostBeep: enabled }) }).then(function (r) {
        return r.json()
      }).then(function (data) {
        if (!data || !data.ok) throw new Error('sysset failed')
        return true
      }).catch(function () {
        // 端点不可用（非静态 DSH web 环境）：保留本地选择，重启后由宿主读盘恢复
        return false
      })
    }
    loadHostBeep()

    var storeListeners = []
    function bump() { persist(); for (var i = 0; i < storeListeners.length; i++) storeListeners[i]() }

    /* ---------------- 宿主事件轮询（v0.5.8，静态安装专用通道） ----------------
     * 浏览器快照拿不到「需要授权 / Agent 提问 / 计划评审 / 插件授权」：
     *   - pendingInteraction 不在 SessionSummary 里（ui-session 单独维护，只经
     *     slot 的 useSessionPendingInteraction prop 暴露给 React 组件）；
     *   - cordis_run 的插件授权根本不产生会话快照信号。
     * 宿主半已正确检测这四类，经 /dsh-chime-alerts/events?after=N 增量下发。
     * 其余（complete/subcomplete/jobdone/jobfail/goalblocked）仍走快照自检，
     * 宿主不入队 → 不会双响。
     */
    var hostEventSeq = 0
    var hostEventsPrimed = false
    /**
     * v0.5.8：宿主 boot 令牌。宿主每次重启都会把 seq 计数清零（boot 也随之变化），
     * 而本客户端的游标只存在内存里：不认 boot 的话，重启后这个标签页会一直请求
     * after=旧宿主的值（例如 5），而新宿主的事件是 seq 1/2/3…，全部被
     * ev.seq > after 挡掉——此后这个标签页对**所有**经宿主转发的提醒彻底不响，
     * 只有刷新页面才能恢复。动态半 lib/client.js 一直有这道守卫，静态半漏了。
     */
    var hostBoot = null
    function pollHostEvents() {
      // 退避期内不打扰；退避结束会自行重试——绝不永久关闭这条通道
      if (Date.now() < hostProbeAfter) return
      return hostFetch('/events?after=' + hostEventSeq, { method: 'GET' }).then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status)
        return r.json()
      }).then(function (data) {
        if (!data || data.ok !== true) return
        hostApiFailures = 0
        hostProbeAfter = 0
        hostApiAvailable = true
        if (typeof data.boot === 'string' && data.boot !== hostBoot) {
          // 宿主换代（重启）：seq 从头开始，游标必须跟着归零，否则本页永久失声。
          // 本轮不补响历史事件（与新开页面一致），只把游标对齐到新宿主。
          hostBoot = data.boot
          hostEventSeq = 0
          hostEventsPrimed = true
          if (typeof data.seq === 'number' && data.seq > hostEventSeq) hostEventSeq = data.seq
          return
        }
        var list = Array.isArray(data.events) ? data.events : []
        if (!hostEventsPrimed) {
          // 首轮只对齐游标：页面刚加载时不该把历史事件补响一遍
          hostEventsPrimed = true
          if (typeof data.seq === 'number' && data.seq > hostEventSeq) hostEventSeq = data.seq
          return
        }
        for (var i = 0; i < list.length; i++) {
          var ev = list[i]
          if (!ev || typeof ev.kind !== 'string') continue
          var sid = typeof ev.sessionId === 'string' ? ev.sessionId : null
          // key 带上宿主 seq：宿主已按「种类+来源」节流，浏览器侧按事件 id 去重即可，
          // 避免同来源的两次真实提醒被 3s 节流吞掉
          fire(ev.kind, sid, 'host:' + String(ev.seq))
        }
        if (typeof data.seq === 'number' && data.seq > hostEventSeq) hostEventSeq = data.seq
      }).catch(function () {
        return noteHostApiFailure()
      })
    }
    loadHostBeep().then(function () { return pollHostEvents() })
    function useVersion() {
      var pair = React.useState(0)
      React.useEffect(function () {
        // v0.5.6：必须用函数式更新 setState(x => x + 1)——闭包捕获初值
        // （pair[1](pair[0] + 1) 恒为 1）会让 React 在第一次重渲染后吞掉后续所有
        // bump：设置页第一次点击后 UI 不再响应、"宿主蜂鸣开关切不动"的根因。
        var fn = function () { pair[1](function (x) { return x + 1 }) }
        storeListeners.push(fn)
        return function () {
          var i = storeListeners.indexOf(fn)
          if (i >= 0) storeListeners.splice(i, 1)
        }
      }, [])
      return pair[0]
    }

    /* ---------------- 声音库（内置合成音 + localStorage 自定义音频） ---------------- */
    var PATTERNS = {
      complete: { notes: [[523.25, 0, 0.1, 'sine', 0.6], [659.25, 0.12, 0.1, 'sine', 0.75], [783.99, 0.26, 0.12, 'triangle', 0.9], [1046.5, 0.42, 0.85, 'sine', 1]] },
      subcomplete: { vol: 0.6, notes: [[783.99, 0, 0.4, 'sine', 1]] },
      jobdone: { vol: 0.5, notes: [[392, 0, 0.12, 'sine', 1], [523.25, 0.14, 0.12, 'sine', 0.8], [783.99, 0.28, 0.5, 'triangle', 0.55]] },
      approval: { notes: [[880, 0, 0.28, 'sine', 0.8], [659.25, 0.34, 0.75, 'triangle', 1]] },
      pluginapproval: { notes: [[880, 0, 0.16, 'sine', 0.7], [880, 0.2, 0.12, 'sine', 0.6], [659.25, 0.36, 0.6, 'triangle', 1]] },
      question: { notes: [[523.25, 0, 0.16, 'sine', 0.7], [783.99, 0.22, 0.55, 'triangle', 1]] },
      planreview: { notes: [[987.77, 0, 0.12, 'triangle', 0.85], [783.99, 0.14, 0.12, 'sine', 0.7], [523.25, 0.28, 0.5, 'sine', 0.55]] },
      goalblocked: { notes: [[349.23, 0, 0.2, 'triangle', 0.9], [349.23, 0.22, 0.2, 'sine', 0.9], [261.63, 0.44, 0.7, 'sine', 1]] },
      interrupt: { notes: [[880, 0, 0.28, 'sine', 1], [440, 0.32, 0.12, 'triangle', 0.8]] },
      jobfail: { vol: 0.5, notes: [[1046.5, 0, 0.1, 'sine', 1], [698.46, 0.12, 0.1, 'sine', 0.75], [493.88, 0.24, 0.5, 'triangle', 0.5]] }
    }
    var SOUND_OPTIONS = [
      { value: 'complete', get label() { return T('凯旋 · 渐强琶音', 'Triumph · crescendo arpeggio') } },
      { value: 'subcomplete', get label() { return T('轻叩 · 单声低语', 'Tap · single soft note') } },
      { value: 'approval', get label() { return T('门铃 · 慢叮咚', 'Doorbell · slow chime') } },
      { value: 'pluginapproval', get label() { return T('门铃 · 短叮咚', 'Doorbell · quick chime') } },
      { value: 'question', get label() { return T('询问 · 上扬双音', 'Ask · rising pair') } },
      { value: 'planreview', get label() { return T('落定 · 下行收束', 'Settled · descending close') } },
      { value: 'goalblocked', get label() { return T('困顿 · 卡住低音', 'Stuck · low repeated tones') } },
      { value: 'interrupt', get label() { return T('惊停 · 突停', 'Abrupt · sudden stop') } },
      { value: 'jobfail', get label() { return T('坠落 · 低调下滑', 'Fall · quiet descent') } },
      { value: 'jobdone', get label() { return T('涟漪 · 低调轻响', 'Ripple · quiet chime') } },
      { value: 'custom', get label() { return T('自定义声音…', 'Custom sound…') } }
    ]
    var DEFAULT_SOUND_LABEL = {
      get complete() { return T('凯旋 · 渐强琶音', 'Triumph · crescendo arpeggio') },
      get subcomplete() { return T('轻叩 · 单声低语', 'Tap · single soft note') },
      get jobdone() { return T('涟漪 · 低调轻响', 'Ripple · quiet chime') },
      get approval() { return T('门铃 · 慢叮咚', 'Doorbell · slow chime') },
      get pluginapproval() { return T('门铃 · 短叮咚', 'Doorbell · quick chime') },
      get question() { return T('询问 · 上扬双音', 'Ask · rising pair') },
      get planreview() { return T('落定 · 下行收束', 'Settled · descending close') },
      get goalblocked() { return T('困顿 · 卡住低音', 'Stuck · low repeated tones') },
      get interrupt() { return T('惊停 · 突停', 'Abrupt · sudden stop') },
      get jobfail() { return T('坠落 · 低调下滑', 'Fall · quiet descent') }
    }
    // ---- v0.5.5：每事件宿主音配置（与动态版同一套选项/默认值，与宿主 DEFAULT_WAV 对齐） ----
    var DEFAULT_HOST_SOUND_BY_PLATFORM = {
      win32: {
        complete: 'Windows Notify System Generic.wav',
        subcomplete: 'ding.wav',
        jobdone: 'Windows Notify System Generic.wav',
        approval: 'Windows User Account Control.wav',
        pluginapproval: 'Windows User Account Control.wav',
        question: 'Windows Ding.wav',
        planreview: 'Windows Default.wav',
        goalblocked: 'Windows Exclamation.wav',
        interrupt: 'Windows Notify Email.wav',
        jobfail: 'Windows Error.wav'
      },
      linux: {
        complete: 'complete',
        subcomplete: 'message',
        jobdone: 'message',
        approval: 'dialog-warning',
        pluginapproval: 'dialog-warning',
        question: 'dialog-question',
        planreview: 'dialog-information',
        goalblocked: 'dialog-warning',
        interrupt: 'dialog-warning',
        jobfail: 'dialog-error'
      },
      darwin: {
        complete: 'Glass.aiff',
        subcomplete: 'Pop.aiff',
        jobdone: 'Pop.aiff',
        approval: 'Ping.aiff',
        pluginapproval: 'Ping.aiff',
        question: 'Tink.aiff',
        planreview: 'Sosumi.aiff',
        goalblocked: 'Basso.aiff',
        interrupt: 'Blow.aiff',
        jobfail: 'Sosumi.aiff'
      }
    }
    function hostSoundDefaults() {
      return DEFAULT_HOST_SOUND_BY_PLATFORM[store.platform] || DEFAULT_HOST_SOUND_BY_PLATFORM.win32
    }
    var HOST_SOUND_OPTIONS = [
      { value: 'chimes.wav', get label() { return T('钟琴 chimes', 'Chimes') } },
      { value: 'ding.wav', get label() { return T('叮 ding', 'Ding') } },
      { value: 'Windows Ding.wav', get label() { return T('Windows 叮', 'Windows Ding') } },
      { value: 'Windows Default.wav', get label() { return T('Windows 默认', 'Windows Default') } },
      { value: 'Windows Notify System Generic.wav', get label() { return T('系统通知', 'System Notify') } },
      { value: 'Windows Notify Email.wav', get label() { return T('邮件通知', 'Email Notify') } },
      { value: 'Windows Notify Calendar.wav', get label() { return T('日历通知', 'Calendar Notify') } },
      { value: 'Windows Foreground.wav', get label() { return T('前台提示', 'Foreground') } },
      { value: 'Windows Background.wav', get label() { return T('后台提示', 'Background') } },
      { value: 'Windows Exclamation.wav', get label() { return T('惊叹', 'Exclamation') } },
      { value: 'Windows Error.wav', get label() { return T('错误', 'Error') } },
      { value: 'Windows Critical Stop.wav', get label() { return T('严重停止', 'Critical Stop') } },
      { value: 'Windows User Account Control.wav', get label() { return T('UAC 授权', 'UAC') } },
      { value: 'Windows Hardware Insert.wav', get label() { return T('硬件接入', 'Hardware Insert') } },
      { value: 'Windows Hardware Remove.wav', get label() { return T('硬件移除', 'Hardware Remove') } },
      { value: 'Windows Logon Sound.wav', get label() { return T('登录', 'Logon') } },
      { value: 'Windows Logoff Sound.wav', get label() { return T('注销', 'Logoff') } },
      { value: 'Windows Recycle.wav', get label() { return T('回收站', 'Recycle') } },
      { value: 'Windows Ringout.wav', get label() { return T('拨出', 'Ringout') } }
    ]
    var HOST_SOUND_OPTIONS_LINUX = [
      { value: 'complete', get label() { return T('完成 Complete', 'Complete') } },
      { value: 'message', get label() { return T('消息 Message', 'Message') } },
      { value: 'bell', get label() { return T('铃 Bell', 'Bell') } },
      { value: 'dialog-information', get label() { return T('信息 Information', 'Information') } },
      { value: 'dialog-question', get label() { return T('询问 Question', 'Question') } },
      { value: 'dialog-warning', get label() { return T('警告 Warning', 'Warning') } },
      { value: 'dialog-error', get label() { return T('错误 Error', 'Error') } },
      { value: 'service-login', get label() { return T('登录 Login', 'Login') } }
    ]
    var HOST_SOUND_OPTIONS_MAC = [
      { value: 'Glass.aiff', get label() { return T('玻璃 Glass', 'Glass') } },
      { value: 'Ping.aiff', get label() { return T('Ping', 'Ping') } },
      { value: 'Pop.aiff', get label() { return T('Pop', 'Pop') } },
      { value: 'Tink.aiff', get label() { return T('Tink', 'Tink') } },
      { value: 'Sosumi.aiff', get label() { return T('Sosumi', 'Sosumi') } },
      { value: 'Hero.aiff', get label() { return T('Hero', 'Hero') } },
      { value: 'Purr.aiff', get label() { return T('Purr', 'Purr') } },
      { value: 'Basso.aiff', get label() { return T('Basso', 'Basso') } },
      { value: 'Blow.aiff', get label() { return T('Blow', 'Blow') } },
      { value: 'Frog.aiff', get label() { return T('Frog', 'Frog') } },
      { value: 'Submarine.aiff', get label() { return T('Submarine', 'Submarine') } }
    ]
    function hostSoundOptions() {
      if (store.platform === 'linux') return HOST_SOUND_OPTIONS_LINUX
      if (store.platform === 'darwin') return HOST_SOUND_OPTIONS_MAC
      return HOST_SOUND_OPTIONS
    }
    function hostBeepPreview(kind) {
      hostFetch('/sysbeep', { method: 'POST', body: JSON.stringify({ kind: kind }) }).catch(function () {})
    }
    function soundOptionList(kind) {
      var list = [{ value: 'default', label: (DEFAULT_SOUND_LABEL[kind] !== undefined ? DEFAULT_SOUND_LABEL[kind] : T('默认', 'Default')) }]
      for (var i = 0; i < SOUND_OPTIONS.length; i++) list.push(SOUND_OPTIONS[i])
      for (var id in store.audioLib) {
        if (Object.prototype.hasOwnProperty.call(store.audioLib, id)) {
          list.push({ value: 'custom:' + id, label: T('自定义声音 · ', 'Custom sound · ') + store.audioLib[id].name })
        }
      }
      return list
    }

    var audioCtx = null
    var resumePromise = null
    // v0.5.8：解锁补响队列。浏览器自动播放策略下 AudioContext 初始为 suspended，
    // 而 resume() 是异步的——旧代码同步查 state 后直接 return null，于是「页面加载
    // 后第一响」和「标签页从后台/睡眠恢复后第一响」被静默吞掉；而人不在标签页时
    // 恰恰是本插件最需要出声的时刻。现在改为：等 resume() 落地再判定，仍未解锁就
    // 排队，等首次用户手势（自动播放策略允许的时机）补响。
    var pendingPlays = []
    // 新鲜窗口：只有窗口内的排队项会一起补响，避免解锁瞬间炸出一串旧音
    var PENDING_TTL_MS = 15000
    // 硬上限：超过这个年龄的提醒已经没有意义（对应的授权/提问早就不在等待了），
    // 此时连「最新一条」也不再补响。窗口之内则必须补响，绝不静默丢弃。
    var PENDING_STALE_MS = 120000
    var PENDING_MAX = 8
    var unlockArmed = false

    // v0.5.8：共享主总线。此前每条音符的 gain 直接接 ac.destination，整条链路
    // 没有任何余量——单个提示音峰值约 0.55，两个提示音碰在一起就 >1.0 硬削波
    // （用户报告的「爆音」）。现在统一汇入一条主总线，经内置
    // DynamicsCompressorNode 兜底后再进 destination。
    // 压缩器只做安全网、不参与音色：阈值留在单个提示音峰值之上，只有真的叠音才介入。
    var MASTER_GAIN = 0.85
    var masterBus = null
    function ensureMasterBus(ac) {
      if (masterBus !== null && masterBus.ctx === ac) return masterBus.input
      var input = null
      try { input = ac.createGain() } catch (err) { input = null }
      if (input === null) return null
      try { if (input.gain) input.gain.value = MASTER_GAIN } catch (err) {}
      var tail = null
      try {
        // 测试桩与老环境可能没有 createDynamicsCompressor——缺失时退回直连
        if (typeof ac.createDynamicsCompressor === 'function') tail = ac.createDynamicsCompressor()
      } catch (err) { tail = null }
      if (tail !== null) {
        try {
          if (tail.threshold) tail.threshold.value = -6
          if (tail.knee) tail.knee.value = 3
          if (tail.ratio) tail.ratio.value = 12
          if (tail.attack) tail.attack.value = 0.003
          if (tail.release) tail.release.value = 0.15
          input.connect(tail)
          tail.connect(ac.destination)
        } catch (err) { tail = null }
      }
      if (tail === null) {
        try { input.connect(ac.destination) } catch (err) {}
      }
      masterBus = { ctx: ac, input: input }
      return input
    }

    // v0.5.8：并发提示音错开调度。此前两个事件同时到达就会在同一时刻起音、
    // 完美叠加（flushPending 批量补响时必然如此，因为每个音符都从
    // currentTime + 0.02 起算）。现在用 nextFreeAt 记下「上一声播完的时刻」：
    // 总线空闲就立刻起音（保持原有零延迟），否则接在它后面，绝不重叠。
    var CHIME_GAP = 0.12
    var nextFreeAt = 0

    // 已 running → 同步返回实例（保持原有零延迟调度）；suspended → 返回
    // Promise<AudioContext|null>，等 resume() 落地后再判活；无法创建 → null。
    function ensureAudio() {
      try {
        if (audioCtx === null) {
          var AC = window.AudioContext || window.webkitAudioContext
          if (AC === undefined) return null
          audioCtx = new AC()
          // 上下文自行恢复（如系统解除音频挂起）时也把排队的提示音补上
          if (typeof audioCtx.addEventListener === 'function') {
            audioCtx.addEventListener('statechange', function () { flushPending() })
          }
        }
        if (audioCtx.state === 'running') return audioCtx
        if (audioCtx.state === 'suspended') {
          if (resumePromise === null) {
            resumePromise = Promise.resolve(audioCtx.resume()).catch(function () {}).finally(function () { resumePromise = null })
          }
          return resumePromise.then(function () {
            return audioCtx !== null && audioCtx.state === 'running' ? audioCtx : null
          })
        }
        return null
      } catch (err) { return null }
    }

    // 排队等解锁：同一类别只保留最新一条，避免解锁瞬间补响一串过期提示音
    function queuePending(kind, cfg) {
      if (audioCtx === null) return
      for (var i = pendingPlays.length - 1; i >= 0; i--) {
        if (pendingPlays[i].kind === kind) pendingPlays.splice(i, 1)
      }
      pendingPlays.push({ kind: kind, cfg: cfg, at: Date.now() })
      while (pendingPlays.length > PENDING_MAX) pendingPlays.shift()
      armUnlock()
    }

    function armUnlock() {
      if (unlockArmed) return
      unlockArmed = true
      try {
        var unlock = function () {
          unlockArmed = false
          try {
            window.removeEventListener('pointerdown', unlock)
            window.removeEventListener('keydown', unlock)
            window.removeEventListener('touchstart', unlock)
          } catch (err) {}
          unlockAudio()
        }
        window.addEventListener('pointerdown', unlock)
        window.addEventListener('keydown', unlock)
        window.addEventListener('touchstart', unlock)
      } catch (err) { unlockArmed = false }
    }

    // 在用户手势里 resume()（自动播放策略允许的时机），落地后补响排队的事件
    function unlockAudio() {
      if (audioCtx === null) return
      try {
        if (audioCtx.state === 'running') { flushPending(); return }
        Promise.resolve(audioCtx.resume()).catch(function () {}).then(function () { flushPending() })
      } catch (err) {}
    }

    function flushPending() {
      if (pendingPlays.length === 0) return
      if (audioCtx === null) { pendingPlays.length = 0; return }
      if (audioCtx.state !== 'running') return
      var now = Date.now()
      var batch = pendingPlays
      pendingPlays = []
      // v0.5.8：过期的不再补响（否则解锁瞬间会炸出一串早已无关的旧音），
      // 但最新那一条必须留下——它正是用户刚才在等的那一声。
      // 旧实现把整批一起丢掉：只要从事件发生到用户首次手势超过 PENDING_TTL_MS，
      // 等待中的提示音就静默消失，既没有日志也没有兜底。
      var fresh = []
      var newest = null
      for (var i = 0; i < batch.length; i++) {
        var q = batch[i]
        if (newest === null || q.at > newest.at) newest = q
        if (now - q.at <= PENDING_TTL_MS) fresh.push(q)
      }
      if (fresh.length === 0 && newest !== null && now - newest.at <= PENDING_STALE_MS) fresh.push(newest)
      for (var k = 0; k < fresh.length; k++) {
        var p = fresh[k]
        var pat = resolvePattern(p.kind, p.cfg)
        if (pat === null) continue
        try { scheduleNotes(audioCtx, pat.notes, pat.vol, p.cfg) } catch (err) {}
      }
    }
    function clampVolume(v) { return Math.max(0, Math.min(1, v)) }
    function playCustom(url, volume) {
      return new Promise(function (resolve) {
        try {
          var audio = new window.Audio(url)
          audio.volume = clampVolume(volume)
          var p = audio.play()
          if (p && typeof p.then === 'function') p.then(function () { resolve(true) }, function () { resolve(false) })
          else resolve(true)
        } catch (err) { resolve(false) }
      })
    }
    // 声音配置 → 音符序列。PATTERNS 里既有数组式简写（[freq, start, dur, wave, ?gain]）
    // 也有 {notes, vol} 对象式；sound 为 'default'/'custom'（含悬空的 custom:<id>——
    // 音频库条目已丢失时回落到该事件类别的默认音）时用事件类别本身的声音。
    function resolvePattern(kind, cfg) {
      var sound = cfg.sound
      var patternKind = (sound === 'default' || sound === 'custom' || (typeof sound === 'string' && sound.indexOf('custom:') === 0)) ? kind : sound
      var spec = PATTERNS[patternKind]
      if (spec === undefined) return null
      return {
        notes: Array.isArray(spec) ? spec : spec.notes,
        vol: Array.isArray(spec) ? 1 : (typeof spec.vol === 'number' ? spec.vol : 1)
      }
    }

    // 同步调度（ac 必须已在 running）；返回 true 表示已排上
    function scheduleNotes(ac, pattern, evVol, cfg) {
      var v = clampVolume(cfg.volume)
      var earliest = ac.currentTime + 0.02
      // 总线空闲就立刻起音（保持原有零延迟）；被上一声占着就顺延
      var t0 = nextFreeAt > earliest ? nextFreeAt : earliest
      var bus = ensureMasterBus(ac)
      var span = 0
      for (var i = 0; i < pattern.length; i++) {
        var item = pattern[i]
        var freq = item[0]
        var start = item[1]
        var dur = item[2]
        var wave = item[3]
        var nv = item.length > 4 && typeof item[4] === 'number' ? item[4] : 1
        if (start + dur > span) span = start + dur
        var t = t0 + start
        var gain = ac.createGain()
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.45 * v * evVol * nv, t + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25)
        var osc = ac.createOscillator()
        osc.type = wave
        osc.frequency.value = freq
        osc.connect(gain)
        var osc2 = ac.createOscillator()
        osc2.type = 'sine'
        osc2.frequency.value = freq * 2
        var gain2 = ac.createGain()
        gain2.gain.value = 0.22
        osc2.connect(gain2)
        gain2.connect(gain)
        gain.connect(bus !== null ? bus : ac.destination)
        osc.start(t)
        osc2.start(t)
        osc.stop(t + dur + 0.3)
        osc2.stop(t + dur + 0.3)
      }
      nextFreeAt = t0 + span + CHIME_GAP
      return true
    }

    function playBrowser(kind, cfg) {
      var sound = cfg.sound
      if (typeof sound === 'string' && sound.indexOf('custom:') === 0) {
        var id = sound.slice(7)
        var entry = store.audioLib[id]
        if (entry && typeof entry.url === 'string') return playCustom(entry.url, cfg.volume)
      }
      var pat = resolvePattern(kind, cfg)
      if (pat === null) return Promise.resolve(false)
      var ac = ensureAudio()
      if (ac === null) { queuePending(kind, cfg); return Promise.resolve(false) }
      if (typeof ac.then === 'function') {
        // v0.5.8：挂起解锁路径——等 resume() 真正落地再调度，而不是同步判空丢弃
        return ac.then(function (ctx) {
          if (ctx === null) { queuePending(kind, cfg); return false }
          return scheduleNotes(ctx, pat.notes, pat.vol, cfg)
        })
      }
      return Promise.resolve(scheduleNotes(ac, pat.notes, pat.vol, cfg))
    }

    /* ---------------- 网页通知 ---------------- */
    function requestNotifyPermission() {
      try {
        if (typeof window.Notification === 'undefined') return
        if (window.Notification.permission === 'default') {
          var p = window.Notification.requestPermission()
          if (p && typeof p.catch === 'function') p.catch(function () {})
        }
      } catch (err) {}
    }
    function notify(kind, wsLabel) {
      try {
        if (typeof window.Notification === 'undefined') return
        if (window.Notification.permission !== 'granted') return
        var meta = KIND_META[kind]
        if (meta === undefined) return
        var body = (wsLabel !== null && wsLabel !== undefined ? (T('工作区「', 'Workspace “') + wsLabel + T('」：', '”: ')) : '') + (meta.desc || '')
        var n = new window.Notification(meta.label + T(' · 声音提醒', ' · Sound alert'), { body: body, tag: 'dsh-chime-alerts:' + kind, silent: true })
        try {
          n.onclick = function () { try { window.focus() } catch (e) {}; try { n.close() } catch (e) {} }
        } catch (e) {}
      } catch (err) {}
    }

    /* ---------------- 多 tab 领导锁 ---------------- */
    var LEADER_KEY = 'dsh-chime-alerts-leader'
    var LEADER_TOKEN = 'chime-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    function amLeader() {
      try {
        var now = Date.now()
        var raw = window.localStorage.getItem(LEADER_KEY)
        if (raw === null) { window.localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now); return true }
        var colon = raw.indexOf(':')
        var token = colon < 0 ? '' : raw.slice(0, colon)
        var ts = Number(colon < 0 ? raw : raw.slice(colon + 1)) || 0
        if (token === LEADER_TOKEN) { window.localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now); return true }
        if (now - ts > 8000) { window.localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now); return true }
        return false
      } catch (err) { return true }
    }

    /* ---------------- 事件检测（sessions / workspaces 快照订阅） ---------------- */
    var lastAt = new Map()
    function throttled(kind, key) {
      var now = Date.now()
      var throttleKey = kind + ':' + key
      if (now - (lastAt.get(throttleKey) || 0) < 3000) return false
      lastAt.set(throttleKey, now)
      if (lastAt.size > 300) {
        var first = lastAt.keys().next().value
        lastAt.delete(first)
      }
      return true
    }
    function fire(kind, sessionId, key) {
      if (!store.master) return
      var cfg = store.kinds[kind]
      if (cfg === undefined || !cfg.enabled) return
      if (!throttled(kind, key)) return
      var wsId = idOfSession(sessionId)
      if (wsId !== null && store.muted.indexOf(wsId) >= 0) return
      var wsLabel = labelOfSession(sessionId)
      if (store.notifyEnabled) notify(kind, wsLabel)
      if (store.webBeep) playBrowser(kind, cfg).catch(function () {})
    }
    function testFire(kind) {
      var cfg = store.kinds[kind]
      if (cfg === undefined) return
      requestNotifyPermission()
      if (store.webBeep) playBrowser(kind, cfg).catch(function () {})
    }

    /* ---------------- 工作区映射 ---------------- */
    var workspacesSvc = null
    function workspaceItems() {
      try {
        if (workspacesSvc === null) return []
        var snap = workspacesSvc.list.getSnapshot()
        return snap && Array.isArray(snap.items) ? snap.items : []
      } catch (err) { return [] }
    }
    function workspaceLabelOf(item) {
      return item && typeof item.title === 'string' && item.title ? item.title : String(item.workspaceId)
    }
    function labelOfSession(sessionId) {
      if (sessionId === null || sessionId === undefined) return null
      var items = workspaceItems()
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        if (it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0) return workspaceLabelOf(it)
      }
      return null
    }
    function idOfSession(sessionId) {
      if (sessionId === null || sessionId === undefined) return null
      var items = workspaceItems()
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        if (it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0) {
          return it && typeof it.workspaceId === 'string' ? it.workspaceId : null
        }
      }
      return null
    }

    /* ---------------- 快照检测器 ---------------- */
    function startWatcher(ctx) {
      var sessionsList = ctx.sessions.list
      var prevGoalPhase = new Map()

      function check() {
        var snap = sessionsList.getSnapshot()
        if (!snap || !snap.byId) return
        var byId = snap.byId
        var ids = snap.ids || []
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i]
          var row = byId[id]
          if (!row) continue

          // 回合结束（complete / subcomplete / interrupt）：v0.5.8 起不再看快照。
          // 旧判定是「running true→false 且 !row.pendingInteraction」，但
          // SessionSummary 在 DSH 0.1.7 里没有 pendingInteraction（ui-session 单独
          // 维护，只经 slot 的 useSessionPendingInteraction prop 暴露给 React），
          // 该守卫恒真 → 等待授权期间结束的回合被误判成完成，与授权音同时响起
          // （用户听到的爆音）。宿主半的判定本来就是对的
          // （agent.inbox.hasPending），现改由 /dsh-chime-alerts/events 转发，
          // 见 pollHostEvents()。

          // 需要人介入（approval / question / planreview）：v0.5.8 起不再看快照。
          // 旧代码读 row.pendingInteraction，但当前 DSH 的 SessionSummary 没有该字段
          // （它由 dsh-client-ui-session 单独维护，只经 slot 的
          // useSessionPendingInteraction prop 暴露给 React 组件），row.pendingInteraction
          // 恒为 undefined → 三类在浏览器侧永远不响。改由宿主半检测后经
          // /dsh-chime-alerts/events 转发，见 pollHostEvents()。

          // 目标受阻：goal 投影进入 blocked（projectionValues.goal 仍在 SessionProjectionMap 中）
          var pv = row.projectionValues
          var goal = pv && typeof pv === 'object' ? pv.goal : undefined
          var phase = goal && typeof goal === 'object' ? goal.phase : undefined
          var prevPhase = prevGoalPhase.get(id)
          if (phase === 'blocked' && prevPhase !== 'blocked') {
            fire('goalblocked', id, 'goal:' + id)
          }
          prevGoalPhase.set(id, phase)
        }

        // 后台任务（jobdone / jobfail）：v0.5.8 起不再看快照。
        // DSH 0.1.7 的 SessionListState 已无 jobsBySession（作业列表迁到独立的
        // jobs 快照，见 dsh-client-ui-jobs），旧循环的 `snap.jobsBySession || {}`
        // 恒为空对象 → 两类在浏览器侧永远不响。宿主半的 jobs.onJobDone 一直检测
        // 正常，只是被挡在 CLIENT_PULL_KINDS 之外，现改由
        // /dsh-chime-alerts/events 转发，见 pollHostEvents()。
      }

      var offSessions = sessionsList.subscribe(check)
      var offWorkspaces = workspacesSvc.list.subscribe(function () {})
      return function () {
        offSessions()
        offWorkspaces()
      }
    }

    /* ---------------- 设置页（V3：折叠分组 + 事件卡片 + 双主题 token） ---------------- */
    // 纯 UI 状态（不入 store，不持久化）
    var UI = { closed: {}, diagOpen: false }

    /* ---- 悬浮提示：优先 DSH 原生 Tooltip，拿不到时用自绘（与预览页同一套行为） ---- */
    var TIP = { node: null, timer: null }
    function tipNode() {
      if (TIP.node !== null) return TIP.node
      try {
        var d = document.createElement('div')
        d.className = 'snd-tip'
        document.body.appendChild(d)
        TIP.node = d
      } catch (err) { TIP.node = null }
      return TIP.node
    }
    function hideTip() {
      if (TIP.timer !== null) { try { clearTimeout(TIP.timer) } catch (e) {} TIP.timer = null }
      var n = TIP.node
      if (n !== null) n.classList.remove('on')
    }
    function showTip(anchor, text) {
      var n = tipNode()
      if (n === null || !anchor || typeof anchor.getBoundingClientRect !== 'function') return
      n.textContent = text
      n.classList.remove('on')
      var r = anchor.getBoundingClientRect()
      n.style.left = '0px'
      n.style.top = '0px'
      var w = n.offsetWidth
      var h = n.offsetHeight
      var left = r.left + r.width / 2 - w / 2
      var maxLeft = (window.innerWidth || 1024) - w - 6
      if (left > maxLeft) left = maxLeft
      if (left < 6) left = 6
      var top = r.top - h - 7
      if (top < 6) top = r.bottom + 7
      n.style.left = left + 'px'
      n.style.top = top + 'px'
      requestAnimationFrame(function () { if (TIP.node !== null) TIP.node.classList.add('on') })
    }
    function scheduleTip(anchor, text) {
      if (TIP.timer !== null) { try { clearTimeout(TIP.timer) } catch (e) {} }
      TIP.timer = setTimeout(function () {
        TIP.timer = null
        showTip(anchor, text)
      }, 180)
    }
    function tipProps(text) {
      return {
        onMouseEnter: function (e) { scheduleTip(e.currentTarget, text) },
        onMouseLeave: hideTip,
        onFocus: function (e) { showTip(e.currentTarget, text) },
        onBlur: hideTip
      }
    }

    /* ---- 图标 ---- */
    var BELL_PATH = 'M12 3a6 6 0 0 0-6 6v4l-2 3v1h16v-1l-2-3V9a6 6 0 0 0-6-6zm0 17.5a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 20.5z'
    var SLASH_PATH = 'M4.5 4.5l15 15'
    var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    var ICON_BELL = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/></svg>'
    // 静音：铃铛 + 反色晕边斜杠（底色描粗一圈再叠琥珀细线，14px 下才分得清）
    var ICON_BELL_OFF = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-base,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-base,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
         '<path d="' + SLASH_PATH + '" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>'

    function switchButton(checked, onToggle, disabled) {
      var dis = disabled === true
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-disabled': dis ? 'true' : undefined,
        disabled: dis ? true : undefined,
        className: 'snd-switch' + (checked ? ' on' : '') + (dis ? ' dis' : ''),
        onClick: dis ? undefined : onToggle
      }, React.createElement('span', { className: 'snd-knob' }))
    }

    function iconButton(icon, label, onClick, extraClass) {
      var props = {
        type: 'button',
        className: 'snd-ib' + (extraClass ? ' ' + extraClass : ''),
        onClick: function (e) { hideTip(); if (typeof onClick === 'function') onClick(e) },
        dangerouslySetInnerHTML: { __html: icon }
      }
      var t = tipProps(label)
      for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) props[k] = t[k]
      return React.createElement('button', props)
    }

    function SettingsPage() {
      useVersion()
      var fileRefs = React.useRef({})
      var pendingPick = React.useRef({})

      React.useEffect(function () {
        var onFocus = function () {
          var need = false
          for (var kind in pendingPick.current) {
            if (Object.prototype.hasOwnProperty.call(pendingPick.current, kind) && pendingPick.current[kind]) {
              pendingPick.current[kind] = false
              need = true
              var k = store.kinds[kind]
              if (k !== undefined && k.customUrl) k.sound = 'custom'
            }
          }
          if (need) bump()
        }
        try { window.addEventListener('focus', onFocus) } catch (e) {}
        return function () {
          try { window.removeEventListener('focus', onFocus) } catch (e) {}
          hideTip()
        }
      }, [])

      function openUpload(kind) {
        var el = fileRefs.current[kind]
        if (!el) return
        pendingPick.current[kind] = true
        try { el.click() } catch (e) {}
      }

      function onFilePicked(kind, e) {
        pendingPick.current[kind] = false
        var file = e.target && e.target.files && e.target.files[0]
        if (e.target) e.target.value = ''
        if (!file) return
        if (file.size > 3 * 1024 * 1024) return
        var reader = new window.FileReader()
        reader.onload = function () {
          try {
            var dataUrl = reader.result
            if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return
            var id = 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
            store.audioLib[id] = { name: file.name, url: dataUrl }
            store.kinds[kind].sound = 'custom:' + id
            bump()
          } catch (err) {}
        }
        reader.onerror = function () {}
        reader.readAsDataURL(file)
      }

      function enabledCount() {
        var n = 0
        for (var i = 0; i < KIND_ORDER.length; i++) if (store.kinds[KIND_ORDER[i]].enabled) n += 1
        return n
      }

      function chip(key, label, on, onClick, disabled) {
        var dis = disabled === true
        var cls = 'snd-chip' + (on ? ' on' : '') + (dis ? ' dis' : '')
        return React.createElement('button', {
          type: 'button',
          className: cls,
          'data-chip': key,
          disabled: dis ? true : undefined,
          onClick: dis ? undefined : onClick
        },
          React.createElement('span', { className: 'snd-chip-dot' }),
          React.createElement('span', null, label),
          React.createElement('span', { className: 'snd-chip-state' }, on ? T('开', 'On') : T('关', 'Off')))
      }

      function setAll(v) {
        for (var i = 0; i < KIND_ORDER.length; i++) store.kinds[KIND_ORDER[i]].enabled = v
        bump()
      }

      function resetDefaults() {
        var d = defaultKinds()
        for (var i = 0; i < KIND_ORDER.length; i++) store.kinds[KIND_ORDER[i]] = d[KIND_ORDER[i]]
        store.master = true
        store.webBeep = true
        store.notifyEnabled = false
        UI.closed = {}
        bump()
      }

      function hostRow(kind) {
        if (store.hostBeep !== true) return null
        var hostDisabled = store.hostBeepCapable === false
        var muted = store.hostMuted[kind] === true
        return React.createElement('div', { className: 'snd-hostrow' },
          React.createElement('span', { className: 'snd-host-label' }, T('宿主音', 'Host')),
          React.createElement('div', { className: 'snd-select-wrap' },
            React.createElement('select', {
              className: 'snd-select snd-host-select',
              value: store.hostSounds[kind] || hostSoundDefaults()[kind],
              disabled: hostDisabled ? true : undefined,
              onChange: function (e) {
                store.hostSounds[kind] = e.target.value
                bump()
                hostFetch('/sysset', { method: 'POST', body: JSON.stringify({ hostSounds: store.hostSounds }) }).catch(function () {})
              }
            }, hostSoundOptions().map(function (o) {
              return React.createElement('option', { key: o.value, value: o.value }, o.label)
            }))),
          iconButton(muted ? ICON_BELL_OFF : ICON_BELL,
            muted ? T('已静音 · 点击恢复', 'Muted · click to restore') : T('静音（只影响这一个事件）', 'Mute this event only'),
            hostDisabled ? undefined : function () {
              if (store.hostMuted[kind] === true) delete store.hostMuted[kind]
              else store.hostMuted[kind] = true
              bump()
              hostFetch('/sysset', { method: 'POST', body: JSON.stringify({ hostMuted: store.hostMuted }) }).catch(function () {})
            },
            'snd-hostmute' + (muted ? ' off' : '')),
          iconButton(ICON_PLAY, T('试听宿主系统音', 'Preview host sound'),
            hostDisabled ? undefined : function () { hostBeepPreview(kind) }, 'play snd-hostpreview'))
      }

      function card(kind) {
        var cfg = store.kinds[kind]
        var meta = KIND_META[kind]
        var head = React.createElement('div', { className: 'snd-row-hd' },
          React.createElement('span', { className: 'snd-row-name' }, meta.label),
          cfg.enabled ? null : React.createElement('span', { className: 'snd-badge' }, T('静音', 'Muted')),
          React.createElement('span', { className: 'snd-grow' }),
          switchButton(cfg.enabled, function () { cfg.enabled = !cfg.enabled; bump() }))

        var children = [
          head,
          React.createElement('div', { className: 'snd-desc' }, meta.desc),
          React.createElement('div', { className: 'snd-row-bd' },
            React.createElement('div', { className: 'snd-select-wrap' },
              React.createElement('select', {
                className: 'snd-select',
                value: cfg.sound,
                onChange: function (e) {
                  if (e.target.value === 'custom') { openUpload(kind); return }
                  cfg.sound = e.target.value
                  bump()
                }
              }, soundOptionList(kind).map(function (o) {
                return React.createElement('option', { key: o.value, value: o.value },
                  o.value === 'custom' ? T('自定义声音…', 'Custom sound…') : o.label)
              }))),
            iconButton(ICON_PLAY, T('试听网页音', 'Preview browser sound'),
              function () { testFire(kind) }, 'play')),
          // 音量常驻可见（曾做成「点数字展开」，真机上被误认为功能消失——功能不能靠猜）
          React.createElement('div', { className: 'snd-vol' },
            React.createElement('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(cfg.volume * 100),
              onChange: function (e) { cfg.volume = Number(e.target.value) / 100; bump() }
            }),
            React.createElement('span', { className: 'snd-vol-val' }, Math.round(cfg.volume * 100) + '%')),
          hostRow(kind),
          React.createElement('input', {
            ref: function (el) { fileRefs.current[kind] = el },
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: function (e) { onFilePicked(kind, e) }
          })
        ]
        return React.createElement('div', { key: kind, className: 'snd-row' + (cfg.enabled ? '' : ' off') }, children)
      }

      function group(g) {
        var closed = UI.closed[g.id] === true
        var on = 0
        for (var i = 0; i < g.kinds.length; i++) if (store.kinds[g.kinds[i]].enabled) on += 1
        var hd = React.createElement('div', {
          className: 'snd-grp-hd',
          onClick: function () { UI.closed[g.id] = !closed; bump() }
        },
          React.createElement('span', { className: 'snd-grp-caret' }, '▾'),
          React.createElement('span', { className: 'snd-grp-name' }, g.label),
          React.createElement('span', { className: 'snd-grp-count' }, on + '/' + g.kinds.length),
          React.createElement('span', { className: 'snd-grow' }),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: function (e) {
              e.stopPropagation()
              for (var j = 0; j < g.kinds.length; j++) store.kinds[g.kinds[j]].enabled = true
              bump()
            }
          }, T('本组全开', 'All on')),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: function (e) {
              e.stopPropagation()
              for (var j = 0; j < g.kinds.length; j++) store.kinds[g.kinds[j]].enabled = false
              bump()
            }
          }, T('本组全关', 'All off')),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: function (e) { e.stopPropagation(); UI.closed[g.id] = !closed; bump() }
          }, closed ? T('展开', 'Expand') : T('收起', 'Collapse')))
        var body = closed ? null : React.createElement('div', { className: 'snd-grid' }, g.kinds.map(function (kind) { return card(kind) }))
        return React.createElement('div', { key: g.id, className: 'snd-grp' + (closed ? ' closed' : '') }, hd, body)
      }

      function diagnostics() {
        var open = UI.diagOpen === true
        var hd = React.createElement('div', {
          className: 'snd-diag-hd',
          onClick: function () { UI.diagOpen = !open; bump() }
        },
          React.createElement('span', { className: 'snd-grp-caret' }, '▾'),
          React.createElement('span', null, T('诊断信息', 'Diagnostics')))
        if (!open) return React.createElement('div', { className: 'snd-diag closed' }, hd)
        var rows = [
          [T('静态版', 'Static build'), versionText()],
          [T('宿主端点', 'Host endpoint'), hostApiAvailable === true ? T('已连接 /events', 'connected /events') : (hostApiAvailable === false ? T('不可用', 'unavailable') : T('未知', 'unknown'))],
          [T('宿主 boot', 'Host boot'), HOST_INFO.boot === null ? T('未知', 'unknown') : String(HOST_INFO.boot)],
          [T('已收事件', 'Events seen'), String(HOST_INFO.seq)],
          [T('语言', 'Language'), (localeBound ? T('已绑定', 'bound') : T('未绑定', 'unbound')) + ' · ' + (localeSvc !== null && typeof localeSvc.getLocale === 'function' ? String((localeSvc.getLocale() || {}).active) : '?') + ' · ' + (LANG === 'zh' ? 'zh' : 'en')],
          [T('工作区静音标记', 'Workspace marks'), WS_MARK_STATS.rows + T(' 行 / ', ' rows / ') + WS_MARK_STATS.matched + T(' 匹配 / ', ' matched / ') + WS_MARK_STATS.shown + T(' 显示', ' shown')]
        ]
        return React.createElement('div', { className: 'snd-diag' }, hd,
          React.createElement('div', { className: 'snd-diag-bd' },
            React.createElement('div', { className: 'snd-kv' }, rows.reduce(function (acc, r, i) {
              acc.push(React.createElement('span', { key: 'k' + i, className: 'snd-kv-k' }, r[0]))
              acc.push(React.createElement('span', { key: 'v' + i, className: 'snd-kv-v' }, r[1]))
              return acc
            }, []))));
      }

      function workspaceGroup() {
        var items = workspaceItems()
        if (items.length === 0) return null
        var mutedCount = 0
        for (var i = 0; i < items.length; i++) {
          if (store.muted.indexOf(String(items[i].workspaceId)) >= 0) mutedCount += 1
        }
        return React.createElement('div', { className: 'snd-grp' },
          React.createElement('div', { className: 'snd-grp-hd' },
            React.createElement('span', { className: 'snd-grp-name' }, T('工作区静音', 'Workspace mute')),
            React.createElement('span', { className: 'snd-grp-count' }, mutedCount + '/' + items.length)),
          React.createElement('div', { className: 'snd-grid' }, items.map(function (it) {
            var id = String(it.workspaceId)
            var muted = store.muted.indexOf(id) >= 0
            return React.createElement('div', { key: id, className: 'snd-row' + (muted ? ' off' : '') },
              React.createElement('div', { className: 'snd-row-hd' },
                React.createElement('span', { className: 'snd-row-name' }, workspaceLabelOf(it)),
                muted ? React.createElement('span', { className: 'snd-badge' }, T('静音', 'Muted')) : null,
                React.createElement('span', { className: 'snd-grow' }),
                switchButton(muted, function () { toggleWorkspaceMute(id) })),
              React.createElement('div', { className: 'snd-desc' },
                T('该工作区的所有会话都不出声；侧栏会话行会显示静音标记', 'Silences every session in this workspace; its sidebar rows show a muted mark')))
          })))
      }

      return React.createElement('div', { className: 'snd-page' },
        React.createElement('div', { className: 'snd-hero' },
          React.createElement('div', { className: 'snd-hero-top' },
            React.createElement('div', null,
              React.createElement('div', { className: 'snd-title' }, T('声音提醒', 'Sound alerts')),
              React.createElement('div', { className: 'snd-sub' },
                enabledCount() + ' / ' + KIND_ORDER.length + T(' 个事件会出声', ' events will sound') +
                (store.master ? '' : T('（总开关已关）', ' (master off)')))),
            React.createElement('span', { className: 'snd-grow' }),
            switchButton(store.master, function () { store.master = !store.master; bump() })),
          React.createElement('div', { className: 'snd-chips' },
            chip('webBeep', T('网页响铃', 'Browser sound'), store.webBeep, function () { store.webBeep = !store.webBeep; bump() }),
            chip('notify', T('网页通知', 'Web notifications'), store.notifyEnabled, function () {
              store.notifyEnabled = !store.notifyEnabled
              bump()
              if (store.notifyEnabled) requestNotifyPermission()
            }),
            chip('hostBeep', T('宿主蜂鸣', 'Host beep'), store.hostBeep === true, function () { saveHostBeep(!(store.hostBeep === true)) }, store.hostBeepCapable === false))),
        React.createElement('div', { className: 'snd-bulk' },
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: function () { setAll(true) } }, T('全部开启', 'All on')),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: function () { setAll(false) } }, T('全部静音', 'All muted')),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: resetDefaults }, T('恢复默认', 'Reset'))),
        KIND_GROUPS.map(group),
        workspaceGroup(),
        diagnostics(),
        React.createElement('div', { className: 'snd-note' },
          versionText() + ' · ' + T('九类提醒由宿主检测后经 /dsh-chime-alerts/events 转发；宿主蜂鸣与每事件宿主音存宿主磁盘，自定义音频存浏览器（≤3MB）。',
            'Nine alert kinds are detected by the host and forwarded over /dsh-chime-alerts/events; host beep and per-event host sounds live on host disk, custom audio in the browser (≤3MB).')))
    }

    /* ---------------- 工作区静音（v0.5.9：设置页开关 + 标题旁只读标记） ---------------- */
    // 标记渲染在 body 下的独立覆盖层里（React 不管理这些节点），只按工作区行标题的
    // 屏幕坐标**移动位置**——不插入 React 子树、不删除，因此不存在「被重渲染冲掉再补回」
    // 的闪烁。滚动/尺寸变化/定时器只更新坐标。
    var WS_MARK_ATTR = 'data-chime-ws-mark'
    var WS_MARK_STATS = { rows: 0, matched: 0, shown: 0, tick: 0 }
    var overlayHost = null
    var overlayMarks = new Map() // wsId -> element
    var ICON_BELL_OFF_PLAIN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-surface,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="' + SLASH_PATH + '" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>'

    function toggleWorkspaceMute(wsId) {
      var id = String(wsId)
      var i = store.muted.indexOf(id)
      if (i >= 0) store.muted.splice(i, 1)
      else store.muted.push(id)
      bump()
    }

    function workspaceTitleNode(row, title) {
      var all = row.querySelectorAll('span,div,button')
      var loose = null
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.children.length > 0) continue
        var text = el.textContent === null ? '' : el.textContent.trim()
        if (text === '') continue
        if (text === title) return el
        if (loose === null && text.indexOf(title) === 0) loose = el
      }
      return loose
    }

    function ensureOverlay() {
      if (overlayHost !== null) return overlayHost
      if (typeof document === 'undefined') return null
      var host = document.createElement('div')
      host.className = 'snd-ws-marks'
      try { document.body.appendChild(host) } catch (e) { return null }
      overlayHost = host
      return host
    }

    function syncWorkspaceMarks() {
      try {
        if (typeof document === 'undefined') return
        var host = ensureOverlay()
        if (host === null) return
        var items = workspaceItems()
        var rows = document.querySelectorAll('div[role="treeitem"]')
        WS_MARK_STATS.rows = rows.length
        WS_MARK_STATS.matched = 0
        WS_MARK_STATS.tick = Date.now()
        var seen = new Set()
        for (var i = 0; i < items.length; i++) {
          var it = items[i]
          if (!it || typeof it.workspaceId !== 'string') continue
          var wsId = String(it.workspaceId)
          if (store.muted.indexOf(wsId) < 0) continue
          var title = workspaceLabelOf(it)
          var titleEl = null
          var rowEl = null
          for (var r = 0; r < rows.length; r++) {
            var cand = workspaceTitleNode(rows[r], title)
            if (cand !== null) { titleEl = cand; rowEl = rows[r]; break }
          }
          if (titleEl === null || rowEl === null) continue
          WS_MARK_STATS.matched += 1
          var mark = overlayMarks.get(wsId)
          if (mark === undefined) {
            mark = document.createElement('span')
            mark.className = 'snd-ws-mark'
            mark.setAttribute(WS_MARK_ATTR, wsId)
            mark.title = T('该工作区已静音（设置 → 声音提醒 里可关闭）', 'This workspace is muted (turn it off in Settings → Sound alerts)')
            mark.innerHTML = ICON_BELL_OFF_PLAIN
            try { host.appendChild(mark) } catch (e) { continue }
            overlayMarks.set(wsId, mark)
          }
          var rect = rowEl.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          // 位置：贴在该行「...」操作按钮的左侧（实测其矩形，不再猜偏移量）；
          // 没有按钮时退回行右侧内部 72px。
          var btns = rowEl.querySelectorAll('button')
          var anchorLeft = rect.right - 72
          if (btns.length > 0) {
            var last = btns[btns.length - 1]
            var br = last.getBoundingClientRect()
            if (br.width > 0) anchorLeft = br.left - 19
          }
          mark.style.left = Math.round(anchorLeft) + 'px'
          mark.style.top = Math.round(rect.top + rect.height / 2 - 7) + 'px'
          // 悬停中的行会浮现操作按钮，布局随之变化——此时隐藏标记，避免跳动与遮挡
          var hovering = false
          try { hovering = !!(rowEl.matches && rowEl.matches(':hover')) } catch (e) { hovering = false }
          mark.style.display = hovering ? 'none' : ''
          seen.add(wsId)
        }
        // 未静音 / 不在视野内的工作区：隐藏而非删除（删除会重新触发插入，容易抖动）
        overlayMarks.forEach(function (el, id) {
          if (!seen.has(id)) el.style.display = 'none'
        })
        WS_MARK_STATS.shown = seen.size
      } catch (err) {}
    }

    function teardownOverlay() {
      try {
        overlayMarks.forEach(function (el) { try { el.remove() } catch (e) {} })
        overlayMarks.clear()
        if (overlayHost !== null) { try { overlayHost.remove() } catch (e) {} }
        overlayHost = null
      } catch (err) {}
    }

    /* ---------------- 插件主体 ---------------- */
    // timer 必须声明：apply 使用 ctx.interval/ctx.timeout（mixin 访问器内部解析
    // ctx['timer']，未声明时 fiber 代理会抛 "cannot get property "timer" without
    // inject"——静态客户端启动失败即由此而来；与动态版 client.js 的声明保持一致）。
    var inject = ['timer', 'slots', 'sessions', 'workspaces', 'locale']

    function apply(ctx) {
      workspacesSvc = ctx.workspaces
      bindLocale(ctx)
      ctx.effect(function () {
        return function () {
          try {
            var stale = document.querySelectorAll('[' + WS_MARK_ATTR + ']')
            for (var i = 0; i < stale.length; i++) { try { stale[i].remove() } catch (e) {} }
          } catch (e) {}
        }
      })
      var disposeWatcher = startWatcher(ctx)
      ctx.effect(function () { return disposeWatcher })

      // v0.5.8：宿主事件轮询（1500ms ≈ 宿主 3s 节流的一半，保证不漏事件）。
      // 必须放在 document 守卫之外——它不依赖 DOM，且在无 document 环境下
      // 也应当继续工作（事件检测与 DOM 注入无关）。
      ctx.interval(pollHostEvents, 1500)
      // 工作区标题旁标记的同步（置后：不改动既有 interval 的注册顺序）
      // 覆盖层标记：定时与滚动/尺寸变化时只更新坐标（不插入 React 子树，天然不闪）
    ctx.interval(function () { bindLocale(ctx); syncWorkspaceMarks() }, 800)

    // 侧栏滚动 / 窗口尺寸变化：只重算坐标（覆盖层节点不重建，不会闪）
    var onReflow = function () { try { syncWorkspaceMarks() } catch (e) {} }
    // 鼠标进出工作区行：立刻重算（悬停会改变行内布局）
    var hoverTimer = null
    var onHover = function () {
      if (hoverTimer !== null) return
      hoverTimer = setTimeout(function () { hoverTimer = null; try { syncWorkspaceMarks() } catch (e) {} }, 60)
    }
    try {
      document.addEventListener('mouseover', onHover, true)
      document.addEventListener('mouseout', onHover, true)
    } catch (e) {}
    ctx.effect(function () {
      return function () {
        try { document.removeEventListener('mouseover', onHover, true) } catch (e) {}
        try { document.removeEventListener('mouseout', onHover, true) } catch (e) {}
        if (hoverTimer !== null) clearTimeout(hoverTimer)
      }
    })
    try {
      document.addEventListener('scroll', onReflow, true)
      window.addEventListener('resize', onReflow)
    } catch (e) {}
    ctx.effect(function () {
      return function () {
        try { document.removeEventListener('scroll', onReflow, true) } catch (e) {}
        try { window.removeEventListener('resize', onReflow) } catch (e) {}
        teardownOverlay()
      }
    })
      ctx.timeout(function () { bindLocale(ctx); syncWorkspaceMarks() }, 1200)
      // 语言变化后重注册：外壳的导航列表靠注册账本（ledger）的 bump 触发重渲染。
      // 文字本身由 label thunk 每次投影重读，所以 id 保持不变——原先「换 id 才刷新」
      // 的做法会让分区在英文下叫 chime-en、中文下叫 chime-zh，既难查也丢掉了
      // 「重注册同 id 即替换该格子」的官方语义。
      var settingsDispose = null
      function registerSettings() {
        if (settingsDispose !== null) { try { settingsDispose() } catch (e) {} }
        settingsDispose = ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'chime-alerts',
            order: 25,
            // thunk：外壳每次投影都重新调用，语言跟着 locale 走（SlotLabel = string | (() => string)）
            label: function () { return T('声音提醒', 'Sound Alerts') }
          }, SettingsPage)
        })
      }
      registerSettings()
      ctx.effect(function () { return function () { if (settingsDispose !== null) { try { settingsDispose() } catch (e) {} } } })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
