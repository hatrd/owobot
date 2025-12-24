const test = require('node:test')
const assert = require('node:assert/strict')

const { Vec3 } = require('vec3')

test('auto-back retries /back after teleport cancel even within cooldown', async () => {
  const chats = []
  const handlers = new Map()

  const bot = {
    chat: (msg) => { chats.push(String(msg)) },
    off: () => {},
    emit: () => {},
    clearControlStates: () => {},
    entity: { position: new Vec3(0, 0, 0) },
    state: {}
  }

  const on = (event, fn) => { handlers.set(String(event), fn) }
  const state = {}

  const actionsPath = require.resolve('../bot_impl/actions')
  const priorActions = require.cache[actionsPath]
  require.cache[actionsPath] = { exports: { install: () => { throw new Error('stub actions') } } }

  try {
    const autoBack = require('../bot_impl/auto-back')
    autoBack.install(bot, { on, state })

    // Make the retry timer eligible to run quickly (avoid the 5s min gap).
    state.autoBackRetryAt = Date.now() - 5000

    handlers.get('message')({ toString: () => '使用/back命令回到死亡地点。' })
    assert.deepEqual(chats, ['/back'])

    // The cancel handler intentionally ignores cancels that arrive immediately after issuing /back.
    state.backLastCmdAt = Date.now() - 1000
    handlers.get('message')({ toString: () => '待处理的传送请求已被取消。' })

    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(chats.filter(x => x === '/back').length, 2)
  } finally {
    if (priorActions) require.cache[actionsPath] = priorActions
    else delete require.cache[actionsPath]
  }
})
