import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatExecutor } from '../bot_impl/ai-chat/executor.js'
import { createPulseService } from '../bot_impl/ai-chat/pulse.js'
import H from '../bot_impl/ai-chat-helpers.js'

const defaults = {
  DEFAULT_MODEL: 'deepseek-chat',
  DEFAULT_BASE: 'https://example.invalid',
  DEFAULT_PATH: '/v1/chat/completions',
  DEFAULT_TIMEOUT_MS: 1000,
  DEFAULT_RECENT_COUNT: 12,
  DEFAULT_RECENT_WINDOW_SEC: 300,
  DEFAULT_MEMORY_STORE_MAX: 20,
  buildDefaultContext: () => ({ include: true, game: {}, memory: {} })
}

function waitFor (predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function makeHarness ({ llmContent }) {
  const sent = []
  const toolRuns = []
  const state = {
    ai: {
      enabled: true,
      key: 'test-key',
      baseUrl: 'https://example.invalid',
      path: '/v1/chat/completions',
      model: 'deepseek-chat',
      context: { include: true, recentCount: 12, recentWindowSec: 300 },
      maxTokensPerCall: 128,
      maxToolCalls: 2,
      maxReplyLen: 120
    },
    aiRecent: [],
    aiRecentSeq: 0,
    aiPulse: {},
    aiStats: { global: [], perUser: new Map() },
    aiSpend: {
      day: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      month: { start: 0, inTok: 0, outTok: 0, cost: 0 },
      total: { inTok: 0, outTok: 0, cost: 0 }
    }
  }
  const oldFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: llmContent } }],
      usage: { prompt_tokens: 10, completion_tokens: 12 }
    })
  })

  const bot = {
    username: 'owkowk',
    entity: { position: { x: 0, y: 64, z: 0 } },
    chat: (text) => { sent.push(String(text)) }
  }
  const memory = {
    longTerm: {
      buildContext: async () => ({ text: '', refs: [] }),
      extractForgetCommand: () => null,
      extractCommand: () => null,
      persistState: () => {}
    },
    dialogue: {
      buildPrompt: () => '',
      maybeRunAggregation: () => {},
      queueSummary: () => {}
    }
  }
  const contextBus = {
    buildXml: () => '',
    getStore: () => [],
    pushBot: () => {},
    pushBotFrom: () => {},
    pushPlayer: () => {},
    pushEvent: () => {},
    pushTool: () => {}
  }
  const pulse = createPulseService({
    state,
    bot,
    log: null,
    now: () => Date.now(),
    H,
    defaults,
    canAfford: () => ({ ok: true }),
    applyUsage: () => {},
    buildContextPrompt: () => '',
    buildGameContext: () => '',
    traceChat: () => {},
    memory,
    feedbackCollector: null,
    contextBus
  })
  const executor = createChatExecutor({
    state,
    bot,
    log: null,
    actionsMod: {
      install: () => ({
        run: async (tool, args) => {
          toolRuns.push({ tool, args })
          return { ok: true, msg: 'ok' }
        },
        dry: async () => ({ ok: true, msg: 'dry' })
      })
    },
    H,
    defaults,
    now: () => Date.now(),
    traceChat: () => {},
    pulse,
    memory,
    people: { buildAllProfilesContext: () => '', buildAllCommitmentsContext: () => '' },
    canAfford: () => ({ ok: true, proj: 0, rem: { day: Infinity, month: Infinity, total: Infinity } }),
    applyUsage: () => {},
    buildGameContext: () => '',
    contextBus
  })

  return {
    executor,
    sent,
    toolRuns,
    cleanup: () => {
      try { pulse.stop() } catch {}
      global.fetch = oldFetch
    }
  }
}

test('executor treats production LLM say{} text as a say tool instead of literal chat', async () => {
  const productionText = 'say{"steps":["没发呆喵！","刚刚在想事情啦~"]}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('zileiku', '在想什么嘛', 'owkowk 在想什么嘛', 'trigger')
    await waitFor(() => harness.sent.length >= 2 || harness.sent.some(line => line.includes('say{')))
    assert.deepEqual(harness.sent, ['没发呆喵！', '刚刚在想事情啦~'])
    assert.equal(harness.sent.some(line => line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor runs consecutive production LLM action+say text tools', async () => {
  const productionText = 'defend_player{"name":"Ameyaku"} say{"steps":["跟着雨姐呢 走哪我跟哪~"]}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('Ameyaku', 'owk，跟随我', 'Ameyaku: owk，跟随我', 'trigger')
    await waitFor(() => harness.sent.length >= 1 || harness.sent.some(line => line.includes('defend_player{')))
    assert.deepEqual(harness.toolRuns, [{ tool: 'defend_player', args: { name: 'Ameyaku' } }])
    assert.deepEqual(harness.sent, ['跟着雨姐呢 走哪我跟哪~'])
    assert.equal(harness.sent.some(line => line.includes('defend_player{') || line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor ignores out-of-scope production LLM action after say without leaking syntax', async () => {
  const productionText = 'say{"steps":["我穿的不是下界合金套吗喵","哼"]} defend_player{"name":"izieluk"}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('izieluk', 'owkowk 身上穿的装备叫什么', 'izieluk: owkowk 身上穿的装备叫什么', 'trigger')
    await waitFor(() => harness.sent.length >= 2 || harness.sent.some(line => line.includes('say{')))
    assert.deepEqual(harness.sent, ['我穿的不是下界合金套吗喵', '哼'])
    assert.deepEqual(harness.toolRuns, [])
    assert.equal(harness.sent.some(line => line.includes('defend_player{') || line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor ignores malformed closing tail after production LLM say text tool', async () => {
  const productionText = 'say{"steps":["哼 谁蠢了喵","我聪明着呢 不信你考考我"]}]}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('izieluk', 'owkowk 蠢猫还有救呢', 'izieluk: owkowk 蠢猫还有救呢', 'trigger')
    await waitFor(() => harness.sent.length >= 2 || harness.sent.some(line => line.includes('say{')))
    assert.deepEqual(harness.sent, ['哼 谁蠢了喵', '我聪明着呢 不信你考考我'])
    assert.equal(harness.sent.some(line => line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor normalizes production LLM go_to_block alias after say text tool', async () => {
  const productionText = 'say{"steps":["雨姐我刚才差点被苦力怕炸了 吓死我了",{"pauseMs":1200},"我去床边躺会儿"]}go_to_block{"type":"bed"}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('Ameyaku', '随便说点啥，然后移动到床边', 'Ameyaku: 随便说点啥，然后移动到床边', 'trigger')
    await waitFor(() => (harness.sent.length >= 2 && harness.toolRuns.length >= 1) || harness.sent.some(line => line.includes('go_to_block{')), 6000)
    assert.deepEqual(harness.sent, ['雨姐我刚才差点被苦力怕炸了 吓死我了', '我去床边躺会儿'])
    assert.deepEqual(harness.toolRuns, [{ tool: 'goto_block', args: { match: 'bed' } }])
    assert.equal(harness.sent.some(line => line.includes('go_to_block{') || line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor merges production LLM say pause say before goto_block', async () => {
  const productionText = 'say{"steps":["雨姐你咋又喊我 草"]}{"pauseMs":800}say{"steps":["行吧我去草方块上站着"]}goto_block{"match":"grass","radius":48}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('Ameyaku', '随便说点啥，然后移动到草方块上', 'Ameyaku: 随便说点啥，然后移动到草方块上', 'trigger')
    await waitFor(() => (harness.sent.length >= 2 && harness.toolRuns.length >= 1) || harness.sent.some(line => line.includes('pauseMs') || line.includes('goto_block{')), 6000)
    assert.deepEqual(harness.sent, ['雨姐你咋又喊我 草', '行吧我去草方块上站着'])
    assert.deepEqual(harness.toolRuns, [{ tool: 'goto_block', args: { match: 'grass', radius: 48 } }])
    assert.equal(harness.sent.some(line => line.includes('say{') || line.includes('pauseMs') || line.includes('goto_block{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor runs consecutive production LLM hunt+say text tools', async () => {
  const productionText = 'hunt_player{"name":"Ameyaku"} say{"steps":["雨姐你认真的吗","那我来咯 跑快点喵~"]}'
  const harness = makeHarness({ llmContent: productionText })
  try {
    await harness.executor.processChatContent('Ameyaku', 'owk，追杀我', 'Ameyaku: owk，追杀我', 'trigger')
    await waitFor(() => harness.sent.length >= 2 || harness.sent.some(line => line.includes('hunt_player{')))
    assert.deepEqual(harness.toolRuns, [{ tool: 'hunt_player', args: { name: 'Ameyaku' } }])
    assert.deepEqual(harness.sent, ['雨姐你认真的吗', '那我来咯 跑快点喵~'])
    assert.equal(harness.sent.some(line => line.includes('hunt_player{') || line.includes('say{')), false)
  } finally {
    harness.cleanup()
  }
})

test('executor treats production LLM skip{} text as no outbound chat', async () => {
  const harness = makeHarness({ llmContent: 'skip{}' })
  try {
    await harness.executor.processChatContent('izieluk', 'owk说的对喵~', 'izieluk whispers to you: owk说的对喵~', 'trigger')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(harness.sent, [])
  } finally {
    harness.cleanup()
  }
})
