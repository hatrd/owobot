const ACTION_TOOL_DEFINITIONS = [
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
    name: 'pickup',
    description: 'Collect nearby dropped items.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Exact item names.' },
        match: { type: 'string', description: 'Substring filter for names.' },
        radius: { type: 'number', description: 'Search radius.' },
        max: { type: 'number', description: 'Max number of items to collect.' },
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
        max: { type: 'number', description: 'Maximum animals to feed or \"all\".' }
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
    description: 'Deposit items into the nearest reachable chest/barrel.',
    parameters: {
      type: 'object',
      properties: {
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
    description: 'Withdraw items from the nearest container.',
    parameters: {
      type: 'object',
      properties: {
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
    description: '查询排行榜，返回活跃度最高的玩家列表',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '排行类型: online(在线时长)/chat(聊天)/deaths(死亡)/score(活跃度)，默认score' },
        period: { type: 'string', description: '时间范围: all(总计)/today(今日)，默认all' },
        limit: { type: 'number', description: '返回数量，默认5' }
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

const SPECIAL_TOOLS = [
  {
    name: 'write_memory',
    description: 'Persist or reinforce a long-term memory entry for the bot. Should *only* be used if the player ask for memorizing, don\'t use it casually',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Memory content to store.' },
        importance: { type: 'number', description: 'Relative importance weight (>=1).' },
        author: { type: 'string', description: 'Author/player attribution.' },
        source: { type: 'string', description: 'Subsystem name such as ai/chat.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  }
]

const ACTION_TOOL_SET = new Set(ACTION_TOOL_DEFINITIONS.map(t => t.name))

function buildToolFunctionList () {
  const defs = ACTION_TOOL_DEFINITIONS.concat(SPECIAL_TOOLS)
  return defs.map(def => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters || { type: 'object', properties: {}, additionalProperties: true }
    }
  }))
}

function isActionToolAllowed (name) {
  return ACTION_TOOL_SET.has(String(name || ''))
}

module.exports = {
  ACTION_TOOL_DEFINITIONS,
  buildToolFunctionList,
  isActionToolAllowed
}
