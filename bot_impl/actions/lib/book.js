function isProbablyJson (s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  const first = t[0]
  const last = t[t.length - 1]
  if (first === '{' && last === '}') return true
  if (first === '[' && last === ']') return true
  return false
}

function flattenTextComponent (node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenTextComponent).join('')
  if (typeof node !== 'object') return String(node)
  const parts = []
  if (typeof node.text === 'string') parts.push(node.text)
  if (Array.isArray(node.extra)) parts.push(node.extra.map(flattenTextComponent).join(''))
  if (typeof node.translate === 'string' && parts.length === 0) parts.push(`[translate:${node.translate}]`)
  return parts.join('')
}

function toPlainText (maybeComponent) {
  if (maybeComponent == null) return ''
  if (typeof maybeComponent === 'string') {
    if (isProbablyJson(maybeComponent)) {
      try {
        const parsed = JSON.parse(maybeComponent)
        return flattenTextComponent(parsed)
      } catch {}
    }
    return maybeComponent
  }
  return flattenTextComponent(maybeComponent)
}

async function simplifyNbtAny (raw) {
  if (!raw) return null
  try {
    const nbt = require('prismarine-nbt')
    const simplify = nbt.simplify || ((v) => v)
    if (raw.type && raw.value) return simplify(raw)
    if (raw.parsed && raw.parsed.type && raw.parsed.value) return simplify(raw.parsed)
    if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      const parsed = await nbt.parse(raw)
      if (parsed && parsed.parsed) return simplify(parsed.parsed)
      if (parsed && parsed.type && parsed.value) return simplify(parsed)
      return null
    }
    // Already simplified?
    if (typeof raw === 'object') return raw
  } catch {}
  return null
}

function isBookItem (item) {
  const n = String(item?.name || '').toLowerCase()
  return n === 'writable_book' || n === 'written_book'
}

function formatPages (pages, opts = {}) {
  const maxPages = Math.max(1, parseInt(opts.maxPages ?? '6', 10) || 6)
  const maxCharsPerPage = Math.max(50, parseInt(opts.maxCharsPerPage ?? '600', 10) || 600)

  const from = Math.max(1, parseInt(opts.pageFrom ?? '1', 10) || 1)
  const toWanted = opts.pageTo == null ? (from + maxPages - 1) : (parseInt(opts.pageTo, 10) || from)
  const to = Math.max(from, toWanted)

  const total = pages.length
  const start = Math.min(Math.max(1, from), Math.max(1, total))
  const end = Math.min(Math.max(start, to), Math.max(1, total))

  const out = []
  for (let i = start; i <= end; i++) {
    const raw = pages[i - 1]
    const text = toPlainText(raw).replace(/\r\n/g, '\n').trim()
    const clipped = text.length > maxCharsPerPage ? (text.slice(0, maxCharsPerPage - 1) + '…') : text
    out.push({ page: i, text: clipped })
  }
  return { total, start, end, shown: out }
}

async function extractBookInfo (item, opts = {}) {
  if (!item) return { ok: false, msg: '没有找到书' }
  if (!isBookItem(item)) return { ok: false, msg: `这不是书（${item.name || 'unknown'}）` }

  const nbtRaw = item.nbt
  const tag = await simplifyNbtAny(nbtRaw)
  const pagesRaw = Array.isArray(tag?.pages) ? tag.pages : []
  const pageInfo = formatPages(pagesRaw, opts)

  const displayName = String(item.displayName || '').trim()
  const title = toPlainText(tag?.title || tag?.display?.Name || '').trim() || displayName || item.name
  const author = toPlainText(tag?.author || '').trim()

  const headerParts = [`书: ${title}`]
  if (author) headerParts.push(`作者: ${author}`)
  headerParts.push(`类型: ${item.name}`)
  if (pageInfo.total) headerParts.push(`页数: ${pageInfo.total}`)

  if (!pageInfo.total) {
    return { ok: true, msg: headerParts.join(' | ') + ' | （没有内容）', data: { title, author, type: item.name, pages: [], totalPages: 0 } }
  }

  const body = pageInfo.shown
    .map(p => `【第${p.page}页】\n${p.text || '（空）'}`)
    .join('\n\n')

  const suffix = (() => {
    if (pageInfo.end < pageInfo.total) return `\n\n（只展示第${pageInfo.start}-${pageInfo.end}页，共${pageInfo.total}页；可用 pageFrom/pageTo 翻页）`
    return ''
  })()

  return {
    ok: true,
    msg: headerParts.join(' | ') + '\n' + body + suffix,
    data: {
      title,
      author,
      type: item.name,
      totalPages: pageInfo.total,
      shownFrom: pageInfo.start,
      shownTo: pageInfo.end,
      pages: pageInfo.shown.map(p => ({ page: p.page, text: p.text }))
    }
  }
}

module.exports = {
  extractBookInfo,
  isBookItem,
  toPlainText
}

