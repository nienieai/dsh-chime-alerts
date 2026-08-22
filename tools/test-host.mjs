// 宿主半逻辑冒烟测试：node tools/test-host.mjs（Node 可跑，无需 DSH）
// 用假 ctx / harness 驱动 host.js，断言九类事件的检测、节流、拉取过滤与蜂鸣。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8')

let failures = 0
const ok = (cond, label) => {
  if (cond) console.log('PASS', label)
  else { failures++; console.log('FAIL', label) }
}

function makeEnv(opts = {}) {
  const listeners = {}
  const handlers = {}
  const spawns = []
  const jobDoneFns = []
  const fsFiles = new Map()
  const fsMock = {
    resolve: async (path, opts2) => ({ key: 't:' + (opts2 && opts2.cwd ? opts2.cwd + '/' : '') + path }),
    processPath: (t) => t.key.slice(2),
    readText: async (t) => { const v = fsFiles.get(t.key); if (v === undefined) throw new Error('ENOENT'); return v },
    writeText: async (t, content) => { fsFiles.set(t.key, content); return { version: 1 } },
    listDir: async () => [],
  }
  const agentsList = [
    { id: 'root', status: 'idle' },
    { id: 'sub1', status: 'idle' },
  ]
  const ctx = {
    get(name) {
      if (name === 'subprocess') {
        if (opts.noSubprocess) return undefined
        return {
          spawn: (spOpts) => {
            spawns.push(spOpts)
            const argv0 = spOpts.argv && spOpts.argv[0]
            if (spOpts.argv && argv0 && argv0.indexOf('cmd.exe') >= 0) {
              return {
                done: Promise.resolve({ exitCode: 0 }),
                collected: { stdout: { finalize: () => ({ text: opts.userProfileText ?? 'C:\\Users\\ns' }) } },
              }
            }
            if (argv0 === 'sh') {
              const c = spOpts.argv[2] || ''
              if (c.indexOf('command -v') >= 0) {
                const probeOk = c.indexOf('canberra-gtk-play') >= 0 ? (opts.canberraProbe !== false) : (opts.paplayProbe !== false)
                return { done: Promise.resolve({ exitCode: probeOk ? 0 : 1 }), collected: {} }
              }
              if (c.indexOf('printf') >= 0) {
                return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { finalize: () => ({ text: opts.homeText ?? '/home/user' }) } } }
              }
            }
            return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
          },
        }
      }
      if (name === 'fs') return fsMock
      if (name === 'sandboxPolicy') return { workspaceRoot: opts.workspaceRoot ?? 'C:/ws' }
      if (name === 'agents') return {
        list: () => agentsList,
        roots: () => [{ id: 'root' }],
        isOwnedBy: (child, owner) => child === 'sub1' && owner !== undefined && owner !== null && owner.id === 'root',
      }
      if (name === 'jobs') return { onJobDone: (fn) => { jobDoneFns.push(fn) } }
      return undefined
    },
    on(event, fn) { (listeners[event] ??= []).push(fn) },
    timeout(fn) { fn(); return () => {} },
    interval() {},
  }
  const harness = Object.assign({ handle: (method, fn) => { handlers[method] = fn } }, opts.harnessExtra || {})
  const plugin = new Function('ctx', 'harness', source)(ctx, harness)
  plugin.apply(ctx)
  const emit = (event, ...args) => { for (const fn of listeners[event] ?? []) fn(...args) }
  const pull = () => handlers.pull({ sessionId: null, after: 0 })
  return { handlers, spawns, jobDoneFns, emit, pull, fsFiles, fsMock }
}

function agent(id, origin, reasonKind, hasPending = false) {
  return {
    id,
    session: { header: { origin }, events: [{ type: 'turn/end', data: { reason: { kind: reasonKind } } }] },
    inbox: { hasPending },
  }
}

// 1. 任务完成
{
  const env = makeEnv()
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'running' })
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'idle' })
  ok(env.pull().events.some((e) => e.kind === 'complete' && e.sessionId === 'root'), '主代理完成 → complete')
}

// 2. 子任务完成（映射回根会话）
{
  const env = makeEnv()
  env.emit('agent/status', { agent: agent('sub1', 'subagent', 'completed'), status: 'running' })
  env.emit('agent/status', { agent: agent('sub1', 'subagent', 'completed'), status: 'idle' })
  ok(env.pull().events.some((e) => e.kind === 'subcomplete' && e.sessionId === 'root'), '子代理完成 → subcomplete（归属根）')
}

// 3. 其他打断
{
  const env = makeEnv()
  env.emit('agent/status', { agent: agent('root', 'main', 'aborted'), status: 'running' })
  env.emit('agent/status', { agent: agent('root', 'main', 'aborted'), status: 'idle' })
  ok(env.pull().events.some((e) => e.kind === 'interrupt'), 'aborted → interrupt')
}

// 4. 需要授权
{
  const env = makeEnv()
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: { toolName: 'write' } })
  const ev = env.pull().events.find((e) => e.kind === 'approval')
  ok(ev !== undefined && ev.tool === 'write', 'approval/asked → approval（含工具名）')
}

// 5. Agent 提问
{
  const env = makeEnv()
  env.emit('tools/execute', { name: 'ask_user_question', agent: { id: 'root' } }, () => {})
  ok(env.pull().events.some((e) => e.kind === 'question'), 'ask_user_question → question')
}

// 6. 计划评审
{
  const env = makeEnv()
  env.emit('tools/execute', { name: 'exit_plan_mode', agent: { id: 'root' } }, () => {})
  ok(env.pull().events.some((e) => e.kind === 'planreview'), 'exit_plan_mode → planreview')
}

// 6b. 动态插件授权（cordis_run 返回 awaiting user approval → pluginapproval；v0.4.4/v0.4.6）
{
  const env = makeEnv()
  env.emit('tools/result', { name: 'cordis_run', agent: { id: 'root' }, arguments: { pluginId: 'tst-2' } },
    { message: { content: [{ type: 'text', text: 'tst-2/pkg-2 is awaiting user approval (run-2).' }] } })
  const ev = env.pull().events.find((e) => e.kind === 'pluginapproval')
  ok(ev !== undefined && ev.tool === 'cordis_run', 'cordis_run awaiting approval → pluginapproval')
}

// 6b2. 嵌套结构（会话日志形状 content[].content[].text；v0.4.5 深度收集）
{
  const env = makeEnv()
  env.emit('tools/result', { name: 'cordis_run', agent: { id: 'root' } },
    { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'tst-3/pkg-4 is awaiting user approval (run-4).' }] }] } })
  const ev = env.pull().events.find((e) => e.kind === 'pluginapproval')
  ok(ev !== undefined && ev.tool === 'cordis_run', '嵌套 content 也能命中 pluginapproval')
}

// 6c. 其他工具结果不触发 approval
{
  const env = makeEnv()
  env.emit('tools/result', { name: 'pwsh', agent: { id: 'root' } }, { message: { content: [{ type: 'text', text: 'ok' }] } })
  ok(!env.pull().events.some((e) => e.kind === 'approval'), '其他工具结果不触发 approval')
}

// 7. 目标受阻
{
  const env = makeEnv()
  env.emit('session/event', { id: 'root' }, { type: 'goal/change', data: { operation: 'block', goal: { phase: 'blocked' } } })
  ok(env.pull().events.some((e) => e.kind === 'goalblocked'), 'goal/change block → goalblocked')
}

// 8. 后台任务失败（bash 响；subagent 跳过避免与打断音双响）
{
  const env = makeEnv()
  for (const fn of env.jobDoneFns) fn({ id: 'bash-3', kind: 'bash', status: 'failed', ownerSession: 'root' }, { id: 'root' })
  ok(env.pull().events.some((e) => e.kind === 'jobfail'), 'bash failed → jobfail')
  const before = env.pull().events.filter((e) => e.kind === 'jobfail').length
  for (const fn of env.jobDoneFns) fn({ id: 'subagent-1', kind: 'subagent', status: 'failed', ownerSession: 'root' }, { id: 'root' })
  ok(env.pull().events.filter((e) => e.kind === 'jobfail').length === before, 'subagent failed 不重复记 jobfail')
}

// 8b. 后台任务完成（bash 响；subagent 跳过避免与子任务音双响）
{
  const env = makeEnv()
  for (const fn of env.jobDoneFns) fn({ id: 'bash-9', kind: 'bash', status: 'completed', ownerSession: 'root' }, { id: 'root' })
  ok(env.pull().events.some((e) => e.kind === 'jobdone'), 'bash completed → jobdone')
  const before = env.pull().events.filter((e) => e.kind === 'jobdone').length
  for (const fn of env.jobDoneFns) fn({ id: 'subagent-2', kind: 'subagent', status: 'completed', ownerSession: 'root' }, { id: 'root' })
  ok(env.pull().events.filter((e) => e.kind === 'jobdone').length === before, 'subagent completed 不重复记 jobdone')
}

// 9. 节流（同种类同来源 3s 内只记一次）
{
  const env = makeEnv()
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: { toolName: 'x' } })
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: { toolName: 'y' } })
  ok(env.pull().events.filter((e) => e.kind === 'approval').length === 1, '3s 节流生效')
}

// 10. 拉取过滤（after 序号；v0.3.8 固定监听所有会话，sessionId 参数忽略）
{
  const env = makeEnv()
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: {} })
  const all = env.handlers.pull({ sessionId: null, after: 0 })
  ok(env.handlers.pull({ sessionId: 'root', after: all.seq }).events.length === 0, 'after 序号过滤')
  ok(env.handlers.pull({ sessionId: 'nope', after: 0 }).events.length === 1, 'v0.3.8 固定监听所有会话（sessionId 参数忽略）')
}

// 11. sysbeep / setalways（宿主常驻蜂鸣；v0.3.9 走 wscript + 系统 wav，不再 spawn PowerShell）
{
  const env = makeEnv()
  ok(env.handlers.sysbeep({ kind: 'complete' }).ok === true, 'sysbeep 已知种类')
  ok(env.handlers.sysbeep({ kind: 'nope' }).ok === false, 'sysbeep 未知种类拒绝')
  env.handlers.setalways({ enabled: true })
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: {} })
  await new Promise((r) => setTimeout(r, 30))
  ok(env.spawns.length >= 1, 'alwaysBeep 开启后记录事件触发系统蜂鸣')
  const found = env.spawns.some((sp) => {
    if (!sp || !Array.isArray(sp.argv) || !sp.argv[1]) return false
    const vbs = env.fsFiles.get('t:' + sp.argv[1])
    return vbs !== undefined && vbs.indexOf('Windows User Account Control.wav') >= 0 && vbs.indexOf('WMPlayer.OCX') >= 0
  })
  ok(found, 'vbs 内容为 WMP 播放对应 wav（approval 默认 UAC）')
}

// 12. v0.3.11 本地存储（fs）：宿主蜂鸣开关 + 音频库（共享）
{
  const env = makeEnv()
  const g1 = await env.handlers.sysget({})
  ok(g1.ok === true && g1.hostBeep === null, 'sysget 无记录返回 null')
  const s1 = await env.handlers.sysset({ hostBeep: true })
  ok(s1.ok === true, 'sysset 写入本地成功')
  const g2 = await env.handlers.sysget({})
  ok(g2.hostBeep === true, 'sysget 读回已存 hostBeep')
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: {} })
  await new Promise((r) => setTimeout(r, 30))
  ok(env.spawns.length >= 1, 'hostBeep=true 后记录事件触发系统蜂鸣')
  const s2 = await env.handlers.sysset({ hostBeep: 'nope' })
  ok(s2.ok === false, 'sysset 非法值拒绝')
  const a1 = await env.handlers.saveaudio({ base64: 'QUJD', name: 'my.mp3' })
  ok(a1.ok === true && typeof a1.id === 'string' && a1.id.length > 0, 'saveaudio 写入音频库并返回 id')
  const all = await env.handlers.loadall({})
  ok(all.ok === true && Array.isArray(all.list) && all.list.length === 1 && all.list[0].id === a1.id && all.list[0].name === 'my.mp3', 'loadall 列出音频库')
  const l1 = await env.handlers.loadaudio({ id: a1.id })
  ok(l1.ok === true && l1.base64 === 'QUJD' && l1.name === 'my.mp3', 'loadaudio 按 id 读回音频')
  const l2 = await env.handlers.loadaudio({ id: 'nope' })
  ok(l2.ok === false, 'loadaudio 无记录返回 false')
  const a2 = await env.handlers.saveaudio({ name: 'x' })
  ok(a2.ok === false, 'saveaudio 缺 base64 拒绝')
}

// 13. v0.3.12：workspace-write 被拒时自动带 danger-full-access 重试；正常路径不传 policy
{
  const env = makeEnv()
  const real = env.fsMock.writeText
  let calls = 0
  env.fsMock.writeText = async (t, c, e, s, policy) => {
    calls++
    if (calls === 1) throw new Error('FS_SANDBOX_DENIED')
    return real(t, c, e, s, policy)
  }
  const s = await env.handlers.sysset({ hostBeep: true })
  ok(s.ok === true && calls === 2, '被沙箱拒绝后自动重试成功')
  let policySeen = 'unset'
  env.fsMock.writeText = async (t, c, e, s, policy) => { policySeen = policy; return real(t, c, e, s, policy) }
  await env.handlers.sysset({ hostBeep: false })
  ok(policySeen === undefined, '正常路径不传 danger-full-access（先走沙箱）')
}

// 14. v0.3.13：workspaceRoot 落在系统目录时，存储根跟随 DSH 数据目录（%USERPROFILE%\.dsh\plugins\dsh-chime-alerts）
{
  const env = makeEnv({ workspaceRoot: 'C:\\Windows\\System32' })
  const s = await env.handlers.sysset({ hostBeep: true })
  ok(s.ok === true, '系统目录下 sysset 仍成功')
  const key = 't:C:\\Users\\ns\\.dsh\\plugins\\dsh-chime-alerts/./dsh-chime-alerts-settings.json'
  ok(env.fsFiles.get(key) !== undefined, '存储根 = %USERPROFILE%\\.dsh\\plugins\\dsh-chime-alerts')
  const cmdSpawn = env.spawns.find((sp) => sp.argv && sp.argv[0] && sp.argv[0].indexOf('cmd.exe') >= 0)
  ok(cmdSpawn !== undefined && cmdSpawn.argv[3] === 'echo %USERPROFILE%', '解析用户目录走 cmd /c echo %USERPROFILE%')
  const g = await env.handlers.sysget({})
  ok(g.ok === true && g.hostBeep === true && typeof g.dir === 'string' && g.dir.indexOf('.dsh') >= 0, 'sysget 返回 DSH 目录路径')
}

// 15. v0.3.13：系统目录里的旧设置/音频迁移到新位置
{
  const env = makeEnv({ workspaceRoot: 'C:\\Windows\\System32' })
  const legacyKey = 't:C:\\Windows\\System32/./dsh-chime-alerts-settings.json'
  env.fsFiles.set(legacyKey, JSON.stringify({ hostBeep: true }))
  env.fsMock.listDir = async () => [{ name: 'dsh-chime-alerts-settings.json' }]
  const g = await env.handlers.sysget({})
  ok(g.hostBeep === true, '旧设置在系统目录时迁移后仍生效')
  const migrated = env.fsFiles.get('t:C:\\Users\\ns\\.dsh\\plugins\\dsh-chime-alerts/./dsh-chime-alerts-settings.json')
  ok(migrated !== undefined && migrated.indexOf('hostBeep') >= 0, '旧设置文件复制到新位置')
}

// 16. v0.3.13：workspaceRoot 为普通工作区时不查用户目录（保持原路径）
{
  const env = makeEnv({ workspaceRoot: 'C:/ws' })
  await env.handlers.sysset({ hostBeep: true })
  ok(env.fsFiles.get('t:C:/ws/./dsh-chime-alerts-settings.json') !== undefined, '普通工作区仍用 workspaceRoot')
  ok(env.spawns.every((sp) => !sp.argv || !sp.argv[0] || sp.argv[0].indexOf('cmd.exe') < 0), '普通工作区不 spawn cmd')
}

// 17. v0.3.20：宿主音每事件可配置（hostSounds 存盘、beep 用自定义 wav）
{
  const env = makeEnv()
  const s = await env.handlers.sysset({ hostSounds: { complete: 'Windows Error.wav' } })
  ok(s.ok === true, 'sysset 保存自定义宿主音')
  const g = await env.handlers.sysget({})
  ok(g.ok === true && g.hostSounds !== undefined && g.hostSounds.complete === 'Windows Error.wav', 'sysget 读回自定义宿主音')
  await env.handlers.sysset({ hostBeep: true })
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'running' })
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'idle' })
  await new Promise((r) => setTimeout(r, 30))
  const sp = env.spawns[env.spawns.length - 1]
  ok(sp !== undefined, '自定义宿主音后事件仍触发蜂鸣')
  const vbs = env.fsFiles.get('t:' + (sp.argv[1] || ''))
  ok(vbs !== undefined && vbs.indexOf('Windows Error.wav') >= 0, '宿主蜂鸣使用自定义 wav')
  const b = await env.handlers.sysbeep({ kind: 'nope' })
  ok(b.ok === false, 'sysbeep 未知种类拒绝')
  const g2 = await env.handlers.sysget({})
  ok(g2.hostSounds.subcomplete === undefined, '未配置事件用默认（不回传多余项）')
}

// 18. v0.4.0：Linux 宿主蜂鸣（freedesktop 主题音，canberra-gtk-play 优先，paplay 回退）
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'linux' } })
  const g = await env.handlers.sysget({})
  ok(g.platform === 'linux', 'sysget 返回平台 linux')
  ok(env.handlers.sysbeep({ kind: 'complete' }).ok === true, 'linux sysbeep 已知种类')
  ok(env.handlers.sysbeep({ kind: 'nope' }).ok === false, 'linux sysbeep 未知种类拒绝')
  await new Promise((r) => setTimeout(r, 30))
  const sp = env.spawns[env.spawns.length - 1]
  ok(sp !== undefined && sp.argv[0] === 'canberra-gtk-play' && sp.argv[1] === '--id=complete', 'linux 默认音走 canberra-gtk-play --id=complete')
}

// 18b. linux 无 canberra 时回退 paplay 播 freedesktop oga
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'linux' }, canberraProbe: false })
  env.handlers.sysbeep({ kind: 'jobfail' })
  await new Promise((r) => setTimeout(r, 30))
  const sp = env.spawns[env.spawns.length - 1]
  ok(sp !== undefined && sp.argv[0] === 'paplay' && sp.argv[1] === '/usr/share/sounds/freedesktop/stereo/dialog-error.oga', 'linux 无 canberra 回退 paplay 播主题音')
}

// 18c. linux 事件触发 + 自定义宿主音
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'linux' } })
  await env.handlers.sysset({ hostSounds: { complete: 'bell' } })
  await env.handlers.sysset({ hostBeep: true })
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: {} })
  await new Promise((r) => setTimeout(r, 30))
  const sp = env.spawns[env.spawns.length - 1]
  ok(sp !== undefined && sp.argv[0] === 'canberra-gtk-play' && sp.argv[1] === '--id=dialog-warning', 'linux 事件触发用默认 dialog-warning')
}

// 18d. linux 存储 fallback：workspaceRoot 在系统目录 → $HOME/.dsh/plugins/dsh-chime-alerts
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'linux' }, workspaceRoot: '/usr/share/x' })
  const s = await env.handlers.sysset({ hostBeep: true })
  ok(s.ok === true, 'linux 系统目录下 sysset 仍成功')
  ok(env.fsFiles.get('t:/home/user/.dsh/plugins/dsh-chime-alerts/./dsh-chime-alerts-settings.json') !== undefined, 'linux 存储根 = $HOME/.dsh/plugins/dsh-chime-alerts')
  const shHome = env.spawns.find((sp2) => sp2.argv && sp2.argv[0] === 'sh' && (sp2.argv[2] || '').indexOf('printf') >= 0)
  ok(shHome !== undefined, 'linux 解析用户目录走 sh printf $HOME')
}

// 18e. darwin 宿主蜂鸣（afplay 系统音）
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'darwin' } })
  env.handlers.sysbeep({ kind: 'complete' })
  await new Promise((r) => setTimeout(r, 30))
  const sp = env.spawns[env.spawns.length - 1]
  ok(sp !== undefined && sp.argv[0] === 'afplay' && sp.argv[1] === '/System/Library/Sounds/Glass.aiff', 'darwin 走 afplay 系统音')
}

// 19. v0.4.1：宿主响铃能力检测（sysget 返回 capBeep）
{
  const env = makeEnv()
  const g = await env.handlers.sysget({})
  ok(g.capBeep === true, 'win32 支持响铃（wscript 在 PATH）capBeep=true')
  ok(env.spawns.some((sp) => sp.argv && sp.argv[3] === 'where wscript'), 'win32 检测走 cmd where wscript')
}
{
  const env = makeEnv({ noSubprocess: true })
  const g = await env.handlers.sysget({})
  ok(g.capBeep === false, '无 subprocess 服务 capBeep=false')
}
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'linux' }, canberraProbe: false, paplayProbe: false })
  const g = await env.handlers.sysget({})
  ok(g.capBeep === false, 'linux 无播放器 capBeep=false')
}
{
  const env = makeEnv({ harnessExtra: { chimePlatformOverride: 'darwin' } })
  const g = await env.handlers.sysget({})
  ok(g.capBeep === true, 'darwin afplay 在 PATH capBeep=true')
}

// 20. v0.4.2：每事件独立静音宿主音（hostMuted 存盘、record 时跳过静音事件）
{
  const env = makeEnv()
  const s = await env.handlers.sysset({ hostMuted: { complete: true } })
  ok(s.ok === true, 'sysset 保存 hostMuted')
  const g = await env.handlers.sysget({})
  ok(g.hostMuted !== undefined && g.hostMuted.complete === true, 'sysget 读回 hostMuted')
  await env.handlers.sysset({ hostBeep: true })
  env.emit('session/event', { id: 'root' }, { type: 'approval/asked', data: {} })
  await new Promise((r) => setTimeout(r, 30))
  const before = env.spawns.length
  ok(before >= 1, '未静音事件（approval）宿主音正常响')
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'running' })
  env.emit('agent/status', { agent: agent('root', 'main', 'completed'), status: 'idle' })
  await new Promise((r) => setTimeout(r, 30))
  ok(env.spawns.length === before, '静音事件（complete）宿主音不响')
  await env.handlers.sysset({ hostMuted: { complete: false } })
  env.emit('agent/status', { agent: agent('root2', 'main', 'completed'), status: 'running' })
  env.emit('agent/status', { agent: agent('root2', 'main', 'completed'), status: 'idle' })
  await new Promise((r) => setTimeout(r, 30))
  ok(env.spawns.length > before, '取消静音后宿主音恢复')
}

console.log(failures === 0 ? '\nall host tests passed' : `\n${failures} host test(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
