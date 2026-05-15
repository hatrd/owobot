import test from 'node:test'
import assert from 'node:assert/strict'
import toolSchemas from '../bot_impl/ai-chat/tool-schemas.js'

const buildToolFunctionList = toolSchemas.buildToolFunctionList
const listActionToolDefinitions = toolSchemas.listActionToolDefinitions

test('AI tool function names are unique', () => {
  const tools = buildToolFunctionList()
  const names = tools.map(tool => tool?.function?.name).filter(Boolean)
  const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx)
  assert.deepEqual([...new Set(duplicates)], [])
})

test('say action schema exposes pulse script arguments', () => {
  const say = listActionToolDefinitions().find(def => def.name === 'say')
  assert.ok(say, 'say action schema exists')
  assert.ok(say.parameters?.properties?.steps, 'say supports ordered steps')
  assert.ok(say.parameters?.properties?.messages, 'say supports message arrays')
  assert.ok(say.parameters?.properties?.typing, 'say supports typing config')
})
