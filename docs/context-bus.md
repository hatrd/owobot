# Context Bus 技术设计文档

## 概述

Context Bus 是统一的上下文事件总线，将机器人运行时产生的所有上下文信息归一为单一时序流，并以紧凑 XML 格式输出给 LLM。

## 设计动机

### 问题

传统设计中，上下文由多个独立模块分别构建，导致：
1. **时序断裂** — 玩家消息、机器人行为、游戏事件各自独立，因果关系丢失
2. **语义模糊** — 纯文本拼接，AI 难以区分"谁说的"和"发生了什么"
3. **时间盲区** — 无法感知"刚才"与"10分钟前"的区别

### 解决方案

**Single Source of Truth** — 所有上下文事件进入同一条总线，按时间戳排序，统一序列化。

## 核心设计

### 事件类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `player` | 玩家发言 | `<p n="Steve">你好</p>` |
| `server` | 服务器广播 | `<s>Server restarting</s>` |
| `bot` | AI 回复 | `<b>收到</b>` |
| `tool` | 工具输出 | `<t>挖到钻石x3</t>` |
| `event` | 系统事件 | `<e t="hurt.combat" d="zombie:-2"/>` |

### 系统事件类型

```
death              → 死亡
respawn            → 重生
skill.end          → 技能完成 (name:success/failed)
skill.fail         → 技能失败 (name:reason)
health.low         → 低血量警告 (hp:N)
hurt.combat        → 战斗伤害 (attacker:delta)
hurt.explosion     → 爆炸伤害
hurt.fire          → 火焰伤害
hurt.drown         → 溺水伤害
hurt.fall          → 摔落伤害
hurt.hunger        → 饥饿伤害
hurt.other         → 其他伤害
heal               → 治疗 (hp:+delta)
```

> 注: 玩家上下线由服务器消息 (`<s>`) 捕获，无需专用事件

### 序列化格式

```xml
<ctx>
<!-- p=player s=server e=event b=bot t=tool g=gap -->
<p n="Steve">来打我</p>
<e t="hurt.combat" d="Steve:-2"/>
<e t="hurt.combat" d="Steve:-1.5x3"/>
<b>疼！</b>
<g d="12m"/>
<s>Steve left the game</s>
<e t="heal" d="hp:+4"/>
</ctx>
```

**设计考量：**

| 决策 | 理由 |
|------|------|
| 单字母标签 `<p>` `<b>` `<e>` | Token 经济性，单条消息节省 ~60% |
| 属性而非子元素 | 减少嵌套层级，降低解析复杂度 |
| 头部图例注释 | 自解释，无需外部 schema |
| Gap 标记 `<g d="5m"/>` | 时间感知，区分连续对话与跨时段 |
| 事件堆叠 `x3` | 防刷屏，同类事件合并 |

### 事件堆叠 (Anti-Spam)

连续相同类型事件在 5 秒窗口内自动合并：

```
hurt.hunger hp:-0.5  (t=0s)
hurt.hunger hp:-0.5  (t=1s)   → 合并为 hp:-0.5x2
hurt.hunger hp:-0.5  (t=2s)   → 合并为 hp:-0.5x3
hurt.combat zombie:-2 (t=3s)  → 新事件（类型不同）
```

**堆叠规则：**
- 仅 `event` 类型参与堆叠
- 匹配条件：`eventType` 相同 + `data` 基础部分相同
- 窗口：5 秒 (`STACK_WINDOW_MS`)
- 格式：`{base}x{count}`，如 `hp:-0.5x4`

### 时间间隔检测

```
事件 A (10:00) → 事件 B (10:02) → 事件 C (10:15)
                    ↓                    ↓
               无 gap 插入         插入 <g d="13m"/>
```

阈值：5 分钟（可配置）

## 架构哲学

### 1. 事件溯源 (Event Sourcing)

所有状态变化记录为不可变事件序列。总线不存储"当前状态"，而是存储"发生了什么"。重建上下文 = 回放事件流。

### 2. 单一职责

```
ContextBus 职责边界：
  ✓ 收集事件
  ✓ 维护时序
  ✓ 序列化输出
  ✗ 不决定何时调用 AI
  ✗ 不处理业务逻辑
  ✗ 不持久化存储
```

### 3. 宽进严出

**输入端宽容：**
- 接受任意类型，内部 `String(value ?? '')` 兜底
- 自动过滤 XML 无效控制字符
- 截断过长内容（200 chars）

**输出端严格：**
- 始终生成合法 XML
- 始终保持时序正确
- 始终包含图例注释

### 4. 渐进增强

```javascript
// 若 contextBus 不可用，回退到旧逻辑
if (contextBus) {
  return contextBus.buildXml(options)
}
return legacyBuildContextPrompt()
```

零破坏性迁移，新旧系统可共存。

## 性能设计

### 内存控制

- FIFO 淘汰，默认上限 200 条
- `enforceLimit()` 在每次 push 后执行
- 上限可配置：`state.ai.context.busMax`

### 查询优化

```javascript
// 倒序遍历 + 提前终止
for (let i = store.length - 1; i >= 0; i--) {
  if (entry.t < cutoff) break  // 时间有序，提前退出
  if (filtered.length >= max) break
}
```

避免全量 `filter()` + `slice()`，大数据量下 O(n) → O(k)。

## 扩展点

### 伤害类型推断

伤害事件通过优先级链推断类型：

```
combat (有攻击者实体) > explosion > fire > drown > fall > hunger > other
```

**检测逻辑：**
- `combat`: `entityHurt` 事件源为 player/mob，1.5s 内
- `explosion`: `explosion` 事件后 1.5s 内
- `fire`: `bot.entity.onFire` 为真
- `drown`: 头部在水中
- `fall`: 落地距离 ≥3 格，1.2s 内
- `hunger`: `bot.food === 0`

### 新增事件类型

```javascript
contextBus.pushEvent('combat.kill', 'zombie:1')
contextBus.pushEvent('trade.complete', 'emerald:5')
```

无需修改序列化逻辑，`<e t="..." d="..."/>` 通用承载。

## 接口速查

```javascript
const bus = createContextBus({ state, now })

// 写入
bus.pushPlayer(name, content)
bus.pushServer(content)
bus.pushBot(content)
bus.pushTool(content)
bus.pushEvent(type, data)

// 读取
bus.buildXml({ maxEntries, windowSec, includeGaps })
bus.getStore()
bus.clear()
```

## 设计箴言

> **"上下文不是数据的堆砌，而是故事的叙述。"**

Context Bus 的本质是将离散的系统事件编织为连贯的叙事流，让 AI 能够"读懂"机器人的经历，而非仅仅"看到"一堆数据。

---

*Version: 1.2*
*Date: 2025-12*
*Changelog: 移除冗余 player.join/leave 事件（服务器消息已覆盖）*
