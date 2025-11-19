'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { getLogger } = require('../logging')

const logger = getLogger('mai.prompt')

class Prompt {
  constructor (name, template) {
    this.name = name
    this.template = template
    if (typeof template !== 'string') {
      throw new Error(`Prompt template for ${name} must be a string`)
    }
  }

  format (values) {
    let out = this.template
    for (const [key, value] of Object.entries(values || {})) {
      const safe = value == null ? '' : String(value)
      out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), safe)
    }
    return out
  }
}

class PromptManager {
  constructor () {
    this.globalPrompts = new Map()
    this.scopedPrompts = new Map()
    this.asyncContext = new AsyncLocalStorage()
  }

  register (prompt, { contextId } = {}) {
    if (!(prompt instanceof Prompt)) {
      throw new Error('register() expects a Prompt instance')
    }
    if (contextId) {
      if (!this.scopedPrompts.has(contextId)) this.scopedPrompts.set(contextId, new Map())
      this.scopedPrompts.get(contextId).set(prompt.name, prompt)
      logger.debug('registered scoped prompt', prompt.name, contextId)
      return prompt
    }
    this.globalPrompts.set(prompt.name, prompt)
    logger.debug('registered prompt', prompt.name)
    return prompt
  }

  getCurrentContextId () {
    return this.asyncContext.getStore()
  }

  getPrompt (name) {
    const ctxId = this.getCurrentContextId()
    if (ctxId && this.scopedPrompts.has(ctxId)) {
      const scoped = this.scopedPrompts.get(ctxId)
      if (scoped.has(name)) return scoped.get(name)
    }
    return this.globalPrompts.get(name)
  }

  async withScope (contextId, fn) {
    if (!contextId) return fn()
    return await this.asyncContext.run(contextId, fn)
  }
}

const globalPromptManager = new PromptManager()

async function resolvePromptBlocks (blockFactories = {}) {
  const entries = Object.entries(blockFactories).map(async ([key, factory]) => {
    try {
      const value = await factory()
      return [key, value ?? '']
    } catch (err) {
      logger.warn('block factory failed', key, err?.message || err)
      return [key, '']
    }
  })
  const resolved = await Promise.all(entries)
  return Object.fromEntries(resolved)
}

function registerPromptTemplate (name, template) {
  const prompt = new Prompt(name, template)
  return globalPromptManager.register(prompt)
}

async function buildPromptFromTemplate (name, blockFactories, extraValues = {}) {
  const prompt = globalPromptManager.getPrompt(name)
  if (!prompt) throw new Error(`Prompt ${name} not registered`)
  const resolvedBlocks = await resolvePromptBlocks(blockFactories)
  const payload = { ...resolvedBlocks, ...extraValues }
  return prompt.format(payload)
}

module.exports = {
  Prompt,
  PromptManager,
  globalPromptManager,
  registerPromptTemplate,
  buildPromptFromTemplate,
  resolvePromptBlocks
}

