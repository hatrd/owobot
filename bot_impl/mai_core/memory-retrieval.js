'use strict'

const { jsonrepair } = require('jsonrepair')
const { getLogger } = require('../logging')
const {
  registerPromptTemplate,
  buildPromptFromTemplate
} = require('./prompt-framework')
const { globalConfig, modelConfig, memoryRetrievalConfig } = require('./config')
const { getToolRegistry, initBuiltinTools, registerMemoryRetrievalTool } = require('./memory-tools')
const { createThinkingBackStore } = require('./thinking-back-store')
const { formatDateTimeTz } = require('../time-utils')

const logger = getLogger('mai.memory')

const MAIN_PROMPT_SKELETON = `{knowledge_prompt}{tool_info_block}{extra_info_block}
{expression_habits_block}{memory_retrieval}

你正在{scene_label}，以下是最近内容：
{time_block}
{dialogue_prompt}

{reply_target_block}。
{planner_reasoning}
{identity}
{chat_prompt}请阅读以上内容，生成一句口语化回复，{mood_state}
尽量简短。{keywords_reaction_prompt}允许适度个性化表达。
{reply_style}
{moderation_prompt}不要输出多余字符（前后缀、冒号、引号、括号、表情、@ 等）。
现在你说：`

const QUESTION_PROMPT = `
你的名字是{bot_name}。现在是{time_now}。
群里正在进行的聊天内容：
{chat_history}

{recent_query_history}

现在，{sender}发送了内容:{target_message}, 你想要回复ta。
请仔细分析聊天内容，考虑以下几点：
1. 对话中是否提到了过去发生的事情、人物、事件或信息
2. 是否有需要回忆的内容（比如"之前说过"、"上次"、"以前"等）
3. 是否有需要查找历史信息的问题
4. 是否需要查找某人的信息（person: 如果对话中提到人名、昵称、用户ID等，需要查询该人物的详细信息）
5. 是否有问题可以搜集信息帮助你聊天
6. 对话中是否包含黑话、俚语、缩写等可能需要查询的概念

重要提示：
- 每次只能提出一个问题，选择最需要查询的关键问题
- 如果"最近已查询的问题和结果"中已经包含了类似的问题，请避免重复生成
- 如果之前已经查询过某个问题但未找到答案，可以尝试用不同方式提问
- 如果之前已经查询过某个问题并找到了答案，可以直接参考已有结果，不需要重复查询

如果你认为需要从记忆中检索信息来回答，请：
1. 先识别对话中可能需要查询的概念（黑话/俚语/缩写/专有名词等关键词），放入"concepts"字段
2. 识别对话中提到的人物名称（人名、昵称等），放入"person"字段
3. 然后根据上下文提出一个最关键的问题来帮助你回复目标消息，放入"questions"字段

输出JSON格式，包含三个字段：
- "concepts": 概念列表
- "person": 人物名称列表
- "questions": 问题数组（要么空数组，要么只包含一个问题）

请只输出JSON对象，不要输出其他内容。
`

const REACT_PROMPT = `
你的名字是{bot_name}。现在是{time_now}。
你正在参与聊天，你需要搜集信息来回答问题，帮助你参与聊天。
你需要通过 Think -> Action -> Observation 的循环来回答问题。

最大查询轮数：{max_iterations}轮（当前第{current_iteration}轮，剩余{remaining_iterations}轮）
必须尽快得出答案，避免不必要的查询。严格使用检索到的信息回答。

历史推理：
{scratchpad}

工具列表：
{tool_block}

问题：{question}
当前聊天上下文：
{chat_context}

在 Think 步骤中，必须明确给出 found_answer(answer="…") 或 not_enough_info(reason="…")。
当需要查询信息时，按如下格式输出：
Action: 工具名
ActionInput: {"key":"value"}
`

const REACT_FINAL_PROMPT = `
你的名字是{bot_name}。现在是{time_now}。
你已经使用完允许的查询次数。请根据已有的 Observation 做出总结。

历史推理：
{scratchpad}

问题：{question}
聊天上下文：
{chat_context}

在 Think 步骤中，必须输出 found_answer(answer="…") 或 not_enough_info(reason="…")。
`

function initMemoryRetrievalPrompt (toolOptions) {
  registerPromptTemplate('memory_retrieval_question_prompt', QUESTION_PROMPT)
  registerPromptTemplate('memory_retrieval_react_prompt', REACT_PROMPT)
  registerPromptTemplate('memory_retrieval_react_final_prompt', REACT_FINAL_PROMPT)

  registerPromptTemplate(
    'chat_prompt_group',
    MAIN_PROMPT_SKELETON.replace('{scene_label}', '群聊中')
  )
  registerPromptTemplate(
    'chat_prompt_private',
    MAIN_PROMPT_SKELETON.replace('{scene_label}', '私聊中')
  )
  registerPromptTemplate(
    'chat_prompt_rewrite',
    MAIN_PROMPT_SKELETON.replace('{scene_label}', '进行改写任务')
  )
  initBuiltinTools(toolOptions)
}

function safeJsonParse (text) {
  if (!text) return { concepts: [], person: [], questions: [] }
  try {
    return JSON.parse(jsonrepair(text))
  } catch (err) {
    logger.warn('json repair failed', err?.message || err)
    return { concepts: [], person: [], questions: [] }
  }
}

function formatRecentQueries (records = []) {
  if (!records.length) return '最近没有查询记录。'
  const lines = records.map((item) => {
    return `- 问题：${item.question} ｜ 结果：${item.answer || '无'}`
  })
  return `最近已查询的问题和结果：\n${lines.join('\n')}`
}

function parseAgentResponse (text) {
  const actionMatch = text.match(/Action\s*:\s*([a-zA-Z0-9_\-]+)/)
  const inputMatch = text.match(/ActionInput\s*:\s*(\{[\s\S]*\})/)
  const foundMatch = text.match(/found_answer\s*\(\s*answer\s*=\s*"([\s\S]*?)"\s*\)/)
  const notEnoughMatch = text.match(/not_enough_info\s*\(\s*reason\s*=\s*"([\s\S]*?)"\s*\)/)
  let actionInput = null
  if (inputMatch) {
    try {
      actionInput = JSON.parse(jsonrepair(inputMatch[1]))
    } catch (err) {
      logger.warn('failed to parse action input', err?.message || err)
    }
  }
  return {
    action: actionMatch ? actionMatch[1].trim() : null,
    actionInput,
    foundAnswer: foundMatch ? foundMatch[1].trim() : null,
    notEnoughInfo: notEnoughMatch ? notEnoughMatch[1].trim() : null
  }
}

function createMemoryRetrievalSystem ({
  llmClient,
  thinkingBackStore = createThinkingBackStore(),
  toolRegistry = getToolRegistry(),
  config = memoryRetrievalConfig,
  now = () => new Date(),
  random = Math.random
} = {}) {
  if (!llmClient || typeof llmClient.complete !== 'function') {
    throw new Error('llmClient.complete(prompt, options) is required')
  }

  async function buildQuestionPayload (payload) {
    const recent = await thinkingBackStore.fetchRecent(payload.chatId, config.maxCacheRecords)
    const prompt = await buildPromptFromTemplate(
      'memory_retrieval_question_prompt',
      {},
      {
        bot_name: globalConfig.botName,
        time_now: formatDateTimeTz(now()),
        chat_history: payload.chatHistory || '',
        recent_query_history: formatRecentQueries(recent),
        sender: payload.sender || '玩家',
        target_message: payload.targetMessage || ''
      }
    )
    const completion = await llmClient.complete({
      prompt,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens
    })
    logger.debug('question prompt result', completion)
    const parsed = safeJsonParse(completion)
    logger.info('memory question generated', {
      question: parsed.questions?.[0] || null,
      conceptCount: parsed.concepts?.length || 0,
      personCount: parsed.person?.length || 0
    })
    return { parsed, prompt, completion, recent }
  }

  async function initialLookup ({ concepts = [], person = [] }) {
    const snippets = []
    if (concepts.length) {
      try {
        const res = await toolRegistry.run('jargon_lookup', { terms: concepts })
        if (res && res.length) snippets.push(`黑话解释：${JSON.stringify(res)}`)
      } catch (err) {
        logger.warn('jargon lookup failed', err?.message || err)
      }
    }
    if (person.length) {
      try {
        const res = await toolRegistry.run('player_profile', { players: person })
        if (res && res.length) snippets.push(`人物档案：${JSON.stringify(res)}`)
      } catch (err) {
        logger.warn('player profile lookup failed', err?.message || err)
      }
    }
    return snippets.join('\n')
  }

  function shouldReuseCache (entry) {
    if (!entry) return false
    if (entry.foundAnswer) {
      return random() >= config.foundAnswerRelookupRatio
    }
    return random() >= config.jargonRelookupRatio
  }

  async function runToolAction (toolName, input, iteration) {
    try {
      const result = await toolRegistry.run(toolName, input)
      logger.debug('tool result', toolName, result)
      return { ok: true, toolName, input, output: result, iteration }
    } catch (err) {
      logger.warn('tool error', toolName, err?.message || err)
      return { ok: false, toolName, input, error: err?.message || String(err), iteration }
    }
  }

  async function runReactAgent ({ question, chatContext }) {
    const maxIterations = config.maxAgentIterations
    const scratchpad = []
    const steps = []
    let answerText = ''
    let foundAnswer = false

    for (let iter = 1; iter <= maxIterations; iter++) {
      const remaining = maxIterations - iter
      const promptName = remaining === 0 ? 'memory_retrieval_react_final_prompt' : 'memory_retrieval_react_prompt'
      const prompt = await buildPromptFromTemplate(
        promptName,
        {},
        {
          bot_name: globalConfig.botName,
          time_now: formatDateTimeTz(now()),
          max_iterations: maxIterations,
          current_iteration: iter,
          remaining_iterations: remaining,
          tool_block: toolRegistry.list().map((t) => `${t.name}: ${t.description}`).join('\n'),
          question,
          chat_context: chatContext,
          scratchpad: scratchpad.join('\n') || '（尚无推理记录）'
        }
      )
      const completion = await llmClient.complete({
        prompt,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        maxTokens: modelConfig.maxTokens
      })
      logger.info('memory react iteration', { iter, isFinal: remaining === 0 })
      steps.push({ type: 'llm', iteration: iter, prompt, output: completion })
      scratchpad.push(completion)
      const parsed = parseAgentResponse(completion)
      if (parsed.foundAnswer) {
        answerText = parsed.foundAnswer
        foundAnswer = true
        break
      }
      if (parsed.notEnoughInfo) {
        answerText = parsed.notEnoughInfo
        foundAnswer = false
        break
      }
      if (parsed.action && remaining > 0) {
        const observation = await runToolAction(parsed.action, parsed.actionInput, iter)
        steps.push({ type: 'tool', ...observation })
        scratchpad.push(`Observation(${parsed.action}): ${JSON.stringify(observation.output ?? observation.error)}`)
        if (observation.ok && observation.output && typeof observation.output === 'string') {
          // allow model to use observation as answer if it emitted found_answer inline
          if (/found_answer\s*\(/i.test(observation.output)) {
            const auto = parseAgentResponse(observation.output)
            if (auto.foundAnswer) {
              answerText = auto.foundAnswer
              foundAnswer = true
              break
            }
          }
        }
      } else if (remaining > 0) {
        // missing action but still have rounds, continue
        continue
      }
    }

    return { foundAnswer, answerText, thinkingSteps: steps }
  }

  async function processSingleQuestion ({ chatId, question, chatContext }) {
    if (!question) return null
    const cached = await thinkingBackStore.findByQuestion(chatId, question)
    if (cached && shouldReuseCache(cached)) {
      logger.info('memory cache hit', { question })
      return {
        question,
        foundAnswer: cached.foundAnswer,
        answer: cached.answer,
        thinkingSteps: cached.thinkingSteps || [],
        fromCache: true
      }
    }
    const reactResult = await runReactAgent({ question, chatContext })
    await thinkingBackStore.saveThinkingResult({
      chatId,
      question,
      context: chatContext,
      foundAnswer: reactResult.foundAnswer,
      answer: reactResult.answerText,
      thinkingSteps: reactResult.thinkingSteps
    })
    return {
      question,
      foundAnswer: reactResult.foundAnswer,
      answer: reactResult.answerText,
      thinkingSteps: reactResult.thinkingSteps,
      fromCache: false
    }
  }

  async function buildMemoryRetrievalPrompt ({
    chatId,
    chatHistory,
    sender,
    targetMessage,
    chatContext
  }) {
    const questionPayload = await buildQuestionPayload({
      chatId,
      chatHistory,
      sender,
      targetMessage
    })
    const { parsed } = questionPayload
    const initialInfo = await initialLookup({
      concepts: parsed.concepts || [],
      person: parsed.person || []
    })
    const pieces = []
    if (initialInfo) pieces.push(initialInfo)

    const questionResults = []
    if (Array.isArray(parsed.questions) && parsed.questions.length) {
      for (const q of parsed.questions) {
        const result = await processSingleQuestion({ chatId, question: q, chatContext })
        if (result) questionResults.push(result)
      }
    } else if (questionPayload.recent?.length) {
      // no question, reuse cache
      pieces.push(formatRecentQueries(questionPayload.recent))
    }

    for (const item of questionResults) {
      pieces.push(`问题：${item.question}\n答案：${item.answer || '未找到'}`)
    }

    if (!pieces.length) {
      pieces.push('最近没有新的回忆。')
    }

    return {
      text: `你回忆起了以下信息：\n${pieces.join('\n')}\n如果与回复内容相关，可以参考这些回忆的信息。`,
      debug: {
        questionPrompt: questionPayload.prompt,
        completion: questionPayload.completion,
        questionResults
      }
    }
  }

  return {
    buildMemoryRetrievalPrompt,
    processSingleQuestion,
    registerMemoryRetrievalTool,
    toolRegistry,
    initBuiltinTools
  }
}

module.exports = {
  initMemoryRetrievalPrompt,
  createMemoryRetrievalSystem
}
