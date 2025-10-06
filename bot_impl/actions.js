// Whitelisted game actions for AI/tool use

let huntInterval = null
let huntTarget = null
let guardInterval = null
let guardTarget = null
let miningAbort = false

function install (bot, { log, on, registerCleanup }) {
  const pvp = require('./pvp')
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

  async function stop () {
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { pvp.stopMoveOverrides(bot) } catch {}
    miningAbort = true
    if (huntInterval) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; huntTarget = null }
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null; guardTarget = null }
    return ok('已停止')
  }

  async function stop_all () {
    await stop()
    try { bot.emit('agent:stop_all') } catch {}
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    return ok('已停止所有任务')
  }

  async function say (args = {}) {
    const { text } = args
    if (!text) return fail('缺少内容')
    try { bot.chat(String(text).slice(0, 120)) } catch {}
    return ok('已发送')
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
    const { name, count = null } = args
    if (!name) return fail('缺少物品名')
    const items = findAllByName(name)
    if (!items || items.length === 0) return fail('背包没有该物品')
    if (count != null) {
      // Toss exactly count from the first matching stack
      const it = items[0]
      await bot.toss(it.type, null, Number(count))
      return ok(`已丢出 ${it.name} x${count}`)
    }
    // Toss all stacks of that item
    let total = 0
    for (const it of items) {
      const c = it.count || 0
      if (c > 0) {
        await bot.toss(it.type, null, c)
        total += c
      }
    }
    return ok(`已丢出 ${normalizeName(name)} x${total}`)
  }

  async function toss_hand () {
    const it = bot.heldItem
    if (!it) return fail('当前未手持物品')
    await bot.toss(it.type, null, it.count)
    return ok(`已丢出手持 ${it.name} x${it.count}`)
  }

  async function attack_player (args = {}) {
    const { name, timeoutMs = 6000 } = args
    if (!name) return fail('缺少玩家名')
    const rec = bot.players[name]
    const ent = rec?.entity
    if (!ent) return fail('未找到玩家')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.allowSprinting = true; m.canDig = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1.8), true)
    const ctx = {}
    const start = Date.now()
    return await new Promise((resolve) => {
      const iv = setInterval(() => {
        const e = bot.players[name]?.entity
        if (!e) { clearInterval(iv); try { pvp.stopMoveOverrides(bot) } catch {}; resolve(fail('目标消失')) ; return }
        try { pvp.pvpTick(bot, e, ctx) } catch {}
        if (Date.now() - start > timeoutMs) { clearInterval(iv); try { pvp.stopMoveOverrides(bot) } catch {}; resolve(ok('攻击已尝试')) }
      }, 150)
    })
  }

  async function hunt_player (args = {}) {
    const { name, range = 1.8, tickMs = 250 } = args
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
    huntInterval = setInterval(() => {
      try {
        const ent = bot.players[huntTarget]?.entity
        if (!ent) return
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
        try { pvp.pvpTick(bot, ent, ctx) } catch {}
      } catch {}
    }, Math.max(150, tickMs))
    return ok(`开始追击 ${huntTarget}`)
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
    const { maxSteps = 16 } = args
    miningAbort = false
    const toolSel = require('./tool-select')
    let done = 0
    while (!miningAbort && done < maxSteps) {
      try {
        if (!bot.entity || !bot.entity.position) break
        if (isDangerBelow()) return ok(`停止: 下方疑似岩浆, 已下挖 ${done} 格`)
        const feet = bot.entity.position.offset(0, -1, 0)
        const target = bot.blockAt(feet)
        if (!target) break
        try { await toolSel.ensureBestToolForBlock(bot, target) } catch {}
        await bot.lookAt(feet.offset(0.5, 0.5, 0.5), true)
        await bot.dig(target)
        const startY = Math.floor(bot.entity.position.y)
        const until = Date.now() + 1500
        while (Date.now() < until) {
          await wait(50)
          const y = Math.floor(bot.entity.position.y)
          if (y < startY) break
        }
        done++
      } catch (e) {
        if (String(e?.message || e).includes('not currently diggable')) { await wait(150); continue }
        break
      }
    }
    return ok(`向下挖掘完成，共 ${done} 格`)
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
    const { target = 'any', radius = 12, maxBlocks = 12 } = args
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    miningAbort = false
    const toolSel = require('./tool-select')
    const wanted = String(target || 'any').toLowerCase().trim()
    const ores = oreNamesSet()

    let mined = 0
    while (!miningAbort && mined < maxBlocks) {
      try {
        const me = bot.entity?.position
        if (!me) break
        const posList = bot.findBlocks({
          maxDistance: Math.max(4, radius),
          count: 64,
          matching: (b) => {
            if (!b) return false
            const n = String(b.name || '').toLowerCase()
            if (!ores.has(n)) return false
            if (wanted !== 'any' && !n.includes(wanted)) return false
            return true
          }
        }) || []
        if (!posList || posList.length === 0) return ok(`附近 ${radius} 格没有目标矿物`)
        // pick nearest
        posList.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        let dugOne = false
        for (const p of posList) {
          if (miningAbort) break
          try {
            bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1), true)
            // wait until close or timeout
            const until = Date.now() + 6000
            while (Date.now() < until) {
              await wait(120)
              const d = bot.entity.position.distanceTo(p)
              if (d <= 2.2) break
            }
            const block = bot.blockAt(p)
            if (!block) continue
            try { await toolSel.ensureBestToolForBlock(bot, block) } catch {}
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
            await bot.dig(block)
            mined++
            dugOne = true
            break
          } catch {}
        }
        if (!dugOne) return ok(`未能到达矿物，已挖 ${mined}`)
      } catch { break }
    }
    return ok(`自动挖矿完成，挖到 ${mined} 块矿物`)
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
    const me = bot.entity?.position
    if (!me) return fail('未就绪')
    // Already mounted
    if (bot.vehicle) return ok('已在乘坐中')
    // Pick target
    let target = null; let bestD = Infinity
    for (const e of Object.values(bot.entities || {})) {
      if (!isRideableEntity(e)) continue
      const d = e.position.distanceTo(me)
      if (d > radius) continue
      if (prefer && !String(e.name || '').toLowerCase().includes(String(prefer).toLowerCase())) continue
      if (d < bestD) { bestD = d; target = e }
    }
    if (!target) return fail('附近没有可乘坐目标')
    if (!ensurePathfinder()) return fail('无寻路')
    const { Movements, goals } = pathfinderPkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    bot.pathfinder.setMovements(m)
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.4), true)
    const start = Date.now()
    return await new Promise((resolve) => {
      const iv = setInterval(() => {
        try {
          if (bot.vehicle) { clearInterval(iv); resolve(ok('已乘坐')) ; return }
          const e = bot.entities?.[target.id]
          if (!e) { clearInterval(iv); resolve(fail('目标消失')) ; return }
          const d = e.position.distanceTo(bot.entity.position)
          if (d <= 2.0) {
            try { bot.mount(e); clearInterval(iv); resolve(ok('尝试乘坐')) ; return } catch {}
          }
          if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(fail('乘坐超时')) }
        } catch { clearInterval(iv); resolve(fail('乘坐异常')) }
      }, 150)
    })
  }

  async function dismount () {
    try { if (!bot.vehicle) return ok('当前未乘坐') ; await bot.dismount(); return ok('已下坐') } catch (e) { return fail('下坐失败: ' + (e?.message || e)) }
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

  const registry = { goto, follow_player, stop, stop_all, say, attack_player, hunt_player, guard, equip, toss, toss_hand, dig_down, auto_mine, mount_near, dismount }

  async function run (tool, args) {
    const fn = registry[tool]
    if (!fn) return { ok: false, msg: '未知工具' }
    try { return await fn(args || {}) } catch (e) { return { ok: false, msg: String(e?.message || e) } }
  }

  function list () { return Object.keys(registry) }

  return { run, list }
}

module.exports = { install }
