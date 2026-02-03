// CLI: .status [full]
// Prints a concise runtime snapshot to the internal terminal (not chat).

const observer = require('./agent/observer')

function install (bot, { on, dlog, state, registerCleanup, log }) {
  function line (label, val) { console.log('[STATUS]', label, val) }

  function printSnapshot (full = false) {
    try {
      const snap = observer.snapshot(bot, { invTop: full ? 999 : 24, nearPlayerRange: 16, nearPlayerMax: 8, dropsRange: 8, dropsMax: 8 })
      const pos = snap.pos ? `${snap.pos.x},${snap.pos.y},${snap.pos.z}` : '未知'
      const dim = snap.dim
      const time = snap.time || ''
      const weather = snap.env?.weather || ''
      const vit = snap.vitals || {}
      const hp = vit.hp != null ? `${Math.round(vit.hp)}/20` : '未知'
      const food = vit.food != null ? `${vit.food}/20` : '未知'
      const sat = vit.saturation != null ? `${Number(vit.saturation).toFixed ? Number(vit.saturation).toFixed(1) : vit.saturation}` : '未知'
      const inv = snap.inv || {}
      const all = Array.isArray(inv.all) ? inv.all : (inv.top || [])
      const invStr = (all || []).map(it => `${it.name}${it.label ? `「${it.label}」` : ''}x${it.count}`).join(', ')
      const hands = `主手=${inv.held || '无'} 副手=${inv.offhand || '无'}`
      const ar = inv.armor || {}
      const armor = `头=${ar.head || '无'} 胸=${ar.chest || '无'} 腿=${ar.legs || '无'} 脚=${ar.feet || '无'}`
      const players = (snap.nearby?.players || []).map(p => `${p.name}@${p.d.toFixed(1)}m`).join(', ')
      const host = snap.nearby?.hostiles || { count: 0, nearest: null }
      const drops = (snap.nearby?.drops || []).length
      const blocks = snap.blocks || {}
      const under = blocks.under || '未知'
      const look = blocks.look || '未知'
      const task = snap.task ? `${snap.task.name} (${snap.task.source === 'player' ? '玩家' : '自动'})` : '无'

      line('位置', `${pos} | ${dim} | ${time} | 天气=${weather}`)
      line('生命', `HP=${hp} 饥饿=${food} 饱和=${sat}`)
      line('附近', `玩家=[${players || '无'}] 敌对=${host.count || 0} 掉落=${drops}`)
      line('方块', `脚下=${under} 准星=${look}`)
      line('任务', task)
      line('手持', `${hands}`)
      line('装备', armor)
      line('背包', invStr || '无')
    } catch (e) {
      console.log('[STATUS] error:', e?.message || e)
    }
  }

  function onCli (payload) {
    try {
      if (!payload || String(payload.cmd || '').toLowerCase() !== 'status') return
      const full = String(payload.args?.[0] || '').toLowerCase() === 'full'
      printSnapshot(full)
    } catch (e) { console.log('[STATUS] error:', e?.message || e) }
  }

  on('cli', onCli)
  registerCleanup && registerCleanup(() => { try { bot.off('cli', onCli) } catch {} })
}

module.exports = { install }
