// Simple PvP helpers: shield usage, basic strafing, timed attacks

// Material priorities for melee weapons
const WEAPON_ORDER = [
  'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
  'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe'
]

function findItemByName (bot, name) {
  const needle = String(name || '').toLowerCase()
  const inv = bot.inventory?.items() || []
  const off = bot.inventory?.slots?.[45]
  const main = bot.heldItem
  const extra = []
  if (main) extra.push(main)
  if (off) extra.push(off)
  return inv.concat(extra).find(it => String(it.name || '').toLowerCase() === needle) || null
}

function findBestWeapon (bot) {
  const inv = bot.inventory?.items() || []
  const main = bot.heldItem
  const off = bot.inventory?.slots?.[45]
  const all = inv.concat([main, off].filter(Boolean))
  const byName = new Map(all.map(it => [String(it.name || '').toLowerCase(), it]))
  for (const key of WEAPON_ORDER) {
    const it = byName.get(key)
    if (it) return it
  }
  return null
}

async function ensureBestWeapon (bot) {
  try { if (bot.state && bot.state.holdItemLock) return false } catch {}
  const best = findBestWeapon(bot)
  if (!best) return false
  try { await bot.equip(best, 'hand'); return true } catch { return false }
}

async function ensureShieldEquipped (bot) {
  try {
    const off = bot.inventory?.slots?.[45]
    if (off && String(off.name || '').toLowerCase() === 'shield') return true
    const shield = findItemByName(bot, 'shield')
    if (!shield) return false
    await bot.equip(shield, 'off-hand')
    return true
  } catch { return false }
}

function isLookingAt (source, target, maxDeg = 28) {
  try {
    if (!source?.position || !target?.position || typeof source.yaw !== 'number') return false
    const dx = target.position.x - source.position.x
    const dz = target.position.z - source.position.z
    const yawToTarget = Math.atan2(-dx, -dz) // mineflayer yaw frame
    const diff = Math.atan2(Math.sin(source.yaw - yawToTarget), Math.cos(source.yaw - yawToTarget))
    const deg = Math.abs(diff * 180 / Math.PI)
    return deg <= maxDeg
  } catch { return false }
}

function entityDistance (a, b) {
  try { return a.position.distanceTo(b.position) } catch { return Infinity }
}

function pickStrafeDir (ctx, periodMs = 900) {
  const now = Date.now()
  if (!ctx.lastStrafeSwitch || (now - ctx.lastStrafeSwitch) > periodMs) {
    ctx.lastStrafeSwitch = now
    ctx.strafeDir = (ctx.strafeDir === 'left') ? 'right' : 'left'
  }
  return ctx.strafeDir || 'left'
}

function shouldBlock (bot, target, d) {
  // Block if in melee range and they face us, or if using a bow within 12 blocks
  const name = String(target?.heldItem?.name || target?.equipment?.[0]?.name || '').toLowerCase()
  const usingBow = name.includes('bow')
  const faceMe = isLookingAt(target, bot.entity)
  if (usingBow && d <= 12 && faceMe) return true
  if (d <= 2.7 && faceMe) return true
  return false
}

function cooledDown (ctx, minMs = 600) {
  const now = Date.now()
  if (!ctx.lastAttack) return true
  return (now - ctx.lastAttack) >= minMs
}

function stopMoveOverrides (bot) {
  try { bot.setControlState('left', false) } catch {}
  try { bot.setControlState('right', false) } catch {}
  try { bot.setControlState('jump', false) } catch {}
  try { bot.setControlState('use', false) } catch {}
}

async function pvpTick (bot, target, ctx) {
  if (!target || !bot?.entity) return
  const d = entityDistance(bot.entity, target)

  // Respect main-hand lock: avoid interfering with tasks like mining
  let locked = false
  try { locked = !!(bot.state && bot.state.holdItemLock) } catch {}
  if (locked) return

  // Try to keep best gear ready
  if (!ctx.weaponEquippedOnce && !locked) {
    ctx.weaponEquippedOnce = true
    try { await ensureBestWeapon(bot) } catch {}
  }
  if (!ctx.shieldCheckedOnce && !locked) {
    ctx.shieldCheckedOnce = true
    try { await ensureShieldEquipped(bot) } catch {}
  }

  // Aim at the target's upper body
  try { bot.lookAt(target.position.offset(0, 1.4, 0), true) } catch {}

  // Strafe to be less predictable while in mid-range
  if (d >= 2.2 && d <= 5.5) {
    const dir = pickStrafeDir(ctx)
    try { bot.setControlState('left', dir === 'left') } catch {}
    try { bot.setControlState('right', dir === 'right') } catch {}
    // occasional hop
    if (Math.random() < 0.08) { try { bot.setControlState('jump', true); setTimeout(() => { try { bot.setControlState('jump', false) } catch {} }, 120) } catch {} }
  } else {
    try { bot.setControlState('left', false) } catch {}
    try { bot.setControlState('right', false) } catch {}
  }

  // Shield usage
  const wantBlock = locked ? false : shouldBlock(bot, target, d)
  try { bot.setControlState('use', wantBlock) } catch {}

  // Attack on cooldown when in range and not actively blocking
  if (!locked && d <= 2.5 && cooledDown(ctx) && !wantBlock) {
    try { bot.attack(target); ctx.lastAttack = Date.now() } catch {}
  }
}

module.exports = { pvpTick, stopMoveOverrides, ensureShieldEquipped, ensureBestWeapon }
