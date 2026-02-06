// Simple PvP helpers: shield usage, basic strafing, timed attacks

// Material priorities for melee weapons
const WEAPON_ORDER = [
  // swords first
  'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
  // then axes
  'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe',
  // pragmatic fallbacks when no weapons: pickaxes, then shovel
  'netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','golden_pickaxe','wooden_pickaxe',
  'netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','golden_shovel','wooden_shovel'
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

const { assertCanEquipHand, isMainHandLocked } = require('./hand-lock')

async function ensureBestWeapon (bot) {
  if (isMainHandLocked(bot)) return false
  const best = findBestWeapon(bot)
  if (!best) return false
  try {
    assertCanEquipHand(bot, best.name)
    await bot.equip(best, 'hand')
    return true
  } catch (e) {
    if (e?.code === 'MAIN_HAND_LOCKED') return false
    return false
  }
}

async function ensureShieldEquipped (bot) {
  try {
    const off = bot.inventory?.slots?.[45]
    if (off && String(off.name || '').toLowerCase() === 'totem_of_undying') {
      const hp = Number(bot.health)
      const keepAt = Number(process.env.AUTO_TOTEM_HEALTH_AT || 10)
      if (Number.isFinite(hp) && hp <= keepAt) return false
    }
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
  try { bot.setControlState('forward', false) } catch {}
  try { bot.setControlState('back', false) } catch {}
}

async function pvpTick (bot, target, ctx) {
  if (!target || !bot?.entity) return
  const d = entityDistance(bot.entity, target)

  // Respect main-hand lock for gear swaps, but still allow defensive moves
  let locked = false
  try { locked = !!(bot.state && bot.state.holdItemLock) } catch {}

  // Try to keep best gear ready
  if (!ctx.weaponEquippedOnce && !locked) {
    ctx.weaponEquippedOnce = true
    try { await ensureBestWeapon(bot) } catch {}
  }
  if (!ctx.shieldCheckedOnce) {
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
  let hasShield = false
  try { hasShield = String(bot.inventory?.slots?.[45]?.name || '').toLowerCase() === 'shield' } catch {}
  const wantBlock = hasShield && shouldBlock(bot, target, d)
  try { bot.setControlState('use', wantBlock) } catch {}

  // Advance or reposition relative to the target
  let wantForward = false
  let wantBack = false
  if (!wantBlock) {
    if (d > 2.6 && d <= 5.5) wantForward = true
    else if (!locked && d < 1.25) wantBack = true
  }
  try { bot.setControlState('forward', wantForward) } catch {}
  try { bot.setControlState('back', wantBack) } catch {}
  if (!wantForward && !wantBack) {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('back', false) } catch {}
  }

  // Attack on cooldown when in range and not actively blocking
  if (d <= 2.5 && cooledDown(ctx)) {
    if (wantBlock && hasShield) {
      try { bot.setControlState('use', false) } catch {}
      try { bot.attack(target); ctx.lastAttack = Date.now() } catch {}
      setTimeout(() => {
        try { if (hasShield) bot.setControlState('use', true) } catch {}
      }, 120)
    } else {
      try { bot.attack(target); ctx.lastAttack = Date.now() } catch {}
    }
  }
}

module.exports = { pvpTick, stopMoveOverrides, ensureShieldEquipped, ensureBestWeapon }
