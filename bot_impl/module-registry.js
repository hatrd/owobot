// Central registry describing hot-reloadable modules installed by index.js

const MODULES = [
  { id: 'bed-sleep', path: './bed-sleep', logger: 'sleep', kind: 'feature', description: 'Sleep when items land on a bed at night' },
  { id: 'follow-iron-nugget', path: './follow-iron-nugget', logger: 'follow', kind: 'feature', description: 'Follow players holding iron nuggets' },
  { id: 'auto-eat', path: './auto-eat', logger: 'eat', kind: 'feature', description: 'Automatic hunger management' },
  { id: 'auto-back', path: './auto-back', logger: 'back', kind: 'feature', description: 'Return to death location and pick up drops' },
  { id: 'log-control', path: './log-control', logger: 'log', kind: 'infrastructure', description: 'Runtime log level control via CLI' },
  { id: 'auto-counter', path: './auto-counter', logger: 'pvp', kind: 'feature', description: 'Counterattack behaviour when hurt' },
  { id: 'auto-gear', path: './auto-gear', logger: 'gear', kind: 'feature', description: 'Equip best armor and weapons' },
  { id: 'auto-armor-craft', path: './auto-armor-craft', logger: 'autoarmor', kind: 'feature', description: 'Craft iron armor when materials are available' },
  { id: 'auto-fish', path: './auto-fish', logger: 'fish', kind: 'feature', description: 'Fishing automation near water' },
  { id: 'auto-swim', path: './auto-swim', logger: 'swim', kind: 'feature', description: 'Prevent drowning by surfacing when in water' },
  { id: 'tpa-here', path: './tpa-here', logger: 'tpa', kind: 'feature', description: 'Respond to chat command with /tpa <player>' },
  { id: 'ai-chat', path: './ai-chat', logger: 'ai', kind: 'ai', description: 'DeepSeek powered chat + tool interface' },
  { id: 'auto-plant', path: './auto-plant', logger: 'plant', kind: 'feature', description: 'Automatically plant saplings from inventory' },
  { id: 'auto-stash', path: './auto-stash', logger: 'stash', kind: 'feature', description: 'Stash items when inventory is nearly full' },
  { id: 'inventory-compress', path: './inventory-compress', logger: 'compress', kind: 'feature', description: 'Craft compacted stacks to free inventory slots' },
  { id: 'frame-sorter', path: './frame-sorter', logger: 'frames', kind: 'feature', description: 'Item frame sorter utilities' },
  { id: 'auto-login', path: './auto-login', logger: 'login', kind: 'feature', description: 'Handle /login prompts automatically' },
  { id: 'drops-debug', path: './drops-debug', logger: 'drops', kind: 'debug', description: 'CLI helpers for nearby item entities' },
  { id: 'collect-cli', path: './collect-cli', logger: 'collect', kind: 'cli', description: 'CLI command for collecting drops around the bot' },
  { id: 'place-cli', path: './place-cli', logger: 'place', kind: 'cli', description: 'CLI command for block placement utilities' },
  { id: 'spawnproof-cli', path: './spawnproof-cli', logger: 'spawnproof', kind: 'cli', description: 'CLI command to place spawn-proofing blocks' },
  { id: 'tab-cli', path: './tab-cli', logger: 'tab', kind: 'cli', description: 'CLI command to print current tablist players with ping' },
  { id: 'status-cli', path: './status-cli', logger: 'status', kind: 'cli', description: 'CLI snapshot of bot status' },
  { id: 'mine-cli', path: './mine-cli', logger: 'mine', kind: 'cli', description: 'CLI command to start/stop ore mining' },
  { id: 'debug-cli', path: './debug-cli', logger: 'dbg', kind: 'cli', description: 'CLI debug helpers (entities/inventory/position etc.)' },
  { id: 'player-stats', path: './player-stats', logger: 'stats', kind: 'feature', description: 'Player statistics and leaderboard tracking' }
]

module.exports = { MODULES }
