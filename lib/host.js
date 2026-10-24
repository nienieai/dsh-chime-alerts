// ============================================================
// dsh-chime-alerts · 宿主半（Host half）— v0.5.10
// 动态 Cordis 插件的宿主代码（函数体，直接粘进 cordis_define 的 code.host）
// 同一份文件也被 lib/index.js 作为静态宿主入口消费：
// 静态环境中 harness 不存在 → handlers 静默不注册，事件记录与系统蜂鸣仍然工作
// v0.3.10：存储基准 = 工作区根（sandboxPolicy.workspaceRoot），兼容沙箱 workspace-write
// v0.3.11：双开关（宿主蜂鸣 hostBeep 存磁盘；网页响铃存浏览器）+ 音频库（saveaudio/loadall/loadaudio，所有事件下拉共享）
// v0.3.13：存储位置跟随 DSH 目录——workspaceRoot 落在系统目录时改用 %USERPROFILE%\.dsh\plugins\dsh-chime-alerts，旧数据自动迁移
// v0.3.20：宿主音每事件可配置（hostSounds 存 settings.json，默认映射更贴语义）
// v0.3.21：任务完成宿主音默认改用系统通知
// v0.4.0：跨平台宿主蜂鸣——win32 wscript+系统 wav；linux freedesktop 主题音（canberra-gtk-play/paplay）；
//        darwin afplay 系统音；sysget 返回 platform；存储 fallback 平台化（%USERPROFILE% / $HOME）
// v0.4.1：sysget 返回 capBeep（宿主响铃能力检测，设置页据此禁用宿主蜂鸣控件）
// v0.4.2：每事件独立静音宿主音（hostMuted 存 settings.json，record 时跳过静音事件）
// v0.4.4：动态插件授权也有声音——cordis_run 不经过 approval 服务（无 approval/asked 会话事件），
//        改监听 tools/result 检测 "awaiting user approval" 文本，按 approval 事件发声
// v0.4.5：tools/result 文本解析改深度收集（真实运行时文本在多层嵌套 content 里）
// v0.4.6：动态插件授权细分为独立事件 pluginapproval（第十个事件，独立配置）
// v0.5.4：静态宿主半的蜂鸣 vbs 走 nodeIo 直通车（不再依赖沙箱 fs 的 danger-full-access 重试）；
//        jobs 服务延迟挂接（internal/service），解决真实 web 树中 jobs 晚于本条目挂载时
//        jobdone/jobfail 宿主蜂鸣永久失联的问题
// v0.5.5：静态 HTTP 端点补全每事件宿主音配置——sysget 回传 hostSounds/hostMuted，
//        新增 /dsh-chime-alerts/sysbeep（POST {kind}）供设置页「宿主试听」按钮使用
// v0.5.8：适配 DSH 0.1.5 的契约变更（此前四类提醒静默失效）：
//        1. session/event 真实签名是 (session, event) **两个**形参，event 落在第三个
//           位置；旧代码声明 (session, event) 拿到的是 session → approval 永不触发
//        2. Session 没有 `.events` 成员（只有 ownEvents()/snapshotEvents()）；
//           旧代码靠它取 turn/end 的 reason → complete/subcomplete/interrupt 全灭
//        3. Cordis 事件名是 goal/changed（带 s），payload = { agent, change }；
//           旧代码监听会话日志事件名 goal/change → goalblocked 永不触发
//        4. 新增 /dsh-chime-alerts/events：把浏览器快照拿不到的四类
//           （approval/question/planreview/pluginapproval）增量下发给静态客户端
// ============================================================
// v0.6.1：本文件现在是 ESM 模块（不再由 lib/index.js 用 new Function 编译）。
// 包成工厂函数是为了传 nodeIo（node:fs 直通车）：Cordis loader 只以 (ctx, config)
// 调用 apply，塞不进第三个参数。动态安装继续粘贴 dynamic/host.body.js
// （tools/build-body.mjs 从本文件生成，形态仍是 `return {...}`），两边语义一致。
export function createHostPlugin(ctx, harness, __nodeIo) {
  return {
  inject: ['timer'],
  apply(ctx) {
    // nodeIo 是静态入口 lib/index.js 用 new Function('ctx','harness','__nodeIo',…) 的
    // 第三参注入的 node:fs 直通车；它**只存在于静态加载**。动态安装（把本文件全文粘进
    // cordis_define 的 code.host）里这个标识符根本没有声明——v0.5.8 之前这里直接写
    // `const nodeIo = __nodeIo`，于是动态安装一激活就 ReferenceError: __nodeIo is not
    // defined，而 README 方式 B 正是教用户粘这个文件。必须用 `typeof` 探测（对未声明
    // 标识符安全），不能再裸引用。
    // 另注：nodeIo 不能作为 apply 的第二参数声明——loader 只以 (ctx, config) 调用，
    // 那样声明会把它遮蔽成 config。
    const nodeIo = (typeof __nodeIo !== 'undefined' && __nodeIo !== null) ? __nodeIo : undefined
    // v0.5.3：fs/subprocess 必须"用的时候"即时解析——真实 web 树里这两项在 chime
    // 条目之后才挂载（激活顺序），apply 时的 ctx.get 会拿到 undefined；动态环境
    // 由 harness 桥延迟调用，不存在此问题，这里统一改为惰性解析。
    function subprocessSvc() {
      try { return ctx.get('subprocess') } catch (err) { return undefined }
    }
    function fsService() {
      try {
        const f = ctx.get('fs')
        if (f !== undefined && f !== null &&
          typeof f.resolve === 'function' && typeof f.processPath === 'function' &&
          typeof f.readText === 'function' && typeof f.writeText === 'function') return f
      } catch (err) {}
      return null
    }
    let boot = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    let seq = 0
    let alwaysBeep = false
    const lastAt = new Map()
    const events = []
    const prevStatus = new Map()
    const debounceTimers = new Map()
    // v0.5.8：静态安装专用的「宿主→浏览器」事件队列。只收浏览器快照拿不到的类别
    // （见 CLIENT_PULL_KINDS 说明），经 /dsh-chime-alerts/events 交给静态客户端播放；
    // 动态安装有 harness 桥，走 events/pull，与此队列互不影响。
    const clientEvents = []
    // v0.5.8：作业事件的诊断环（最近 80 条原始 settled/registered/removed），
    // 随 /events 响应一并返回，便于在真机上确认「到底收到了什么、awaited 是真是假」，
    // 浏览器忽略该字段（不影响播放）。
    const jobLog = []
    // 浏览器侧无快照信号、必须由宿主转发的类别：
    //   approval / question / planreview —— 客户端读不到 pendingInteraction
    //   pluginapproval —— cordis_run 的授权不产生会话快照信号
    //   jobdone / jobfail —— DSH 0.1.7 起 SessionListState 不再有 jobsBySession
    //     （作业列表迁到独立的 jobs 快照 / dsh-client-ui-jobs），客户端快照自检
    //     恒不触发；宿主半的 jobs.onJobDone 检测一直是好的，只是被挡在队列之外
    //   complete / subcomplete / interrupt —— 客户端原来靠
    //     「running true→false 且 !row.pendingInteraction」判定，但 SessionSummary
    //     在 DSH 0.1.7 里同样没有 pendingInteraction（ui-session 单独维护，只经
    //     slot 的 useSessionPendingInteraction prop 暴露给 React），该守卫恒真：
    //     一个正在等待授权的回合结束时会被误判成「完成」，授权音与完成音叠在
    //     一起就是用户听到的爆音。宿主半的判定本来就是对的
    //     （agent.inbox.hasPending），所以把判定权收回宿主。
    // 仍由浏览器快照自检的只剩 goalblocked —— projectionValues.goal 还在，
    // 不入此队列（否则会双响）。
    const CLIENT_PULL_KINDS = ['approval', 'question', 'planreview', 'pluginapproval', 'jobdone', 'jobfail', 'complete', 'subcomplete', 'interrupt']

    // 动态环境有 harness（客户端-宿主桥）；静态环境没有 → 静默跳过 handler 注册
    const hh = (typeof harness !== 'undefined' && harness !== null && typeof harness.handle === 'function') ? harness : null
    function handle(method, fn) { if (hh !== null) hh.handle(method, fn) }

    // ---- 平台检测（v0.4.0）：harness 可注入覆盖（测试用），否则用 process.platform ----
    // 动态宿主沙箱可能没有 process 全局；检测失败时按 Windows 兼容路径处理（不响也不会崩）
    const PLATFORM = detectPlatform()
    function detectPlatform() {
      try {
        if (hh !== null && typeof hh.chimePlatformOverride === 'string' && hh.chimePlatformOverride !== '') return hh.chimePlatformOverride
      } catch (err) {}
      try {
        if (typeof process !== 'undefined' && process !== null && typeof process.platform === 'string' && process.platform !== '') return process.platform
      } catch (err) {}
      return null
    }

    // ---- 本地存储（fs 服务）：宿主蜂鸣开关 + 音频库（base64 文本） ----
    // 无 fs 服务（静态环境/测试缺省）时静默降级：开关仅内存、音频仅会话内
    const SETTINGS_FILE = 'dsh-chime-alerts-settings.json'
    const MANIFEST_FILE = 'dsh-chime-alerts-manifest.json'
    const B64_PREFIX = 'dsh-chime-alerts-audio-'
    let fsSvc = null
    // v0.5.3：惰性解析——首次实际用时才取 fs（apply 时可能尚未挂载）
    function getFs() {
      if (fsSvc !== null) return fsSvc
      fsSvc = fsService()
      return fsSvc
    }
    let dirPath = null
    let dirReady = false
    // 存储基准 = 沙箱 workspaceRoot。
    // workspace-write 沙箱只允许写工作区根/平台临时区；DSH 进程 cwd 在工作区外会被 FS_SANDBOX_DENIED 拒绝。
    let baseCwd = null
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp !== undefined && sp !== null && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') baseCwd = sp.workspaceRoot
    } catch (err) {}
    // v0.5.3：静态宿主半（无 harness 桥）固定使用 DSH 数据目录
    // %DSH_HOME%\plugins\dsh-chime-alerts（与动态插件旧目录一致，磁盘设置成为真源），
    // 并经 nodeIo（node:fs 直通车）读写——会话沙箱只允许写工作区根，绕过它写用户数据目录。
    let staticHomeRoot = null
    let staticNodeIo = null
    try {
      if (hh === null && nodeIo !== undefined && nodeIo !== null && nodeIo.isStatic === true) {
        const dhp = ctx.get('dshHomePath')
        if (typeof dhp === 'function') staticHomeRoot = dhp('plugins', 'dsh-chime-alerts')
        staticNodeIo = nodeIo
      }
    } catch (err) {}
    // v0.3.13：存储位置跟随 DSH 目录。
    // DSH 以管理员身份启动时进程 cwd=System32 → workspaceRoot 落在系统目录，不适合存用户数据；
    // 此时改用 DSH 数据目录 %USERPROFILE%\.dsh\plugins\dsh-chime-alerts（写入带 danger-full-access 重试）。
    const SYS_ROOT_RE = /^[a-zA-Z]:[\\/]windows([\\/]|$)/i
    const LINUX_SYS_ROOT_RE = /^\/(usr|etc|var|root|opt|srv|bin|sbin)(\/|$)/
    // v0.4.0：系统目录判定按平台（win32 仅 C:\Windows；其他平台 /usr /etc /var /root 等）
    function isSysRoot(p) {
      if (SYS_ROOT_RE.test(p)) return true
      if (PLATFORM === 'win32') return false
      return LINUX_SYS_ROOT_RE.test(p)
    }
    let userHomeCache = null
    async function resolveUserHome() {
      if (userHomeCache !== null) return userHomeCache
      try {
        const sub = ctx.get('subprocess')
        if (sub === undefined || typeof sub.spawn !== 'function') return null
        const isWin = PLATFORM !== 'linux' && PLATFORM !== 'darwin'
        const argv = isWin ? [WINDIR + '\\System32\\cmd.exe', '/d', '/c', 'echo %USERPROFILE%'] : ['sh', '-c', 'printf %s "$HOME"']
        const handle = sub.spawn({
          argv,
          cwd: isWin ? 'C:\\' : '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 512 } },
          graceMs: 5000
        })
        const res = await handle.done
        let text = ''
        try {
          if (handle.collected !== undefined && handle.collected !== null && handle.collected.stdout !== undefined && handle.collected.stdout !== null && typeof handle.collected.stdout.finalize === 'function') {
            text = handle.collected.stdout.finalize().text
          }
        } catch (err) {}
        text = String(text || '').trim()
        if (res.exitCode !== 0) return null
        if (isWin ? !/^[a-zA-Z]:[\\/]/u.test(text) : text === '' || text.charAt(0) !== '/') return null
        userHomeCache = text
        return text
      } catch (err) { return null }
    }
    let storageRootResolved = false
    async function resolveStorageRoot() {
      if (storageRootResolved) return baseCwd
      storageRootResolved = true
      // v0.5.3：静态宿主半固定使用 DSH 数据目录，跳过 workspaceRoot（会话沙箱）逻辑
      if (staticHomeRoot !== null) { baseCwd = staticHomeRoot; return baseCwd }
      try {
        if (baseCwd !== null && isSysRoot(baseCwd)) {
          const home = await resolveUserHome()
          if (home !== null) {
            baseCwd = PLATFORM === 'win32' ? home + '\\.dsh\\plugins\\dsh-chime-alerts' : home + '/.dsh/plugins/dsh-chime-alerts'
          }
        }
      } catch (err) {}
      return baseCwd
    }
    let legacyChecked = false
    // 迁移：旧版本把设置/音频写在系统目录（workspaceRoot），新版本搬到 DSH 数据目录后复制过来
    async function migrateLegacy() {
      if (legacyChecked || getFs() === null) return
      legacyChecked = true
      try {
        // v0.5.3：静态宿主半固定用 DSH 数据目录，不做 workspaceRoot 迁移
        if (staticHomeRoot !== null) return
        const sp = ctx.get('sandboxPolicy')
        const legacyRoot = (sp !== undefined && sp !== null && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') ? sp.workspaceRoot : null
        if (legacyRoot === null || baseCwd === null || legacyRoot === baseCwd) return
        if (!isSysRoot(legacyRoot)) return
        const ldir = await getFs().resolve('.', { cwd: legacyRoot })
        const lpath = getFs().processPath(ldir)
        let entries = []
        try {
          const listed = await getFs().listDir(ldir)
          if (Array.isArray(listed)) entries = listed
        } catch (err) {}
        for (const e of entries) {
          const name = (typeof e === 'string') ? e : (e !== undefined && e !== null && typeof e.name === 'string' ? e.name : null)
          if (name === null) continue
          if (name !== SETTINGS_FILE && name !== MANIFEST_FILE && !name.startsWith(B64_PREFIX)) continue
          try {
            const src = await getFs().resolve(name, { cwd: lpath })
            const txt = await getFs().readText(src)
            const dst = await getFs().resolve(name, { cwd: dirPath })
            await writeTextAny(dst, txt)
          } catch (err) {}
        }
      } catch (err) {}
    }
    async function ensureDir() {
      if (staticNodeIo !== null) {
        if (dirReady) return true
        await resolveStorageRoot()
        dirPath = baseCwd
        dirReady = true
        return true
      }
      if (getFs() === null) return false
      if (dirReady) return true
      try {
        await resolveStorageRoot()
        const base = await getFs().resolve('.', { cwd: baseCwd })
        dirPath = getFs().processPath(base)
        dirReady = true
        await migrateLegacy()
        return true
      } catch (err) { return false }
    }
    // v0.3.12：写入被 workspace-write 沙箱拒绝时，以插件自身数据文件身份带 danger-full-access 重试一次
    // （插件代码由用户亲自粘贴，只写 dsh-chime-alerts-* 前缀文件，可信；正常路径仍走沙箱）
    async function writeTextAny(target, content) {
      try {
        return await getFs().writeText(target, content)
      } catch (err) {
        try {
          return await getFs().writeText(target, content, undefined, undefined, { mode: 'danger-full-access' })
        } catch (err2) { throw err2 }
      }
    }
    // v0.6.1：损坏的 JSON 不再静默被覆盖 —— 读失败时暂存原文，下一次写盘前先另存一份
    // `<名>.corrupt-<时间戳>`，用户至少还能手工找回。
    let corruptText = null
    async function writeJsonRaw(name, text) {
      if (staticNodeIo !== null) {
        staticNodeIo.writeText(staticNodeIo.join(dirPath, name), text)
        return true
      }
      const target = await getFs().resolve(name, { cwd: dirPath })
      await writeTextAny(target, text)
      return true
    }
    async function readJson(name) {
      let txt = null
      try {
        if (!(await ensureDir())) return null
        // v0.5.3：静态模式经 node:fs 直读 DSH 数据目录（沙箱 fs 可读但写入受限，统一走直通车）
        if (staticNodeIo !== null) {
          const abs = staticNodeIo.join(dirPath, name)
          if (!staticNodeIo.exists(abs)) return null
          txt = staticNodeIo.readText(abs)
        } else {
          const target = await getFs().resolve(name, { cwd: dirPath })
          txt = await getFs().readText(target)
        }
        return JSON.parse(txt)
      } catch (err) {
        if (typeof txt === 'string' && txt !== '') corruptText = txt
        return null
      }
    }
    async function writeJson(name, obj) {
      try {
        if (!(await ensureDir())) return { ok: false, reason: 'no-fs' }
        if (corruptText !== null) {
          try { await writeJsonRaw(name + '.corrupt-' + String(Date.now()), corruptText) } catch (err) {}
          corruptText = null
        }
        await writeJsonRaw(name, JSON.stringify(obj))
        return { ok: true }
      } catch (err) { return { ok: false, reason: String((err && err.message) || err) } }
    }

    // ---- v0.4.1：宿主响铃能力检测（设置页据此把宿主蜂鸣控件变灰） ----
    let beepCapCache = null // null=未检测；boolean
    async function probeCmd(argv) {
      try {
        if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return false
        const h = subprocessSvc().spawn({
          argv,
          cwd: PLATFORM === 'win32' ? 'C:\\' : '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 512 }, stderr: { maxBytes: 256 } },
          graceMs: 3000
        })
        const res = await h.done
        return res.exitCode === 0
      } catch (err) { return false }
    }
    async function hostBeepCapable() {
      // v0.6.1：只缓存"能响"这个肯定结论。旧代码把首次探测的 false 永久缓存 —— 而
      // subprocess 服务常常在本插件之后才挂载，首个 sysget 探到 false 后整会话再也
      // 不会重探，设置页的宿主控件就一直是灰的（只能刷新页面）。
      if (beepCapCache === true) return true
      try {
        if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') { beepCapCache = false; return false }
        if (PLATFORM === 'linux') {
          beepCapCache = (await probeLinuxPlayer()) !== false
          return beepCapCache
        }
        if (PLATFORM === 'darwin') {
          beepCapCache = await probeCmd(['sh', '-c', 'command -v afplay'])
          return beepCapCache
        }
        // win32（或平台未知）：wscript.exe 在 PATH 中即支持
        beepCapCache = await probeCmd([WINDIR + '\\System32\\cmd.exe', '/d', '/c', 'where wscript'])
        return beepCapCache
      } catch (err) { beepCapCache = false; return false }
    }

    // ---- 客户端读取/写入宿主设置（宿主蜂鸣开关 hostBeep + 每事件宿主音 hostSounds）与音频库（async handler） ----
    // v0.6.0：设置读取统一走这里（动态 handler 与静态 HTTP 端点共用，避免两份解析漂移）
    function parseHostData(data) {
      const out = { hostBeep: null, hostSounds: {}, hostMuted: {}, eventModes: {}, notifyLevels: {} }
      if (data === null || typeof data !== 'object') return out
      if (typeof data.hostBeep === 'boolean') out.hostBeep = data.hostBeep
      if (data.hostSounds !== null && typeof data.hostSounds === 'object') {
        // 旧设置里可能残留非白名单值（v0.6.1 之前可写入），加载时直接丢弃 → 回落默认音
        for (const k of KIND_NAMES) if (allowedHostSound(data.hostSounds[k])) out.hostSounds[k] = data.hostSounds[k]
      }
      if (data.hostMuted !== null && typeof data.hostMuted === 'object') {
        for (const k of KIND_NAMES) if (data.hostMuted[k] === true) out.hostMuted[k] = true
      }
      if (data.eventModes !== null && typeof data.eventModes === 'object') {
        for (const k of KIND_NAMES) { const m = safeMode(data.eventModes[k]); if (m !== null) out.eventModes[k] = m }
      }
      if (data.notifyLevels !== null && typeof data.notifyLevels === 'object') {
        for (const k of KIND_NAMES) { const l = safeLevel(data.notifyLevels[k]); if (l !== null) out.notifyLevels[k] = l }
      }
      return out
    }
    function applyHostData(parsed) {
      if (parsed.hostBeep !== null) alwaysBeep = parsed.hostBeep
      hostSounds = parsed.hostSounds
      hostMuted = parsed.hostMuted
      hostModes = parsed.eventModes
      hostLevels = parsed.notifyLevels
    }
    function dumpHostSettings() {
      return { hostBeep: alwaysBeep, hostSounds, hostMuted, eventModes: hostModes, notifyLevels: hostLevels }
    }

    handle('sysget', async () => {
      const data = await readJson(SETTINGS_FILE)
      const parsed = parseHostData(data)
      const hostBeep = parsed.hostBeep
      applyHostData(parsed)
      const cap = await hostBeepCapable()
      const capNotify = await hostNotifyCapable()
      return {
        ok: getFs() !== null,
        hostBeep,
        hostSounds: parsed.hostSounds,
        hostMuted: parsed.hostMuted,
        eventModes: parsed.eventModes,
        notifyLevels: parsed.notifyLevels,
        dir: dirPath,
        platform: PLATFORM,
        capBeep: cap,
        capNotify
      }
    })

    // v0.6.0：写入时同时维护 eventModes 与派生的 hostMuted（旧客户端仍读 hostMuted）
    function mergeHostArgs(args) {
      const src = args !== null && typeof args === 'object' ? args : null
      const res = { touched: false, bad: false }
      if (src === null) { res.bad = true; return res }
      if (typeof src.hostBeep === 'boolean') { alwaysBeep = src.hostBeep; res.touched = true }
      if (src.hostSounds !== null && typeof src.hostSounds === 'object') {
        // v0.6.1：只接受白名单值（见 HOST_SOUND_WHITELIST）。此前这里只判类型，
        // 于是 /sysset 可以把任意字符串写进设置、再拼进 VBS 交 wscript 执行。
        for (const k of KIND_NAMES) if (allowedHostSound(src.hostSounds[k])) hostSounds[k] = src.hostSounds[k]
        res.touched = true
      }
      if (src.hostMuted !== null && typeof src.hostMuted === 'object') {
        for (const k of KIND_NAMES) {
          const was = hostMuted[k] === true
          if (src.hostMuted[k] === true) {
            hostMuted[k] = true
            hostModes[k] = 'off'
          } else {
            delete hostMuted[k]
            if (was) delete hostModes[k]
          }
        }
        res.touched = true
      }
      if (src.eventModes !== null && typeof src.eventModes === 'object') {
        for (const k of KIND_NAMES) {
          const m = safeMode(src.eventModes[k])
          if (m === null) continue
          hostModes[k] = m
          if (m === 'off') hostMuted[k] = true
          else delete hostMuted[k]
        }
        res.touched = true
      }
      if (src.notifyLevels !== null && typeof src.notifyLevels === 'object') {
        for (const k of KIND_NAMES) {
          const l = safeLevel(src.notifyLevels[k])
          if (l !== null) hostLevels[k] = l
        }
        res.touched = true
      }
      return res
    }
    handle('sysset', async (args) => {
      const merged = mergeHostArgs(args)
      if (merged.bad || !merged.touched) return { ok: false, reason: 'bad-args' }
      const out = await writeJson(SETTINGS_FILE, dumpHostSettings())
      if (!out.ok) return { ok: false, reason: out.reason }
      return { ok: true }
    })

    // v0.6.0：设置页「测试」按钮——按该事件的模式发一条宿主通知（或响一声），不走总开关
    // 0.6.0 修正：接受 level，让测试按钮忠实反映当前选中的等级（静默/重要），而不是只读宿主缓存
    handle('sysnotify', async (args) => {
      const kind = args !== null && typeof args === 'object' && typeof args.kind === 'string' ? args.kind : ''
      const level = args !== null && typeof args === 'object' ? args.level : undefined
      if (KIND_NAMES.indexOf(kind) < 0) return { ok: false, reason: 'unknown-kind' }
      if (!(await hostNotifyCapable())) return { ok: false, reason: 'no-capability' }
      notifyHost(kind, level)
      return { ok: true }
    })

    // ---- 音频库：上传进库（返回 id），所有事件下拉共享 ----
    let audioSeq = 0
    handle('saveaudio', async (args) => {
      const base64 = args !== null && typeof args === 'object' && typeof args.base64 === 'string' ? args.base64 : null
      const name = args !== null && typeof args === 'object' && typeof args.name === 'string' ? args.name : ''
      if (base64 === null) return { ok: false, reason: 'bad-args' }
      // v0.6.1：上传体积上限（约 8MB base64 ≈ 6MB 音频）。旧代码不限，一次调用可把磁盘填满。
      if (base64.length > 9 * 1024 * 1024) return { ok: false, reason: 'too-large' }
      try {
        if (!(await ensureDir())) return { ok: false, reason: 'no-fs' }
        audioSeq += 1
        const id = 'c' + Date.now().toString(36) + '-' + audioSeq
        const manifest = (await readJson(MANIFEST_FILE)) || {}
        if (typeof manifest !== 'object' || manifest === null) return { ok: false, reason: 'bad-manifest' }
        manifest[id] = { name: name.slice(0, 200), file: B64_PREFIX + id + '.b64' }
        if (staticNodeIo !== null) {
          const abs = staticNodeIo.join(dirPath, manifest[id].file)
          staticNodeIo.writeText(abs, base64)
        } else {
          const fileTarget = await getFs().resolve(manifest[id].file, { cwd: dirPath })
          await writeTextAny(fileTarget, base64)
        }
        const out = await writeJson(MANIFEST_FILE, manifest)
        if (!out.ok) return { ok: false, reason: out.reason }
        return { ok: true, id }
      } catch (err) { return { ok: false, reason: String((err && err.message) || err) } }
    })

    handle('loadall', async () => {
      try {
        if (!(await ensureDir())) return { ok: false }
        const manifest = await readJson(MANIFEST_FILE)
        const list = []
        if (manifest !== null && typeof manifest === 'object') {
          for (const id of Object.keys(manifest)) {
            const entry = manifest[id]
            if (entry !== null && typeof entry === 'object' && typeof entry.file === 'string') {
              list.push({ id, name: typeof entry.name === 'string' ? entry.name : '' })
            }
          }
        }
        return { ok: true, list }
      } catch (err) { return { ok: false } }
    })

    handle('loadaudio', async (args) => {
      const id = args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : null
      if (id === null) return { ok: false }
      try {
        if (!(await ensureDir())) return { ok: false }
        const manifest = await readJson(MANIFEST_FILE)
        const entry = manifest !== null && typeof manifest === 'object' ? manifest[id] : null
        if (entry === null || typeof entry !== 'object' || typeof entry.file !== 'string') return { ok: false }
        if (staticNodeIo !== null) {
          const abs = staticNodeIo.join(dirPath, entry.file)
          if (!staticNodeIo.exists(abs)) return { ok: false }
          return { ok: true, base64: staticNodeIo.readText(abs), name: typeof entry.name === 'string' ? entry.name : '' }
        }
        const fileTarget = await getFs().resolve(entry.file, { cwd: dirPath })
        const base64 = await getFs().readText(fileTarget)
        return { ok: true, base64, name: typeof entry.name === 'string' ? entry.name : '' }
      } catch (err) { return { ok: false } }
    })

    // 播种：把当前所有 agent 的状态记为“上一个状态”，插件安装时正在进行的回合结束后也能正确判定 running->idle
    try {
      const agents = ctx.get('agents')
      if (agents !== undefined && typeof agents.list === 'function') {
        for (const agent of agents.list()) {
          if (agent && typeof agent.id === 'string') prevStatus.set(agent.id, agent.status)
        }
      }
    } catch (err) {}

    // ---- 系统蜂鸣（v0.3.9）：wscript.exe + WMP 播放系统 wav，避开 PowerShell ----
    // 安全软件（如火绒「隐藏执行PowerShell」防护）会拦截 node → 隐藏 powershell.exe 链路并弹窗；
    // 改为：fs 写临时 .vbs → spawn wscript.exe 播放 Windows 自带音效 → 脚本播放完自删。
    // wscript 为 GUI 子系统（无窗口闪现），实测不被火绒拦截；无 fs 服务时静默降级（不响）。
    // v0.3.20：宿主音每事件可配置（hostSounds 存 settings.json），DEFAULT_WAV 为默认映射（更贴语义）。
    // v0.4.0：按平台取默认宿主音——win32 系统 wav / linux freedesktop 主题音 / darwin 系统音。
    // v0.6.1：系统目录不要写死 C:\Windows（系统盘不是 C: 或自定义 SystemRoot 时全部静默失效）
    const WINDIR = (function () {
      try {
        if (typeof process !== 'undefined' && process !== null && process.env &&
          typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== '') return process.env.SystemRoot
      } catch (err) {}
      return 'C:\\Windows'
    })()
    const WSCRIPT = WINDIR + '\\System32\\wscript.exe'
    const KIND_NAMES = ['complete', 'subcomplete', 'jobdone', 'approval', 'pluginapproval', 'question', 'planreview', 'goalblocked', 'interrupt', 'jobfail']
    const DEFAULT_WAV = {
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
    }
    // freedesktop 声音主题（/usr/share/sounds/freedesktop/stereo/<id>.oga，多数 Linux 桌面随
    // sound-theme-freedesktop 安装；canberra-gtk-play --id=<id> 直接按主题播放）
    const DEFAULT_LINUX_SOUND = {
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
    }
    // macOS 系统音（/System/Library/Sounds/*.aiff，afplay 播放）
    const DEFAULT_MAC_SOUND = {
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
    let hostSounds = {}
    let hostMuted = {}
    // v0.6.0：每事件宿主模式（off / beep / notify）与通知等级（silent / normal / important）。
    // hostMuted 保留为兼容字段：旧客户端仍按「每事件静音」读写它，modeOf() 会把它折算成 off。
    let hostModes = {}
    let hostLevels = {}
    const HOST_MODES = ['off', 'beep', 'notify']
    const NOTIFY_LEVELS = ['silent', 'normal', 'important']
    function safeMode(v) { return HOST_MODES.indexOf(v) >= 0 ? v : null }
    function safeLevel(v) { return NOTIFY_LEVELS.indexOf(v) >= 0 ? v : null }
    function modeOf(kind) {
      const m = hostModes[kind]
      if (m === 'off' || m === 'beep' || m === 'notify') return m
      return hostMuted[kind] === true ? 'off' : 'beep'
    }
    function levelOf(kind) { return safeLevel(hostLevels[kind]) || 'normal' }
    const KIND_TITLE = {
      complete: '任务完成',
      subcomplete: '子任务完成',
      jobdone: '后台任务完成',
      approval: '需要授权',
      pluginapproval: '插件授权',
      question: 'Agent 提问',
      planreview: '计划评审',
      goalblocked: '目标受阻',
      interrupt: '运行被打断',
      jobfail: '后台任务失败'
    }
    // ---- v0.6.1 安全修复：宿主音白名单 ----
    // 旧代码只检查 hostSounds[k] 是"非空字符串"，随后把值原样拼进 .vbs 脚本
    // （`p.URL = "C:\Windows\Media\<wav>"`）交给 wscript 执行；值里带 `"` + CRLF
    // 就能闭合字符串执行任意 VBScript。而 /sysset 端点当时没有任何鉴权，
    // 任意网页一次跨站 POST 即可把 payload 持久化进 settings.json，下一次提醒时执行。
    // 现在只接受设置页下拉里存在的值（与客户端 HOST_SOUND_OPTIONS* 保持一致），
    // 并额外用正则兜住扩展名与字符集（纵深防御，白名单被绕过时仍挡得住）。
    const HOST_SOUNDS_WIN = [
      'chimes.wav', 'ding.wav', 'Windows Ding.wav', 'Windows Default.wav',
      'Windows Notify System Generic.wav', 'Windows Notify Email.wav', 'Windows Notify Calendar.wav',
      'Windows Foreground.wav', 'Windows Background.wav', 'Windows Exclamation.wav', 'Windows Error.wav',
      'Windows Critical Stop.wav', 'Windows User Account Control.wav', 'Windows Hardware Insert.wav',
      'Windows Hardware Remove.wav', 'Windows Logon Sound.wav', 'Windows Logoff Sound.wav',
      'Windows Recycle.wav', 'Windows Ringout.wav'
    ]
    const HOST_SOUNDS_MAC = [
      'Glass.aiff', 'Ping.aiff', 'Pop.aiff', 'Tink.aiff', 'Sosumi.aiff', 'Hero.aiff', 'Purr.aiff',
      'Basso.aiff', 'Blow.aiff', 'Frog.aiff', 'Submarine.aiff'
    ]
    const HOST_SOUNDS_LINUX = [
      'complete', 'message', 'bell', 'dialog-information', 'dialog-question', 'dialog-warning',
      'dialog-error', 'service-login'
    ]
    const HOST_SOUND_WHITELIST = {
      win32: HOST_SOUNDS_WIN,
      darwin: HOST_SOUNDS_MAC,
      linux: HOST_SOUNDS_LINUX
    }
    // 平台未知（进程信息被沙箱遮蔽）时按并集放行，否则加载旧设置会全被丢掉
    const HOST_SOUND_ALL = HOST_SOUNDS_WIN.concat(HOST_SOUNDS_MAC, HOST_SOUNDS_LINUX)
    function allowedHostSound(v) {
      if (typeof v !== 'string' || v === '') return false
      const list = HOST_SOUND_WHITELIST[PLATFORM] || HOST_SOUND_ALL
      if (list.indexOf(v) < 0) return false
      // 决定性防线：不允许分隔符/引号/换行/上跳（Windows 名里有点号和空格，仍放行）
      if (v.indexOf('..') >= 0 || v.indexOf('/') >= 0 || v.indexOf('\\') >= 0) return false
      if (/["'\r\n\t]/.test(v)) return false
      return /^[A-Za-z0-9 ._-]+$/.test(v)
    }
    // 取某个事件实际要播的宿主音：白名单外一律回落默认值（旧脏数据自愈）
    function hostSoundFor(kind, defaults) {
      const want = hostSounds[kind]
      if (allowedHostSound(want)) return want
      return defaults[kind]
    }
    let beepSeq = 0
    async function writeBeepVbs(wav) {
      try {
        // v0.6.1：调用方已按白名单取值，这里再挡一次 —— 这段字符串会被 wscript 执行，
        // 任何来自设置的字节都不允许直接进入脚本（`"` + 换行即可闭合字符串）。
        if (!allowedHostSound(wav)) return null
        if (!(await ensureDir())) return null
        beepSeq += 1
        const name = 'dsh-chime-alerts-beep-' + String(Date.now()) + '-' + beepSeq + '.vbs'
        const content = 'Set p = CreateObject("WMPlayer.OCX")\r\n' +
          'p.URL = "C:\\Windows\\Media\\' + wav.replace(/"/g, '') + '"\r\n' +
          'p.controls.play()\r\n' +
          'WScript.Sleep 4000\r\n' +
          'Set f = CreateObject("Scripting.FileSystemObject")\r\n' +
          'f.DeleteFile WScript.ScriptFullName\r\n'
        // v0.5.4：静态宿主半的 vbs 写盘走 nodeIo 直通车（与设置文件同一通道）——
        // 沙箱 fs 对工作区外写入需 danger-full-access 重试且顺序不可控，直通车一步到位
        if (staticNodeIo !== null) {
          const abs = staticNodeIo.join(dirPath, name)
          staticNodeIo.writeText(abs, content)
          return abs
        }
        if (getFs() === null) return null
        const target = await getFs().resolve(name, { cwd: dirPath })
        await writeTextAny(target, content)
        return getFs().processPath(target)
      } catch (err) { return null }
    }
    // ---- v0.4.0：Linux/macOS 宿主蜂鸣（探测播放器 → 播放系统主题音） ----
    let linuxPlayer = null // null=未探测；'canberra' | 'paplay' | false
    let linuxPlayerAt = 0
    async function probeLinuxPlayer() {
      // v0.6.1：负结论 5s 后重探（与 hostBeepCapable 同理，服务晚挂载能自愈）
      if (linuxPlayer !== null && (linuxPlayer !== false || Date.now() - linuxPlayerAt < 5000)) return linuxPlayer
      linuxPlayerAt = Date.now()
      try {
        if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') { linuxPlayer = false; return false }
        for (const cmd of ['canberra-gtk-play', 'paplay']) {
          const h = subprocessSvc().spawn({
            argv: ['sh', '-c', 'command -v ' + cmd],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 256 } },
            graceMs: 3000
          })
          const res = await h.done
          if (res.exitCode === 0) {
            linuxPlayer = cmd === 'canberra-gtk-play' ? 'canberra' : 'paplay'
            return linuxPlayer
          }
        }
        linuxPlayer = false
        return false
      } catch (err) { linuxPlayer = false; return false }
    }
    // v0.6.1：统一的后台 spawn —— 失败的 promise 必须被吃掉，否则 unhandledRejection
    // 会把宿主的错误面板点亮（旧代码每处都是裸 spawn，.done 从不 catch）。
    function runDetached(argv, opts) {
      try {
        const svc = subprocessSvc()
        if (svc === undefined || typeof svc.spawn !== 'function') return null
        const spec = {
          argv: argv,
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 512 } },
          graceMs: 6000
        }
        if (opts !== undefined && opts !== null) {
          if (opts.cwd !== undefined) spec.cwd = opts.cwd
          if (opts.graceMs !== undefined) spec.graceMs = opts.graceMs
          if (opts.stdio !== undefined) spec.stdio = opts.stdio
        }
        const h = svc.spawn(spec)
        if (h !== null && h !== undefined && h.done !== undefined && h.done !== null &&
          typeof h.done.catch === 'function') h.done.catch(() => {})
        return h
      } catch (err) { return null }
    }
    // spawn 失败时把刚写下的临时脚本删掉（脚本自身的自删前提是它真的被跑起来了）
    function cleanupTemp(absPath) {
      try {
        if (staticNodeIo !== null && typeof staticNodeIo.rm === 'function') staticNodeIo.rm(absPath)
      } catch (err) {}
    }
    // freedesktop 主题的 id 与波形文件名不总是一一对应：Ubuntu 22.04 的 freedesktop 主题里
    // 只有 window-question.oga，没有 dialog-question.oga（Yaru 主题才有）。canberra 走主题查找
    // 所以能响，纯 paplay 回退会静默失败 —— 这里按别名再试一次。
    const LINUX_SOUND_DIR = '/usr/share/sounds/freedesktop/stereo/'
    const LINUX_FILE_ALIASES = { 'dialog-question': ['dialog-question', 'window-question'] }
    async function playLinuxFile(id) {
      const names = LINUX_FILE_ALIASES[id] || [id]
      for (const name of names) {
        const h = runDetached(['paplay', LINUX_SOUND_DIR + name + '.oga'], { cwd: '/' })
        if (h === null) return
        let res = null
        try { res = await h.done } catch (err) { return }
        if (res !== null && res !== undefined && res.exitCode === 0) return
      }
    }
    async function linuxBeep(kind) {
      const id = hostSoundFor(kind, DEFAULT_LINUX_SOUND)
      if (id === undefined) return
      const player = await probeLinuxPlayer()
      if (player === false) return
      try {
        if (player === 'canberra') {
          runDetached(['canberra-gtk-play', '--id=' + id], { cwd: '/' })
        } else {
          await playLinuxFile(id)
        }
      } catch (err) {}
    }
    function macBeep(kind) {
      const name = hostSoundFor(kind, DEFAULT_MAC_SOUND)
      if (name === undefined) return
      runDetached(['afplay', '/System/Library/Sounds/' + name], { cwd: '/' })
    }
    function beep(kind) {
      if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return
      if (PLATFORM === 'linux') { linuxBeep(kind).catch(() => {}); return }
      if (PLATFORM === 'darwin') { macBeep(kind); return }
      const wav = hostSoundFor(kind, DEFAULT_WAV)
      if (wav === undefined) return
      // fire-and-forget：写 vbs（异步）→ spawn wscript → vbs 播放后自删
      writeBeepVbs(wav).then((vbsPath) => {
        if (vbsPath === null) return
        const h = runDetached([WSCRIPT, vbsPath], { cwd: 'C:\\' })
        if (h === null) cleanupTemp(vbsPath)
      }).catch(() => {})
    }

    // ---- v0.6.0：宿主通知（Windows toast / macOS 通知中心 / Linux libnotify） ----
    // Windows：PowerShell + WinRT（ToastNotificationManager）。Node 不能直接调 WinRT，只能借
    //   powershell.exe 当桥——它是 `-WindowStyle Hidden` 隐藏跑的，一次只活几百毫秒。
    //   toast 的归属名（标题栏左侧那行）由 AUMID 决定，**与脚本语言无关**：优先借 DSH 自己
    //   的 AUMID，头部就显示「DeepSeek Harness」而不是「Windows PowerShell」。AUMID 是否
    //   有效用 `CreateToastNotifier(...).Setting` 判——未注册时它返回空字符串（实测），
    //   所以候选里 DSH 不在（改名/绿色版）会自动回退到 PowerShell 自己的注册项。
    //   脚本文件必须带 UTF-8 BOM：PowerShell 5.1 对无 BOM 的 .ps1 按系统 ANSI（中文机器是
    //   GBK）解析，中文标题会变成「浠诲姟瀹屾垚」这种乱码（实测对照见 tools/test-host.mjs）。
    // macOS：`osascript display notification`，系统内置；非静默等级带提示音。
    // Linux：`notify-send`（libnotify），等级映射为 low / normal / critical。
    // 能力探测失败时静默降级，并在 sysget 里回 capNotify=false，设置页会把「测试」按钮置灰。
    const PS_EXE = WINDIR + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const NOTIFY_AUMIDS = [
      'electron.app.DeepSeek Harness',
      '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    ]
    let notifCapCache = null
    let notifSeq = 0
    function xmlEsc(v) {
      return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    }
    function buildToastXml(title, level) {
      const scenario = level === 'important' ? ' scenario="urgent"' : ''
      let audio = ''
      if (level === 'silent') audio = '<audio silent="true"/>'
      else if (level === 'important') audio = '<audio src="ms-winsoundevent:Notification.Reminder"/>'
      // 归属名已经在标题栏（AUMID 决定），正文不再重复 "DeepSeek Harness"，只留事件标题一行
      return '<toast' + scenario + '><visual><binding template="ToastGeneric">' +
        '<text>' + xmlEsc(title) + '</text>' +
        '</binding></visual>' + audio + '</toast>'
    }
    // 候选 AUMID 逐个试：Setting 为空 = 该系统上没注册这个 AUMID，换下一个
    function aumidCandidatesScript() {
      const list = NOTIFY_AUMIDS.map((id) => "'" + id.replace(/'/g, "''") + "'").join(', ')
      return [
        '  $notifier = $null',
        '  foreach ($id in @(' + list + ')) {',
        '    try {',
        '      $cand = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)',
        '      if ("$($cand.Setting)" -ne "") { $notifier = $cand; break }',
        '    } catch {}',
        '  }',
        '  if ($notifier -ne $null) { $notifier.Show($toast) }'
      ]
    }
    async function writeToastPs1(kind, level) {
      try {
        if (!(await ensureDir())) return null
        notifSeq += 1
        const name = 'dsh-chime-alerts-toast-' + String(Date.now()) + '-' + notifSeq + '.ps1'
        const title = KIND_TITLE[kind] || kind
        const xml = buildToastXml(title, level)
        const content = [
          // BOM：没有它 PowerShell 5.1 按 GBK 解析脚本，中文标题变乱码
          '\uFEFF' + "$ErrorActionPreference = 'SilentlyContinue'",
          'try {',
          '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
          '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
          '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
          "  $xml.LoadXml(@'",
          xml,
          "'@)",
          '  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
          ...aumidCandidatesScript(),
          '  Start-Sleep -Milliseconds 200',
          '} catch {}',
          'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
          ''
        ].join('\r\n')
        if (staticNodeIo !== null) {
          const abs = staticNodeIo.join(dirPath, name)
          staticNodeIo.writeText(abs, content)
          return abs
        }
        if (getFs() === null) return null
        const target = await getFs().resolve(name, { cwd: dirPath })
        await writeTextAny(target, content)
        return getFs().processPath(target)
      } catch (err) { return null }
    }
    async function hostNotifyCapable() {
      // v0.6.1：同 hostBeepCapable，负结论不再永久缓存（服务晚挂载时能自愈）
      if (notifCapCache === true) return true
      try {
        if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') { notifCapCache = false; return false }
        if (PLATFORM === 'linux') { notifCapCache = await probeLinuxNotifier(); return notifCapCache }
        if (PLATFORM === 'darwin') { notifCapCache = await probeCmd(['sh', '-c', 'command -v osascript']); return notifCapCache }
        if (PLATFORM !== 'win32' && PLATFORM !== null) { notifCapCache = false; return false }
        notifCapCache = await probeCmd([PS_EXE, '-NoProfile', '-NonInteractive', '-Command', 'exit 0'])
        return notifCapCache
      } catch (err) { notifCapCache = false; return false }
    }
    function notifyHost(kind, levelIn) {
      const level = safeLevel(levelIn) || levelOf(kind)
      if (PLATFORM === 'linux') { linuxNotify(kind, level); return }
      if (PLATFORM === 'darwin') { macNotify(kind, level); return }
      if (PLATFORM !== 'win32' && PLATFORM !== null) return
      if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return
      writeToastPs1(kind, level).then((ps1Path) => {
        if (ps1Path === null) return
        const h = runDetached([PS_EXE, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1Path], { cwd: 'C:\\', graceMs: 12000 })
        if (h === null) cleanupTemp(ps1Path)
      }).catch(() => {})
    }

    // ---- Linux / macOS 通知（v0.6.0 补齐：此前只有 Windows 有系统通知，另两个平台选「通知」静默无效） ----
    // 与蜂鸣同一套「探测命令是否在 PATH → spawn → 不等待」形态，探测结果缓存一次。
    let linuxNotifier = null // null=未探测；true/false
    let linuxNotifierAt = 0
    async function probeLinuxNotifier() {
      if (linuxNotifier !== null && (linuxNotifier !== false || Date.now() - linuxNotifierAt < 5000)) return linuxNotifier
      linuxNotifierAt = Date.now()
      try {
        if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') { linuxNotifier = false; return false }
        const h = subprocessSvc().spawn({
          argv: ['sh', '-c', 'command -v notify-send'],
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 256 } },
          graceMs: 3000
        })
        const res = await h.done
        linuxNotifier = res.exitCode === 0
        return linuxNotifier
      } catch (err) { linuxNotifier = false; return false }
    }
    function linuxNotify(kind, level) {
      if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return
      const title = KIND_TITLE[kind] || kind
      // 等级 → freedesktop 紧急度：静默 low（不抢焦点、不进勿扰例外）、重要 critical
      const urgency = level === 'silent' ? 'low' : (level === 'important' ? 'critical' : 'normal')
      probeLinuxNotifier().then((ok) => {
        if (!ok) return
        try {
          subprocessSvc().spawn({
            argv: ['notify-send', '-a', 'DeepSeek Harness', '-u', urgency, title],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 512 } },
            graceMs: 6000
          })
        } catch (err) {}
      }).catch(() => {})
    }
    // AppleScript 字符串转义：反斜杠与双引号（标题里出现引号时不能把脚本弄断）
    function appleScriptQuote(v) {
      return '"' + String(v === undefined || v === null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }
    function macNotify(kind, level) {
      if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return
      const title = KIND_TITLE[kind] || kind
      let script = 'display notification ' + appleScriptQuote('DeepSeek Harness') + ' with title ' + appleScriptQuote(title)
      // macOS 没有「紧急」概念：静默等级不带提示音，其余带一声 Glass
      if (level !== 'silent') script += ' sound name "Glass"'
      try {
        subprocessSvc().spawn({
          argv: ['osascript', '-e', script],
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 512 } },
          graceMs: 6000
        })
      } catch (err) {}
    }

    // 节流按 种类+来源 独立：并行任务（不同 agent）各自都响，不会互相吞掉
    function record(kind, sessionId, tool, key) {
      const now = Date.now()
      const throttleKey = kind + ':' + (key != null ? key : (sessionId == null ? 'x' : sessionId))
      if (now - (lastAt.get(throttleKey) || 0) < 3000) return
      lastAt.set(throttleKey, now)
      if (lastAt.size > 300) { const first = lastAt.keys().next().value; lastAt.delete(first) }
      seq += 1
      const entry = { seq, kind, sessionId: sessionId == null ? null : String(sessionId), at: now }
      if (tool != null) entry.tool = String(tool)
      events.push(entry)
      if (events.length > 300) events.shift()
      // v0.5.8：浏览器快照拿不到的类别同时入静态队列（静态客户端轮询 /events 播放）
      if (CLIENT_PULL_KINDS.indexOf(kind) >= 0) {
        clientEvents.push(entry)
        if (clientEvents.length > 300) clientEvents.shift()
      }
      // v0.6.0：宿主侧按每事件模式分发——关 = 什么都不做；响铃 = 播宿主音；通知 = 弹 toast
      if (alwaysBeep) {
        const hostMode = modeOf(kind)
        if (hostMode === 'beep') beep(kind)
        else if (hostMode === 'notify') notifyHost(kind)
      }
    }

    // 归属查找：把子代理映射到它的运行时根（主会话），支持多层嵌套（深度上限 4）
    function rootOf(childId, depth) {
      try {
        const agents = ctx.get('agents')
        if (agents === undefined || typeof agents.list !== 'function' || typeof agents.isOwnedBy !== 'function') return null
        if (depth > 4) return null
        if (typeof agents.roots === 'function') {
          for (const root of agents.roots()) {
            if (root && typeof root.id === 'string' && agents.isOwnedBy(childId, root)) return root.id
          }
        }
        for (const a of agents.list()) {
          if (a && typeof a.id === 'string' && agents.isOwnedBy(childId, a)) {
            return rootOf(a.id, depth + 1)
          }
        }
      } catch (err) {}
      return null
    }

    // ---- 取本会话最后一条 turn/end 的结束原因（v0.5.8 契约修正） ----
    // 旧代码读 `agent.session.events`——**Session 类没有这个成员**（当前 DSH 只有
    // get surface / header / inheritedEventCount / firstLiveSeq / seq 与
    // eventAt() / snapshotEvents() / ownEvents()），所以 reason 恒为 undefined，
    // agent/status 处理器在 `if (reason === undefined) return` 处直接退出：
    // 任务完成 / 子任务完成 / 其他打断三类声音一次都不响。
    // 优先用 ownEvents()（无拷贝、覆盖本进程追加的事件，即刚结束的这一轮）；
    // 恢复/分叉会话里本进程首轮结束可能落在 inherited 段，此时回退
    // snapshotEvents()（继承+本进程，会拷贝整段日志，故只作兜底）。
    // 只回扫尾部 200 条：turn/end 必然在最近，避免长会话上全量遍历。
    function lastTurnEndReason(session) {
      if (session === undefined || session === null) return undefined
      const sources = []
      try { if (typeof session.ownEvents === 'function') sources.push(session.ownEvents()) } catch (err) {}
      try { if (typeof session.snapshotEvents === 'function') sources.push(session.snapshotEvents()) } catch (err) {}
      for (const evs of sources) {
        if (!Array.isArray(evs) || evs.length === 0) continue
        const from = evs.length > 200 ? evs.length - 200 : 0
        for (let i = evs.length - 1; i >= from; i--) {
          const ev = evs[i]
          if (ev && ev.type === 'turn/end') {
            const kind = ev.data && ev.data.reason ? ev.data.reason.kind : undefined
            if (typeof kind === 'string') return kind
          }
        }
      }
      return undefined
    }

    // ---- 需要授权：从会话日志检测（approval/request 瀑布会被 UI 应答器认领） ----
    // v0.5.8 修正（实测）：**按形状选，不按位置猜**。
    // 类型声明写的是 'session/event'(this: Scoped<Session>, session, event)，
    // 看起来 event 在第三个位置；但在真实运行时用探针实测 listener 只收到
    // **两个**实参：args[0]=Session、args[1]=SessionEvent（eventAt=[1]，argCounts={"2":n}）。
    // 因此位置推断法会翻车：声明 (session, event) 时 event=Session（旧代码的 bug），
    // 声明 (session, second, third) 时第三个恒为 undefined（又一次 bug）。
    // 这里改成遍历实参、挑出「有 string type + number seq」的那个作为事件，
    // 挑出「有 string id + append()」的那个作为 Session——两种布局都能工作。
    // 判别依据是关键：**Session 没有 `type` 字段，SessionEvent 有**（string）。
    // 不要用 `seq` 来判别——虽然类型上 SessionEvent 必有 seq，但用它当必要条件
    // 会让任何形状稍异的事件（或构造出来的样本）被整条丢弃。
    function isSessionEvent(v) {
      if (v === null || v === undefined || typeof v !== 'object') return false
      if (typeof v.type !== 'string') return false
      // SessionEvent 必带 data 载荷（可能为 null），Session 没有该字段
      return Object.prototype.hasOwnProperty.call(v, 'data')
    }
    function isSessionLike(v) {
      if (v === null || v === undefined || typeof v !== 'object') return false
      if (typeof v.append === 'function') return true
      if (typeof v.id === 'string' && typeof v.snapshotEvents === 'function') return true
      return false
    }
    ctx.on('session/event', function () {
      try {
        const args = Array.prototype.slice.call(arguments)
        let event = null
        let session = null
        for (const a of args) {
          if (event === null && isSessionEvent(a)) { event = a; continue }
          if (session === null && isSessionLike(a)) { session = a }
        }
        if (event === null) return
        const id = session !== null && typeof session.id === 'string' ? session.id : null
        if (event.type === 'approval/asked') {
          const tool = event.data && typeof event.data.toolName === 'string' ? event.data.toolName : undefined
          record('approval', id, tool)
        }
      } catch (err) {}
    })

    // ---- 目标受阻（v0.5.8）：改用 Cordis 事件 goal/changed（带 s） ----
    // 旧代码监听 'goal/change'——那是**会话日志事件**的名字（dsh-session 的
    // KNOWN_SESSION_EVENT_TYPES），不是 Cordis 事件，监听器永远不会被调用。
    // 真实契约：
    //   'goal/changed'(this: Scoped<Agent>, payload: { agent: Agent; change: GoalChanged })
    //   GoalChanged = { operation: 'create'|'edit'|'pause'|'resume'|'complete'|'block'|'clear';
    //                   ref: GoalRef; goal?: GoalView }
    //   GoalView.phase = 'active'|'paused'|'blocked'|'complete'
    // 判定沿用「operation=block 或 phase=blocked」，两者都兼容。
    ctx.on('goal/changed', (payload) => {
      try {
        if (payload === undefined || payload === null) return
        const change = payload.change
        if (change === undefined || change === null) return
        const op = typeof change.operation === 'string' ? change.operation : undefined
        const phase = change.goal !== undefined && change.goal !== null && typeof change.goal.phase === 'string'
          ? change.goal.phase
          : undefined
        if (op !== 'block' && phase !== 'blocked') return
        const agent = payload.agent
        const id = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : null
        record('goalblocked', id)
      } catch (err) {}
    })

    // ---- 任务完成 / 子任务完成 / 其他打断 ----
    ctx.on('agent/status', (payload) => {
      try {
        const agent = payload && payload.agent
        const status = payload && payload.status
        if (agent === undefined || typeof agent.id !== 'string') return
        const id = agent.id
        const prev = prevStatus.get(id)
        prevStatus.set(id, status)
        // v0.6.1：Map 只增不删会随历史会话无限增长
        if (prevStatus.size > 500) { const firstKey = prevStatus.keys().next().value; prevStatus.delete(firstKey) }
        if (status === 'running') {
          const t = debounceTimers.get(id)
          if (t) t()
          debounceTimers.delete(id)
          return
        }
        if (status !== 'idle' || prev !== 'running') return
        // 同步捕获：agent 此刻必然还在注册表中（防抖 800ms 后可能已被销毁）
        let origin
        try { origin = agent.session && agent.session.header ? agent.session.header.origin : undefined } catch (err) { origin = undefined }
        let hasPending = false
        try { hasPending = !!(agent.inbox && agent.inbox.hasPending) } catch (err) {}
        let reason
        try {
          // 主路径：payload.agent.session（ReactLoopAgent 上 session 是公开字段）
          reason = lastTurnEndReason(agent.session)
          // 兜底一：payload/session 直接挂在 payload 上（契约若改动仍能取到）
          if (reason === undefined) reason = lastTurnEndReason(payload && payload.session)
          // 兜底二：agents 服务按 id 查活 agent 再取 session
          if (reason === undefined) {
            const agents = ctx.get('agents')
            if (agents !== undefined && typeof agents.get === 'function') {
              const live = agents.get(id)
              if (live !== undefined && live !== null) reason = lastTurnEndReason(live.session)
            }
          }
        } catch (err) { reason = undefined }
        if (reason === undefined) return
        let ownerId = null
        if (origin === 'subagent') ownerId = rootOf(id, 0)
        const t = debounceTimers.get(id)
        if (t) t()
        debounceTimers.set(id, ctx.timeout(() => {
          debounceTimers.delete(id)
          if (origin === 'subagent') {
            // 归属映射失败时兜底用子代理自己的会话 id（“所有会话”范围仍能收到）
            const target = ownerId === null ? id : ownerId
            if (reason === 'completed') record('subcomplete', target, undefined, id)
            else record('interrupt', target, undefined, id)
            return
          }
          if (hasPending) return
          if (reason === 'completed') record('complete', id, undefined, id)
          else record('interrupt', id, undefined, id)
        }, 800))
      } catch (err) {}
    })

    // ---- Agent 提问 / 计划评审 ----
    // ask_user_question = 提问；exit_plan_mode = 计划评审（计划模式退出前请求批准）
    ctx.on('tools/execute', (exec, next) => {
      try {
        if (exec && typeof exec.name === 'string' && exec.agent && typeof exec.agent.id === 'string') {
          if (exec.name === 'ask_user_question') record('question', exec.agent.id, undefined, exec.agent.id)
          else if (exec.name === 'exit_plan_mode') record('planreview', exec.agent.id, 'exit_plan_mode', exec.agent.id)
        }
      } catch (err) {}
      return next()
    })

    // ---- 动态插件等待授权（v0.4.4）：cordis_run 的授权不经过 approval 服务
    // （不会产生 approval/asked 会话事件，实测全部授权事件只有工具授权），
    // 授权状态以工具返回文本 "awaiting user approval" 出现在 tool/result 事件中，
    // 因此监听 tools/result 命中后按 approval 事件发声。
    // v0.4.5：文本解析改为深度收集——真实运行时文本可能嵌在多层
    // content[].content[].text 中（会话日志形状），单层解析会漏。
    // v0.4.6：细分为独立事件 pluginapproval（设置页「需要人介入时」分组），
    // 与 approval 各拥有独立开关/声音/音量/宿主音/静音。 ----
    function collectText(value, out) {
      try {
        if (value === null || value === undefined) return
        const t = typeof value
        if (t === 'string') { out.push(value); return }
        if (t !== 'object') return
        if (typeof value.text === 'string') out.push(value.text)
        for (const k of Object.keys(value)) {
          if (k === 'text') continue
          collectText(value[k], out)
        }
      } catch (err) {}
    }
    ctx.on('tools/result', (exec, result) => {
      try {
        if (exec === null || exec === undefined || exec.name !== 'cordis_run') return
        if (exec.agent === null || exec.agent === undefined || typeof exec.agent.id !== 'string') return
        const parts = []
        collectText(result, parts)
        const text = parts.join(' ')
        if (/awaiting (user )?approval/i.test(text)) {
          let pluginId = ''
          try {
            const args = exec.arguments
            if (args !== null && typeof args === 'object' && typeof args.pluginId === 'string') pluginId = args.pluginId
          } catch (err) {}
          record('pluginapproval', exec.agent.id, 'cordis_run', 'cordis:' + (pluginId || exec.agent.id))
        }
      } catch (err) {}
    })

    // ---- 后台任务完成/失败（bash 等非代理作业；子代理由 agent/status 覆盖，跳过避免双响） ----
    // v0.5.4：jobs 服务在真实 web 树中可能晚于本条目挂载（apply 期 ctx.get 取不到，
    // 与 fs/subprocess 同一时序问题）；缺位时经 internal/service 延迟挂接，与
    // webServer 端点同形态（只等一次，挂上即撤监听）。
    // v0.5.8：jobs 服务有三代契约，必须都支持——
    //   旧（≤ DSH 0.1.7）：jobs.onJobDone((snapshot, owner) => …)
    //   中（部分 0.1.x 构建）：jobs.subscribe(filter, listener)
    //   新（DSH 0.2.0+）：注册表本身**没有** subscribe，事件流挂在属性上——
    //     jobs.events: JobEvents，即 jobs.events.subscribe(filter, listener)。
    //     实测（desktop 内嵌 dsh，经 cordis Service inspect 核对）：Registry 的方法只有
    //     start / list / get / read / readAt / kill / wait / remove / attachController。
    //   事件终止态是 { type: 'settled', job, cause, awaited }，
    //   job = { id, kind, owner?, status }，status ∈ running|stopping|completed|killed|failed
    // 只认旧契约时这几类宿主蜂鸣会静默失效——不报错、不响，最难排查的一种坏法。
    // v0.5.8 真机补充（两轮实测后的结论）：
    // `settled` 的 `awaited` 只能说明「结算时有人正在等」，**不足以区分前后台**——
    // 真机上 `run_in_background` 的作业结算时 `awaited` 同样为 true（0/1 两次都试过：
    // 只按 awaited 过滤会连真后台作业一起静默）。可用的行为判据是 `removed`：
    //   · 前台 bash/pwsh：工具内部 `wait()` 拿到结果后**立刻** `remove()`（工具源码里紧挨着）
    //   · 后台作业：结算后仍留在可见列表里（模型之后才用 job_output 读或 owner 销毁时移除）
    // 因此对 awaited 的结算先挂一个短延迟（1.5s），期间收到同 id 的 `removed` 就取消；
    // 没被移除 → 是真后台作业 → 提醒。awaited=false 的结算（无人等待）直接提醒。
    // 另附诊断环 `jobLog`（最近 80 条原始作业事件），随 /events 响应一起返回，便于再次排查。
    const JOB_CONFIRM_MS = 1500
    function subscribeJobEvents(jobs, onSettle) {
      const seenJobs = new Set()
      const pendingAlerts = new Map()
      function debugJob(ev) {
        try {
          jobLog.push({
            at: Date.now(),
            type: ev.type,
            id: ev.job !== undefined && ev.job !== null && ev.job.id !== undefined ? String(ev.job.id) : null,
            kind: ev.job !== undefined && ev.job !== null ? String(ev.job.kind) : null,
            status: ev.job !== undefined && ev.job !== null ? String(ev.job.status) : null,
            awaited: typeof ev.awaited === 'boolean' ? ev.awaited : null,
            cause: typeof ev.cause === 'string' ? ev.cause : null,
          })
          if (jobLog.length > 80) jobLog.shift()
        } catch (err) {}
      }
      function fireOnce(job, sid) {
        const jobId = job !== undefined && job !== null && typeof job.id === 'string' ? job.id : null
        if (jobId !== null) {
          if (seenJobs.has(jobId)) return
          if (seenJobs.size > 500) seenJobs.clear()
          seenJobs.add(jobId)
        }
        onSettle(job, sid)
      }
      const targets = [
        jobs, // 部分 0.1.x 构建
        jobs.events, // 0.2.0+：JobEvents 属性
      ]
      for (const target of targets) {
        if (target === undefined || target === null) continue
        if (typeof target.subscribe !== 'function') continue
        const off = target.subscribe({ owners: 'all' }, (ev) => {
          try {
            if (ev === undefined || ev === null) return
            debugJob(ev)
            const job = ev.job
            // 前台调用结算后立刻被移除：撤销待发提醒
            if (ev.type === 'removed') {
              const rid = job !== undefined && job !== null && typeof job.id === 'string' ? job.id : null
              if (rid !== null && pendingAlerts.has(rid)) {
                const cancel = pendingAlerts.get(rid)
                pendingAlerts.delete(rid)
                try { cancel() } catch (err) {}
              }
              return
            }
            if (ev.type !== 'settled') return
            if (job === undefined || job === null) return
            if (job.kind === 'subagent') return
            if (job.status !== 'completed' && job.status !== 'failed') return
            const sid = typeof job.owner === 'string' ? job.owner : null
            if (ev.awaited !== true) { fireOnce(job, sid); return }
            // awaited：可能是前台调用，短延迟确认它是否紧接着被 remove
            const jobId = typeof job.id === 'string' ? job.id : null
            if (jobId === null) return
            const cancelTimer = ctx.timeout(() => {
              pendingAlerts.delete(jobId)
              fireOnce(job, sid)
            }, JOB_CONFIRM_MS)
            pendingAlerts.set(jobId, cancelTimer)
          } catch (err) {}
        })
        return typeof off === 'function' ? off : () => {}
      }
      return null
    }
    // v0.5.8：作业「失败」的判定。真机与源码都确认：命令退出码非 0 **不算** failed——
    // dsh-tool-bash 的 processOutcome() 明确写着「A nonzero command exit is reported,
    // not failed, exactly like the foreground rendering」，只把 `exit code: N` 放进 detail；
    // status === 'failed' 只在生产端自身崩掉（如 spawn 失败）时出现。
    // 想让「后台任务失败」真的响，必须两种都认：status==='failed' 或 detail 里的非零退出码。
    function jobFailed(job) {
      try {
        if (job === undefined || job === null) return false
        if (job.status === 'failed') return true
        if (job.status !== 'completed') return false
        const detail = typeof job.detail === 'string' ? job.detail : ''
        const m = /exit code:\s*(-?\d+)/.exec(detail)
        if (m === null) return false
        return m[1] !== '0'
      } catch (err) { return false }
    }
    function attachJobs() {
      try {
        const jobs = ctx.get('jobs')
        if (jobs === undefined || jobs === null) return false
        if (typeof jobs.onJobDone === 'function') {
          const offLegacy = jobs.onJobDone((snapshot, owner) => {
            try {
              if (snapshot === undefined || snapshot === null) return
              const sid = owner && typeof owner.id === 'string' ? owner.id : (typeof snapshot.ownerSession === 'string' ? snapshot.ownerSession : null)
              if (snapshot.kind === 'subagent') return
              if (jobFailed(snapshot)) record('jobfail', sid, undefined, 'job:' + String(snapshot.id))
              else if (snapshot.status === 'completed') record('jobdone', sid, undefined, 'job:' + String(snapshot.id))
            } catch (err) {}
          })
          // v0.6.1：旧分支以前不保存 disposer，插件重载会重复注册 → 同一作业响两次
          if (typeof offLegacy === 'function') ctx.effect(() => () => { try { offLegacy() } catch (err) {} })
          return true
        }
        const off = subscribeJobEvents(jobs, (job, sid) => {
          if (jobFailed(job)) record('jobfail', sid, undefined, 'job:' + String(job.id))
          else record('jobdone', sid, undefined, 'job:' + String(job.id))
        })
        if (off === null) return false
        ctx.effect(() => () => { try { off() } catch (err) {} })
        return true
      } catch (err) { return false }
    }
    if (!attachJobs()) {
      const jobsWaiter = (name) => {
        if (name === 'jobs' && attachJobs()) {
          try { ctx.off('internal/service', jobsWaiter) } catch (err) {}
        }
      }
      ctx.on('internal/service', jobsWaiter)
      ctx.effect(() => () => { try { ctx.off('internal/service', jobsWaiter) } catch (err) {} })
    }

    // ---- 静态宿主半：启动自动读盘 + 无 harness 时的 HTTP 设置端点 ----
    // 静态环境不存在客户端-宿主 RPC 桥（harness 为 undefined），以往 sysget/sysset
    // 无人调用 → alwaysBeep 恒为 false、磁盘设置永远不生效。这里补两条通路：
    // 1) 启动时直接读 settings.json 恢复 alwaysBeep/hostSounds/hostMuted（磁盘为真源）；
    // 2) 注册 dsh webServer 的精简 REST 端点，让静态设置页直接读写宿主设置。
    // 端点注册沿用 dsh-liquid-glass-balance-card 的验证形态：webServer 可能在 apply
    // 之后才提供（internal/service 延迟监听），只等一次、注册后不再重复。
    (async () => {
      try {
        const data = await readJson(SETTINGS_FILE)
        if (data !== null && typeof data === 'object') {
          if (typeof data.hostBeep === 'boolean') { alwaysBeep = data.hostBeep }
          if (data.hostSounds !== null && typeof data.hostSounds === 'object') {
            // v0.6.1：启动加载同样走白名单（磁盘上可能残留旧版本写入的脏值）
            for (const k of KIND_NAMES) if (allowedHostSound(data.hostSounds[k])) hostSounds[k] = data.hostSounds[k]
          }
          if (data.hostMuted !== null && typeof data.hostMuted === 'object') {
            for (const k of KIND_NAMES) if (data.hostMuted[k] === true) hostMuted[k] = true
          }
          if (data.eventModes !== null && typeof data.eventModes === 'object') {
            for (const k of KIND_NAMES) { const m = safeMode(data.eventModes[k]); if (m !== null) hostModes[k] = m }
          }
          if (data.notifyLevels !== null && typeof data.notifyLevels === 'object') {
            for (const k of KIND_NAMES) { const l = safeLevel(data.notifyLevels[k]); if (l !== null) hostLevels[k] = l }
          }
        }
      } catch (err) {}
      // http 端点只在 DSH webServer 存在且无 harness 桥时注册（避免与动态桥重复）
      if (hh !== null) return
      const BODY_TOO_LARGE = { tooLarge: true }
      const readBody = async (req, res) => {
        try {
          const chunks = []
          let size = 0
          for await (const c of req) {
            size += c.length
            // v0.6.1：请求体上限。旧代码把任意长度的 body 全收进内存。
            if (size > 64 * 1024) {
              try { res.writeHead(413); res.end() } catch (err) {}
              return BODY_TOO_LARGE
            }
            chunks.push(c)
          }
          if (chunks.length === 0) return null
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (err) { return null }
      }
      // ---- v0.6.1 安全修复：路由准入 + 限流 ----
      // DSH 的 webServer 只按 pathname 派发（dsh-host-webserver 里没有任何 auth 钩子），
      // Host/Origin 校验与会话鉴权只做在 /api 通道上（dsh-client-connection）。插件自定义
      // 路由必须自己接 connection.requestRejection，否则任意网页一次跨站 POST 就能
      // 写设置（进而触发 VBS 注入链）或刷系统通知。没有 connection 服务时退回
      // 「Origin 必须与 Host 同源 + Host 必须是 loopback」的保守判定。
      let wsOriginHost = null
      const connectionSvc = () => {
        try {
          const c = ctx.get('connection')
          if (c !== undefined && c !== null && typeof c.requestRejection === 'function') return c
        } catch (err) {}
        return null
      }
      const hostOfHeader = (req) => {
        try {
          const raw = (req.headers && req.headers.host) ? String(req.headers.host) : ''
          return raw.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
        } catch (err) { return '' }
      }
      const originHostOf = (req) => {
        try {
          const o = (req.headers && req.headers.origin) ? String(req.headers.origin) : ''
          if (o === '' || o === 'null') return ''
          const u = new URL(o)
          return u.hostname.toLowerCase()
        } catch (err) { return '' }
      }
      const loopbackHost = (h) => h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1'
      // 0 = 放行；401/403 = 拒绝（照抄 DSH 的语义）
      const routeRejection = (req) => {
        const conn = connectionSvc()
        if (conn !== null) {
          try {
            const rej = conn.requestRejection({ headers: req.headers })
            if (rej === 401 || rej === 403) return rej
            return 0
          } catch (err) {}
        }
        const oh = originHostOf(req)
        const hhHost = hostOfHeader(req)
        if (oh !== '' && oh !== hhHost) return 403
        if (oh === '' && !loopbackHost(hhHost) && hhHost !== wsOriginHost) return 403
        return 0
      }
      const guard = (req, res) => {
        const rej = routeRejection(req)
        if (rej !== 0) {
          try { res.writeHead(rej, { 'cache-control': 'no-store' }); res.end() } catch (err) {}
          return false
        }
        return true
      }
      // 试听/测试端点限流：同事件 700ms、全局 10 次/10s。
      // 旧代码直接调 beep()/notifyHost()，绕过 record() 的 3s 节流，且每次
      // sysnotify 都起一个 powershell —— 被刷时就是通知轰炸 + 进程风暴。
      const actionAt = new Map()
      let actionWindow = []
      const actionAllowed = (kind) => {
        const now = Date.now()
        if (now - (actionAt.get(kind) || 0) < 700) return false
        actionWindow = actionWindow.filter((t) => now - t < 10000)
        if (actionWindow.length >= 10) return false
        actionAt.set(kind, now)
        if (actionAt.size > 64) { const first = actionAt.keys().next().value; actionAt.delete(first) }
        actionWindow.push(now)
        return true
      }
      const registerApi = (server) => {
        if (server === undefined || server === null || typeof server.register !== 'function') return
        try {
          if (typeof server.getOrigin === 'function') {
            const u = new URL(String(server.getOrigin()))
            wsOriginHost = u.hostname.toLowerCase()
          }
        } catch (err) {}
        ctx.effect(() => server.register({
          kind: 'exact',
          path: '/dsh-chime-alerts/sysget',
          handler: async (req, res) => {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
              if (!guard(req, res)) return
              const parsed = parseHostData(await readJson(SETTINGS_FILE))
              const cap = await hostBeepCapable()
              const capNotify = await hostNotifyCapable()
              const body = JSON.stringify({
                ok: getFs() !== null,
                hostBeep: parsed.hostBeep,
                hostSounds: parsed.hostSounds,
                hostMuted: parsed.hostMuted,
                eventModes: parsed.eventModes,
                notifyLevels: parsed.notifyLevels,
                dir: dirPath,
                platform: PLATFORM,
                capBeep: cap,
                capNotify
              })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(req.method === 'HEAD' ? '' : body)
            } catch (err) { res.writeHead(500); res.end() }
          }
        }))
        ctx.effect(() => server.register({
          kind: 'exact',
          path: '/dsh-chime-alerts/sysset',
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              if (!guard(req, res)) return
              const args = await readBody(req, res)
              if (args === BODY_TOO_LARGE) return
              const merged = mergeHostArgs(args)
              if (merged.bad || !merged.touched) { res.writeHead(400); res.end(JSON.stringify({ ok: false, reason: 'bad-args' })); return }
              const out = await writeJson(SETTINGS_FILE, dumpHostSettings())
              res.writeHead(out.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(JSON.stringify(out))
            } catch (err) { res.writeHead(500); res.end() }
          }
        }))
        // v0.5.5：宿主试听端点——静态设置页的「宿主试听」按钮 POST {kind}，宿主即播该事件
        // 当前配置的宿主音（与 record 的 beep 同一路径，不依赖宿主蜂鸣总开关）
        ctx.effect(() => server.register({
          kind: 'exact',
          path: '/dsh-chime-alerts/sysbeep',
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              if (!guard(req, res)) return
              const args = await readBody(req, res)
              if (args === BODY_TOO_LARGE) return
              const kind = args !== null && typeof args === 'object' && typeof args.kind === 'string' ? args.kind : ''
              if (KIND_NAMES.indexOf(kind) < 0) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'unknown-kind' }))
                return
              }
              if (!actionAllowed(kind)) {
                res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'rate-limited' }))
                return
              }
              if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'no-subprocess' }))
                return
              }
              beep(kind)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(JSON.stringify({ ok: true }))
            } catch (err) { res.writeHead(500); res.end() }
          }
        }))
        // 0.6.0 修正：设置页「测试」按钮的静态端点。首版只给动态桥补了 handle('sysnotify')，
        // 忘了给静态 HTTP 半注册路由——静态版点「测试」POST 到不存在的路径，服务器回 405，
        // 表现就是「点了没反应」。形状照抄 sysbeep：仅 POST、校验 kind、按能力门降级。
        ctx.effect(() => server.register({
          kind: 'exact',
          path: '/dsh-chime-alerts/sysnotify',
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
              if (!guard(req, res)) return
              const args = await readBody(req, res)
              if (args === BODY_TOO_LARGE) return
              const kind = args !== null && typeof args === 'object' && typeof args.kind === 'string' ? args.kind : ''
              const level = args !== null && typeof args === 'object' ? args.level : undefined
              if (KIND_NAMES.indexOf(kind) < 0) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'unknown-kind' }))
                return
              }
              if (!actionAllowed(kind)) {
                res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'rate-limited' }))
                return
              }
              if (!(await hostNotifyCapable())) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
                res.end(JSON.stringify({ ok: false, reason: 'no-capability' }))
                return
              }
              notifyHost(kind, level)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
              res.end(JSON.stringify({ ok: true }))
            } catch (err) { res.writeHead(500); res.end() }
          }
        }))
        // v0.5.8：事件拉取端点——静态客户端（无 harness 桥）唯一的「宿主→浏览器」通道。
        // 静态客户端原来从 sessions 快照读 `row.pendingInteraction`，但当前 DSH 的
        // SessionSummary 没有该字段（它由 dsh-client-ui-session 单独维护，只经 slot 的
        // useSessionPendingInteraction prop 暴露），于是「需要授权 / Agent 提问 /
        // 计划评审」三类在浏览器侧永远不响。宿主半已经正确检测到这三类（session/event
        // 的 approval/asked、tools/execute 的 ask_user_question / exit_plan_mode），
        // 以及快照拿不到的「插件授权」（tools/result），因此把它们经本端点交给浏览器。
        // 只有 CLIENT_PULL_KINDS 入队（上述四类 + jobdone/jobfail 快照已失效的两类）：
        // complete/subcomplete/goalblocked 仍由浏览器快照自行检测，避免同一事件双响。
        ctx.effect(() => server.register({
          kind: 'exact',
          path: '/dsh-chime-alerts/events',
          handler: (req, res) => {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
              if (!guard(req, res)) return
              let after = 0
              try {
                const q = String(req.url || '')
                const m = /[?&]after=(\d+)/.exec(q)
                if (m !== null) after = Number(m[1])
                if (!isFinite(after) || after < 0) after = 0
              } catch (err) { after = 0 }
              const out = []
              for (const ev of clientEvents) {
                if (ev.seq > after) out.push(ev)
                if (out.length >= 50) break
              }
              const lastSeq = clientEvents.length > 0 ? clientEvents[clientEvents.length - 1].seq : 0
              const body = JSON.stringify({ ok: true, boot: boot, seq: lastSeq, events: out, kinds: CLIENT_PULL_KINDS, jobLog: jobLog })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(req.method === 'HEAD' ? '' : body)
            } catch (err) { res.writeHead(500); res.end() }
          }
        }))
      }
      let regDone = false
      const doRegister = (server) => {
        if (regDone) return
        regDone = true
        registerApi(server)
      }
      try {
        const web = ctx.get('webServer') ?? ctx.get('httpServer')
        if (web !== undefined && web !== null) { doRegister(web); return }
      } catch (err) {}
      const listener = (serviceName) => {
        try {
          if (serviceName === 'webServer' || serviceName === 'httpServer') {
            doRegister(ctx.get(serviceName))
          }
        } catch (err) {}
      }
      ctx.on('internal/service', listener)
      ctx.effect(() => () => { try { ctx.off('internal/service', listener) } catch (err) {} })
    })().catch(() => {})

    // ---- 客户端拉取：固定监听所有会话（v0.3.8 起不再有“声音范围”选项，按工作区静音） ----
    handle('pull', (args) => {
      const after = args && typeof args.after === 'number' ? args.after : 0
      const out = []
      for (const ev of events) {
        if (ev.seq > after) out.push(ev)
        if (out.length >= 50) break
      }
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0
      return { boot, seq: lastSeq, events: out }
    })

    // ---- 宿主常驻蜂鸣：v0.3.11 起由 sysset(hostBeep) 统一维护，此 handler 保留兼容旧客户端 ----
    handle('setalways', (args) => {
      alwaysBeep = !!(args && args.enabled === true)
      return { ok: true, alwaysBeep }
    })

    handle('sysbeep', (args) => {
      const kind = args && typeof args.kind === 'string' ? args.kind : ''
      if (KIND_NAMES.indexOf(kind) < 0) return { ok: false, reason: 'unknown-kind' }
      if (subprocessSvc() === undefined || typeof subprocessSvc().spawn !== 'function') return { ok: false, reason: 'no-subprocess' }
      beep(kind)
      return { ok: true }
    })
  }
}
}
