function isOreNameSimple (name) {
  const s = String(name || '').toLowerCase()
  if (!s) return false
  if (s.endsWith('_ore')) return true
  if (s === 'ancient_debris') return true
  return false
}

function oreOnlyToken (name) {
  const s = String(name || '').toLowerCase()
  if (s === 'ancient_debris') return 'ancient_debris'
  if (!s.endsWith('_ore')) return s
  let base = s.slice(0, -'_ore'.length)
  if (base.startsWith('deepslate_')) base = base.slice('deepslate_'.length)
  if (base.startsWith('nether_')) base = base.slice('nether_'.length)
  if (base.includes('lapis')) return 'lapis'
  if (base.includes('redstone')) return 'redstone'
  if (base.includes('quartz')) return 'quartz'
  return base
}

function oreDisplayCN (token) {
  const t = String(token || '').toLowerCase()
  if (!t) return '矿物'
  if (t.includes('redstone')) return '红石'
  if (t.includes('diamond')) return '钻石'
  if (t.includes('iron')) return '铁'
  if (t.includes('gold')) return '金'
  if (t.includes('copper')) return '铜'
  if (t.includes('coal')) return '煤炭'
  if (t.includes('lapis')) return '青金石'
  if (t.includes('emerald')) return '绿宝石'
  if (t.includes('quartz')) return '石英'
  if (t.includes('ancient_debris') || t.includes('debris') || t.includes('netherite')) return '远古残骸'
  if (t.endsWith('_ore')) return t.replace(/_ore$/, '')
  return t
}

function oreLabelFromOnly (only) {
  try {
    if (!only) return '矿物'
    if (Array.isArray(only)) {
      const arr = only.map(oreDisplayCN).filter(Boolean)
      if (!arr.length) return '矿物'
      if (arr.length === 1) return arr[0]
      return arr.slice(0, 3).join('/') + (arr.length > 3 ? '等' : '')
    }
    return oreDisplayCN(only)
  } catch { return '矿物' }
}

module.exports = { isOreNameSimple, oreOnlyToken, oreLabelFromOnly }
