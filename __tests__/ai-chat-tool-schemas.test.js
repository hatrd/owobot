import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractToolCallsFromApiResponse } from '../bot_impl/ai-chat-helpers.js'
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

test('say steps schema matches pulse script step forms', () => {
  const say = listActionToolDefinitions().find(def => def.name === 'say')
  const stepItems = say?.parameters?.properties?.steps?.items
  assert.ok(Array.isArray(stepItems?.anyOf), 'say steps accept multiple step forms')
  assert.ok(stepItems.anyOf.some(item => item?.type === 'string'), 'say steps accept string message steps')
  assert.ok(stepItems.anyOf.some(item => item?.properties?.pauseMs && !item?.required?.includes('kind')), 'say steps accept pure pauseMs steps without kind')
})

test('system prompt documents JSON-compatible say pause steps', () => {
  const prompt = fs.readFileSync(new URL('../bot_impl/prompts/ai-system.txt', import.meta.url), 'utf8')
  assert.doesNotMatch(prompt, /pauseMs\s*\(/, 'prompt must not suggest non-JSON pauseMs(...) syntax')
  assert.match(prompt, /"pauseMs"\s*:\s*1500/, 'prompt should show JSON object pause steps')
  assert.doesNotMatch(prompt, /"kind"\s*:\s*"pause"/, 'prompt should not require kind for pause steps')
})

test('ai-chat tool extraction keeps JSON say pause arguments parseable', () => {
  const data = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'say',
                arguments: '{"steps":["才不给你奖励喵",{"pauseMs":1500},"变态","想得美~"]}'
              }
            }
          ]
        }
      }
    ]
  }
  const [call] = extractToolCallsFromApiResponse(data)
  assert.equal(call?.function?.name, 'say')
  const args = JSON.parse(call.function.arguments)
  assert.deepEqual(args.steps, ['才不给你奖励喵', { pauseMs: 1500 }, '变态', '想得美~'])
})
