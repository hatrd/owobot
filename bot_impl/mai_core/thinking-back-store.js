'use strict'

const { getLogger } = require('../logging')

const logger = getLogger('mai.memory.store')

function createThinkingBackStore ({ dao, now = () => Date.now() } = {}) {
  const inMemory = []

  async function fetchRecent (chatId, limit = 5) {
    if (dao?.fetchRecent) return await dao.fetchRecent(chatId, limit)
    return inMemory
      .filter((item) => item.chatId === chatId)
      .sort((a, b) => b.updateTime - a.updateTime)
      .slice(0, limit)
  }

  async function findByQuestion (chatId, question) {
    if (!question) return null
    if (dao?.findByQuestion) return await dao.findByQuestion(chatId, question)
    return (
      inMemory
        .filter((item) => item.chatId === chatId && item.question === question)
        .sort((a, b) => b.updateTime - a.updateTime)[0] || null
    )
  }

  async function insert (record) {
    const payload = {
      id: record?.id ?? `mem_${now()}_${Math.random().toString(16).slice(2)}`,
      chatId: record.chatId,
      question: record.question,
      context: record.context,
      foundAnswer: Boolean(record.foundAnswer),
      answer: record.answer || '',
      thinkingSteps: record.thinkingSteps || [],
      createTime: record.createTime ?? now(),
      updateTime: record.updateTime ?? now()
    }
    if (dao?.insert) return await dao.insert(payload)
    inMemory.push(payload)
    return payload
  }

  async function update (id, updates) {
    if (dao?.update) return await dao.update(id, updates)
    const target = inMemory.find((item) => item.id === id)
    if (!target) return null
    Object.assign(target, updates, { updateTime: now() })
    return target
  }

  async function saveThinkingResult ({ chatId, question, context, foundAnswer, answer, thinkingSteps }) {
    const existing = await findByQuestion(chatId, question)
    if (existing) {
      logger.debug('update ThinkingBack entry', chatId, question)
      return await update(existing.id, {
        context,
        foundAnswer,
        answer,
        thinkingSteps,
        updateTime: now()
      })
    }
    logger.debug('insert ThinkingBack entry', chatId, question)
    return await insert({
      chatId,
      question,
      context,
      foundAnswer,
      answer,
      thinkingSteps,
      createTime: now(),
      updateTime: now()
    })
  }

  return {
    fetchRecent,
    findByQuestion,
    insert,
    update,
    saveThinkingResult
  }
}

module.exports = {
  createThinkingBackStore
}

