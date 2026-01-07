#!/usr/bin/env node

const path = require('path')

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.replace(/^--+/, '')
    const next = argv[i + 1]
    const hasValue = next && !next.startsWith('--')
    if (hasValue) { out[key] = next; i++; continue }
    out[key] = true
  }
  return out
}

function usage () {
  return [
    'Usage:',
    '  node scripts/inspect-injected-context.js --player <name> [--query <text>] [--memory-limit <n>]',
    '',
    'Prints the exact snippets injected into LLM context for that player:',
    '- long-term memory system message (memory.longTerm.buildContext)',
    '- chat context system message (context bus XML + dialogue memory)',
    '',
    'Examples:',
    "  node scripts/inspect-injected-context.js --player Shiki --query '我家在哪'",
    '  node scripts/inspect-injected-context.js --player Shiki --memory-limit 8'
  ].join('\n')
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const player = args.player || args.username || args.user || args.p
  const query = typeof args.query === 'string' ? args.query : ''
  const memoryLimitRaw = args['memory-limit'] || args.memoryLimit || args.limit
  const memoryLimit = memoryLimitRaw != null ? Number(memoryLimitRaw) : null

  if (!player) {
    process.stderr.write(usage() + '\n')
    process.exitCode = 2
    return
  }

  const projectRoot = path.resolve(__dirname, '..')
  const memoryStore = require(path.join(projectRoot, 'bot_impl', 'memory-store'))
  const H = require(path.join(projectRoot, 'bot_impl', 'ai-chat-helpers'))
  const { prepareAiState } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'state-init'))
  const { createMemoryService } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'memory'))
  const { createContextBus } = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'context-bus'))
  const defaults = require(path.join(projectRoot, 'bot_impl', 'ai-chat', 'config'))

  const state = {}
  const bot = { username: process.env.BOT_NAME || 'bot' }
  const log = null
  const now = () => Date.now()
  const dayStart = (t = now()) => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const monthStart = (t = now()) => {
    const d = new Date(t)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  const defaultsBundle = {
    DEFAULT_MODEL: defaults.DEFAULT_MODEL,
    DEFAULT_BASE: defaults.DEFAULT_BASE,
    DEFAULT_PATH: defaults.DEFAULT_PATH,
    DEFAULT_TIMEOUT_MS: defaults.DEFAULT_TIMEOUT_MS,
    DEFAULT_RECENT_COUNT: defaults.DEFAULT_RECENT_COUNT,
    DEFAULT_RECENT_WINDOW_SEC: defaults.DEFAULT_RECENT_WINDOW_SEC,
    DEFAULT_MEMORY_STORE_MAX: defaults.DEFAULT_MEMORY_STORE_MAX,
    buildDefaultContext: defaults.buildDefaultContext
  }

  const memory = createMemoryService({ state, log, memoryStore, defaults: defaultsBundle, bot, now })
  const persistedMemory = memoryStore.load()
  const persistedEvolution = memoryStore.loadEvolution()

  prepareAiState(state, {
    defaults: defaultsBundle,
    persistedMemory,
    persistedEvolution,
    trimConversationStore: memory.dialogue.trimStore,
    updateWorldMemoryZones: memory.longTerm.updateWorldZones,
    dayStart,
    monthStart
  })

  const contextBus = createContextBus({ state, now })

  const memoryCtxResult = await memory.longTerm.buildContext({
    query,
    withRefs: true,
    ...(Number.isFinite(memoryLimit) && memoryLimit > 0 ? { limit: Math.floor(memoryLimit) } : {})
  })
  const memoryCtx = typeof memoryCtxResult === 'string' ? memoryCtxResult : (memoryCtxResult?.text || '')
  const memoryRefs = Array.isArray(memoryCtxResult?.refs) ? memoryCtxResult.refs : []

  const ctx = state.ai?.context || defaults.buildDefaultContext()
  const maxEntries = Number.isFinite(ctx.recentCount) ? Math.max(1, Math.floor(ctx.recentCount)) : defaults.DEFAULT_RECENT_COUNT
  const windowSec = Number.isFinite(ctx.recentWindowSec) ? Math.max(0, Math.floor(ctx.recentWindowSec)) : defaults.DEFAULT_RECENT_WINDOW_SEC
  const xmlCtx = contextBus.buildXml({ maxEntries, windowSec, includeGaps: true })
  const conv = memory.dialogue.buildPrompt(player)
  const contextPrompt = [`当前对话玩家: ${player}`, xmlCtx, conv].filter(Boolean).join('\n\n')

  const blocks = [
    `player: ${player}`,
    query ? `query: ${query}` : null,
    `memory.limit: ${Number.isFinite(memoryLimit) && memoryLimit > 0 ? Math.floor(memoryLimit) : (state.ai?.context?.memory?.max || 6)}`,
    '',
    '--- injected: memoryCtx (system) ---',
    memoryCtx || '(empty)',
    memoryRefs.length ? `refs: ${memoryRefs.join(', ')}` : null,
    '',
    '--- injected: contextPrompt (system) ---',
    contextPrompt || '(empty)'
  ].filter(v => v != null)

  process.stdout.write(blocks.join('\n') + '\n')
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err?.message || err) + '\n')
  process.exitCode = 1
})

