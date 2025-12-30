function createAiCliHandler (options = {}) {
  const {
    bot,
    state,
    buildGameContext,
    buildContextPrompt,
    buildMetaContext,
    persistMemoryState,
    selectDialoguesForContext,
    formatDialogueEntriesForDisplay,
    DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC,
    rollSpendWindows,
    dayStart,
    monthStart,
    log,
    actionsMod,
    feedbackCollector = null,
    introspection = null,
    memory = null,
    mind = null
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
            if (typeof buildMetaContext === 'function') {
              print('metaCtx ->', buildMetaContext())
            }
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
          const lines = typeof formatDialogueEntriesForDisplay === 'function'
            ? formatDialogueEntriesForDisplay(list)
            : list.map((entry, idx) => {
                const label = entry && entry.endedAt ? new Date(entry.endedAt).toISOString() : '未知时间'
                const people = (entry?.participants || []).join('、') || '玩家们'
                return `${idx + 1}. ${label} ${people}: ${entry?.summary || ''}`
              })
          lines.forEach(line => print(line))
          break
        }
        case 'context': {
          const k = (rest[0] || '').toLowerCase(); const v = rest[1]
          state.ai.context = state.ai.context || {
            include: true,
            recentCount: DEFAULT_RECENT_COUNT,
            recentWindowSec: DEFAULT_RECENT_WINDOW_SEC,
            recentStoreMax: 200
          }
          switch (k) {
            case 'on': state.ai.context.include = true; print('context include=true'); break
            case 'off': state.ai.context.include = false; print('context include=false'); break
            case 'recent':
              state.ai.context.recentCount = Math.max(0, parseInt(v || String(DEFAULT_RECENT_COUNT), 10))
              state.ai.context.userRecentOverride = true
              print('context recentCount=', state.ai.context.recentCount)
              break
            case 'window':
              state.ai.context.recentWindowSec = Math.max(10, parseInt(v || String(DEFAULT_RECENT_WINDOW_SEC), 10))
              state.ai.context.userWindowOverride = true
              print('context recentWindowSec=', state.ai.context.recentWindowSec)
              break
            case 'recentmax': state.ai.context.recentStoreMax = Math.max(20, parseInt(v || '200', 10)); print('context recentStoreMax=', state.ai.context.recentStoreMax); break
            case 'show':
            default:
              print('context =', state.ai.context)
          }
          break
        }
        // REFS: 反馈/自省/人格 命令
        case 'refs':
        case 'feedback': {
          const k = (rest[0] || '').toLowerCase()
          if (k === 'stats') {
            const stats = feedbackCollector?.getStats?.() || {}
            print('正面反馈:', stats.positive, '| 负面反馈:', stats.negative)
            print('反馈正面率:', (stats.feedbackRatio * 100).toFixed(1) + '%')
            print('动作成功:', stats.actionSuccess, '| 动作失败:', stats.actionFail)
            print('动作成功率:', (stats.actionSuccessRate * 100).toFixed(1) + '%')
          } else if (k === 'recent') {
            const signals = feedbackCollector?.getRecentSignals?.(30 * 60 * 1000) || []
            print('最近30分钟信号数:', signals.length)
            for (const s of signals.slice(-5)) {
              print(`  ${s.isPositive ? '+' : s.isNegative ? '-' : '~'} "${s.botMessage?.slice(0, 30)}..." -> ${s.signals?.map(x => x.type).join(',')}`)
            }
          } else {
            print('用法: .ai feedback stats|recent')
          }
          break
        }
        case 'introspect': {
          const k = (rest[0] || '').toLowerCase()
          if (k === 'now' || k === 'run') {
            print('触发自省...')
            introspection?.runIntrospection?.('manual').then(r => {
              if (r) {
                print('自省完成:', r.self_narrative)
                if (r.insights?.length) print('洞察:', r.insights.join(' | '))
              }
            }).catch(e => print('自省失败:', e?.message))
          } else if (k === 'status') {
            const status = introspection?.getStatus?.() || {}
            print('上次自省:', status.lastRun ? new Date(status.lastRun).toLocaleString() : '无')
            print('历史记录:', status.historyCount, '条')
            print('连续负面:', status.consecutiveNegative)
            print('情感状态:', status.emotionalState?.current, '强度:', status.emotionalState?.intensity)
          } else {
            print('用法: .ai introspect now|status')
          }
          break
        }
        case 'personality': {
          const effective = introspection?.getEffectivePersonality?.() || state.aiPersonality?.traits || {}
          const mods = state.aiPersonality?.modifiers || {}
          print('当前人格特质 (基础+修正):')
          for (const [k, v] of Object.entries(effective)) {
            const mod = mods[k] || 0
            print(`  ${k}: ${v.toFixed(2)}${mod !== 0 ? ` (${mod > 0 ? '+' : ''}${mod.toFixed(2)})` : ''}`)
          }
          print('情感状态:', state.aiEmotionalState?.current || 'content')
          break
        }
        case 'memstats': {
          const stats = memory?.longTerm?.getStats?.() || {}
          print('记忆条目:', stats.totalEntries)
          print('使用次数:', stats.totalUsed)
          print('有效反馈:', stats.totalHelpful, '| 无效反馈:', stats.totalUnhelpful)
          print('有效率:', (stats.effectivenessRate * 100).toFixed(1) + '%')
          break
        }
        case 'mind': {
          const k = (rest[0] || '').toLowerCase()
          if (k === 'status' || !k) {
            const status = mind?.getStatus?.() || {}
            print('运行中:', status.running ? '是' : '否')
            print('惊讶度:', (status.surprise * 100).toFixed(0) + '%')
            print('好奇:', status.curious || '无')
            print('已知状态:', status.knownStates)
          } else if (k === 'history') {
            const status = mind?.getStatus?.() || {}
            const history = status.history || []
            if (!history.length) {
              print('暂无记录')
            } else {
              for (const h of history) {
                print(`  ${(h.surprise * 100).toFixed(0)}% ${h.thought}`)
              }
            }
          } else if (k === 'follows') {
            const pattern = rest.slice(1).join(' ') || ''
            if (!pattern) {
              print('用法: .ai mind follows <状态片段>')
            } else {
              const results = mind?.whatFollows?.(pattern) || []
              if (!results.length) {
                print(`不知道 ${pattern} 之后会发生什么`)
              } else {
                for (const r of results.slice(0, 5)) {
                  print(`  ${r.from} → ${r.to} (${(r.probability * 100).toFixed(0)}%, ${r.count}次)`)
                }
              }
            }
          } else {
            print('用法: .ai mind [status|history|follows <模式>]')
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
