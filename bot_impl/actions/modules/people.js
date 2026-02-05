const peopleStore = require('../../people-store')
const { createPeopleService } = require('../../ai-chat/people')

function parseBool (value, fallback = false) {
  if (value == null) return fallback
  if (value === true) return true
  const v = String(value).trim().toLowerCase()
  if (!v) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return fallback
}

function fold (value) {
  return String(value || '').trim().toLowerCase()
}

module.exports = function loadPeopleActions (ctx) {
  const { bot, register, ok, fail } = ctx
  const state = bot?.state || (bot.state = {})
  const people = createPeopleService({ state, peopleStore })

  register('people_commitments_clear', async (args = {}) => {
    const mode = fold(args.mode || args.m || 'done')
    const playerNeedle = fold(args.player || args.name || '')
    const matchNeedle = fold(args.match || args.q || '')
    const confirm = parseBool(args.confirm, false)

    const destructive = (mode === 'all' || mode === 'pending')
    if (destructive && !confirm) {
      return fail('需要确认：请加 confirm=true（mode=all|pending 会删除未完成承诺）', { blocks: ['confirm_required'] })
    }

    const supported = new Set(['done', 'closed', 'pending', 'all', 'failed', 'ongoing'])
    if (!supported.has(mode)) {
      return fail('不支持的 mode；可选 done|pending|failed|ongoing|all', { blocks: ['bad_args'] })
    }

    const shouldRemove = (c) => {
      if (!c) return false
      if (playerNeedle && fold(c.playerKey || c.player) !== playerNeedle) return false
      if (matchNeedle && !fold(c.action).includes(matchNeedle)) return false
      if (mode === 'all') return true
      if (mode === 'pending') return c.status === 'pending'
      if (mode === 'failed') return c.status === 'failed'
      if (mode === 'ongoing') return c.status === 'ongoing'
      if (mode === 'closed') return c.status !== 'pending'
      // done (default): only remove finished/failed
      return c.status === 'done' || c.status === 'failed'
    }

    people.load()
    const slice = state.aiPeople
    const raw = Array.isArray(slice?.commitments) ? slice.commitments : []
    const normalized = people.listCommitments()
    const removals = normalized.filter(shouldRemove)
    if (!removals.length) {
      return ok('没有匹配的承诺需要清理', { removed: 0, before: normalized.length, after: normalized.length })
    }

    const removeIds = new Set(removals.map(x => x.id).filter(Boolean))
    const removeKeys = new Set(removals.map(x => `${fold(x.playerKey)}::${fold(x.action)}`))

    const kept = raw.filter((rec) => {
      if (!rec || typeof rec !== 'object') return false
      const id = typeof rec.id === 'string' ? rec.id : ''
      if (id && removeIds.has(id)) return false
      const key = `${fold(rec.playerKey || rec.player || rec.name)}::${fold(rec.action)}`
      if (removeKeys.has(key)) return false
      return true
    })

    slice.commitments = kept
    const persisted = people.persist()

    const before = normalized.length
    const after = people.listCommitments().length
    const removed = before - after
    const preview = removals.slice(0, 8).map(c => `${c.player || c.playerKey}：${c.action}（${c.status}）`)

    return ok(`已清理承诺 ${removed} 条${persisted ? '' : '（未持久化）'}`, {
      removed,
      before,
      after,
      persisted,
      preview
    })
  })
}
