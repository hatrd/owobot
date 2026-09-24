import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { clearModuleTree } from '../scripts/lib/clear-module-tree.js'

test('reloading a module tree does not retain old modules in the loader', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-reload-'))
  const entry = path.join(root, 'index.js')
  const child = path.join(root, 'child.js')
  const loader = path.join(root, '..', 'mcbot-loader-' + path.basename(root) + '.js')
  try {
    fs.writeFileSync(loader, 'module.exports = () => require(' + JSON.stringify(entry) + ')\n')
    fs.writeFileSync(entry, "module.exports = require('./child')\n")
    fs.writeFileSync(child, 'module.exports = { version: 1 }\n')
    const requireFixture = createRequire(import.meta.url)
    const load = requireFixture(loader)
    const parent = requireFixture.cache[loader]
    for (let version = 1; version <= 30; version++) {
      fs.writeFileSync(child, `module.exports = { version: ${version} }\n`)
      clearModuleTree(root)
      assert.equal(load().version, version)
      assert.equal(parent.children.filter(mod => mod.id === entry).length, 1)
      assert.equal(requireFixture.cache[entry].children.filter(mod => mod.id === child).length, 1)
    }
  } finally {
    clearModuleTree(root)
    const requireFixture = createRequire(import.meta.url)
    delete requireFixture.cache[loader]
    fs.rmSync(loader, { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
