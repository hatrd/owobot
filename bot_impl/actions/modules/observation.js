module.exports = function registerObservation (ctx) {
  const { bot, register, ok, fail, log } = ctx
  const observer = ctx.observer

  async function observe_detail (args = {}) {
    try {
      const r = await Promise.resolve(observer.detail(bot, args || {}))
      return { ok: Boolean(r && r.ok), msg: (r && r.msg) || '无', data: r && r.data }
    } catch (e) {
      try { log?.warn && log.warn('observe_detail error', e?.message || e) } catch {}
      return fail('观察失败，请稍后再试~')
    }
  }

  async function observe_players (args = {}) {
    const me = bot.entity?.position
    if (!me) return fail('未就绪')
    const radius = Math.max(1, parseInt(args.radius || '32', 10))
    const maxOut = Math.max(1, parseInt(args.max || '20', 10))
    const names = Array.isArray(args.names) ? args.names.filter(Boolean).map(s => String(s).toLowerCase()) : null
    const single = args.name ? String(args.name).toLowerCase() : null
    const wanted = (() => {
      if (names && names.length) return new Set(names)
      if (single) return new Set([single])
      return null
    })()

    try {
      const rows = []
      const dim = String(bot.game?.dimension || 'unknown')
      for (const [name, rec] of Object.entries(bot.players || {})) {
        try {
          const entity = rec?.entity
          if (!entity || entity === bot.entity || !entity.position) continue
          const d = entity.position.distanceTo(me)
          if (!Number.isFinite(d) || d > radius) continue
          const nLower = String(name || '').toLowerCase()
          if (wanted && !wanted.has(nLower)) continue
          rows.push({
            name,
            dim,
            x: Number(entity.position.x || 0),
            y: Number(entity.position.y || 0),
            z: Number(entity.position.z || 0),
            d: Number(d.toFixed(2))
          })
        } catch {}
      }

      rows.sort((a, b) => a.d - b.d)
      if (!rows.length) {
        if (wanted && wanted.size) return fail('未找到指定玩家（附近范围内）')
        return ok(`附近玩家0个(半径${radius})`, { data: [] })
      }

      const out = rows.slice(0, maxOut)
      const parts = out.map(r => `${r.name}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)} ${r.d.toFixed(1)}m`)
      return ok(`附近玩家${rows.length}个(半径${radius}): ${parts.join('; ')}`, { data: out })
    } catch (e) {
      try { log?.warn && log.warn('observe_players error', e?.message || e) } catch {}
      return fail('查询失败，请稍后再试~')
    }
  }

  register('observe_detail', observe_detail)
  register('observe_players', observe_players)
}
