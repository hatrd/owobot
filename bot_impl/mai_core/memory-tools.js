'use strict'

const { getLogger } = require('../logging')

const logger = getLogger('mai.memory.tools')

class ToolRegistry {
  constructor () {
    this.tools = new Map()
  }

  register (tool) {
    const { name, description, handler } = tool || {}
    if (!name || typeof name !== 'string') throw new Error('tool name required')
    if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`)
    this.tools.set(name, { name, description: description || '', handler })
    logger.debug('registered tool', name)
    return () => this.tools.delete(name)
  }

  list () {
    return Array.from(this.tools.values()).map((t) => ({ name: t.name, description: t.description }))
  }

  async run (name, input) {
    if (!this.tools.has(name)) throw new Error(`tool ${name} not registered`)
    return await this.tools.get(name).handler(input)
  }
}

const defaultToolRegistry = new ToolRegistry()

function registerMemoryRetrievalTool (tool) {
  return defaultToolRegistry.register(tool)
}

function getToolRegistry () {
  return defaultToolRegistry
}

function initBuiltinTools ({
  chatHistorySearch = async () => [],
  jargonLookup = async () => [],
  playerInfoLookup = async () => [],
  mcServerLookup = async () => []
} = {}) {
  registerMemoryRetrievalTool({
    name: 'chat_history_search',
    description: '按关键词或时间范围搜索聊天摘要',
    handler: async (input = {}) => {
      return await chatHistorySearch(input)
    }
  })

  registerMemoryRetrievalTool({
    name: 'jargon_lookup',
    description: '查询黑话/俚语/缩写的解释',
    handler: async (input = {}) => {
      return await jargonLookup(input)
    }
  })

  registerMemoryRetrievalTool({
    name: 'player_profile',
    description: '查询玩家/人物档案信息',
    handler: async (input = {}) => {
      return await playerInfoLookup(input)
    }
  })

  registerMemoryRetrievalTool({
    name: 'mc_server_state',
    description: 'Minecraft 服务器/方块事件/行为日志检索',
    handler: async (input = {}) => {
      return await mcServerLookup(input)
    }
  })
}

module.exports = {
  ToolRegistry,
  getToolRegistry,
  registerMemoryRetrievalTool,
  initBuiltinTools
}

