// CLI entry to start/stop ore mining skill.

function install (bot, { on, dlog, state, registerCleanup, log }) {
  state.mineOreTaskId = state.mineOreTaskId || null
  function ensureRunner () {
    try { return bot._skillRunner || require('./agent/runner').install(bot, { on, registerCleanup, log }) } catch { return null }
  }

  on('cli', async ({ cmd, args }) => {
    if (String(cmd).toLowerCase() !== 'mine') return
    const runner = ensureRunner()
    if (!runner) { try { bot.chat('技能系统不可用') } catch {} ; return }

    const a0 = String(args[0] || '').toLowerCase()
    if (a0 === 'stop' || a0 === 'cancel') {
      if (state.mineOreTaskId) {
        const r = runner.cancel(state.mineOreTaskId)
        try { bot.chat(r.ok ? '已停止挖矿' : ('停止失败: ' + (r.msg || '未知'))) } catch {}
        state.mineOreTaskId = null
      } else {
        try { bot.chat('没有进行中的挖矿任务') } catch {}
      }
      return
    }

    const radius = (() => {
      const r0 = parseInt(args[0] || 'NaN', 10)
      if (!isNaN(r0)) return r0
      const r1 = parseInt(args[1] || 'NaN', 10)
      if (!isNaN(r1)) return r1
      return 32
    })()
    try { bot.chat(`开始矿脉挖掘 半径=${isNaN(radius) ? 32 : radius}`) } catch {}
    const res = runner.startSkill('mine_ore', { radius: isNaN(radius) ? 32 : radius })
    if (!res.ok) try { bot.chat('启动失败: ' + (res.msg || '未知')) } catch {}
    else state.mineOreTaskId = res.taskId
  })
}

module.exports = { install }
