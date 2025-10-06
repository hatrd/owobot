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
      ['镐', 'pickaxe']
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
    const max = Math.max(1, parseInt(args.max || '12', 10))
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
      while (!miningAbort && broken < Math.min(max, steps)) {
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

    while (!miningAbort && broken < max) {
      const posList = bot.findBlocks({
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
    }
    return ok(`挖掘完成 ${broken}`)
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
    return new Set(['creeper','zombie','skeleton','spider','enderman','witch','slime','drowned','husk','pillager','vex','ravager','phantom','blaze','ghast','magma_cube','guardian','elder_guardian','shulker','wither_skeleton','hoglin','zoglin','stray','silverfish','evoker','vindicator','warden']).has(nm)
  }

  async function guard (args = {}) {
    const { name, radius = 8, followRange = 3, tickMs = 250 } = args
    if (!name) return fail('缺少玩家名')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = true
    bot.pathfinder.setMovements(m)
    guardTarget = String(name)
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null }
    let mode = 'follow'
    let currentMobId = null
    guardInterval = setInterval(() => {
      try {
        const targetEnt = bot.players[guardTarget]?.entity
        if (!targetEnt) return
        // nearest hostile around target player
        let nearest = null; let bestD = Infinity
        for (const e of Object.values(bot.entities || {})) {
          if (e?.type !== 'mob' || !e.position || !isHostile(e.name || e.displayName)) continue
          const d = e.position.distanceTo(targetEnt.position)
          if (d <= radius && d < bestD) { bestD = d; nearest = e }
        }
        if (nearest) {
          if (mode !== 'chase' || currentMobId !== nearest.id) {
            bot.pathfinder.setGoal(new goals.GoalFollow(nearest, 1.8), true)
            mode = 'chase'; currentMobId = nearest.id
          }
          const meD = nearest.position.distanceTo(bot.entity.position)
          if (meD <= 2.3) {
            try { bot.lookAt(nearest.position.offset(0, 1.2, 0), true) } catch {}
            try { bot.attack(nearest) } catch {}
          }
        } else {
          if (mode !== 'follow') {
            bot.pathfinder.setGoal(new goals.GoalFollow(targetEnt, followRange), true)
            mode = 'follow'; currentMobId = null
          }
        }
      } catch {}
    }, Math.max(150, tickMs))
    return ok(`开始护卫 ${guardTarget} (半径${radius}格)`)
  }

  const registry = { goto, follow_player, stop, stop_all, say, hunt_player, guard, equip, toss, break_blocks, mount_near, dismount, flee_trap, observe_detail, skill_start, skill_status, skill_cancel }

  async function run (tool, args) {
    const fn = registry[tool]
    if (!fn) return { ok: false, msg: '未知工具' }
    try { return await fn(args || {}) } catch (e) { return { ok: false, msg: String(e?.message || e) } }
  }

  function list () { return Object.keys(registry) }

  return { run, list }
}

module.exports = { install }
