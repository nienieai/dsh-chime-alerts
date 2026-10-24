// fake-dom.mjs —— 测试用的极简 DOM 桩。
//
// 为什么需要它：客户端的「设置导航图标」与「工作区静音标记」都按真实 DOM 定位，
// 而它们恰恰是最容易静默失效的部分（v0.5.9 里导航图标用了 `nth-child(5)` + 外壳
// 混淆类名，外壳一改就整条失效，页面上只剩默认齿轮，且没有任何报错）。没有 DOM
// 就在测试里看不见这类回归，所以这里提供一个够用的小实现：
//
//   只支持客户端实际用到的选择器形态：`tag`、`.class`、`[attr]`、`[attr="value"]`、
//   `tag[attr="value"]`，以及逗号分隔的组合（任一命中即可）。
//   不支持层级、伪类、`>` 等——真需要时再加，别把它写成通用 DOM。

class FakeEl {
  constructor(tagName, text) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this.className = ''
    this.id = ''
    this.title = ''
    this._text = text === undefined ? null : String(text)
    this._attrs = new Map()
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  get textContent() {
    if (this._text !== null) return this._text
    return this.children.map((c) => c.textContent).join('')
  }

  set textContent(v) {
    this._text = v === null || v === undefined ? '' : String(v)
  }

  setAttribute(k, v) { this._attrs.set(String(k), String(v)) }

  getAttribute(k) {
    const v = this._attrs.get(String(k))
    return v === undefined ? null : v
  }

  removeAttribute(k) { this._attrs.delete(String(k)) }

  hasAttribute(k) { return this._attrs.has(String(k)) }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  remove() {
    const p = this.parentElement
    if (p !== null) {
      const i = p.children.indexOf(this)
      if (i >= 0) p.children.splice(i, 1)
    }
    this.parentElement = null
  }

  /** 测试里手动摆位置（工作区标记按矩形定位，需要非零矩形才会落位） */
  setRect(rect) { this._rect = Object.assign({}, this._rect, rect); return this }

  getBoundingClientRect() { return this._rect }

  matches(selector) { return matchAny(this, selector) }

  querySelectorAll(selector) {
    const out = []
    walk(this, (n) => { if (n !== this && matchAny(n, selector)) out.push(n) })
    return out
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function walk(node, fn) {
  for (const c of node.children) { fn(c); walk(c, fn) }
}

function textOf(el) {
  if (el.className === '') return ''
  return String(el.className)
}

function matchOne(el, part) {
  const src = part.trim()
  if (src === '') return false
  let rest = src
  let tag = null
  const mTag = /^([a-zA-Z][\w-]*)/.exec(rest)
  if (mTag) { tag = mTag[1].toUpperCase(); rest = rest.slice(mTag[1].length) }
  if (tag !== null && el.tagName !== tag) return false
  const rePart = /(\.[\w-]+|\[[^\]]+\])/g
  let m
  let sawAny = false
  while ((m = rePart.exec(rest)) !== null) {
    sawAny = true
    const token = m[1]
    if (token.startsWith('.')) {
      const cls = token.slice(1)
      if ((' ' + el.className + ' ').indexOf(' ' + cls + ' ') < 0) return false
      continue
    }
    const inner = token.slice(1, -1)
    const eq = inner.indexOf('=')
    if (eq < 0) {
      if (!el.hasAttribute(inner)) return false
      continue
    }
    const name = inner.slice(0, eq).trim()
    let want = inner.slice(eq + 1).trim()
    if ((want.startsWith('"') && want.endsWith('"')) || (want.startsWith("'") && want.endsWith("'"))) want = want.slice(1, -1)
    if (el.getAttribute(name) !== want) return false
  }
  return sawAny || tag !== null
}

function matchAny(el, selector) {
  if (typeof selector !== 'string') return false
  if (selector === ':hover') return false
  return selector.split(',').some((part) => matchOne(el, part))
}

/**
 * 装上假 document / window 环境。
 * spec.body：body 下预置的节点（数组），例如 [{ tag: 'div', className: 'row', children: [...] }]
 * 返回 { document, body, head, find, findAll, restore }。
 */
export function installFakeDom(spec = {}) {
  const doc = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => new FakeEl('#text', t),
    addEventListener() {},
    removeEventListener() {},
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
  }
  doc.body = new FakeEl('body')
  doc.head = new FakeEl('head')
  doc.documentElement = new FakeEl('html')
  doc.body.parentElement = doc.documentElement
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)

  for (const node of (spec.body || [])) doc.body.appendChild(build(node))

  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })

  return {
    document: doc,
    body: doc.body,
    head: doc.head,
    findAll: (sel) => doc.body.querySelectorAll(sel),
    find: (sel) => doc.body.querySelector(sel),
    add(node) { return doc.body.appendChild(build(node)) },
    restore() {
      if (prevDoc === undefined) delete globalThis.document
      else Object.defineProperty(globalThis, 'document', prevDoc)
    },
  }
}

/** 按简单描述建节点树：{ tag, className, text, attrs: {k: v}, children: [...] } */
export function build(node) {
  const el = new FakeEl(node.tag || 'div', node.text)
  if (node.className) el.className = node.className
  if (node.id) el.id = node.id
  for (const [k, v] of Object.entries(node.attrs || {})) el.setAttribute(k, v)
  for (const child of (node.children || [])) el.appendChild(typeof child === 'string' ? new FakeEl('#text', child) : build(child))
  if (node.rect) el.setRect(node.rect)
  return el
}

export { FakeEl }
