#!/usr/bin/env node
// Provider-neutral SDK + NDJSON bridge. Reads always use the read-only dry path.
const net = require('net')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { readOps, writeOps } = require('../bot_impl/controller/contract')
function request (payload, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options.sock || process.env.MCBOT_SOCK || path.resolve('.mcbot.sock'))
    let buffer = ''
    let settled = false
    const finish = (error, data) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolve(data)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(options.timeoutMs || 10000, () => finish(new Error('control_timeout')))
    socket.on('error', error => finish(error))
    socket.on('end', () => finish(new Error('control_connection_closed')))
    socket.on('connect', () => socket.write(JSON.stringify({ ...payload, id: randomUUID(), token: options.token || process.env.MCBOT_CTL_TOKEN || '' }) + '\n'))
    socket.on('data', data => {
      buffer += data
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('response_too_large'))
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        if (!response.ok) return finish(new Error(response.error))
        finish(null, response.result)
      } catch (error) { finish(error) }
    })
  })
}
function call (op, args = {}, options = {}) {
  if (op === 'observe') return request({ op: 'tool.dry', tool: 'observe_detail', args }, options)
  if (readOps.includes(op)) return request({ op: 'tool.dry', tool: 'controller_read', args: { op, args } }, options)
  if (writeOps.includes(op)) return request({ op: options.dry ? 'tool.dry' : 'tool.run', tool: 'controller_write', args: { op, args } }, options)
  return Promise.reject(new Error('unknown_operation'))
}
async function main () {
  const [op, raw = '{}', ...flags] = process.argv.slice(2)
  if (op === 'stdio') {
    const readline = require('readline')
    // Sequential protocol avoids races between acquire/install/start from one model client.
    for await (const line of readline.createInterface({ input: process.stdin })) {
      let input
      try { if (line.length > 1024 * 1024) throw new Error('request_too_large'); input = JSON.parse(line); const result = await call(input.op, input.args, { dry: flags.includes('--dry') || raw === '--dry' }); process.stdout.write(JSON.stringify({ id: input.id, result }) + '\n') }
      catch (error) { process.stdout.write(JSON.stringify({ id: input?.id, error: error.message }) + '\n') }
    }
    return
  }
  const args = JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw)
  const result = await call(op, args, { dry: flags.includes('--dry') })
  const output = flags.find(v => v.startsWith('--image='))?.slice(8)
  if (output && result.ok && result.data?.base64) {
    fs.writeFileSync(output, Buffer.from(result.data.base64, 'base64'))
    delete result.data.base64
    result.data.file = output
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.ok) process.exitCode = 1
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { call, request }
