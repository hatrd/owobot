// Skill: write_text — write block letters on the ground using inventory blocks
// Args: { text, item?, spacing?=1, size?=1 }

const { assertCanEquipHand, isMainHandLocked } = require('../hand-lock')

module.exports = function writeTextFactory ({ bot, args, log }) {
  const text = String(args.text || '').toUpperCase()
  const spacing = Math.max(1, parseInt(args.spacing || '1', 10))
  const size = Math.max(1, parseInt(args.size || '1', 10))
  const itemPref = args.item ? String(args.item).toLowerCase() : null

  let pf = null
  let plan = [] // [{x,y,z}]
  let step = 0
  let inited = false

  function invItems () { try { return bot.inventory?.items() || [] } catch { return [] } }
  function pickBlockName () {
    if (itemPref) {
      const exact = invItems().find(it => String(it?.name||'').toLowerCase() === itemPref)
      if (exact) return exact.name
      const part = invItems().find(it => String(it?.name||'').toLowerCase().includes(itemPref))
      if (part) return part.name
    }
    const prefs = ['cobblestone','cobbled_deepslate','deepslate','stone','oak_planks','spruce_planks']
    for (const p of prefs) { const it = invItems().find(x => String(x?.name||'').toLowerCase() === p); if (it) return it.name }
    return invItems()[0]?.name || null
  }

  async function equipByName (name) {
    const n = String(name||'').toLowerCase()
    const inv = invItems()
    const it = inv.find(x => String(x?.name||'').toLowerCase() === n) || inv.find(x => String(x?.name||'').toLowerCase().includes(n))
    if (!it) throw new Error('材料不足')
    if (isMainHandLocked(bot, it.name)) throw new Error('主手已锁定，无法切换方块')
    try { assertCanEquipHand(bot, it.name) } catch (e) { if (e?.code === 'MAIN_HAND_LOCKED') throw new Error('主手已锁定，无法切换方块'); throw e }
    await bot.equip(it, 'hand')
    return it
  }

  function ensurePathfinder () {
    try {
      const pkg = require('mineflayer-pathfinder')
      if (!bot.pathfinder) bot.loadPlugin(pkg.pathfinder)
      const { Movements } = pkg
      const mcData = bot.mcData || require('minecraft-data')(bot.version)
      const m = new Movements(bot, mcData)
      m.canDig = true; m.allowSprinting = true
      pf = { pkg, m }
      return true
    } catch { return false }
  }

  function fwdRight () {
    try {
      const yaw = bot.entity.yaw || 0
      // forward dirs in XZ plane; right is perpendicular
      const dirs = [ [1,0], [0,1], [-1,0], [0,-1] ]
      const a = Math.round((yaw / (Math.PI/2)))
      const f = dirs[(a%4+4)%4]
      const r = [f[1], -f[0]]
      return { f, r }
    } catch { return { f: [1,0], r: [0,-1] } }
  }

  function font5x5 () {
    // 5x5 uppercase A-Z and digits 0-9; '1' = filled, space = empty
    const F = {}
    const add = (ch, rows) => { F[ch] = rows }
    add('A', [' 111 ', '1   1', '11111', '1   1', '1   1'])
    add('B', ['1111 ', '1   1', '1111 ', '1   1', '1111 '])
    add('C', [' 1111', '1    ', '1    ', '1    ', ' 1111'])
    add('D', ['1111 ', '1   1', '1   1', '1   1', '1111 '])
    add('E', ['11111', '1    ', '1111 ', '1    ', '11111'])
    add('F', ['11111', '1    ', '1111 ', '1    ', '1    '])
    add('G', [' 1111', '1    ', '1 111', '1   1', ' 1111'])
    add('H', ['1   1', '1   1', '11111', '1   1', '1   1'])
    add('I', ['11111', '  1  ', '  1  ', '  1  ', '11111'])
    add('J', ['    1', '    1', '    1', '1   1', ' 111 '])
    add('K', ['1   1', '1  1 ', '111  ', '1  1 ', '1   1'])
    add('L', ['1    ', '1    ', '1    ', '1    ', '11111'])
    add('M', ['1   1', '11 11', '1 1 1', '1   1', '1   1'])
    add('N', ['1   1', '11  1', '1 1 1', '1  11', '1   1'])
    add('O', [' 111 ', '1   1', '1   1', '1   1', ' 111 '])
    add('P', ['1111 ', '1   1', '1111 ', '1    ', '1    '])
    add('Q', [' 111 ', '1   1', '1   1', '1  11', ' 1111'])
    add('R', ['1111 ', '1   1', '1111 ', '1  1 ', '1   1'])
    add('S', [' 1111', '1    ', ' 111 ', '    1', '1111 '])
    add('T', ['11111', '  1  ', '  1  ', '  1  ', '  1  '])
    add('U', ['1   1', '1   1', '1   1', '1   1', ' 111 '])
    add('V', ['1   1', '1   1', '1   1', ' 1 1 ', '  1  '])
    add('W', ['1   1', '1   1', '1 1 1', '11 11', '1   1'])
    add('X', ['1   1', ' 1 1 ', '  1  ', ' 1 1 ', '1   1'])
    add('Y', ['1   1', ' 1 1 ', '  1  ', '  1  ', '  1  '])
    add('Z', ['11111', '   1 ', '  1  ', ' 1   ', '11111'])

    add('0', [' 111 ', '1  11', '1 1 1', '11  1', ' 111 '])
    add('1', ['  1  ', ' 11  ', '  1  ', '  1  ', ' 111 '])
    add('2', [' 111 ', '1   1', '   1 ', '  1  ', '11111'])
    add('3', ['1111 ', '    1', ' 111 ', '    1', '1111 '])
    add('4', ['1  1 ', '1  1 ', '11111', '   1 ', '   1 '])
    add('5', ['11111', '1    ', '1111 ', '    1', '1111 '])
    add('6', [' 111 ', '1    ', '1111 ', '1   1', ' 111 '])
    add('7', ['11111', '   1 ', '  1  ', ' 1   ', '1    '])
    add('8', [' 111 ', '1   1', ' 111 ', '1   1', ' 111 '])
    add('9', [' 111 ', '1   1', ' 1111', '    1', ' 111 '])

    return F
  }

  function buildPlan () {
    const V = require('vec3').Vec3
    const me = bot.entity?.position?.floored?.() || bot.entity?.position
    if (!me) throw new Error('未就绪')
    const { f, r } = fwdRight()
    const origin = new V(me.x + f[0]*2, me.y, me.z + f[1]*2)
    const F = font5x5()
    let cx = 0
    for (const ch of text) {
      const glyph = F[ch]
      if (!glyph) { cx += 4 + spacing; continue }
      // Normalize to 5 rows x up to 3 cols (compact 3x5 to save blocks)
      const rows = glyph
      const gw = Math.max(...rows.map(s => s.length))
      const gh = rows.length
      for (let y = 0; y < gh; y++) {
        const row = rows[y]
        for (let x = 0; x < gw; x++) {
          if (row[x] !== '1') continue
          // For scale (size), place a size x size filled tile
          for (let sx = 0; sx < size; sx++) {
            for (let sz = 0; sz < size; sz++) {
              const dx = (cx + x*size + sx)
              const dz = (y*size + sz)
              const wx = origin.x + r[0]*dx + f[0]*dz
              const wz = origin.z + r[1]*dx + f[1]*dz
              plan.push({ x: Math.floor(wx), z: Math.floor(wz) })
            }
          }
        }
      }
      cx += (gw * size) + spacing
    }
  }

  function findGroundY (x, z) {
    const V = require('vec3').Vec3
    try {
      const meY = Math.floor(bot.entity?.position?.y || 64)
      for (let y = meY + 2; y >= -64; y--) {
        const b = bot.blockAt(new V(x, y, z))
        if (b && b.name !== 'air') return y + 1
      }
      return meY
    } catch { return Math.floor(bot.entity?.position?.y || 64) }
  }

  async function gotoNear (pos, range = 3) {
    if (!ensurePathfinder()) throw new Error('无寻路')
    const { goals } = pf.pkg
    bot.pathfinder.setMovements(pf.m)
    await bot.pathfinder.goto(new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), Math.max(1, range)))
  }

  async function placeAt (x, z, name) {
    const V = require('vec3').Vec3
    const y = findGroundY(x, z)
    const support = bot.blockAt(new V(x, y - 1, z))
    if (!support) return false
    await equipByName(name)
    await gotoNear({ x, y, z }, 3)
    try { await bot.lookAt(new V(x + 0.5, y + 0.5, z + 0.5), true) } catch {}
    try { await bot.placeBlock(support, new V(0, 1, 0)) ; return true } catch { return false }
  }

  async function tick () {
    if (!inited) {
      const name = pickBlockName()
      if (!name) throw new Error('材料不足')
      buildPlan()
      // material cached by name on controller
      writeTextFactory._materialName = name
      inited = true
      return { status: 'running', progress: 0 }
    }
    if (step >= plan.length) return { status: 'succeeded', progress: 1, events: [{ type: 'done' }] }
    const name = writeTextFactory._materialName
    const cell = plan[step]
    const ok = await placeAt(cell.x, cell.z, name).catch(() => false)
    step++
    return { status: 'running', progress: Math.min(0.99, step / plan.length), events: ok ? undefined : [{ type: 'place_fail', at: cell }] }
  }

  function cancel () { try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {} }

  return { tick, cancel }
}
