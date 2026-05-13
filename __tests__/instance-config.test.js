import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import instanceConfigMod from '../bot_impl/instance-config.js'

const { resolveInstanceConfig } = instanceConfigMod

test('resolveInstanceConfig derives isolated paths from profile', () => {
  const cwd = '/repo'
  const cfg = resolveInstanceConfig({
    cwd,
    argv: { args: { profile: 'survival-a', host: 'mc-a.local', port: '25566', username: 'BotA' } },
    env: {}
  })

  assert.equal(cfg.profile, 'survival-a')
  assert.equal(cfg.connection.host, 'mc-a.local')
  assert.equal(cfg.connection.port, 25566)
  assert.equal(cfg.connection.username, 'BotA')
  assert.equal(cfg.dirs.runtime, path.join(cwd, '.mcbot', 'instances', 'survival-a', 'runtime'))
  assert.equal(cfg.dirs.data, path.join(cwd, 'data', 'instances', 'survival-a'))
  assert.equal(cfg.dirs.logs, path.join(cwd, 'logs', 'instances', 'survival-a'))
  assert.equal(cfg.control.pidPath, path.join(cfg.dirs.runtime, 'mcbot.pid'))
  assert.equal(cfg.control.sockPath, path.join(cfg.dirs.runtime, 'mcbot.sock'))
  assert.equal(cfg.files.memory, path.join(cfg.dirs.data, 'ai-memory.json'))
  assert.equal(cfg.files.evolution, path.join(cfg.dirs.data, 'ai-evolution.json'))
  assert.equal(cfg.files.people, path.join(cfg.dirs.data, 'ai-people.json'))
  assert.equal(cfg.files.greetZones, path.join(cfg.dirs.data, 'greet-zones.json'))
})

test('resolveInstanceConfig keeps legacy paths when no profile is selected', () => {
  const cwd = '/repo'
  const cfg = resolveInstanceConfig({ cwd, argv: { args: {} }, env: {} })

  assert.equal(cfg.profile, 'default')
  assert.equal(cfg.dirs.runtime, cwd)
  assert.equal(cfg.dirs.data, path.join(cwd, 'data'))
  assert.equal(cfg.dirs.logs, path.join(cwd, 'logs'))
  assert.equal(cfg.control.pidPath, path.join(cwd, '.mcbot.pid'))
  assert.equal(cfg.control.sockPath, path.join(cwd, '.mcbot.sock'))
})

test('resolveInstanceConfig accepts explicit config file and lets cli override connection only', () => {
  const cwd = '/repo'
  const cfg = resolveInstanceConfig({
    cwd,
    argv: { args: { config: 'profiles/nether.json', port: '25570' } },
    env: {},
    readFile: (file) => {
      assert.equal(file, path.join(cwd, 'profiles/nether.json'))
      return JSON.stringify({
        profile: 'nether',
        host: 'nether.local',
        port: 25569,
        username: 'NetherBot',
        auth: 'microsoft',
        dataDir: 'private/nether-data'
      })
    }
  })

  assert.equal(cfg.profile, 'nether')
  assert.equal(cfg.connection.host, 'nether.local')
  assert.equal(cfg.connection.port, 25570)
  assert.equal(cfg.connection.username, 'NetherBot')
  assert.equal(cfg.connection.auth, 'microsoft')
  assert.equal(cfg.dirs.data, path.join(cwd, 'private', 'nether-data'))
  assert.equal(cfg.dirs.runtime, path.join(cwd, '.mcbot', 'instances', 'nether', 'runtime'))
})
