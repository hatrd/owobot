import test from 'node:test'
import assert from 'node:assert/strict'
import schemas from '../bot_impl/action-tool-schemas.js'
import actionsMod from '../bot_impl/actions/index.js'

test('every allowlisted action has a complete explicit schema', () => {
  const r = schemas.getActionToolSchemaReport()
  assert.equal(r.allowlistCount, actionsMod.TOOL_NAMES.length)
  assert.deepEqual(r.missingSchema, [])
  assert.deepEqual(r.staleSchema, [])
})

test('schema validation rejects missing, mistyped, and unexpected explicit parameters', () => {
  for (const [name, args] of [['goto', { x: 1 }], ['skill_start', {}], ['skill_cancel', { taskId: 7 }], ['stop', { surprise: true }], ['pickup', []], ['pickup', null], ['pickup', { radius: 'twenty' }]]) {
    const r = schemas.validateToolArgs(name, args)
    assert.equal(r.ok, false, name)
    assert.deepEqual(r.blocks, ['bad_args'])
    assert.ok(r.errors.length)
  }
  assert.equal(schemas.validateToolArgs('pickup', { max: 'all', dig: false }).ok, true)
  assert.equal(schemas.validateToolArgs('skill_start', { skill: 'go', args: { x: 1, y: 64, z: 2 } }).ok, true)
  assert.equal(schemas.validateToolArgs('feed_animals', { max: 'all' }).ok, true)
})

test('dry and run reject invalid input before invoking action effects', async () => {
  const bot = { state: {} }
  const actions = actionsMod.install(bot)
  for (const [tool, args] of [['goto', { x: 1 }], ['skill_start', {}], ['pickup', []]]) {
    const dry = await actions.dry(tool, args)
    const run = await actions.run(tool, args)
    assert.equal(dry.ok, false)
    assert.deepEqual(dry.blocks, ['bad_args'])
    assert.deepEqual(dry.errors, run.errors)
  }
  assert.equal(bot._skillRunner, undefined)
  const valid = await actions.dry('skill_start', { skill: 'go', args: { x: 1, y: 64, z: 2 } })
  assert.equal(valid.ok, true)
  assert.equal(valid.capability.level, 'validate_only')
  assert.equal(bot._skillRunner, undefined)
})

test('read-only dry preserves observer diagnostic fields before spawn', async () => {
  const actions = actionsMod.install({ state: {} })
  const result = await actions.dry('observe_detail', { what: 'runtime' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'diagnostics_unavailable')
  assert.equal(result.capability.level, 'read_only')
})
