// 客户端半逻辑冒烟测试：node tools/test-client.mjs（Node 可跑，无需浏览器）
// 用假 React / window / slots / host 驱动 client.js，断言默认值、持久化迁移、
// 事件触发播放、系统蜂鸣兜底、快捷静音按钮与插槽注册。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let failures = 0
const ok = (cond, label) => {
  if (cond) console.log('PASS', label)
  else { failures++; console.log('FAIL', label) }
}

function makeEnv(seedLocal, legacyLocal, pullEvents = [], workspaceItems = [], oldLegacyLocal = undefined, sysgetRes = { ok: true, hostBeep: false, dir: '/tmp/chime-test' }, loadallRes = { ok: true, list: [] }, loadaudioRes = { ok: false }) {
  // 浏览器全局假体（每个场景独立）
  const storage = new Map()
  if (seedLocal !== undefined) storage.set('dsh-chime-alerts-v1', JSON.stringify(seedLocal))
  if (legacyLocal !== undefined) storage.set('dsh-chime-v1', JSON.stringify(legacyLocal))
  if (oldLegacyLocal !== undefined) storage.set('dsh-sound-alerts-v1', JSON.stringify(oldLegacyLocal))
  const oscs = []
  const gainRamps = []
  const audioPlays = []
  const notifications = []
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)) },
  }
  globalThis.Notification = class Notification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, opts) { this.opts = opts || {}; notifications.push({ title, opts: this.opts }) }
    close() {}
    onclick = null
  }
  globalThis.window = {
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      resume() { return Promise.resolve() }
      createOscillator() { const o = { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; oscs.push(o); return o }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime(v, t) { gainRamps.push([v, t]) } }, connect() {} } }
    },
  }
  globalThis.Audio = class {
    constructor(url) { this.url = url; this.volume = 1 }
    play() { audioPlays.push(this.url); return Promise.resolve() }
  }
  globalThis.FileReader = class {}

  // 假 React：createElement 建树，组件函数可递归渲染
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  const styles = { inserted: [], insert(css) { this.inserted.push(css); return () => {} } }
  const calls = []
  const host = {
    call: (method, args) => {
      calls.push([method, args])
      if (method === 'pull') return Promise.resolve({ boot: 'b1', seq: 1, events: pullEvents })
      if (method === 'sysget') return Promise.resolve(sysgetRes)
      if (method === 'loadall') return Promise.resolve(loadallRes)
      if (method === 'loadaudio') return Promise.resolve(loadaudioRes)
      if (method === 'saveaudio') return Promise.resolve({ ok: true, id: 'c-test-1' })
      return Promise.resolve({ ok: true })
    },
  }
  const slotRegs = []
  const slots = {
    inject(_slot, fn) { return fn() },
    register(options, component) { slotRegs.push({ options, component }) },
  }
  const intervals = []
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: workspaceItems }) } }
      return undefined
    },
    interval(fn) { intervals.push(fn) },
    timeout() {},
    on() {},
    effect() {},
  }
  const plugin = new Function('ctx', 'React', 'console', 'styles', 'host', 'harness', source)(
    ctx, react, console, styles, host, undefined
  )
  plugin.apply(ctx)
  return { storage, oscs, gainRamps, audioPlays, notifications, react, styles, calls, slotRegs, tick: () => intervals[0]() }
}

/** 递归渲染 createElement 树（组件函数被调用展开），返回所有真实 DOM 型节点。 */
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
const settle = () => new Promise((r) => setTimeout(r, 10))

// 1. 默认值与九类事件卡片
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  ok(page.filter((n) => n.type === 'div' && (n.props.className === 'snd-row' || n.props.className === 'snd-row off')).length === 9, '设置页渲染 9 张事件卡片')
  ok(env.slotRegs.some((r) => r.options.name === 'settings.section' && r.options.id === 'chime'), '注册设置分区 chime')
}

// 2. 完成事件 → 播放合成音（v0.3.15 四音符，基音 + 泛音）
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, 'complete 合成音产生 8 个振荡器（4 音符 × 基音+泛音）')
  ok(env.oscs[0] && env.oscs[0].frequency.value === 523.25 && env.oscs[0].type === 'sine', 'complete 频率/音型正确')
  ok(env.oscs[1] && env.oscs[1].frequency.value === 1046.5 && env.oscs[1].type === 'sine', '泛音为 2 倍频正弦')
  ok(env.gainRamps.some(([v]) => Math.abs(v - 0.45) < 1e-9), '整体音量 0.45（降杂音）')
}

// 2c. v0.3.17/18：每个音符时值/间隔可以不同（complete 尾音明显更长）
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  const decays = env.gainRamps.filter(([v]) => v < 0.001).map(([, t]) => t)
  ok(decays.length === 4 && decays[3] - decays[2] >= 0.7, 'complete 尾音更长（短短短长节奏）')
}

// 2d. v0.3.18/19：音量变化（complete 渐强）、音色变化（第三音 triangle）、后台/子任务低调
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  const peaks = env.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(peaks.length === 4 && peaks[0] < peaks[1] && peaks[1] < peaks[2] && peaks[2] < peaks[3], 'complete 渐强（每音音量不同）')
  ok(env.oscs[4] && env.oscs[4].type === 'triangle', '音色变化（第三音 triangle）')
  const jd = makeEnv(undefined, undefined, [{ seq: 1, kind: 'jobdone', at: Date.now() }])
  jd.tick()
  await settle()
  const jp = jd.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(jp.length === 3 && jp.every((p) => p < 0.5) && jp[0] > jp[1] && jp[1] > jp[2], 'jobdone 后台低调且渐弱（<0.5）')
  const jf = makeEnv(undefined, undefined, [{ seq: 1, kind: 'jobfail', at: Date.now() }])
  jf.tick()
  await settle()
  const fp = jf.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(fp.length === 3 && fp.every((p) => p < 0.5), 'jobfail 后台低调（<0.5）')
  const sub = makeEnv({ kinds: { subcomplete: { enabled: true, sound: 'default', volume: 1 } } }, undefined, [{ seq: 1, kind: 'subcomplete', at: Date.now() }])
  sub.tick()
  await settle()
  const sp = sub.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(sp.length === 1 && sp[0] < 0.3, 'subcomplete 子任务低调（<0.3）')
}

// 2b. v0.3.17：九种音各有 1~4 音符、跳跃音型（非连续级进）、节奏各异，语义方向正确
{
  const env = makeEnv()
  const freqOf = async (kind) => {
    const seed = kind === 'subcomplete' ? { kinds: { subcomplete: { enabled: true, sound: 'default', volume: 1 } } } : undefined
    const e2 = makeEnv(seed, undefined, [{ seq: 1, kind, at: Date.now() }])
    e2.tick()
    await settle()
    return e2.oscs.filter((o, i) => i % 2 === 0).map((o) => o.frequency.value)
  }
  const c = await freqOf('complete')
  ok(c.length === 4 && c[0] < c[1] && c[1] < c[2] && c[2] < c[3], 'complete 四声上行琶音')
  const sub = await freqOf('subcomplete')
  ok(sub.length === 1, 'subcomplete 单声')
  const jd = await freqOf('jobdone')
  ok(jd.length === 3 && jd[0] < jd[1] && jd[1] < jd[2], 'jobdone 三声跳进上行（392→523→784）')
  const a = await freqOf('approval')
  ok(a.length === 2 && a[0] > a[1], 'approval 慢叮咚高→低（880→659）')
  const q = await freqOf('question')
  ok(q.length === 2 && q[0] < q[1], 'question 上扬双音（523→784）')
  const p = await freqOf('planreview')
  ok(p.length === 3 && p[0] > p[1] && p[1] > p[2], 'planreview 紧凑下行')
  const g = await freqOf('goalblocked')
  ok(g.length === 3 && g.every((f) => f >= 250 && f <= 400) && g[0] === g[1] && g[1] > g[2], 'goalblocked 卡住低音（重复+下行）')
  const inter = await freqOf('interrupt')
  ok(inter.length === 2 && inter[0] > inter[1], 'interrupt 突停双音（880→440）')
  const fail = await freqOf('jobfail')
  ok(fail.length === 3 && fail[0] > fail[1] && fail[1] > fail[2], 'jobfail 坠落三连下行')
}

// 3. 子任务音默认关闭 → 不播放
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'subcomplete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 0, 'subcomplete 默认关闭不响')
}

// 4. 总开关关闭 → 静音
{
  const env = makeEnv({ master: false }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 0, 'master=false 时全部静音')
}

// 5. 旧存储键自动迁移（dsh-chime-v1 → dsh-chime-alerts-v1）
{
  const env = makeEnv(undefined, { master: false, scope: 'all', sysMode: 'auto', kinds: {} })
  ok(env.storage.has('dsh-chime-alerts-v1'), '旧键 dsh-chime-v1 迁移到 dsh-chime-alerts-v1')
}

// 5b. 更老键 dsh-sound-alerts-v1 也迁移到新键
{
  const env = makeEnv(undefined, undefined, [], [], { master: false, scope: 'all', sysMode: 'auto', kinds: {} })
  ok(env.storage.has('dsh-chime-alerts-v1'), '老老键 dsh-sound-alerts-v1 迁移到 dsh-chime-alerts-v1')
}

// 6. 双开关：webBeep=true 播放浏览器音；hostBeep=true 时客户端不重复调 sysbeep（宿主 record() 已响）
{
  const env = makeEnv({ webBeep: true, hostBeep: true }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, dir: '/tmp/chime' })
  env.tick()
  await settle()
  ok(env.oscs.length === 8, 'webBeep=true 播放浏览器音')
  ok(!env.calls.some(([m]) => m === 'sysbeep'), 'hostBeep=true 时客户端不重复调 sysbeep（宿主 record() 已响）')
}

// 6b. webBeep=false 时不播放浏览器音（宿主蜂鸣独立）
{
  const env = makeEnv({ webBeep: false }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 0, 'webBeep=false 不播放浏览器音')
}

// 6c. 旧 sysMode/alwaysBeep 迁移为 hostBeep 并写入宿主
{
  const env = makeEnv({ alwaysBeep: true, sysMode: 'auto' }, undefined, [], [], undefined, { ok: true, hostBeep: null, dir: '/tmp/chime' })
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a.hostBeep === true), '旧 alwaysBeep=true 迁移为 hostBeep=true 并写入宿主')
}

// 6d. 旧 sysMode=off 迁移：webBeep=false（浏览器）、hostBeep=false（宿主）
{
  const env = makeEnv({ sysMode: 'off' }, undefined, [], [], undefined, { ok: true, hostBeep: null, dir: '/tmp/chime' })
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a.hostBeep === false), '旧 sysMode=off 迁移 hostBeep=false')
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const webSwitch = page.filter((n) => n.type === 'button' && n.props.className !== undefined && n.props.className.indexOf('snd-switch') === 0)[1]
  ok(webSwitch !== undefined && webSwitch.props.className === 'snd-switch', '旧 sysMode=off 迁移 webBeep=false（网页响铃开关关闭）')
}

// 7. 播放失败不触发系统蜂鸣（双开关独立，不再自动兜底）
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  globalThis.window.AudioContext = undefined
  env.tick()
  await settle()
  ok(!env.calls.some(([m]) => m === 'sysbeep'), 'webBeep 播放失败时不再自动兜底系统蜂鸣（双开关独立）')
}

// 8. 按工作区静音：事件会话属于被静音工作区 → 不响
{
  const env = makeEnv({ master: true, muted: ['K230'] }, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 's1', at: Date.now() }],
    [{ workspaceId: 'K230', title: 'K230', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 0, '被静音工作区的事件不响')
}

// 8b. 未静音工作区的事件正常播放
{
  const env = makeEnv(undefined, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 's1', at: Date.now() }],
    [{ workspaceId: 'K230', title: 'K230', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, '未静音工作区事件正常播放')
}

// 8c. 工作区映射不到的会话照常响（防御）
{
  const env = makeEnv({ muted: ['K230'] }, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 'unknown', at: Date.now() }],
    [{ workspaceId: 'K230', title: 'K230', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, '未知会话不被误静音')
}

// 8d. muted 旧格式（工作区标题）自动迁移为 workspaceId
{
  const env = makeEnv({ muted: ['K230 工作区'] }, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 's1', at: Date.now() }],
    [{ workspaceId: 'ws1', title: 'K230 工作区', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 0, '旧标题 muted 迁移为 workspaceId 后仍生效')
  ok(env.storage.get('dsh-chime-alerts-v1').indexOf('ws1') >= 0, '迁移结果持久化（muted 含 workspaceId）')
}

// 9. 试听按钮触发播放
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const testBtn = page.find((n) => n.type === 'button' && n.children !== undefined && n.children.some((c) => c === '试听'))
  ok(testBtn !== undefined, '试听按钮存在')
  testBtn.props.onClick()
  await settle()
  ok(env.oscs.length === 8, '试听触发合成音')
}

// 9b. 声音下拉内置「自定义声音…」，选择预设生效，外置上传/清除按钮已移除
{
  const env = makeEnv()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  let page = render(comp())
  const sel = page.find((n) => n.type === 'select' && n.children !== undefined &&
    n.children.flat(2).some((c) => c !== null && typeof c === 'object' && c.props && c.props.value === 'custom'))
  ok(sel !== undefined, '声音下拉包含自定义声音选项')
  const customOpt = page.find((n) => n.type === 'option' && n.props.value === 'custom')
  ok(customOpt !== undefined && String(customOpt.children[0]).indexOf('自定义声音') === 0, '自定义声音选项文案以「自定义声音」开头')
  sel.props.onChange({ target: { value: 'approval' } })
  page = render(comp())
  const sel2 = page.find((n) => n.type === 'select' && n.children !== undefined &&
    n.children.flat(2).some((c) => c !== null && typeof c === 'object' && c.props && c.props.value === 'custom'))
  ok(sel2 !== undefined && sel2.props.value === 'approval', '选择预设声音立即生效')
  ok(!page.some((n) => n.type === 'button' && n.children !== undefined &&
    n.children.some((c) => typeof c === 'string' && (c.indexOf('上传') === 0 || c === '清除'))), '外置上传/清除按钮已移除')
}

// 9c. 单行布局：每行一个图标化静音键 + 音量数值，点击切换静音态
{
  const env = makeEnv()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  let page = render(comp())
  const mutes = page.filter((n) => n.type === 'button' && n.props.className !== undefined && n.props.className.indexOf('snd-row-mute') === 0)
  ok(mutes.length === 9, '每行一个静音图标按钮')
  ok(page.filter((n) => n.type === 'span' && n.props.className === 'snd-vol-val').length === 9, '每行一个音量数值')
  ok(mutes[0].props.className === 'snd-row-mute', '默认非静音态')
  ok(mutes[1].props.className === 'snd-row-mute off', '子任务行默认静音态')
  mutes[0].props.onClick()
  page = render(comp())
  const mutes2 = page.filter((n) => n.type === 'button' && n.props.className !== undefined && n.props.className.indexOf('snd-row-mute') === 0)
  ok(mutes2[0].props.className === 'snd-row-mute off', '点击后显示静音态')
  ok(page.filter((n) => n.props.className === 'snd-row off').length === 2, '对应行变暗')
}

// 9d. 三分类标题
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const titles = page.filter((n) => n.type === 'div' && n.props.className === 'snd-group-title').map((n) => n.children[0])
  ok(titles.length === 3 && titles[0] === '主要通知' && titles[1] === '其他通知' && titles[2] === '需要人介入时', '三分类标题：主要通知/其他通知/需要人介入时')
}

// 9e. 多 tab 领导锁：其他 tab 是 leader 时本 tab 只消费不播放（防双响）
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.storage.set('dsh-chime-alerts-leader', 'other-tab:' + (Date.now() + 60000))
  env.tick()
  await settle()
  ok(env.oscs.length === 0, '非 leader tab 不播放（防双响）')
  ok(env.notifications.length === 0, '非 leader tab 不弹通知')
}

// 9f. 桌面通知：事件触发时弹系统通知（同类事件 tag 合并）
{
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'approval', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.notifications.length === 1 && env.notifications[0].opts.tag === 'dsh-chime-alerts:approval', '事件触发桌面通知（tag 合并同类）')
}

// 9g. 桌面通知开关关闭时不弹
{
  const env = makeEnv({ notifyEnabled: false }, undefined, [{ seq: 1, kind: 'approval', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.notifications.length === 0, '桌面通知开关关闭时不弹')
}

// 10. 样式注入
{
  const env = makeEnv()
  ok(env.styles.inserted.length === 1 && env.styles.inserted[0].indexOf('.snd-ws-mute') >= 0, '样式注入（含工作区静音按钮样式）')
}

// 11. 中英双语：英文环境渲染英文文案（无 navigator 环境默认中文）
{
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
  const env = makeEnv()
  const env2 = makeEnv(undefined, undefined, [{ seq: 1, kind: 'approval', at: Date.now() }])
  Object.defineProperty(globalThis, 'navigator', origNav)
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  ok(env.slotRegs.some((r) => r.options.name === 'settings.section' && r.options.label === 'Sound Alerts'), '英文分区标题 Sound Alerts')
  ok(page.some((n) => n.type === 'button' && n.children !== undefined && n.children.some((c) => c === 'Preview')), '英文试听按钮 Preview')
  const titles = page.filter((n) => n.type === 'div' && n.props.className === 'snd-group-title').map((n) => n.children[0])
  ok(titles.length === 3 && titles[0] === 'Primary notifications' && titles[2] === 'Human action needed', '英文分组标题')
  const customOpt = page.find((n) => n.type === 'option' && n.props.value === 'custom')
  ok(customOpt !== undefined && String(customOpt.children[0]).indexOf('Custom sound') === 0, '英文自定义声音选项文案')
  env2.tick()
  await settle()
  ok(env2.notifications.length === 1 && env2.notifications[0].title === 'Approval needed · Sound alert', '英文通知标题')
}

// 12. v0.3.11：声音范围移除；双开关（网页响铃/宿主蜂鸣）；音频库共享
{
  // 12a. 设置页：无声音范围；四个独立开关（总开关/网页响铃/宿主蜂鸣/桌面通知）；本地存储位置
  const env = makeEnv()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  ok(!render(comp()).some((n) => n.type === 'span' && n.children !== undefined && n.children.some((c) => c === '声音范围')), '设置页不再有声音范围卡片')
  await settle()
  const page = render(comp())
  ok(page.some((n) => n.type === 'div' && n.props.className === 'snd-note' && n.children !== undefined && String(n.children[0]).indexOf('/tmp/chime-test') >= 0), '设置页显示本地存储位置')
  ok(page.filter((n) => n.type === 'button' && n.props.className !== undefined && n.props.className.indexOf('snd-switch') === 0).length === 4, '四个独立开关（总开关/网页响铃/宿主蜂鸣/桌面通知）')

  // 12b. 宿主蜂鸣开关切换触发 sysset（写入宿主本地）
  const switches = page.filter((n) => n.type === 'button' && n.props.className !== undefined && n.props.className.indexOf('snd-switch') === 0)
  switches[2].props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a.hostBeep === true), '宿主蜂鸣开关变更触发 sysset 写入宿主')

  // 12c. 启动时从宿主读取 hostBeep（sysget）
  const env2 = makeEnv({ webBeep: false }, undefined, [], [], undefined, { ok: true, hostBeep: true, dir: '/tmp/chime2' })
  await settle()
  ok(env2.calls.some(([m]) => m === 'sysget'), '启动时调用 sysget 加载宿主设置')

  // 12d. 音频库：loadall 加载 + custom:<id> 按 id 恢复 + 选项出现在下拉（共享）
  const env3 = makeEnv({ kinds: { complete: { enabled: true, sound: 'custom:lib1', volume: 1 } } }, undefined, [], [], undefined,
    { ok: true, hostBeep: false, dir: '/tmp/chime3' }, { ok: true, list: [{ id: 'lib1', name: 'my.mp3' }] }, { ok: true, base64: 'QUJD', name: 'my.mp3' })
  await settle()
  await settle()
  ok(env3.calls.some(([m]) => m === 'loadall'), '启动时调用 loadall 加载音频库')
  ok(env3.calls.some(([m, a]) => m === 'loadaudio' && a.id === 'lib1'), 'sound=custom:<id> 时按 id 恢复音频')
  const page3 = render(env3.slotRegs.find((r) => r.options.name === 'settings.section').component())
  ok(page3.some((n) => n.type === 'option' && n.props.value === 'custom:lib1' && n.children !== undefined &&
    String(n.children[0]).indexOf('my.mp3') >= 0), '音频库条目出现在声音下拉（所有事件共享）')
}

console.log(failures === 0 ? '\nall client tests passed' : `\n${failures} client test(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
