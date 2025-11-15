function createAiCliHandler (options = {}) {
  const {
    bot,
    state,
    buildGameContext,
    buildContextPrompt,
    persistMemoryState,
    selectDialoguesForContext,
    relativeTimeLabel,
    DEFAULT_RECENT_COUNT,
    rollSpendWindows,
    dayStart,
    monthStart,
    log,
    actionsMod
  } = options

  return function handleAiCli (payload) {
    try {
      if (!payload || payload.cmd !== 'ai') return
      const [sub, ...rest] = payload.args || []
      const print = (...a) => console.log('[AICTL]', ...a)
      switch ((sub || '').toLowerCase()) {
        case 'on': state.ai.enabled = true; print('enabled'); break
        case 'off': state.ai.enabled = false; print('disabled'); break
        case 'key': state.ai.key = rest.join(' ').trim() || null; print('key set'); break
        case 'model': state.ai.model = rest[0] || state.ai.model; print('model =', state.ai.model); break
        case 'base': state.ai.baseUrl = rest[0] || state.ai.baseUrl; print('base =', state.ai.baseUrl); break
        case 'path': state.ai.path = rest[0] || state.ai.path; print('path =', state.ai.path); break
        case 'max': state.ai.maxReplyLen = Math.max(20, parseInt(rest[0] || '120', 10)); print('maxReplyLen =', state.ai.maxReplyLen); break
        case 'clear': {
          state.aiRecent = []
          state.aiRecentSeq = 0
          if (state.aiPulse) state.aiPulse.lastSeq = 0
          print('recent chat cleared')
          break
        }
        case 'ctx': {
          try {
            print('gameCtx ->', buildGameContext())
            print('chatCtx ->', buildContextPrompt(''))
          } catch (e) {
            log?.warn && log.warn('ctx dump error:', e?.message || e)
          }
          break
        }
        case 'tools': {
          const tools = actionsMod.install(bot, { log })
          print('tools =', tools.list())
          break
        }
        case 'limit': {
          const k = (rest[0] || '').toLowerCase()
          const v = rest[1]
          state.ai.limits = state.ai.limits || { notify: true }
          switch (k) {
            case 'show':
              print('limits=', state.ai.limits || null)
              break
            case 'off':
              state.ai.limits = null
              print('limits disabled')
              break
            case 'usermin':
              state.ai.limits.userPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerMin =', state.ai.limits.userPerMin)
              break
            case 'userday':
              state.ai.limits.userPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('userPerDay =', state.ai.limits.userPerDay)
              break
            case 'globalmin':
              state.ai.limits.globalPerMin = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerMin =', state.ai.limits.globalPerMin)
              break
            case 'globalday':
              state.ai.limits.globalPerDay = v == null ? null : Math.max(0, parseInt(v, 10))
              print('globalPerDay =', state.ai.limits.globalPerDay)
              break
            case 'cooldown':
              state.ai.limits.cooldownMs = v == null ? null : Math.max(0, parseInt(v, 10))
              print('cooldownMs =', state.ai.limits.cooldownMs)
              break
            case 'notify':
              state.ai.limits.notify = ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase())
              print('notify =', state.ai.limits.notify)
              break
            default:
              print('limit usage: .ai limit show|off|usermin N|userday N|globalmin N|globalday N|cooldown ms|notify on|off')
          }
          break
        }
        case 'trace': {
          const v = (rest[0] || '').toLowerCase()
          state.ai.trace = ['1', 'true', 'on', 'yes'].includes(v)
          print('trace =', state.ai.trace)
          break
        }
        case 'budget': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          switch (k) {
            case 'show':
              rollSpendWindows()
              print('currency=', state.ai.currency, 'price(in/out)=', state.ai.priceInPerKT, state.ai.priceOutPerKT, 'budget(day/month)=', state.ai.budgetDay, state.ai.budgetMonth)
              print('spent day=', state.aiSpend.day, 'spent month=', state.aiSpend.month)
              break
            case 'currency': state.ai.currency = v || state.ai.currency; print('currency=', state.ai.currency); break
            case 'pricein': state.ai.priceInPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceInPerKT=', state.ai.priceInPerKT); break
            case 'priceout': state.ai.priceOutPerKT = Math.max(0, parseFloat(v || '0') || 0); print('priceOutPerKT=', state.ai.priceOutPerKT); break
            case 'day': state.ai.budgetDay = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetDay=', state.ai.budgetDay); break
            case 'month': state.ai.budgetMonth = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetMonth=', state.ai.budgetMonth); break
            case 'total': state.ai.budgetTotal = v == null ? null : Math.max(0, parseFloat(v || '0') || 0); print('budgetTotal=', state.ai.budgetTotal); break
            case 'maxtokens': state.ai.maxTokensPerCall = Math.max(64, parseInt(v || '512', 10)); print('maxTokensPerCall=', state.ai.maxTokensPerCall); break
            case 'notify': state.ai.notifyOnBudget = ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase()); print('notifyOnBudget=', state.ai.notifyOnBudget); break
            case 'resetday': state.aiSpend.day = { start: dayStart(), inTok: 0, outTok: 0, cost: 0 }; print('day spend reset'); break
            case 'resetmonth': state.aiSpend.month = { start: monthStart(), inTok: 0, outTok: 0, cost: 0 }; print('month spend reset'); break
            case 'resettotal': state.aiSpend.total = { inTok: 0, outTok: 0, cost: 0 }; print('total spend reset'); break
            default:
              print('budget usage: .ai budget show|currency USD|pricein 0.002|priceout 0.002|day 1.5|month 10|maxtokens 512|notify on|resetday|resetmonth')
          }
          break
        }
        case 'reply': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          switch (k) {
            case 'maxlen':
            case 'len':
              state.ai.maxReplyLen = Math.max(60, parseInt(v || '240', 10))
              print('maxReplyLen =', state.ai.maxReplyLen)
              break
            case 'show':
            default:
              print('reply =', { maxReplyLen: state.ai.maxReplyLen })
          }
          break
        }
        case 'dialog': {
          const sub = (rest[0] || '').toLowerCase()
          if (sub === 'clear') {
            state.aiDialogues = []
            print('dialog memory cleared')
            persistMemoryState()
            break
          }
          const list = (() => {
            if (sub === 'full') {
              return (state.aiDialogues || []).slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
            }
            const targetUser = sub ? rest[0] : null
            return selectDialoguesForContext(targetUser)
          })()
          if (!list.length) {
            print('dialog memory empty')
            break
          }
          list.forEach((entry, idx) => {
            const label = relativeTimeLabel(entry.endedAt)
            const people = (entry.participants || []).join('、') || '玩家们'
            print(`${idx + 1}. ${label} ${people}: ${entry.summary}`)
          })
          break
        }
        case 'context': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          state.ai.context = state.ai.context || { include: true, recentCount: DEFAULT_RECENT_COUNT, recentWindowSec: 300, recentStoreMax: 200 }
          switch (k) {
            case 'on': state.ai.context.include = true; print('context include=true'); break
            case 'off': state.ai.context.include = false; print('context include=false'); break
            case 'recent':
              state.ai.context.recentCount = Math.max(0, parseInt(v || '3', 10))
              state.ai.context.userRecentOverride = true
              print('context recentCount=', state.ai.context.recentCount)
              break
            case 'window': state.ai.context.recentWindowSec = Math.max(10, parseInt(v || '120', 10)); print('context recentWindowSec=', state.ai.context.recentWindowSec); break
            case 'recentmax': state.ai.context.recentStoreMax = Math.max(20, parseInt(v || '200', 10)); print('context recentStoreMax=', state.ai.context.recentStoreMax); break
            case 'show':
            default:
              print('context =', state.ai.context)
          }
          break
        }
        case 'info':
        default:
          print('enabled=', state.ai.enabled, 'model=', state.ai.model, 'base=', state.ai.baseUrl, 'path=', state.ai.path, 'max=', state.ai.maxReplyLen, 'limits=', state.ai.limits || null)
      }
    } catch (e) {
      log?.warn && log.warn('ai cli error:', e?.message || e)
    }
  }
}

module.exports = { createAiCliHandler }
