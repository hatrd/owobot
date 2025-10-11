// Whitelisted game actions for AI/tool use

let huntInterval = null
let huntTarget = null
let guardInterval = null
let guardTarget = null
let cullInterval = null
let miningAbort = false

function install (bot, { log, on, registerCleanup }) {
  const pvp = require('./pvp')
  const observer = require('./agent/observer')
  const skillRunnerMod = require('./agent/runner')
  let pathfinderPkg = null
  let guardDebug = false
  function ensurePathfinder () {
    try { if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder'); if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder); return true } catch (e) { log && log.warn && log.warn('pathfinder missing'); return false }
  }

  function ok(msg, extra) { return { ok: true, msg, ...extra } }
  function fail(msg) { return { ok: false, msg } }

  function wait (ms) { return new Promise(r => setTimeout(r, ms)) }

  async function goto (args = {}) {
    const { x, y, z, range = 1.5 } = args
    if ([x, y, z].some(v => typeof v !== 'number')) return fail('缺少坐标')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true); m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range))
    return ok(`前往 ${x},${y},${z}`)
  }

  // Go to the nearest block matching names/match within radius
  async function goto_block (args = {}) {
    const names = Array.isArray(args.names) ? args.names.map(n => String(n).toLowerCase()) : (args.name ? [String(args.name).toLowerCase()] : null)
    const match = args.match ? String(args.match).toLowerCase() : null
    const radius = Math.max(2, parseInt(args.radius || '32', 10))
    const range = Math.max(1, parseFloat(args.range || '1.5'))
    if (!names && !match) return fail('缺少目标名（name|names|match）')
    if (!bot.entity || !bot.entity.position) return fail('未就绪')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = (args.dig === true); m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    const me = bot.entity.position
    // First try mineflayer.findBlocks
    let candidates = bot.findBlocks({
      point: me,
      maxDistance: Math.max(2, radius),
      count: 128,
      matching: (b) => {
        try {
          if (!b) return false
          const n = String(b.name || '').toLowerCase()
          if (!n || n === 'air') return false
          if (names && names.length) { if (names.includes(n)) return true }
          if (match && n.includes(match)) return true
          // Special shorthands
          if (!names && match === 'bed') return n.endsWith('_bed')
          return false
        } catch { return false }
      }
    }) || []

    // Fallback small scan if none
    if (!candidates.length) {
      try {
        const V = require('vec3').Vec3
        const c = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
              const p = new V(c.x + dx, c.y + dy, c.z + dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const n = String(b.name || '').toLowerCase()
              if (!n || n === 'air') continue
              if (names && names.length && !names.includes(n)) continue
              if (match && !n.includes(match)) continue
              candidates.push(p)
              if (candidates.length >= 128) break
            }
            if (candidates.length >= 128) break
          }
          if (candidates.length >= 128) break
        }
      } catch {}
    }

    if (!candidates.length) return fail('附近没有匹配方块')
    // Evaluate reachability using pathfinder.getPathTo and choose the lowest-cost reachable target
    candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const consider = candidates.slice(0, Math.min(80, candidates.length))
    let best = null
    let bestCost = Infinity
    for (const c of consider) {
      try {
        const gx = Math.floor(c.x), gy = Math.floor(c.y), gz = Math.floor(c.z)
        const g = new goals.GoalNear(gx, gy, gz, range)
        const res = bot.pathfinder.getPathTo(m, g)
        if (res && res.status === 'success') {
          const cost = Number.isFinite(res.cost) ? res.cost : (res.path ? res.path.length : 999999)
          if (cost < bestCost) { best = { pos: c, g }; bestCost = cost }
        }
      } catch {}
    }
    if (!best) return fail('附近没有可到达的匹配方块')
    const bp = best.pos
    const px = Math.floor(bp.x), py = Math.floor(bp.y), pz = Math.floor(bp.z)
    bot.pathfinder.setGoal(best.g, true)
    const targetName = (() => { try { return (bot.blockAt(bp)?.name) || (match || (names && names[0]) || 'block') } catch { return match || (names && names[0]) || 'block' } })()
    return ok(`前往(可达) ${targetName} @ ${px},${py},${pz}`)
  }

  async function follow_player (args = {}) {
    const { name, range = 3 } = args
    if (!name) return fail('缺少玩家名')
    const rec = bot.players[name]
    const ent = rec?.entity
    if (!ent) return fail('未找到玩家')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
    return ok(`跟随 ${name}`)
  }

  async function stop (args = {}) {
    // Global emergency stop: always perform a full reset and broadcast stop_all.
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { pvp.stopMoveOverrides(bot) } catch {}
    miningAbort = true
    if (huntInterval) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; huntTarget = null }
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null; guardTarget = null }
    if (cullInterval) { try { clearInterval(cullInterval) } catch {}; cullInterval = null }
    try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch {}
    try { if (bot.isSleeping) await bot.wake() } catch {}
    try { if (bot.vehicle) await bot.dismount() } catch {}
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    try { if (bot.entity && bot.entity.position) bot.lookAt(bot.entity.position, true) } catch {}
    try { if (bot.state) bot.state.autoLookSuspended = false } catch {}
    try { bot.emit('agent:stop_all') } catch {}
    try { if (bot.state) bot.state.currentTask = null } catch {}
    return ok('已复位')
  }

  // Back-compat alias; not advertised to AI
  async function stop_all () { return stop({}) }

  // Preferred name for global reset
  async function reset (args = {}) { return stop(args || {}) }

  async function say (args = {}) {
    const { text } = args
    if (!text) return fail('缺少内容')
    try { bot.chat(String(text).slice(0, 120)) } catch {}
    return ok('已发送')
  }

  // --- Ore mining convenience tool (bridges to skill runner)
  async function mine_ore (args = {}) {
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const radius = Math.max(4, parseInt(args.radius || '32', 10))
    const only = (() => {
      if (!args.only) return null
      if (Array.isArray(args.only)) return args.only.map(x => String(x).toLowerCase())
      return String(args.only).toLowerCase()
    })()
    const expected = args.expected ? String(args.expected) : null
    const res = runner.startSkill('mine_ore', { radius, only }, expected)
    return res.ok ? ok('矿脉挖掘已启动', { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  // --- Write text on ground using blocks (high-level skill) ---
  async function write_text (args = {}) {
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const text = String(args.text || '').trim()
    if (!text) return fail('缺少文本')
    const spacing = Math.max(1, parseInt(args.spacing || '1', 10))
    const size = Math.max(1, parseInt(args.size || '1', 10))
    const item = args.item ? String(args.item) : null
    const res = runner.startSkill('write_text', { text, item, spacing, size }, null)
    return res.ok ? ok('开始铺字~', { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  // --- Harvest and replant crops ---
  async function harvest (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '12', 10))
    const onlyRaw = args.only ? String(args.only).toLowerCase() : null // desired crop item/block name
    const replant = (args.replant !== false)
    const sowOnly = (args.sowOnly === true)
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    function now () { return Date.now() }
    function blockName (b) { try { return String(b?.name || '').toLowerCase() } catch { return '' } }
    function props (b) { try { return (typeof b?.getProperties === 'function') ? (b.getProperties() || {}) : {} } catch { return {} } }
    function isFarmland (b) { const n = blockName(b); return n === 'farmland' }
    function isSoulSand (b) { const n = blockName(b); return n === 'soul_sand' }
    function isAir (b) { const n = blockName(b); return !b || n === 'air' }

    // map block names and items
    const CROPS = [
      { block: 'wheat', item: 'wheat_seeds', maxAge: 7, soil: 'farmland' },
      { block: 'carrots', item: 'carrot', maxAge: 7, soil: 'farmland' },
      { block: 'potatoes', item: 'potato', maxAge: 7, soil: 'farmland' },
      { block: 'beetroots', item: 'beetroot_seeds', maxAge: 3, soil: 'farmland' },
      { block: 'nether_wart', item: 'nether_wart', maxAge: 3, soil: 'soul_sand' }
    ]
    function cropByBlock (n) { n = String(n||'').toLowerCase(); return CROPS.find(c => c.block === n) || null }
    function cropByAlias (n) {
      if (!n) return null
      const s = String(n).toLowerCase()
      for (const c of CROPS) {
        if (c.block === s || c.item === s) return c
        if (s.includes('wheat') || s.includes('seed')) return CROPS[0]
        if (s.includes('carrot')) return CROPS[1]
        if (s.includes('potato') || s.includes('马铃薯') || s.includes('土豆')) return CROPS[2]
        if (s.includes('beet')) return CROPS[3]
        if (s.includes('wart') || s.includes('地狱疙瘩') || s.includes('下界疣')) return CROPS[4]
      }
      return null
    }

    const desired = onlyRaw ? cropByAlias(onlyRaw) : null

    function isMature (b) {
      const n = blockName(b)
      const c = cropByBlock(n)
      if (!c) return false
      const p = props(b)
      const age = (p && (typeof p.age === 'number')) ? p.age : null
      if (age == null) return false
      return age >= c.maxAge
    }

    function findTargets (onlyCrop = null) {
      try {
        const me = bot.entity?.position
        if (!me) return []
        const list = []
        const V = require('vec3').Vec3
        const base = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 3; dy++) {
              const p = base.offset(dx, dy, dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const n = blockName(b)
              const c = cropByBlock(n)
              if (!c) continue
              if (onlyCrop && c.block !== onlyCrop.block) continue
              if (!isMature(b)) continue
              list.push({ pos: p, crop: c, mature: true })
            }
          }
        }
        list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
        return list
      } catch { return [] }
    }

    function invFind (name) { try { const s = String(name).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === s) || null } catch { return null } }

    async function plantAt (pos, crop) {
      try {
        const below = pos.offset(0, -1, 0)
        const soil = bot.blockAt(below)
        if (crop.soil === 'farmland' && !isFarmland(soil)) return false
        if (crop.soil === 'soul_sand' && !isSoulSand(soil)) return false
        const seed = invFind(crop.item)
        if (!seed) return false
        // Equip seed and place on top face of soil
        await bot.equip(seed, 'hand')
        try { await bot.lookAt(soil.position.offset(0.5, 0.5, 0.5), true) } catch {}
        await bot.placeBlock(soil, require('vec3').Vec3(0, 1, 0))
        return true
      } catch { return false }
    }

    function findSowSpots (crop) {
      try {
        const me = bot.entity?.position
        if (!me) return []
        const list = []
        const V = require('vec3').Vec3
        const base = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 2; dy++) {
              const soilPos = base.offset(dx, dy, dz)
              const soil = bot.blockAt(soilPos)
              if (!soil) continue
              if (crop.soil === 'farmland' && !isFarmland(soil)) continue
              if (crop.soil === 'soul_sand' && !isSoulSand(soil)) continue
              const above = bot.blockAt(soilPos.offset(0, 1, 0))
              if (!isAir(above)) continue
              list.push(soilPos.offset(0, 1, 0)) // position where crop will be
            }
          }
        }
        list.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        return list
      } catch { return [] }
    }

    let targets = sowOnly ? [] : findTargets(desired)
    let done = 0; let replanted = 0
    for (const t of targets) {
      try {
        const me = bot.entity?.position
        const d = me ? t.pos.distanceTo(me) : 0
        // Move near the crop
        bot.pathfinder.setGoal(new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 1.8), true)
        const until = now() + 6000
        while (now() < until) {
          const cur = bot.blockAt(t.pos)
          if (!cur || !isMature(cur)) break
          const cd = bot.entity.position.distanceTo(t.pos)
          if (cd <= 2.0) break
          await wait(80)
        }
        // Dig only mature crop (default behavior)
        const cur = bot.blockAt(t.pos)
        if (cur && isMature(cur)) {
          try { await bot.lookAt(cur.position.offset(0.5, 0.4, 0.5), true) } catch {}
          try { await bot.dig(cur) } catch {}
          done++
          // brief wait for drops to land
          await wait(300)
          // try replant
          if (replant) {
            // quick nearby pickup to acquire seeds if needed
            if (!invFind(t.crop.item)) {
              try {
                // actively collect nearby matching drops for a short window
                await collect({ radius: Math.min(12, radius), match: t.crop.item })
              } catch {}
            }
            const okp = await plantAt(t.pos, t.crop)
            if (okp) replanted++
          }
        }
      } catch {}
    }
    // If sow-only requested, or nothing to harvest, or replant count is low, do a sow-only pass
    const wantCrop = desired || (targets[0] && targets[0].crop) || null
    if (replant !== false && (sowOnly || done === 0 || replanted < done)) {
      const seedPref = wantCrop || (function pickByInventory () {
        const order = ['potato','carrot','wheat_seeds','beetroot_seeds','nether_wart']
        for (const name of order) { if (invFind(name)) return cropByAlias(name) }
        return null
      })()
      if (seedPref) {
        // Try collect matching seeds before sowing if none in inventory
        if (!invFind(seedPref.item)) {
          try { await collect({ radius: Math.min(16, radius + 4), match: seedPref.item }) } catch {}
        }
        const spots = findSowSpots(seedPref)
        for (const p of spots) {
          const okp = await plantAt(p, seedPref)
          if (okp) replanted++
          if (done > 0 && replanted >= done) break
        }
      }
    }
    try { bot.pathfinder.setGoal(null) } catch {}
    return ok(`已收割${done}，重种${replanted}`)
  }

  async function observe_detail (args = {}) {
    try {
      const r = observer.detail(bot, args || {})
      return { ok: Boolean(r && r.ok), msg: (r && r.msg) || '无', data: r && r.data }
    } catch (e) { return fail(String(e?.message || e)) }
  }

  // --- High-level skills bridge ---
  function ensureRunner () {
    try { return skillRunnerMod.ensure(bot, { on, registerCleanup, log }) } catch { return null }
  }

  async function skill_start (args = {}) {
    const { skill, expected = null } = args
    if (!skill) return fail('缺少技能名')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    try {
      // lazy register default skills once (no placeholders)
      if (runner.listSkills().length === 0) {
        runner.registerSkill('go', require('./skills/go'))
        runner.registerSkill('gather', require('./skills/gather'))
        runner.registerSkill('craft', require('./skills/craft'))
      }
    } catch {}
    const res = runner.startSkill(String(skill), args.args || {}, expected || null)
    return res.ok ? ok(`任务已启动 ${res.taskId}`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  async function skill_status (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.status(String(taskId))
    return r.ok ? ok('状态', r) : fail(r.msg || '查询失败')
  }

  async function skill_cancel (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.cancel(String(taskId))
    return r.ok ? ok('已取消', r) : fail(r.msg || '取消失败')
  }

  function normalizeName (name) {
    const n = String(name || '').toLowerCase().trim()
    const aliases = new Map([
      ['铁粒', 'iron_nugget'],
      ['火把', 'torch'],
      ['水桶', 'water_bucket'],
      ['钻石剑', 'diamond_sword'],
      ['钻石斧', 'diamond_axe'],
      ['钻石镐', 'diamond_pickaxe'],
      ['圆石', 'cobblestone'],
      ['石头', 'stone'],
      ['木棍', 'stick'],
      ['沙子', 'sand'],
      // woods (CN -> EN)
      ['橡木原木', 'oak_log'],
      ['云杉原木', 'spruce_log'],
      ['白桦原木', 'birch_log'],
      ['丛林原木', 'jungle_log'],
      ['金合欢原木', 'acacia_log'],
      ['相思木原木', 'acacia_log'],
      ['深色橡木原木', 'dark_oak_log'],
      ['红树原木', 'mangrove_log'],
      ['樱花原木', 'cherry_log'],
      // saplings
      ['橡树苗', 'oak_sapling'],
      ['云杉树苗', 'spruce_sapling'],
      ['白桦树苗', 'birch_sapling'],
      ['丛林树苗', 'jungle_sapling'],
      ['金合欢树苗', 'acacia_sapling'],
      ['相思木树苗', 'acacia_sapling'],
      ['深色橡树苗', 'dark_oak_sapling'],
      ['樱花树苗', 'cherry_sapling']
    ])
    return aliases.get(n) || n
  }

  function resolveItemByName (name) {
    const needle = normalizeName(name)
    const inv = bot.inventory?.items() || []
    // include held/offhand explicitly if not listed
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    const all = inv.concat(extra)
    let exact = all.find(it => String(it.name || '').toLowerCase() === needle)
    if (exact) return exact
    const partial = all.filter(it => String(it.name || '').toLowerCase().includes(needle))
    partial.sort((a, b) => (b.count || 0) - (a.count || 0))
    return partial[0] || null
  }

  function countItemByName (name) {
    try {
      const needle = normalizeName(name)
      const inv = bot.inventory?.items() || []
      return inv.filter(it => String(it.name || '').toLowerCase() === needle).reduce((a, b) => a + (b.count || 0), 0)
    } catch { return 0 }
  }

  function findAllByName (name) {
    const needle = normalizeName(name)
    const inv = bot.inventory?.items() || []
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    const all = inv.concat(extra)
    const same = all.filter(it => String(it.name || '').toLowerCase() === needle)
    if (same.length) return same
    const part = all.filter(it => String(it.name || '').toLowerCase().includes(needle))
    return part
  }

  function bestMaterialRank (n) {
    const order = ['netherite','diamond','iron','stone','golden','wooden']
    const i = order.indexOf(String(n || '').toLowerCase())
    return i >= 0 ? i : order.length
  }

  function itemMaterial (nm) {
    const n = String(nm || '').toLowerCase()
    if (n === 'turtle_helmet') return 'turtle'
    const p = n.split('_')
    return p.length ? p[0] : null
  }

  function isPickaxeName (nm) { return String(nm || '').toLowerCase().endsWith('_pickaxe') }

  function findBestPickaxe () {
    const inv = bot.inventory?.items() || []
    const extra = []
    if (bot.heldItem) extra.push(bot.heldItem)
    const off = bot.inventory?.slots?.[45]
    if (off) extra.push(off)
    const all = inv.concat(extra)
    const picks = all.filter(it => isPickaxeName(it?.name))
    if (!picks.length) return null
    picks.sort((a, b) => bestMaterialRank(itemMaterial(a.name)) - bestMaterialRank(itemMaterial(b.name)))
    return picks[0] || null
  }

  async function ensureBestPickaxe () {
    try { const it = findBestPickaxe(); if (it) { await bot.equip(it, 'hand'); return true } } catch {}
    return false
  }

  async function equip (args = {}) {
    const { name, dest = 'hand' } = args
    if (!name) return fail('缺少物品名')
    const item = resolveItemByName(name)
    if (!item) return fail('背包没有该物品')
    const map = {
      hand: 'hand', 'main': 'hand', 'mainhand': 'hand',
      offhand: 'off-hand', 'off_hand': 'off-hand', 'off-hand': 'off-hand',
      head: 'head', helmet: 'head',
      chest: 'torso', body: 'torso', torso: 'torso',
      legs: 'legs', pants: 'legs',
      feet: 'feet', boots: 'feet'
    }
    const destination = map[String(dest).toLowerCase()] || 'hand'
    await bot.equip(item, destination)
    return ok(`已装备 ${item.name} -> ${destination}`)
  }

  async function ensureItemEquipped (name) {
    const item = resolveItemByName(name)
    if (!item) throw new Error('背包没有该物品')
    await bot.equip(item, 'hand')
    return true
  }

  async function toss (args = {}) {
    // Unified interface: support single or multiple via items[]; each item spec may be by name or slot, with optional count
    // Accepted forms:
    //  - { name, count? }
    //  - { items: [{ name|slot, count? }, ...] }
    //  - { names: [string,...] }
    const arr = (() => {
      if (Array.isArray(args.items) && args.items.length) return args.items
      if (Array.isArray(args.names) && args.names.length) return args.names.map(n => ({ name: n }))
      if (args.name) return [{ name: args.name, count: args.count }]
      if (args.slot) return [{ slot: args.slot, count: args.count }]
      return null
    })()
    // Special: drop all inventory items when all=true (consistent interface, still one tool)
    if ((!arr || !arr.length) && (args.all === true || String(args.all).toLowerCase() === 'true')) {
      const inv = bot.inventory?.items() || []
      const uniq = new Map()
      for (const it of inv) { if (it && it.name) uniq.set(it.name, true) }
      const exclude = new Set((Array.isArray(args.exclude) ? args.exclude : []).map(n => String(n).toLowerCase()))
      const items = Array.from(uniq.keys()).filter(n => !exclude.has(String(n).toLowerCase()))
      if (items.length === 0) return ok('背包为空')
      for (const nm of items) {
        const stacks = findAllByName(nm)
        for (const it of stacks) { const c = it.count || 0; if (c > 0) await bot.toss(it.type, null, c) }
      }
      return ok('已丢出全部物品')
    }
    if (!arr || !arr.length) return fail('缺少物品参数')

    function itemFromSlot (slot) {
      const key = String(slot).toLowerCase()
      if (key === 'hand' || key === 'main' || key === 'mainhand') return bot.heldItem || null
      if (key === 'offhand' || key === 'off-hand' || key === 'off_hand') return bot.inventory?.slots?.[45] || null
      const idx = parseInt(String(slot), 10)
      if (Number.isFinite(idx) && bot.inventory?.slots) return bot.inventory.slots[idx] || null
      return null
    }

    const summary = []
    for (const spec of arr) {
      const cnt = (spec && spec.count != null) ? Math.max(0, Number(spec.count)) : null
      if (spec.slot) {
        const it = itemFromSlot(spec.slot)
        if (!it) { summary.push(`${spec.slot}:x0`); continue }
        const n = cnt != null ? Math.min(cnt, it.count || 0) : (it.count || 0)
        if (n > 0) await bot.toss(it.type, null, n)
        summary.push(`${it.name}x${n}`)
        continue
      }
      const nm = spec?.name
      if (!nm) { summary.push('unknown:x0'); continue }
      const items = findAllByName(nm)
      if (!items || items.length === 0) { summary.push(`${normalizeName(nm)}x0`); continue }
      if (cnt != null) {
        const it = items[0]
        const n = Math.min(cnt, it.count || 0)
        if (n > 0) await bot.toss(it.type, null, n)
        summary.push(`${it.name}x${n}`)
      } else {
        let total = 0
        for (const it of items) { const c = it.count || 0; if (c > 0) { await bot.toss(it.type, null, c); total += c } }
        summary.push(`${normalizeName(nm)}x${total}`)
      }
    }
    return ok(`已丢出: ${summary.join(', ')}`)
  }

  async function hunt_player (args = {}) {
    const { name, range = 1.8, tickMs = 250, durationMs = null } = args
    if (!name) return fail('缺少玩家名')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = true
    bot.pathfinder.setMovements(m)
    huntTarget = String(name)
    if (huntInterval) { try { clearInterval(huntInterval) } catch {}; huntInterval = null }
    const ctx = {}
    const startedAt = Date.now()
    const iv = setInterval(() => {
      try {
        if (durationMs != null && (Date.now() - startedAt) > Number(durationMs)) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; return }
        const ent = bot.players[huntTarget]?.entity
        if (!ent) return
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
        try { pvp.pvpTick(bot, ent, ctx) } catch {}
      } catch {}
    }, Math.max(150, tickMs))
    huntInterval = iv
    // Ensure hard reset truly stops hunting: clear this specific timer on stop/end
    const stopHunt = () => { try { clearInterval(iv) } catch {}; if (huntInterval === iv) huntInterval = null; huntTarget = null; try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {} }
    try { bot.once('agent:stop_all', stopHunt) } catch {}
    try { bot.once('end', stopHunt) } catch {}
    try { if (typeof registerCleanup === 'function') registerCleanup(() => stopHunt()) } catch {}
    return ok(`开始追击 ${huntTarget}` + (durationMs != null ? ` (持续${Math.round(Number(durationMs)/1000)}s)` : ''))
  }

  // --- Mining ---
  function isLavaLike (block) { const n = String(block?.name || '').toLowerCase(); return n.includes('lava') }
  function isDangerBelow () {
    try {
      const p1 = bot.entity.position.offset(0, -1, 0)
      const p2 = bot.entity.position.offset(0, -2, 0)
      const b1 = bot.blockAt(p1)
      const b2 = bot.blockAt(p2)
      return isLavaLike(b1) || isLavaLike(b2)
    } catch { return false }
  }

  async function dig_down (args = {}) {
    // wrapper to unified break_blocks
    const maxSteps = Math.max(1, parseInt(args.maxSteps || '16', 10))
    return break_blocks({ area: { shape: 'down', steps: maxSteps }, max: maxSteps, collect: true })
  }

  function oreNamesSet () {
    const list = [
      // overworld
      'coal_ore','iron_ore','gold_ore','diamond_ore','redstone_ore','lapis_ore','emerald_ore','copper_ore',
      // deepslate variants
      'deepslate_coal_ore','deepslate_iron_ore','deepslate_gold_ore','deepslate_diamond_ore','deepslate_redstone_ore','deepslate_lapis_ore','deepslate_emerald_ore','deepslate_copper_ore',
      // nether
      'nether_quartz_ore','nether_gold_ore','ancient_debris'
    ]
    return new Set(list)
  }

  async function auto_mine (args = {}) {
    // wrapper to unified break_blocks (user may pass target substring)
    const { target = 'any', radius = 12, maxBlocks = 12 } = args
    const match = target && target !== 'any' ? String(target) : null
    return break_blocks({ match, area: { shape: 'sphere', radius }, max: maxBlocks, collect: true })
  }

  async function break_blocks (args = {}) {
    const toolSel = require('./tool-select')
    const match = Array.isArray(args.names) && args.names.length ? null : (args.match ? String(args.match).toLowerCase() : null)
    const names = Array.isArray(args.names) ? args.names.map(n => String(n).toLowerCase()) : null
    const area = args.area || { shape: 'sphere', radius: 8 }
    const until = String(args.until || 'exhaust').toLowerCase() // default exhaust to avoid premature stop
    const max = Math.max(1, parseInt(args.max || '12', 10))
    const limit = (until === 'exhaust' || until === 'all') ? Number.MAX_SAFE_INTEGER : max
    const collect = (String(args.collect ?? 'true').toLowerCase() !== 'false')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    miningAbort = false

    // helpers
    function matches (b) {
      const n = String(b?.name || '').toLowerCase()
      if (!n || n === 'air') return false
      if (names) return names.includes(n)
      if (match) return n.includes(match)
      return true
    }

    async function approachAndDig (p) {
      // approach
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1), true)
      const until = Date.now() + 8000
      while (Date.now() < until) {
        await wait(100)
        const d = bot.entity.position.distanceTo(p)
        if (d <= 2.3) break
      }
      // stop pathfinder before digging to avoid movement-caused aborts
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      await wait(60)
      let block = bot.blockAt(p)
      if (!block || !matches(block)) return false
      // safety: avoid lava neighbor on/below
      const below = bot.blockAt(p.offset(0, -1, 0))
      if (isLavaLike(block) || isLavaLike(below)) return false
      try { await toolSel.ensureBestToolForBlock(bot, block) } catch {}
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
          await bot.dig(block)
          break
        } catch (e) {
          const msg = String(e?.message || e)
          if (/aborted/i.test(msg) || /not currently diggable/i.test(msg)) {
            await wait(150)
            block = bot.blockAt(p)
            if (!block || !matches(block)) return false
            continue
          }
          return false
        }
      }
      if (collect) {
        // move into spot briefly to pick drops
        try { bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 0), true) } catch {}
        await wait(300)
      }
      return true
    }

    let broken = 0
    const me = bot.entity?.position
    if (!me) return fail('未就绪')

    if ((area.shape || 'sphere') === 'down') {
      const steps = Math.max(1, parseInt(area.steps || '8', 10))
      while (!miningAbort && broken < Math.min(limit, steps)) {
        if (!bot.entity || !bot.entity.position) break
        if (isDangerBelow()) return ok(`停止: 下方疑似岩浆, 已挖 ${broken}`)
        const feet = bot.entity.position.offset(0, -1, 0)
        const target = bot.blockAt(feet)
        if (!target || !matches(target)) break
        try { await toolSel.ensureBestToolForBlock(bot, target) } catch {}
        await bot.lookAt(feet.offset(0.5, 0.5, 0.5), true)
        await bot.dig(target)
        // wait to fall
        const startY = Math.floor(bot.entity.position.y)
        const untilFall = Date.now() + 1500
        while (Date.now() < untilFall) { await wait(50); const y = Math.floor(bot.entity.position.y); if (y < startY) break }
        broken++
      }
      return ok(`挖掘完成 ${broken}`)
    }

    // sphere with optional vertical limit (height -> cylinder)
    const origin = area.origin ? new (require('vec3').Vec3)(area.origin.x, area.origin.y, area.origin.z) : me
    const radius = Math.max(1, parseInt(area.radius || '8', 10))
    const height = area.height != null ? Math.max(0, parseInt(area.height, 10)) : null

    // Flush config: if drops pile up, run a short pickup sweep (no digging)
    const flushThreshold = (() => { const v = args.flushThreshold; return v == null ? (collect ? 10 : 0) : Math.max(1, parseInt(v, 10)) })()
    const flushTimeoutMs = Math.max(500, parseInt(args.flushTimeoutMs || '2500', 10))
    const flushRadius = Math.max(2, parseInt(args.flushRadius || String(radius), 10))
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
    function countNearbyDrops () {
      try {
        const mep = bot.entity?.position; if (!mep) return 0
        let c = 0
        for (const e of Object.values(bot.entities || {})) {
          if (!isItemEntity(e)) continue
          try { if (mep.distanceTo(e.position) <= flushRadius) c++ } catch {}
        }
        return c
      } catch { return 0 }
    }
    async function doShortPickup () {
      try {
        const { goals } = pathfinderPkg
        const untilPick = Date.now() + flushTimeoutMs
        while (Date.now() < untilPick) {
          const mep = bot.entity?.position; if (!mep) break
          const items = Object.values(bot.entities || {}).filter(e => isItemEntity(e) && mep.distanceTo(e.position) <= flushRadius)
          if (!items.length) break
          // go to nearest one
          items.sort((a, b) => a.position.distanceTo(mep) - b.position.distanceTo(mep))
          const it = items[0]
          bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(it.position.x), Math.floor(it.position.y), Math.floor(it.position.z), 0), true)
          await wait(120)
        }
      } catch {}
    }

    // Prefer XY-near targets for logs to avoid zig-zagging across the area
    const isLogsMode = (() => {
      try {
        if (names && names.some(n => n && (n === 'log' || n.endsWith('_log')))) return true
        if (match && String(match).includes('log')) return true
      } catch {}
      return false
    })()
    let currentColumn = null // { x, z } of last chopped block; finish trunk before moving

    while (!miningAbort && broken < limit) {
      const posList = bot.findBlocks({
        point: origin,
        maxDistance: Math.max(2, radius),
        count: 64,
        matching: (b) => {
          if (!matches(b)) return false
          if (height != null) {
            const dy = Math.abs(b.position.y - origin.y)
            if (dy > (height / 2)) return false
          }
          return true
        }
      }) || []
      if (!posList.length) break
      // Selection: if logs and we have a current trunk, finish same (x,z) first; else sort by 2D distance then |dy|
      let candidate = null
      if (isLogsMode && currentColumn) {
        candidate = posList.find(p => (p.x === currentColumn.x && p.z === currentColumn.z)) || null
      }
      if (!candidate) {
        const here = bot.entity?.position || me
        posList.sort((a, b) => {
          const adx = Math.abs(a.x - here.x), adz = Math.abs(a.z - here.z)
          const bdx = Math.abs(b.x - here.x), bdz = Math.abs(b.z - here.z)
          const a2d = Math.hypot(adx, adz), b2d = Math.hypot(bdx, bdz)
          if (a2d !== b2d) return a2d - b2d
          const ady = Math.abs(a.y - here.y), bdy = Math.abs(b.y - here.y)
          return ady - bdy
        })
        candidate = posList[0]
      }
      let did = false
      if (candidate) {
        if (await approachAndDig(candidate)) { broken++; did = true; if (isLogsMode) currentColumn = { x: candidate.x, z: candidate.z } }
      }
      if (!did) break
      // Mid-loop flush: if many drops nearby, do a quick pickup pass
      if (collect && flushThreshold > 0) {
        try { if (countNearbyDrops() >= flushThreshold) await doShortPickup() } catch {}
      }
    }
    // final pickup sweep (short)
    if (collect) {
      try {
        const me = bot.entity?.position
        const items = Object.values(bot.entities || {}).filter(e => {
          try {
            if (!me || !e || !e.position) return false
            const kind = String(e?.kind || '').toLowerCase()
            if (kind === 'drops') return me.distanceTo(e.position) <= Math.max(3, (area.radius || 6))
            const nm = String(e.name || e.displayName || '').toLowerCase()
            if (nm === 'item' || nm === 'item_entity' || nm === 'dropped_item') return me.distanceTo(e.position) <= Math.max(3, (area.radius || 6))
            if (e.item) return me.distanceTo(e.position) <= Math.max(3, (area.radius || 6))
            return false
          } catch { return false }
        })
        const { goals } = pathfinderPkg
        const untilPick = Date.now() + 1500
        for (const it of items) {
          if (Date.now() > untilPick) break
          bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(it.position.x), Math.floor(it.position.y), Math.floor(it.position.z), 0), true)
          await wait(120)
        }
      } catch {}
    }

    // Optional: return to the original origin after mining (useful when standing on leaves after chopping)
    try {
      const wantReturn = (() => {
        if (args.returnToOrigin === true) return true
        if (args.returnToOrigin === false) return false
        // Auto-enable when target is logs
        if (names && names.some(n => n && (n === 'log' || n.endsWith('_log')))) return true
        if (match && String(match).includes('log')) return true
        return false
      })()
      if (wantReturn && origin && bot.entity && bot.entity.position) {
        const here = bot.entity.position
        const dist = here.distanceTo(origin)
        if (dist > 1.8) {
          const { Movements, goals } = pathfinderPkg
          const mcData2 = bot.mcData || require('minecraft-data')(bot.version)
          const m2 = new Movements(bot, mcData2)
          m2.canDig = true
          m2.allowSprinting = true
          m2.allowParkour = true
          // allow dropping a bit to get off leaves safely
          try { m2.maxDropDown = Math.max(4, m2.maxDropDown || 0, 8) } catch {}
          bot.pathfinder.setMovements(m2)
          bot.pathfinder.setGoal(new goals.GoalNear(origin.x, origin.y, origin.z, 1), true)
          const untilBack = Date.now() + 6000
          while (Date.now() < untilBack) {
            await wait(120)
            const cur = bot.entity?.position
            if (!cur) break
            const d = cur.distanceTo(origin)
            if (d <= 1.6) break
          }
          try { bot.pathfinder.setGoal(null) } catch {}
        }
      }
    } catch {}
    return ok(`挖掘完成 ${broken}`)
  }

  // Helper: ore detection/unification for gather->mine_ore
  function isOreNameSimple (n) {
    const s = String(n || '').toLowerCase()
    if (!s) return false
    if (s.endsWith('_ore')) return true
    if (s === 'ancient_debris') return true
    return false
  }
  function oreOnlyToken (n) {
    const s = String(n || '').toLowerCase()
    if (s === 'ancient_debris') return 'ancient_debris'
    if (!s.endsWith('_ore')) return s
    let base = s.slice(0, -'_ore'.length)
    if (base.startsWith('deepslate_')) base = base.slice('deepslate_'.length)
    if (base.startsWith('nether_')) base = base.slice('nether_'.length)
    // map lapis/redstone/quartz exacts
    if (base.includes('lapis')) return 'lapis'
    if (base.includes('redstone')) return 'redstone'
    if (base.includes('quartz')) return 'quartz'
    return base
  }

  // --- Riding ---
  function isRideableName (nm) {
    const n = String(nm || '').toLowerCase()
    if (!n) return false
    if (n.includes('boat')) return true // boat, chest_boat, oak_boat, etc.
    if (n.includes('minecart')) return true
    if (['horse','donkey','mule','camel','llama','trader_llama','strider','pig'].includes(n)) return true
    return false
  }

  function isRideableEntity (e) { try { return e && e !== bot.entity && e.position && isRideableName(e.name || e.displayName) } catch { return false } }

  async function mount_near (args = {}) {
    const { radius = 6, prefer = null, timeoutMs = 8000 } = args
    if (!bot.entity || !bot.entity.position) return fail('未就绪')
    // If already riding something else (e.g., boat), dismount first then proceed
    if (bot.vehicle) {
      try { await bot.dismount() } catch {}
      await wait(200)
      if (bot.vehicle) return fail('当前在其他坐骑上，无法操作')
    }
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    function pickNearest () {
      const me = bot.entity?.position
      if (!me) return null
      let best = null; let bestD = Infinity
      for (const e of Object.values(bot.entities || {})) {
        if (!isRideableEntity(e)) continue
        if (prefer && !String(e.name || '').toLowerCase().includes(String(prefer).toLowerCase())) continue
        const d = e.position.distanceTo(me)
        if (d <= radius && d < bestD) { best = e; bestD = d }
      }
      return best
    }

    const start = Date.now()
    while (Date.now() - start <= timeoutMs) {
      try {
        if (bot.vehicle) return ok('已乘坐')
        const tgt = pickNearest()
        if (!tgt) { await wait(150); continue }
        bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 1.4), true)
        // Approach until close or target gone or timeout slice
        const sliceUntil = Date.now() + 2000
        while (Date.now() < sliceUntil) {
          if (bot.vehicle) return ok('已乘坐')
          const cur = bot.entities?.[tgt.id]
          if (!cur) break
          const d = cur.position.distanceTo(bot.entity.position)
          if (d <= 2.0) {
            try { bot.mount(cur) } catch {}
            // wait confirmation from mineflayer state
            const confirmUntil = Date.now() + 1800
            while (Date.now() < confirmUntil) {
              if (bot.vehicle) return ok('已乘坐')
              await wait(80)
            }
            break
          }
          await wait(120)
        }
      } catch { await wait(120) }
    }
    return fail('乘坐超时')
  }

  async function dismount () {
    try { if (!bot.vehicle) return ok('当前未乘坐') ; await bot.dismount(); return ok('已下坐') } catch (e) { return fail('下坐失败: ' + (e?.message || e)) }
  }

  // --- Ranged attack (bow/crossbow via HawkEye) ---
  async function range_attack (args = {}) {
    const { name = null, match = null } = args
    const radius = Math.max(4, parseInt(args.radius || '24', 10))
    const followRange = Math.max(4, parseInt(args.followRange || '6', 10))
    const durationMs = args.durationMs != null ? Math.max(500, parseInt(args.durationMs, 10)) : null
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true
    m.canDig = false
    bot.pathfinder.setMovements(m)

    // Load HawkEye plugin
    let hawkLoaded = false
    try {
      if (!bot.hawkEye) {
        const mod = require('minecrafthawkeye')
        const plug = (mod && mod.default) ? mod.default : mod
        if (typeof plug === 'function') bot.loadPlugin(plug)
      }
      hawkLoaded = !!bot.hawkEye
    } catch {}
    if (!hawkLoaded) return fail('鹰眼不可用')

    function invHas (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).some(it => String(it.name||'').toLowerCase() === n) } catch { return false } }
    function invGet (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === n) || null } catch { return null } }
    function pickRangedWeapon () { if (!invHas('arrow')) return null; if (invHas('crossbow')) return 'crossbow'; if (invHas('bow')) return 'bow'; return null }
    async function ensureWeaponEquipped (weapon) { try { if (bot.state && bot.state.holdItemLock) return false; const it = invGet(weapon); if (!it) return false; if (bot.heldItem && String(bot.heldItem.name||'').toLowerCase() === weapon) return true; await bot.equip(it, 'hand'); return true } catch { return false } }

    const weapon = pickRangedWeapon()
    if (!weapon) return fail('缺少弓箭（需要弓/弩和箭）')

    function entityLabel (e) {
      try { return String(e?.name || (e?.displayName && e.displayName.toString && e.displayName.toString()) || e?.kind || e?.type || '').replace(/\u00a7./g, '').toLowerCase() } catch { return '' }
    }
    function resolvePlayerByName (wanted) {
      try {
        const w = String(wanted || '').trim().toLowerCase()
        if (!w) return null
        // bot.players map
        if (bot.players && bot.players[w] && bot.players[w].entity) return bot.players[w].entity
        // fallback scan
        for (const e of Object.values(bot.entities || {})) {
          try { if (e && e.type === 'player' && String(e.username || e.name || '').toLowerCase() === w) return e } catch {}
        }
      } catch {}
      return null
    }
    function resolveNearestByMatch (substr, radius) {
      const me = bot.entity?.position
      if (!me) return null
      const s = String(substr || '').toLowerCase()
      let best = null; let bestD = Infinity
      for (const e of Object.values(bot.entities || {})) {
        try {
          if (!e || e === bot.entity || !e.position) continue
          const d = e.position.distanceTo(me)
          if (!Number.isFinite(d) || d > radius) continue
          const nm = entityLabel(e)
          if (!s || (nm && nm.includes(s))) {
            if (d < bestD) { best = e; bestD = d }
          }
        } catch {}
      }
      return best
    }

    // Target resolution with safety: for player, require explicit exact name
    let target = null
    if (name) {
      target = resolvePlayerByName(name)
      if (!target) return fail('找不到该玩家')
    } else if (match) {
      target = resolveNearestByMatch(match, radius)
      if (!target) return fail('附近没有匹配目标')
      if (String(target.type).toLowerCase() === 'player') return fail('禁止模糊攻击玩家，请指名玩家名')
    } else {
      return fail('缺少目标（name|match）')
    }

    // Start ranged tracking loop
    let rangedActive = false
    let rangedStickUntil = 0
    let handLockToken = null
    function lockHand () { try { if (bot.state && !bot.state.holdItemLock) { bot.state.holdItemLock = 'ranged_bow'; handLockToken = 'ranged_bow' } } catch {} }
    function unlockHand () { try { if (handLockToken && bot.state && bot.state.holdItemLock === handLockToken) bot.state.holdItemLock = null; handLockToken = null } catch {} }
    let currentId = null
    const startedAt = Date.now()

    const iv = setInterval(async () => {
      try {
        // Yield to other tools while busy
        try { if (bot.state && bot.state.externalBusy) return } catch {}
        // Refresh target entity reference
        const ent = (() => { try { return bot.entities?.[target.id] || target } catch { return target } })()
        if (!ent || !ent.position) return
        // Follow within a comfortable distance while ranging
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, followRange), true)
        const meD = ent.position.distanceTo(bot.entity.position)
        // (Re)start hawkeye autoAttack when target changes
        if (!rangedActive || currentId !== ent.id) {
          try { bot.hawkEye.stop() } catch {}
          try { await ensureWeaponEquipped(weapon) } catch {}
          try { bot.hawkEye.autoAttack(ent, weapon) } catch {}
          rangedActive = true
          currentId = ent.id
        }
        // Optional duration limit
        if (durationMs != null && (Date.now() - startedAt) > durationMs) {
          try { bot.hawkEye.stop() } catch {}
          try { clearInterval(iv) } catch {}
          return
        }
      } catch {}
    }, Math.max(150, parseInt(args.tickMs || '250', 10)))

    // Stop hooks
    const stop = () => { try { bot.hawkEye.stop() } catch {}; try { clearInterval(iv) } catch {} }
    try { bot.once('agent:stop_all', stop) } catch {}
    try { bot.once('end', stop) } catch {}
    try { if (typeof registerCleanup === 'function') registerCleanup(stop) } catch {}
    try { if (bot.state) bot.state.currentTask = { name: '远程射击', source: 'player', startedAt: Date.now() } } catch {}

    return ok(name ? `开始远程射击玩家 ${name}` : `开始远程射击（匹配:${String(match)}）`)
  }

  // --- Mount player: empty-hand right click on a player entity
  async function mount_player (args = {}) {
    const { name, range = 1.2, followRange = 1.2, timeoutMs = 10000, tickMs = 120, sneak = false } = args
    if (!name) return fail('缺少玩家名')
    if (!bot.entity || !bot.entity.position) return fail('未就绪')
    // Do not short-circuit if already riding; dismount first to avoid stale state
    if (bot.vehicle) {
      try { await bot.dismount() } catch {}
      await wait(250)
    }
    const initialMounted = !!bot.vehicle
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = false; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    const targetName = String(name).trim().toLowerCase()
    function resolveTargetEntity () {
      try {
        for (const [uname, rec] of Object.entries(bot.players || {})) {
          if (String(uname || '').toLowerCase() === targetName) return rec?.entity || null
        }
        for (const e of Object.values(bot.entities || {})) {
          try { if (e && e.type === 'player' && String(e.username || e.name || '').toLowerCase() === targetName) return e } catch {}
        }
      } catch {}
      return null
    }
    async function ensureEmptyHand () {
      try {
        if (bot.state && bot.state.holdItemLock) return true // respect lock; proceed anyway
        if (!bot.heldItem) return true
        await bot.unequip('hand')
        return true
      } catch { return false }
    }

    const start = Date.now()
    let success = false
    // Listen for mount event for reliable confirmation (handles set_passengers/attach variants)
    let mountedAt = 0
    const onMount = () => { mountedAt = Date.now() }
    try { bot.on('mount', onMount) } catch {}
    try {
      while (Date.now() - start <= timeoutMs) {
        try {
          // Only treat mounted as success if it changed during this call
          if (bot.vehicle && (!initialMounted || mountedAt >= start)) { success = true; break }
          const ent = resolveTargetEntity()
          if (!ent || !ent.position) { await wait(Math.min(300, tickMs)); continue }
          // Approach within follow range
          bot.pathfinder.setGoal(new goals.GoalFollow(ent, Math.max(0.9, Math.min(2, followRange))), true)
          const d = ent.position.distanceTo(bot.entity.position)
          if (d <= Math.max(0.9, range)) {
            // Prepare: empty hand, face head, optional sneak
            try { await ensureEmptyHand() } catch {}
            try { await bot.lookAt(ent.position.offset(0, 1.5, 0), true) } catch {}
            if (sneak === true) { try { bot.setControlState('sneak', true) } catch {} }
            // Stop pathfinder during interaction to reduce jitter
            try { bot.pathfinder.setGoal(null) } catch {}
            // Try multiple interaction styles
            const burst = async () => {
              for (let i = 0; i < 6; i++) {
                // High-level interact (no position)
                try { if (typeof bot.activateEntity === 'function') await bot.activateEntity(ent) } catch {}
                // Interact-at head position (plugins often listen on InteractAt)
                try { if (typeof bot.activateEntityAt === 'function') await bot.activateEntityAt(ent, ent.position.offset(0, 1.5, 0)) } catch {}
                try { if (typeof bot.swingArm === 'function') bot.swingArm('right') } catch {}
                if (bot.vehicle) return true
                await wait(90)
              }
              return false
            }
            if (await burst()) { success = true; break }
            // Confirm with a slightly longer window to catch server-side attach
            const confirmUntil = Date.now() + 2500
            while (Date.now() < confirmUntil) {
              if ((bot.vehicle && (!initialMounted || mountedAt >= start)) || (mountedAt >= start)) { success = true; break }
              await wait(60)
            }
            if (success) break
            // Nudge and retry once without sneak, then with sneak
            try { bot.setControlState('forward', true); await wait(220); bot.setControlState('forward', false) } catch {}
            if (await burst()) { success = true; break }
            if (!sneak) {
              try { bot.setControlState('sneak', true) } catch {}
              if (await burst()) { success = true; break }
            }
            try { bot.setControlState('sneak', false) } catch {}
          }
          await wait(Math.min(300, tickMs))
        } catch { await wait(Math.min(300, tickMs)) }
      }
    } finally {
      try { bot.off('mount', onMount) } catch {}
      // Always release controls and clear following
      try { bot.setControlState('forward', false) } catch {}
      try { bot.setControlState('sneak', false) } catch {}
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    }
    return success ? ok('已乘坐') : fail('乘坐玩家超时')
  }

  // --- Flee trap: move to nearest safe open spot
  function isAir (pos) { try { const b = bot.blockAt(pos); return !b || b.name === 'air' } catch { return false } }
  function isSolid (pos) { try { const b = bot.blockAt(pos); return b && b.name !== 'air' && !b.boundingBox?.includes('empty') } catch { return false } }
  function isSafeFeet (pos) {
    try {
      const feet = pos
      const head = pos.offset(0, 1, 0)
      const under = pos.offset(0, -1, 0)
      if (!isAir(feet) || !isAir(head)) return false
      const b = bot.blockAt(under)
      if (!b) return false
      const nm = String(b.name || '').toLowerCase()
      if (nm.includes('lava')) return false
      return true
    } catch { return false }
  }
  async function flee_trap (args = {}) {
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    const base = bot.entity?.position?.floored?.() || bot.entity?.position
    if (!base) return fail('未就绪')
    const R = Math.max(2, Math.min(8, Number(args.radius || 6)))
    const chatCute = args.cute !== false // default true
    // Be more aggressive about escaping: default do not strike unless explicitly requested
    const doStrike = args.strike === true // only if caller opts in

    function cuteFearLine () {
      const arr = ['呜呜…好可怕(>_<)~', '不要围我啦QAQ', '害怕…我要溜了！', '呀！吓到我了…', '诶诶别这样嘛…']
      return arr[Math.floor(Math.random() * arr.length)]
    }

    function pickThreat (radius = 6) {
      const me = bot.entity?.position
      if (!me) return null
      let best = null; let bestScore = -Infinity
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position) continue
        if (!(e.type === 'player' || e.type === 'mob')) continue
        const d = e.position.distanceTo(me)
        if (!Number.isFinite(d) || d > radius) continue
        // base by distance (closer = higher), plus threat bonus
        let score = 100 - d * 10
        if (e.type === 'player') score += 25
        if (isHostile(e.name || e.displayName)) score += 20
        if (score > bestScore) { bestScore = score; best = e }
      }
      return best
    }
    let target = null; let best = Infinity
    for (let r = 2; r <= R; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const p = base.offset(dx, 0, dz)
          for (let dy = -1; dy <= 2; dy++) {
            const q = p.offset(0, dy, 0)
            if (!isSafeFeet(q)) continue
            const d = q.distanceTo(base)
            if (d < best) { best = d; target = q }
          }
        }
      }
      if (target) break
    }
    if (!target) return fail('附近没有安全空位')
    if (log?.info) log.info('[flee] target spot ->', { x: target.x, y: target.y, z: target.z, dist: target.distanceTo(base).toFixed(2) })

    // Try to exit GSit-like states: dismount, wake, toggle sneak, and jump
    try { if (bot.isSleeping) await bot.wake() } catch {}
    try { if (bot.vehicle) await bot.dismount() } catch {}
    try { bot.clearControlStates() } catch {}
    try { bot.setControlState('sneak', true); await wait(220); bot.setControlState('sneak', false) } catch {}
    try { bot.setControlState('jump', true); await wait(240); bot.setControlState('jump', false) } catch {}

    if (chatCute) { try { bot.chat(cuteFearLine()) } catch {} }

    // Optional: quick strike the most threatening nearby entity, then flee
    if (doStrike) {
      try {
        const foe = pickThreat(Math.min(8, R + 2))
        if (foe) {
          try { await require('./pvp').ensureBestWeapon(bot) } catch {}
          const approachUntil = Date.now() + 900
          if (log?.debug) log.debug('[flee] quick strike ->', foe.name || foe.username || foe.id)
          bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1.8), true)
          while (Date.now() < approachUntil) {
            const cur = bot.entities?.[foe.id]
            if (!cur) break
            const d = cur.position.distanceTo(bot.entity.position)
            if (d <= 2.5) { try { bot.attack(cur) } catch {} ; break }
            await wait(80)
          }
          // stop engaging before fleeing
          try { bot.pathfinder.setGoal(null) } catch {}
          try { require('./pvp').stopMoveOverrides(bot) } catch {}
        }
      } catch {}
    }

    if (log?.info) log.info('[flee] escaping to ->', { x: target.x, y: target.y, z: target.z })
    try { bot.clearControlStates() } catch {}
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1))
    // Aggressive manual assist: face target, sprint+forward with jump pulses for a short burst
    try {
      const toward = target.offset(0.5, 0, 0.5)
      try { await bot.lookAt(toward, true) } catch {}
      bot.setControlState('sprint', true)
      bot.setControlState('forward', true)
      const t0 = Date.now()
      while (Date.now() - t0 < 1600) {
        // periodic hop to get over edges
        if (((Date.now() - t0) % 400) < 60) { bot.setControlState('jump', true) } else { bot.setControlState('jump', false) }
        await wait(60)
      }
    } catch {}
    // Stop manual controls; keep pathfinder goal
    try { bot.setControlState('jump', false); bot.setControlState('forward', false); bot.setControlState('sprint', false) } catch {}
    // Verify motion; if still stuck, nudge again and widen radius once
    try {
      const startPos2 = bot.entity.position.clone()
      await wait(700)
      const moved2 = (() => { try { return bot.entity.position.distanceTo(startPos2) } catch { return 0 } })()
      if (moved2 < 0.2) {
        if (log?.warn) log.warn('[flee] still stuck, nudging again')
        try { await bot.lookAt(target, true) } catch {}
        bot.setControlState('sprint', true)
        bot.setControlState('forward', true)
        await wait(900)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
      }
    } catch {}
    return ok('尝试脱困')
  }

  function isHostile (name) {
    const nm = String(name || '').toLowerCase()
    // Exclude creeper by default (avoid detonations)
    return new Set([
      'zombie','zombie_villager','skeleton','spider','cave_spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma_cube','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden','piglin_brute'
    ]).has(nm)
  }

  // --- Simple hostile culling within a radius ---
  async function cull_hostiles (args = {}) {
    // Start a defend cycle anchored at current position to attack hostiles within radius
    const radius = Math.max(3, parseInt(args.radius || '10', 10))
    const tickMs = Math.max(120, parseInt(args.tickMs || '250', 10))
    return defend_area({ radius, tickMs })
  }

  // Defend a fixed area (anchor = current position). Good for mob farms.
  async function defend_area (args = {}) {
    const { radius = 8, followRange = 3, tickMs = 250 } = args
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true
    m.canDig = (args.dig === true) // 默认不挖掘，防止破坏脚手架/刷怪塔结构
    bot.pathfinder.setMovements(m)
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null }
    // Mark current task for observer/"doing" queries
    try { if (bot.state) bot.state.currentTask = { name: '驻点清怪', source: 'player', startedAt: Date.now() } } catch {}
    let mode = 'follow'
    let currentMobId = null
    // optional ranged plugin support
    let hawkLoaded = false
    try {
      if (!bot.hawkEye) {
        const mod = require('minecrafthawkeye')
        const plug = (mod && mod.default) ? mod.default : mod
        if (typeof plug === 'function') bot.loadPlugin(plug)
      }
      hawkLoaded = !!bot.hawkEye
    } catch {}
    let rangedActive = false

    function invHas (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).some(it => String(it.name||'').toLowerCase() === n) } catch { return false } }
    function invGet (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === n) || null } catch { return null } }
    function pickRangedWeapon () {
      // Require arrows present; prefer crossbow > bow
      if (!invHas('arrow')) return null
      if (invHas('crossbow')) return 'crossbow'
      if (invHas('bow')) return 'bow'
      return null
    }
    function stopRanged () { try { if (rangedActive && bot.hawkEye) bot.hawkEye.stop() } catch {} ; rangedActive = false; rangedStickUntil = 0; unlockHand() }
    async function ensureWeaponEquipped (weapon) {
      try {
        // Respect main-hand lock to avoid stealing hands from tasks (e.g., mining)
        try { if (bot.state && bot.state.holdItemLock) return false } catch {}
        const it = invGet(weapon)
        if (!it) return false
        if (bot.heldItem && String(bot.heldItem.name||'').toLowerCase() === weapon) return true
        await bot.equip(it, 'hand')
        return true
      } catch { return false }
    }
    const anchor = bot.entity?.position?.clone?.() || null

    function resolveGuardEntity () {
      if (!guardTarget) return null
      try {
        const wanted = String(guardTarget).trim().toLowerCase()
        // primary: bot.players map
        for (const [uname, rec] of Object.entries(bot.players || {})) {
          if (String(uname || '').toLowerCase() === wanted) return rec?.entity || null
        }
        // fallback: scan entities of type player with username
        for (const e of Object.values(bot.entities || {})) {
          try { if (e && e.type === 'player' && String(e.username || e.name || '').toLowerCase() === wanted) return e } catch {}
        }
        return null
      } catch { return null }
    }

    function mobName (e) {
      try {
        const raw = e?.name || (e?.displayName && e.displayName.toString && e.displayName.toString()) || ''
        return String(raw).replace(/\u00a7./g, '').toLowerCase()
      } catch { return '' }
    }

    // Helpers: robust hostile detection (align with observer)
    function entityName (e) {
      try { const raw = e?.name || (e?.displayName && e.displayName.toString && e.displayName.toString()) || e?.kind || e?.type || ''; return String(raw).replace(/\u00a7./g, '').toLowerCase() } catch { return '' }
    }
    function isPlayerEntity (e) { try { return String(e?.type || '').toLowerCase() === 'player' } catch { return false } }
    function isHostileName (nm) {
      const s = String(nm || '').toLowerCase()
      if (!s) return false
      const tokens = ['creeper','zombie','zombie_villager','skeleton','spider','cave_spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden','piglin','piglin_brute']
      for (const t of tokens) if (s.includes(t)) return true
      // CN tokens (common)
      const cn = ['苦力怕','僵尸','骷髅','蜘蛛','洞穴蜘蛛','末影人','女巫','史莱姆','溺尸','尸壳','掠夺者','恼鬼','掠夺兽','幻翼','烈焰人','恶魂','岩浆怪','守卫者','远古守卫者','潜影贝','凋灵骷髅','疣猪兽','僵尸疣猪兽','流浪者','蠹虫','唤魔者','卫道士','监守者','猪灵','猪灵蛮兵']
      for (const t of cn) if (s.includes(t)) return true
      return false
    }

    // cycle different aim heights to better hit feet through trapdoors/windows
    const AIM_OFFSETS = [0.2, 0.6, 1.0, 1.2]
    let aimPhase = 0

    guardInterval = setInterval(async () => {
      try {
        // Yield to externally-triggered tools (e.g., mount_player) during execution
        try { if (bot.state && bot.state.externalBusy) return } catch {}
        const centerPos = anchor || bot.entity?.position
        if (!centerPos) return
        // nearest hostile around center
        let nearest = null; let bestD = Infinity; let scanned = 0; let matched = 0
        for (const e of Object.values(bot.entities || {})) {
          try {
            if (!e || !e.position) continue
            if (isPlayerEntity(e)) continue
            const nm = entityName(e)
            scanned++
            if (!isHostileName(nm)) continue
            const d = e.position.distanceTo(centerPos)
            if (!(Number.isFinite(d) && d <= radius)) continue
            matched++
            if (d < bestD) { bestD = d; nearest = e }
          } catch {}
        }
        if ((guardDebug || (bot.state && bot.state.ai && bot.state.ai.trace)) && log?.info) {
          try {
            log.info('[defend] center=', { x: Math.floor(centerPos.x), y: Math.floor(centerPos.y), z: Math.floor(centerPos.z) }, 'scan=', scanned, 'hostiles=', matched, 'nearest=', nearest ? entityName(nearest) : 'none', 'd=', nearest ? bestD.toFixed(1) : '-')
          } catch {}
        }
        if (nearest) {
          const meD = nearest.position.distanceTo(bot.entity.position)
          const weapon = pickRangedWeapon()
          if (hawkLoaded && weapon && meD > 4) {
            try {
              if (!rangedActive || currentMobId !== nearest.id) {
                stopRanged()
                // try to equip weapon explicitly to avoid other modules holding tools
                try { await ensureWeaponEquipped(weapon) } catch {}
                lockHand()
                bot.hawkEye.autoAttack(nearest, weapon)
                rangedActive = true
                currentMobId = nearest.id
                mode = 'ranged'
                rangedStickUntil = Date.now() + 1200
              if ((guardDebug || (bot.state && bot.state.ai && bot.state.ai.trace)) && log?.info) log.info('[defend] ranged ->', weapon, 'mob=', mobName(nearest))
              }
              // keep some distance while ranging
              bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 6), true)
            } catch {}
          } else {
            // honor a brief stickiness after switching to ranged, so the draw can complete
            if (mode === 'ranged' && Date.now() < rangedStickUntil && meD >= 2.6) {
              try { bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 6), true) } catch {}
              return
            }
            // Evaluate reachability; farm模式或不可达时，尝试原地击杀（刷怪塔窗口）
            let reachable = true
            try {
              const testGoal = new goals.GoalFollow(nearest, followRange)
              const res = bot.pathfinder.getPathTo(m, testGoal)
              reachable = !!(res && res.status === 'success')
            } catch {}

            if (!reachable) {
              stopRanged()
              // 原地/小范围守点：若靠得足够近，直接攻击；否则保持在锚点附近
              if (meD <= 3.6) {
                try { require('./pvp').ensureBestWeapon(bot) } catch {}
                // try multiple aim heights (feet -> chest -> head)
                try {
                  const oy = AIM_OFFSETS[aimPhase % AIM_OFFSETS.length]; aimPhase++
                  bot.lookAt(nearest.position.offset(0, oy, 0), true)
                } catch {}
                try { bot.attack(nearest) } catch {}
                mode = 'hold'
                currentMobId = nearest.id
              } else if (anchor) {
                bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z), Math.max(1, followRange)), true)
                mode = 'hold'; currentMobId = null
              }
            } else {
              if (mode !== 'chase' || currentMobId !== nearest.id) {
                stopRanged()
                bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 1.8), true)
                mode = 'chase'; currentMobId = nearest.id
                if ((guardDebug || (bot.state && bot.state.ai && bot.state.ai.trace)) && log?.info) log.info('[defend] chase ->', mobName(nearest))
              }
              if (meD <= 2.8) {
                try { require('./pvp').ensureBestWeapon(bot) } catch {}
                try { bot.lookAt(nearest.position.offset(0, 1.2, 0), true) } catch {}
                try { bot.attack(nearest) } catch {}
              }
            }
          }
        } else {
          stopRanged()
          if (anchor) {
            bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z), Math.max(1, followRange)), true)
            mode = 'hold'; currentMobId = null
            if ((guardDebug || (bot.state && bot.state.ai && bot.state.ai.trace)) && log?.info) log.info('[defend] hold at anchor')
          }
        }
      } catch {}
    }, Math.max(150, tickMs))
    try {
      bot.once('agent:stop_all', () => {
        try { stopRanged() } catch {}
        try { if (bot.state && bot.state.currentTask && bot.state.currentTask.name === '驻点清怪') bot.state.currentTask = null } catch {}
      })
      bot.once('end', () => {
        try { stopRanged() } catch {}
        try { if (guardInterval) clearInterval(guardInterval) } catch {}
        guardInterval = null
      })
      if (typeof registerCleanup === 'function') registerCleanup(() => {
        try { stopRanged() } catch {}
        try { if (guardInterval) clearInterval(guardInterval) } catch {}
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
        guardInterval = null
        try { if (bot.state && bot.state.currentTask && bot.state.currentTask.name === '驻点清怪') bot.state.currentTask = null } catch {}
      })
    } catch {}
    return ok(`开始驻守当前位置 (半径${radius}格)`)
  }

  // Defend a specific player (follow + protect using defend_area heuristics)
  async function defend_player (args = {}) {
    const { name, radius = 8, followRange = 3, tickMs = 250 } = args
    if (!name) return fail('缺少玩家名')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true
    m.canDig = (args.dig === true)
    bot.pathfinder.setMovements(m)
    guardTarget = String(name || '')
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null }
    try { if (bot.state) bot.state.currentTask = { name: '护卫玩家', source: 'player', startedAt: Date.now() } } catch {}
    let mode = 'follow'
    let currentMobId = null
    let hawkLoaded = false
    try {
      if (!bot.hawkEye) {
        const mod = require('minecrafthawkeye')
        const plug = (mod && mod.default) ? mod.default : mod
        if (typeof plug === 'function') bot.loadPlugin(plug)
      }
      hawkLoaded = !!bot.hawkEye
    } catch {}
    let rangedActive = false

    // Local helpers (aligned with defend_area)
    function invHas (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).some(it => String(it.name||'').toLowerCase() === n) } catch { return false } }
    function invGet (nm) { try { const n = String(nm).toLowerCase(); return (bot.inventory?.items()||[]).find(it => String(it.name||'').toLowerCase() === n) || null } catch { return null } }
    function pickRangedWeapon () {
      if (!invHas('arrow')) return null
      if (invHas('crossbow')) return 'crossbow'
      if (invHas('bow')) return 'bow'
      return null
    }
    function stopRanged () { try { if (rangedActive && bot.hawkEye) bot.hawkEye.stop() } catch {} ; rangedActive = false; rangedStickUntil = 0; unlockHand() }
    async function ensureWeaponEquipped (weapon) {
      try {
        if (bot.state && bot.state.holdItemLock) return false
        const it = invGet(weapon)
        if (!it) return false
        if (bot.heldItem && String(bot.heldItem.name||'').toLowerCase() === weapon) return true
        await bot.equip(it, 'hand')
        return true
      } catch { return false }
    }

    function mobName (e) { try { const raw = e?.name || (e?.displayName && e.displayName.toString && e.displayName.toString()) || ''; return String(raw).replace(/\u00a7./g, '').toLowerCase() } catch { return '' } }
    function resolveGuardEntity () {
      try {
        const wanted = String(guardTarget).trim().toLowerCase()
        for (const [uname, rec] of Object.entries(bot.players || {})) { if (String(uname || '').toLowerCase() === wanted) return rec?.entity || null }
        for (const e of Object.values(bot.entities || {})) { try { if (e && e.type === 'player' && String(e.username || e.name || '').toLowerCase() === wanted) return e } catch {} }
        return null
      } catch { return null }
    }

    // cycle different aim heights when hitting through windows
    const AIM_OFFSETS = [0.2, 0.6, 1.0, 1.2]
    let aimPhase = 0

    guardInterval = setInterval(async () => {
      try {
        try { if (bot.state && bot.state.externalBusy) return } catch {}
        const targetEnt = resolveGuardEntity()
        if (!targetEnt) return
        // Follow the player target
        bot.pathfinder.setGoal(new goals.GoalFollow(targetEnt, followRange), true)

        // Search hostiles around the player
        let nearest = null; let bestD = Infinity
        for (const e of Object.values(bot.entities || {})) {
          if (e?.type !== 'mob' || !e.position) continue
          const nm = mobName(e)
          if (!isHostile(nm)) continue
          const d = e.position.distanceTo(targetEnt.position)
          if (d <= radius && d < bestD) { bestD = d; nearest = e }
        }
        if (!nearest) { stopRanged(); return }

        const meD = nearest.position.distanceTo(bot.entity.position)
        const weapon = pickRangedWeapon()
        if (hawkLoaded && weapon && meD > 4) {
          try {
            if (!rangedActive || currentMobId !== nearest.id) {
              stopRanged()
              try { await ensureWeaponEquipped(weapon) } catch {}
              lockHand()
              bot.hawkEye.autoAttack(nearest, weapon)
              rangedActive = true
              currentMobId = nearest.id
              mode = 'ranged'
              rangedStickUntil = Date.now() + 1200
              if (guardDebug && log?.info) log.info('[defend_player] ranged ->', mobName(nearest))
            }
            // keep some distance while ranging
            bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 6), true)
          } catch {}
        } else {
          // honor short stickiness to let the draw complete
          if (mode === 'ranged' && Date.now() < rangedStickUntil && meD >= 2.6) {
            try { bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 6), true) } catch {}
            return
          }
          // Evaluate reachability similar to defend_area
          let reachable = true
          try {
            const testGoal = new goals.GoalFollow(nearest, followRange)
            const res = bot.pathfinder.getPathTo(m, testGoal)
            reachable = !!(res && res.status === 'success')
          } catch {}

          if (!reachable) {
            stopRanged()
            // If close enough, attack in place with varying aim; otherwise keep following the player
            if (meD <= 3.6) {
              try { require('./pvp').ensureBestWeapon(bot) } catch {}
              try { const oy = AIM_OFFSETS[aimPhase % AIM_OFFSETS.length]; aimPhase++; bot.lookAt(nearest.position.offset(0, oy, 0), true) } catch {}
              try { bot.attack(nearest) } catch {}
              mode = 'hold'; currentMobId = nearest.id
            } else {
              bot.pathfinder.setGoal(new goals.GoalFollow(targetEnt, followRange), true)
              mode = 'follow'; currentMobId = null
            }
          } else {
            if (mode !== 'chase' || currentMobId !== nearest.id) {
              stopRanged()
              bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 1.8), true)
              mode = 'chase'; currentMobId = nearest.id
              if (guardDebug && log?.info) log.info('[defend_player] chase ->', mobName(nearest))
            }
            if (meD <= 2.8) {
              try { require('./pvp').ensureBestWeapon(bot) } catch {}
              try { bot.lookAt(nearest.position.offset(0, 1.2, 0), true) } catch {}
              try { bot.attack(nearest) } catch {}
            }
          }
        }
      } catch {}
    }, Math.max(150, tickMs))
    try {
      bot.once('agent:stop_all', () => {
        try { stopRanged() } catch {}
        try { if (bot.state && bot.state.currentTask && bot.state.currentTask.name === '护卫玩家') bot.state.currentTask = null } catch {}
      })
      bot.once('end', () => {
        try { stopRanged() } catch {}
        try { if (guardInterval) clearInterval(guardInterval) } catch {}
        guardInterval = null
      })
      if (typeof registerCleanup === 'function') registerCleanup(() => {
        try { stopRanged() } catch {}
        try { if (guardInterval) clearInterval(guardInterval) } catch {}
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
        guardInterval = null
        try { if (bot.state && bot.state.currentTask && bot.state.currentTask.name === '护卫玩家') bot.state.currentTask = null } catch {}
      })
    } catch {}
    return ok(`开始护卫玩家 ${guardTarget} (半径${radius}格)`)
  }

  // Removed legacy 'guard' tool

  // --- Collect dropped items (pickups) ---
  async function collect (args = {}) {
    const what = String(args.what || 'drops').toLowerCase()
    if (what !== 'drops' && what !== 'items') return fail('未知collect类型')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    const radius = Math.max(1, parseInt(args.radius || '20', 10))
    const max = Math.max(1, parseInt(args.max || '80', 10))
    const timeoutMs = Math.max(1500, parseInt(args.timeoutMs || '12000', 10))
    const until = String(args.until || 'exhaust').toLowerCase()
    const names = Array.isArray(args.names) ? args.names.map(n => String(n).toLowerCase()) : null
    const match = args.match ? String(args.match).toLowerCase() : null

    const t0 = Date.now()
    let picked = 0
    const invSum = () => { try { return (bot.inventory?.items()||[]).reduce((a,b)=>a+(b.count||0),0) } catch { return 0 } }
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
    function itemName (e) { try { return String(e?.item?.name || e?.displayName || e?.name || '').toLowerCase() } catch { return '' } }
    function want (e) {
      const n = itemName(e)
      if (names && n) return names.includes(n)
      if (match && n) return n.includes(match)
      return true
    }
    function nearbyItems () {
      try {
        const me = bot.entity?.position; if (!me) return []
        return Object.values(bot.entities || {}).filter(e => isItemEntity(e) && me.distanceTo(e.position) <= radius && want(e))
      } catch { return [] }
    }

    while (true) {
      if (picked >= max) break
      if (Date.now() - t0 > timeoutMs) break
      let items = nearbyItems()
      if (!items.length) {
        if (until === 'exhaust') break
        await wait(200)
        continue
      }
      items.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      const target = items[0]
      try {
        const before = invSum()
        let success = false
        // Prefer following the entity tightly to ensure collision
        try { bot.pathfinder.setGoal(new goals.GoalFollow(target, 0.35), true) } catch {}
        const untilArrive = Date.now() + 6000
        while (Date.now() < untilArrive) {
          await wait(80)
          const cur = bot.entities?.[target.id]
          if (!cur) { success = true; break } // picked or despawned
          const d = cur.position.distanceTo(bot.entity.position)
          if (d <= 0.5) {
            // micro-nudge forward to guarantee collision
            try { bot.lookAt(cur.position.offset(0, 0.1, 0), true) } catch {}
            try { bot.setControlState('forward', true) } catch {}
            await wait(180)
            try { bot.setControlState('forward', false) } catch {}
          }
          if ((invSum() > before)) { success = true; break }
        }
        try { bot.pathfinder.setGoal(null) } catch {}
        // short settle to let pickups apply
        await wait(150)
        if (!success && (invSum() > before)) success = true
        if (success) picked++
      } catch {}
    }
    return ok(`已拾取附近掉落 (尝试${picked})`)
  }

  // --- Gather resources (high-level wrapper for break_blocks) ---
  async function gather (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '10', 10))
    const height = (args.height != null) ? Math.max(0, parseInt(args.height, 10)) : null
    const names = Array.isArray(args.names) ? args.names.map(n => String(n).toLowerCase()) : null
    const match = args.match ? String(args.match).toLowerCase() : null
    const onlyParam = (() => {
      if (args.only == null) return null
      if (Array.isArray(args.only)) return args.only.map(x => String(x).toLowerCase())
      return String(args.only).toLowerCase()
    })()
    const stacks = args.stacks != null ? Math.max(0, parseInt(args.stacks, 10)) : null
    const count = args.count != null ? Math.max(0, parseInt(args.count, 10)) : null
    const collectDrops = (String(args.collect ?? 'true').toLowerCase() !== 'false')
    if (!names && !match && !onlyParam) return fail('缺少目标')

    // Unified path: if target looks like ore(s), delegate to mining skill
    try {
      const runner = ensureRunner()
      const looksLikeOre = (() => {
        if (onlyParam) return true
        if (names && names.some(isOreNameSimple)) return true
        if (match && (match.includes('_ore') || ['ore','diamond','iron','gold','copper','coal','redstone','lapis','emerald','quartz','debris','netherite'].some(k => match.includes(k)))) return true
        return false
      })()
      if (runner && looksLikeOre) {
        let only = null
        if (onlyParam) {
          if (Array.isArray(onlyParam)) {
            only = onlyParam
          } else {
            only = onlyParam
          }
        } else if (names && names.length) {
          const uniq = new Map()
          for (const n of names) { const tok = oreOnlyToken(n); if (tok) uniq.set(tok, true) }
          only = Array.from(uniq.keys())
        } else if (match) {
          only = [oreOnlyToken(match)]
        }
        // Expected stop condition for simple single-target requests
        let expected = null
        const targetCount = stacks != null ? (stacks * 64) : (count != null ? count : null)
        if (targetCount && only && only.length === 1) {
          const tok = String(only[0])
          const invKey = ({
            diamond: 'diamond', coal: 'coal', redstone: 'redstone', lapis: 'lapis_lazuli', emerald: 'emerald',
            iron: 'raw_iron', gold: 'raw_gold', copper: 'raw_copper', quartz: 'quartz', ancient_debris: 'ancient_debris'
          })[tok]
          if (invKey) expected = `inventory.${invKey} >= ${targetCount}`
        }
        const res = runner.startSkill('mine_ore', { radius: Math.max(4, radius), only: (only && only.length === 1) ? only[0] : only }, expected || null)
        return res.ok ? ok(`矿物采集已启动`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
      }
    } catch {}

    function invSumTargets () {
      try {
        const inv = bot.inventory?.items() || []
        if (names && names.length) {
          const set = new Set(names)
          return inv.filter(it => set.has(String(it.name||'').toLowerCase())).reduce((a,b)=>a+(b.count||0),0)
        }
        if (match) {
          return inv.filter(it => String(it.name||'').toLowerCase().includes(match)).reduce((a,b)=>a+(b.count||0),0)
        }
        return 0
      } catch { return 0 }
    }

    const targetCount = stacks != null ? (stacks * 64) : (count != null ? count : null)
    const before = invSumTargets()
    const area = { shape: 'sphere', radius }
    if (height != null) area.height = height
    const until = (targetCount != null) ? 'all' : (String(args.until || 'exhaust').toLowerCase())
    const br = await break_blocks({ names, match, area, max: Number.MAX_SAFE_INTEGER, until, collect: collectDrops })
    const after = invSumTargets()
    const gained = Math.max(0, after - before)
    if (targetCount != null && gained < targetCount) {
      return ok(`已收集 ${gained}, 低于目标 ${targetCount}`)
    }
    return ok(`已收集 ${gained}`)
  }

  // Alias for AI clarity: pickup == collect
  async function pickup (args = {}) { return collect(args || {}) }

  // --- Placing blocks/items ---
  async function place_blocks (args = {}) {
    const item = String(args.item || '').toLowerCase()
    if (!item) return fail('缺少item')
    const debug = String(args.debug || 'false').toLowerCase() === 'true'
    const on = args.on || { top_of: [] }
    const tops = Array.isArray(on.top_of) ? on.top_of.map(n => String(n).toLowerCase()) : []
    const max = Math.max(1, parseInt(args.max || '8', 10))
    const spacing = Math.max(1, parseInt(args.spacing || '3', 10))
    const collect = (String(args.collect ?? 'false').toLowerCase() === 'true')
    const area = args.area || { shape: 'sphere', radius: 8 }
    const origin = area.origin ? new (require('vec3').Vec3)(area.origin.x, area.origin.y, area.origin.z) : (bot.entity?.position || null)
    if (!origin) return fail('未就绪')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    // default valid bases for saplings
    let baseNames = tops
    if (baseNames.length === 0 && /_sapling$/.test(item)) {
      baseNames = ['dirt','grass_block','podzol','coarse_dirt','rooted_dirt','mud','muddy_mangrove_roots']
    }
    if (baseNames.length === 0) return fail('缺少on.top_of')

    const me = bot.entity.position
    if (debug) try { console.log('[PLACE] item=', item, 'tops=', baseNames, 'radius=', radius, 'me=', `${me.x},${me.y},${me.z}`) } catch {}
    const radius = Math.max(1, parseInt(area.radius || '8', 10))
    let candidates = bot.findBlocks({
      maxDistance: Math.max(2, radius),
      count: 128,
      matching: (b) => {
        if (!b) return false
        const n = String(b.name || '').toLowerCase()
        if (!baseNames.includes(n)) return false
        // top must be air/replaceable
        const pos = b && b.position ? b.position : null
        if (!pos || typeof pos.offset !== 'function') return false
        const top = bot.blockAt(pos.offset(0, 1, 0))
        const tn = String(top?.name || 'air').toLowerCase()
        if (tn === 'air') return true
        if (['tall_grass','short_grass','grass','fern','large_fern','snow','seagrass','dead_bush'].includes(tn)) return true
        return false
      }
    }) || []
    if (debug) try { const c0 = candidates[0]; console.log('[PLACE] candidates=', candidates.length, 'first=', c0 ? `${c0.x},${c0.y},${c0.z}` : 'none') } catch {}
    // Fallback scan if mineflayer findBlocks didn't return candidates
    if (!candidates.length) {
      try {
        const V = require('vec3').Vec3
        const center = me.floored ? me.floored() : new V(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z))
        const r = Math.max(1, radius)
        const extra = []
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dy = -1; dy <= 2; dy++) { // scan slight vertical range to handle raised ground
              const p = new V(center.x + dx, center.y + dy, center.z + dz)
              const b = bot.blockAt(p)
              if (!b) continue
              const n = String(b.name || '').toLowerCase()
              if (!baseNames.includes(n)) continue
              const top = bot.blockAt(p.offset(0, 1, 0))
              const tn = String(top?.name || 'air').toLowerCase()
              const replaceable = (tn === 'air') || ['tall_grass','short_grass','grass','fern','large_fern','snow','seagrass','dead_bush'].includes(tn)
              if (!replaceable) continue
              extra.push(p)
            }
          }
        }
        if (extra.length) {
          candidates = extra
          if (debug) try { console.log('[PLACE] fallback candidates=', candidates.length) } catch {}
        }
      } catch (e) { if (debug) try { console.log('[PLACE] fallback scan error:', e?.message || e) } catch {} }
    }
    if (!candidates.length) return fail('附近没有可放置位置')
    // sort by distance
    candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))

    const placed = []
    let remaining = Math.min(max, countItemByName(item))
    if (remaining <= 0) return fail('背包没有该物品')

    async function approach (p) {
      if (!p) return
      const V = require('vec3').Vec3
      const pv = (p instanceof V) ? p : new V(p.x, p.y, p.z)
      bot.pathfinder.setGoal(new goals.GoalNear(pv.x, pv.y + 1, pv.z, 1), true)
      const until = Date.now() + 5000
      let lastD = Infinity
      let stall = 0
      while (Date.now() < until) {
        await wait(100)
        const me = bot.entity?.position
        if (!me) break
        const d = me.distanceTo(pv.offset(0,1,0))
        if (d <= 1.6) break
        // detect stall
        if (Math.abs(lastD - d) < 0.01) { stall++ } else { stall = 0 }
        lastD = d
        if (stall >= 10) break
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      await wait(50)
    }

    function farEnough (p) { return placed.every(pp => p.distanceTo(pp) >= spacing) }

    function isReplaceable (top) {
      try {
        const tn = String(top?.name || 'air').toLowerCase()
        if (tn === 'air') return true
        if (['tall_grass','short_grass','grass','fern','large_fern','snow','seagrass','dead_bush'].includes(tn)) return true
        return false
      } catch { return false }
    }

    for (const p of candidates) {
      if (remaining <= 0) break
      if (!farEnough(p)) continue
      try {
        if (!p) continue
        const V = require('vec3').Vec3
        const pv = (p instanceof V) ? p : new V(p.x, p.y, p.z)
        const base = bot.blockAt(pv)
        if (!base) continue
        const above = pv.offset(0,1,0)
        const top = bot.blockAt(above)
        if (debug) try { console.log('[PLACE] try at', `${pv.x},${pv.y},${pv.z}`, 'base=', base?.name, 'top=', top?.name) } catch {}
        // Skip if already occupied (sapling/leaf/etc.)
        if (!isReplaceable(top)) continue
        // clear small plants if any
        const tn = String(top?.name || 'air').toLowerCase()
        if (['tall_grass','short_grass','grass','fern','large_fern','snow','seagrass','dead_bush'].includes(tn)) {
          try { if (top?.position) await bot.lookAt(top.position.offset(0.5, 0.5, 0.5), true); await bot.dig(top) } catch {}
        }
        await approach(pv)
        try { await ensureItemEquipped(item) } catch (e) { return fail(String(e?.message || e)) }
        try {
          // re-check top right before placing (might have changed)
          const top2 = bot.blockAt(pv.offset(0,1,0))
          if (!isReplaceable(top2)) continue
          await bot.lookAt(pv.offset(0.5, 1.2, 0.5), true)
          await bot.placeBlock(base, new (require('vec3').Vec3)(0, 1, 0))
          placed.push(pv)
          remaining--
          if (debug) try { console.log('[PLACE] placed at', `${pv.x},${pv.y+1},${pv.z}`) } catch {}
          if (collect) { try { bot.pathfinder.setGoal(new goals.GoalNear(pv.x, pv.y + 1, pv.z, 0), true) } catch {}; await wait(200) }
        } catch (e) {
          // try once more after a tiny nudge
          try { await bot.lookAt(pv.offset(0.5, 1.0, 0.5), true) } catch {}
          try { await bot.placeBlock(base, new (require('vec3').Vec3)(0, 1, 0)); placed.push(pv); remaining--; if (debug) try { console.log('[PLACE] placed (retry) at', `${pv.x},${pv.y+1},${pv.z}`) } catch {} } catch (e2) { if (debug) try { console.log('[PLACE] place failed:', e2?.message || e2) } catch {} }
        }
      } catch (e) {
        if (debug) try { console.log('[PLACE] attempt error:', e?.message || e) } catch {}
        // swallow and continue to next candidate
      }
    }
    if (placed.length === 0) return fail('未能放置任何方块')
    return ok(`已放置 ${item} x${placed.length}`)
  }

  // --- Start or move to auto fishing ---
  async function autofish (args = {}) {
    const radius = Math.max(3, parseInt(args.radius || '10', 10))
    const debug = String(args.debug || '').toLowerCase() === 'true'
    const S = bot.state?.autoFish || (bot.state ? (bot.state.autoFish = {}) : {})
    S.cfg = Object.assign({ enabled: true, tickMs: 8000, radius }, S.cfg || {})
    S.cfg.radius = radius
    if (debug) S.cfg.debug = true

    function isNearbyWaterPos (p) {
      try {
        const n = String(bot.blockAt(p)?.name || '').toLowerCase()
        if (n.includes('water')) return true
        const props = bot.blockAt(p)?.getProperties?.()
        return props && props.waterlogged === true
      } catch { return false }
    }
    function canStandOn (p) {
      try {
        const ground = bot.blockAt(p)
        if (!ground) return false
        const gname = String(ground.name || '').toLowerCase()
        if (!gname || gname === 'air' || gname.includes('water') || gname.includes('lava')) return false
        const feet = bot.blockAt(p.offset(0, 1, 0))
        const head = bot.blockAt(p.offset(0, 2, 0))
        const feetEmpty = (!feet || String(feet.name || '') === 'air')
        const headEmpty = (!head || String(head.name || '') === 'air')
        return feetEmpty && headEmpty
      } catch { return false }
    }
    function findFishingSpot (r) {
      try {
        const me = bot.entity?.position; if (!me) return null
        const waterBlocks = bot.findBlocks({ matching: (b) => b && (String(b.name||'').toLowerCase().includes('water') || (b.getProperties && b.getProperties()?.waterlogged === true)), maxDistance: Math.max(3, r), count: 100 }) || []
        if (!waterBlocks.length) return null
        const { Vec3 } = require('vec3')
        let best = null; let bestD = Infinity
        for (const wb of waterBlocks) {
          const adj = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)].map(d => wb.offset(d.x, 0, d.z))
          for (const p of adj) {
            if (!canStandOn(p)) continue
            const d = p.offset(0,1,0).distanceTo(me)
            if (d < bestD) { best = p; bestD = d }
          }
        }
        return best
      } catch { return null }
    }

    const spot = findFishingSpot(radius)
    if (!spot) return fail('附近没有可垂钓的水域')
    if (!ensurePathfinder()) return fail('无寻路')
    const { goals } = pathfinderPkg
    bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y + 1, spot.z, 0), true)
    const until = Date.now() + 8000
    while (Date.now() < until) { await wait(80); const me = bot.entity?.position; if (!me) break; if (me.distanceTo(spot.offset(0,1,0)) <= 1.5) break }
    try { bot.pathfinder.setGoal(null) } catch {}

    try { bot.emit('autofish:now') } catch {}
    return ok('开始自动钓鱼')
  }

  // --- Deposit items into nearest chest/barrel ---
  async function deposit (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '18', 10))
    const includeBarrel = !(String(args.includeBarrel || 'true').toLowerCase() === 'false')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = false; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    function isContainerName (n) {
      const s = String(n || '').toLowerCase()
      if (s === 'chest' || s === 'trapped_chest') return true
      if (includeBarrel && s === 'barrel') return true
      return false
    }

    const me = bot.entity?.position
    if (!me) return fail('未就绪')
    const blocks = bot.findBlocks({ matching: (b) => b && isContainerName(b.name), maxDistance: Math.max(2, radius), count: 32 }) || []
    if (!blocks.length) return fail('附近没有箱子')
    blocks.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const target = blocks[0]

    // Approach
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1), true)
    const until = Date.now() + 6000
    while (Date.now() < until) {
      await wait(100)
      const d = bot.entity.position.distanceTo(target)
      if (d <= 2.2) break
    }
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    await wait(60)

    // Open container
    const { Vec3 } = require('vec3')
    const blk = bot.blockAt(new Vec3(target.x, target.y, target.z))
    if (!blk) return fail('箱子不可见')
    try { await bot.lookAt(blk.position.offset(0.5, 0.5, 0.5), true) } catch {}
    let container = null
    try { container = await bot.openContainer(blk) } catch (e) { return fail('无法打开箱子: ' + (e?.message || e)) }

    function itemFromSlot (slot) {
      const key = String(slot).toLowerCase()
      if (key === 'hand' || key === 'main' || key === 'mainhand') return bot.heldItem || null
      if (key === 'offhand' || key === 'off-hand' || key === 'off_hand') return bot.inventory?.slots?.[45] || null
      const idx = parseInt(String(slot), 10)
      if (Number.isFinite(idx) && bot.inventory?.slots) return bot.inventory.slots[idx] || null
      return null
    }

    // Build items list similar to toss interface
    const arr = (() => {
      if (Array.isArray(args.items) && args.items.length) return args.items
      if (Array.isArray(args.names) && args.names.length) return args.names.map(n => ({ name: n }))
      if (args.name) return [{ name: args.name, count: args.count }]
      if (args.slot) return [{ slot: args.slot, count: args.count }]
      return null
    })()

    let kinds = 0
    let total = 0
    try {
      if ((!arr || !arr.length) && (args.all === true || String(args.all).toLowerCase() === 'true')) {
        // Modes: by default keep equipped armor and current hands; override via keepEquipped/keepHeld/keepOffhand=false
        const keepEquipped = (args.keepEquipped === undefined) ? true : !(args.keepEquipped === false)
        const keepHeld = (args.keepHeld === undefined) ? true : !(args.keepHeld === false)
        const keepOffhand = (args.keepOffhand === undefined) ? true : !(args.keepOffhand === false)
        // Deposit all inventory stacks (items() excludes armor/offhand/held)
        const items = (bot.inventory?.items() || []).slice()
        for (const it of items) {
          const cnt = it?.count || 0
          if (cnt <= 0) continue
          try { await container.deposit(it.type, it.metadata, cnt, it.nbt); kinds++; total += cnt } catch {}
        }
        if (!keepOffhand) { try { const off = bot.inventory?.slots?.[45]; if (off && off.count > 0) { await container.deposit(off.type, off.metadata, off.count, off.nbt); kinds++; total += (off.count||0) } } catch {} }
        if (!keepHeld) { try { const h = bot.heldItem; if (h && h.count > 0) { await container.deposit(h.type, h.metadata, h.count, h.nbt); kinds++; total += (h.count||0) } } catch {} }
        if (!keepEquipped) {
          try {
            const slots = bot.inventory?.slots || []
            for (const idx of [5,6,7,8]) {
              const it = slots[idx]
              const c = it?.count || 0
              if (it && c > 0) { try { await container.deposit(it.type, it.metadata, c, it.nbt); kinds++; total += c } catch {} }
            }
          } catch {}
        }
      } else if (arr && arr.length) {
        for (const spec of arr) {
          const cnt = (spec && spec.count != null) ? Math.max(0, Number(spec.count)) : null
          if (spec.slot) {
            const it = itemFromSlot(spec.slot)
            if (!it) continue
            const n = cnt != null ? Math.min(cnt, it.count || 0) : (it.count || 0)
            if (n > 0) { try { await container.deposit(it.type, it.metadata, n, it.nbt); kinds++; total += n } catch {} }
            continue
          }
          const nm = spec?.name
          if (!nm) continue
          const list = (bot.inventory?.items() || []).filter(x => String(x?.name || '').toLowerCase() === String(nm).toLowerCase())
          if (!list.length) continue
          if (cnt != null) {
            const it = list[0]
            const n = Math.min(cnt, it.count || 0)
            if (n > 0) { try { await container.deposit(it.type, it.metadata, n, it.nbt); kinds++; total += n } catch {} }
          } else {
            for (const it of list) { const c = it.count || 0; if (c > 0) { try { await container.deposit(it.type, it.metadata, c, it.nbt); kinds++; total += c } catch {} } }
          }
        }
      } else {
        return fail('缺少物品参数（或指定 all=true）')
      }
    } finally { try { container.close() } catch {} }
    if (kinds <= 0) return fail('没有可存放的物品')
    return ok(`已经把东西塞进箱子啦~ 共${kinds}种${total}个`)
  }

  // Back-compat alias for previous API
  async function deposit_all (args = {}) { return deposit({ ...args, all: true }) }

  // --- Withdraw items from nearest (or multiple) chest/barrel ---
  async function withdraw (args = {}) {
    const radius = Math.max(2, parseInt(args.radius || '18', 10))
    const includeBarrel = !(String(args.includeBarrel || 'true').toLowerCase() === 'false')
    const multi = (String(args.multi || args.searchAll || 'true').toLowerCase() !== 'false')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = false; m.allowSprinting = true
    bot.pathfinder.setMovements(m)

    function isContainerName (n) {
      const s = String(n || '').toLowerCase()
      if (s === 'chest' || s === 'trapped_chest') return true
      if (includeBarrel && s === 'barrel') return true
      return false
    }

    const me = bot.entity?.position
    if (!me) return fail('未就绪')
    const blocks = bot.findBlocks({ matching: (b) => b && isContainerName(b.name), maxDistance: Math.max(2, radius), count: 48 }) || []
    if (!blocks.length) return fail('附近没有箱子')
    blocks.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))

    // Build spec list similar to toss/deposit interface
    const specs = (() => {
      if (Array.isArray(args.items) && args.items.length) return args.items
      if (Array.isArray(args.names) && args.names.length) return args.names.map(n => ({ name: n }))
      if (args.name) return [{ name: args.name, count: args.count }]
      if (args.slot != null) return [{ slot: args.slot, count: args.count }]
      return []
    })()

    const takeAll = ((!specs || specs.length === 0) && (args.all === true || String(args.all).toLowerCase() === 'true'))

    let kinds = 0
    let total = 0
    const { Vec3 } = require('vec3')

    function fromContainerSlots (container) {
      const res = []
      try {
        const invStart = container.inventoryStart || 0
        const end = Math.max(0, invStart)
        for (let i = 0; i < end; i++) {
          const it = container.slots?.[i]
          if (it && it.count > 0) res.push(it)
        }
      } catch {}
      return res
    }

    function matchesName (it, nm) { return String(it?.name || '').toLowerCase() === String(nm || '').toLowerCase() }

    // Helper to approach and open a container block (Vec3)
    async function openAt (pos) {
      bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1), true)
      const until = Date.now() + 6000
      while (Date.now() < until) { await wait(100); const d = bot.entity.position.distanceTo(pos); if (d <= 2.2) break }
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      await wait(60)
      const blk = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!blk) return null
      try { await bot.lookAt(blk.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try { return await bot.openContainer(blk) } catch { return null }
    }

    // If taking all: just use nearest container
    if (takeAll) {
      const target = blocks[0]
      let container = await openAt(target)
      if (!container) return fail('无法打开箱子')
      try {
        const list = fromContainerSlots(container)
        for (const it of list) {
          const cnt = it.count || 0
          if (cnt <= 0) continue
          try { await container.withdraw(it.type, it.metadata, cnt, it.nbt); kinds++; total += cnt } catch {}
        }
      } finally { try { container.close() } catch {} }
      if (kinds <= 0) return fail('箱子里没有可取的物品')
      return ok(`已经把箱子里的东西都取出来啦~ 共${kinds}种${total}个`)
    }

    // Named/slot-based withdrawal, possibly across multiple containers
    const want = specs.map(s => ({ name: s.name ? String(s.name).toLowerCase() : null, count: (s.count == null ? null : Math.max(0, Number(s.count))), slot: s.slot }))
    // Track remaining counts by name; null means unlimited
    const remainByName = new Map()
    for (const s of want) {
      if (!s || !s.name) continue
      const key = s.name
      const add = (s.count == null) ? Infinity : Math.max(0, Number(s.count))
      const cur = remainByName.has(key) ? remainByName.get(key) : 0
      const next = (cur === Infinity || add === Infinity) ? Infinity : (cur + add)
      remainByName.set(key, next)
    }

    for (let i = 0; i < blocks.length; i++) {
      const pos = blocks[i]
      let container = await openAt(pos)
      if (!container) continue
      try {
        const list = fromContainerSlots(container)
        // Slot-specific (container slot index) support is rare; we focus on names
        for (const it of list) {
          if (!it || it.count <= 0) continue
          // Try each desired name
          for (const [nm, rem0] of remainByName.entries()) {
            if (rem0 <= 0) continue
            if (!matchesName(it, nm)) continue
            const take = Math.min(rem0, it.count || 0)
            if (take <= 0) continue
            try { await container.withdraw(it.type, it.metadata, take, it.nbt); kinds++; total += take; remainByName.set(nm, rem0 - take) } catch {}
          }
        }
      } finally { try { container.close() } catch {} }
      // Stop early if all satisfied
      let done = true
      for (const v of remainByName.values()) { if (v > 0) { done = false; break } }
      if (done) break
      if (!multi) break
    }

    if (kinds <= 0) return fail('没有取到物品')
    return ok(`已取出${kinds}种${total}个`)
  }

  async function withdraw_all (args = {}) { return withdraw({ ...args, all: true }) }

  const registry = { goto, goto_block, follow_player, reset, stop, stop_all, say, hunt_player, defend_area, defend_player, equip, toss, break_blocks, place_blocks, collect, pickup, gather, harvest, cull_hostiles, mount_near, mount_player, dismount, flee_trap, observe_detail, deposit, deposit_all, withdraw, withdraw_all, autofish, mine_ore, write_text, range_attack, skill_start, skill_status, skill_cancel }

  async function run (tool, args) {
    const fn = registry[tool]
    if (!fn) return { ok: false, msg: '未知工具' }
    try { return await fn(args || {}) } catch (e) { return { ok: false, msg: String(e?.message || e) } }
  }

  function list () { return Object.keys(registry) }

  return { run, list }
}

module.exports = { install }
