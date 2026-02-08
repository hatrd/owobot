# Observer Contract（`bot_impl/agent/observer.js`）

本文档定义 observer 的稳定接口与输出契约，供控制面、AI 编排、dry 验证共用。

## 1. 公共导出

`bot_impl/agent/observer.js` 当前导出：

- `snapshot(bot, opts)`
- `toPrompt(snapshot)`
- `detail(bot, args)`
- `affordances(bot, snap?)`

其中前三个是交互主链路的核心依赖。

## 2. 调用方

- 控制面：`bot.js` 的 `observe.snapshot` / `observe.prompt` / `observe.detail`
- 动作层：`bot_impl/actions/modules/observation.js`（`observe_detail` 工具）
- AI 编排：`bot_impl/ai-chat.js` 中 `buildGameContext()` 使用 `snapshot + toPrompt`

## 3. 统一返回结构

### 3.1 snapshot

- 返回结构化对象，不使用 `{ ok, msg }` 包装。

### 3.2 toPrompt

- 返回字符串（通常以 `游戏:` 开头）。

### 3.3 detail

- 返回 `{ ok: boolean, msg: string, data: any }`。
- `msg`：短文本摘要（便于聊天/日志直读）。
- `data`：结构化明细（便于脚本/LLM 消费）。

## 4. `detail.what` 约定

`observe.detail` 的 canonical `what` 与 alias 由 `observe.schema` 暴露；文档推荐以运行时返回为准：

```bash
node scripts/botctl.js schema observe
```


`detail()` 先做 `what` 归一化（alias -> canonical），再按 canonical handler 分发。

当前支持（含别名归一后）：

- `containers`
- `players`
- `hostiles`
- `entities` / `nearby_entities`
- `animals` / `passives`
- `cats`
- `cows`
- `signs`
- `space_snapshot` / `environment` / `room_probe`
- `inventory`
- `blocks`

未知 `what` 必须返回 `ok:false` 且携带明确错误信息。

常见别名示例：

- `nearby_entities` -> `entities`
- `passives` -> `animals`
- `sign` / `signboard` / `boards` -> `signs`
- `space` / `environment` / `room_probe` -> `space_snapshot`
- `inv` / `bag` -> `inventory`

## 5. 容器观察诊断契约（重点）

`what=containers` 时，每个容器 row 至少包含：

- 位置信息：`x,y,z,d`
- 容器身份：`containerType`, `blockName`
- 读取结果：`ok`, `kinds`, `total`, `items`

读取失败时必须保留可诊断字段（按可用性）：

- `unreachable: true`
- `error`（如 `unreachable`）
- `openError`
- `openErrors`（重试/打开失败细节列表）

这条约束是为了满足“失败必须可诊断”，禁止把失败压缩成单一模糊消息。

## 6. 行为边界

- observer 路径默认 read-only。
- `players` 信息只来自 mineflayer 运行时近邻实体，不依赖外部地图 API。
- 任何新增 detail 分支，必须同时提供：
  - 人类可读摘要（`msg`）
  - 结构化证据（`data`）

## 7. 验证命令

```bash
npm run interaction:docgen
npm run interaction:dry
node scripts/botctl.js observe detail what=players radius=24 max=12
node scripts/botctl.js dry observe_detail what=containers radius=20 max=8
node scripts/botctl.js dry observe_detail what=environment radius=12
```

如果容器读取失败，请检查返回中是否包含 `openError/openErrors`，没有则视为契约退化。
