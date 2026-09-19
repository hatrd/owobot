module.exports = function registerController (ctx) {
  ctx.register('fishing_goal', args => {
    const r = ctx.bot.state?.fishingApi?.configure(args.op, args.args || {}) || {ok:false,error:'fishing_unavailable'}
    return {...r,msg:r.ok?'Fishing goal updated':r.error}
  })
  ctx.register('life_configure', args => {
    const result = ctx.bot.state?.lifeApi?.configure(args.op, args.args || {}) || { ok: false, error: 'life_unavailable' }
    return { ...result, msg: result.ok ? 'Autonomous life configured' : result.error }
  })
  ctx.register('controller_read', args => require('../../controller').read(ctx.bot, args))
  ctx.register('controller_write', async args => {
    const api = ctx.bot.state?.controllerApi
    if (!api) return ctx.fail('Controller unavailable', { error: 'runtime_unavailable' })
    const result = await api.write(args.op, args.args || {})
    return { ...result, msg: result.ok ? 'Controller updated' : result.error }
  })
}
