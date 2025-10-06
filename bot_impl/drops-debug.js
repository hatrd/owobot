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

  function itemName (e) {
    try { return String(e?.item?.name || e?.displayName || e?.name || '').toLowerCase() } catch { return '' }
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
        .map(e => ({ id: e.id, name: itemName(e), kind: String(e?.kind||''), pos: e.position?.clone?.() || e.position, d: me.distanceTo(e.position) }))
        .filter(x => Number.isFinite(x.d) && x.d <= radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
      if (!items.length) { console.log(`[DROPS] none within r=${radius}`); return }
      console.log(`[DROPS] count=${items.length} within r=${radius}`)
      for (const it of items) {
        const p = it.pos || { x: '?', y: '?', z: '?' }
        console.log(`[DROPS] id=${it.id} name=${it.name||'?'} kind=${it.kind||'?'} at ${p.x?.toFixed? p.x.toFixed(1):p.x},${p.y?.toFixed? p.y.toFixed(1):p.y},${p.z?.toFixed? p.z.toFixed(1):p.z} d=${it.d.toFixed(2)}`)
      }
    } catch (e) { console.log('[DROPS] error:', e?.message || e) }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
