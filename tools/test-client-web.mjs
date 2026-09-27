// 静态客户端半逻辑冒烟测试：node tools/test-client-web.mjs（Node 可跑，无需浏览器）
// 用假 React / window / localStorage / sessions 快照驱动 lib/client.web.js，
// 断言：ModuleLoader 封套、三类快照检测（complete/subcomplete/goalblocked）、
// 六类宿主事件转发（approval/question/planreview/pluginapproval/jobdone/jobfail）、
// AudioContext 挂起解锁（自动播放策略）、工作区静音、节流、设置页渲染、自定义音频持久化。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.web.js', import.meta.url), 'utf8')

let failures = 0
const ok = (cond, label) => {
  if (cond) console.log('PASS', label)
  else { failures++; console.log('FAIL', label) }
}

function makeEnv(seedLocal, seedLib, fetchHandler, audioFactory) {
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

  const winListeners = {}
  const win = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)) },
    },
    // 默认桩：上下文直接可用（running）。用例可传 audioFactory 造
    // suspended / 拒绝 resume 的变体，见「AudioContext 挂起解锁」回归用例。
    AudioContext: typeof audioFactory === 'function' ? audioFactory(oscs) : class {
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
    // v0.5.8：记录 window 级监听器，供「自动播放策略解锁」用例触发用户手势
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      const a = winListeners[type]
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) }
    },
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
    // v0.5.6：useState 记录每次 setter 入参（回归检测函数式更新），useEffect 同步执行
    // effect 回调（useVersion 借此把监听器挂进 storeListeners）
    useState: (v) => {
      const pair = [typeof v === 'function' ? v() : v]
      pair[1] = (u) => { react.useStateCalls.push(u) }
      return pair
    },
    useStateCalls: [],
    useEffect: (fn) => { if (typeof fn === 'function') { try { fn() } catch (err) {} } return () => {} },
    useRef: (v) => ({ current: v }),
  }

  const slotRegs = []
  const slots = {
    inject(_slot, fn) { return fn() },
    register(options, component) { slotRegs.push({ options, component }) },
  }

  const intervalFns = []
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
    interval(fn) { if (typeof fn === 'function') intervalFns.push(fn); return () => {} },
    timeout() {},
    effect() {},
  }

  // v0.5.8：默认 fetch 桩。宿主端点未单独打桩时返回「空但成功」的响应，
  // 避免 /events 轮询把 hostApiAvailable 置 false 而影响其他用例。
  // overrideFetch(fn) 只覆盖本次用例关心的端点，返回 null 时回落到默认桩。
  const fetchCalls = []
  const origFetch = globalThis.fetch
  // 每个 env 独立：上一个用例的端点覆盖不得泄漏到下一个。
  // 注意：/sysget 在 mod.apply() **同步**期间就会发出，所以需要覆盖它的用例
  // 必须在 makeEnv 收尾之前就把 handler 传进来（第三个参数），不能等
  // makeEnv 返回后再 env.overrideFetch(...)。
  let fetchOverride = typeof fetchHandler === 'function' ? fetchHandler : null
  globalThis.fetch = (url, opts) => {
    const u = String(url)
    fetchCalls.push({ url: u, opts: opts || {} })
    if (fetchOverride !== null) {
      const custom = fetchOverride(u, opts || {})
      if (custom !== null && custom !== undefined) return custom
    }
    if (u.indexOf('/events') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, boot: 'b', seq: 0, events: [] }) })
    if (u.indexOf('/sysget') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, hostBeep: false, capBeep: true }) })
    if (u.indexOf('/sysset') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    if (u.indexOf('/sysbeep') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
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
    // v0.5.8：跑一遍插件注册的 ctx.interval 回调（真实环境由 timer 服务周期触发）
    // v0.5.8：跑一遍插件注册的 ctx.interval 回调（真实环境由 timer 服务周期触发）
    runIntervals() { for (const fn of intervalFns) { try { fn() } catch (err) {} } },
    intervalCount() { return intervalFns.length },
    intervalCount() { return intervalFns.length },
    fetchCalls,
    overrideFetch(fn) { fetchOverride = fn },
    restoreFetch() { globalThis.fetch = origFetch },
    push: () => {},
    winListeners,
    // v0.5.8：触发一次 window 级用户手势（真实浏览器里自动播放策略的解锁时机）
    gesture(type) {
      const a = winListeners[type] || []
      for (const fn of a.slice()) { try { fn({ type }) } catch (err) {} }
    },
  }
  mod.apply(ctx)
  return env
}

/**
 * 让一个 env 通过宿主 /events 通道收事件。v0.5.8 起 complete / subcomplete /
 * interrupt 也不再由快照判定，一律走这条通道，所以涉及回合结束的用例必须用它。
 * 调用前先 `env.runIntervals(); await flush()` 对齐游标（首轮不补响历史事件）。
 * 返回 deliver(kind, sessionId) 投递一个事件。
 */
function hostEventsDriver(env) {
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      // 忠实模拟宿主：队列常驻，且按 ev.seq > after 过滤。过滤发生在宿主侧，
      // 客户端不复查序号——假驱动若不过滤，「游标被卡死」类用例会假绿。
      const m = /after=([0-9]+)/.exec(u)
      const after = m ? Number(m[1]) : 0
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch.filter((e) => e.seq > after) }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  return function deliver(kind, sessionId) {
    batch = [{ seq: seq + 1, kind, sessionId: sessionId || 's1', at: Date.now() }]
    env.runIntervals()
  }
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

/** 让已排队的微任务/一次宏任务跑完，用于等待 fetch 链与 .then 回调。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

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

// 2. 主会话回合结束 → complete：v0.5.8 起改由宿主 /events 转发
{
  // 2a. 钉死旧失效路径：快照 running true→false 再也不该响（防止回退）。
  // 旧判定是「running true→false 且 !row.pendingInteraction」，而 DSH 0.1.7 的
  // SessionSummary 没有 pendingInteraction → 该守卫恒真 → 一个正在等待授权的
  // 回合结束时会被误判成「完成」，与授权音叠在一起（用户听到的爆音）。
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, blank: false } }, jobsBySession: {} })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false, blank: false } }, jobsBySession: {} })
  ok(env.oscs.length === 0, '快照 running→false 不再判定完成（判定权已归宿主）')

  // 2b. 宿主 /events 的 complete 必须响
  const env2 = makeEnv()
  let seq = 0
  let batch = []
  env2.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env2.runIntervals()
  await flush() // 首轮对齐游标
  const n0 = env2.oscs.length
  batch = [{ seq: 2, kind: 'complete', sessionId: 's1', at: Date.now() }]
  env2.runIntervals()
  await flush()
  ok(env2.oscs.length > n0, '宿主 /events 的 complete → 播放')
  const first = env2.oscs[n0]
  ok(first !== undefined && first.frequency !== undefined, '振荡器已创建')
}

// 3. 子代理会话结束 → subcomplete（按 parentId 归属根；默认关闭，先启用）
{
  const env = makeEnv({ master: true, webBeep: true, notifyEnabled: false, muted: [], kinds: { subcomplete: { enabled: true, sound: 'default', volume: 1 } } })
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['root'] }])
  env.setSessions({ ids: ['root', 'sub1'], byId: { root: { id: 'root', running: false }, sub1: { id: 'sub1', origin: 'subagent', parentId: 'root', running: true } }, jobsBySession: {} })
  env.setSessions({ ids: ['root', 'sub1'], byId: { root: { id: 'root', running: false }, sub1: { id: 'sub1', origin: 'subagent', parentId: 'root', running: false } }, jobsBySession: {} })
  ok(env.oscs.length === 0, '快照不再判定 subcomplete（判定权已归宿主）')

  // 3b. 宿主 /events 的 subcomplete 必须响（宿主侧按 parentId 归属根）
  const env2 = makeEnv({ master: true, webBeep: true, notifyEnabled: false, muted: [], kinds: { subcomplete: { enabled: true, sound: 'default', volume: 1 } } })
  let seq = 0
  let batch = []
  env2.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env2.runIntervals()
  await flush()
  const n0 = env2.oscs.length
  batch = [{ seq: 2, kind: 'subcomplete', sessionId: 'root', at: Date.now() }]
  env2.runIntervals()
  await flush()
  ok(env2.oscs.length > n0, '宿主 /events 的 subcomplete → 播放')
}

// 4. 后台任务完成/失败：v0.5.8 起不再走快照，改由宿主 /events 转发。
// DSH 0.1.7 的 SessionListState 没有 jobsBySession（作业列表迁到独立的 jobs 快照，
// 见 dsh-client-ui-jobs），旧自检分支的 snap.jobsBySession 恒为空对象 → 两类永不响。
{
  // 4a. 钉死旧失效路径：即使快照里塞了 jobsBySession 也不该再响（防止回退）
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-1', kind: 'bash', status: 'running' }] } })
  const n0 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-1', kind: 'bash', status: 'completed' }] } })
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: false } }, jobsBySession: { s1: [{ id: 'bash-2', kind: 'bash', status: 'failed' }] } })
  ok(env.oscs.length === n0, '快照 jobsBySession 不再触发（该字段不存在于 SessionListState）')
}
{
  // 4b. 宿主 /events 的 jobdone / jobfail 必须响（宿主半 jobs.onJobDone 一直检测正常）
  const env = makeEnv()
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals() // 首轮对齐游标
  await flush()
  const n1 = env.oscs.length
  batch = [{ seq: 2, kind: 'jobdone', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n1, '宿主 /events 的 jobdone → 播放')
  const n2 = env.oscs.length
  batch = [{ seq: 3, kind: 'jobfail', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n2, '宿主 /events 的 jobfail → 播放')
}

// 5. v0.5.8：approval / question / planreview 改由宿主事件端点驱动。
// 当前 DSH 的 SessionSummary 没有 pendingInteraction 字段（由 dsh-client-ui-session
// 单独维护、只经 slot 的 useSessionPendingInteraction prop 暴露），旧实现恒不触发。
{
  // 5a. 快照里带 pendingInteraction 再也不该响（钉死旧失效路径，防止回退）
  const env = makeEnv()
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true } }, jobsBySession: {} })
  const n0 = env.oscs.length
  env.setSessions({ ids: ['s1'], byId: { s1: { id: 's1', running: true, pendingInteraction: 'approval' } }, jobsBySession: {} })
  ok(env.oscs.length === n0, '快照 pendingInteraction 不再触发（该字段不存在于 SessionSummary）')
}
{
  // 5b. 宿主 /events 首轮只对齐游标，不补响历史事件
  const env = makeEnv()
  let seq = 0
  const deliver = [{ seq: 1, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      const body = u.indexOf('after=0') >= 0
        ? { ok: true, boot: 'b', seq: 1, events: deliver }
        : { ok: true, boot: 'b', seq: seq, events: [] }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush()
  ok(env.oscs.length === 0, '/events 首轮只对齐游标（不补响历史）')
}
{
  // 5d. 宿主重启（boot 换代、seq 归零）后，本页游标必须跟着归零。
  // 旧实现只推进 seq 而完全忽略 data.boot：宿主重启把 seq 清零后，本页仍在请求
  // after=5，而**过滤发生在宿主侧**（ev.seq > after），新事件 seq 1/2/3… 全被挡掉；
  // line 322 的 `data.seq > hostEventSeq` 也修不回来（新 seq 只会更小）→ 该标签页对
  // 所有经宿主转发的提醒彻底失声，只有刷新页面才能恢复。用户实测：同一页面手机有
  // 声音、电脑（长开的标签页）完全没声音，刷新后立刻恢复。
  const env = makeEnv()
  let boot = 'b1'
  let high = 0
  let recorded = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      const m = /after=([0-9]+)/.exec(u)
      const after = m ? Number(m[1]) : 0
      const body = { ok: true, boot, seq: high, events: recorded.filter((e) => e.seq > after) }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  const hRecord = (kind) => {
    high += 1
    recorded.push({ seq: high, kind, sessionId: 's1', at: Date.now() })
    env.runIntervals()
  }
  env.runIntervals()
  await flush() // 首轮对齐游标（boot b1）
  for (let i = 0; i < 5; i++) { hRecord('approval'); await flush() }
  const n1 = env.oscs.length
  ok(n1 > 0, '宿主重启前：事件正常播放')
  ok(high === 5, '驱动已把宿主 seq 推到 5')

  // 宿主重启：boot 换代，seq 从 0 重新计数，旧队列丢弃
  boot = 'b2'
  high = 0
  recorded = []
  env.runIntervals()
  await flush()
  ok(env.oscs.length === n1, '宿主换代当轮只归零游标、不补响历史事件')

  // 新宿主记下第一条事件，seq 从 1 开始——必须仍然响
  hRecord('complete')
  await flush()
  ok(env.oscs.length > n1, '宿主重启后 seq 从头计数仍能响（游标已随 boot 归零）')
}
{
  // 5c. 首轮之后的新事件：approval / question / planreview / pluginapproval 都要响
  const env = makeEnv()
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals() // 首轮对齐游标
  await flush()
  const n0 = env.oscs.length
  batch = [{ seq: 2, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n0, '宿主 /events 的 approval → 播放')

  const n1 = env.oscs.length
  batch = [{ seq: 3, kind: 'question', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n1, '宿主 /events 的 question → 播放')

  const n2 = env.oscs.length
  batch = [{ seq: 4, kind: 'planreview', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n2, '宿主 /events 的 planreview → 播放')

  const n3 = env.oscs.length
  batch = [{ seq: 5, kind: 'pluginapproval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n3, '宿主 /events 的 pluginapproval → 播放')
}
{
  // 5d. 宿主已节流、浏览器按事件 seq 去重：同一 seq 只响一次
  const env = makeEnv()
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush()
  const n0 = env.oscs.length
  batch = [{ seq: 7, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  const afterFirst = env.oscs.length
  ok(afterFirst > n0, '宿主事件按 seq 播放')
  // 同一批事件重复到达（seq 相同）不再响
  batch = [{ seq: 7, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length === afterFirst, '同一 seq 事件不重复播放')
}
{
  // 5e. 被静音工作区的宿主转发事件也不响
  const env = makeEnv({ master: true, webBeep: true, notifyEnabled: false, muted: ['w1'], kinds: {} })
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['s1'] }])
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush()
  batch = [{ seq: 2, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.oscs.length === 0, '宿主转发事件同样受工作区静音约束')
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
  // v0.5.8：不再自建 fetch 桩——makeEnv 已装默认桩并记录调用，避免用例之间
  // 替换/恢复 globalThis.fetch 造成泄漏。
  const env = makeEnv()
  const calls = env.fetchCalls
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
}

// 9c. v0.5.5：宿主蜂鸣开启时每事件展开「宿主音」行（下拉/单独静音/宿主试听）+ 版本标注
{
  const env = makeEnv(undefined, undefined, (u) => {
    if (u.indexOf('/sysget') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, hostBeep: true, hostSounds: {}, hostMuted: {}, platform: 'win32', capBeep: true }) })
    return null
  })
  const calls = env.fetchCalls
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
  ok(byText(page, '静态版 v0.5.8') !== undefined, '设置页底部标注版本 v0.5.8')
}

// 9d. v0.5.6：useVersion 必须函数式更新（setState(x => x + 1)）。闭包捕获初值
// （pair[1](pair[0] + 1) 恒传 1）会让 React 第一次重渲染后吞掉后续所有 bump——
// 「切换宿主蜂鸣开关后卡住、开关不再响应」的根因回归测试
{
  const env = makeEnv()
  const before = env.react.useStateCalls.length
  const root = env.slotRegs.find((r) => r.options.name === 'settings.section').component()
  const page = render(root)
  const masterSwitch = page.find((n) => n.type === 'button' && n.props.role === 'switch')
  ok(masterSwitch !== undefined && typeof masterSwitch.props.onClick === 'function', '总开关存在且可点击')
  masterSwitch.props.onClick()
  const after = env.react.useStateCalls.length
  ok(after > before, 'bump 触发 setState')
  const last = env.react.useStateCalls[after - 1]
  ok(typeof last === 'function' && last(41) === 42, 'setState 使用函数式更新（x => x + 1），连续 bump 不会被吞掉')
}

// 10. 网页通知触发（v0.5.8：改由宿主事件端点驱动）
{
  const env = makeEnv()
  env.setWorkspaces([{ workspaceId: 'w1', title: 'K230', sessionIds: ['s1'] }])
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush()
  batch = [{ seq: 2, kind: 'approval', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  ok(env.notifications.length > 0, '宿主转发的 approval 触发网页通知')
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

// 13. v0.5.8 回归：AudioContext 处于 suspended 时，首响不能被静默丢弃。
// 浏览器自动播放策略下上下文初始就是 suspended，而 resume() 是异步兑现的；旧实现
// 同步查 state 后直接 return null，于是「页面加载后第一响」与「标签页从后台/睡眠
// 恢复后第一响」都被吞掉——而人不在标签页时恰恰最需要出声。
{
  const env = makeEnv(undefined, undefined, undefined, (oscs) => class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.listeners = {} }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
    // 真实浏览器里 resume() 是异步兑现的：这里用微任务模拟，落地后才变 running
    resume() {
      return Promise.resolve().then(() => {
        this.state = 'running'
        for (const fn of (this.listeners['statechange'] || []).slice()) { try { fn({ type: 'statechange' }) } catch (err) {} }
      })
    }
    createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  })
  const drive = hostEventsDriver(env)
  env.runIntervals()
  await flush() // 首轮只对齐游标
  drive('complete')
  ok(env.oscs.length === 0, 'suspended：resume 落地前尚未调度（异步等待，而非同步判空）')
  await flush()
  ok(env.oscs.length > 0, 'suspended → resume 落地后仍然出声（旧实现此处静默丢弃）')
}

// 13b. resume() 被自动播放策略拒绝（还没有任何用户手势）时不能直接丢：
// 先排队，等首次用户手势解锁后补响。
{
  let allowResume = false
  const env = makeEnv(undefined, undefined, undefined, (oscs) => class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {} }
    resume() { return Promise.resolve().then(() => { if (allowResume) this.state = 'running' }) }
    createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  })
  const drive = hostEventsDriver(env)
  env.runIntervals()
  await flush() // 首轮只对齐游标
  drive('complete')
  await flush()
  ok(env.oscs.length === 0, '自动播放策略拒绝 resume 时暂不出声')
  ok((env.winListeners['pointerdown'] || []).length > 0, '已挂上用户手势解锁监听器')
  allowResume = true
  env.gesture('pointerdown')
  await flush()
  ok(env.oscs.length > 0, '首次用户手势后补响排队的提示音（不再永久丢失）')
  ok((env.winListeners['pointerdown'] || []).length === 0, '解锁后摘掉手势监听器')
}

// 13c. 陈到没有意义的排队提示音不再补响（避免解锁瞬间炸出一串早已无关的旧音）
{
  let allowResume = false
  const env = makeEnv(undefined, undefined, undefined, (oscs) => class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {} }
    resume() { return Promise.resolve().then(() => { if (allowResume) this.state = 'running' }) }
    createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  })
  const realNow = Date.now
  const drive = hostEventsDriver(env)
  env.runIntervals()
  await flush() // 首轮只对齐游标
  drive('complete')
  await flush()
  ok(env.oscs.length === 0, '13c 前置：仍处于未解锁状态')
  Date.now = () => realNow() + 180000 // 推过 PENDING_STALE_MS（120s）
  allowResume = true
  env.gesture('pointerdown')
  await flush()
  Date.now = realNow
  ok(env.oscs.length === 0, '超过 PENDING_STALE_MS 的排队提示音不再补响')
}

// 13d. 超过新鲜窗口、但仍在可救范围内的排队提示音必须补响。
// 旧实现把整批一起丢掉：从事件发生到用户首次手势只要超过 15s，
// 用户正在等的那一声就静默消失（既无日志也无兜底）。这里钉住「绝不静默丢弃最新一条」。
{
  let allowResume = false
  const env = makeEnv(undefined, undefined, undefined, (oscs) => class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {} }
    resume() { return Promise.resolve().then(() => { if (allowResume) this.state = 'running' }) }
    createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  })
  const realNow = Date.now
  const drive = hostEventsDriver(env)
  env.runIntervals()
  await flush() // 首轮只对齐游标
  drive('complete')
  await flush()
  ok(env.oscs.length === 0, '13d 前置：仍处于未解锁状态')
  Date.now = () => realNow() + 60000 // 超过 PENDING_TTL_MS（15s），但仍在 PENDING_STALE_MS（120s）内
  allowResume = true
  env.gesture('pointerdown')
  await flush()
  Date.now = realNow
  ok(env.oscs.length > 0, '超过新鲜窗口的最新排队提示音仍会补响（不再静默丢弃）')
}

// 14. 音频 1+3：并发提示音错开调度 + 共享主总线（内置压缩器兜底）。
// 旧实现里每个音符的 gain 直接接 ac.destination 且都从 currentTime + 0.02 起算，
// 两个提示音碰在一起就同刻叠加、峰值 >1.0 硬削波（用户报告的「爆音」）。
{
  const log = []
  const env = makeEnv(undefined, undefined, undefined, () => class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = { kind: 'destination' } }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(t) {
          let to = 'nil'
          if (t) {
            if (t.kind === 'destination') to = 'destination'
            else if (t.kind === 'compressor') to = 'compressor'
            else if (t.gain && t.gain.value === 0.85) to = 'master'
            else to = 'unknown'
          }
          log.push({ from: 'gain', to })
        },
      }
    }
    createDynamicsCompressor() {
      return {
        kind: 'compressor',
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
        attack: { value: 0 }, release: { value: 0 },
        connect(t) { log.push({ from: 'compressor', to: t && t.kind === 'destination' ? 'destination' : 'unknown' }) },
      }
    }
    createOscillator() {
      return { type: 'sine', frequency: { value: 0 }, connect() {}, start(t) { log.push({ from: 'osc', t }) }, stop() {} }
    }
  })
  let seq = 0
  let batch = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: batch }
      batch = []
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush() // 首轮对齐游标

  batch = [{ seq: 2, kind: 'complete', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  const startsA = log.filter((e) => e.from === 'osc').map((e) => e.t)
  ok(startsA.length > 0, '14 前置：第一个提示音已调度')
  const tA = Math.min.apply(null, startsA)

  const mark = log.length
  batch = [{ seq: 3, kind: 'question', sessionId: 's1', at: Date.now() }]
  env.runIntervals()
  await flush()
  const startsB = log.slice(mark).filter((e) => e.from === 'osc').map((e) => e.t)
  ok(startsB.length > 0, '14：第二个提示音已调度')
  const tB = Math.min.apply(null, startsB)
  ok(tB > tA, '并发提示音错开起音（不再与上一声同刻叠加）')

  ok(log.filter((e) => e.from === 'gain' && e.to === 'destination').length === 0, '音符 gain 不再直连 destination（改走主总线）')
  ok(log.some((e) => e.from === 'gain' && e.to === 'master'), '音符 gain 汇入共享主总线')
  ok(log.some((e) => e.from === 'gain' && e.to === 'compressor'), '主总线接内置压缩器')
  ok(log.filter((e) => e.from === 'compressor' && e.to === 'destination').length === 1, 'destination 只被压缩器接入一次（安全网生效）')
}

// 15. 宿主桥：一次瞬时失败不得永久关闭通道。
// 旧实现把 hostApiAvailable 置 false 后 pollHostEvents 开头直接 return，
// 于是任何一次瞬时失败都会让 approval/question/planreview/jobdone/jobfail
// 全部静默到刷新页面——「有些时候不会出声」的随机性来源之一。
{
  const env = makeEnv()
  let failing = false
  let seq = 0
  const events = []
  env.overrideFetch((u) => {
    if (u.indexOf('/events') >= 0) {
      if (failing) return Promise.reject(new Error('transient'))
      seq += 1
      const body = { ok: true, boot: 'b', seq, events: events.splice(0) }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }
    return null
  })
  env.runIntervals()
  await flush()
  const callCount = () => env.fetchCalls.filter((c) => c.url.indexOf('/events') >= 0).length
  const before = callCount()
  ok(before > 0, '轮询已发起')

  failing = true
  env.runIntervals()
  await flush()
  const afterFail = callCount()
  ok(afterFail > before, '失败那次确实发起了请求')

  // 退避窗口过后必须继续重试
  failing = false
  const realNow = Date.now
  Date.now = () => realNow() + 60000
  env.runIntervals()
  await flush()
  Date.now = realNow
  ok(callCount() > afterFail, '一次瞬时失败后仍会重试（旧实现此处永久不再发请求）')

  // 通道恢复后事件照常播放
  const n0 = env.oscs.length
  events.push({ seq: 99, kind: 'approval', sessionId: 's1', at: Date.now() })
  env.runIntervals()
  await flush()
  ok(env.oscs.length > n0, '恢复后宿主事件照常播放')
}

if (failures === 0) console.log('all client-web tests passed')
else console.error(failures + ' client-web test(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
