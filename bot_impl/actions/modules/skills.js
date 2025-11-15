const { oreLabelFromOnly } = require('../lib/ore')

module.exports = function registerSkills (ctx) {
  const { bot, register, ok, fail, log } = ctx
  const skillRunnerMod = ctx.skillRunnerMod
  const registerCleanup = ctx.registerCleanup

  function ensureRunner () {
    try { return skillRunnerMod.ensure(bot, { on: ctx.on, registerCleanup, log }) } catch { return null }
  }

  async function mine_ore (args = {}) {
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const radius = Math.max(4, parseInt(args.radius || '32', 10))
    const only = (() => {
      if (!args.only) return null
      if (Array.isArray(args.only)) return args.only.map(x => String(x).toLowerCase())
      return String(args.only).toLowerCase()
    })()
    const expected = args.expected ? String(args.expected) : null
    const res = runner.startSkill('mine_ore', { radius, only }, expected)
    const label = oreLabelFromOnly(only)
    return res.ok ? ok(`矿脉挖掘已启动: ${label}`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  async function skill_start (args = {}) {
    const { skill, expected = null } = args
    if (!skill) return fail('缺少技能名')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    try {
      if (runner.listSkills().length === 0) {
        runner.registerSkill('go', require('../../skills/go'))
        runner.registerSkill('gather', require('../../skills/gather'))
        runner.registerSkill('craft', require('../../skills/craft'))
      }
    } catch {}
    const res = runner.startSkill(String(skill), args.args || {}, expected || null)
    return res.ok ? ok(`任务已启动 ${res.taskId}`, { taskId: res.taskId }) : fail(res.msg || '启动失败')
  }

  async function skill_status (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.status(String(taskId))
    return r.ok ? ok('状态', r) : fail(r.msg || '查询失败')
  }

  async function skill_cancel (args = {}) {
    const { taskId } = args
    if (!taskId) return fail('缺少taskId')
    const runner = ensureRunner()
    if (!runner) return fail('技能运行器不可用')
    const r = runner.cancel(String(taskId))
    return r.ok ? ok('已取消', r) : fail(r.msg || '取消失败')
  }

  async function sort_chests (args = {}) {
    const frameState = bot.state?.frameSort
    if (!frameState || typeof frameState.runSort !== 'function') return fail('分类模块未就绪')
    const radiusRaw = args?.radius ?? args?.range ?? args?.r ?? undefined
    let res
    try {
      res = await frameState.runSort(radiusRaw)
    } catch (e) {
      try { log?.warn && log.warn('sort_chests error', e?.message || e) } catch {}
      return fail('分类失败，请稍后再试~')
    }
    if (!res || res.ok === false) {
      const reason = res?.reason
      const reasonMsg = (() => {
        switch (reason) {
          case 'running': return '分类已在进行中'
          case 'busy': return '当前忙于其他任务'
          case 'unready': return '还没准备好'
          case 'no_framed': return '附近没有展示框指引的箱子'
          default: return '分类失败'
        }
      })()
      return fail(reasonMsg)
    }
    const totalSources = Number.isFinite(res.sourcesTotal) ? res.sourcesTotal : null
    if (!res.moved || res.reason === 'nothing_to_sort') {
      return ok('所有箱子已经整理好啦', { moved: false, radius: res.radius, sourcesTotal: totalSources })
    }
    const movedCount = Number.isFinite(res.sourcesMoved) ? res.sourcesMoved : null
    const suffix = movedCount && movedCount > 0 ? `，处理了${movedCount}个源箱` : ''
    return ok(`整理箱子完成${suffix}`, { moved: true, sourcesMoved: res.sourcesMoved ?? null, sourcesTotal: totalSources, radius: res.radius })
  }

  register('mine_ore', mine_ore)
  register('skill_start', skill_start)
  register('skill_status', skill_status)
  register('skill_cancel', skill_cancel)
  register('sort_chests', sort_chests)
}
