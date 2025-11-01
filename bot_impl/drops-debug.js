// Debug helper: list nearby dropped items via CLI

function install (bot, { on, dlog, state, registerCleanup, log }) {
  function isItemEntity (e) {
    try {
      if (!e || !e.position) return false
      const kind = String(e?.kind || '').toLowerCase()
      if (kind === 'drops') return true
      const nm = String(e.name || e.displayName || '').toLowerCase()
      if (nm === 'item' || nm === 'item_entity' || nm === 'dropped_item') return true
      if (e.item) return true
      return false
    } catch { return false }
  }

  function formatItem (item) {
    if (!item) return null
    try {
      const parts = []
      if (item.name || item.displayName) parts.push(String(item.name || item.displayName).toLowerCase())
      if (typeof item.count === 'number') parts.push(`x${item.count}`)
      if (typeof item.type === 'number') parts.push(`type=${item.type}`)
      if (typeof item.metadata === 'number') parts.push(`meta=${item.metadata}`)
      if (item.nbt) parts.push('nbt')
      return parts.join(' ')
    } catch { return 'unreadable' }
  }

  function formatVec (vec) {
    if (!vec) return '?, ?, ?'
    try {
      const x = Number.isFinite(vec.x) ? vec.x.toFixed(1) : '?'
      const y = Number.isFinite(vec.y) ? vec.y.toFixed(1) : '?'
      const z = Number.isFinite(vec.z) ? vec.z.toFixed(1) : '?'
      return `${x},${y},${z}`
    } catch { return '?, ?, ?' }
  }

  function describeValue (value, depth = 0) {
    if (value == null) return 'null'
    if (typeof value === 'string') return `str(${value.slice(0, 24)})`
    if (typeof value === 'number') return `num(${value})`
    if (typeof value === 'boolean') return `bool(${value})`
    if (Array.isArray(value)) return `array(${value.length})`
    if (typeof value === 'object') {
      if (depth > 2) return 'obj'
      const keys = Object.keys(value)
      if (!keys.length) return 'obj(empty)'
      const preview = keys.slice(0, 4).map(k => {
        const v = value[k]
        if (v == null) return `${k}:null`
        if (typeof v === 'object') return `${k}:obj`
        if (typeof v === 'string') return `${k}:str(${v.slice(0, 12)})`
        if (typeof v === 'number') return `${k}:num(${v})`
        if (typeof v === 'boolean') return `${k}:bool(${v})`
        return `${k}:${typeof v}`
      }).join('|')
      return `obj{${preview}${keys.length > 4 ? '|…' : ''}}`
    }
    return typeof value
  }

  function summarizeMetadata (meta) {
    if (!meta) return ''
    try {
      const entries = []
      if (Array.isArray(meta)) {
        for (let i = 0; i < meta.length; i++) {
          const val = meta[i]
          if (val == null) continue
          entries.push(`${i}:${describeValue(val)}`)
          if (entries.length >= 6) break
        }
      } else if (typeof meta === 'object') {
        const keys = Object.keys(meta)
        for (const key of keys.slice(0, 6)) entries.push(`${key}:${describeValue(meta[key])}`)
      }
      return entries.join(', ')
    } catch { return 'meta:unreadable' }
  }

  function onCli (payload) {
    try {
      if (!payload || payload.cmd !== 'drops') return
      const args = payload.args || []
      const radius = Math.max(1, parseInt(args[0] || '24', 10))
      const max = Math.max(1, parseInt(args[1] || '50', 10))
      const me = bot.entity?.position
      if (!me) { console.log('[DROPS] not ready'); return }
      const items = Object.values(bot.entities || {})
        .filter(e => isItemEntity(e))
        .map(e => {
          const drop = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null
          return {
            id: e.id,
            entityName: e.name || null,
            displayName: e.displayName || null,
            kind: String(e?.kind || ''),
            drop,
            entityItem: e.item || null,
            metadata: e.metadata,
            position: e.position?.clone?.() || e.position,
            velocity: e.velocity?.clone?.() || e.velocity,
            age: e.age || e.ticksLived || null,
            d: me.distanceTo(e.position)
          }
        })
        .filter(x => Number.isFinite(x.d) && x.d <= radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
      if (!items.length) { console.log(`[DROPS] none within r=${radius}`); return }
      console.log(`[DROPS] count=${items.length} within r=${radius}`)
      items.forEach((it, idx) => {
        const pos = formatVec(it.position)
        const vel = formatVec(it.velocity)
        const dropInfo = formatItem(it.drop)
        const entityItemInfo = formatItem(it.entityItem)
        const metaInfo = summarizeMetadata(it.metadata)
        const ageInfo = typeof it.age === 'number' ? ` age=${it.age}` : ''
        console.log(`[DROPS] #${idx + 1} id=${it.id} d=${it.d.toFixed(2)} pos=${pos}${ageInfo}`)
        console.log(`        entity=${String(it.entityName || '?')} display=${String(it.displayName || '?')} kind=${String(it.kind || '?')}`)
        console.log(`        drop=${dropInfo || 'none'} item=${entityItemInfo || 'none'} vel=${vel}`)
        if (metaInfo) console.log(`        metadata=${metaInfo}`)
      })
    } catch (e) { console.log('[DROPS] error:', e?.message || e) }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
