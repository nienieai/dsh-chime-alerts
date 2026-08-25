// 静态客户端半逻辑冒烟测试：node tools/test-client-web.mjs（Node 可跑，无需浏览器）
// 用假 React / window / localStorage / sessions 快照驱动 lib/client.web.js，
// 断言：ModuleLoader 封套、八类事件的快照检测（complete/subcomplete/jobdone/jobfail/
// approval/question/planreview/goalblocked）、工作区静音、节流、设置页渲染、自定义音频持久化。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.web.js', import.meta.url), 'utf8')

let failures = 0
const ok = (cond, label) => {
  if (cond) console.log('PASS', label)
  else { failures++; console.log('FAIL', label) }
}

function makeEnv(seedLocal, seedLib) {
  const storage = new Map()
  if (seedLocal !== undefined) storage.set('dsh-chime-alerts-v1', JSON.stringify(seedLocal))
  if (seedLib !== undefined) storage.set('dsh-chime-alerts-v1-audiolib', JSON.stringify(seedLib))
  const oscs = []
  const audioPlays = []
  const notifications = []
  const sessListeners = []
  const wsListeners = []
  let sessSnap = { ids: [], byId: {}, jobsBySession: {} }
  let wsSnap = { items: [] }

  const win = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)) },
    },
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      resume() { return Promise.resolve() }
      createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
    },
    Audio: class {
      constructor(url) { this.url = url; this.volume = 1 }
      play() { audioPlays.push(this.url); return Promise.resolve() }
    },
    FileReader: class {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    __ModuleLoader__: { load: (spec) => { captured = spec } },
  }
  win.Notification = class Notification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, opts) { this.opts = opts || {}; notifications.push({ title, opts: this.opts }) }
    close() {}
    onclick = null
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }

  const slotRegs = []
  const slots = {
    inject(_slot, fn) { return fn() },
    register(options, component) { slotRegs.push({ options, component }) },
  }

  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => sessSnap,
        subscribe: (fn) => { sessListeners.push(fn); return () => {} },
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => wsSnap,
        subscribe: (fn) => { wsListeners.push(fn); return () => {} },
      },
    },
    slots,
    interval() {},
    timeout() {},
    effect() {},
  }

  let captured = null
  globalThis.window = win
  // 注意：window 在整个测试进程内保持（由下一个 makeEnv 覆盖），
  // 因为 factory 与插件运行时都在执行期间访问 window（AudioContext/localStorage 等）。
  new Function(source)()
  if (captured === null) throw new Error('ModuleLoader.load 未调用')
  const mod = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error('unknown require: ' + name)
  })

  const env = {
    storage, oscs, audioPlays, notifications, slotRegs, react,
    apply: mod.apply,
    inject: mod.inject,
    setSessions(next) { sessSnap = next; for (const fn of sessListeners) fn() },
    setWorkspaces(items) { wsSnap = { items }; for (const fn of wsListeners) fn() },
    push: () => {},
  }
  mod.apply(ctx)
  return env
}

/** 递归渲染 createElement 树，返回所有真实 DOM 型节点。 */
function render(node) {
  const out = []
  function walk(n) {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n === 'string' || typeof n === 'number') return
    if (typeof n.type === 'function') { walk(n.type(n.props)); return }
    if (typeof n.type === 'string') {
      out.push(n)
      const kids = n.props.children !== undefined ? n.props.children : n.children
      walk(kids)
    }
  }
  walk(node)
  return out
}
const byText = (nodes, text) => nodes.find((n) => n.children !== undefined && n.children.some((c) => String(c).indexOf(text) === 0))

// 1. ModuleLoader 封套 + 设置分区注册
{
  const env = makeEnv()
  ok(env.slotRegs.some((r) => r.options.name === 'settings.section' && r.options.id === 'chime'), '注册设置分区 chime')
}

// 1b. inject 必须声明 timer（apply 使用 ctx.interval/ctx.timeout，缺失即
// 触发浏览器启动失败 "cannot get property \"timer\" without inject"）
{
  const env = makeEnv()
  ok(Array.isArray(env.inject) && env.inject.indexOf('timer') >= 0, 'inject 声明 timer')
  ok(Array.isArray(env.inject) && env.inject.indexOf('slots') >= 0, 'inject 声明 slots')
  ok(Array.isArray(env.inject) && env.inject.indexOf('sessions') >= 0, 'inject 声明 sessions')
  ok(Array.isArray(env.inject) && env.inject.indexOf('workspaces') >= 0, 'inject 声明 workspaces')
}

// 2. 主会话回合结束 → complete
{
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, blank: false } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false, blank: false } }, jobsBySession: {} })
  ok(env.oscs.length > 0, 'running→false 播放合成音（complete）')
  const first = env.oscs[0]
  ok(first !== undefined && first.frequency !== undefined, '振荡器已创建')
}

// 3. 子代理会话结束 → subcomplete（按 parentId 归属根；默认关闭，先启用）
{
  const env = makeEnv({ master: true, webBeep: true, notifyEnabled: false, muted: [], kinds: { subcomplete: { enabled: true, sound: 'default', volume: 1 } } })
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['root'] }])
  env.setSessions({ ids: ['root', 'sub1'], byId: { root: { id: 'root', running: false }, sub1: { id: 'sub1', origin: 'subagent', parentId: 'root', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['root', 'sub1'], byId: { root: { id: 'root', running: false }, sub1: { id: 'sub1', origin: 'subagent', parentId: 'root', running: false } }, jobsBySession: {} })
  ok(env.oscs.length > 0, 'subagent 结束播放（subcomplete）')
}

// 4. 后台任务完成/失败
{
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-1', kind: 'bash', status: 'running' }] } })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-1', kind: 'bash', status: 'completed' }] } })
  ok(env.oscs.length > 0, 'bash completed → jobdone 播放')
  const before = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-2', kind: 'bash', status: 'running' }] } })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-2', kind: 'bash', status: 'failed' }] } })
  ok(env.oscs.length > before, 'bash failed → jobfail 播放')
  const before2 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'subagent-job', kind: 'subagent', status: 'running' }] } })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'subagent-job', kind: 'subagent', status: 'failed' }] } })
  ok(env.oscs.length === before2, 'subagent job 不重复响（跳过）')
}

// 5. pendingInteraction → approval / question / planreview
{
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  const n0 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, pendingInteraction: 'approval' } }, jobsBySession: {} })
  ok(env.oscs.length > n0, 'pendingInteraction=approval → 播放')
  const n1 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, pendingInteraction: 'plan-review' } }, jobsBySession: {} })
  ok(env.oscs.length > n1, 'pendingInteraction=plan-review → 播放')
  const n2 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, pendingInteraction: 'question' } }, jobsBySession: {} })
  ok(env.oscs.length > n2, 'pendingInteraction=question → 播放')
}

// 6. goal 投影 blocked → goalblocked
{
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, projectionValues: { goal: { phase: 'active' } } } }, jobsBySession: {} })
  const n0 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, projectionValues: { goal: { phase: 'blocked' } } } }, jobsBySession: {} })
  ok(env.oscs.length > n0, 'goal.phase=blocked → goalblocked 播放')
}

// 7. 被静音工作区的事件不响
{
  const env = makeEnv({ master: true, webBeep: true, notifyEnabled: false, muted: ['w1'], kinds: {} })
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['s1'] }])
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: {} })
  ok(env.oscs.length === 0, '被静音工作区不播放')
}

// 8. 节流（同种类同来源 3s 内只播一次）
{
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: {} })
  const n = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: {} })
  ok(env.oscs.length === n, '3s 节流生效（同来源不重复）')
}

// 9. 设置页渲染 10 张事件卡片 + 四个开关（静态版含宿主蜂鸣开关）
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  ok(page.filter((n) => n.type === 'div' && (n.props.className === 'snd-row' || n.props.className === 'snd-row off')).length === 10, '设置页渲染 10 张事件卡片')
  ok(byText(page, '启用声音提醒') !== undefined, '总开关存在')
  ok(byText(page, '网页响铃') !== undefined, '网页响铃开关存在')
  ok(byText(page, '网页通知') !== undefined, '网页通知开关存在')
  ok(byText(page, '宿主蜂鸣') !== undefined, '宿主蜂鸣开关存在')
  ok(byText(page, '插件授权') !== undefined, '渲染「插件授权」事件行')
}

// 9b. 宿主设置同步：启动读 /sysget；开关点击走 /sysset
{
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => {
    const u = String(url)
    calls.push({ url: u, opts: opts || {} })
    if (u.indexOf('/sysget') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, hostBeep: false, capBeep: true }) })
    if (u.indexOf('/sysset') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    return Promise.reject(new Error('unexpected fetch ' + u))
  }
  const env = makeEnv()
  ok(calls.some((c) => c.url.indexOf('/sysget') >= 0), '启动时读取宿主设置（/sysget）')
  // 在未拍平的组件树上找到「宿主蜂鸣」snd-master 行,取该行内的 switch 按钮
  const root = env.slotRegs.find((r) => r.options.name === 'settings.section').component()
  let hostSwitchOnClick = null
  const nameOf = (x) => { // 取一个节点里可能的内嵌 label 文本
    if (x === null || x === undefined) return ''
    if (typeof x === 'string') return x
    if (Array.isArray(x)) return x.map((c) => nameOf(c)).join('')
    if (typeof x.type === 'function') return nameOf(x.type(x.props))
    if (x.type === 'span' && x.props && x.props.className === 'snd-name') {
      const sk = x.props.children !== undefined ? x.props.children : x.children
      return nameOf(sk)
    }
    const k = x.props && x.props.children !== undefined ? x.props.children : x.children
    return nameOf(k)
  }
  const innerSwitch = (x) => {
    if (x === null || x === undefined || hostSwitchOnClick !== null) return
    if (Array.isArray(x)) { x.forEach(innerSwitch); return }
    if (typeof x === 'string' || typeof x === 'number') return
    if (typeof x.type === 'function') { innerSwitch(x.type(x.props)); return }
    if (typeof x.type === 'string' && x.props && x.props.role === 'switch' && typeof x.props.onClick === 'function') { hostSwitchOnClick = x.props.onClick; return }
    const k = x.props && x.props.children !== undefined ? x.props.children : x.children
    innerSwitch(k)
  }
  const walk = (n) => {
    if (n === null || n === undefined || hostSwitchOnClick !== null) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n === 'string' || typeof n === 'number') return
    if (typeof n.type === 'function') { walk(n.type(n.props)); return }
    if (n.type === 'div' && n.props && n.props.className === 'snd-master') {
      const k = n.props.children !== undefined ? n.props.children : n.children
      if (nameOf(k).indexOf('宿主蜂鸣') >= 0 || nameOf(k).indexOf('Host beep') >= 0) {
        innerSwitch(k)
        return
      }
    }
    const k = n.props && n.props.children !== undefined ? n.props.children : n.children
    walk(k)
  }
  walk(root)
  ok(hostSwitchOnClick !== null, '宿主蜂鸣开关可点击')
  const before = calls.length
  hostSwitchOnClick()
  ok(calls.length > before && calls.slice(before).some((c) => c.url.indexOf('/sysset') >= 0), '切换后写宿主设置（/sysset）')
  globalThis.fetch = origFetch
}

// 9c. v0.5.5：宿主蜂鸣开启时每事件展开「宿主音」行（下拉/单独静音/宿主试听）+ 版本标注
{
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => {
    const u = String(url)
    calls.push({ url: u, opts: opts || {} })
    if (u.indexOf('/sysget') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, hostBeep: true, hostSounds: {}, hostMuted: {}, platform: 'win32', capBeep: true }) })
    if (u.indexOf('/sysset') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    if (u.indexOf('/sysbeep') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    return Promise.reject(new Error('unexpected fetch ' + u))
  }
  const env = makeEnv()
  await new Promise((r) => setTimeout(r, 10))
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const hostRows = page.filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostrow') >= 0)
  ok(hostRows.length === 10, '宿主蜂鸣开启时展开 10 行宿主音')
  const hostSelects = page.filter((n) => n.type === 'select' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-host-select') >= 0)
  ok(hostSelects.length === 10, '每行一个宿主音下拉')
  const hostMutes = page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostmute') >= 0)
  ok(hostMutes.length === 10, '每行一个宿主静音键')
  const hostPreviews = page.filter((n) => n.type === 'button' && n.props.className === 'snd-btn' && n.children !== undefined && n.children.some((c) => String(c) === '宿主试听'))
  ok(hostPreviews.length === 10, '每行一个宿主试听按钮')
  const before = calls.length
  hostSelects[0].props.onChange({ target: { value: 'Windows Error.wav' } })
  ok(calls.length > before && calls.slice(before).some((c) => c.url.indexOf('/sysset') >= 0 && String(c.opts.body).indexOf('Windows Error.wav') >= 0), '宿主音选择写宿主（sysset hostSounds）')
  const before2 = calls.length
  hostMutes[1].props.onClick()
  ok(calls.length > before2 && calls.slice(before2).some((c) => c.url.indexOf('/sysset') >= 0 && String(c.opts.body).indexOf('hostMuted') >= 0), '宿主静音键写宿主（sysset hostMuted）')
  const before3 = calls.length
  hostPreviews[2].props.onClick()
  ok(calls.length > before3 && calls.slice(before3).some((c) => c.url.indexOf('/sysbeep') >= 0), '宿主试听调 /sysbeep')
  ok(byText(page, '静态版 v0.5.5') !== undefined, '设置页底部标注版本 v0.5.5')
  globalThis.fetch = origFetch
}

// 10. 网页通知触发
{
  const env = makeEnv()
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['s1'] }])
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, pendingInteraction: 'approval' } }, jobsBySession: {} })
  ok(env.notifications.length > 0, 'approval 触发网页通知')
}

// 11. 从 localStorage 读回设置（webBeep=false → 不播放；自定义音频库可见）
{
  const env = makeEnv(
    { master: true, webBeep: false, notifyEnabled: false, muted: [], kinds: { complete: { enabled: true, sound: 'default', volume: 0.5 } } },
    { 'c1': { name: 'my.mp3', url: 'data:audio/mp3;base64,AAAA' } }
  )
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: {} })
  ok(env.oscs.length === 0, 'webBeep=false（从 localStorage 读回）不播放')
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const selects = page.filter((n) => n.type === 'select')
  const opts = []
  for (const s of selects) {
    const kids = s.children || []
    for (const row of kids) {
      const arr = Array.isArray(row) ? row : [row]
      for (const c of arr) if (c && typeof c === 'object') opts.push(c.props ? c.props.value : null)
    }
  }
  ok(opts.indexOf('custom:c1') >= 0, '音频库条目出现在声音下拉（localStorage）')
}

// 12. master=false 全部静音
{
  const env = makeEnv({ master: false, webBeep: true, notifyEnabled: false, muted: [], kinds: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: {} })
  ok(env.oscs.length === 0, 'master=false 全部静音')
}

if (failures === 0) console.log('all client-web tests passed')
else console.error(failures + ' client-web test(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
