// Pin the v8 entrypoint: a live bot may have cached the transitive v6 package main.
const Ajv = require('ajv/dist/ajv')
const { TOOL_SPECS } = require('./action-tool-specs')
const ajv = new Ajv({ allErrors: true, strict: false })

const ACTION_TOOL_SCHEMAS = [
  {
    name: 'goto',
    description: 'Pathfind to an absolute coordinate.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate.' },
        y: { type: 'number', description: 'Target Y coordinate.' },
        z: { type: 'number', description: 'Target Z coordinate.' },
        range: { type: 'number', description: 'Distance tolerance from target.' },
        dig: { type: 'boolean', description: 'Allow digging blocks if necessary.' }
      },
      required: ['x', 'y', 'z'],
      additionalProperties: true
    }
  },
  {
    name: 'goto_block',
    description: 'Find and walk to a block that matches names or substring filters.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Explicit block names.' },
        name: { type: 'string', description: 'Single block name shortcut.' },
        match: { type: 'string', description: 'Substring to match block names, e.g. "_log".' },
        radius: { type: 'number', description: 'Max search radius.' },
        range: { type: 'number', description: 'Goal tolerance once block is found.' },
        dig: { type: 'boolean', description: 'Allow digging when approaching.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'follow_player',
    description: 'Follow a specific player while keeping some distance.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact player name to follow.' },
        range: { type: 'number', description: 'Distance to maintain.' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'hunt_player',
    description: 'Aggressively chase and attack a named player.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player to hunt.' },
        range: { type: 'number', description: 'Follow distance used for the pathfinder goal.' },
        tickMs: { type: 'number', description: 'Polling interval in milliseconds.' },
        durationMs: { type: 'number', description: 'Abort after this duration.' },
        dig: { type: 'boolean', description: 'Allow digging toward the player.' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'defend_area',
    description: 'Anchor near current position and clear nearby hostiles.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Engagement radius.' },
        followRange: { type: 'number', description: 'How far to wander when no mobs around.' },
        tickMs: { type: 'number', description: 'Loop interval in milliseconds.' },
        dig: { type: 'boolean', description: 'Allow digging while moving.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'defend_player',
    description: 'Escort and protect a named player.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player to defend.' },
        radius: { type: 'number', description: 'Combat radius when anchored on the player.' },
        followRange: { type: 'number', description: 'Allowed distance from the player.' },
        tickMs: { type: 'number', description: 'Loop interval.' },
        dig: { type: 'boolean', description: 'Allow digging to reach the player.' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'reset',
    description: 'Stop current tasks, clear timers, and return to idle.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'voice_status',
    description: 'Read current Simple Voice Chat runtime status (enabled/connected/errors).',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'voice_speak',
    description: 'Speak with a controlled voice preset. Path/URL/TTS are not accepted yet.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Voice source kind. Only preset is currently supported.' },
        preset: { type: 'string', description: 'Voice preset key. Currently supports: ciallo.' },
        name: { type: 'string', description: 'Alias of preset.' },
        text: { type: 'string', description: 'Compat alias for preset for now; only value ciallo is accepted.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'say',
    description: 'Send multiple chat messages in order, optionally inserting pauses to simulate human typing delay. Use this when you want to deliver a reply in several short parts with timing.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Single chat message shortcut.' },
        steps: {
          type: 'array',
          description: 'Ordered script. Each step can be a string chat message, a text step, or a pause object. Use `{ "pauseMs": 1500 }` for a pure wait.',
          items: {
            anyOf: [
              { type: 'string', description: 'Chat message to send.' },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'text' },
                  text: { type: 'string', description: 'Chat message to send.' },
                  pauseMs: { type: 'number', description: 'Milliseconds to wait after this message.' },
                  typing: { type: 'boolean', description: 'If true, wait a computed typing delay before sending this message.' }
                },
                required: ['text'],
                additionalProperties: true
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', const: 'pause', description: 'Optional explicit pause marker.' },
                  pauseMs: { type: 'number', description: 'Milliseconds to wait before the next step.' },
                  ms: { type: 'number', description: 'Alias for pauseMs.' },
                  delayMs: { type: 'number', description: 'Alias for pauseMs.' }
                },
                required: ['pauseMs'],
                additionalProperties: true
              }
            ]
          }
        },
        messages: { type: 'array', items: { type: 'string' }, description: 'Convenience: messages to send in order.' },
        gapMs: { type: 'number', description: 'Default pause between messages when using `messages`.' },
        typing: {
          type: 'object',
          description: 'Typing delay config used when `typing` is enabled.',
          properties: {
            enabled: { type: 'boolean', description: 'Enable computed typing delay before each message.' },
            cps: { type: 'number', description: 'Characters per second when computing typing delay.' },
            baseMs: { type: 'number', description: 'Base delay added before each message.' },
            minMs: { type: 'number', description: 'Minimum computed typing delay.' },
            maxMs: { type: 'number', description: 'Maximum computed typing delay.' },
            jitterMs: { type: 'number', description: 'Random jitter (+/-) added to computed typing delay.' }
          },
          additionalProperties: true
        },
        cancelPrevious: { type: 'boolean', description: 'Cancel any unfinished `say` sequence for this player before starting a new one.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'equip',
    description: 'Equip an item from the inventory into a destination slot.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name to equip.' },
        dest: { type: 'string', description: 'Destination slot such as hand, offhand, head, torso, legs, feet.' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'use_item',
    description: 'Equip (main/offhand) and right-click use an item, including consumables like chorus_fruit or throwables like ender_pearl.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name to use.' },
        hand: { type: 'string', description: 'hand|offhand; defaults to hand.' },
        holdMs: { type: 'number', description: 'Optional hold duration before release, ms.' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'toss',
    description: 'Drop items from inventory, slots, or by name.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'List of {name|slot,count} entries to drop.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              slot: { type: 'string' },
              count: { type: 'number' }
            },
            additionalProperties: true
          }
        },
        names: { type: 'array', items: { type: 'string' }, description: 'Shortcut list of item names.' },
        name: { type: 'string', description: 'Single item name.' },
        slot: { type: 'string', description: 'Slot alias such as hand/offhand/helm.' },
        count: { type: 'number', description: 'Quantity to drop when using name/slot.' },
        all: { type: 'boolean', description: 'Drop entire inventory (respecting exclude list).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Items to skip when dropping all.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'read_book',
    description: 'Read text from a book (writable_book / written_book) held in hand/offhand or stored in inventory.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'boolean', description: 'If true, list all books in inventory with slot/title info (no page content).' },
        index: { type: 'number', description: '1-based index from list=true output, to select a specific book.' },
        slot: { type: 'string', description: 'Where to read: hand|offhand|head|chest|legs|feet or a raw inventory slot number.' },
        name: { type: 'string', description: 'Item name to read; if omitted, auto-picks the first book found.' },
        title: { type: 'string', description: 'Preferred book title/custom label to select among multiple books.' },
        pageFrom: { type: 'number', description: '1-based start page.' },
        pageTo: { type: 'number', description: '1-based end page.' },
        maxPages: { type: 'number', description: 'Max pages to display in one reply.' },
        maxCharsPerPage: { type: 'number', description: 'Max characters per page to display.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'observe_detail',
    description: 'Read-only world inspection. Use this for information requests before taking action.',
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          description: 'Inspection target: life|block_at|block_search|navigation|terrain|exploration_memory|controller|view|runtime|online_players|players|hostiles|entities|animals|cats|cows|inventory|blocks|containers|signs|space_snapshot|environment|room_probe.'
        },
        namedOnly: {
          type: 'boolean',
          description: 'When what=entities|animals|cats|cows, return only entities with explicit nametags by default; set false to include all.'
        },
        radius: { type: 'number', description: 'Search radius around bot. For what=containers, runtime clamps radius to <=6.' },
        max: { type: 'number', description: 'Max entities/containers returned.' },
        containerType: {
          type: 'string',
          description: 'When what=containers: any|storage|chest|barrel|ender_chest|shulker_box|furnace|smoker|blast_furnace|hopper|dispenser|dropper|brewing_stand (Chinese aliases also accepted).'
        },
        itemMax: { type: 'number', description: 'When what=containers: max item kinds returned for each container.' },
        full: { type: 'boolean', description: 'When what=containers: include all aggregated items via allItems.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'observe_players',
    description: 'Read-only nearby player inspection from mineflayer runtime state (no external API).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Single player name filter.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Multiple player names.' },
        radius: { type: 'number', description: 'Nearby scan radius from bot.' },
        max: { type: 'number', description: 'Max rows returned.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'pickup',
    description: 'Collect nearby dropped items.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Exact item names.' },
        match: { type: 'string', description: 'Substring filter for names.' },
        radius: { type: 'number', description: 'Search radius.' },
        max: { anyOf: [{ type: 'number' }, { type: 'string', const: 'all' }], description: 'Max targets; 0/all means unlimited.' },
        what: { type: 'string', enum: ['drops', 'items'] },
        dig: { type: 'boolean' }, includeNew: { type: 'boolean' }, softAbort: { type: 'boolean' },
        timeoutMs: { type: 'number' }, revisitCooldownMs: { type: 'number' },
        until: { type: 'string', description: 'Stop condition such as exhaust/all.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'gather',
    description: 'Gather resources such as logs or ore with configurable filters.',
    parameters: {
      type: 'object',
      properties: {
        only: { type: 'string', description: 'Shortcut resource filter (e.g., log).' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact block names.' },
        match: { type: 'string', description: 'Substring match for block names.' },
        radius: { type: 'number', description: 'Working radius.' },
        height: { type: 'number', description: 'Vertical search height.' },
        stacks: { type: 'number', description: 'Target stack count.' },
        count: { type: 'number', description: 'Target quantity.' },
        collect: { type: 'boolean', description: 'Collect drops when true.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'harvest',
    description: 'Harvest and optionally replant crops.',
    parameters: {
      type: 'object',
      properties: {
        only: { type: 'string', description: 'Crop filter (e.g., potato).' },
        radius: { type: 'number', description: 'Working radius.' },
        replant: { type: 'boolean', description: 'Replant harvested crops.' },
        sowOnly: { type: 'boolean', description: 'Only sow missing crops without harvesting.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'feed_animals',
    description: 'Feed nearby passive mobs using inventory items.',
    parameters: {
      type: 'object',
      properties: {
        species: { type: 'string', description: 'Mob type, e.g., cow, sheep.' },
        item: { type: 'string', description: 'Food item name.' },
        radius: { type: 'number', description: 'Search radius.' },
        max: { anyOf: [{ type: 'number' }, { type: 'string', const: 'all' }], description: 'Maximum animals to feed; 0/all means unlimited.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'place_blocks',
    description: 'Place blocks (saplings, torches, etc.) following spatial constraints.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item to place.' },
        on: {
          type: 'object',
          description: 'Ground constraints when placing.',
          properties: {
            top_of: { type: 'array', items: { type: 'string' }, description: 'Allowed block names underneath.' },
            solid: { type: 'boolean', description: 'Require a solid block underfoot.' }
          },
          additionalProperties: true
        },
        area: {
          type: 'object',
          description: 'Placement bounds, default centered on current position.',
          properties: {
            radius: { type: 'number' },
            origin: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
              additionalProperties: false
            }
          },
          additionalProperties: true
        },
        max: { type: 'number', description: 'Max placements.' },
        spacing: { type: 'number', description: 'Minimum spacing between placements.' },
        collect: { type: 'boolean', description: 'Collect drops/residual blocks afterwards.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'light_area',
    description: 'Place torches or lighting items across a radius to raise light levels.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Square radius to light.' },
        spacing: { type: 'number', description: 'Spacing between placements.' },
        lightThreshold: { type: 'number', description: 'Minimum light level before placing more torches.' },
        max: { type: 'number', description: 'Limit on placements.' },
        returnToOrigin: { type: 'boolean', description: 'Return to original spot afterwards.' },
        item: { type: 'string', description: 'Lighting item to place, defaults to torches/buttons.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'deposit',
    description: 'Deposit items into the nearest reachable container (storage blocks, hoppers, and furnace-like blocks).',
    parameters: {
      type: 'object',
      properties: {
        containerType: { type: 'string', description: 'Container type: storage|chest|barrel|ender_chest|shulker_box|furnace|smoker|blast_furnace|hopper|dispenser|dropper|brewing_stand|any (supports Chinese synonyms).' },
        x: { type: 'number', description: 'Optional target block X.' },
        y: { type: 'number', description: 'Optional target block Y.' },
        z: { type: 'number', description: 'Optional target block Z.' },
        to: { type: 'string', description: 'For furnace-like blocks: input|fuel (defaults to input). all=true is not supported on furnace-like blocks.' },
        items: {
          type: 'array',
          description: 'List of {name|slot,count} entries to deposit.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              slot: { type: 'string' },
              count: { type: 'number' }
            },
            additionalProperties: true
          }
        },
        all: { type: 'boolean', description: 'Deposit everything except protected slots.' },
        radius: { type: 'number', description: 'Search radius for containers.' },
        includeBarrel: { type: 'boolean', description: 'Permit barrels in addition to chests.' },
        keepEquipped: { type: 'boolean', description: 'Keep armor equipped.' },
        keepHeld: { type: 'boolean', description: 'Keep main-hand item.' },
        keepOffhand: { type: 'boolean', description: 'Keep off-hand item.' },
        dig: { type: 'boolean', description: 'Allow digging path to container.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'withdraw',
    description: 'Withdraw items from the nearest reachable container (supports furnace-like output slot).',
    parameters: {
      type: 'object',
      properties: {
        containerType: { type: 'string', description: 'Container type: storage|chest|barrel|ender_chest|shulker_box|furnace|smoker|blast_furnace|hopper|dispenser|dropper|brewing_stand|any (supports Chinese synonyms).' },
        x: { type: 'number', description: 'Optional target block X.' },
        y: { type: 'number', description: 'Optional target block Y.' },
        z: { type: 'number', description: 'Optional target block Z.' },
        from: { type: 'string', description: 'For furnace-like blocks: output|input|fuel|any (defaults to output). For all=true you likely want from=any.' },
        items: {
          type: 'array',
          description: 'List of {name,count} entries to withdraw.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              count: { type: 'number' }
            },
            additionalProperties: true
          }
        },
        all: { type: 'boolean', description: 'Take everything.' },
        radius: { type: 'number', description: 'Search radius for containers.' },
        includeBarrel: { type: 'boolean', description: 'Permit barrels.' },
        multi: { type: 'boolean', description: 'Visit multiple containers if needed.' },
        dig: { type: 'boolean', description: 'Allow digging path.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'autofish',
    description: 'Walk to nearby water and start the auto-fishing module.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Radius in which to search for water.' },
        debug: { type: 'boolean', description: 'Enable verbose logging.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'mount_near',
    description: 'Mount the nearest rideable entity (boats, minecarts, etc.).',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Search radius.' },
        prefer: { type: 'string', description: 'Preferred entity name, e.g., boat or minecart.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'mount_player',
    description: 'Right-click mount a player that asked for it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player to mount.' },
        range: { type: 'number', description: 'Approach distance before mounting.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'dismount',
    description: 'Dismount immediately.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'range_attack',
    description: 'Use a bow/crossbow (HawkEye) to attack the target.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact entity/player name to attack.' },
        match: { type: 'string', description: 'Substring match for mobs (e.g., iron_golem).' },
        radius: { type: 'number', description: 'Search radius for targets.' },
        followRange: { type: 'number', description: 'Distance when chasing target.' },
        durationMs: { type: 'number', description: 'Stop after this duration.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'attack_armor_stand',
    description: 'Stay put and repeatedly attack armor stands; optionally path to a provided absolute coordinate before swinging.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Search radius when locating armor stands.' },
        range: { type: 'number', description: 'Skip pathing when already within this melee range.' },
        rate: { type: ['string', 'number'], description: 'Attack cadence, e.g. 20gt or 1000ms.' },
        pos: {
          type: 'object',
          description: 'Absolute coordinate (x,y,z) to stand on before attacking.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          additionalProperties: true
        },
        position: {
          type: 'object',
          description: 'Alias for pos; provide {x,y,z}.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          additionalProperties: true
        },
        x: { type: 'number', description: 'Shortcut for pos.x (absolute coordinate).' },
        y: { type: 'number', description: 'Shortcut for pos.y (absolute coordinate).' },
        z: { type: 'number', description: 'Shortcut for pos.z (absolute coordinate).' },
        anchorRange: { type: 'number', description: 'Distance tolerance when snapping to the absolute coordinate.' },
        anchorTimeoutMs: { type: 'number', description: 'Timeout while traveling to the absolute coordinate.' },
        dig: { type: 'boolean', description: 'Allow digging while pathing toward the provided coordinate.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'sort_chests',
    description: 'Sort chest contents based on frame hints within a radius.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Search radius when locating chests.' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'query_player_stats',
    description: '查询玩家统计数据（在线时长、聊天次数、死亡次数）',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '玩家名称，必填' },
        period: { type: 'string', description: '时间范围: all(总计)/today(今日)，默认all' },
        type: { type: 'string', description: '统计类型: online/chat/deaths/all，默认all' }
      },
      required: ['name'],
      additionalProperties: true
    }
  },
  {
    name: 'query_leaderboard',
    description: '查询排行榜，返回活跃度最高的玩家列表，可指定玩家/日期/日期范围',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '排行类型: online(在线时长)/chat(聊天)/deaths(死亡)/score(活跃度)，默认score' },
        period: { type: 'string', description: '时间范围: all(总计)/today(今日)/yesterday(昨日)，默认all；当指定 date/startDate/endDate 时忽略' },
        limit: { type: 'number', description: '返回数量，默认5，最多10' },
        name: { type: 'string', description: '玩家名称，可选；提供后会额外返回该玩家排名' },
        date: { type: 'string', description: '指定日期 YYYY-MM-DD，统计该日数据' },
        startDate: { type: 'string', description: '范围起始 YYYY-MM-DD，和 endDate 一起使用，若只给一端则视为同一天' },
        endDate: { type: 'string', description: '范围结束 YYYY-MM-DD，和 startDate 一起使用，若只给一端则视为同一天' }
      },
      additionalProperties: true
    }
  },
  {
    name: 'announce_daily_star',
    description: '播报今日之星（昨日最活跃玩家）',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认昨日' }
      },
      additionalProperties: true
    }
  }
]


// Aliases share parameter definitions with their implementation target.
for (const [name, target] of [['stop', 'reset'], ['stop_all', 'reset'], ['collect', 'pickup'], ['deposit_all', 'deposit'], ['withdraw_all', 'withdraw']]) {
  const base = ACTION_TOOL_SCHEMAS.find(def => def.name === target)
  ACTION_TOOL_SCHEMAS.push({ ...base, name, description: `${base.description} (${name}${name.endsWith('_all') ? ': all=true' : ': alias'}).` })
}
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const number = { type: 'number' }
const string = { type: 'string' }
const boolean = { type: 'boolean' }
const taskId = object({ taskId: { type: 'string', minLength: 1 } }, ['taskId'])
const peopleFilter = { player: string, match: string }
ACTION_TOOL_SCHEMAS.push(
  { name: 'break_blocks', description: 'Break matching blocks in an area. until=exhaust/all ignores max; use until=max for a bounded count.', parameters: object({
    names: { type: 'array', items: string }, match: string,
    area: object({ shape: { type: 'string', enum: ['sphere', 'down'] }, radius: number, height: number, steps: number, origin: object({ x: number, y: number, z: number }, ['x', 'y', 'z']) }),
    until: { type: 'string', enum: ['exhaust', 'all', 'max'] }, max: number, collect: boolean, dig: boolean
  }) },
  { name: 'cull_hostiles', description: 'Start defending the current position against hostiles.', parameters: object({ radius: number, tickMs: number }) },
  { name: 'mine_ore', description: 'Start the built-in ore mining skill; returns taskId.', parameters: object({ radius: number, only: { anyOf: [string, { type: 'array', items: string }] }, expected: string }) },
  { name: 'skill_start', description: 'Start a registered skill with its arguments; returns taskId.', parameters: object({ skill: { type: 'string', minLength: 1 }, args: { type: 'object', additionalProperties: true }, expected: { type: 'object', properties: { success: string, fail: string }, additionalProperties: false } }, ['skill']) },
  { name: 'skill_status', description: 'Read a running skill task status by taskId.', parameters: taskId },
  { name: 'skill_cancel', description: 'Cancel a running skill task by taskId.', parameters: taskId },
  { name: 'people_commitments_list', description: 'List commitments, optionally filtered by player and literal text match.', parameters: object({ ...peopleFilter, mode: { type: 'string', enum: ['pending', 'closed', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 200 }, context: boolean }) },
  { name: 'people_commitments_dedupe', description: 'Preview duplicate commitment removal; apply=true persists the result.', parameters: object({ ...peopleFilter, mode: { type: 'string', enum: ['pending', 'closed', 'all'] }, keep: { type: 'string', enum: ['shortest', 'longest', 'latest'] }, threshold: number, min_hits: number, min_lcs: number, apply: boolean, preview: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { name: 'people_commitments_clear', description: 'Delete matching commitments. mode=all/pending requires confirm=true.', parameters: object({ ...peopleFilter, mode: { type: 'string', enum: ['done', 'closed', 'pending', 'all', 'failed', 'ongoing'] }, confirm: boolean }) }
)

const lifeContract = require('./life/contract')
const controllerContract = require('./controller/contract')
ACTION_TOOL_SCHEMAS.push(
  { name: 'life_configure', description: 'Enable/disable autonomous life or set home. First enable uses the current location as home; later enables retain home. Query observe_detail what=life for status, preview and config schema.', parameters: lifeContract.envelope },
  { name: 'controller_read', description: 'Read external controller status/events/schema or validate a behavior. Query schema for detailed operation contracts.', parameters: controllerContract.envelope(controllerContract.readOps) },
  { name: 'controller_write', description: 'Acquire/renew/release control, install immutable behaviors, start/cancel asynchronous tasks. Query controller_read op=schema first.', parameters: controllerContract.envelope(controllerContract.writeOps) }
)

const blockPosition = object({ x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }, ['x', 'y', 'z'])
const craftArgs = { item: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 64 } }
ACTION_TOOL_SCHEMAS.push(
  { name: 'craft_preview', description: 'Read real recipe ingredients and inventory shortages; does not craft.', parameters: object(craftArgs, ['item']) },
  { name: 'move_input', description: 'Bounded direct forward/jump input for local movement or swimming. No pathfinding, digging or placement. Stop/reset and reload cancel the pulse.', parameters: object({ yaw: { type: 'number', minimum: -6.284, maximum: 6.284 }, pitch: { type: 'number', minimum: -1.571, maximum: 1.571 }, forward: { type: 'boolean' }, jump: { type: 'boolean' }, durationMs: { type: 'integer', minimum: 50, maximum: 5000 } }, ['yaw', 'forward', 'jump', 'durationMs']) },
  { name: 'place_block', description: 'Place one registered block item at an empty reachable integer position on solid support; confirm block readback. Does not move.', parameters: object({ position: blockPosition, item: { type: 'string', minLength: 1 } }, ['position', 'item']) },
  { name: 'dig_block', description: 'Dig exactly one visible reachable block matching expected, using an explicit inventory tool. Never moves or clears obstructions; pickup is separate.', parameters: object({ position: blockPosition, expected: { type: 'string', minLength: 1 }, tool: { type: 'string', minLength: 1 } }, ['position', 'expected', 'tool']) },
  { name: 'craft_item', description: 'Craft an explicit recipe; requires reachable table coordinates when applicable.', parameters: object({ ...craftArgs, recipeIndex: { type: 'integer', minimum: 0, maximum: 1000 }, table: blockPosition }, ['item']) },
  { name: 'place_sign', description: 'Place a new standing sign at an empty coordinate and confirm four lines by readback. Never overwrites existing blocks.', parameters: object({ item: { type: 'string', minLength: 1 }, position: blockPosition, lines: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 15, pattern: '^[^\\r\\n]+$' } } }, ['item', 'position', 'lines']) }
)
const definitions = new Map()
for (const def of ACTION_TOOL_SCHEMAS) {
  if (definitions.has(def.name)) throw new Error(`Duplicate action schema: ${def.name}`)
  if (!def.description || def.parameters?.type !== 'object') throw new Error(`Invalid action schema: ${def.name}`)
  definitions.set(def.name, def)
}
const names = new Set(TOOL_SPECS.map(spec => spec.name))
const report = {
  allowlistCount: names.size,
  missingSchema: [...names].filter(name => !definitions.has(name)),
  staleSchema: [...definitions.keys()].filter(name => !names.has(name))
}
if (report.missingSchema.length || report.staleSchema.length) throw new Error(`Action schema mismatch: ${JSON.stringify(report)}`)
const ACTION_TOOL_DEFINITIONS = TOOL_SPECS.map(spec => ({ ...definitions.get(spec.name), dryCapability: spec.dryCapability || 'validate_only' }))
const cloneObject = value => JSON.parse(JSON.stringify(value))
const validators = new Map(ACTION_TOOL_DEFINITIONS.map(def => [def.name, ajv.compile(def.parameters)]))

function validateToolArgs (name, args = {}) {
  const validate = validators.get(name)
  if (!validate) return { ok: false, msg: '工具不在白名单', blocks: ['not_allowlisted'] }
  if (validate(args)) {
    if (name === 'life_configure') return lifeContract.validate(args.op, args.args || {})
    if (name === 'controller_read' || name === 'controller_write') return controllerContract.validate(args.op, args.args || {})
    return { ok: true }
  }
  return { ok: false, msg: '工具参数不符合 schema', blocks: ['bad_args'], errors: cloneObject(validate.errors) }
}

function listActionToolDefinitions () { return cloneObject(ACTION_TOOL_DEFINITIONS) }
function getActionToolSchemaReport () { return cloneObject(report) }
function isActionToolAllowed (name) { return names.has(name) }
module.exports = { ACTION_TOOL_DEFINITIONS, listActionToolDefinitions, getActionToolSchemaReport, isActionToolAllowed, validateToolArgs }
