// ============================================================
// dsh-chime-alerts · 客户端半（Client half）— v0.3.16
// 动态 Cordis 插件的客户端代码（函数体，直接粘进 cordis_define 的 code.client）
// ============================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---- i18n：按浏览器语言自动选择中文/英文（无 navigator 时默认中文） ----
    const navLang = (typeof navigator !== 'undefined' && navigator.language) ? String(navigator.language).toLowerCase() : 'zh'
    const LANG = navLang.indexOf('zh') === 0 ? 'zh' : 'en'
    const T = (zh, en) => (LANG === 'zh' ? zh : en)

    const KIND_META = {
      complete: { label: T('任务完成', 'Task completed'), desc: T('Agent 完整结束一轮任务（回合正常完成）', 'Agent finished a full turn (normal completion)') },
      subcomplete: { label: T('子任务完成', 'Subagent completed'), desc: T('并行子代理任务完成（默认关闭，需要时打开）', 'A parallel subagent task finished (off by default, enable if needed)') },
      jobdone: { label: T('后台任务完成', 'Background job done'), desc: T('后台作业（如 shell 后台任务）执行完成', 'A background job (e.g. a shell background task) finished') },
      approval: { label: T('需要授权', 'Approval needed'), desc: T('出现需要你手动批准的操作时', 'When an operation requires your manual approval') },
      question: { label: T('Agent 提问', 'Agent question'), desc: T('Agent 调用提问工具询问你时', 'When the agent asks you via the question tool') },
      planreview: { label: T('计划评审', 'Plan review'), desc: T('Agent 提交计划等待你批准（退出计划模式）', 'Agent submitted a plan awaiting your approval (left plan mode)') },
      goalblocked: { label: T('目标受阻', 'Goal blocked'), desc: T('长期目标被阻塞，需要你处理', 'A long-term goal is blocked and needs your attention') },
      interrupt: { label: T('其他打断', 'Interrupted'), desc: T('运行被停止 / 出错 / 目标阻塞 / 超出 token 上限', 'Run stopped / error / goal blocked / token limit exceeded') },
      jobfail: { label: T('后台任务失败', 'Background job failed'), desc: T('后台作业（如 shell 后台任务）执行失败', 'A background job (e.g. a shell background task) failed') }
    }

    // 设置页分组：主要通知 / 其他通知 / 需要人介入时
    const KIND_GROUPS = [
      { id: 'main', label: T('主要通知', 'Primary notifications'), kinds: ['complete', 'subcomplete', 'jobdone'] },
      { id: 'other', label: T('其他通知', 'Other notifications'), kinds: ['jobfail', 'interrupt'] },
      { id: 'human', label: T('需要人介入时', 'Human action needed'), kinds: ['approval', 'question', 'planreview', 'goalblocked'] }
    ]

    const store = {
      master: true,
      webBeep: true,
      hostBeep: false,
      notifyEnabled: true,
      muted: [],
      audioLib: {},
      localDir: null,
      saveError: null,
      kinds: {
        complete: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        subcomplete: { enabled: false, sound: 'default', volume: 1, customUrl: null, customName: null },
        jobdone: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        approval: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        question: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        planreview: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        goalblocked: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        interrupt: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null },
        jobfail: { enabled: true, sound: 'default', volume: 1, customUrl: null, customName: null }
      }
    }

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

    // v0.3.16：九种音各有 1~4 个音符（不全是四声），音调用跳跃音型（如 1'3'5'1''、1''3'1''3' 跳进，
    // 非连续音阶），全部 sine 基音 + sine 2 倍频泛音；
    // 语义：上行琶音=任务完成，单声=子任务轻提示，五度跳进往返=后台完成，
    // 叮咚大跳×2=需要授权，增四度跳跃上行=提问，镜像下行=评审结束，
    // 低音三连下行=目标受阻，四度下行双响=打断，大跳坠落下行=失败。
    // 每音 0.1–0.2s 间隔、尾音 0.35–0.7s 长衰减（保留 0.25s 余韵铃感）。
    const PATTERNS = {
      complete: [[523.25, 0, 0.18, 'sine'], [659.25, 0.16, 0.18, 'sine'], [783.99, 0.32, 0.18, 'sine'], [1046.5, 0.48, 0.7, 'sine']],
      subcomplete: [[783.99, 0, 0.4, 'sine']],
      jobdone: [[392, 0, 0.14, 'sine'], [523.25, 0.14, 0.14, 'sine'], [783.99, 0.28, 0.5, 'sine']],
      approval: [[1046.5, 0, 0.16, 'sine'], [659.25, 0.18, 0.16, 'sine'], [1046.5, 0.4, 0.16, 'sine'], [659.25, 0.58, 0.6, 'sine']],
      question: [[523.25, 0, 0.14, 'sine'], [698.46, 0.14, 0.14, 'sine'], [987.77, 0.28, 0.5, 'sine']],
      planreview: [[987.77, 0, 0.14, 'sine'], [698.46, 0.14, 0.14, 'sine'], [523.25, 0.28, 0.55, 'sine']],
      goalblocked: [[392, 0, 0.2, 'sine'], [329.63, 0.2, 0.2, 'sine'], [261.63, 0.4, 0.65, 'sine']],
      interrupt: [[698.46, 0, 0.1, 'sine'], [523.25, 0.12, 0.35, 'sine']],
      jobfail: [[1046.5, 0, 0.1, 'sine'], [698.46, 0.12, 0.1, 'sine'], [493.88, 0.24, 0.45, 'sine']]
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
      const pattern = PATTERNS[patternKind]
      if (pattern === undefined) return false
      const ac = await ensureAudio()
      if (ac === null) return false
      const v = clampVolume(cfg.volume)
      const t0 = ac.currentTime + 0.02
      // 每个音符 = 基音 + 2 倍频泛音（低音量正弦）：起音快而轻（12ms），
      // 衰减带 0.25s 自然余韵（铃感），比纯振荡器直出更圆润、不刺耳
      // v0.3.15：音量提升（基音 0.32→0.45、泛音 0.22→0.26），尾音余韵保留
      for (const item of pattern) {
        const freq = item[0]
        const start = item[1]
        const dur = item[2]
        const wave = item[3]
        const t = t0 + start
        const gain = ac.createGain()
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.45 * v, t + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25)
        const osc = ac.createOscillator()
        osc.type = wave
        osc.frequency.value = freq
        osc.connect(gain)
        const osc2 = ac.createOscillator()
        osc2.type = 'sine'
        osc2.frequency.value = freq * 2
        const gain2 = ac.createGain()
        gain2.gain.value = 0.26
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

    function testFire(kind) {
      const cfg = store.kinds[kind]
      if (cfg === undefined) return
      requestNotifyPermission()
      if (store.webBeep) playBrowser(kind, cfg).catch(() => {})
      if (store.hostBeep) sysBeep(kind)
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

    const SOUND_OPTIONS = [
      { value: 'default', label: T('默认（本事件专属短音）', 'Default (event-specific chime)') },
      { value: 'complete', label: T('完成音 · 上行琶音', 'Complete · ascending arpeggio') },
      { value: 'subcomplete', label: T('子任务音 · 单声轻叮', 'Subtask · single soft ding') },
      { value: 'approval', label: T('授权音 · 叮咚大跳×2', 'Approval · leaping bell ×2') },
      { value: 'question', label: T('提问音 · 跳跃上行', 'Question · leaping ascent') },
      { value: 'planreview', label: T('评审音 · 跳跃下行', 'Review · leaping descent') },
      { value: 'goalblocked', label: T('受阻音 · 低音三连', 'Blocked · low triad') },
      { value: 'interrupt', label: T('打断音 · 下行双响', 'Interrupt · descending pair') },
      { value: 'jobfail', label: T('失败音 · 坠落三连', 'Failure · falling triad') },
      { value: 'jobdone', label: T('后台完成音 · 跳进上行', 'Job done · leaping ascent') },
      { value: 'custom', label: T('自定义声音…', 'Custom sound…') }
    ]
    // v0.3.11 音频库：内置选项 + 所有已导入音频（每个下拉都可见可选）
    function soundOptionList() {
      const list = SOUND_OPTIONS.slice()
      for (const id of Object.keys(store.audioLib)) {
        list.push({ value: 'custom:' + id, label: T('自定义声音 · ', 'Custom sound · ') + store.audioLib[id].name })
      }
      return list
    }

    function switchButton(checked, onToggle) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        className: 'snd-switch' + (checked ? ' on' : ''),
        onClick: onToggle
      }, React.createElement('span', { className: 'snd-knob' }))
    }

    function SettingsPage() {
      useVersion()
      const fileRefs = React.useRef({})
      const pendingPick = React.useRef({})

      // 自定义声音改到「声音」下拉列表里：选中「自定义声音…」即弹出上传窗。
      // 上传窗取消时页面重新获得焦点（focus 事件）——借此把下拉显示复位，
      // 并让已有自定义文件的用户“取消=切回自定义声音”。
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
        return () => { try { window.removeEventListener('focus', onFocus) } catch (err) {} }
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
            // v0.3.11：音频入库（所有事件下拉共享），当前事件立即选中
            saveAudioToLib(b64, file.name).then((id) => {
              if (id !== null) { store.kinds[kind].sound = 'custom:' + id; bump() }
            })
          } catch (err) {}
        }
        reader.readAsDataURL(file)
      }

      function kindRow(kind) {
        const cfg = store.kinds[kind]
        const meta = KIND_META[kind]
        // 单行布局（不折叠）：名称 / 声音下拉 / 静音图标键 / 音量条 / 音量数值 / 试听。
        // 静音键 = 原开关的图标化：响铃=开启，斜杠喇叭（橙色）=静音；
        // 自定义声音仍通过声音下拉里的「自定义声音…」选项上传/替换。
        return React.createElement('div', { key: kind, className: 'snd-row' + (cfg.enabled ? '' : ' off') },
          React.createElement('span', { className: 'snd-name snd-row-name' }, meta.label),
          React.createElement('div', { className: 'snd-select-wrap' },
            React.createElement('select', {
              className: 'snd-select',
              value: cfg.sound,
              onChange: (e) => {
                if (e.target.value === 'custom') { openUpload(kind); return }
                cfg.sound = e.target.value
                bump()
              }
            }, soundOptionList().map((o) => React.createElement('option', { key: o.value, value: o.value },
              o.value === 'custom' ? T('自定义声音…', 'Custom sound…') : o.label)))),
          React.createElement('button', {
            type: 'button',
            className: 'snd-row-mute' + (cfg.enabled ? '' : ' off'),
            title: cfg.enabled ? (T('静音「', 'Mute “') + meta.label + T('」', '”')) : (T('开启「', 'Unmute “') + meta.label + T('」的声音', '”')),
            'aria-label': cfg.enabled ? (T('静音「', 'Mute “') + meta.label + T('」', '”')) : (T('开启「', 'Unmute “') + meta.label + T('」的声音', '”')),
            'aria-pressed': String(cfg.enabled),
            onClick: () => { cfg.enabled = !cfg.enabled; bump() }
          }, React.createElement('span', { className: 'snd-row-mute-icon' })),
          React.createElement('input', {
            type: 'range',
            className: 'snd-volume',
            min: 0,
            max: 100,
            step: 5,
            value: Math.round(cfg.volume * 100),
            onChange: (e) => { cfg.volume = Number(e.target.value) / 100; bump() }
          }),
          React.createElement('span', { className: 'snd-vol-val' }, Math.round(cfg.volume * 100) + '%'),
          React.createElement('button', { type: 'button', className: 'snd-btn', onClick: () => testFire(kind) }, T('试听', 'Preview')),
          React.createElement('input', {
            ref: (el) => { fileRefs.current[kind] = el },
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: (e) => onFilePicked(kind, e)
          }))
      }

      return React.createElement('div', { className: 'snd-page' },
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('启用声音提醒', 'Enable sound alerts')),
            React.createElement('span', { className: 'snd-desc' }, T('总开关，关闭后所有事件静音', 'Master switch; all events are silent when off'))),
          switchButton(store.master, () => { store.master = !store.master; bump() })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('网页响铃', 'Browser sound')),
            React.createElement('span', { className: 'snd-desc' }, T('事件时在浏览器播放合成音（设置存浏览器）', 'Plays synthesized sounds in the browser (stored in browser)'))),
          switchButton(store.webBeep, () => { store.webBeep = !store.webBeep; bump() })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('宿主蜂鸣', 'Host beep')),
            React.createElement('span', { className: 'snd-desc' }, T('宿主直接播放系统音效，页面关闭也响（设置存本地磁盘）', 'Host plays system sounds directly, even with the page closed (stored on local disk)'))),
          switchButton(store.hostBeep, () => {
            store.hostBeep = !store.hostBeep
            bump()
            host.call('sysset', { hostBeep: store.hostBeep }).catch(() => {})
          })),
        React.createElement('div', { className: 'snd-master' },
          React.createElement('div', null,
            React.createElement('span', { className: 'snd-name' }, T('桌面通知', 'Desktop notifications')),
            React.createElement('span', { className: 'snd-desc' }, T('事件发生时弹系统通知（首次开启/试听时请求浏览器权限）', 'Shows a system notification on events (browser permission is requested on first enable / preview)'))),
          switchButton(store.notifyEnabled, () => {
            store.notifyEnabled = !store.notifyEnabled
            bump()
            if (store.notifyEnabled) requestNotifyPermission()
          })),
        KIND_GROUPS.map((g) => React.createElement('div', { key: g.id, className: 'snd-group' },
          React.createElement('div', { className: 'snd-group-title' }, g.label),
          g.kinds.map((kind) => kindRow(kind)))),
        React.createElement('div', { className: 'snd-note' }, T('按三组分类：主要通知 / 其他通知 / 需要人介入时。每行：名称 / 声音下拉（内置 + 音频库「自定义声音 · 文件名」，选中「自定义声音…」即上传入库，所有事件下拉共享；换文件先选其他声音再选回）/ 静音图标键 / 音量条 / 试听。网页响铃（浏览器合成音）与宿主蜂鸣（系统音效，页面关闭也响）是两个独立开关；桌面通知独立开关。固定监听所有会话，子任务行默认静音；侧栏工作区条目旁的喇叭按钮可单独静音该工作区。网页响铃设置存浏览器 localStorage；宿主蜂鸣设置与自定义音频存本地磁盘。', 'Events are grouped into three categories: primary / other / human action needed. Each row: name / sound dropdown (built-in + audio library “Custom sound · filename”; picking “Custom sound…” uploads into the shared library, available in every dropdown; to replace a file, pick another sound first, then pick custom again) / mute button / volume slider / preview. Browser sound (synthesized) and host beep (system sounds, even with the page closed) are two independent switches; desktop notifications have their own switch. All sessions are watched; the subagent row is muted; the speaker button next to a workspace in the sidebar mutes that workspace alone. The browser-sound switch persists in localStorage; the host-beep setting and custom audio are stored on the local disk.')),
        (store.localDir !== null ? React.createElement('div', { className: 'snd-note' }, T('本地存储位置：', 'Local storage: ') + store.localDir) : null),
        (store.saveError !== null ? React.createElement('div', { className: 'snd-note', style: { color: '#e08a3c' } }, store.saveError) : null))
    }

    // ---- 工作区行内静音按钮（悬停显现；挂 body；单例防重影） ----
    // 工作区行特征：div[role="treeitem"][aria-expanded]（会话行只有 aria-selected，无 aria-expanded）；
    // 外壳无行内插槽，且 React 会在悬停状态变化时重渲染行并抹掉注入到行内的节点，
    // 因此按钮挂在 document.body（React 树外），fixed 定位贴到行的右侧、悬停时显示。
    // 单例协议：body 上有 owner 标记（token+时间戳）。同页多个实例（旧 run 泄漏等）
    // 同时存在时只有最新属主创建按钮；属主每次扫描刷新时间戳，死后 5s 被接管。
    // 同时清理行内残留与 body 上非本实例的按钮，避免双喇叭重叠。
    const MUTE_TOKEN = 'chime-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    const wsButtons = new Map() // row element -> { btn, label }
    function ownerMarker() {
      try {
        if (typeof document === 'undefined') return null
        return document.getElementById('dsh-chime-alerts-ws-mute-owner')
      } catch (err) { return null }
    }
    function ownsMuteButtons() {
      try {
        const m = ownerMarker()
        if (m === null) {
          const el = document.createElement('div')
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
      for (const [, rec] of wsButtons) {
        if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (err) {} }
        try { rec.row.classList.remove('snd-keep-open') } catch (err) {}
        try { rec.btn.remove() } catch (err) {}
      }
      wsButtons.clear()
    }
    function positionWsButton(row, btn) {
      try {
        const rect = row.getBoundingClientRect()
        // 官方 ⋮/+ 按钮约 60px 宽：我们的按钮贴在其左侧，避免重叠
        btn.style.top = (rect.top + rect.height / 2 - 11) + 'px'
        btn.style.right = (window.innerWidth - rect.right + 62) + 'px'
      } catch (err) {}
    }
    function syncWorkspaceMuteButtons() {
      try {
        if (typeof document === 'undefined') return
        // 行匹配按标题（DOM 文本），静音键控按 workspaceId（改名/重名不失效）
        const titleToId = new Map()
        for (const it of workspaceItems()) {
          if (it && typeof it.workspaceId === 'string') titleToId.set(workspaceLabelOf(it), it.workspaceId)
        }
        if (titleToId.size === 0) { dropMyMuteButtons(); return }
        if (!ownsMuteButtons()) { dropMyMuteButtons(); return }
        // 清理异常残留：行内旧版按钮（本版从不注入行内）与 body 上非本实例按钮
        for (const el of document.querySelectorAll('div[role="treeitem"] .snd-ws-mute')) {
          try { el.remove() } catch (err) {}
        }
        const mineSet = new Set()
        for (const [, rec] of wsButtons) mineSet.add(rec.btn)
        for (const el of document.querySelectorAll('.snd-ws-mute')) {
          if (el.parentNode !== document.body || mineSet.has(el)) continue
          try { el.remove() } catch (err) {}
        }
        const rows = document.querySelectorAll('div[role="treeitem"][aria-expanded]')
        const seen = new Set()
        for (const row of rows) {
          seen.add(row)
          const label = (row.textContent || '').trim()
          const wsId = titleToId.get(label)
          if (label === '' || wsId === undefined) continue
          let rec = wsButtons.get(row)
          if (rec === undefined) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'snd-ws-mute'
            btn.style.position = 'fixed'
            btn.style.display = 'none'
            btn.style.zIndex = '60'
            const span = document.createElement('span')
            span.className = 'snd-ws-mute-icon'
            btn.appendChild(span)
            btn.addEventListener('click', (e) => {
              e.preventDefault()
              e.stopPropagation()
              try {
                const i = store.muted.indexOf(wsId)
                if (i >= 0) store.muted.splice(i, 1)
                else store.muted.push(wsId)
                bump()
                syncWorkspaceMuteButtons()
              } catch (err) {}
            })
            document.body.appendChild(btn)
            rec = { btn, label, id: wsId, hideTimer: null, row }
            wsButtons.set(row, rec)
            // 悬停意图协议：行/按钮任一悬停即显示；离开行延迟 250ms 隐藏，
            // 离开按钮延迟 200ms——按钮挂 body（不在行内），鼠标移上按钮会触发行
            // mouseleave，立即隐藏会造成 显示↔隐藏 循环闪烁。
            // 同时给行加 snd-keep-open 类：官方 ⋮/+ 按钮只在行 :hover 时显示，
            // 光标移到本按钮（行外）时靠该类保持官方按钮可见（见样式表）。
            const cancelHide = () => {
              if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (err) {} }
              rec.hideTimer = null
            }
            const show = () => {
              cancelHide()
              btn.style.display = 'inline-flex'
              try { row.classList.add('snd-keep-open') } catch (err) {}
              positionWsButton(row, btn)
            }
            const scheduleHide = (ms) => {
              // 静音态：标志常驻显示不隐藏，但移除 keep-open（官方 ⋮/+ 维持悬停协议）
              if (store.muted.indexOf(rec.id) >= 0) {
                try { row.classList.remove('snd-keep-open') } catch (err) {}
                return
              }
              cancelHide()
              rec.hideTimer = ctx.timeout(() => {
                rec.hideTimer = null
                btn.style.display = 'none'
                try { row.classList.remove('snd-keep-open') } catch (err) {}
              }, ms)
            }
            row.addEventListener('mouseenter', show)
            row.addEventListener('mouseleave', () => scheduleHide(250))
            btn.addEventListener('mouseenter', show)
            btn.addEventListener('mouseleave', () => scheduleHide(200))
          }
          const muted = store.muted.indexOf(rec.id) >= 0
          rec.btn.className = 'snd-ws-mute' + (muted ? ' off pin' : '')
          rec.btn.title = muted ? (T('已静音「', 'Muted “') + rec.label + T('」，点击恢复声音', '”, click to restore')) : (T('静音「', 'Mute “') + rec.label + T('」的声音提醒', '” sound alerts'))
          rec.btn.setAttribute('aria-label', muted ? (T('开启「', 'Unmute “') + rec.label + T('」的声音提醒', '” sound alerts')) : (T('静音「', 'Mute “') + rec.label + T('」的声音提醒', '” sound alerts')))
          rec.btn.setAttribute('aria-pressed', String(!muted))
          if (muted) {
            // 静音态：静音标志常驻显示（不随悬停隐藏）
            if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (err) {} }
            rec.hideTimer = null
            rec.btn.style.display = 'inline-flex'
          } else {
            // 非静音态：回到悬停显示协议
            rec.btn.style.display = 'none'
          }
          positionWsButton(row, rec.btn)
        }
        for (const [row, rec] of wsButtons) {
          if (!seen.has(row) || !document.body.contains(row)) {
            if (rec.hideTimer !== null) { try { rec.hideTimer() } catch (err) {} }
            try { rec.row.classList.remove('snd-keep-open') } catch (err) {}
            try { rec.btn.remove() } catch (err) {}
            wsButtons.delete(row)
          }
        }
      } catch (err) {}
    }
    if (typeof document !== 'undefined') {
      ctx.interval(syncWorkspaceMuteButtons, 1200)
      ctx.timeout(syncWorkspaceMuteButtons, 1500)
      // 侧栏内部滚动（捕获阶段）与窗口变化时立即重新定位，避免按钮飘移
      const reposition = () => {
        for (const [row, rec] of wsButtons) positionWsButton(row, rec.btn)
      }
      document.addEventListener('scroll', reposition, true)
      window.addEventListener('resize', reposition)
      ctx.effect(() => () => {
        try { document.removeEventListener('scroll', reposition, true) } catch (err) {}
        try { window.removeEventListener('resize', reposition) } catch (err) {}
        dropMyMuteButtons()
        const m = ownerMarker()
        if (m !== null && m.dataset.token === MUTE_TOKEN) { try { m.remove() } catch (err) {} }
      })
    }

    styles.insert('.snd-page{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#e7e9f0);padding-bottom:8px}' +
      '.snd-master{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.25));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,140,170,.06))}' +
      '.snd-row{display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,140,170,.06))}' +
      '.snd-group{display:flex;flex-direction:column;gap:8px}' +
      '.snd-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa3b8);padding:0 4px}' +
      '.snd-row.off{opacity:.55}' +
      '.snd-row-name{flex:none;min-width:88px;white-space:nowrap}' +
      '.snd-name{font-weight:600;line-height:1.3}' +
      '.snd-desc{display:block;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);margin-top:2px;line-height:1.45}' +
      '.snd-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:1px solid rgba(0,0,0,.18);border-radius:10px;background:#7d8698;cursor:pointer;transition:background .15s ease,border-color .15s ease}' +
      '.snd-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s ease}' +
      '.snd-switch.on{background:#3b82f6;border-color:#2b6ae0}' +
      '.snd-switch.on .snd-knob{left:18px}' +
      '.snd-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8)}' +
      '.snd-select-wrap{position:relative;display:inline-flex;flex:none}' +
      '.snd-select-wrap::after{content:"";position:absolute;right:8px;top:50%;width:12px;height:12px;transform:translateY(-50%);background-color:var(--dsw-alias-label-secondary,#9aa3b8);-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M7.41%208.59L12%2013.17l4.59-4.58L18%2010l-6%206-6-6z%27/%3E%3C/svg%3E") center/contain no-repeat;pointer-events:none}' +
      '.snd-select{appearance:none;-webkit-appearance:none;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:12.5px;height:30px;padding:0 26px 0 8px;min-width:150px;cursor:pointer}' +
      '.snd-page .snd-volume{width:auto;flex:1;min-width:80px;max-width:240px;margin:2px 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}' +
      '.snd-vol-val{flex:none;width:36px;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);font-variant-numeric:tabular-nums}' +
      '.snd-row-mute{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;transition:background .12s ease,color .12s ease}' +
      '.snd-row-mute:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,170,.22));color:var(--dsw-alias-label-primary,#e7e9f0)}' +
      '.snd-row-mute.off{color:#e08a3c}' +
      '.snd-row-mute-icon{width:15px;height:15px;display:block;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}' +
      '.snd-row-mute.off .snd-row-mute-icon{-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat}' +
      '.snd-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.16));border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.3));border-radius:8px;color:var(--dsw-alias-label-primary,#e7e9f0);font-size:12px;padding:0 10px;cursor:pointer;transition:background .12s ease}' +
      '.snd-btn:hover{background:var(--dsw-alias-hover-l2,rgba(128,140,170,.22))}' +
      '.snd-page input[type=range]{width:100%;margin:2px 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}' +
      '.snd-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b8);line-height:1.5}' +
      '.snd-ws-mute{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(120,132,160,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(30,36,52,.92));box-shadow:0 2px 6px rgba(0,0,0,.3);color:var(--dsw-alias-label-secondary,#9aa3b8);cursor:pointer;transition:background .12s ease,color .12s ease}' +
      '.snd-ws-mute:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,170,.22));color:var(--dsw-alias-label-primary,#e7e9f0)}' +
      '.snd-ws-mute.off{color:#e08a3c}' +
      '.snd-ws-mute.pin{background:transparent;border-color:transparent;box-shadow:none}' +
      '.snd-ws-mute-icon{width:14px;height:14px;display:block;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}' +
      '.snd-ws-mute.off .snd-ws-mute-icon{-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M16.5%2012c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45%202.45c.03-.2.05-.41.05-.63zm2.5%200c0%20.94-.2%201.82-.54%202.64l1.51%201.51C20.63%2014.91%2021%2013.5%2021%2012c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86%205%203.54%205%206.71zM4.27%203L3%204.27%207.73%209H3v6h4l5%205v-6.73l4.25%204.25c-.67.52-1.42.93-2.25%201.18v2.06c1.38-.31%202.63-.95%203.69-1.81L19.73%2021%2021%2019.73l-9-9L4.27%203zM12%204L9.91%206.09%2012%208.18V4z%27/%3E%3C/svg%3E") center/contain no-repeat}' +
      '.YDXeBa_projectRow.snd-keep-open.snd-keep-open .YDXeBa_rowActions{display:inline-flex}' +
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) > svg{display:none}' +
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel{display:inline-flex;align-items:center;gap:8px}' +
      '.VOzbGW_navList .VOzbGW_navCell:nth-child(5) .VOzbGW_navLabel::before{content:" ";width:16px;height:16px;flex:none;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M3%209v6h4l5%205V4L7%209H3zM16.5%2012c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73%202.5-2.25%202.5-4.02zM14%203.23v2.06c2.89.86%205%203.54%205%206.71s-2.11%205.85-5%206.71v2.06c4.01-.91%207-4.49%207-8.77s-2.99-7.86-7-8.77z%27/%3E%3C/svg%3E") center/contain no-repeat}')

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'chime', order: 25, label: T('声音提醒', 'Sound Alerts') },
      () => React.createElement(SettingsPage)
    ))
  }
}
