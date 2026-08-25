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
 *      - pendingInteraction 出现（'approval' | 'plan-review' | 'question'）→
 *        approval / planreview / question
 *      - projectionValues.goal.phase 进入 'blocked' → goalblocked
 *   2. jobsBySession 快照：job status running/stopping → completed（非 subagent）
 *      → jobdone；→ failed → jobfail；killed 不响；kind === 'subagent' 跳过
 *   3. 静态版无法从快照得到 pluginapproval（cordis_run 授权）——该事件由静态
 *      宿主半（lib/host.js 的 tools/result 监听）在宿主蜂鸣开启时用系统音兜底；
 *      浏览器侧无对应信号。
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
 */
window.__ModuleLoader__.load({
  id: 'dsh-chime-alerts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /* ---------------- 样式（一次注入，HMR 重载去重） ---------------- */
    var CSS = [
      '.snd-page{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#e7e9f0);padding-bottom:8px}',
      '.snd-master{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.25));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,140,170,.06))}',
      '.snd-row{display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,140,170,.06))}',
      '.snd-group{display:flex;flex-direction:column;gap:8px}',
      '.snd-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa3b8);padding:0 4px}',
      '.snd-row.off{opacity:.55}',
      '.snd-hostrow{opacity:.85;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.12));margin-left:18px;padding-top:4px;padding-bottom:4px}',
      '.snd-switch.dis{opacity:.45;cursor:default}',
      '.snd-row-name{flex:none;min-width:88px;white-space:nowrap}',
      '.snd-name{font-weight:600;line-height:1.3}',
      '.snd-desc{display:block;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);margin-top:2px;line-height:1.45}',
      '.snd-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:1px solid rgba(0,0,0,.18);border-radius:10px;background:#7d8698;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.snd-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s ease}',
      '.snd-switch.on{background:#3b82f6;border-color:#2b6ae0}',
      '.snd-switch.on .snd-knob{left:18px}',
      '.snd-select-wrap{position:relative;display:inline-flex;flex:none}',
      '.snd-select-wrap::after{content:"";position:absolute;right:8px;top:50%;width:12px;height:12px;transform:translateY(-50%);background-color:var(--dsw-alias-label-secondary,#9aa3b8);-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;pointer-events:none}',
      '.snd-select{appearance:none;-webkit-appearance:none;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:12.5px;height:30px;padding:0 26px 0 8px;min-width:150px;cursor:pointer}',
      '.snd-page .snd-volume{width:auto;flex:1;min-width:80px;max-width:240px;margin:2px 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.snd-vol-val{flex:none;width:36px;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);font-variant-numeric:tabular-nums}',
      '.snd-row-mute{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.snd-row-mute:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,170,.22));color:var(--dsw-alias-label-primary,#e7e9f0)}',
      '.snd-row-mute.off{color:#e08a3c}',
      '.snd-row-mute-icon{width:15px;height:15px;display:block;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}',
      '.snd-row-mute.off .snd-row-mute-icon{-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat}',
      '.snd-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:12px;padding:0 10px;cursor:pointer;transition:background .12s ease}',
      '.snd-btn:hover{background:var(--dsw-alias-hover-l2,rgba(128,140,170,.22))}',
      '.snd-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.5}',
      '.snd-ws-mute{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(30,36,52,.92));box-shadow:0 2px 6px rgba(0,0,0,.3);color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.snd-ws-mute:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,170,.22));color:var(--dsw-alias-label-primary,#e7e9f0)}',
      '.snd-ws-mute.off{color:#e08a3c}',
      '.snd-ws-mute.pin{background:transparent;border-color:transparent;box-shadow:none}',
      '.snd-ws-mute-icon{width:14px;height:14px;display:block;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}',
      '.snd-ws-mute.off .snd-ws-mute-icon{-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat}',
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
    function T(zh, en) { return LANG === 'zh' ? zh : en }

    /* ---------------- 事件元数据（十类；静态版可检测 8 类） ---------------- */
    var KIND_META = {
      complete: { label: T('任务完成', 'Task completed'), desc: T('Agent 完整结束一轮任务（回合正常完成）', 'Agent finished a full turn (normal completion)') },
      subcomplete: { label: T('子任务完成', 'Subagent completed'), desc: T('并行子代理任务完成（默认关闭，需要时打开）', 'A parallel subagent task finished (off by default, enable if needed)') },
      jobdone: { label: T('后台任务完成', 'Background job done'), desc: T('后台作业（如 shell 后台任务）执行完成', 'A background job (e.g. a shell background task) finished') },
      approval: { label: T('需要授权', 'Approval needed'), desc: T('出现需要你手动批准的操作时', 'When an operation requires your manual approval') },
      pluginapproval: { label: T('插件授权', 'Plugin approval'), desc: T('动态 Cordis 插件等待你批准（静态版仅宿主蜂鸣）', 'A dynamic Cordis plugin is awaiting approval (static: host beep only)') },
      question: { label: T('Agent 提问', 'Agent question'), desc: T('Agent 调用提问工具询问你时', 'When the agent asks you via the question tool') },
      planreview: { label: T('计划评审', 'Plan review'), desc: T('Agent 提交计划等待你批准（退出计划模式）', 'Agent submitted a plan awaiting your approval (left plan mode)') },
      goalblocked: { label: T('目标受阻', 'Goal blocked'), desc: T('长期目标被阻塞，需要你处理', 'A long-term goal is blocked and needs your attention') },
      interrupt: { label: T('其他打断', 'Interrupted'), desc: T('运行被停止 / 出错 / 目标阻塞 / 超出 token 上限（静态版并入任务完成）', 'Run stopped / error / goal blocked / token limit exceeded (static: merged into completion)') },
      jobfail: { label: T('后台任务失败', 'Background job failed'), desc: T('后台作业（如 shell 后台任务）执行失败', 'A background job (e.g. a shell background task) failed') }
    }
    var KIND_GROUPS = [
      { id: 'main', label: T('主要通知', 'Primary notifications'), kinds: ['complete', 'subcomplete', 'jobdone'] },
      { id: 'other', label: T('其他通知', 'Other notifications'), kinds: ['jobfail', 'interrupt'] },
      { id: 'human', label: T('需要人介入时', 'Human action needed'), kinds: ['approval', 'pluginapproval', 'question', 'planreview', 'goalblocked'] }
    ]

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
        hostApiAvailable = false
        store.hostBeepCapable = false
        return null
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
      { value: 'complete', label: T('凯旋 · 渐强琶音', 'Triumph · crescendo arpeggio') },
      { value: 'subcomplete', label: T('轻叩 · 单声低语', 'Tap · single soft note') },
      { value: 'approval', label: T('门铃 · 慢叮咚', 'Doorbell · slow chime') },
      { value: 'pluginapproval', label: T('门铃 · 短叮咚', 'Doorbell · quick chime') },
      { value: 'question', label: T('询问 · 上扬双音', 'Ask · rising pair') },
      { value: 'planreview', label: T('落定 · 下行收束', 'Settled · descending close') },
      { value: 'goalblocked', label: T('困顿 · 卡住低音', 'Stuck · low repeated tones') },
      { value: 'interrupt', label: T('惊停 · 突停', 'Abrupt · sudden stop') },
      { value: 'jobfail', label: T('坠落 · 低调下滑', 'Fall · quiet descent') },
      { value: 'jobdone', label: T('涟漪 · 低调轻响', 'Ripple · quiet chime') },
      { value: 'custom', label: T('自定义声音…', 'Custom sound…') }
    ]
    var DEFAULT_SOUND_LABEL = {
      complete: T('凯旋 · 渐强琶音', 'Triumph · crescendo arpeggio'),
      subcomplete: T('轻叩 · 单声低语', 'Tap · single soft note'),
      jobdone: T('涟漪 · 低调轻响', 'Ripple · quiet chime'),
      approval: T('门铃 · 慢叮咚', 'Doorbell · slow chime'),
      pluginapproval: T('门铃 · 短叮咚', 'Doorbell · quick chime'),
      question: T('询问 · 上扬双音', 'Ask · rising pair'),
      planreview: T('落定 · 下行收束', 'Settled · descending close'),
      goalblocked: T('困顿 · 卡住低音', 'Stuck · low repeated tones'),
      interrupt: T('惊停 · 突停', 'Abrupt · sudden stop'),
      jobfail: T('坠落 · 低调下滑', 'Fall · quiet descent')
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
      { value: 'chimes.wav', label: T('钟琴 chimes', 'Chimes') },
      { value: 'ding.wav', label: T('叮 ding', 'Ding') },
      { value: 'Windows Ding.wav', label: T('Windows 叮', 'Windows Ding') },
      { value: 'Windows Default.wav', label: T('Windows 默认', 'Windows Default') },
      { value: 'Windows Notify System Generic.wav', label: T('系统通知', 'System Notify') },
      { value: 'Windows Notify Email.wav', label: T('邮件通知', 'Email Notify') },
      { value: 'Windows Notify Calendar.wav', label: T('日历通知', 'Calendar Notify') },
      { value: 'Windows Foreground.wav', label: T('前台提示', 'Foreground') },
      { value: 'Windows Background.wav', label: T('后台提示', 'Background') },
      { value: 'Windows Exclamation.wav', label: T('惊叹', 'Exclamation') },
      { value: 'Windows Error.wav', label: T('错误', 'Error') },
      { value: 'Windows Critical Stop.wav', label: T('严重停止', 'Critical Stop') },
      { value: 'Windows User Account Control.wav', label: T('UAC 授权', 'UAC') },
      { value: 'Windows Hardware Insert.wav', label: T('硬件接入', 'Hardware Insert') },
      { value: 'Windows Hardware Remove.wav', label: T('硬件移除', 'Hardware Remove') },
      { value: 'Windows Logon Sound.wav', label: T('登录', 'Logon') },
      { value: 'Windows Logoff Sound.wav', label: T('注销', 'Logoff') },
      { value: 'Windows Recycle.wav', label: T('回收站', 'Recycle') },
      { value: 'Windows Ringout.wav', label: T('拨出', 'Ringout') }
    ]
    var HOST_SOUND_OPTIONS_LINUX = [
      { value: 'complete', label: T('完成 Complete', 'Complete') },
      { value: 'message', label: T('消息 Message', 'Message') },
      { value: 'bell', label: T('铃 Bell', 'Bell') },
      { value: 'dialog-information', label: T('信息 Information', 'Information') },
      { value: 'dialog-question', label: T('询问 Question', 'Question') },
      { value: 'dialog-warning', label: T('警告 Warning', 'Warning') },
      { value: 'dialog-error', label: T('错误 Error', 'Error') },
      { value: 'service-login', label: T('登录 Login', 'Login') }
    ]
    var HOST_SOUND_OPTIONS_MAC = [
      { value: 'Glass.aiff', label: T('玻璃 Glass', 'Glass') },
      { value: 'Ping.aiff', label: T('Ping', 'Ping') },
      { value: 'Pop.aiff', label: T('Pop', 'Pop') },
      { value: 'Tink.aiff', label: T('Tink', 'Tink') },
      { value: 'Sosumi.aiff', label: T('Sosumi', 'Sosumi') },
      { value: 'Hero.aiff', label: T('Hero', 'Hero') },
      { value: 'Purr.aiff', label: T('Purr', 'Purr') },
      { value: 'Basso.aiff', label: T('Basso', 'Basso') },
      { value: 'Blow.aiff', label: T('Blow', 'Blow') },
      { value: 'Frog.aiff', label: T('Frog', 'Frog') },
      { value: 'Submarine.aiff', label: T('Submarine', 'Submarine') }
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
    function ensureAudio() {
      try {
        if (audioCtx === null) {
          var AC = window.AudioContext || window.webkitAudioContext
          if (AC === undefined) return null
          audioCtx = new AC()
        }
        if (audioCtx.state === 'suspended') {
          if (resumePromise === null) {
            resumePromise = Promise.resolve(audioCtx.resume()).catch(function () {}).finally(function () { resumePromise = null })
          }
          resumePromise.then(function () {})
        }
        if (audioCtx.state !== 'running') return null
        return audioCtx
      } catch (err) { return null }
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
    function playBrowser(kind, cfg) {
      var sound = cfg.sound
      if (typeof sound === 'string' && sound.indexOf('custom:') === 0) {
        var id = sound.slice(7)
        var entry = store.audioLib[id]
        if (entry && typeof entry.url === 'string') return playCustom(entry.url, cfg.volume)
      }
      var patternKind = (sound === 'default' || sound === 'custom' || (typeof sound === 'string' && sound.indexOf('custom:') === 0)) ? kind : sound
      var spec = PATTERNS[patternKind]
      if (spec === undefined) return Promise.resolve(false)
      var pattern = Array.isArray(spec) ? spec : spec.notes
      var evVol = Array.isArray(spec) ? 1 : (typeof spec.vol === 'number' ? spec.vol : 1)
      var ac = ensureAudio()
      if (ac === null) return Promise.resolve(false)
      var v = clampVolume(cfg.volume)
      var t0 = ac.currentTime + 0.02
      for (var i = 0; i < pattern.length; i++) {
        var item = pattern[i]
        var freq = item[0]
        var start = item[1]
        var dur = item[2]
        var wave = item[3]
        var nv = item.length > 4 && typeof item[4] === 'number' ? item[4] : 1
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
        gain.connect(ac.destination)
        osc.start(t)
        osc2.start(t)
        osc.stop(t + dur + 0.3)
        osc2.stop(t + dur + 0.3)
      }
      return Promise.resolve(true)
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
      var prevRunning = new Map()
      var prevPending = new Map()
      var prevGoalPhase = new Map()
      var prevJobStatus = new Map()

      // 子代理归属：沿 parentId 链向上找到非子代理祖先（深度上限 4），失败返回自身
      function rootOfSid(byId, sid, depth) {
        if (depth > 4) return sid
        var row = byId[sid]
        if (!row) return sid
        if (row.origin !== 'subagent') return sid
        var parent = row.parentId
        if (typeof parent === 'string' && byId[parent]) return rootOfSid(byId, parent, depth + 1)
        return sid
      }

      function check() {
        var snap = sessionsList.getSnapshot()
        if (!snap || !snap.byId) return
        var byId = snap.byId
        var ids = snap.ids || []
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i]
          var row = byId[id]
          if (!row) continue

          // 回合结束：running true -> false
          var was = prevRunning.get(id)
          if (was === true && row.running === false) {
            // 有待处理交互时不判完成（等待授权/提问/评审期间结束的回合不算）
            var piNow = row.pendingInteraction
            if (!piNow) {
              if (row.origin === 'subagent') {
                var rootId = rootOfSid(byId, id, 0)
                fire('subcomplete', rootId, 'sub:' + rootId + ':' + id)
              } else {
                fire('complete', id, 'complete:' + id)
              }
            }
          }
          prevRunning.set(id, row.running === true)

          // 需要人介入：pendingInteraction 上升沿
          var pi = row.pendingInteraction
          var prevPi = prevPending.get(id)
          if (pi !== undefined && pi !== prevPi) {
            var kind = pi === 'approval' ? 'approval' : (pi === 'question' ? 'question' : 'planreview')
            fire(kind, id, 'pending:' + id + ':' + pi)
          }
          prevPending.set(id, pi)

          // 目标受阻：goal 投影进入 blocked
          var pv = row.projectionValues
          var goal = pv && typeof pv === 'object' ? pv.goal : undefined
          var phase = goal && typeof goal === 'object' ? goal.phase : undefined
          var prevPhase = prevGoalPhase.get(id)
          if (phase === 'blocked' && prevPhase !== 'blocked') {
            fire('goalblocked', id, 'goal:' + id)
          }
          prevGoalPhase.set(id, phase)
        }

        // 后台任务：status 终态
        var jobsBy = snap.jobsBySession || {}
        for (var sid in jobsBy) {
          if (!Object.prototype.hasOwnProperty.call(jobsBy, sid)) continue
          var jobs = jobsBy[sid] || []
          for (var j = 0; j < jobs.length; j++) {
            var job = jobs[j]
            if (!job || typeof job.id !== 'string') continue
            if (job.kind === 'subagent') continue
            var key = sid + ':' + job.id
            var prev = prevJobStatus.get(key)
            var terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
            if ((prev === 'running' || prev === 'stopping') && terminal) {
              if (job.status === 'failed') fire('jobfail', sid, 'job:' + key)
              else if (job.status === 'completed') fire('jobdone', sid, 'job:' + key)
            }
            prevJobStatus.set(key, job.status)
          }
        }
      }

      var offSessions = sessionsList.subscribe(check)
      var offWorkspaces = workspacesSvc.list.subscribe(function () {})
      return function () {
        offSessions()
        offWorkspaces()
      }
    }

    /* ---------------- 设置页 ---------------- */
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
        return function () { try { window.removeEventListener('focus', onFocus) } catch (e) {} }
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

      function kindRow(kind) {
        var cfg = store.kinds[kind]
        var meta = KIND_META[kind]
        var mainRow = React.createElement('div', { key: kind, className: 'snd-row' + (cfg.enabled ? '' : ' off') },
          React.createElement('span', { className: 'snd-name snd-row-name' }, meta.label),
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
          React.createElement('button', {
            type: 'button',
            className: 'snd-row-mute' + (cfg.enabled ? '' : ' off'),
            title: cfg.enabled ? (T('静音「', 'Mute “') + meta.label + T('」', '”')) : (T('开启「', 'Unmute “') + meta.label + T('」的声音', '”')),
            'aria-pressed': String(cfg.enabled),
            onClick: function () { cfg.enabled = !cfg.enabled; bump() }
          }, React.createElement('span', { className: 'snd-row-mute-icon' })),
          React.createElement('input', {
            type: 'range',
            className: 'snd-volume',
            min: 0,
            max: 100,
            step: 5,
            value: Math.round(cfg.volume * 100),
            onChange: function (e) { cfg.volume = Number(e.target.value) / 100; bump() }
          }),
          React.createElement('span', { className: 'snd-vol-val' }, Math.round(cfg.volume * 100) + '%'),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: function () { testFire(kind) } }, T('试听', 'Preview')),
          React.createElement('input', {
            ref: function (el) { fileRefs.current[kind] = el },
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: function (e) { onFilePicked(kind, e) }
          }))
        // v0.5.5：宿主蜂鸣开启时每行追加「宿主音」行——选宿主音 / 单独静音 / 宿主试听
        // （与动态版 UI 对齐；capBeep=false 时整行禁用）
        if (!(store.hostBeep === true)) return mainRow
        var hostDisabled = store.hostBeepCapable === false
        var hostMutedThis = store.hostMuted[kind] === true
        var hostRow = React.createElement('div', { key: 'host-' + kind, className: 'snd-row snd-hostrow' },
          React.createElement('span', { className: 'snd-name snd-row-name' }, T('宿主音', 'Host sound')),
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
          React.createElement('button', {
            type: 'button',
            className: 'snd-row-mute snd-hostmute' + (hostMutedThis ? ' off' : ''),
            title: hostMutedThis ? (T('开启「', 'Unmute “') + meta.label + T('」的宿主音', '” host sound')) : (T('静音「', 'Mute “') + meta.label + T('」的宿主音', '” host sound')),
            'aria-pressed': String(!hostMutedThis),
            disabled: hostDisabled ? true : undefined,
            onClick: hostDisabled ? undefined : function () {
              if (store.hostMuted[kind] === true) delete store.hostMuted[kind]
              else store.hostMuted[kind] = true
              bump()
              hostFetch('/sysset', { method: 'POST', body: JSON.stringify({ hostMuted: store.hostMuted }) }).catch(function () {})
            }
          }, React.createElement('span', { className: 'snd-row-mute-icon' })),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn',
            disabled: hostDisabled ? true : undefined,
            onClick: hostDisabled ? undefined : function () { hostBeepPreview(kind) }
          }, T('宿主试听', 'Host preview')))
        return [mainRow, hostRow]
      }

      return React.createElement('div', { className: 'snd-page' },
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('启用声音提醒', 'Enable sound alerts')),
            React.createElement('span', { className: 'snd-desc' }, T('总开关，关闭后所有事件静音', 'Master switch; all events are silent when off'))),
          switchButton(store.master, function () { store.master = !store.master; bump() })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('网页响铃', 'Browser sound')),
            React.createElement('span', { className: 'snd-desc' }, T('事件时在浏览器播放合成音（设置存浏览器）', 'Plays synthesized sounds in the browser (stored in browser)'))),
          switchButton(store.webBeep, function () { store.webBeep = !store.webBeep; bump() })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('网页通知', 'Web notifications')),
            React.createElement('span', { className: 'snd-desc' }, T('事件时弹浏览器网页通知（首次开启/试听时请求浏览器权限）', 'Shows a browser web notification on events (browser permission is requested on first enable / preview)'))),
          switchButton(store.notifyEnabled, function () {
            store.notifyEnabled = !store.notifyEnabled
            bump()
            if (store.notifyEnabled) requestNotifyPermission()
          })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('宿主蜂鸣', 'Host beep')),
            React.createElement('span', { className: 'snd-desc' }, T('事件时宿主播放系统提示音；开启后每个事件会展开「宿主音」行，可单独选声音、试听、静音', 'Plays the OS system sound on events; when on, each event expands a Host-sound row for per-event sound choice, preview, and mute'))),
          switchButton(store.hostBeep === true, function () {
            var next = !(store.hostBeep === true)
            saveHostBeep(next)
          }, store.hostBeepCapable === false)),
        KIND_GROUPS.map(function (g) {
          return React.createElement('div', { key: g.id, className: 'snd-group' },
            React.createElement('div', { className: 'snd-group-title' }, g.label),
            g.kinds.map(function (kind) { return kindRow(kind) }))
        }),
        React.createElement('div', { className: 'snd-note' },
          T('静态版 v0.5.7 · 事件检测基于会话快照，「插件授权」由宿主蜂鸣兜底，「其他打断」并入「任务完成」；宿主蜂鸣与每事件宿主音保存到宿主磁盘（%USERPROFILE%\\.dsh\\plugins\\dsh-chime-alerts\\dsh-chime-alerts-settings.json），自定义音频存浏览器（≤3MB）。', 'Static build v0.5.7 · detection uses session snapshots; plugin approval falls back to host beep and interrupts merge into completion; host beep and per-event host sounds are stored on host disk (settings.json under .dsh/plugins/dsh-chime-alerts); custom audio is stored in the browser (≤3MB).')))
    }

    /* ---------------- 工作区行内静音按钮（挂 body，同动态版） ---------------- */
    var MUTE_TOKEN = 'chime-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    var wsButtons = new Map()
    function ownerMarker() {
      try {
        if (typeof document === 'undefined') return null
        return document.getElementById('dsh-chime-alerts-ws-mute-owner')
      } catch (err) { return null }
    }
    function ownsMuteButtons() {
      try {
        var m = ownerMarker()
        if (m === null) {
          var el = document.createElement('div')
          el.id = 'dsh-chime-alerts-ws-mute-owner'
          el.style.display = 'none'
          el.dataset.token = MUTE_TOKEN
          el.dataset.ts = String(Date.now())
          document.body.appendChild(el)
          return true
        }
        if (m.dataset.token === MUTE_TOKEN) { m.dataset.ts = String(Date.now()); return true }
        if (Date.now() - Number(m.dataset.ts || 0) > 5000) { m.dataset.token = MUTE_TOKEN; m.dataset.ts = String(Date.now()); return true }
        return false
      } catch (err) { return false }
    }
    function dropMyMuteButtons() {
      for (var it = wsButtons.values(), rec = it.next(); !rec.done; rec = it.next()) {
        var row = rec.value
        if (row.hideTimer !== null) { try { row.hideTimer() } catch (e) {} }
        try { row.row.classList.remove('snd-keep-open') } catch (e) {}
        try { row.btn.remove() } catch (e) {}
      }
      wsButtons.clear()
    }
    function positionWsButton(row, btn) {
      try {
        var rect = row.getBoundingClientRect()
        btn.style.top = (rect.top + rect.height / 2 - 11) + 'px'
        btn.style.right = (window.innerWidth - rect.right + 62) + 'px'
      } catch (err) {}
    }
    function syncWorkspaceMuteButtons() {
      try {
        if (typeof document === 'undefined') return
        var titleToId = new Map()
        var items = workspaceItems()
        for (var i = 0; i < items.length; i++) {
          var it = items[i]
          if (it && typeof it.workspaceId === 'string') titleToId.set(workspaceLabelOf(it), it.workspaceId)
        }
        if (titleToId.size === 0) { dropMyMuteButtons(); return }
        if (!ownsMuteButtons()) { dropMyMuteButtons(); return }
        for (var el of document.querySelectorAll('div[role="treeitem"] .snd-ws-mute')) { try { el.remove() } catch (e) {} }
        var mineSet = new Set()
        for (var it2 = wsButtons.values(), rec2 = it2.next(); !rec2.done; rec2 = it2.next()) mineSet.add(rec2.value.btn)
        for (var el2 of document.querySelectorAll('.snd-ws-mute')) {
          if (el2.parentNode !== document.body || mineSet.has(el2)) continue
          try { el2.remove() } catch (e) {}
        }
        var rows = document.querySelectorAll('div[role="treeitem"][aria-expanded]')
        var seen = new Set()
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r]
          seen.add(row)
          var label = (row.textContent || '').trim()
          var wsId = titleToId.get(label)
          if (label === '' || wsId === undefined) continue
          var rec = wsButtons.get(row)
          if (rec === undefined) {
            var btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'snd-ws-mute'
            btn.style.position = 'fixed'
            btn.style.display = 'none'
            btn.style.zIndex = '60'
            var span = document.createElement('span')
            span.className = 'snd-ws-mute-icon'
            btn.appendChild(span)
            btn.addEventListener('click', function (e) {
              e.preventDefault()
              e.stopPropagation()
              try {
                var idx = store.muted.indexOf(wsId)
                if (idx >= 0) store.muted.splice(idx, 1)
                else store.muted.push(wsId)
                bump()
                syncWorkspaceMuteButtons()
              } catch (err) {}
            })
            document.body.appendChild(btn)
            rec = { btn: btn, label: label, id: wsId, hideTimer: null, row: row }
            wsButtons.set(row, rec)
            var cancelHide = function () {
              if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (e) {} }
              rec.hideTimer = null
            }
            var show = function () {
              cancelHide()
              btn.style.display = 'inline-flex'
              try { row.classList.add('snd-keep-open') } catch (e) {}
              positionWsButton(row, btn)
            }
            var scheduleHide = function (ms) {
              if (store.muted.indexOf(rec.id) >= 0) {
                try { row.classList.remove('snd-keep-open') } catch (e) {}
                return
              }
              cancelHide()
              rec.hideTimer = ctx.timeout(function () {
                rec.hideTimer = null
                btn.style.display = 'none'
                try { row.classList.remove('snd-keep-open') } catch (e) {}
              }, ms)
            }
            row.addEventListener('mouseenter', show)
            row.addEventListener('mouseleave', function () { scheduleHide(250) })
            btn.addEventListener('mouseenter', show)
            btn.addEventListener('mouseleave', function () { scheduleHide(200) })
          }
          var muted = store.muted.indexOf(rec.id) >= 0
          rec.btn.className = 'snd-ws-mute' + (muted ? ' off pin' : '')
          rec.btn.title = muted ? (T('已静音「', 'Muted “') + rec.label + T('」，点击恢复声音', '”, click to restore')) : (T('静音「', 'Mute “') + rec.label + T('」的声音提醒', '” sound alerts'))
          if (muted) {
            if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (e) {} }
            rec.hideTimer = null
            rec.btn.style.display = 'inline-flex'
          } else {
            rec.btn.style.display = 'none'
          }
          positionWsButton(row, rec.btn)
        }
        for (var it3 = wsButtons.entries(), rec3 = it3.next(); !rec3.done; rec3 = it3.next()) {
          var rowEl = rec3.value[0]
          var r2 = rec3.value[1]
          if (!seen.has(rowEl) || !document.body.contains(rowEl)) {
            if (r2.hideTimer !== null) { try { r2.hideTimer() } catch (e) {} }
            try { r2.row.classList.remove('snd-keep-open') } catch (e) {}
            try { r2.btn.remove() } catch (e) {}
            wsButtons.delete(rowEl)
          }
        }
      } catch (err) {}
    }

    /* ---------------- 插件主体 ---------------- */
    // timer 必须声明：apply 使用 ctx.interval/ctx.timeout（mixin 访问器内部解析
    // ctx['timer']，未声明时 fiber 代理会抛 "cannot get property "timer" without
    // inject"——静态客户端启动失败即由此而来；与动态版 client.js 的声明保持一致）。
    var inject = ['timer', 'slots', 'sessions', 'workspaces']

    function apply(ctx) {
      workspacesSvc = ctx.workspaces
      var disposeWatcher = startWatcher(ctx)
      ctx.effect(function () { return disposeWatcher })

      if (typeof document !== 'undefined') {
        ctx.interval(syncWorkspaceMuteButtons, 1200)
        ctx.timeout(syncWorkspaceMuteButtons, 1500)
        var reposition = function () {
          for (var it = wsButtons.entries(), rec = it.next(); !rec.done; rec = it.next()) positionWsButton(rec.value[0], rec.value[1].btn)
        }
        document.addEventListener('scroll', reposition, true)
        window.addEventListener('resize', reposition)
        ctx.effect(function () {
          return function () {
            try { document.removeEventListener('scroll', reposition, true) } catch (e) {}
            try { window.removeEventListener('resize', reposition) } catch (e) {}
            dropMyMuteButtons()
            var m = ownerMarker()
            if (m !== null && m.dataset.token === MUTE_TOKEN) { try { m.remove() } catch (e) {} }
          }
        })
      }

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'chime',
          order: 25,
          label: function () { return T('声音提醒', 'Sound Alerts') }
        }, SettingsPage)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
