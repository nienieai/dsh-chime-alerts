// 客户端半逻辑冒烟测试：node tools/test-client.mjs（Node 可跑，无需浏览器）
// 用假 React / window / slots / host 驱动 client.js，断言默认值、持久化迁移、
// 事件触发播放、系统蜂鸣兜底、快捷静音按钮与插槽注册。
import { readFileSync } from 'node:fs'
import { installFakeDom } from './fake-dom.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// v0.6.0：每个事件默认「关」。需要出声的用例显式种下 beep；makeEnv 会给种子里
// 没写 mode 的事件补 'beep'（见其注释），所以这里只列事件名。
const BEEP_SEED = {
  kinds: {
    complete: { enabled: true, mode: 'beep' },
    subcomplete: { enabled: true, mode: 'beep' },
    jobdone: { enabled: true, mode: 'beep' },
    jobfail: { enabled: true, mode: 'beep' },
    interrupt: { enabled: true, mode: 'beep' },
    approval: { enabled: true, mode: 'beep' },
    pluginapproval: { enabled: true, mode: 'beep' },
    question: { enabled: true, mode: 'beep' },
    planreview: { enabled: true, mode: 'beep' },
    goalblocked: { enabled: true, mode: 'beep' }
  }
}
// 需要「通知」态（桌面通知）的用例用它
const NOTIFY_SEED = { notifyEnabled: true, kinds: { approval: { enabled: true, mode: 'notify' }, question: { enabled: true, mode: 'notify' } } }
let failures = 0
const ok = (cond, label) => {
  if (cond) console.log('PASS', label)
  else { failures++; console.log('FAIL', label) }
}

function makeEnv(seedLocal, legacyLocal, pullEvents = [], workspaceItems = [], oldLegacyLocal = undefined, sysgetRes = { ok: true, hostBeep: false, dir: '/tmp/chime-test' }, loadallRes = { ok: true, list: [] }, loadaudioRes = { ok: false }, opts = {}) {
  // 浏览器全局假体（每个场景独立）
  const storage = new Map()
  if (seedLocal !== undefined) {
    // v0.6.0：种子里的 kind 没写 mode 时补 beep（老用例都是按「响铃」写的）
    const seed = JSON.parse(JSON.stringify(seedLocal))
    if (seed && seed.kinds) {
      const kindKeys = Object.keys(seed.kinds)
      for (let i = 0; i < kindKeys.length; i++) {
        const k = seed.kinds[kindKeys[i]]
        if (k && typeof k === 'object' && typeof k.mode !== 'string') k.mode = 'beep'
      }
    }
    storage.set('dsh-chime-alerts-v1', JSON.stringify(seed))
  }
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
  if (opts.noNotification) { delete globalThis.Notification }
  globalThis.window = {
    // 「防双响」用页面地址判断是不是同一台设备；测试默认按本机（127.0.0.1）
    location: { hostname: '127.0.0.1' },
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
  return { storage, oscs, gainRamps, audioPlays, notifications, react, styles, calls, slotRegs, tick: () => intervals[0](),
    runIntervals: () => { for (const fn of intervals.slice()) { try { fn() } catch (err) {} } } }
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

// 1. 默认值与十类事件卡片（v0.4.6 新增 pluginapproval）
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  ok(page.filter((n) => n.type === 'div' && (n.props.className === 'snd-row' || n.props.className === 'snd-row off')).length === 10, '设置页渲染 10 张事件卡片')
  ok(byText(page, '插件授权') !== undefined, '渲染「插件授权」事件行')
  ok(env.slotRegs.some((r) => r.options.name === 'settings.section' && String(r.options.id).indexOf('chime') === 0), '注册设置分区 chime')
}

// 2. 完成事件 → 播放合成音（v0.3.15 四音符，基音 + 泛音）
{
  const env = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, 'complete 合成音产生 8 个振荡器（4 音符 × 基音+泛音）')
  ok(env.oscs[0] && env.oscs[0].frequency.value === 523.25 && env.oscs[0].type === 'sine', 'complete 频率/音型正确')
  ok(env.oscs[1] && env.oscs[1].frequency.value === 1046.5 && env.oscs[1].type === 'sine', '泛音为 2 倍频正弦')
  ok(env.gainRamps.some(([v]) => Math.abs(v - 0.45) < 1e-9), '整体音量 0.45（降杂音）')
}

// 2c. v0.3.17/18：每个音符时值/间隔可以不同（complete 尾音明显更长）
{
  const env = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  const decays = env.gainRamps.filter(([v]) => v < 0.001).map(([, t]) => t)
  ok(decays.length === 4 && decays[3] - decays[2] >= 0.7, 'complete 尾音更长（短短短长节奏）')
}

// 2d. v0.3.18/19：音量变化（complete 渐强）、音色变化（第三音 triangle）、后台/子任务低调
{
  const env = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  const peaks = env.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(peaks.length === 4 && peaks[0] < peaks[1] && peaks[1] < peaks[2] && peaks[2] < peaks[3], 'complete 渐强（每音音量不同）')
  ok(env.oscs[4] && env.oscs[4].type === 'triangle', '音色变化（第三音 triangle）')
  const jd = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'jobdone', at: Date.now() }])
  jd.tick()
  await settle()
  const jp = jd.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(jp.length === 3 && jp.every((p) => p < 0.5) && jp[0] > jp[1] && jp[1] > jp[2], 'jobdone 后台低调且渐弱（<0.5）')
  const jf = makeEnv({ kinds: { jobfail: { enabled: true, mode: 'beep', sound: 'default', volume: 1 } } }, undefined, [{ seq: 1, kind: 'jobfail', at: Date.now() }])
  jf.tick()
  await settle()
  const fp = jf.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(fp.length === 3 && fp.every((p) => p < 0.5), 'jobfail 后台低调（<0.5）')
  const sub = makeEnv({ kinds: { subcomplete: { enabled: true, mode: 'beep', sound: 'default', volume: 1 } } }, undefined, [{ seq: 1, kind: 'subcomplete', at: Date.now() }])
  sub.tick()
  await settle()
  const sp = sub.gainRamps.filter(([v]) => v > 0.1).map(([v]) => v)
  ok(sp.length === 1 && sp[0] < 0.3, 'subcomplete 子任务低调（<0.3）')
}

// 2b. v0.3.17：九种音各有 1~4 音符、跳跃音型（非连续级进）、节奏各异，语义方向正确
{
  const env = makeEnv()
  const freqOf = async (kind) => {
    // v0.6.0：这些用例测音型，必须走响铃通道
    const seed = { kinds: {} }
    seed.kinds[kind] = { enabled: true, mode: 'beep', sound: 'default', volume: 1 }
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
  const env = makeEnv({ kinds: { subcomplete: { mode: 'beep' } } }, undefined, [{ seq: 1, kind: 'subcomplete', at: Date.now() }])
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
  const env = makeEnv(BEEP_SEED, undefined, [], [], { master: false, scope: 'all', sysMode: 'auto', kinds: {} })
  ok(env.storage.has('dsh-chime-alerts-v1'), '老老键 dsh-sound-alerts-v1 迁移到 dsh-chime-alerts-v1')
}

// 6. 双开关：webBeep=true 播放浏览器音；客户端从不主动调 sysbeep（宿主 record() 已响）
{
  const env = makeEnv({ webBeep: true }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, 'webBeep=true 播放浏览器音')
  ok(!env.calls.some(([m]) => m === 'sysbeep'), '客户端不重复调 sysbeep（宿主 record() 已响）')
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
  const webChip = page.find((n) => n.type === 'button' && n.props['data-chip'] === 'webBeep')
  ok(webChip !== undefined && webChip.props.className.indexOf(' on') < 0, '旧 sysMode=off 迁移 webBeep=false（网页响铃 chip 关闭）')
}

// 7. 播放失败不触发系统蜂鸣（双开关独立，不再自动兜底）
{
  const env = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
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
  const env = makeEnv(BEEP_SEED, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 's1', at: Date.now() }],
    [{ workspaceId: 'K230', title: 'K230', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, '未静音工作区事件正常播放')
}

// 8c. 工作区映射不到的会话照常响（防御）
{
  const env = makeEnv({ muted: ['K230'], kinds: { complete: { mode: 'beep' } } }, undefined,
    [{ seq: 1, kind: 'complete', sessionId: 'unknown', at: Date.now() }],
    [{ workspaceId: 'K230', title: 'K230', sessionIds: ['s1'] }])
  env.tick()
  await settle()
  ok(env.oscs.length === 8, '未知会话不被误静音')
}

// 8d. muted 旧格式（工作区标题）自动迁移为 workspaceId
{
  const env = makeEnv({ muted: ['K230 工作区'], kinds: { complete: { mode: 'beep' } } }, undefined,
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
  const testBtn = page.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-ib') >= 0 && n.props.className.indexOf('play') >= 0)
  ok(testBtn !== undefined, '试听按钮存在（▶ 图标）')
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
  const cards = () => page.filter((n) => n.type === 'div' && (n.props.className === 'snd-row' || n.props.className === 'snd-row off'))
  const switches = () => page.filter((n) => n.type === 'button' && n.props.role === 'switch')
  ok(cards().length === 10, '每个事件一张卡片')
  ok(page.filter((n) => n.type === 'span' && n.props.className === 'snd-vol-val').length === 10, '每行一个音量数值')
  ok(cards()[0].props.className === 'snd-row', '默认非静音态')
  ok(cards()[1].props.className === 'snd-row off', '子任务行默认静音态')
  // switches[0] 是总开关，之后按 KIND_ORDER 排列（complete 在前）
  switches()[1].props.onClick()
  page = render(comp())
  ok(cards()[0].props.className === 'snd-row off', '点击卡内开关后变静音态')
  ok(cards().filter((c) => c.props.className === 'snd-row off').length === 5, '对应行变暗（默认关 4 类 + 刚关掉的 complete）')
}

// 9d. 三分类标题
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const titles = page.filter((n) => n.props.className === 'snd-grp-name').map((n) => n.children[0])
  ok(titles.length === 3 && titles[0] === '主要通知' && titles[1] === '其他通知' && titles[2] === '需要人介入时', '三分类标题：主要通知/其他通知/需要人介入时')
}

// 9e. v0.3.20：默认下拉选项显示声音名称（不再写「默认（本事件专属音）」）
{
  const env = makeEnv()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const options = page.filter((n) => n.type === 'option')
  ok(options.some((o) => o.children !== undefined && String(o.children[0]).indexOf('凯旋') === 0), '默认选项显示声音名称（凯旋）')
  ok(!options.some((o) => o.children !== undefined && String(o.children[0]).indexOf('默认（本事件专属音）') === 0), '不再显示「默认（本事件专属音）」')
}

// 9f. v0.3.20：宿主蜂鸣开启时每行追加第二行（宿主音下拉 + 宿主试听），浏览器/宿主试听分离
{
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, dir: '/tmp/chime-test' })
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  let page = render(comp())
  ok(byText(page, '宿主提醒') !== undefined, '宿主提醒开启时渲染宿主行')
  // v0.6.0：每事件一个三选一。旧配置（hostBeep=true 且没有 eventModes）按 hostMuted 还原成响铃，
  ok(page.filter((n) => n.type === 'div' && n.props.className === 'snd-seg').length === 10, '每个事件一个三选一')
  ok(page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostpreview') >= 0).length === 10, '旧配置还原成响铃：每个事件都有宿主试听（10 个）')
  ok(page.filter((n) => n.type === 'select' && n.props.className !== undefined && n.props.className.indexOf('snd-host-select') >= 0).length === 10, '旧配置还原成响铃：每个事件都有宿主音下拉（10 个）')
  ok(page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostnotify') >= 0).length === 0, '默认没有通知态事件 → 没有测试按钮（通知要手动选）')
  // 载入时把宿主侧没有记录的事件校正成界面所见（旧配置只剩部分 eventModes 时必须写实）
  const reconcile = env.calls.filter(([m, a]) => m === 'sysset' && a && a.eventModes)
  ok(reconcile.length > 0, '载入后把宿主模式校正成界面所见（旧配置只有部分 eventModes）')
  const recModes = reconcile.length > 0 ? reconcile[0][1].eventModes : null
  ok(recModes !== null && Object.keys(recModes).length === 10 && Object.values(recModes).every((v) => v === 'beep'), '校正写入 10 个事件（旧配置按 hostMuted 还原为响铃）')
  const hostPreview = page.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostpreview') >= 0)
  hostPreview.props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysbeep' && a && a.kind === 'complete'), '宿主试听调用 sysbeep（带事件）')
  // 浏览器试听只播浏览器音，不调 sysbeep（分离）
  env.calls.length = 0
  page = render(comp())
  const browserPreview = page.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-ib') >= 0 && n.props.className.indexOf('play') >= 0 && n.props.className.indexOf('snd-hostpreview') < 0)
  browserPreview.props.onClick()
  await settle()
  ok(env.oscs.length > 0, '浏览器试听播放合成音')
  ok(!env.calls.some(([m]) => m === 'sysbeep'), '浏览器试听不调 sysbeep（分离）')
  // 宿主音下拉选择 → 调 sysset 保存 hostSounds
  env.calls.length = 0
  page = render(comp())
  const hostSelect = page.find((n) => n.type === 'select' && n.props.className !== undefined && n.props.className.indexOf('snd-host-select') >= 0)
  hostSelect.props.onChange({ target: { value: 'Windows Error.wav' } })
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.hostSounds && a.hostSounds.complete === 'Windows Error.wav'), '宿主音下拉选择保存到宿主')
}

// 9g. v0.4.0：Linux 平台宿主音选项（freedesktop 主题音，不含 Windows wav）
{
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, dir: '/tmp/chime-test', platform: 'linux' })
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  const hostSelects = page.filter((n) => n.type === 'select' && n.props.className !== undefined && n.props.className.indexOf('snd-host-select') >= 0)
  ok(hostSelects.length === 10, 'linux：旧配置还原成响铃 → 每个事件都有宿主音下拉（10 个）')
  const values = hostSelects[0].children.flat(2).filter((c) => c !== null && typeof c === 'object' && c.props && typeof c.props.value === 'string').map((c) => c.props.value)
  ok(values.indexOf('complete') >= 0 && values.indexOf('dialog-error') >= 0 && values.indexOf('bell') >= 0, 'linux 选项为 freedesktop 主题音')
  ok(values.indexOf('chimes.wav') < 0 && values.indexOf('Windows Error.wav') < 0, 'linux 选项不含 Windows wav')
  ok(hostSelects[0].props.value === 'complete', 'linux complete 默认宿主音 = complete')
  hostSelects[0].props.onChange({ target: { value: 'dialog-warning' } })
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.hostSounds && a.hostSounds.complete === 'dialog-warning'), 'linux 宿主音选择保存到宿主')
}

// 9h. v0.4.1：宿主响铃不支持（capBeep=false）时宿主蜂鸣相关控件禁用变灰
{
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: false })
  await settle()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const chips = page.filter((n) => n.type === 'button' && n.props['data-chip'] !== undefined)
  ok(chips.length === 3, '三个 chip 仍在（含禁用态）')
  const hostChip = chips.find((c) => c.props['data-chip'] === 'hostBeep')
  const notifyChip = chips.find((c) => c.props['data-chip'] === 'notify')
  ok(hostChip.props.disabled === true && hostChip.props.onClick === undefined, '宿主蜂鸣 chip 禁用且不可点击')
  ok(notifyChip.props.disabled === undefined, '网页通知 chip 不受宿主能力影响')
  const hostSelect = page.find((n) => n.type === 'select' && n.props.className !== undefined && n.props.className.indexOf('snd-host-select') >= 0)
  ok(hostSelect !== undefined && hostSelect.props.disabled === true, '宿主音下拉禁用')
  const hostPreviewBtn = page.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostpreview') >= 0)
  ok(hostPreviewBtn !== undefined && hostPreviewBtn.props.disabled === true, '宿主试听按钮禁用')
}

// 9i. v0.4.1：浏览器不支持 Notification 时桌面通知开关禁用
{
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: false, dir: '/tmp/chime-test' }, undefined, undefined, { noNotification: true })
  await settle()
  const page = render(env.slotRegs.find((r) => r.options.name === 'settings.section').component())
  const chips = page.filter((n) => n.type === 'button' && n.props['data-chip'] !== undefined)
  const notifyChip = chips.find((c) => c.props['data-chip'] === 'notify')
  const hostChip = chips.find((c) => c.props['data-chip'] === 'hostBeep')
  ok(notifyChip.props.disabled === true, 'Notification 缺失时网页通知 chip 禁用')
  ok(hostChip.props.disabled === undefined, '宿主蜂鸣 chip 不受影响（capBeep 未知不禁用）')
}

// 9j. v0.6.0：宿主提醒改为每事件三选一（关 / 响铃 / 通知），去掉独立静音键
{
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, hostMuted: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  let page = render(comp())
  ok(byText(page, '网页通知') !== undefined, '开关改名为网页通知')
  ok(!page.some((n) => n.type === 'span' && n.children !== undefined && n.children.some((c) => String(c).indexOf('桌面通知') === 0)), '不再显示「桌面通知」')
  ok(page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostmute') >= 0).length === 0, '宿主静音键已删除（三选一的「关」即静音）')
  const segBtns = page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-seg-btn') >= 0)
  ok(segBtns.length === 30, '三选一每格都是按钮（10 × 3）')
  // 旧配置（hostBeep=true 且没有 eventModes）按 hostMuted 还原成「响铃」
  const onBtns = segBtns.filter((b) => b.props.className.indexOf(' on') >= 0)
  ok(onBtns.length === 10, '每个事件有一个选中格')
  const notifyCount = onBtns.filter((b) => String(b.children[0]) === '通知').length
  ok(notifyCount === 0, '默认没有事件处于「通知」态（通知必须手动选）')
  // 点「关」→ 写 eventModes
  const offBtn = segBtns.find((b) => String(b.children[0]) === '关')
  const notifySeg = segBtns.find((b) => String(b.children[0]) === '通知')
  notifySeg.props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.eventModes && a.eventModes.complete === 'notify'), '切到「通知」写 eventModes=notify')
  const page2 = render(comp())
  ok(page2.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostnotify') >= 0).length === 1, '选中「通知」后才出现测试按钮')
  // 点「关」→ 写 eventModes=off
  env.calls.length = 0
  offBtn.props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.eventModes && a.eventModes.complete === 'off'), '切到「关」写 eventModes=off')
  page = render(comp())
  ok(page.filter((c) => c.type === 'div' && (c.props.className === 'snd-row' || c.props.className === 'snd-row off')).length === 10, '事件卡片仍在（未被三选一影响）')
}

// 9e. 多 tab 领导锁：其他 tab 是 leader 时本 tab 只消费不播放（防双响）
{
  const env = makeEnv(BEEP_SEED, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.storage.set('dsh-chime-alerts-leader', 'other-tab:' + (Date.now() + 60000))
  env.tick()
  await settle()
  ok(env.oscs.length === 0, '非 leader tab 不播放（防双响）')
  ok(env.notifications.length === 0, '非 leader tab 不弹通知')
}

// 9f. 桌面通知：事件触发时弹系统通知（同类事件 tag 合并）
{
  const env = makeEnv(NOTIFY_SEED, undefined, [{ seq: 1, kind: 'approval', at: Date.now() }])
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
  ok(env.styles.inserted.length === 1 && env.styles.inserted[0].indexOf('.snd-ws-mark') >= 0, '样式注入（含工作区静音标记样式）')
}

// 11. 中英双语：英文环境渲染英文文案（无 navigator 环境默认中文）
{
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
  const env = makeEnv()
  const env2 = makeEnv(NOTIFY_SEED, undefined, [{ seq: 1, kind: 'approval', at: Date.now() }])
  Object.defineProperty(globalThis, 'navigator', origNav)
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  ok(env.slotRegs.some((r) => r.options.name === 'settings.section' && (typeof r.options.label === 'function' ? r.options.label() : r.options.label) === 'Sound Alerts'), '英文分区标题 Sound Alerts')
  // v0.5.10：id 固定、label 是 thunk（真机曾因字符串 label + 换 id 硬刷导致导航项不跟语言）
  {
    const reg = env.slotRegs.find((r) => r.options.name === 'settings.section')
    ok(reg.options.id === 'chime-alerts', '英文下分区 id 固定为 chime-alerts')
    ok(typeof reg.options.label === 'function', '分区 label 是 thunk')
    ok(page.some((n) => n.type === 'div' && n.children !== undefined && String(n.children[0]).indexOf('Dynamic build v0.6.0') === 0), '英文版本标注 Dynamic build v0.5.10')
  }
  ok(page.some((n) => n.type === 'button' && n.children !== undefined && n.children.some((c) => c === 'All off')), '英文批量按钮 All off')
  const titles = page.filter((n) => n.props.className === 'snd-grp-name').map((n) => n.children[0])
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
  ok(page.filter((n) => n.type === 'button' && n.props['data-chip'] !== undefined).length === 3, '顶部三个 chip（网页响铃/网页通知/宿主蜂鸣）')
  ok(page.filter((n) => n.type === 'button' && n.props.role === 'switch').length === 11, '总开关 + 每事件开关（1 + 10）')
  ok(page.some((n) => n.type === 'div' && n.children !== undefined && typeof n.children[0] === 'string' && n.children[0].indexOf('6 / 10 个事件会提醒') === 0), '标题卡片副标题沿用 0.5.10 文案（N / 10 个事件会提醒）')

  // 12b. 开启宿主提醒先弹确认框；确认后才写宿主（并把每事件三选一显式写实）
  const hostChipBtn = page.find((n) => n.type === 'button' && n.props['data-chip'] === 'hostBeep')
  const beforeHost = env.calls.length
  hostChipBtn.props.onClick()
  await settle()
  ok(env.calls.slice(beforeHost).every(([m]) => m !== 'sysset'), '未确认前不写宿主设置（不触发任何宿主动作）')
  const modalPage = render(comp())
  ok(modalPage.some((n) => n.type === 'div' && n.props.className === 'snd-modal'), '开启宿主提醒弹出确认框（提示 PowerShell / 杀软风险）')
  const confirmBtn = modalPage.find((n) => n.type === 'button' && n.props['data-act'] === 'host-enable')
  ok(confirmBtn !== undefined, '确认框有「开启」按钮')
  // 文案要求：设置界面不出现实现细节（PowerShell），只说「可能被安全软件拦截 / 信任则放行」
  const modalText = JSON.stringify(modalPage)
  ok(modalText.indexOf('信任') >= 0 && modalText.indexOf('放行') >= 0, '弹窗文案说明「信任则允许放行」')
  ok(modalText.indexOf('PowerShell') < 0, '弹窗文案不出现 PowerShell 等实现细节')
  confirmBtn.props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.hostBeep === true), '确认后写 hostBeep=true')
  const bulk = env.calls.filter(([m, a]) => m === 'sysset' && a && a.eventModes).pop()
  ok(bulk !== undefined && Object.keys(bulk[1].eventModes).length === 10 && Object.values(bulk[1].eventModes).every((v) => v === 'off'), '确认时把 10 个事件全量写成「关」（默认不启用）')
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

// 13. v0.5.10：导航图标与工作区标记走真实 DOM 路径（假 DOM 驱动）
// 回归背景之一：这段代码此前把需要重新赋值的绑定写成了 const（`for (const i = 0; …)`、
// `const titleEl = null` 之后再赋值），运行时必抛 TypeError，又被外层 try/catch 吞掉——
// 动态安装下工作区标记从来不显示，且没有任何日志可查。
{
  const dom = installFakeDom({
    body: [
      { tag: 'div', className: 'navCell', children: [{ tag: 'svg' }, { tag: 'span', text: '声音提醒' }] },
      { tag: 'div', attrs: { role: 'treeitem', 'aria-expanded': 'true' },
        rect: { left: 20, top: 100, right: 300, bottom: 128, width: 280, height: 28 },
        children: [
          { tag: 'div', children: [{ tag: 'span', text: 'K230' }] },
          { tag: 'button', rect: { left: 260, top: 104, right: 280, bottom: 124, width: 20, height: 20 } },
        ] },
    ],
  })
  const env = makeEnv({ muted: ['w1'] }, undefined, [], [{ workspaceId: 'w1', title: 'K230' }])
  env.runIntervals()
  const navRow = dom.findAll('.navCell')[0]
  ok(navRow !== undefined && navRow.getAttribute('data-chime-nav') === '1', '导航行被打上 data-chime-nav')
  ok(env.styles.inserted[0].indexOf('[data-chime-nav]') >= 0, '动态版样式包含导航图标选择器')
  const marks = dom.findAll('.snd-ws-mark')
  ok(marks.length === 1, '已静音工作区渲染出标记（const 重新赋值 bug 回归）')
  ok(marks[0] !== undefined && marks[0].style.left === '241px', '标记贴在「…」按钮左侧（260-19=241）')
  ok(marks[0] !== undefined && marks[0].getAttribute('data-chime-ws-mark') === 'w1', '标记带工作区 id')
  dom.restore()
}

// 17. 提醒方式的新语义（动态版）：三选一管宿主，宿主没接管时浏览器照常提醒
{
  // 宿主提醒关着（默认）：选了「通知」也照常出声；网页通知默认关
  const env = makeEnv({ kinds: { complete: { enabled: true, mode: 'notify', level: 'important' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.oscs.length > 0, '宿主没接管时照常出声')
  ok(env.notifications.length === 0, '网页通知默认关 → 不弹通知')
}
{
  const env = makeEnv({ notifyEnabled: true, kinds: { complete: { enabled: true, mode: 'notify', level: 'important' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.notifications.length === 1, '网页通知开 → 弹一条浏览器通知')
  ok(env.notifications[0].opts.requireInteraction === true, '重要等级带 requireInteraction')
}
{
  const env = makeEnv({ notifyEnabled: true, kinds: { complete: { enabled: true, mode: 'notify', level: 'silent' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }])
  env.tick()
  await settle()
  ok(env.notifications.length === 1 && env.notifications[0].opts.silent === true, '静默等级：silent=true')
}
{
  // 宿主开着 + 响铃，但「防双响」默认关 → 两边各响一次
  const env = makeEnv({ kinds: { complete: { enabled: true, mode: 'beep' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'beep' }, hostMuted: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  env.tick()
  await settle()
  ok(env.oscs.length > 0, '防双响默认关 → 宿主响的同时浏览器也响')
}
{
  // 防双响开 + 本机页面：只留宿主那一声
  const env = makeEnv({ dedupe: true, kinds: { complete: { enabled: true, mode: 'beep' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'beep' }, hostMuted: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  env.tick()
  await settle()
  ok(env.oscs.length === 0, '防双响开（本机）→ 只留宿主那一声')
}
{
  // 防双响开，但页面在另一台设备上 → 不压
  const env = makeEnv({ dedupe: true, kinds: { complete: { enabled: true, mode: 'beep' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'beep' }, hostMuted: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  globalThis.window.location.hostname = '192.168.1.50'
  env.tick()
  await settle()
  ok(env.oscs.length > 0, '另一台设备上不压浏览器（各响各的）')
}
{
  // 宿主开着但该事件为「关」→ 浏览器照常
  const env = makeEnv({ kinds: { complete: { enabled: true, mode: 'off' } } }, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'off' }, hostMuted: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  env.tick()
  await settle()
  ok(env.oscs.length > 0, '宿主开着但事件为「关」→ 浏览器照常响')
}
{
  // 旧配置迁移：旧版「宿主静音」→ 卡片开关也关掉（整体不提醒）
  const env = makeEnv(undefined, undefined, [{ seq: 1, kind: 'complete', at: Date.now() }], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, hostMuted: { complete: true }, dir: '/tmp/chime-test', platform: 'win32', capBeep: true })
  env.tick()
  await settle()
  ok(env.oscs.length === 0 && env.notifications.length === 0, '旧设置迁移：hostMuted 的事件整体不提醒')
}
{
// 「测试」按钮走宿主 sysnotify
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'notify' }, notifyLevels: { complete: 'normal' }, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  const testBtn = page.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.indexOf('snd-hostnotify') >= 0)
  ok(testBtn !== undefined, '通知态事件渲染测试按钮')
  env.calls.length = 0
  testBtn.props.onClick()
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysnotify' && a && a.kind === 'complete' && a.level === 'normal'), '测试按钮调宿主 sysnotify（带当前等级）')
}
{
  // 0.6.0 修正：试听只出声、不弹通知，也不受「网页响铃」通道开关限制
  const env = makeEnv(
    { master: true, webBeep: false, notifyEnabled: true, muted: [], kinds: { complete: { enabled: true, mode: 'notify', level: 'important', sound: 'default', volume: 0.6 } } },
    undefined,
    [],
    [],
    undefined,
    { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'notify' }, notifyLevels: { complete: 'important' }, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true }
  )
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  const playBtns = page.filter((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className === 'snd-ib play')
  ok(playBtns.length === 10, '动态版：每个事件都有网页音试听键（10 个）')
  const beforeOsc = env.oscs.length
  const beforeNotif = env.notifications.length
  playBtns[0].props.onClick()
  await settle()
  ok(env.oscs.length > beforeOsc, '通知模式的事件点试听仍然出声（网页响铃通道关着也出声）')
  ok(env.notifications.length === beforeNotif, '通知模式的事件点试听不弹浏览器通知')
}
{
  // 通知等级下拉写宿主 notifyLevels
  const env = makeEnv(BEEP_SEED, undefined, [], [], undefined, { ok: true, hostBeep: true, hostSounds: {}, eventModes: { complete: 'notify' }, notifyLevels: {}, dir: '/tmp/chime-test', platform: 'win32', capBeep: true, capNotify: true })
  await settle()
  const comp = env.slotRegs.find((r) => r.options.name === 'settings.section').component
  const page = render(comp())
  const levelSel = page.filter((n) => n.type === 'select').find((n) => (n.children || []).flat(2).some((c) => c && c.props && c.props.value === 'important'))
  ok(levelSel !== undefined, '通知态事件渲染等级下拉')
  env.calls.length = 0
  levelSel.props.onChange({ target: { value: 'important' } })
  await settle()
  ok(env.calls.some(([m, a]) => m === 'sysset' && a && a.notifyLevels && a.notifyLevels.complete === 'important'), '等级选择写宿主（sysset notifyLevels）')
}

console.log(failures === 0 ? '\nall client tests passed' : `\n${failures} client test(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
