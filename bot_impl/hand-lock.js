function normalizeName (value) {
  return String(value || '').toLowerCase()
}

function hasMainHandLock (bot) {
  try { return Boolean(bot?.state?.holdItemLock) } catch { return false }
}

function isMainHandLocked (bot, desiredName = null) {
  if (!bot) return false
  const lockName = normalizeName(bot?.state?.holdItemLock)
  if (!lockName) return false
  if (desiredName == null) return true
  const want = normalizeName(desiredName)
  if (!want) return true
  if (lockName === want) return false
  const held = normalizeName(bot.heldItem?.name)
  if (held && held === want) return false
  return true
}

function assertCanEquipHand (bot, desiredName = null) {
  if (!isMainHandLocked(bot, desiredName)) return
  const reason = normalizeName(bot?.state?.holdItemLock) || 'locked'
  const err = new Error(`主手已锁定(${reason})`)
  err.code = 'MAIN_HAND_LOCKED'
  throw err
}

module.exports = { normalizeName, hasMainHandLock, isMainHandLocked, assertCanEquipHand }
