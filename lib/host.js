// ============================================================
// dsh-chime-alerts · 宿主半（Host half）— v0.3.21
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
// ============================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    let boot = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    let seq = 0
    let alwaysBeep = false
    const lastAt = new Map()
    const events = []
    const prevStatus = new Map()
    const debounceTimers = new Map()

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
    try {
      const f = ctx.get('fs')
      if (f !== undefined && f !== null &&
        typeof f.resolve === 'function' && typeof f.processPath === 'function' &&
        typeof f.readText === 'function' && typeof f.writeText === 'function') fsSvc = f
    } catch (err) {}
    let dirPath = null
    let dirReady = false
    // 存储基准 = 沙箱 workspaceRoot。
    // workspace-write 沙箱只允许写工作区根/平台临时区；DSH 进程 cwd 在工作区外会被 FS_SANDBOX_DENIED 拒绝。
    let baseCwd = null
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp !== undefined && sp !== null && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') baseCwd = sp.workspaceRoot
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
        const argv = isWin ? ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'echo %USERPROFILE%'] : ['sh', '-c', 'printf %s "$HOME"']
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
      if (legacyChecked || fsSvc === null) return
      legacyChecked = true
      try {
        const sp = ctx.get('sandboxPolicy')
        const legacyRoot = (sp !== undefined && sp !== null && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') ? sp.workspaceRoot : null
        if (legacyRoot === null || baseCwd === null || legacyRoot === baseCwd) return
        if (!isSysRoot(legacyRoot)) return
        const ldir = await fsSvc.resolve('.', { cwd: legacyRoot })
        const lpath = fsSvc.processPath(ldir)
        let entries = []
        try {
          const listed = await fsSvc.listDir(ldir)
          if (Array.isArray(listed)) entries = listed
        } catch (err) {}
        for (const e of entries) {
          const name = (typeof e === 'string') ? e : (e !== undefined && e !== null && typeof e.name === 'string' ? e.name : null)
          if (name === null) continue
          if (name !== SETTINGS_FILE && name !== MANIFEST_FILE && !name.startsWith(B64_PREFIX)) continue
          try {
            const src = await fsSvc.resolve(name, { cwd: lpath })
            const txt = await fsSvc.readText(src)
            const dst = await fsSvc.resolve(name, { cwd: dirPath })
            await writeTextAny(dst, txt)
          } catch (err) {}
        }
      } catch (err) {}
    }
    async function ensureDir() {
      if (fsSvc === null) return false
      if (dirReady) return true
      try {
        await resolveStorageRoot()
        const base = await fsSvc.resolve('.', { cwd: baseCwd })
        dirPath = fsSvc.processPath(base)
        dirReady = true
        await migrateLegacy()
        return true
      } catch (err) { return false }
    }
    // v0.3.12：写入被 workspace-write 沙箱拒绝时，以插件自身数据文件身份带 danger-full-access 重试一次
    // （插件代码由用户亲自粘贴，只写 dsh-chime-alerts-* 前缀文件，可信；正常路径仍走沙箱）
    async function writeTextAny(target, content) {
      try {
        return await fsSvc.writeText(target, content)
      } catch (err) {
        try {
          return await fsSvc.writeText(target, content, undefined, undefined, { mode: 'danger-full-access' })
        } catch (err2) { throw err2 }
      }
    }
    async function readJson(name) {
      try {
        if (!(await ensureDir())) return null
        const target = await fsSvc.resolve(name, { cwd: dirPath })
        const txt = await fsSvc.readText(target)
        return JSON.parse(txt)
      } catch (err) { return null }
    }
    async function writeJson(name, obj) {
      try {
        if (!(await ensureDir())) return { ok: false, reason: 'no-fs' }
        const target = await fsSvc.resolve(name, { cwd: dirPath })
        await writeTextAny(target, JSON.stringify(obj))
        return { ok: true }
      } catch (err) { return { ok: false, reason: String((err && err.message) || err) } }
    }

    // ---- v0.4.1：宿主响铃能力检测（设置页据此把宿主蜂鸣控件变灰） ----
    let beepCapCache = null // null=未检测；boolean
    async function probeCmd(argv) {
      try {
        if (subprocess === undefined || typeof subprocess.spawn !== 'function') return false
        const h = subprocess.spawn({
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
      if (beepCapCache !== null) return beepCapCache
      try {
        if (subprocess === undefined || typeof subprocess.spawn !== 'function') { beepCapCache = false; return false }
        if (PLATFORM === 'linux') {
          beepCapCache = (await probeLinuxPlayer()) !== false
          return beepCapCache
        }
        if (PLATFORM === 'darwin') {
          beepCapCache = await probeCmd(['sh', '-c', 'command -v afplay'])
          return beepCapCache
        }
        // win32（或平台未知）：wscript.exe 在 PATH 中即支持
        beepCapCache = await probeCmd(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'where wscript'])
        return beepCapCache
      } catch (err) { beepCapCache = false; return false }
    }

    // ---- 客户端读取/写入宿主设置（宿主蜂鸣开关 hostBeep + 每事件宿主音 hostSounds）与音频库（async handler） ----
    handle('sysget', async () => {
      const data = await readJson(SETTINGS_FILE)
      let hostBeep = null
      const hs = {}
      const hm = {}
      if (data !== null && typeof data === 'object') {
        if (typeof data.hostBeep === 'boolean') {
          hostBeep = data.hostBeep
          alwaysBeep = hostBeep
        }
        if (data.hostSounds !== null && typeof data.hostSounds === 'object') {
          for (const k of KIND_NAMES) {
            if (typeof data.hostSounds[k] === 'string' && data.hostSounds[k] !== '') hs[k] = data.hostSounds[k]
          }
        }
        if (data.hostMuted !== null && typeof data.hostMuted === 'object') {
          for (const k of KIND_NAMES) {
            if (data.hostMuted[k] === true) hm[k] = true
          }
        }
      }
      hostSounds = hs
      hostMuted = hm
      const cap = await hostBeepCapable()
      return { ok: fsSvc !== null, hostBeep, hostSounds: hs, hostMuted: hm, dir: dirPath, platform: PLATFORM, capBeep: cap }
    })

    handle('sysset', async (args) => {
      const hostBeep = args !== null && typeof args === 'object' && typeof args.hostBeep === 'boolean' ? args.hostBeep : null
      const hsIn = args !== null && typeof args === 'object' && args.hostSounds !== null && typeof args.hostSounds === 'object' ? args.hostSounds : null
      const hmIn = args !== null && typeof args === 'object' && args.hostMuted !== null && typeof args.hostMuted === 'object' ? args.hostMuted : null
      if (hostBeep === null && hsIn === null && hmIn === null) return { ok: false, reason: 'bad-args' }
      if (hostBeep !== null) alwaysBeep = hostBeep
      if (hsIn !== null) {
        for (const k of KIND_NAMES) {
          if (typeof hsIn[k] === 'string' && hsIn[k] !== '') hostSounds[k] = hsIn[k]
        }
      }
      if (hmIn !== null) {
        for (const k of KIND_NAMES) {
          if (hmIn[k] === true) hostMuted[k] = true
          else delete hostMuted[k]
        }
      }
      const out = await writeJson(SETTINGS_FILE, { hostBeep: alwaysBeep, hostSounds, hostMuted })
      if (!out.ok) return { ok: false, reason: out.reason }
      return { ok: true }
    })

    // ---- 音频库：上传进库（返回 id），所有事件下拉共享 ----
    let audioSeq = 0
    handle('saveaudio', async (args) => {
      const base64 = args !== null && typeof args === 'object' && typeof args.base64 === 'string' ? args.base64 : null
      const name = args !== null && typeof args === 'object' && typeof args.name === 'string' ? args.name : ''
      if (base64 === null) return { ok: false, reason: 'bad-args' }
      try {
        if (!(await ensureDir())) return { ok: false, reason: 'no-fs' }
        audioSeq += 1
        const id = 'c' + Date.now().toString(36) + '-' + audioSeq
        const manifest = (await readJson(MANIFEST_FILE)) || {}
        if (typeof manifest !== 'object' || manifest === null) return { ok: false, reason: 'bad-manifest' }
        manifest[id] = { name: name.slice(0, 200), file: B64_PREFIX + id + '.b64' }
        const fileTarget = await fsSvc.resolve(manifest[id].file, { cwd: dirPath })
        await writeTextAny(fileTarget, base64)
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
        const fileTarget = await fsSvc.resolve(entry.file, { cwd: dirPath })
        const base64 = await fsSvc.readText(fileTarget)
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
    const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe'
    const KIND_NAMES = ['complete', 'subcomplete', 'jobdone', 'approval', 'question', 'planreview', 'goalblocked', 'interrupt', 'jobfail']
    const DEFAULT_WAV = {
      complete: 'Windows Notify System Generic.wav',
      subcomplete: 'ding.wav',
      jobdone: 'Windows Notify System Generic.wav',
      approval: 'Windows User Account Control.wav',
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
      question: 'Tink.aiff',
      planreview: 'Sosumi.aiff',
      goalblocked: 'Basso.aiff',
      interrupt: 'Blow.aiff',
      jobfail: 'Sosumi.aiff'
    }
    let hostSounds = {}
    let hostMuted = {}
    let beepSeq = 0
    async function writeBeepVbs(wav) {
      if (fsSvc === null) return null
      try {
        if (!(await ensureDir())) return null
        beepSeq += 1
        const name = 'dsh-chime-alerts-beep-' + String(Date.now()) + '-' + beepSeq + '.vbs'
        const content = 'Set p = CreateObject("WMPlayer.OCX")\r\n' +
          'p.URL = "C:\\Windows\\Media\\' + wav + '"\r\n' +
          'p.controls.play()\r\n' +
          'WScript.Sleep 4000\r\n' +
          'Set f = CreateObject("Scripting.FileSystemObject")\r\n' +
          'f.DeleteFile WScript.ScriptFullName\r\n'
        const target = await fsSvc.resolve(name, { cwd: dirPath })
        await writeTextAny(target, content)
        return fsSvc.processPath(target)
      } catch (err) { return null }
    }
    // ---- v0.4.0：Linux/macOS 宿主蜂鸣（探测播放器 → 播放系统主题音） ----
    let linuxPlayer = null // null=未探测；'canberra' | 'paplay' | false
    async function probeLinuxPlayer() {
      if (linuxPlayer !== null) return linuxPlayer
      try {
        if (subprocess === undefined || typeof subprocess.spawn !== 'function') { linuxPlayer = false; return false }
        for (const cmd of ['canberra-gtk-play', 'paplay']) {
          const h = subprocess.spawn({
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
    async function linuxBeep(kind) {
      const id = hostSounds[kind] || DEFAULT_LINUX_SOUND[kind]
      if (id === undefined) return
      const player = await probeLinuxPlayer()
      if (player === false) return
      try {
        if (player === 'canberra') {
          subprocess.spawn({
            argv: ['canberra-gtk-play', '--id=' + id],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
            graceMs: 6000
          })
        } else {
          subprocess.spawn({
            argv: ['paplay', '/usr/share/sounds/freedesktop/stereo/' + id + '.oga'],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
            graceMs: 6000
          })
        }
      } catch (err) {}
    }
    function macBeep(kind) {
      const name = hostSounds[kind] || DEFAULT_MAC_SOUND[kind]
      if (name === undefined) return
      try {
        subprocess.spawn({
          argv: ['afplay', '/System/Library/Sounds/' + name],
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
          graceMs: 6000
        })
      } catch (err) {}
    }
    function beep(kind) {
      if (subprocess === undefined || typeof subprocess.spawn !== 'function') return
      if (PLATFORM === 'linux') { linuxBeep(kind).catch(() => {}); return }
      if (PLATFORM === 'darwin') { macBeep(kind); return }
      const wav = hostSounds[kind] || DEFAULT_WAV[kind]
      if (wav === undefined) return
      // fire-and-forget：写 vbs（异步）→ spawn wscript → vbs 播放后自删
      writeBeepVbs(wav).then((vbsPath) => {
        if (vbsPath === null) return
        try {
          subprocess.spawn({
            argv: [WSCRIPT, vbsPath],
            cwd: 'C:\\',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 256 }, stderr: { maxBytes: 256 } },
            graceMs: 6000
          })
        } catch (err) {}
      }).catch(() => {})
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
      // v0.4.2：每事件独立静音宿主音（主行静音键只关浏览器音，hostMuted 单独关宿主音）
      if (alwaysBeep && !(hostMuted[kind] === true)) beep(kind)
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

    // ---- 需要授权 / 目标受阻：从会话日志检测（approval/request 瀑布会被 UI 应答器认领） ----
    ctx.on('session/event', (session, event) => {
      try {
        if (session === undefined || event === undefined) return
        const id = typeof session.id === 'string' ? session.id : null
        if (event.type === 'approval/asked') {
          const tool = event.data && typeof event.data.toolName === 'string' ? event.data.toolName : undefined
          record('approval', id, tool)
          return
        }
        // goal/change：operation=block（或 goal.phase=blocked）即目标受阻
        if (event.type === 'goal/change') {
          const data = event.data
          const op = data && typeof data.operation === 'string' ? data.operation : undefined
          const phase = data && data.goal && typeof data.goal.phase === 'string' ? data.goal.phase : undefined
          if (op === 'block' || phase === 'blocked') record('goalblocked', id)
        }
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
          const evs = agent.session ? agent.session.events : undefined
          if (Array.isArray(evs)) {
            for (let i = evs.length - 1; i >= 0; i--) {
              const ev = evs[i]
              if (ev && ev.type === 'turn/end') {
                reason = ev.data && ev.data.reason ? ev.data.reason.kind : undefined
                break
              }
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

    // ---- 后台任务完成/失败（bash 等非代理作业；子代理由 agent/status 覆盖，跳过避免双响） ----
    const jobs = ctx.get('jobs')
    if (jobs !== undefined && typeof jobs.onJobDone === 'function') {
      jobs.onJobDone((snapshot, owner) => {
        try {
          if (snapshot === undefined || snapshot === null) return
          if (snapshot.kind === 'subagent') return
          const sid = owner && typeof owner.id === 'string' ? owner.id : (typeof snapshot.ownerSession === 'string' ? snapshot.ownerSession : null)
          if (snapshot.status === 'failed') record('jobfail', sid, undefined, 'job:' + String(snapshot.id))
          else if (snapshot.status === 'completed') record('jobdone', sid, undefined, 'job:' + String(snapshot.id))
        } catch (err) {}
      })
    }

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
      if (subprocess === undefined || typeof subprocess.spawn !== 'function') return { ok: false, reason: 'no-subprocess' }
      beep(kind)
      return { ok: true }
    })
  }
}
