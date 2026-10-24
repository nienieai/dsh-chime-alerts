// cdp-shot.mjs — 用 CDP 驱动已开着调试端口的 msedge/chrome 截图（开发工具，不随包发布）
//
// v0.6.1：不再用 process.exit() 强制结束。一是它会让静态扫描把仓库判成
// critical（R3 process 直接访问），二是强制退出会跳过 finally/清理。
// 现在由 main() 正常返回，错误用 process.exitCode 表达，退出码语义保持不变（2 = 没找到页面）。
import { writeFileSync } from 'node:fs'

async function main() {
  const port = Number(process.argv[2])
  const url = process.argv[3]
  const out = process.argv[4]
  const sel = process.argv[5] || '#s'
  const clipH = Number(process.argv[6] || 300)

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) { console.error('no page target'); process.exitCode = 2; return }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result?.value
  }

  try {
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1200, deviceScaleFactor: 1, mobile: false })
    await send('Runtime.enable')
    await send('Page.navigate', { url })
    await new Promise((r) => setTimeout(r, 900))
    await evaluate('window.scrollTo(0,0)')
    const rect = JSON.parse(await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      el.scrollIntoView({ block: 'center' });
      window.scrollBy(0, el.getBoundingClientRect().top - 220);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()`))

    const cx = Math.round(rect.x + rect.w / 2)
    const cy = Math.round(rect.y + rect.h / 2)
    console.log('rect', rect, 'click', cx, cy)

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 })
    await new Promise((r) => setTimeout(r, 700))

    const hover = process.argv[7]
    if (hover) {
      const [dx, dy] = hover.split(',').map(Number)
      const hx = Math.round(rect.x + dx), hy = Math.round(rect.y + dy)
      for (let i = 1; i <= 6; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(hx - 60 + (60 * i) / 6),
          y: Math.round(hy - 30 + (30 * i) / 6)
        })
        await new Promise((r) => setTimeout(r, 60))
      }
      console.log('hover at', hx, hy)
      await new Promise((r) => setTimeout(r, 400))
    }

    const open = await evaluate('JSON.stringify({ open: document.querySelector(' + JSON.stringify(sel) + ').matches(":open") })')
    console.log('state', open)

    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1000, height: 1200, scale: 1 }
    })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log('wrote', out)
  } finally {
    try { ws.close() } catch (err) {}
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err))
  process.exitCode = 1
})
