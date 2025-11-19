/**
 * Config objects used by the MaiCore-style prompt + memory system.
 *
 * External deps expected at runtime:
 * - json-repair (https://www.npmjs.com/package/json-repair) to parse non-strict JSON
 * - ORM / DAO implementation that persists ThinkingBack records
 * - async LLM client capable of returning text completions
 */

'use strict'

const defaultToolList = [
  'chat_history_search',
  'jargon_lookup',
  'player_profile',
  'mc_server_state'
]

const globalConfig = {
  botName: 'MaiBot',
  timezone: 'Asia/Shanghai',
  locale: 'zh',
  promptLanguage: 'zh',
  enableDebugLog: true
}

const modelConfig = {
  model: 'gpt-4o-mini',
  temperature: 0.4,
  maxTokens: 1024,
  stop: []
}

const memoryRetrievalConfig = {
  maxAgentIterations: 4,
  maxCacheRecords: 5,
  jargonRelookupRatio: 0.4,
  foundAnswerRelookupRatio: 0.2,
  language: 'zh',
  enableTools: [...defaultToolList]
}

module.exports = {
  globalConfig,
  modelConfig,
  memoryRetrievalConfig
}

