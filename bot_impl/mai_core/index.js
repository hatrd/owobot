'use strict'

const { initMemoryRetrievalPrompt, createMemoryRetrievalSystem } = require('./memory-retrieval')
const { registerPromptTemplate, buildPromptFromTemplate } = require('./prompt-framework')
const { globalConfig, modelConfig, memoryRetrievalConfig } = require('./config')
const { registerMemoryRetrievalTool, getToolRegistry, initBuiltinTools } = require('./memory-tools')
const { createThinkingBackStore } = require('./thinking-back-store')
const { createThinkingBackDao } = require('./thinking-back-dao')

module.exports = {
  initMemoryRetrievalPrompt,
  createMemoryRetrievalSystem,
  registerPromptTemplate,
  buildPromptFromTemplate,
  globalConfig,
  modelConfig,
  memoryRetrievalConfig,
  registerMemoryRetrievalTool,
  getToolRegistry,
  initBuiltinTools,
  createThinkingBackStore,
  createThinkingBackDao
}
