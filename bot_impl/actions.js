// Whitelisted game actions for AI/tool use

let huntInterval = null
let huntTarget = null
let guardInterval = null
let guardTarget = null

function install (bot, { log, on, registerCleanup }) {
  let pathfinderPkg = null
  function ensurePathfinder () {
    try { if (!pathfinderPkg) pathfinderPkg = require('mineflayer-pathfinder'); if (!bot.pathfinder) bot.loadPlugin(pathfinderPkg.pathfinder); return true } catch (e) { log && log.warn && log.warn('pathfinder missing'); return false }
  }

  function ok(msg, extra) { return { ok: true, msg, ...extra } }
  function fail(msg) { return { ok: false, msg } }

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
    if (huntInterval) { try { clearInterval(huntInterval) } catch {}; huntInterval = null; huntTarget = null }
    if (guardInterval) { try { clearInterval(guardInterval) } catch {}; guardInterval = null; guardTarget = null }
    return ok('已停止')
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
    const start = Date.now()
    return await new Promise((resolve) => {
      const iv = setInterval(() => {
        const e = bot.players[name]?.entity
        if (!e) { clearInterval(iv); resolve(fail('目标消失')) ; return }
        const d = e.position.distanceTo(bot.entity.position)
        if (d <= 2.2) {
          try { bot.attack(e) } catch {}
        }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(ok('攻击已尝试')) }
      }, 300)
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
    huntInterval = setInterval(() => {
      try {
        const ent = bot.players[huntTarget]?.entity
        if (!ent) return
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, range), true)
        const d = ent.position.distanceTo(bot.entity.position)
        if (d <= (range + 0.5)) {
          try { bot.lookAt(ent.position.offset(0, 1.4, 0), true) } catch {}
          try { bot.attack(ent) } catch {}
        }
      } catch {}
    }, Math.max(150, tickMs))
    return ok(`开始追击 ${huntTarget}`)
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

  const registry = { goto, follow_player, stop, say, attack_player, hunt_player, guard, equip, toss, toss_hand }

  async function run (tool, args) {
    const fn = registry[tool]
    if (!fn) return { ok: false, msg: '未知工具' }
    try { return await fn(args || {}) } catch (e) { return { ok: false, msg: String(e?.message || e) } }
  }

  function list () { return Object.keys(registry) }

  return { run, list }
}

module.exports = { install }
