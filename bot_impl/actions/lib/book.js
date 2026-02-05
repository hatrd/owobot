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

function isPlainObject (v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function looksLikeTypedNbt (v) {
  return isPlainObject(v) && typeof v.type === 'string' && 'value' in v
}

function normalizeComponentsObject (v) {
  if (!v) return null
  if (isPlainObject(v)) return v
  try {
    if (v instanceof Map) {
      const out = {}
      for (const [k, val] of v.entries()) out[String(k)] = val
      return out
    }
  } catch {}
  return null
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
  try {
    if (looksLikeTypedNbt(maybeComponent)) {
      const nbt = require('prismarine-nbt')
      const simplify = nbt.simplify || ((v) => v)
      const simplified = simplify(maybeComponent)
      return flattenTextComponent(simplified)
    }
  } catch {}
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

function simplifyNbtBestEffortSync (raw) {
  if (!raw) return null
  try {
    const nbt = require('prismarine-nbt')
    const simplify = nbt.simplify || ((v) => v)
    if (raw.type && raw.value) return simplify(raw)
    if (raw.parsed && raw.parsed.type && raw.parsed.value) return simplify(raw.parsed)
    if (typeof raw === 'object') return raw
  } catch {}
  return null
}

function isBookItem (item) {
  const n = String(item?.name || '').toLowerCase()
  return n === 'writable_book' || n === 'written_book'
}

function extractComponentsLike (tag) {
  if (!isPlainObject(tag)) return null
  const direct = tag.components
  if (isPlainObject(direct)) return direct
  const alt = tag.Components
  if (isPlainObject(alt)) return alt
  const inner = tag.tag
  if (isPlainObject(inner)) return extractComponentsLike(inner)
  return null
}

function unwrapTypedRoot (raw) {
  if (!raw) return null
  if (raw.parsed) return raw.parsed
  return raw
}

function readTypedNode (raw, path) {
  try {
    let node = unwrapTypedRoot(raw)
    const keys = Array.isArray(path) ? path : [path]
    for (const key of keys) {
      if (!node || node.type !== 'compound') return null
      node = node.value?.[key]
    }
    return node || null
  } catch {
    return null
  }
}

function readTypedString (raw, path) {
  const node = readTypedNode(raw, path)
  if (!node) return null
  if (node.type === 'string') return String(node.value || '')
  if (node.value != null && typeof node.value !== 'object') return String(node.value)
  return null
}

function readTypedListStrings (raw, path) {
  const node = readTypedNode(raw, path)
  if (!node || node.type !== 'list') return null
  const inner = node.value
  const arr = inner && Array.isArray(inner.value) ? inner.value : null
  if (!arr) return null
  return arr.map(v => (v == null ? '' : String(v)))
}

function simplifyTypedNode (node) {
  if (!node) return null
  try {
    const nbt = require('prismarine-nbt')
    const simplify = nbt.simplify || ((v) => v)
    if (node.type && node.value != null) return simplify(node)
  } catch {}
  return null
}

let SLOT_COMPONENT_TYPE_NAMES = null
function loadSlotComponentTypeNames () {
  if (Array.isArray(SLOT_COMPONENT_TYPE_NAMES)) return SLOT_COMPONENT_TYPE_NAMES
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const base = path.dirname(require.resolve('minecraft-data'))
    const protoPath = path.join(base, 'minecraft-data', 'data', 'pc', 'latest', 'proto.yml')
    const src = fs.readFileSync(protoPath, 'utf8')
    const lines = src.split(/\r?\n/)
    const names = []
    let inBlock = false
    for (const line of lines) {
      if (!inBlock) {
        if (/^\s*SlotComponentType:\s*varint\s*=>\s*$/.test(line)) inBlock = true
        continue
      }
      const m = line.match(/^\s*-\s*([^\s#]+)\s*$/)
      if (m) { names.push(m[1]); continue }
      if (/^\S/.test(line)) break
      if (!line.trim()) continue
      if (!/^\s+/.test(line)) break
    }
    SLOT_COMPONENT_TYPE_NAMES = names
    return names
  } catch {
    SLOT_COMPONENT_TYPE_NAMES = []
    return SLOT_COMPONENT_TYPE_NAMES
  }
}

function normalizeComponentTypeName (type) {
  if (type == null) return null
  if (typeof type === 'string') return type.toLowerCase()
  if (typeof type === 'number' && Number.isFinite(type)) {
    const names = loadSlotComponentTypeNames()
    const name = names[type]
    return typeof name === 'string' ? name.toLowerCase() : null
  }
  return String(type).toLowerCase()
}

function extractComponentsFromItem (item) {
  try {
    const out = {}
    if (!item) return null
    const put = (k, v) => { if (k) out[k] = v }
    const payloadFromComponent = (comp) => {
      if (!comp || typeof comp !== 'object') return undefined
      if ('data' in comp && comp.data != null) return comp.data
      // protodef switch often flattens fields onto the component object itself.
      const cloned = { ...comp }
      delete cloned.type
      // Some decoders may use `_` for anon fields; merge it if present.
      if (cloned._ && typeof cloned._ === 'object' && !Array.isArray(cloned._)) {
        const merged = { ...cloned._, ...cloned }
        delete merged._
        return merged
      }
      delete cloned._
      return cloned
    }
    // prismarine-item (1.20.5+) stores components as an array plus a componentMap.
    if (item.componentMap && typeof item.componentMap.get === 'function') {
      for (const [rawType, comp] of item.componentMap.entries()) {
        const name = normalizeComponentTypeName(rawType)
        if (!name) continue
        put(name, payloadFromComponent(comp))
      }
      return Object.keys(out).length ? out : null
    }
    if (Array.isArray(item.components)) {
      for (const comp of item.components) {
        if (!comp || typeof comp !== 'object') continue
        const name = normalizeComponentTypeName(comp.type)
        if (!name) continue
        put(name, payloadFromComponent(comp))
      }
      return Object.keys(out).length ? out : null
    }
    // Legacy / custom shapes
    const obj = normalizeComponentsObject(item.components)
    if (obj) return obj
  } catch {}
  return null
}

function pickFirstField (obj, keys) {
  if (!isPlainObject(obj)) return undefined
  for (const k of keys) {
    if (k in obj) return obj[k]
  }
  return undefined
}

function extractCustomName (item) {
  try {
    if (!item) return null
    const components = extractComponentsFromItem(item)
    const rawFromComponents = pickFirstField(components, ['custom_name', 'minecraft:custom_name', 'customname', 'customName'])
    const compName = toPlainText(rawFromComponents).trim()
    if (compName) return compName

    const raw = item?.nbt
    const tag = simplifyNbtBestEffortSync(raw)
    const tagInner = isPlainObject(tag?.tag) ? tag.tag : null
    const nbtNameRaw = tag?.display?.Name ?? tagInner?.display?.Name
    const typedName = readTypedString(raw, ['display', 'Name']) || readTypedString(raw, ['tag', 'display', 'Name'])
    const legacyName = toPlainText(nbtNameRaw ?? typedName).trim()
    return legacyName || null
  } catch {
    return null
  }
}

function extractBookTitle (item) {
  try {
    if (!item || !isBookItem(item)) return null
    const base = String(item?.name || '').toLowerCase()
    const components = extractComponentsFromItem(item)
    if (base === 'written_book') {
      const content = pickFirstField(components, ['written_book_content', 'minecraft:written_book_content'])
      if (content && typeof content === 'object') {
        const t = toPlainText(content.rawTitle ?? content.filteredTitle ?? content.title).trim()
        if (t) return t
      }
    }
    const raw = item?.nbt
    const tag = simplifyNbtBestEffortSync(raw)
    const tagInner = isPlainObject(tag?.tag) ? tag.tag : null
    const titleRaw = tag?.title ?? tagInner?.title
    const titleTyped = readTypedString(raw, ['title']) || readTypedString(raw, ['tag', 'title'])
    const legacyTitle = toPlainText(titleRaw ?? titleTyped).trim()
    return legacyTitle || null
  } catch {
    return null
  }
}

function extractItemLabel (item, opts = {}) {
  try {
    if (!item) return null
    const fallbackBookDisplayName = opts.fallbackBookDisplayName !== false
    const customName = extractCustomName(item)
    if (isBookItem(item)) {
      const title = extractBookTitle(item)
      const label = title || customName || (fallbackBookDisplayName ? String(item.displayName || '').trim() : '')
      return label && label.trim() ? label.trim() : null
    }
    return customName || null
  } catch {
    return null
  }
}

function normalizeBookPageEntries (pages) {
  if (!Array.isArray(pages)) return []
  return pages.map((p) => {
    if (p == null) return ''
    if (typeof p === 'string') return p
    if (isPlainObject(p)) {
      // Newer data-components may store pages as {raw, filtered} or similar.
      if (typeof p.raw === 'string') return p.raw
      if (typeof p.filtered === 'string') return p.filtered
      if (typeof p.content === 'string') return p.content
      if (typeof p.filteredContent === 'string') return p.filteredContent
      if (p.content != null) return p.content
      if (p.filteredContent != null) return p.filteredContent
      // Sometimes page itself can be a text component object.
      return p
    }
    return String(p)
  })
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

async function extractBookMeta (item, opts = {}) {
  if (!item) return { ok: false, msg: '没有找到书', data: null }
  if (!isBookItem(item)) return { ok: false, msg: `这不是书（${item.name || 'unknown'}）`, data: null }

  const tag = await simplifyNbtAny(item.nbt)
  return extractBookMetaFromSimplified(item, tag, opts)
}

function extractBookMetaFromSimplified (item, tag, opts = {}) {
  const tagInner = isPlainObject(tag?.tag) ? tag.tag : null
  const itemComponents = extractComponentsFromItem(item)
  const typedComponents = (() => {
    const fromRaw = item?.nbt
    const node = readTypedNode(fromRaw, ['components']) || readTypedNode(fromRaw, ['tag', 'components'])
    return simplifyTypedNode(node)
  })()
  const components = itemComponents || typedComponents || extractComponentsLike(tag) || extractComponentsLike(tagInner)

  const writtenContent = pickFirstField(components, ['written_book_content', 'minecraft:written_book_content', 'writtenBookContent', 'writtenbookcontent'])
  const writableContent = pickFirstField(components, ['writable_book_content', 'minecraft:writable_book_content', 'writableBookContent', 'writablebookcontent'])
  const componentContent = isPlainObject(writtenContent) ? writtenContent : (isPlainObject(writableContent) ? writableContent : null)

  const legacyTitleRaw = pickFirstField(isPlainObject(tag) ? tag : null, ['title']) ?? pickFirstField(tagInner, ['title'])
  const legacyAuthorRaw = pickFirstField(isPlainObject(tag) ? tag : null, ['author']) ?? pickFirstField(tagInner, ['author'])
  const legacyPagesRaw = pickFirstField(isPlainObject(tag) ? tag : null, ['pages']) ?? pickFirstField(tagInner, ['pages'])
  const legacyTitleTyped = readTypedString(item?.nbt, ['title']) || readTypedString(item?.nbt, ['tag', 'title'])
  const legacyAuthorTyped = readTypedString(item?.nbt, ['author']) || readTypedString(item?.nbt, ['tag', 'author'])
  const legacyPagesTyped = readTypedListStrings(item?.nbt, ['pages']) || readTypedListStrings(item?.nbt, ['tag', 'pages'])

  const componentTitleRaw = pickFirstField(componentContent, ['title', 'rawTitle', 'filteredTitle'])
  const componentAuthorRaw = pickFirstField(componentContent, ['author'])
  const componentPagesRaw = pickFirstField(componentContent, ['pages'])

  const displayName = String(item.displayName || '').trim()

  const customNameRaw = pickFirstField(components, ['minecraft:custom_name', 'custom_name', 'customname']) ??
    pickFirstField(isPlainObject(tag) ? tag : null, ['display'])?.Name ??
    pickFirstField(tagInner, ['display'])?.Name
  const customNameTyped = readTypedString(item?.nbt, ['display', 'Name']) || readTypedString(item?.nbt, ['tag', 'display', 'Name'])
  const customName = toPlainText(customNameRaw ?? customNameTyped).trim() || displayName || ''

  const contentTitle = toPlainText(componentTitleRaw).trim()
  const legacyTitle = toPlainText(legacyTitleRaw ?? legacyTitleTyped).trim()
  const bestTitle = (contentTitle || legacyTitle || toPlainText(customNameTyped).trim() || customName || displayName || item.name).trim()

  const author = toPlainText(componentAuthorRaw).trim() || toPlainText(legacyAuthorRaw ?? legacyAuthorTyped).trim()

  const rawPages = (() => {
    if (Array.isArray(componentPagesRaw)) return normalizeBookPageEntries(componentPagesRaw)
    if (Array.isArray(legacyPagesRaw)) return normalizeBookPageEntries(legacyPagesRaw)
    if (Array.isArray(legacyPagesTyped)) return normalizeBookPageEntries(legacyPagesTyped)
    return []
  })()

  const totalPages = rawPages.length
  const probePages = Math.max(0, Math.min(totalPages, parseInt(opts.probePages ?? '3', 10) || 3))
  let hasContent = false
  for (let i = 0; i < probePages; i++) {
    const t = toPlainText(rawPages[i]).replace(/\r\n/g, '\n').trim()
    if (t) { hasContent = true; break }
  }

  const slot = (typeof item.slot === 'number' && Number.isFinite(item.slot)) ? item.slot : null

  return {
    ok: true,
    msg: 'ok',
    data: {
      title: bestTitle,
      contentTitle: contentTitle || null,
      legacyTitle: legacyTitle || null,
      customName: customName || null,
      author: author || null,
      type: item.name,
      slot,
      totalPages,
      hasContent
    }
  }
}

async function extractBookInfo (item, opts = {}) {
  if (!item) return { ok: false, msg: '没有找到书' }
  if (!isBookItem(item)) return { ok: false, msg: `这不是书（${item.name || 'unknown'}）` }

  const tag = await simplifyNbtAny(item.nbt)
  const meta = extractBookMetaFromSimplified(item, tag, { probePages: opts.probePages })
  const data = meta.ok ? meta.data : null

  const tagInner = isPlainObject(tag?.tag) ? tag.tag : null
  const itemComponents = extractComponentsFromItem(item)
  const typedComponents = (() => {
    const node = readTypedNode(item?.nbt, ['components']) || readTypedNode(item?.nbt, ['tag', 'components'])
    return simplifyTypedNode(node)
  })()
  const components = itemComponents || typedComponents || extractComponentsLike(tag) || extractComponentsLike(tagInner)
  const writtenContent = pickFirstField(components, ['minecraft:written_book_content', 'written_book_content', 'writtenbookcontent']) ?? pickFirstField(components, ['written_book_content'])
  const writableContent = pickFirstField(components, ['minecraft:writable_book_content', 'writable_book_content', 'writablebookcontent']) ?? pickFirstField(components, ['writable_book_content'])
  const componentContent = isPlainObject(writtenContent) ? writtenContent : (isPlainObject(writableContent) ? writableContent : null)
  const pagesRawFromComponents = pickFirstField(componentContent, ['pages'])
  const legacyPagesRaw = pickFirstField(isPlainObject(tag) ? tag : null, ['pages']) ?? pickFirstField(tagInner, ['pages'])
  const legacyPagesTyped = readTypedListStrings(item?.nbt, ['pages']) || readTypedListStrings(item?.nbt, ['tag', 'pages'])
  const pagesRaw = Array.isArray(pagesRawFromComponents)
    ? normalizeBookPageEntries(pagesRawFromComponents)
    : (Array.isArray(legacyPagesRaw)
        ? normalizeBookPageEntries(legacyPagesRaw)
        : (Array.isArray(legacyPagesTyped) ? normalizeBookPageEntries(legacyPagesTyped) : []))

  const pageInfo = formatPages(pagesRaw, opts)

  const displayName = String(item.displayName || '').trim()
  const title = String(data?.title || '').trim() || displayName || item.name
  const author = String(data?.author || '').trim()
  const contentTitle = String(data?.contentTitle || '').trim()
  const customName = String(data?.customName || '').trim()

  const headerParts = [`书: ${title}`]
  if (contentTitle && contentTitle !== title) headerParts.push(`书名: ${contentTitle}`)
  if (customName && customName !== title && customName !== contentTitle) headerParts.push(`显示名: ${customName}`)
  if (author) headerParts.push(`作者: ${author}`)
  headerParts.push(`类型: ${item.name}`)
  if (data?.slot != null) headerParts.push(`槽位: ${data.slot}`)
  if (pageInfo.total) headerParts.push(`页数: ${pageInfo.total}`)

  if (!pageInfo.total) {
    return {
      ok: true,
      msg: headerParts.join(' | ') + ' | （没有内容）',
      data: {
        title,
        contentTitle: contentTitle || null,
        customName: customName || null,
        author,
        type: item.name,
        slot: data?.slot ?? null,
        totalPages: 0,
        hasContent: false,
        pages: []
      }
    }
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
      contentTitle: contentTitle || null,
      customName: customName || null,
      author,
      type: item.name,
      slot: data?.slot ?? null,
      totalPages: pageInfo.total,
      shownFrom: pageInfo.start,
      shownTo: pageInfo.end,
      hasContent: Boolean(data?.hasContent),
      pages: pageInfo.shown.map(p => ({ page: p.page, text: p.text }))
    }
  }
}

module.exports = {
  extractBookInfo,
  extractBookMeta,
  extractBookTitle,
  extractCustomName,
  extractItemLabel,
  isBookItem,
  toPlainText
}
