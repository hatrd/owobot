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

function parseIntClamped (value, fallback, min, max) {
  if (value == null) return fallback
  const n = Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

module.exports = function loadPeopleActions (ctx) {
  const { bot, register, ok, fail } = ctx
  const state = bot?.state || (bot.state = {})
  const people = createPeopleService({ state, peopleStore })

  register('people_commitments_list', async (args = {}) => {
    const mode = fold(args.mode || args.m || 'pending')
    const playerNeedle = fold(args.player || args.name || '')
    const matchNeedle = fold(args.match || args.q || '')
    const limit = parseIntClamped(args.limit || args.n, 50, 1, 200)
    const withContext = parseBool(args.context || args.ctx, true)

    const supported = new Set(['pending', 'closed', 'all'])
    if (!supported.has(mode)) {
      return fail('不支持的 mode；可选 pending|closed|all', { blocks: ['bad_args'] })
    }

    people.load()
    const all = people.listCommitments()
    let items = all
    if (mode === 'pending') items = items.filter(c => c.status === 'pending')
    if (mode === 'closed') items = items.filter(c => c.status !== 'pending')
    if (playerNeedle) items = items.filter(c => fold(c.playerKey || c.player) === playerNeedle)
    if (matchNeedle) items = items.filter(c => fold(c.action).includes(matchNeedle))

    const returned = items.slice(0, limit)
    const context = (() => {
      if (!withContext) return null
      if (!returned.length) return null
      const title = mode === 'pending' ? '承诺（未完成）：' : (mode === 'closed' ? '承诺（已关闭）：' : '承诺（全部）：')
      const lines = [title]
      for (const c of returned) {
        const suffix = c.status === 'pending' ? '' : `（${c.status}）`
        lines.push(`${c.player}：${c.action}${suffix}`)
      }
      return lines.length > 1 ? lines.join('\n') : null
    })()

    return ok(`承诺 ${returned.length}/${items.length} 条`, {
      mode,
      returned: returned.length,
      total: items.length,
      items: returned,
      context
    })
  })

  register('people_commitments_dedupe', async (args = {}) => {
    const mode = fold(args.mode || args.m || 'pending')
    const playerNeedle = String(args.player || args.name || '').trim()
    const matchNeedle = String(args.match || args.q || '').trim()
    const keep = fold(args.keep || 'shortest')
    const thresholdRaw = args.threshold ?? args.t
    const threshold = thresholdRaw == null ? undefined : Number.parseFloat(String(thresholdRaw))
    const minOverlapHitsRaw = args.min_hits ?? args.minHits ?? args.hits
    const minOverlapHits = minOverlapHitsRaw == null ? undefined : Number.parseInt(String(minOverlapHitsRaw), 10)
    const minLcsRaw = args.min_lcs ?? args.minLcs ?? args.lcs
    const minCommonSubstrLen = minLcsRaw == null ? undefined : Number.parseInt(String(minLcsRaw), 10)
    const apply = parseBool(args.apply ?? args.confirm, false)
    const previewLimit = parseIntClamped(args.preview || args.p, 12, 1, 50)

    if (!people?.dedupeCommitments) return fail('people service not available', { blocks: ['internal_error'] })

    const result = people.dedupeCommitments({
      mode,
      player: playerNeedle,
      match: matchNeedle,
      keep,
      threshold,
      minOverlapHits,
      minCommonSubstrLen,
      previewLimit,
      persist: apply
    })

    if (!result?.ok) {
      return fail('dedupe failed', { ...result, blocks: ['internal_error'] })
    }

    return ok(`${apply ? '已应用' : 'dry-run'}：去重移除 ${result.removed || 0} 条`, result)
  })

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
