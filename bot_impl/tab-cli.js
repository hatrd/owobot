// CLI: .tab
// Prints current tablist-style player list with ping to the internal console.

function install (bot, { on, registerCleanup, log }) {
  const print = (...a) => console.log('[TAB]', ...a)

  function cleanName (rec, fallback) {
    try {
      const raw = rec?.displayName
      const s = raw && typeof raw.toString === 'function' ? raw.toString() : (raw != null ? String(raw) : fallback)
      return String(s || fallback || '').replace(/\u00a7./g, '') || fallback || 'unknown'
    } catch {
      return fallback || 'unknown'
    }
  }

  function stripPingSuffix (s) {
    try {
      return String(s || '').replace(/\s*[\[(]?\s*\d+\s*ms\s*[\])]?$/i, '').trim()
    } catch { return s }
  }

  function formatPing (v) {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return '?'
    return `${Math.round(n)}ms`
  }

  function onCli (payload) {
    try {
      if (!payload || String(payload.cmd || '').toLowerCase() !== 'tab') return
      const entries = Object.entries(bot.players || {}).filter(([, rec]) => rec?.listed !== false)
      if (!entries.length) {
        print('无玩家')
        return
      }
      entries.sort(([a], [b]) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' }))
      const rows = entries.map(([name, rec]) => {
        const baseName = String(rec?.username || name || 'unknown')
        let label = cleanName(rec, baseName)
        label = stripPingSuffix(label)
        if (!label) label = baseName
        const ping = formatPing(rec?.ping)
        return `${label}(${ping})`
      })
      print(`${rows.length} 玩家`, rows.join(', '))
    } catch (e) {
      try { (log?.warn || console.log)('[TAB] error:', e?.message || e) } catch {}
    }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
