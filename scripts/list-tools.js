#!/usr/bin/env node

const path = require('path')

// Ensure the script can be run from any working directory
const projectRoot = path.resolve(__dirname, '..')
// eslint-disable-next-line import/no-dynamic-require
const { TOOL_NAMES } = require(path.join(projectRoot, 'bot_impl', 'actions'))

const result = {
  generatedAt: new Date().toISOString(),
  count: Array.isArray(TOOL_NAMES) ? TOOL_NAMES.length : 0,
  tools: Array.isArray(TOOL_NAMES) ? TOOL_NAMES : []
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
