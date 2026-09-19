module.exports = function registerController (ctx) {
  ctx.register('controller_read', args => require('../../controller').read(ctx.bot, args))
  ctx.register('controller_write', args => {
    const api = ctx.bot.state?.controllerApi
    if (!api) return ctx.fail('Controller unavailable', { error: 'runtime_unavailable' })
    const result = api.write(args.op, args.args || {})
    return { ...result, msg: result.ok ? 'Controller updated' : result.error }
  })
}
