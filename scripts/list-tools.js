#!/usr/bin/env node

const path = require('path')

// Ensure the script can be run from any working directory
const projectRoot = path.resolve(__dirname, '..')
// eslint-disable-next-line import/no-dynamic-require
const actionsMod = require(path.join(projectRoot, 'bot_impl', 'actions'))

const metadata = typeof actionsMod.listToolMetadata === 'function'
  ? actionsMod.listToolMetadata()
  : (Array.isArray(actionsMod.TOOL_NAMES) ? actionsMod.TOOL_NAMES.map(name => ({ name, dryCapability: 'validate_only' })) : [])

const result = {
  generatedAt: new Date().toISOString(),
  count: metadata.length,
  tools: metadata.map(meta => meta.name),
  metadata
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
