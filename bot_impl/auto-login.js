// Auto-login module: listens for server prompts like
// "用法: /login <密码>" and sends "/login <password>" once per session.

function install (bot, { on, state, log, dlog, registerCleanup }) {
  function ts () { return new Date().toISOString() }

  if (typeof state.loginAttempted !== 'boolean') state.loginAttempted = false

  function getPassword () {
    try { return state?.loginPassword || process.env.MC_PASSWORD || null } catch { return null }
  }

  function tryLogin (trigger) {
    const pwd = getPassword()
    if (!pwd) {
      log && log.warn ? log.warn('auto-login: password not set; set MC_PASSWORD or pass --password') : console.log('auto-login: password not set')
      return
    }
    if (state.loginAttempted) return
    state.loginAttempted = true
    try {
      bot.chat(`/login ${pwd}`)
      console.log(`[${ts()}] Sent /login due to ${trigger}`)
    } catch (e) {
      log && log.warn ? log.warn('auto-login chat error: ' + (e?.message || e)) : console.log('auto-login chat error:', e)
    }
  }

  on('spawn', () => {
    // New session -> allow login once
    state.loginAttempted = false
    // Some servers don't prompt immediately; send proactively if desired in future
  })

  on('message', (message) => {
    try {
      const text = typeof message.getText === 'function' ? message.getText() : (typeof message.toString === 'function' ? message.toString() : String(message))
      const s = (text || '').toString()
      const normalized = s.replace(/\u00a7./g, '')
      if (!normalized) return
      const patterns = [
        /用法[:：]\s*\/login\s*<密码>/i,
        /用法[:：]\s*\/l\s*<密码>/i,
        /usage[:：]?\s*\/login\s*<password>/i,
        /please\s+login/i
      ]
      if (patterns.some(rx => rx.test(normalized))) {
        tryLogin('server prompt')
      }
    } catch {}
  })

  registerCleanup && registerCleanup(() => {})
}

module.exports = { install }
