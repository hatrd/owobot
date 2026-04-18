# Reconnect Readiness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stalled reconnect attempts self-fail so the bot always returns to the existing reconnect loop instead of hanging in a fake-online state.

**Architecture:** Add a small readiness-guard helper around each newly created bot instance. The guard enforces two structural milestones — `spawn` arrives, then tablist contains self — and terminates only the stalled instance while reusing the existing `end`-driven reconnect path.

**Tech Stack:** Node.js, mineflayer, node:test, existing `tablist-utils` helper.

---

### Task 1: Add a failing test for stalled reconnect readiness

**Files:**
- Create: `__tests__/reconnect-readiness.test.js`
- Test: `__tests__/reconnect-readiness.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReconnectReadinessGuard } = require('../bot_impl/reconnect-readiness')

test('forces reconnect when spawn never arrives', async () => {
  let reconnectReason = null
  let terminatedReason = null
  const handlers = new Map()
  const bot = {
    username: 'owkowk',
    players: {},
    on (event, fn) { handlers.set(event, fn) },
    quit (reason) { terminatedReason = reason },
    end (reason) { terminatedReason = reason },
    _client: { end (reason) { terminatedReason = reason } }
  }

  createReconnectReadinessGuard(bot, {
    spawnTimeoutMs: 20,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) { reconnectReason = reason }
  })

  await new Promise(resolve => setTimeout(resolve, 40))
  assert.match(String(terminatedReason), /spawn timeout/)
  assert.equal(reconnectReason, 'spawn-timeout')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: FAIL with `Cannot find module '../bot_impl/reconnect-readiness'` or missing export.

- [ ] **Step 3: Write minimal implementation**

```js
function createReconnectReadinessGuard (bot, options = {}) {
  // Create per-bot timers here; call onReconnectReady before terminating.
}

module.exports = { createReconnectReadinessGuard }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: PASS for the new stall case.

### Task 2: Cover the spawned-but-tab-empty stall case

**Files:**
- Modify: `__tests__/reconnect-readiness.test.js`
- Modify: `bot_impl/reconnect-readiness.js`
- Test: `__tests__/reconnect-readiness.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('forces reconnect when spawn happened but self never appears in tablist', async () => {
  let reconnectReason = null
  let terminatedReason = null
  const handlers = new Map()
  const bot = {
    username: 'owkowk',
    players: {},
    on (event, fn) { handlers.set(event, fn) },
    quit (reason) { terminatedReason = reason },
    end (reason) { terminatedReason = reason },
    _client: { end (reason) { terminatedReason = reason } }
  }

  createReconnectReadinessGuard(bot, {
    spawnTimeoutMs: 100,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) { reconnectReason = reason }
  })

  handlers.get('spawn')()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.match(String(terminatedReason), /tab ready timeout/)
  assert.equal(reconnectReason, 'tab-not-ready')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: FAIL because the guard only handles the spawn timeout so far.

- [ ] **Step 3: Write minimal implementation**

```js
function startTabReadyWindow () {
  tabTimer = setTimeout(() => fail('tab-not-ready', 'tab ready timeout'), tabReadyTimeoutMs)
  tabPoller = setInterval(() => {
    if (hasListedSelf(bot)) succeed()
  }, tabPollIntervalMs)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: PASS for both timeout paths.

### Task 3: Integrate the guard into bot startup lifecycle

**Files:**
- Modify: `bot.js`
- Modify: `bot_impl/reconnect-readiness.js`
- Test: `__tests__/reconnect-readiness.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('cleanup prevents stale timers from old bots after end', async () => {
  let reconnectReason = null
  let terminatedReason = null
  const handlers = new Map()
  const bot = {
    username: 'owkowk',
    players: {},
    on (event, fn) { handlers.set(event, fn) },
    quit (reason) { terminatedReason = reason },
    end (reason) { terminatedReason = reason },
    _client: { end (reason) { terminatedReason = reason } }
  }

  const guard = createReconnectReadinessGuard(bot, {
    spawnTimeoutMs: 20,
    tabReadyTimeoutMs: 20,
    tabPollIntervalMs: 5,
    onReconnectReady (reason) { reconnectReason = reason }
  })

  guard.cleanup()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(terminatedReason, null)
  assert.equal(reconnectReason, null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: FAIL because cleanup does not cancel all pending work yet.

- [ ] **Step 3: Write minimal implementation**

```js
const readiness = createReconnectReadinessGuard(bot, {
  onReconnectReady () {
    // Only terminate the current bot instance; existing end listener schedules reconnect.
  }
})

function attachCoreBotListeners (targetBot) {
  targetBot.on('end', () => readiness.cleanup())
  targetBot.on('kicked', () => readiness.cleanup())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/reconnect-readiness.test.js`
Expected: PASS with no leaked timeout-triggered reconnect after cleanup.

### Task 4: Verify syntax and bot-level dry checks

**Files:**
- Modify: `bot.js`
- Modify: `bot_impl/reconnect-readiness.js`
- Modify: `__tests__/reconnect-readiness.test.js`

- [ ] **Step 1: Run syntax checks**

```bash
node --check bot.js
node --check bot_impl/reconnect-readiness.js
node --check __tests__/reconnect-readiness.test.js
```

Expected: no output.

- [ ] **Step 2: Run focused tests**

```bash
node --test __tests__/reconnect-readiness.test.js
```

Expected: all reconnect-readiness tests PASS.

- [ ] **Step 3: Reload latest bot logic**

```bash
npm run bot:reload
```

Expected: reload gate/script completes without error.

- [ ] **Step 4: Run required dry verification**

```bash
npm run interaction:dry
```

Expected: dry interaction suite PASS; no contract drift introduced by the reconnect fix.
