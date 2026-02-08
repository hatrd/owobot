# Interaction Schema (Generated)

- GeneratedAt: `2026-02-08T12:16:19.229Z`
- Source: `offline-module`

## Control Ops

| op | aliases | requiresBot | description |
| --- | --- | --- | --- |
| hello |  | no | Control-plane heartbeat and process status. |
| proc.restart | process.restart | no | Restart current bot process. |
| ai.chat.dry | chat.dry | yes | Dry-run one AI chat turn without real world side effects. |
| observe.snapshot |  | yes | Structured runtime snapshot for AI/game context. |
| observe.prompt |  | yes | Prompt text plus snapshot, as used by AI context assembly. |
| observe.detail |  | yes | Focused read-only observation details. |
| observe.schema |  | no | Observer detail schema and aliases. |
| tool.list |  | yes | Tool allowlist and registration report. |
| tool.dry |  | yes | Dry-run one tool call. |
| tool.run |  | yes | Execute one tool call. |
| tool.schema |  | no | Tool metadata + parameter schemas. |
| ctl.schema |  | no | Control-plane operation schema. |

## observe.detail what

| what | description |
| --- | --- |
| containers | Inspect nearby containers in read-only mode with diagnostic fields on failures. |
| players | Nearby players from mineflayer runtime state. |
| hostiles | Nearby hostile mobs. |
| entities | Nearby entities with optional species/match filters. |
| animals | Nearby passive animals. |
| cats | Nearby cats. |
| signs | Nearby signs and extracted text. |
| space_snapshot | Environment/room profile snapshot. |
| inventory | Current bot inventory summary. |
| cows | Nearby cows. |
| blocks | Nearby non-air blocks around current position. |

### Aliases

- `container` -> `containers`
- `chests` -> `containers`
- `boxes` -> `containers`
- `container_contents` -> `containers`
- `chest_contents` -> `containers`
- `nearby_entities` -> `entities`
- `passives` -> `animals`
- `cat` -> `cats`
- `sign` -> `signs`
- `signboard` -> `signs`
- `boards` -> `signs`
- `space` -> `space_snapshot`
- `room_probe` -> `space_snapshot`
- `environment` -> `space_snapshot`
- `inv` -> `inventory`
- `bag` -> `inventory`
- `cow` -> `cows`

## Tool Schema

| tool | dryCapability | hasSchema | description |
| --- | --- | --- | --- |
| goto | validate_only | yes | Pathfind to an absolute coordinate. |
| goto_block | validate_only | yes | Find and walk to a block that matches names or substring filters. |
| follow_player | validate_only | yes | Follow a specific player while keeping some distance. |
| reset | validate_only | yes | Stop current tasks, clear timers, and return to idle. |
| stop | validate_only | yes | Execute action tool "stop". |
| stop_all | validate_only | yes | Execute action tool "stop_all". |
| say | validate_only | yes | Execute action tool "say". |
| voice_status | read_only | yes | Read current Simple Voice Chat runtime status (enabled/connected/errors). |
| voice_speak | validate_only | yes | Speak with a controlled voice preset. Path/URL/TTS are not accepted yet. |
| hunt_player | validate_only | yes | Aggressively chase and attack a named player. |
| defend_area | validate_only | yes | Anchor near current position and clear nearby hostiles. |
| defend_player | validate_only | yes | Escort and protect a named player. |
| equip | validate_only | yes | Equip an item from the inventory into a destination slot. |
| use_item | validate_only | yes | Equip (main/offhand) and right-click use an item, including consumables like chorus_fruit or throwables like ender_pearl. |
| toss | validate_only | yes | Drop items from inventory, slots, or by name. |
| read_book | read_only | yes | Read text from a book (writable_book / written_book) held in hand/offhand or stored in inventory. |
| break_blocks | validate_only | yes | Execute action tool "break_blocks". |
| place_blocks | validate_only | yes | Place blocks (saplings, torches, etc.) following spatial constraints. |
| light_area | validate_only | yes | Place torches or lighting items across a radius to raise light levels. |
| collect | validate_only | yes | Execute action tool "collect". |
| pickup | validate_only | yes | Collect nearby dropped items. |
| gather | validate_only | yes | Gather resources such as logs or ore with configurable filters. |
| harvest | validate_only | yes | Harvest and optionally replant crops. |
| feed_animals | validate_only | yes | Feed nearby passive mobs using inventory items. |
| cull_hostiles | validate_only | yes | Execute action tool "cull_hostiles". |
| mount_near | validate_only | yes | Mount the nearest rideable entity (boats, minecarts, etc.). |
| mount_player | validate_only | yes | Right-click mount a player that asked for it. |
| dismount | validate_only | yes | Dismount immediately. |
| observe_detail | read_only | yes | Read-only world inspection. Use this for information requests before taking action. |
| observe_players | read_only | yes | Read-only nearby player inspection from mineflayer runtime state (no external API). |
| deposit | validate_only | yes | Deposit items into the nearest reachable container (storage blocks, hoppers, and furnace-like blocks). |
| deposit_all | validate_only | yes | Execute action tool "deposit_all". |
| withdraw | validate_only | yes | Withdraw items from the nearest reachable container (supports furnace-like output slot). |
| withdraw_all | validate_only | yes | Execute action tool "withdraw_all". |
| autofish | validate_only | yes | Walk to nearby water and start the auto-fishing module. |
| mine_ore | validate_only | yes | Execute action tool "mine_ore". |
| range_attack | validate_only | yes | Use a bow/crossbow (HawkEye) to attack the target. |
| attack_armor_stand | validate_only | yes | Stay put and repeatedly attack armor stands; optionally path to a provided absolute coordinate before swinging. |
| skill_start | validate_only | yes | Execute action tool "skill_start". |
| skill_status | validate_only | yes | Execute action tool "skill_status". |
| skill_cancel | validate_only | yes | Execute action tool "skill_cancel". |
| sort_chests | validate_only | yes | Sort chest contents based on frame hints within a radius. |
| query_player_stats | validate_only | yes | 查询玩家统计数据（在线时长、聊天次数、死亡次数） |
| query_leaderboard | validate_only | yes | 查询排行榜，返回活跃度最高的玩家列表，可指定玩家/日期/日期范围 |
| announce_daily_star | validate_only | yes | 播报今日之星（昨日最活跃玩家） |
| people_commitments_list | validate_only | yes | Execute action tool "people_commitments_list". |
| people_commitments_dedupe | validate_only | yes | Execute action tool "people_commitments_dedupe". |
| people_commitments_clear | validate_only | yes | Execute action tool "people_commitments_clear". |

### Coverage Report

- allowlistCount: 48
- missingSchema: `stop`, `stop_all`, `say`, `break_blocks`, `collect`, `cull_hostiles`, `deposit_all`, `withdraw_all`, `mine_ore`, `skill_start`, `skill_status`, `skill_cancel`, `people_commitments_list`, `people_commitments_dedupe`, `people_commitments_clear`
- staleSchema: (none)
