const FURNACE_LIKE_BLOCKS = new Set(['furnace', 'smoker', 'blast_furnace'])

const STORAGE_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'shulker_box'
])

const EXTRA_CONTAINER_BLOCKS = new Set([
  'hopper',
  'dispenser',
  'dropper',
  'brewing_stand'
])

function isShulkerBlockName (name) {
  const s = String(name || '').toLowerCase()
  return s === 'shulker_box' || s.endsWith('_shulker_box')
}

function isFurnaceLikeBlockName (name) {
  return FURNACE_LIKE_BLOCKS.has(String(name || '').toLowerCase())
}

function normalizeContainerType (raw, { fallback = null } = {}) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return fallback

  if (['any', 'auto', 'default', 'all', '任意', '随便', '所有', '全部'].includes(s)) return 'any'

  if (['storage', 'store', '仓库', '仓储', '存储', '收纳'].includes(s)) return 'storage'

  if (['chest', 'box', '箱子', '箱'].includes(s)) return 'chest'
  if (['barrel', '木桶', '桶'].includes(s)) return 'barrel'
  if (['ender_chest', 'enderchest', 'ender-chest', 'ender chest', 'ender', '末影箱', '末影'].includes(s)) return 'ender_chest'
  if (['shulker_box', 'shulkerbox', 'shulker-box', 'shulker box', 'shulker', '潜影箱', '潜影盒', '潜影'].includes(s)) return 'shulker_box'

  if (['furnace', '炉子', '熔炉', '普通炉', '普通熔炉', '烤炉'].includes(s)) return 'furnace'
  if (['smoker', '烟熏炉', '烟熏'].includes(s)) return 'smoker'
  if (['blast_furnace', 'blastfurnace', 'blast-furnace', 'blast furnace', '高炉'].includes(s)) return 'blast_furnace'

  if (['hopper', '漏斗'].includes(s)) return 'hopper'
  if (['dispenser', '发射器'].includes(s)) return 'dispenser'
  if (['dropper', '投掷器', '投放器'].includes(s)) return 'dropper'
  if (['brewing_stand', 'brewingstand', 'brewing-stand', 'brewing stand', 'brew', '酿造台'].includes(s)) return 'brewing_stand'

  return fallback
}

function containerGroupFromName (name) {
  const s = String(name || '').toLowerCase()
  if (s === 'chest' || s === 'trapped_chest') return 'chest'
  if (s === 'barrel') return 'barrel'
  if (s === 'ender_chest') return 'ender_chest'
  if (isShulkerBlockName(s)) return 'shulker_box'
  if (isFurnaceLikeBlockName(s)) return 'furnace'
  if (s === 'hopper') return 'hopper'
  if (s === 'dispenser') return 'dispenser'
  if (s === 'dropper') return 'dropper'
  if (s === 'brewing_stand') return 'brewing_stand'
  return 'other'
}

function containerTypeLabel (type) {
  const t = String(type || '').toLowerCase()
  if (t === 'chest') return '箱子'
  if (t === 'barrel') return '木桶'
  if (t === 'ender_chest') return '末影箱'
  if (t === 'shulker_box') return '潜影箱'
  if (t === 'storage') return '存储容器'

  if (t === 'furnace') return '熔炉'
  if (t === 'smoker') return '烟熏炉'
  if (t === 'blast_furnace') return '高炉'

  if (t === 'hopper') return '漏斗'
  if (t === 'dispenser') return '发射器'
  if (t === 'dropper') return '投掷器'
  if (t === 'brewing_stand') return '酿造台'
  return '容器'
}

function isContainerNameMatch (name, containerType = 'any', { includeBarrel = true } = {}) {
  const s = String(name || '').toLowerCase()
  const t = String(containerType || 'any').toLowerCase()

  // Legacy behavior: containerType can be null to mean "default" (chest + optional barrel).
  if (!containerType) {
    if (s === 'chest' || s === 'trapped_chest') return true
    if (includeBarrel && s === 'barrel') return true
    return false
  }

  if (t === 'storage') {
    if (s === 'chest' || s === 'trapped_chest') return true
    if (s === 'ender_chest') return true
    if (isShulkerBlockName(s)) return true
    if (includeBarrel && s === 'barrel') return true
    return false
  }

  if (t === 'chest') return (s === 'chest' || s === 'trapped_chest')
  if (t === 'barrel') return s === 'barrel'
  if (t === 'ender_chest') return s === 'ender_chest'
  if (t === 'shulker_box') return isShulkerBlockName(s)

  if (t === 'furnace') return isFurnaceLikeBlockName(s)
  if (t === 'smoker') return s === 'smoker'
  if (t === 'blast_furnace') return s === 'blast_furnace'
  if (t === 'hopper') return s === 'hopper'
  if (t === 'dispenser') return s === 'dispenser'
  if (t === 'dropper') return s === 'dropper'
  if (t === 'brewing_stand') return s === 'brewing_stand'

  if (t === 'any') {
    if (s === 'chest' || s === 'trapped_chest') return true
    if (s === 'barrel') return true
    if (s === 'ender_chest') return true
    if (isShulkerBlockName(s)) return true
    if (isFurnaceLikeBlockName(s)) return true
    if (EXTRA_CONTAINER_BLOCKS.has(s)) return true
    return false
  }

  // Unknown: do not guess.
  return false
}

module.exports = {
  normalizeContainerType,
  containerGroupFromName,
  containerTypeLabel,
  isContainerNameMatch,
  isFurnaceLikeBlockName,
  isShulkerBlockName,
  FURNACE_LIKE_BLOCKS,
  STORAGE_BLOCKS,
  EXTRA_CONTAINER_BLOCKS
}

