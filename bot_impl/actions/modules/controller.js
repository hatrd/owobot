module.exports = function registerController (ctx) {
  ctx.register('controller_read', args => require('../../controller').read(ctx.bot, args))
  ctx.register('controller_write', async args => {
    const api = ctx.bot.state?.controllerApi
    if (!api) return ctx.fail('Controller unavailable', { error: 'runtime_unavailable' })
    const result = await api.write(args.op, args.args || {})
    return { ...result, msg: result.ok ? 'Controller updated' : result.error }
  })
}
