// Whitelisted game actions for AI/tool use

let huntInterval = null
let huntTarget = null
let guardInterval = null
let guardTarget = null
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
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range))
    return ok(`前往 ${x},${y},${z}`)
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
    const mode = String(args.mode || 'soft').toLowerCase()
    // soft stop: pause ongoing movement/loops
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { pvp.stopMoveOverrides(bot) } catch {}
    miningAbort = true
    if (huntInterval) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; huntTarget = null }
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null; guardTarget = null }
    if (mode === 'hard' || mode === 'reset' || mode === 'all') {
      try { bot.emit('agent:stop_all') } catch {}
      try { if (typeof bot.stopDigging === 'function') bot.stopDigging() } catch {}
      try { if (bot.isSleeping) await bot.wake() } catch {}
      try { if (bot.vehicle) await bot.dismount() } catch {}
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
      try { if (bot.entity && bot.entity.position) bot.lookAt(bot.entity.position, true) } catch {}
      try { if (bot.state) bot.state.autoLookSuspended = false } catch {}
      return ok('已重置 (hard stop)')
    }
    return ok('已暂停 (soft stop)')
  }

  // Back-compat alias; not advertised to AI
  async function stop_all () { return stop({ mode: 'hard' }) }

  async function say (args = {}) {
    const { text } = args
    if (!text) return fail('缺少内容')
    try { bot.chat(String(text).slice(0, 120)) } catch {}
    return ok('已发送')
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
    huntInterval = setInterval(() => {
      try {
        if (durationMs != null && (Date.now() - startedAt) > Number(durationMs)) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; return }
        const ent = bot.players[huntTarget]?.entity
        if (!ent) return
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
        try { pvp.pvpTick(bot, ent, ctx) } catch {}
      } catch {}
    }, Math.max(150, tickMs))
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
      posList.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
      let did = false
      for (const p of posList) {
        if (await approachAndDig(p)) { broken++; did = true; break }
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
    return ok(`挖掘完成 ${broken}`)
  }

  // --- Harvest: break -> collect -> deposit selected items into nearest container ---
  async function harvest (args = {}) {
    const area = args.area || { radius: Math.max(3, parseInt(args.radius || '10', 10)) }
    const radius = Math.max(3, parseInt(area.radius || '10', 10))
    let names = Array.isArray(args.names) ? args.names.map(n => String(n).toLowerCase()) : null
    let match = args.match ? String(args.match).toLowerCase() : null
    const includeBarrel = !(String(args.includeBarrel || 'true').toLowerCase() === 'false')
    const depositRadius = Math.max(2, parseInt(args.depositRadius || String(Math.max(16, radius)), 10))

    // Resource presets for simpler AI usage
    const resource = String(args.resource || '').toLowerCase()
    function applyResource (r) {
      if (!r) return
      if (r === 'logs' || r === 'log' || r === '原木' || r === '树木' || r === '树') { match = 'log'; return }
      if (r === 'sand' || r === '沙' || r === '沙子') { names = ['sand']; return }
      if (r === 'stone' || r === '原石' || r === '石头') { match = 'stone'; return }
      if (r === 'gravel' || r === '沙砾' || r === '砾石') { names = ['gravel']; return }
      if (r === 'dirt' || r === '泥土') { names = ['dirt']; return }
    }
    if (!names && !match) applyResource(resource)
    if (!names && !match) return fail('缺少目标')

    // 1) break blocks until exhausted in area
    const br = await break_blocks({ names, match, area: { shape: 'sphere', radius: radius, height: area.height }, max: Number.MAX_SAFE_INTEGER, until: 'exhaust', collect: true })
    // 2) collect nearby drops (filtered by names/match)
    const collectArgs = { what: 'drops', radius: Math.max(radius, 12), timeoutMs: 6000, until: 'exhaust' }
    if (names && names.length) collectArgs.names = names
    if (!names && match) collectArgs.match = match
    try { await collect(collectArgs) } catch {}

    // 3) deposit target items into nearest chest/barrel
    // Build items list based on current inventory
    const inv = bot.inventory?.items() || []
    let items = []
    if (names && names.length) {
      const set = new Set(names)
      const uniq = new Map()
      for (const it of inv) { const n = String(it?.name || '').toLowerCase(); if (set.has(n)) uniq.set(n, true) }
      items = Array.from(uniq.keys()).map(n => ({ name: n }))
    } else if (match) {
      const uniq = new Map()
      for (const it of inv) { const n = String(it?.name || '').toLowerCase(); if (n.includes(match)) uniq.set(n, true) }
      items = Array.from(uniq.keys()).map(n => ({ name: n }))
    }
    if (!items.length) return ok((br && br.msg) ? (br.msg + '（无可存放）') : '完成（无可存放）')
    const dep = await deposit({ items, radius: depositRadius, includeBarrel })
    return ok(`${(br && br.msg) ? br.msg : '处理完成'}，${dep && dep.msg ? dep.msg : '已存放'}`)
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
    if (bot.vehicle) return ok('已在乘坐中')
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

  async function guard (args = {}) {
    const { name = '', radius = 8, followRange = 3, tickMs = 250 } = args
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = true
    bot.pathfinder.setMovements(m)
    guardTarget = String(name || '')
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null }
    let mode = 'follow'
    let currentMobId = null
    // optional ranged plugin support
    let hawkLoaded = false
    try { if (!bot.hawkEye) { bot.loadPlugin(require('minecrafthawkeye')) }; hawkLoaded = !!bot.hawkEye } catch {}
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
    function stopRanged () { try { if (rangedActive && bot.hawkEye) bot.hawkEye.stop() } catch {} ; rangedActive = false }
    async function ensureWeaponEquipped (weapon) {
      try {
        const it = invGet(weapon)
        if (!it) return false
        if (bot.heldItem && String(bot.heldItem.name||'').toLowerCase() === weapon) return true
        await bot.equip(it, 'hand')
        return true
      } catch { return false }
    }
    // Anchor point when guarding a position (no name provided)
    const anchor = (!guardTarget ? (bot.entity?.position?.clone?.() || null) : null)

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

    guardInterval = setInterval(async () => {
      try {
        const targetEnt = resolveGuardEntity()
        const centerPos = targetEnt ? targetEnt.position : (anchor || bot.entity?.position)
        if (!centerPos) return
        // nearest hostile around center
        let nearest = null; let bestD = Infinity
        for (const e of Object.values(bot.entities || {})) {
          if (e?.type !== 'mob' || !e.position) continue
          const nm = mobName(e)
          if (!isHostile(nm)) continue
          const d = e.position.distanceTo(centerPos)
          if (d <= radius && d < bestD) { bestD = d; nearest = e }
        }
        if (guardDebug && log?.info) {
          try {
            log.info('[guard] center=', { x: Math.floor(centerPos.x), y: Math.floor(centerPos.y), z: Math.floor(centerPos.z) }, 'nearest=', nearest ? mobName(nearest) : 'none', 'd=', nearest ? bestD.toFixed(1) : '-')
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
                bot.hawkEye.autoAttack(nearest, weapon)
                rangedActive = true
                currentMobId = nearest.id
                mode = 'ranged'
                if (guardDebug && log?.info) log.info('[guard] ranged ->', weapon, 'mob=', mobName(nearest))
              }
              // keep some distance while ranging
              bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 6), true)
            } catch {}
          } else {
            if (mode !== 'chase' || currentMobId !== nearest.id) {
              stopRanged()
              bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 1.8), true)
              mode = 'chase'; currentMobId = nearest.id
              if (guardDebug && log?.info) log.info('[guard] chase ->', mobName(nearest))
            }
            if (meD <= 2.8) {
              try { require('./pvp').ensureBestWeapon(bot) } catch {}
              try { bot.lookAt(nearest.position.offset(0, 1.2, 0), true) } catch {}
              try { bot.attack(nearest) } catch {}
            }
          }
        } else {
          stopRanged()
          if (targetEnt) {
            // always refresh follow goal to ensure we keep up
            bot.pathfinder.setGoal(new goals.GoalFollow(targetEnt, followRange), true)
            mode = 'follow'; currentMobId = null
            if (guardDebug && log?.info) log.info('[guard] follow ->', String(guardTarget))
          } else if (anchor) {
            bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z), Math.max(1, followRange)), true)
            mode = 'hold'; currentMobId = null
            if (guardDebug && log?.info) log.info('[guard] hold at anchor')
          }
        }
      } catch {}
    }, Math.max(150, tickMs))
    try { bot.once('agent:stop_all', stopRanged) } catch {}
    return ok(guardTarget ? `开始护卫玩家 ${guardTarget} (半径${radius}格)` : `开始驻守当前位置 (半径${radius}格)`)
  }

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
    const stacks = args.stacks != null ? Math.max(0, parseInt(args.stacks, 10)) : null
    const count = args.count != null ? Math.max(0, parseInt(args.count, 10)) : null
    const collectDrops = (String(args.collect ?? 'true').toLowerCase() !== 'false')
    if (!names && !match) return fail('缺少目标')

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
    const radius = Math.max(2, parseInt(args.radius || '16', 10))
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
        // Deposit all inventory stacks
        const items = (bot.inventory?.items() || []).slice()
        for (const it of items) {
          const cnt = it?.count || 0
          if (cnt <= 0) continue
          try { await container.deposit(it.type, it.metadata, cnt, it.nbt); kinds++; total += cnt } catch {}
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

  function guard_debug (args = {}) { guardDebug = !(String(args.enabled ?? args.on ?? 'on').toLowerCase() === 'off'); return ok('guard debug=' + guardDebug) }

  const registry = { goto, follow_player, stop, stop_all, say, hunt_player, guard, guard_debug, equip, toss, break_blocks, place_blocks, collect, pickup, gather, harvest, mount_near, dismount, flee_trap, observe_detail, deposit, deposit_all, autofish, skill_start, skill_status, skill_cancel }

  async function run (tool, args) {
    const fn = registry[tool]
    if (!fn) return { ok: false, msg: '未知工具' }
    try { return await fn(args || {}) } catch (e) { return { ok: false, msg: String(e?.message || e) } }
  }

  function list () { return Object.keys(registry) }

  return { run, list }
}

module.exports = { install }
