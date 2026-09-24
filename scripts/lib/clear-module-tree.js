const path = require('node:path')

function clearModuleTree (root, cache = require.cache) {
  const prefix = path.resolve(root) + path.sep
  const stale = new Set(Object.keys(cache).filter(id => id.startsWith(prefix)))
  if (stale.size === 0) return

  // Deleting cache entries alone leaves the old entry module in its parent's
  // children array. The long-lived loader then retains every reload's code tree.
  for (const mod of Object.values(cache)) {
    if (mod.children?.length) {
      mod.children = mod.children.filter(child => !stale.has(child.id))
    }
  }
  for (const id of stale) delete cache[id]
}

module.exports = { clearModuleTree }
