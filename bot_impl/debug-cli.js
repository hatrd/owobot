// CLI: rich debugging helpers

const observer = require('./agent/observer')
const actionsMod = require('./actions')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const P = (tag, ...a) => console.log(`[DBG] ${tag}`, ...a)

  function printEntities (radius = 20, max = 40) {
    try {
      const me = bot.entity?.position
      if (!me) { P('entities', 'not ready'); return }
      const list = []
      for (const e of Object.values(bot.entities || {})) {
        try {
          if (!e?.position) continue
          const d = e.position.distanceTo(me)
          if (!Number.isFinite(d) || d > radius) continue
          const name = String(e.name || (e.displayName && e.displayName.toString && e.displayName.toString()) || e.kind || e.type || 'entity').replace(/\u00a7./g, '')
          list.push({ id: e.id, type: e.type, name, d })
        } catch {}
      }
      list.sort((a, b) => a.d - b.d)
      const out = list.slice(0, max)
      P('entities', `count=${list.length} within r=${radius} (showing ${out.length})`)
      for (const it of out) P('entities', `id=${it.id} type=${it.type} name=${it.name} d=${it.d.toFixed(2)}`)
    } catch (e) { P('entities error:', e?.message || e) }
  }

  function printAnimals (radius = 20, species = null) {
    try {
      const r = observer.detail(bot, { what: species ? String(species) : 'animals', radius, max: 200 })
      const arr = r?.data || []
      P('animals', r?.msg || `animals ${arr.length}`)
      arr.forEach(a => P('animals', `${a.name || '?'} @ ${Number(a.d).toFixed(2)}m`))
    } catch (e) { P('animals error:', e?.message || e) }
  }

  function printPlayers (radius = 20) {
    try {
      const r = observer.detail(bot, { what: 'players', radius, max: 200 })
      const arr = r?.data || []
      P('players', r?.msg || `players ${arr.length}`)
      arr.forEach(p => P('players', `${p.name} @ ${Number(p.d).toFixed(2)}m`))
    } catch (e) { P('players error:', e?.message || e) }
  }

  function printHostiles (radius = 24) {
    try {
      const r = observer.detail(bot, { what: 'hostiles', radius, max: 200 })
      const arr = r?.data || []
      P('hostiles', r?.msg || `hostiles ${arr.length}`)
      arr.forEach(h => P('hostiles', `${h.name} @ ${Number(h.d).toFixed(2)}m`))
    } catch (e) { P('hostiles error:', e?.message || e) }
  }

  function printInv (full = false) {
    try {
      const inv = observer.detail(bot, { what: 'inventory' })?.data
      if (!inv) { P('inv', 'no data'); return }
      const top = full ? (inv.all || []) : (inv.top || [])
      P('inv', (top || []).map(it => `${it.name}${it.label ? `「${it.label}」` : ''}x${it.count}`).join(', ') || 'empty')
      P('hands', `held=${inv.held || '无'} offhand=${inv.offhand || '无'}`)
      const ar = inv.armor || {}
      P('armor', `head=${ar.head || '无'} chest=${ar.chest || '无'} legs=${ar.legs || '无'} feet=${ar.feet || '无'}`)
    } catch (e) { P('inv error:', e?.message || e) }
  }

  function printPos () {
    try {
      const s = observer.snapshot(bot, {})
      const p = s.pos
      P('pos', p ? `${p.x},${p.y},${p.z} dim=${s.dim}` : 'unknown')
    } catch (e) { P('pos error:', e?.message || e) }
  }

  function printGoal () {
    try {
      const g = bot.pathfinder && bot.pathfinder.goal
      if (!g) { P('goal', 'none'); return }
      const info = { name: g.constructor && g.constructor.name }
      // Best-effort extract
      ;['x','y','z','range','radius'].forEach(k => { try { if (g[k] != null) info[k] = g[k] } catch {} })
      P('goal', info)
    } catch (e) { P('goal error:', e?.message || e) }
  }

  function printTask () {
    try {
      const t = (bot.state && bot.state.currentTask) || null
      P('task', t ? t : 'none')
    } catch (e) { P('task error:', e?.message || e) }
  }

  function printTools () {
    try {
      const tools = actionsMod.install(bot, { log })
      P('tools', tools.list())
    } catch (e) { P('tools error:', e?.message || e) }
  }

  function printHawk () {
    try {
      const has = (n) => (bot.inventory?.items()||[]).some(it => String(it.name||'').toLowerCase() === n)
      const status = {
        loaded: !!bot.hawkEye,
        has_arrow: has('arrow'),
        has_bow: has('bow'),
        has_crossbow: has('crossbow'),
        held: bot.heldItem ? String(bot.heldItem.name) : null
      }
      P('hawk', status)
    } catch (e) { P('hawk error:', e?.message || e) }
  }

  function onCli (payload) {
    try {
      const cmd = String(payload?.cmd || '').toLowerCase()
      const args = payload?.args || []
      if (cmd === 'entities') { printEntities(parseInt(args[0]||'20',10), parseInt(args[1]||'40',10)); return }
      if (cmd === 'animals') { printAnimals(parseInt(args[0]||'20',10), null); return }
      if (cmd === 'cows') { printAnimals(parseInt(args[0]||'20',10), 'cow'); return }
      if (cmd === 'players') { printPlayers(parseInt(args[0]||'20',10)); return }
      if (cmd === 'hostiles') { printHostiles(parseInt(args[0]||'24',10)); return }
      if (cmd === 'inv') { printInv(String(args[0]||'').toLowerCase()==='full'); return }
      if (cmd === 'pos') { printPos(); return }
      if (cmd === 'goal') { printGoal(); return }
      if (cmd === 'task') { printTask(); return }
      if (cmd === 'tools') { printTools(); return }
      if (cmd === 'hawk') { printHawk(); return }
    } catch (e) { P('dbg error:', e?.message || e) }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
