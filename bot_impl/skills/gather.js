// High-level gather skill: obtain target item with qty

function invCount (bot, name) { try { const n = String(name||'').toLowerCase(); return (bot.inventory?.items()||[]).filter(it=>String(it.name||'').toLowerCase()===n).reduce((a,b)=>a+(b.count||0),0) } catch { return 0 } }

function ensurePathfinder (bot, log) {
  try {
    const pkg = require('mineflayer-pathfinder')
    if (!bot.pathfinder) bot.loadPlugin(pkg.pathfinder)
    const { Movements } = pkg
    const mcData = bot.mcData || require('minecraft-data')(bot.version)
    const m = new Movements(bot, mcData)
    m.canDig = true; m.allowSprinting = true
    return { ok: true, pkg, m }
  } catch (e) { log && log.warn && log.warn('pathfinder missing'); return { ok: false } }
}

async function mineNearest (bot, nameLike, maxBlocks, log) {
  const pf = ensurePathfinder(bot, log); if (!pf.ok) return { ok: false, msg: '无寻路' }
  const toolSel = require('../tool-select')
  let mined = 0
  while (mined < maxBlocks) {
    const me = bot.entity?.position
    if (!me) break
    const list = bot.findBlocks({ maxDistance: 20, count: 64, matching: (b) => { const n = String(b?.name || '').toLowerCase(); return n && n.includes(nameLike) } }) || []
    if (!list.length) break
    list.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    let dugOne = false
    for (const p of list) {
      try {
        const { goals } = pf.pkg
        bot.pathfinder.setMovements(pf.m)
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1), true)
        const until = Date.now() + 6000
        while (Date.now() < until) {
          await new Promise(r => setTimeout(r, 120))
          const d = bot.entity.position.distanceTo(p)
          if (d <= 2.2) break
        }
        const block = bot.blockAt(p)
        if (!block) continue
        try { await toolSel.ensureBestToolForBlock(bot, block) } catch {}
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
        await bot.dig(block)
        mined++; dugOne = true; break
      } catch {}
    }
    if (!dugOne) break
  }
  return { ok: mined > 0, msg: `挖掘完成 ${mined}` }
}

module.exports = function gatherFactory ({ bot, args, log }) {
  const item = String(args.item || '').toLowerCase()
  const qty = Math.max(1, parseInt(args.qty || '1', 10))
  let phase = 'plan'
  let target = item
  let started = false

  function start () { started = true }

  async function tick () {
    if (!started) start()
    const have = invCount(bot, item)
    if (have >= qty) return { status: 'succeeded', progress: 1, events: [{ type: 'gather_ok', item, qty }] }

    // Simple built-ins: if item is <wood>_planks, craft from <wood>_log
    if (/^([a-z_]+)_planks$/.test(item)) {
      const base = item.replace(/_planks$/, '_log')
      const needLogs = Math.ceil((qty - have) / 4)
      const haveLogs = invCount(bot, base)
      if (haveLogs < needLogs) {
        // ask AI whether oak->spruce acceptable if we have spruce logs
        const offers = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','bamboo_block']
        const available = offers.filter(n => invCount(bot, n) > 0)
        return { status: 'failed', progress: have/qty, events: [{ type: 'missing_material', need: base, offer: available, decision: 'awaiting' }] }
      }
      // craft using craft skill
      const craft = require('./craft')({ bot, args: { item, qty: (qty - have) }, log })
      try { const res = await craft.tick(); if (res.status !== 'succeeded') return res; return { status: 'succeeded', progress: 1, events: [{ type: 'crafted', item, qty }] } } catch (e) { return { status: 'failed', progress: have/qty, events: [{ type: 'error', error: String(e?.message || e) }] } }
    }

    // If item is a log, mine it
    if (/_log$/.test(item)) {
      const left = qty - have
      const r = await mineNearest(bot, 'log', Math.max(1, left), log)
      if (!r.ok) return { status: 'failed', progress: have/qty, events: [{ type: 'error', error: r.msg || '挖掘失败' }] }
      return { status: 'running', progress: Math.min(0.95, have/qty) }
    }

    // Fallback: try craft directly
    const craft = require('./craft')({ bot, args: { item, qty: (qty - have) }, log })
    const res = await craft.tick()
    return res
  }

  function cancel () {}

  return { start, tick, cancel }
}
