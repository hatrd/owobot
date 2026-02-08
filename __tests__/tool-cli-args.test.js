const test = require('node:test')
const assert = require('node:assert/strict')

const toolCli = require('../bot_impl/tool-cli')

test('tool-cli: alias + positional sugar for pick', () => {
  const { normalizeToolName, parseArgsForTool, coerceToolArgs } = toolCli._internal
  const tool = normalizeToolName('pick')
  assert.equal(tool, 'pickup')
  const args = coerceToolArgs(tool, parseArgsForTool(tool, ['20']))
  assert.deepEqual(args, { radius: 20 })
})

test('tool-cli: pick 20 log -> radius + match', () => {
  const { normalizeToolName, parseArgsForTool, coerceToolArgs } = toolCli._internal
  const tool = normalizeToolName('pick')
  const args = coerceToolArgs(tool, parseArgsForTool(tool, ['20', 'log']))
  assert.deepEqual(args, { radius: 20, match: 'log' })
})

test('tool-cli: key=value parsing', () => {
  const { parseKeyValueArgs } = toolCli._internal
  const { args, positionals } = parseKeyValueArgs(['radius=20', 'timeoutMs=8000', 'log'])
  assert.equal(args.radius, '20')
  assert.equal(args.timeoutMs, '8000')
  assert.deepEqual(positionals, ['log'])
})

test('tool-cli: voice_speak positional sugar maps to preset', () => {
  const { normalizeToolName, parseArgsForTool } = toolCli._internal
  const tool = normalizeToolName('voice_speak')
  assert.equal(tool, 'voice_speak')
  const args = parseArgsForTool(tool, ['ciallo'])
  assert.deepEqual(args, { preset: 'ciallo' })
})
