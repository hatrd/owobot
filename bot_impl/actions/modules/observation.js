module.exports = function registerObservation (ctx) {
  const { bot, register, ok, fail, log } = ctx
  const observer = ctx.observer

  async function observe_detail (args = {}) {
    try {
      const r = observer.detail(bot, args || {})
      return { ok: Boolean(r && r.ok), msg: (r && r.msg) || '无', data: r && r.data }
    } catch (e) {
      try { log?.warn && log.warn('observe_detail error', e?.message || e) } catch {}
      return fail('观察失败，请稍后再试~')
    }
  }

  async function observe_players (args = {}) {
    const url = String(process.env.MAP_API_URL || '').trim()
    if (!url) return fail('MAP_API_URL 未配置')
    const names = Array.isArray(args.names) ? args.names.filter(Boolean).map(s => String(s)) : null
    const single = args.name ? String(args.name) : null
    const filterWorldRaw = String(args.world || args.dim || '').trim()
    const maxOut = Math.max(1, parseInt(args.max || '20', 10))
    const toDim = (w) => {
      const s = String(w || '')
      if (s === 'world_nether' || /nether/i.test(s)) return '下界'
      if (s === 'world_the_end' || /end$/i.test(s)) return '末地'
      if (s === 'world' || /overworld|^world$/i.test(s)) return '主世界'
      return s || '未知'
    }
    const worldKey = (() => {
      if (!filterWorldRaw) return null
      const v = filterWorldRaw.toLowerCase()
      if (/nether|下界/.test(v)) return 'world_nether'
      if (/the_end|end|末地/.test(v)) return 'world_the_end'
      if (/overworld|主世界|^world$/.test(v)) return 'world'
      return filterWorldRaw
    })()
    const wantNames = (() => {
      if (names && names.length) return names
      if (single) return [single]
      return null
    })()

    function num (v) { const n = Number(v); return Number.isFinite(n) ? n : null }
    function parseThresh (pfx) {
      const eq = num(args[pfx + '_eq'] ?? args[pfx + 'Eq'])
      const lt = num(args[pfx + '_lt'] ?? args[pfx + 'Lt'])
      const lte = num(args[pfx + '_lte'] ?? args[pfx + 'Lte'])
      const gt = num(args[pfx + '_gt'] ?? args[pfx + 'Gt'])
      const gte = num(args[pfx + '_gte'] ?? args[pfx + 'Gte'])
      const min = num(args[pfx + 'Min'])
      const max = num(args[pfx + 'Max'])
      return { eq, lt: lt ?? (max != null ? max - Number.EPSILON : null), lte: lte ?? max, gt: gt ?? (min != null ? min + Number.EPSILON : null), gte: gte ?? min }
    }
    const armorT = parseThresh('armor')
    const healthT = parseThresh('health')
    const hasThresh = (t) => (t && (t.eq != null || t.lt != null || t.lte != null || t.gt != null || t.gte != null))
    function passNum (val, t) {
      if (t.eq != null && val !== t.eq) return false
      if (t.lte != null && !(val <= t.lte)) return false
      if (t.lt != null && !(val < t.lt)) return false
      if (t.gte != null && !(val >= t.gte)) return false
      if (t.gt != null && !(val > t.gt)) return false
      return true
    }

    function parseWorldFromUrl (u) {
      try {
        const m = String(u || '').match(/\/maps\/([^/]+)\/live\/players\.json/i)
        if (m && m[1]) return m[1]
      } catch {}
      return 'world'
    }

    function normalizePlayers (data, u) {
      const worldFromUrl = parseWorldFromUrl(u)
      const list = Array.isArray(data?.players) ? data.players : []
      return list.map(p => {
        const pos = p?.position
        const hasPosObject = pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number'
        const hasFlatXYZ = typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number'
        const x = hasFlatXYZ ? Number(p.x) : (hasPosObject ? Number(pos.x) : 0)
        const y = hasFlatXYZ ? Number(p.y) : (hasPosObject ? Number(pos.y) : 0)
        const z = hasFlatXYZ ? Number(p.z) : (hasPosObject ? Number(pos.z) : 0)
        const world = String(p?.world || worldFromUrl || 'world')
        const health = (p?.health == null ? null : Number(p.health))
        const armor = (p?.armor == null ? null : Number(p.armor))
        return { name: String(p?.name || ''), world, x, y, z, health, armor }
      })
    }

    function baseRoot (u) {
      try {
        const o = new URL(u)
        const path = o.pathname || '/'
        const prefix = path.replace(/\/maps\/.+\/live\/players\.json$/i, '').replace(/\/$/, '')
        return `${o.protocol}//${o.host}${prefix}` || null
      } catch { return null }
    }
    function parseMapId (u) {
      try {
        const m = String(u || '').match(/\/maps\/([^/]+)\/live\/players\.json/i)
        if (m && m[1]) return m[1]
      } catch {}
      return null
    }

    function isBlueMapShape (data) {
      return data && typeof data === 'object' && data.players && Array.isArray(data.players)
    }

    async function blueMapCollectAll (root, currentMapId, seedData) {
      const all = []
      const rootUrl = baseRoot(root)
      if (!rootUrl) return seedData ? normalizePlayers(seedData, root) : all
      let settings
      try {
        const res = await fetch(`${rootUrl}/settings.json`, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) throw new Error(`settings ${res.status}`)
        settings = await res.json()
      } catch (err) {
        log?.warn && log.warn('BlueMap settings error', err?.message || err)
        return seedData ? normalizePlayers(seedData, root) : all
      }
      const liveRoot = settings?.liveDataRoot || 'maps'
      const maps = settings?.maps && typeof settings.maps === 'object' ? settings.maps : {}
      const tasks = []
      for (const [key, info] of Object.entries(maps)) {
        const livePath = `${rootUrl}/${liveRoot}/${key}/live/players.json`
        const request = fetch(livePath, { signal: AbortSignal.timeout(5000) })
          .then(r => r.json().catch(() => null))
          .then(data => ({ key, data, info }))
          .catch(() => ({ key, data: null, info }))
        tasks.push(request)
      }
      if (seedData && currentMapId && !maps[currentMapId]) {
        tasks.push(Promise.resolve({ key: currentMapId, data: seedData, info: { live: { foreign: false } } }))
      }
      const results = await Promise.all(tasks)
      for (const { key, data, info } of results) {
        if (!data || !isBlueMapShape(data)) continue
        const players = normalizePlayers(data, `${rootUrl}/${liveRoot}/${key}/live/players.json`)
        for (const p of players) {
          const mapInfo = info?.live || {}
          if (mapInfo.foreign === false && String(p.world || '').toLowerCase() === 'world') {
            p.world = key
          }
          all.push(p)
        }
      }
      return all
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => { try { controller.abort() } catch {} }, 6000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) return fail(`请求失败 ${res.status}`)
      const data = await res.json().catch(() => null)
      if (!data) return fail('响应无法解析')
      let rows
      if (Array.isArray(data.players)) {
        rows = normalizePlayers(data, url)
      } else if (isBlueMapShape(data)) {
        rows = normalizePlayers(data, url)
      } else if (Array.isArray(data)) {
        rows = data.map(p => ({ name: String(p?.name || ''), world: String(p?.world || 'world'), x: Number(p?.x || 0), y: Number(p?.y || 0), z: Number(p?.z || 0), health: p?.health == null ? null : Number(p.health), armor: p?.armor == null ? null : Number(p.armor) }))
      } else {
        return fail('API 格式不支持')
      }

      if (!rows.length && data.players && isBlueMapShape(data)) {
        rows = await blueMapCollectAll(url, parseMapId(url), data)
      }

      if (worldKey) rows = rows.filter(p => String(p?.world || '') === worldKey)
      if (wantNames) {
        const set = new Set(wantNames.map(n => String(n).toLowerCase()))
        rows = rows.filter(p => set.has(String(p?.name || '').toLowerCase()))
      }

      rows = rows.filter(p => {
        const a = (p?.armor == null ? null : Number(p.armor))
        const h = (p?.health == null ? null : Number(p.health))
        if (hasThresh(armorT) && a == null) return false
        if (hasThresh(healthT) && h == null) return false
        return passNum(a ?? 0, armorT) && passNum(h ?? 0, healthT)
      })

      if (!rows.length) {
        if (wantNames && wantNames.length) return fail('未找到指定玩家')
        const dimCN = worldKey ? toDim(worldKey) : '全部'
        return ok(`${dimCN}: 无`, { data: [] })
      }

      const mapped = rows.map(p => ({
        name: p.name,
        world: p.world,
        dim: toDim(p.world),
        x: Number(p.x || 0), y: Number(p.y || 0), z: Number(p.z || 0),
        health: (p.health == null ? null : Number(p.health)),
        armor: (p.armor == null ? null : Number(p.armor))
      }))

      const dimCN = worldKey ? toDim(worldKey) : null
      const parts = mapped.slice(0, maxOut).map(r => {
        if (r.health == null || r.armor == null) return `${r.name}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)}`
        return `${r.name}@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)} 生命${Math.round(r.health)}/20 盔甲${Math.round(r.armor)}`
      })
      const msg = dimCN ? `${dimCN}: ${parts.join('; ')}` : parts.join('; ')
      return ok(msg, { data: mapped.slice(0, maxOut) })
    } catch (e) {
      try { log?.warn && log.warn('observe_players error', e?.message || e) } catch {}
      return fail('查询失败，请稍后再试~')
    } finally {
      clearTimeout(timeout)
    }
  }

  register('observe_detail', observe_detail)
  register('observe_players', observe_players)
}
