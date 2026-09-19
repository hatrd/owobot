# 外部 LLM 控制与行为热加载

状态：首版已实现。外部 Astra 或其他模型通过本地 NDJSON 控制面读取观察、申请租约、安装 JSON 行为、启动和查询异步任务。无需调用内置聊天模型，也无需为每个新行为修改 JS 或触发 `open_fire`。模型供应商的 API 和密钥留在外部控制器；这里提供模型无关的 JS SDK 与 stdin/stdout 桥，不内嵌新的计费模型请求。

## 入口与机器真相

```bash
node scripts/controller-client.js schema
node scripts/controller-client.js status
node scripts/controller-client.js observe '{"what":"cats","radius":24,"max":5}'
node scripts/controller-client.js observe '{"what":"view","radius":12}' --image=/tmp/mcbot-view.png
node scripts/run-behavior.js examples/behaviors/neighborhood-tour.json --dry
```

`controller-client.js` 导出 `call(op, args, {sock, token, timeoutMs, dry})`，也支持 `stdio` 模式：每行输入 `{id,op,args}`，每行输出 `{id,result}` 或 `{id,error}`。模型可自行选择文本观察或图片观察。图片结果带 `image/png` base64，外部模型适配器按其供应商格式构建 image 输入。SDK 默认使用 `.mcbot.sock`，支持 `MCBOT_SOCK` 和 `MCBOT_CTL_TOKEN`；沿用原有 socket 的 0600 权限与 token 校验。

没有新增远程端口。桥接关系是显式契约：读操作经 `tool.dry controller_read`，写操作经 `tool.run controller_write`，世界观察经 `tool.dry observe_detail`。`schema tool` 可查询入口，`controller_read op=schema` 返回各操作与行为语言的完整 JSON Schema。使用既有可热加载动作入口，因此部署这一版也无需重启 loader。不要将下表操作名称误当成顶层 ctl op。

| 操作 | 参数重点 | 结果 |
| --- | --- | --- |
| schema | 无 | 请求 schema、行为 schema、容量限制 |
| status | 可选 taskId | 租约摘要、任务状态、已安装版本、runtimeId |
| events.read | cursor、limit | 有界事件、nextCursor、historyLost |
| behavior.validate | behavior | 纯校验、hash、节点数 |
| session.acquire | controllerId、ttlMs | leaseId、epoch、expiresAt |
| session.renew | leaseId、epoch、ttlMs | expiresAt |
| session.release | leaseId、epoch | 取消当前任务并释放控制 |
| behavior.install | leaseId、epoch、behavior | 不可变版本 hash |
| task.start | leaseId、epoch、requestId、behaviorId、revision、timeoutMs | 立即返回 taskId |
| task.cancel | leaseId、epoch、taskId | 保留取消后的终态 |

写操作的 `--dry` 只校验输入，不获取租约、不安装行为、不启动或取消任务。AI 先完成 dry/mock 验证，通过后可自主运行：

```bash
node scripts/run-behavior.js examples/behaviors/neighborhood-tour.json
```

示例控制器自动申请/续租/释放租约、读取增量事件，Ctrl-C 取消任务。当前导览示例读取附近告示牌和猫，通过血量条件分支决定是否继续，不写死世界坐标。不自动走向某个曾经观察到的位置：外部模型应读取最新实体 `position` 后生成一个新行为版本。

## 行为语言与完成语义

行为定义为 `{id,revision,entry,nodes}`，详见示例与 schema。支持：

- `action`：`goto`（不挖掘、不搭柱，抵达目标范围才完成）、`look`（yaw/pitch，弧度）、`say`（纯聊天，不接受服务器斜杠命令）、`observe`（明确的只读 what 列表）、`feed_cat`（uuid 指定当前猫，原地单次喂食并确认消耗；危险中断取消而不重放）。每个动作必须有 timeoutMs 和 next。
- `wait`：明确毫秒数与 next。
- `wait_event`：等待进入节点后的 health/entityHurt/rain/day/night 结构化事件，必须有 timeoutMs。
- `branch`：health/food/oxygenLevel 数值字段与 lt/lte/eq/gte/gt 比较，显式 yes/no。
- `end`：任务成功。

所有跳转都先校验。最多 64 个节点，任务最长五分钟，最多 1000 次节点进入。全局最多 64 个行为版本、100 个任务记录、256 条事件。每个任务仅保留最后一次动作结果（最多 16 KiB），历史结果走有界事件与结构化日志；超过保留范围会返回 historyLost。单租约超过 100 个任务直接拒绝，不通过淘汰 requestId 让旧重试意外重跑。

同一 id/revision 内容不能变；新 revision 不影响当前任务。requestId 在同一租约内幂等，复用 requestId 却改变任务参数会拒绝。新动作需要实现明确的完成/取消驱动并扩展 schema；不能直接把会后台运行的旧 action 包成一个“成功”节点。当前扩展支持有保护检查的单次开掘与明确容器转移，不支持任意 Lua/JS 执行。

## 状态、抢占与恢复

事实来源是 `state.controller`（版本、租约、任务、节点、结果、事件序号）。`state.controllerApi` 仅是可替换驱动入口。任务迁移、行为安装和租约事件写入正常结构化日志 `controller.event`。进程重启清空控制运行时，不自动从日志恢复并执行动作；空间记忆和探索任务检查点单独持久化，见 [exploration-memory.md](exploration-memory.md)。

首版采用**整机独占**：租约期间其他 AI/CLI 的修改类 action 返回 controller_busy，stop/reset 与只读观察仍可用。申请租约前检查现有寻路、窗口、挖掘、钓鱼和旧技能任务，忙时拒绝；旧技能执行器不会被静默迁移到新状态机。已有自动行为通过 externalBusy 协作让出控制。

头部入水/正在脱困、低血量（<=6）、饥饿（<=6）、缺氧（<=10）或正在自动进食会暂停任务、取消当前寻路并让出 externalBusy，给现有进食、游泳、不死图腾等确定性反应工作。危险解除且资源空闲后从当前节点恢复；任务总 deadline 不暂停。取消、租约过期、死亡、掉线会停止本运行时持有的寻路并保留终态。取消后的迟到结果不能推进任务。

这是对现有自动行为的协作式抢占，尚不是所有 Mineflayer 调用的底层资源隔离；新增自动模块必须遵守 busy/取消约定。外部控制首版只开放有限驱动，避免宣称所有旧动作已经具备可靠取消。

行为安装不重载代码。**代码热重载**保留定义和历史，取消运行中的任务并撤销租约，不重放执行结果不确定的动作。外部控制器重新申请租约再发任务。runtimeId 标识驱动实例；epoch 标识租约世代，均不是服务器世界版本号。轮询状态及租约到期时间，不能把 socket 连通当成仍持有控制权。

## 按需画面

`observe_detail what=view` 返回当前机器人视角的 160×100 PNG、frameId、runtimeId、租约 epoch、采集起止时间、维度、眼睛位置、yaw/pitch、方块调色板和 unknownBlocks。半径限制为 4–16，默认 12。颜色按方块名稳定分配，不等同于 Minecraft 材质；实体、流体、光照、UI 不绘制，形状近似整方块。实体位置应读结构化观察。

世界数据分批采集，每层让出事件循环；光线投射与 PNG 压缩在独立 worker 中执行。单次并发、有界尺寸与时间、64 MiB worker 堆限制，无常驻图片缓存。断线、维度切换或驱动替换会使采集失败并返回明确 error。采集不是原子世界快照，应检查时间与 runtimeId，动作前重新确认目标。

需要真实材质、实体模型和 UI 时，后续可接独立实际客户端采集端。当前简化图片已经能给外部模型提供局部几何证据，但不能用它识别未绘制的实体或阅读告示牌文字。

## 验证

离线测试覆盖租约、幂等性、不可变版本、取消迟到结果、超时、基础反应暂停恢复、热重载、事件缺口、dry 无执行副作用与 PNG 生成。在线按仓库流程执行：

```bash
npm run interaction:dry
node scripts/botctl.js dry observe_detail what=controller
node scripts/botctl.js dry observe_detail what=view radius=12
node scripts/run-behavior.js examples/behaviors/neighborhood-tour.json --dry
```

服内实跑验收：导览示例、短距离 goto 到达、Ctrl-C 取消、控制器退出后租约过期、危险状态下暂停与恢复。AI 已获项目持续授权，可自主完成这些实跑验收；先通过 dry/mock，再读取结构化结果确认。

探索扩展：`memory.recall/begin/resume/pause/checkpoint`、`task.start missionId` 和 `behavior.remove` 已加入机器 schema。查看 [探索记忆](exploration-memory.md) 获取持续探索与恢复流程。

液体判定、卡住重规划和脱困交接详见 [液体与导航](navigation.md)。goto 失败保留结构化 lastResult，不自动无限重试。

自主生活调度器复用该控制器执行短途任务；玩家修改类动作或外部控制器申请租约会使自主任务让路。家、活动状态和喂食冷却见 [自主生活](autonomous-life.md)。

开掘与储物扩展：现已支持 `excavate`、`discard`、`storage_transfer`，单次修改均有明确完成回执；这些修改在危险中断后取消而不自动重放。当前能力及长期证据接口见 [cerebellum.md](cerebellum.md) 与实时 schema。
