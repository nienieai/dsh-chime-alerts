// ============================================================
// dsh-chime-alerts · 客户端半（Client half）— v0.5.8
// 动态 Cordis 插件的客户端代码（函数体，直接粘进 cordis_define 的 code.client）
// v0.4.6：新增第十个事件「插件授权」（pluginapproval，独立配置，默认短叮咚）
// v0.5.8：动态版逻辑无需改动（事件检测全在宿主半经 harness 桥 pull）；
//         本版本修的是宿主半的 DSH 0.1.5 契约漂移，动态安装自动受益。
// ============================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---- i18n：按浏览器语言自动选择中文/英文（无 navigator 时默认中文） ----
    const navLang = (typeof navigator !== 'undefined' && navigator.language) ? String(navigator.language).toLowerCase() : 'zh'
    let LANG = navLang.indexOf('zh') === 0 ? 'zh' : 'en'
    // v0.5.9：语言以 DSH locale 服务为准（navigator.language 在「英文界面 + 中文系统」下会误判）
    let localeSvc = null
    function syncLang() {
      try {
        if (localeSvc === null) return
        const snap = localeSvc.getLocale()
        if (snap !== null && snap !== undefined && typeof snap.active === 'string') {
          LANG = snap.active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
        }
      } catch (err) {}
    }
    const T = (zh, en) => (LANG === 'zh' ? zh : en)
    // locale 服务可能晚于本插件挂载：任何时机都能接上（每 1.5s 的同步会用 bindLocale 重试）
    const localeBound = false
    function bindLocale(ctx) {
      if (localeBound) return
      try {
        if (localeSvc === null && typeof ctx.get === 'function') localeSvc = ctx.get('locale')
        if (localeSvc === undefined || localeSvc === null) {
          localeSvc = (typeof ctx.locale === 'undefined') ? null : ctx.locale
        }
        if (localeSvc === null || localeSvc === undefined) return
        localeBound = true
        syncLang()
        if (typeof localeSvc.subscribe === 'function') {
          ctx.effect(() => localeSvc.subscribe(() => { syncLang(); bump() }))
        }
      } catch (err) {}
    }
    // 文案改成 getter：切换语言后无需重建对象
    function metaText(zhLabel, enLabel, zhDesc, enDesc) {
      return {
        get label() { return T(zhLabel, enLabel) },
        get desc() { return T(zhDesc, enDesc) }
      }
    }

    const KIND_META = {
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

    // 设置页分组：主要通知 / 其他通知 / 需要人介入时
    const KIND_GROUPS = [
      { id: 'main', get label() { return T('主要通知', 'Primary notifications') }, kinds: ['complete', 'subcomplete', 'jobdone'] },
      { id: 'other', get label() { return T('其他通知', 'Other notifications') }, kinds: ['jobfail', 'interrupt'] },
      { id: 'human', get label() { return T('需要人介入时', 'Human action needed') }, kinds: ['approval', 'pluginapproval', 'question', 'planreview', 'goalblocked'] }
    ]

    // 事件顺序（与分组一致；批量操作与计数按此遍历）
    const KIND_ORDER = ['complete', 'subcomplete', 'jobdone', 'jobfail', 'interrupt', 'approval', 'pluginapproval', 'question', 'planreview', 'goalblocked']
    const VERSION_TEXT = T('动态版 v0.5.8', 'Dynamic build v0.5.8')

    const store = {
      master: true,
      webBeep: true,
      hostBeep: false,
      notifyEnabled: true,
      muted: [],
      audioLib: {},
      hostSounds: {},
      hostMuted: {},
      platform: null,
      capBeep: null,
      notifyCap: null,
      localDir: null,
      saveError: null,
      kinds: {
        complete: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        subcomplete: { enabled: false, sound: 'default', volume: 1, customUrl: null, customName: null },
        jobdone: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        approval: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        pluginapproval: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        question: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        planreview: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        goalblocked: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        interrupt: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        jobfail: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null }
      }
    }

    // v0.4.1：通知能力（浏览器 Notification API 缺失时桌面通知开关禁用）
    store.notifyCap = (typeof Notification !== 'undefined')

    // ---- 设置持久化（Web UI 的 localStorage，按 origin 存储；自定义音频文件过大不入库） ----
    // v0.3.5 存储键改为 dsh-chime-alerts-v1；旧键 dsh-chime-v1 / dsh-sound-alerts-v1 存在时自动迁移一次
    const STORE_KEY = 'dsh-chime-alerts-v1'
    const LEGACY_STORE_KEY = 'dsh-chime-v1'
    const OLD_LEGACY_STORE_KEY = 'dsh-sound-alerts-v1'
    function loadStore() {
      try {
        if (typeof localStorage === 'undefined') return
        let raw = localStorage.getItem(STORE_KEY)
        if (!raw) {
          raw = localStorage.getItem(LEGACY_STORE_KEY)
          if (!raw) raw = localStorage.getItem(OLD_LEGACY_STORE_KEY)
          if (raw) { try { localStorage.setItem(STORE_KEY, raw) } catch (err) {} }
        }
        if (!raw) return
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object') return
        if (typeof saved.master === 'boolean') store.master = saved.master
        // v0.3.11：网页响铃独立存浏览器；旧 sysMode 作为一次性迁移源（auto/both→网页开；off→关）
        if (typeof saved.webBeep === 'boolean') store.webBeep = saved.webBeep
        else if (saved.sysMode === 'off') store.webBeep = false
        // v0.3.8：旧 sysMode 读取仅作迁移源（宿主 hostBeep）
        if (saved.sysMode === 'auto' || saved.sysMode === 'both' || saved.sysMode === 'off' || saved.sysMode === 'always') store.sysMode = saved.sysMode
        // v0.3.2：旧的独立「宿主常驻蜂鸣」开关并入迁移（always→宿主蜂鸣开）
        if (saved.alwaysBeep === true) store.sysMode = 'always'
        if (typeof saved.notifyEnabled === 'boolean') store.notifyEnabled = saved.notifyEnabled
        if (Array.isArray(saved.muted)) store.muted = saved.muted.filter((s) => typeof s === 'string')
        if (saved.kinds && typeof saved.kinds === 'object') {
          for (const kind of Object.keys(store.kinds)) {
            const k = saved.kinds[kind]
            if (!k || typeof k !== 'object') continue
            if (typeof k.enabled === 'boolean') store.kinds[kind].enabled = k.enabled
            if (typeof k.sound === 'string') store.kinds[kind].sound = k.sound
            if (typeof k.volume === 'number' && isFinite(k.volume)) store.kinds[kind].volume = Math.max(0, Math.min(1, k.volume))
          }
        }
      } catch (err) {}
    }
    function persist() {
      try {
        if (typeof localStorage === 'undefined') return
        const kinds = {}
        for (const kind of Object.keys(store.kinds)) {
          const k = store.kinds[kind]
          kinds[kind] = { enabled: k.enabled, sound: k.sound, volume: k.volume }
        }
        // v0.3.11：网页响铃存浏览器；宿主蜂鸣（hostBeep）与自定义音频存宿主本地
        localStorage.setItem(STORE_KEY, JSON.stringify({ master: store.master, webBeep: store.webBeep, notifyEnabled: store.notifyEnabled, muted: store.muted.slice(), kinds }))
      } catch (err) {}
    }
    loadStore()
    // ---- 从宿主加载设置（宿主蜂鸣开关 hostBeep）与音频库；旧 localStorage sysMode 作为一次性迁移 ----
    const migratedSys = store.sysMode
    host.call('sysget').then((res) => {
      try {
        if (res !== null && typeof res === 'object' && typeof res.hostBeep === 'boolean') {
          store.hostBeep = res.hostBeep
        } else {
          // 宿主无记录：旧 sysMode → hostBeep（auto/both/always→开；off→关）一次性迁移
          const map = { auto: false, both: true, always: true, off: false }
          if (migratedSys in map) {
            store.hostBeep = map[migratedSys]
            host.call('sysset', { hostBeep: store.hostBeep }).catch(() => {})
          }
        }
        if (res !== null && typeof res === 'object' && typeof res.dir === 'string') store.localDir = res.dir
        // v0.4.0：宿主平台（决定宿主音选项列表 win32/linux/darwin）
        if (res !== null && typeof res === 'object' && typeof res.platform === 'string') store.platform = res.platform
        // v0.4.1：宿主响铃能力（false 时宿主蜂鸣相关控件禁用变灰）
        if (res !== null && typeof res === 'object' && typeof res.capBeep === 'boolean') store.capBeep = res.capBeep
        // v0.4.2：每事件宿主音独立静音（hostMuted）
        if (res !== null && typeof res === 'object' && res.hostMuted !== null && typeof res.hostMuted === 'object') {
          const hm = {}
          for (const k of Object.keys(store.kinds)) {
            if (res.hostMuted[k] === true) hm[k] = true
          }
          store.hostMuted = hm
        }
        // v0.3.20：加载每事件宿主音选择（hostSounds，缺失用默认）
        if (res !== null && typeof res === 'object' && res.hostSounds !== null && typeof res.hostSounds === 'object') {
          const hs = {}
          for (const k of Object.keys(hostSoundDefaults())) {
            if (typeof res.hostSounds[k] === 'string' && res.hostSounds[k] !== '') hs[k] = res.hostSounds[k]
          }
          store.hostSounds = hs
        }
        // 加载音频库（所有事件下拉共享）并恢复已选音频
        host.call('loadall').then((lr) => {
          try {
            if (lr !== null && typeof lr === 'object' && lr.ok === true && Array.isArray(lr.list)) {
              for (const item of lr.list) {
                if (item !== null && typeof item === 'object' && typeof item.id === 'string' && !store.audioLib[item.id]) {
                  store.audioLib[item.id] = { name: typeof item.name === 'string' && item.name ? item.name : 'custom', url: null }
                }
              }
              for (const kind of Object.keys(store.kinds)) {
                const s = store.kinds[kind].sound
                if (typeof s === 'string' && s.indexOf('custom:') === 0) {
                  const id = s.slice(7)
                  if (store.audioLib[id] !== undefined && store.audioLib[id].url === null) loadAudioUrl(id)
                }
              }
              bump()
            }
          } catch (err) {}
        }).catch(() => {})
        bump()
      } catch (err) {}
    }).catch(() => {})

    // ---- 自定义音频本地化（v0.3.8）：经宿主 fs 存磁盘；v0.3.11 改为音频库（所有事件下拉共享） ----
    const objectUrls = []
    function revokeCustomUrls() {
      for (const u of objectUrls) { try { URL.revokeObjectURL(u) } catch (err) {} }
      objectUrls.length = 0
    }
    function base64ToBlobUrl(base64, mime) {
      try {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blob = new Blob([bytes], { type: mime || 'audio/*' })
        const url = URL.createObjectURL(blob)
        objectUrls.push(url)
        return url
      } catch (err) { return null }
    }
    function loadAudioUrl(id) {
      host.call('loadaudio', { id }).then((res) => {
        try {
          if (res === null || typeof res !== 'object' || res.ok !== true || typeof res.base64 !== 'string') return
          const url = base64ToBlobUrl(res.base64)
          if (url === null) return
          if (!store.audioLib[id]) store.audioLib[id] = { name: 'custom', url: null }
          store.audioLib[id].url = url
          if (typeof res.name === 'string' && res.name) store.audioLib[id].name = res.name
          bump()
        } catch (err) {}
      }).catch(() => {})
    }
    function saveAudioToLib(base64, name) {
      return host.call('saveaudio', { base64, name }).then((res) => {
        if (res !== null && typeof res === 'object' && res.ok === true && typeof res.id === 'string') {
          store.audioLib[res.id] = { name: name || 'custom', url: null }
          store.saveError = null
          return res.id
        }
        store.saveError = T('音频保存到本地失败（' + ((res && res.reason) || 'unknown') + '）', 'Failed to save audio locally (' + ((res && res.reason) || 'unknown') + ')')
        return null
      }).catch(() => {
        store.saveError = T('音频保存到本地失败（no-fs）', 'Failed to save audio locally (no-fs)')
        return null
      })
    }
    ctx.effect(() => () => { revokeCustomUrls() })

    // ---- 工作区映射（sessionId → 工作区标题；用于按工作区静音与行内按钮） ----
    let workspacesSvc = null
    try {
      localeSvc = (typeof ctx.get === 'function') ? ctx.get('locale') : (ctx.locale !== undefined ? ctx.locale : null)
      syncLang()
      if (localeSvc !== null && localeSvc !== undefined && typeof localeSvc.subscribe === 'function') {
        ctx.effect(() => localeSvc.subscribe(() => { syncLang(); bump() }))
      }
      const ws = ctx.get('workspaces')
      if (ws !== undefined && ws !== null && ws.list !== undefined) workspacesSvc = ws
    } catch (err) {}
    function workspaceItems() {
      try {
        if (workspacesSvc === null) return []
        const snap = workspacesSvc.list.getSnapshot()
        return snap && Array.isArray(snap.items) ? snap.items : []
      } catch (err) { return [] }
    }
    function workspaceLabelOf(item) {
      return item && typeof item.title === 'string' && item.title ? item.title : String(item.workspaceId)
    }
    function labelOfSession(sessionId) {
      if (sessionId === null || sessionId === undefined) return null
      for (const it of workspaceItems()) {
        if (it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0) return workspaceLabelOf(it)
      }
      return null
    }
    function idOfSession(sessionId) {
      if (sessionId === null || sessionId === undefined) return null
      for (const it of workspaceItems()) {
        if (it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sessionId) >= 0) {
          return it && typeof it.workspaceId === 'string' ? it.workspaceId : null
        }
      }
      return null
    }

    // v0.3.6：muted 由工作区标题迁移为 workspaceId（工作区改名/重名不再失效）
    function migrateMutedIds() {
      try {
        const items = workspaceItems()
        if (items.length === 0) return
        let changed = false
        const out = []
        for (const m of store.muted) {
          if (items.some((it) => it.workspaceId === m)) { out.push(m); continue }
          const byTitle = items.find((it) => workspaceLabelOf(it) === m)
          if (byTitle !== undefined && typeof byTitle.workspaceId === 'string') {
            out.push(byTitle.workspaceId)
            changed = true
          }
        }
        if (changed) { store.muted = out; bump() }
      } catch (err) {}
    }
    migrateMutedIds()

    const storeListeners = new Set()
    function bump() { persist(); const list = Array.from(storeListeners); for (const fn of list) fn() }
    function useVersion() {
      const [v, setV] = React.useState(0)
      React.useEffect(() => {
        const fn = () => setV((x) => x + 1)
        storeListeners.add(fn)
        return () => { storeListeners.delete(fn) }
      }, [])
      return v
    }

    // v0.3.19：音量回调（基音 0.55→0.45、泛音 0.26→0.22，消除大音量下的波形叠加杂音），
    // 子任务单独低调（vol 0.6）；每个声音有名字（见 SOUND_OPTIONS）。其余维度保持 v0.3.18。
    const PATTERNS = {
      complete: { notes: [[523.25, 0, 0.1, 'sine', 0.6], [659.25, 0.12, 0.1, 'sine', 0.75], [783.99, 0.26, 0.12, 'triangle', 0.9], [1046.5, 0.42, 0.85, 'sine', 1]] },
      subcomplete: { vol: 0.6, notes: [[783.99, 0, 0.4, 'sine', 1]] },
      jobdone: { vol: 0.5, notes: [[392, 0, 0.12, 'sine', 1], [523.25, 0.14, 0.12, 'sine', 0.8], [783.99, 0.28, 0.5, 'triangle', 0.55]] },
      approval: { notes: [[880, 0, 0.28, 'sine', 0.8], [659.25, 0.34, 0.75, 'triangle', 1]] },
      // v0.4.6：插件授权独立事件——门铃的紧凑变体（两短一长，音色区分「需要授权」）
      pluginapproval: { notes: [[880, 0, 0.16, 'sine', 0.7], [880, 0.2, 0.12, 'sine', 0.6], [659.25, 0.36, 0.6, 'triangle', 1]] },
      question: { notes: [[523.25, 0, 0.16, 'sine', 0.7], [783.99, 0.22, 0.55, 'triangle', 1]] },
      planreview: { notes: [[987.77, 0, 0.12, 'triangle', 0.85], [783.99, 0.14, 0.12, 'sine', 0.7], [523.25, 0.28, 0.5, 'sine', 0.55]] },
      goalblocked: { notes: [[349.23, 0, 0.2, 'triangle', 0.9], [349.23, 0.22, 0.2, 'sine', 0.9], [261.63, 0.44, 0.7, 'sine', 1]] },
      interrupt: { notes: [[880, 0, 0.28, 'sine', 1], [440, 0.32, 0.12, 'triangle', 0.8]] },
      jobfail: { vol: 0.5, notes: [[1046.5, 0, 0.1, 'sine', 1], [698.46, 0.12, 0.1, 'sine', 0.75], [493.88, 0.24, 0.5, 'triangle', 0.5]] }
    }

    let audioCtx = null
    let resumePromise = null

    async function ensureAudio() {
      try {
        if (audioCtx === null) {
          const AC = window.AudioContext || window.webkitAudioContext
          if (AC === undefined) return null
          audioCtx = new AC()
        }
        if (audioCtx.state === 'suspended') {
          if (resumePromise === null) {
            resumePromise = Promise.resolve(audioCtx.resume()).catch(() => {}).finally(() => { resumePromise = null })
          }
          await resumePromise
        }
        if (audioCtx.state !== 'running') return null
        return audioCtx
      } catch (err) {
        return null
      }
    }

    function clampVolume(v) { return Math.max(0, Math.min(1, v)) }

    function playCustom(url, volume) {
      return new Promise((resolve) => {
        try {
          const audio = new Audio(url)
          audio.volume = clampVolume(volume)
          const p = audio.play()
          if (p && typeof p.then === 'function') p.then(() => resolve(true), () => resolve(false))
          else resolve(true)
        } catch (err) {
          resolve(false)
        }
      })
    }

    async function playBrowser(kind, cfg) {
      const sound = cfg.sound
      // v0.3.11 音频库：custom:<id> 从库加载（无缓存时按需拉取）
      if (typeof sound === 'string' && sound.indexOf('custom:') === 0) {
        const id = sound.slice(7)
        let url = store.audioLib[id] !== undefined ? store.audioLib[id].url : null
        if (url === null) {
          const res = await host.call('loadaudio', { id }).catch(() => null)
          if (res !== null && typeof res === 'object' && res.ok === true && typeof res.base64 === 'string') {
            url = base64ToBlobUrl(res.base64)
            if (url !== null) {
              if (!store.audioLib[id]) store.audioLib[id] = { name: 'custom', url: null }
              store.audioLib[id].url = url
              if (typeof res.name === 'string' && res.name) store.audioLib[id].name = res.name
            }
          }
        }
        if (url !== null) return playCustom(url, cfg.volume)
      }
      // 自定义音频缺失（旧格式 custom 无 id / 库中已删）：降级为本事件默认音，避免静默降级成系统蜂鸣
      const patternKind = (sound === 'default' || sound === 'custom' || (typeof sound === 'string' && sound.indexOf('custom:') === 0)) ? kind : sound
      const spec = PATTERNS[patternKind]
      if (spec === undefined) return false
      const pattern = Array.isArray(spec) ? spec : spec.notes
      const evVol = Array.isArray(spec) ? 1 : (typeof spec.vol === 'number' ? spec.vol : 1)
      const ac = await ensureAudio()
      if (ac === null) return false
      const v = clampVolume(cfg.volume)
      const t0 = ac.currentTime + 0.02
      // 每个音符 = 基音 + 2 倍频泛音：起音快而轻（12ms），衰减带 0.25s 自然余韵（铃感）。
      // v0.3.15：音量提升；v0.3.18：加大（0.45→0.55）+ 每音音量因子 + 事件整体音量；
      // v0.3.19：回调到 0.45/0.22（消除大音量波形叠加杂音）。
      for (const item of pattern) {
        const freq = item[0]
        const start = item[1]
        const dur = item[2]
        const wave = item[3]
        const nv = item.length > 4 && typeof item[4] === 'number' ? item[4] : 1
        const t = t0 + start
        const gain = ac.createGain()
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.45 * v * evVol * nv, t + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25)
        const osc = ac.createOscillator()
        osc.type = wave
        osc.frequency.value = freq
        osc.connect(gain)
        const osc2 = ac.createOscillator()
        osc2.type = 'sine'
        osc2.frequency.value = freq * 2
        const gain2 = ac.createGain()
        gain2.gain.value = 0.22
        osc2.connect(gain2)
        gain2.connect(gain)
        gain.connect(ac.destination)
        osc.start(t)
        osc2.start(t)
        osc.stop(t + dur + 0.3)
        osc2.stop(t + dur + 0.3)
      }
      return true
    }

    function sysBeep(kind) {
      try { host.call('sysbeep', { kind }).catch(() => {}) } catch (err) {}
    }

    // ---- 桌面通知（浏览器 Notification API；与声音同源触发，同类事件用 tag 合并） ----
    function requestNotifyPermission() {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') {
          const p = Notification.requestPermission()
          if (p && typeof p.catch === 'function') p.catch(() => {})
        }
      } catch (err) {}
    }
    function notify(kind, wsLabel) {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission !== 'granted') return
        const meta = KIND_META[kind]
        if (meta === undefined) return
        const body = (wsLabel !== null && wsLabel !== undefined ? (T('工作区「', 'Workspace “') + wsLabel + T('」：', '”: ')) : '') + (meta.desc || '')
        const n = new Notification(meta.label + T(' · 声音提醒', ' · Sound alert'), { body, tag: 'dsh-chime-alerts:' + kind, silent: true })
        try {
          n.onclick = () => { try { window.focus() } catch (err) {}; try { n.close() } catch (err) {} }
        } catch (err) {}
      } catch (err) {}
    }

    // ---- 多 tab 领导锁：同页多个实例（多标签页）时只有 leader 播放，防双响 ----
    // localStorage 里存 token:时间戳；leader 每次 tick 刷新自己的时间戳，
    // 其他 tab 发现时间戳超过 8s 未刷新则接管；自己写的 token 视为仍在任。
    const LEADER_KEY = 'dsh-chime-alerts-leader'
    const LEADER_TOKEN = 'chime-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    function amLeader() {
      try {
        const now = Date.now()
        const raw = localStorage.getItem(LEADER_KEY)
        if (raw === null) {
          localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now)
          return true
        }
        const colon = raw.indexOf(':')
        const token = colon < 0 ? '' : raw.slice(0, colon)
        const ts = Number(colon < 0 ? raw : raw.slice(colon + 1)) || 0
        if (token === LEADER_TOKEN) {
          localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now)
          return true
        }
        if (now - ts > 8000) {
          localStorage.setItem(LEADER_KEY, LEADER_TOKEN + ':' + now)
          return true
        }
        return false
      } catch (err) {
        return true
      }
    }

    function fire(kind, wsLabel) {
      if (!store.master) return
      const cfg = store.kinds[kind]
      if (cfg === undefined || !cfg.enabled) return
      if (store.notifyEnabled) notify(kind, wsLabel)
      // v0.3.11：网页响铃（浏览器合成音）与宿主蜂鸣（系统音）两个独立开关。
      // hostBeep 开启时宿主在 record() 时已直接系统蜂鸣（页面关闭也响），客户端不再重复调用 sysbeep。
      if (store.webBeep) playBrowser(kind, cfg).catch(() => {})
    }

    // v0.3.20：浏览器试听与宿主试听分离——浏览器试听只播浏览器合成音；
    // 宿主试听单独由第二行「宿主试听」按钮调用 sysbeep（不受宿主蜂鸣开关影响）
    function testFire(kind) {
      const cfg = store.kinds[kind]
      if (cfg === undefined) return
      requestNotifyPermission()
      if (store.webBeep) playBrowser(kind, cfg).catch(() => {})
    }
    function hostBeepPreview(kind) {
      try { host.call('sysbeep', { kind }).catch(() => {}) } catch (err) {}
    }

    let lastSeq = 0
    let myBoot = null
    let inFlight = false

    function tick() {
      if (inFlight) return
      inFlight = true
      const leader = amLeader()
      // v0.3.8：固定监听所有会话（范围控制交给工作区静音按钮）
      Promise.resolve(host.call('pull', { sessionId: null, after: lastSeq }))
        .then((res) => {
          if (res === null || typeof res !== 'object') return
          if (typeof res.boot === 'string' && res.boot !== myBoot) {
            myBoot = res.boot
            lastSeq = 0
          }
          const evs = Array.isArray(res.events) ? res.events : []
          for (const ev of evs) {
            if (typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq
            if (ev === null || typeof ev !== 'object' || typeof ev.kind !== 'string') continue
            if (typeof ev.at !== 'number' || Date.now() - ev.at > 15000) continue
            const wsId = idOfSession(ev.sessionId)
            if (wsId !== null && store.muted.indexOf(wsId) >= 0) continue
            const wsLabel = labelOfSession(ev.sessionId)
            // 非 leader tab 只推进序号不播放（避免多标签页双响）
            if (leader) fire(ev.kind, wsLabel)
          }
          if (typeof res.seq === 'number' && res.seq > lastSeq) lastSeq = res.seq
        })
        .catch(() => {})
        .finally(() => { inFlight = false })
    }

    ctx.interval(tick, 700)
    ctx.timeout(tick, 800)
    // 工作区标题旁标记的同步（置后：不改动既有 interval 的注册顺序）
    // 覆盖层标记：定时与滚动/尺寸变化时只更新坐标（不插入 React 子树，天然不闪）
    ctx.interval(() => { bindLocale(ctx); syncWorkspaceMarks() }, 800)

    // 侧栏滚动 / 窗口尺寸变化：只重算坐标（覆盖层节点不重建，不会闪）
    const onReflow = () => { try { syncWorkspaceMarks() } catch (err) {} }
    // 鼠标进出工作区行：立刻重算（悬停会改变行内布局）
    let hoverTimer = null
    const onHover = () => {
      if (hoverTimer !== null) return
      hoverTimer = setTimeout(() => { hoverTimer = null; try { syncWorkspaceMarks() } catch (err) {} }, 60)
    }
    try {
      document.addEventListener('mouseover', onHover, true)
      document.addEventListener('mouseout', onHover, true)
    } catch (err) {}
    ctx.effect(() => () => {
      try { document.removeEventListener('mouseover', onHover, true) } catch (err) {}
      try { document.removeEventListener('mouseout', onHover, true) } catch (err) {}
      if (hoverTimer !== null) clearTimeout(hoverTimer)
    })
    try {
      document.addEventListener('scroll', onReflow, true)
      window.addEventListener('resize', onReflow)
    } catch (err) {}
    ctx.effect(() => () => {
      try { document.removeEventListener('scroll', onReflow, true) } catch (err) {}
      try { window.removeEventListener('resize', onReflow) } catch (err) {}
      teardownOverlay()
    })
    ctx.timeout(() => { bindLocale(ctx); syncWorkspaceMarks() }, 1200)

    // v0.3.19：每个声音起了名字（中文/英文），音量整体回调到 0.45 消除杂音
    const SOUND_OPTIONS = [
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
    // v0.3.20：每个事件的默认音名称（下拉「默认」选项显示实际会响的声音名）
    const DEFAULT_SOUND_LABEL = {
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
    // v0.3.20：宿主音每事件可配置——系统 wav 列表（与宿主 DEFAULT_WAV 一致）+ 可选音色
    // v0.4.0：宿主音默认值与选项按平台——win32 系统 wav / linux freedesktop 主题音 / darwin 系统音
    const DEFAULT_HOST_SOUND_BY_PLATFORM = {
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
    const HOST_SOUND_OPTIONS = [
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
    // freedesktop 声音主题 id（canberra-gtk-play --id=… / /usr/share/sounds/freedesktop/stereo/<id>.oga）
    const HOST_SOUND_OPTIONS_LINUX = [
      { value: 'complete', label: T('完成 Complete', 'Complete') },
      { value: 'message', label: T('消息 Message', 'Message') },
      { value: 'bell', label: T('铃 Bell', 'Bell') },
      { value: 'dialog-information', label: T('信息 Information', 'Information') },
      { value: 'dialog-question', label: T('询问 Question', 'Question') },
      { value: 'dialog-warning', label: T('警告 Warning', 'Warning') },
      { value: 'dialog-error', label: T('错误 Error', 'Error') },
      { value: 'service-login', label: T('登录 Login', 'Login') }
    ]
    // macOS 系统音（/System/Library/Sounds/*.aiff）
    const HOST_SOUND_OPTIONS_MAC = [
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
    // v0.3.11 音频库：内置选项 + 所有已导入音频（每个下拉都可见可选）；
    // v0.3.20：「默认」选项显示该事件默认声音的名称
    function soundOptionList(kind) {
      const list = [{ value: 'default', label: (DEFAULT_SOUND_LABEL[kind] !== undefined ? DEFAULT_SOUND_LABEL[kind] : T('默认', 'Default')) }]
      for (const o of SOUND_OPTIONS) list.push(o)
      for (const id of Object.keys(store.audioLib)) {
        list.push({ value: 'custom:' + id, label: T('自定义声音 · ', 'Custom sound · ') + store.audioLib[id].name })
      }
      return list
    }

    /* ---------------- 设置页（V3：折叠分组 + 事件卡片 + 双主题 token） ---------------- */
    const UI = { closed: {}, diagOpen: false }

    /* ---- 悬浮提示（自绘；与静态版一致） ---- */
    const TIP = { node: null, timer: null }
    function tipNode() {
      if (TIP.node !== null) return TIP.node
      try {
        const d = document.createElement('div')
        d.className = 'snd-tip'
        document.body.appendChild(d)
        TIP.node = d
      } catch (err) { TIP.node = null }
      return TIP.node
    }
    function hideTip() {
      if (TIP.timer !== null) { try { clearTimeout(TIP.timer) } catch (e) {} TIP.timer = null }
      if (TIP.node !== null) TIP.node.classList.remove('on')
    }
    function showTip(anchor, text) {
      const n = tipNode()
      if (n === null || !anchor || typeof anchor.getBoundingClientRect !== 'function') return
      n.textContent = text
      n.classList.remove('on')
      const r = anchor.getBoundingClientRect()
      n.style.left = '0px'
      n.style.top = '0px'
      const w = n.offsetWidth
      const h = n.offsetHeight
      let left = r.left + r.width / 2 - w / 2
      const maxLeft = (window.innerWidth || 1024) - w - 6
      if (left > maxLeft) left = maxLeft
      if (left < 6) left = 6
      let top = r.top - h - 7
      if (top < 6) top = r.bottom + 7
      n.style.left = left + 'px'
      n.style.top = top + 'px'
      requestAnimationFrame(() => { if (TIP.node !== null) TIP.node.classList.add('on') })
    }
    function scheduleTip(anchor, text) {
      if (TIP.timer !== null) { try { clearTimeout(TIP.timer) } catch (e) {} }
      TIP.timer = setTimeout(() => { TIP.timer = null; showTip(anchor, text) }, 180)
    }
    function tipProps(text) {
      return {
        onMouseEnter: (e) => scheduleTip(e.currentTarget, text),
        onMouseLeave: hideTip,
        onFocus: (e) => showTip(e.currentTarget, text),
        onBlur: hideTip
      }
    }

    /* ---- 图标 ---- */
    const BELL_PATH = 'M12 3a6 6 0 0 0-6 6v4l-2 3v1h16v-1l-2-3V9a6 6 0 0 0-6-6zm0 17.5a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 20.5z'
    const SLASH_PATH = 'M4.5 4.5l15 15'
    const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    const ICON_BELL = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/></svg>'
    const ICON_BELL_OFF = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-base,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-base,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
         '<path d="' + SLASH_PATH + '" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>'

    function switchButton(checked, onToggle, disabled) {
      const dis = disabled === true
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

    function iconButton(icon, label, onClick, extraClass, disabled) {
      const dis = disabled === true
      const props = {
        type: 'button',
        className: 'snd-ib' + (extraClass ? ' ' + extraClass : ''),
        disabled: dis ? true : undefined,
        onClick: dis ? undefined : (e) => { hideTip(); if (typeof onClick === 'function') onClick(e) },
        dangerouslySetInnerHTML: { __html: icon }
      }
      Object.assign(props, tipProps(label))
      return React.createElement('button', props)
    }

    function SettingsPage() {
      useVersion()
      const fileRefs = React.useRef({})
      const pendingPick = React.useRef({})

      // 自定义声音经「声音」下拉的「自定义声音…」项上传；取消时 focus 事件把下拉复位。
      React.useEffect(() => {
        const onFocus = () => {
          let need = false
          for (const kind of Object.keys(pendingPick.current)) {
            if (pendingPick.current[kind]) {
              pendingPick.current[kind] = false
              need = true
              const k = store.kinds[kind]
              if (k !== undefined && k.customUrl) k.sound = 'custom'
            }
          }
          if (need) bump()
        }
        try { window.addEventListener('focus', onFocus) } catch (err) {}
        return () => {
          try { window.removeEventListener('focus', onFocus) } catch (err) {}
          hideTip()
        }
      }, [])

      function openUpload(kind) {
        const el = fileRefs.current[kind]
        if (!el) return
        pendingPick.current[kind] = true
        try { el.click() } catch (err) {}
      }

      function onFilePicked(kind, e) {
        pendingPick.current[kind] = false
        const file = e.target && e.target.files && e.target.files[0]
        if (e.target) e.target.value = ''
        if (!file) return
        if (file.size > 5 * 1024 * 1024) return
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const dataUrl = reader.result
            if (typeof dataUrl !== 'string') return
            const comma = dataUrl.indexOf(',')
            const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
            saveAudioToLib(b64, file.name).then((id) => {
              if (id !== null) { store.kinds[kind].sound = 'custom:' + id; bump() }
            })
          } catch (err) {}
        }
        reader.readAsDataURL(file)
      }

      function enabledCount() {
        let n = 0
        for (const kind of KIND_ORDER) if (store.kinds[kind].enabled) n += 1
        return n
      }

      function setAll(v) {
        for (const kind of KIND_ORDER) store.kinds[kind].enabled = v
        bump()
      }

      function resetDefaults() {
        for (const kind of KIND_ORDER) {
          store.kinds[kind] = { enabled: kind !== 'subcomplete', sound: 'default', volume: 1, customUrl: null, customName: null }
        }
        store.master = true
        store.webBeep = true
        store.notifyEnabled = false
        UI.closed = {}
        bump()
      }

      function chip(key, label, on, onClick, disabled) {
        const dis = disabled === true
        return React.createElement('button', {
          type: 'button',
          className: 'snd-chip' + (on ? ' on' : '') + (dis ? ' dis' : ''),
          'data-chip': key,
          disabled: dis ? true : undefined,
          onClick: dis ? undefined : onClick
        },
          React.createElement('span', { className: 'snd-chip-dot' }),
          React.createElement('span', null, label),
          React.createElement('span', { className: 'snd-chip-state' }, on ? T('开', 'On') : T('关', 'Off')))
      }

      function hostRow(kind) {
        if (!store.hostBeep) return null
        const hostDisabled = store.capBeep === false
        const muted = store.hostMuted[kind] === true
        return React.createElement('div', { className: 'snd-hostrow' },
          React.createElement('span', { className: 'snd-host-label' }, T('宿主音', 'Host')),
          React.createElement('div', { className: 'snd-select-wrap' },
            React.createElement('select', {
              className: 'snd-select snd-host-select',
              value: store.hostSounds[kind] || hostSoundDefaults()[kind],
              disabled: hostDisabled ? true : undefined,
              onChange: (e) => {
                store.hostSounds[kind] = e.target.value
                bump()
                host.call('sysset', { hostSounds: store.hostSounds }).catch(() => {})
              }
            }, hostSoundOptions().map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))),
          iconButton(muted ? ICON_BELL_OFF : ICON_BELL,
            muted ? T('已静音 · 点击恢复', 'Muted · click to restore') : T('静音（只影响这一个事件）', 'Mute this event only'),
            hostDisabled ? undefined : () => {
              if (store.hostMuted[kind] === true) delete store.hostMuted[kind]
              else store.hostMuted[kind] = true
              bump()
              host.call('sysset', { hostMuted: store.hostMuted }).catch(() => {})
            },
            'snd-hostmute' + (muted ? ' off' : '')),
          iconButton(ICON_PLAY, T('试听宿主系统音', 'Preview host sound'),
            hostDisabled ? undefined : () => hostBeepPreview(kind), 'play snd-hostpreview', hostDisabled))
      }

      function card(kind) {
        const cfg = store.kinds[kind]
        const meta = KIND_META[kind]
        return React.createElement('div', { key: kind, className: 'snd-row' + (cfg.enabled ? '' : ' off') },
          React.createElement('div', { className: 'snd-row-hd' },
            React.createElement('span', { className: 'snd-row-name' }, meta.label),
            cfg.enabled ? null : React.createElement('span', { className: 'snd-badge' }, T('静音', 'Muted')),
            React.createElement('span', { className: 'snd-grow' }),
            switchButton(cfg.enabled, () => { cfg.enabled = !cfg.enabled; bump() })),
          React.createElement('div', { className: 'snd-desc' }, meta.desc),
          React.createElement('div', { className: 'snd-row-bd' },
            React.createElement('div', { className: 'snd-select-wrap' },
              React.createElement('select', {
                className: 'snd-select',
                value: cfg.sound,
                onChange: (e) => {
                  if (e.target.value === 'custom') { openUpload(kind); return }
                  cfg.sound = e.target.value
                  bump()
                }
              }, soundOptionList(kind).map((o) => React.createElement('option', { key: o.value, value: o.value },
                o.value === 'custom' ? T('自定义声音…', 'Custom sound…') : o.label)))),
            iconButton(ICON_PLAY, T('试听网页音', 'Preview browser sound'), () => testFire(kind), 'play')),
          // 音量常驻可见（与静态版一致：折叠隐藏会让人以为功能消失）
          React.createElement('div', { className: 'snd-vol' },
            React.createElement('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(cfg.volume * 100),
              onChange: (e) => { cfg.volume = Number(e.target.value) / 100; bump() }
            }),
            React.createElement('span', { className: 'snd-vol-val' }, Math.round(cfg.volume * 100) + '%')),
          hostRow(kind),
          React.createElement('input', {
            ref: (el) => { fileRefs.current[kind] = el },
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: (e) => onFilePicked(kind, e)
          }))
      }

      function group(g) {
        const closed = UI.closed[g.id] === true
        let on = 0
        for (const kind of g.kinds) if (store.kinds[kind].enabled) on += 1
        const hd = React.createElement('div', {
          className: 'snd-grp-hd',
          onClick: () => { UI.closed[g.id] = !closed; bump() }
        },
          React.createElement('span', { className: 'snd-grp-caret' }, '▾'),
          React.createElement('span', { className: 'snd-grp-name' }, g.label),
          React.createElement('span', { className: 'snd-grp-count' }, on + '/' + g.kinds.length),
          React.createElement('span', { className: 'snd-grow' }),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: (e) => {
              e.stopPropagation()
              for (const kind of g.kinds) store.kinds[kind].enabled = true
              bump()
            }
          }, T('本组全开', 'All on')),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: (e) => {
              e.stopPropagation()
              for (const kind of g.kinds) store.kinds[kind].enabled = false
              bump()
            }
          }, T('本组全关', 'All off')),
          React.createElement('button', {
            type: 'button',
            className: 'snd-btn snd-btn-mini',
            onClick: (e) => { e.stopPropagation(); UI.closed[g.id] = !closed; bump() }
          }, closed ? T('展开', 'Expand') : T('收起', 'Collapse')))
        const body = closed ? null : React.createElement('div', { className: 'snd-grid' }, g.kinds.map((kind) => card(kind)))
        return React.createElement('div', { key: g.id, className: 'snd-grp' + (closed ? ' closed' : '') }, hd, body)
      }

      function diagnostics() {
        const open = UI.diagOpen === true
        const hd = React.createElement('div', {
          className: 'snd-diag-hd',
          onClick: () => { UI.diagOpen = !open; bump() }
        },
          React.createElement('span', { className: 'snd-grp-caret' }, '▾'),
          React.createElement('span', null, T('诊断信息', 'Diagnostics')))
        if (!open) return React.createElement('div', { className: 'snd-diag closed' }, hd)
        const rows = [
          [T('动态版', 'Dynamic build'), VERSION_TEXT],
          [T('宿主能力', 'Host capability'), store.capBeep === false ? T('不可蜂鸣', 'beep unavailable') : T('可蜂鸣', 'beep available')],
          [T('通知权限', 'Notification permission'), store.notifyCap === false ? T('不可用', 'unavailable') : T('可用', 'available')],
          [T('存储位置', 'Storage'), store.localDir === null ? T('未知', 'unknown') : String(store.localDir)],
          [T('工作区静音标记', 'Workspace marks'), WS_MARK_STATS.rows + T(' 行 / ', ' rows / ') + WS_MARK_STATS.matched + T(' 匹配 / ', ' matched / ') + WS_MARK_STATS.shown + T(' 显示', ' shown')]
        ]
        return React.createElement('div', { className: 'snd-diag' }, hd,
          React.createElement('div', { className: 'snd-diag-bd' },
            React.createElement('div', { className: 'snd-kv' },
              rows.map((r, i) => React.createElement('span', { key: 'k' + i, className: 'snd-kv-k' }, r[0]))
                .concat(rows.map((r, i) => React.createElement('span', { key: 'v' + i, className: 'snd-kv-v' }, r[1]))))))
      }

      function workspaceGroup() {
        const items = workspaceItems()
        if (items.length === 0) return null
        let mutedCount = 0
        for (const it of items) if (store.muted.indexOf(String(it.workspaceId)) >= 0) mutedCount += 1
        return React.createElement('div', { className: 'snd-grp' },
          React.createElement('div', { className: 'snd-grp-hd' },
            React.createElement('span', { className: 'snd-grp-name' }, T('工作区静音', 'Workspace mute')),
            React.createElement('span', { className: 'snd-grp-count' }, mutedCount + '/' + items.length)),
          React.createElement('div', { className: 'snd-grid' }, items.map((it) => {
            const id = String(it.workspaceId)
            const muted = store.muted.indexOf(id) >= 0
            return React.createElement('div', { key: id, className: 'snd-row' + (muted ? ' off' : '') },
              React.createElement('div', { className: 'snd-row-hd' },
                React.createElement('span', { className: 'snd-row-name' }, workspaceLabelOf(it)),
                muted ? React.createElement('span', { className: 'snd-badge' }, T('静音', 'Muted')) : null,
                React.createElement('span', { className: 'snd-grow' }),
                switchButton(muted, () => toggleWorkspaceMute(id))),
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
            switchButton(store.master, () => { store.master = !store.master; bump() })),
          React.createElement('div', { className: 'snd-chips' },
            chip('webBeep', T('网页响铃', 'Browser sound'), store.webBeep, () => { store.webBeep = !store.webBeep; bump() }),
            chip('notify', T('网页通知', 'Web notifications'), store.notifyEnabled, () => {
              store.notifyEnabled = !store.notifyEnabled
              bump()
              if (store.notifyEnabled) requestNotifyPermission()
            }, store.notifyCap === false),
            chip('hostBeep', T('宿主蜂鸣', 'Host beep'), store.hostBeep, () => {
              store.hostBeep = !store.hostBeep
              bump()
              host.call('sysset', { hostBeep: store.hostBeep }).catch(() => {})
            }, store.capBeep === false))),
        React.createElement('div', { className: 'snd-bulk' },
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: () => setAll(true) }, T('全部开启', 'All on')),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: () => setAll(false) }, T('全部静音', 'All muted')),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: resetDefaults }, T('恢复默认', 'Reset'))),
        KIND_GROUPS.map((g) => group(g)),
        workspaceGroup(),
        diagnostics(),
        store.localDir !== null ? React.createElement('div', { className: 'snd-note' }, T('本地存储位置：', 'Local storage: ') + store.localDir) : null,
        store.saveError !== null ? React.createElement('div', { className: 'snd-note', style: { color: 'var(--dsw-alias-state-warn-label,#dd8629)' } }, store.saveError) : null,
        React.createElement('div', { className: 'snd-note' },
          VERSION_TEXT + ' · ' + T('设置存浏览器（localStorage），自定义音频经宿主写入本地磁盘；页面关闭时只有宿主蜂鸣生效。',
            'Settings live in the browser (localStorage); custom audio is written to local disk by the host. With the page closed only the host beep fires.')))
    }

    /* ---------------- 工作区静音（v0.5.9：设置页开关 + 标题旁只读标记） ---------------- */
    // 标记渲染在 body 下的独立覆盖层里（React 不管理这些节点），只按工作区行标题的
    // 屏幕坐标**移动位置**——不插入 React 子树、不删除，因此不存在「被重渲染冲掉再补回」
    // 的闪烁。滚动/尺寸变化/定时器只更新坐标。
    const WS_MARK_ATTR = 'data-chime-ws-mark'
    const WS_MARK_STATS = { rows: 0, matched: 0, shown: 0, tick: 0 }
    const overlayHost = null
    const overlayMarks = new Map() // wsId -> element
    const ICON_BELL_OFF_PLAIN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BELL_PATH + '"/>' +
      '<path d="' + SLASH_PATH + '" stroke="var(--dsw-alias-bg-surface,#151517)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="' + SLASH_PATH + '" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>'

    function toggleWorkspaceMute(wsId) {
      const id = String(wsId)
      const i = store.muted.indexOf(id)
      if (i >= 0) store.muted.splice(i, 1)
      else store.muted.push(id)
      bump()
    }

    function workspaceTitleNode(row, title) {
      const all = row.querySelectorAll('span,div,button')
      const loose = null
      for (const i = 0; i < all.length; i++) {
        const el = all[i]
        if (el.children.length > 0) continue
        const text = el.textContent === null ? '' : el.textContent.trim()
        if (text === '') continue
        if (text === title) return el
        if (loose === null && text.indexOf(title) === 0) loose = el
      }
      return loose
    }

    function ensureOverlay() {
      if (overlayHost !== null) return overlayHost
      if (typeof document === 'undefined') return null
      const host = document.createElement('div')
      host.className = 'snd-ws-marks'
      try { document.body.appendChild(host) } catch (e) { return null }
      overlayHost = host
      return host
    }

    function syncWorkspaceMarks() {
      try {
        if (typeof document === 'undefined') return
        const host = ensureOverlay()
        if (host === null) return
        const items = workspaceItems()
        const rows = document.querySelectorAll('div[role="treeitem"]')
        WS_MARK_STATS.rows = rows.length
        WS_MARK_STATS.matched = 0
        WS_MARK_STATS.tick = Date.now()
        const seen = new Set()
        for (const i = 0; i < items.length; i++) {
          const it = items[i]
          if (!it || typeof it.workspaceId !== 'string') continue
          const wsId = String(it.workspaceId)
          if (store.muted.indexOf(wsId) < 0) continue
          const title = workspaceLabelOf(it)
          const titleEl = null
          const rowEl = null
          for (const r = 0; r < rows.length; r++) {
            const cand = workspaceTitleNode(rows[r], title)
            if (cand !== null) { titleEl = cand; rowEl = rows[r]; break }
          }
          if (titleEl === null || rowEl === null) continue
          WS_MARK_STATS.matched += 1
          const mark = overlayMarks.get(wsId)
          if (mark === undefined) {
            mark = document.createElement('span')
            mark.className = 'snd-ws-mark'
            mark.setAttribute(WS_MARK_ATTR, wsId)
            mark.title = T('该工作区已静音（设置 → 声音提醒 里可关闭）', 'This workspace is muted (turn it off in Settings → Sound alerts)')
            mark.innerHTML = ICON_BELL_OFF_PLAIN
            try { host.appendChild(mark) } catch (e) { continue }
            overlayMarks.set(wsId, mark)
          }
          const rect = rowEl.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          // 位置：贴在该行「...」操作按钮的左侧（实测其矩形，不再猜偏移量）；
          // 没有按钮时退回行右侧内部 72px。
          const btns = rowEl.querySelectorAll('button')
          const anchorLeft = rect.right - 72
          if (btns.length > 0) {
            const last = btns[btns.length - 1]
            const br = last.getBoundingClientRect()
            if (br.width > 0) anchorLeft = br.left - 19
          }
          mark.style.left = Math.round(anchorLeft) + 'px'
          mark.style.top = Math.round(rect.top + rect.height / 2 - 7) + 'px'
          // 悬停中的行会浮现操作按钮，布局随之变化——此时隐藏标记，避免跳动与遮挡
          const hovering = false
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

    styles.insert(`
.snd-page{display:flex;flex-direction:column;gap:11px;font-size:13px;color:var(--dsw-alias-label-primary,#e7e9f0);padding-bottom:8px}
.snd-grow{flex:1}
.snd-hero{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:13px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent),transparent);padding:11px 12px;display:flex;flex-direction:column;gap:9px}
.snd-hero-top{display:flex;align-items:center;gap:10px}
.snd-title{font-weight:700;font-size:13px}
.snd-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8)}
.snd-chips{display:flex;gap:7px;flex-wrap:wrap}
.snd-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);padding:4px 10px 4px 8px;font-size:11.5px;cursor:pointer;color:var(--dsw-alias-label-primary,#e7e9f0);font-family:inherit}
.snd-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#adb2b8);flex:none}
.snd-chip-state{color:var(--dsw-alias-label-secondary,#9aa3b8);font-size:10.5px}
.snd-chip.on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 55%,transparent)}
.snd-chip.on .snd-chip-dot{background:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 18%,transparent)}
.snd-chip.dis{opacity:.5;cursor:default}
.snd-bulk{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.snd-grp{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent)}
.snd-grp-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 7%,transparent)}
.snd-grp-caret{color:var(--dsw-alias-label-secondary,#9aa3b8);transition:transform .15s ease;display:inline-block;width:11px}
.snd-grp.closed .snd-grp-caret{transform:rotate(-90deg)}
.snd-grp-name{font-size:11.5px;font-weight:600}
.snd-grp-count{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent);border-radius:999px;padding:0 6px}
.snd-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:9px}
@media (max-width:680px){.snd-grid{grid-template-columns:1fr}}
.snd-row{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);padding:8px 9px}
.snd-row.off{opacity:.6}
.snd-row-hd{display:flex;align-items:center;gap:6px}
.snd-row-name{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.snd-desc{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:28px}
.snd-row-bd{display:flex;align-items:center;gap:5px}
.snd-badge{font-size:9.5px;padding:0 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-label,#dd8629);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 35%,transparent);white-space:nowrap}
.snd-switch{flex:none;display:flex;align-items:center;width:36px;height:20px;padding:2px;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 18%,transparent);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.snd-knob{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);transition:margin-left .16s ease}
.snd-switch.on{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.snd-switch.on .snd-knob{margin-left:auto}
.snd-switch.dis{opacity:.45;cursor:default}
.snd-select-wrap{position:relative;display:inline-flex;flex:1;min-width:0}
.snd-select{appearance:none;-webkit-appearance:none;width:100%;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:11.5px;height:26px;padding:0 22px 0 7px;cursor:pointer;font-family:inherit}
.snd-row-bd .snd-select-wrap{flex:1}
.snd-select{color-scheme:light}
body[data-ds-dark-theme] .snd-select{color-scheme:dark}
.snd-select option,.snd-select optgroup{background-color:var(--dsw-alias-bg-overlay,#2c2c2e);color:var(--dsw-alias-label-primary,#e7e9f0)}
.snd-select-wrap::after{content:"";position:absolute;right:5px;top:50%;width:13px;height:13px;transform:translateY(-50%);background-color:var(--dsw-alias-label-secondary,#9aa3b8);-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;pointer-events:none}
.snd-ib{width:27px;height:27px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;flex:none;transition:background .12s ease,color .12s ease}
.snd-ib:hover{color:var(--dsw-alias-label-primary,#e7e9f0);background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent)}
.snd-ib svg{width:14px;height:14px;fill:currentColor}
.snd-ib.play svg{width:17px;height:17px;transform:translateX(1px)}
.snd-ib.off{color:var(--dsw-alias-state-warn-label,#dd8629);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent)}
.snd-vol{display:flex;align-items:center;gap:6px;margin-top:2px}
.snd-vol input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.snd-vol-val{flex:none;width:30px;text-align:right;font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);font-variant-numeric:tabular-nums}
.snd-hostrow{display:flex;align-items:center;gap:4px;padding-top:5px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(120,132,160,.3))}
.snd-host-label{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa3b8);white-space:nowrap;flex:none}
.snd-hostrow .snd-select{height:24px;font-size:11px}
.snd-hostrow .snd-ib{width:24px;height:24px}
.snd-hostrow .snd-ib svg{width:13px;height:13px}
.snd-hostrow .snd-ib.play svg{width:15px;height:15px}
.snd-btn{display:inline-flex;align-items:center;justify-content:center;height:27px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:7px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:11.5px;padding:0 9px;cursor:pointer;transition:background .12s ease;font-family:inherit;white-space:nowrap}
.snd-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 11%,transparent)}
.snd-btn-mini{height:22px;padding:0 7px;font-size:10.5px;border-radius:6px}
.snd-diag{border:1px solid var(--dsw-alias-border-l2,rgba(120,132,160,.3));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7e9f0) 4%,transparent)}
.snd-diag-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8)}
.snd-diag.closed .snd-grp-caret{transform:rotate(-90deg)}
.snd-diag-bd{padding:0 10px 10px}
.snd-kv{display:grid;grid-template-columns:96px 1fr;gap:3px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8)}
.snd-kv-k{color:var(--dsw-alias-label-secondary,#9aa3b8)}
.snd-kv-v{color:var(--dsw-alias-label-primary,#e7e9f0)}
.snd-note{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.5}
.snd-ws-marks{position:fixed;inset:0;pointer-events:none;z-index:2147482000}
.snd-ws-mark{position:absolute;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;color:var(--dsw-alias-state-warn-label,#dd8629);pointer-events:none}
.snd-ws-mark svg{width:14px;height:14px;fill:currentColor;display:block}
.snd-tip{position:fixed;z-index:2147483000;max-width:240px;background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:6px;padding:4px 8px;font-size:11px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none;opacity:0;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease;white-space:nowrap;font-family:inherit}
.snd-tip.on{opacity:1;transform:none}
.YDXeBa_projectRow.snd-keep-open.snd-keep-open .YDXeBa_rowActions{display:inline-flex}
.VOzbGW_navList .VOzbGW_navCell:nth-child(5) > svg{display:none}
.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel{display:inline-flex;align-items:center;gap:8px}
.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel::before{content:" ";width:16px;height:16px;flex:none;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}
`)

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'chime', order: 25, label: T('声音提醒', 'Sound Alerts') },
      () => React.createElement(SettingsPage)
    ))

  }
}
