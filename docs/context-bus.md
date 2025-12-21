# Context Bus 技术设计文档

## 概述

Context Bus 是一个统一的上下文事件总线，将机器人运行时产生的所有上下文信息归一为单一时序流，并以紧凑 XML 格式输出给 LLM。

## 设计动机

### 问题

传统设计中，上下文由多个独立模块分别构建：

```
buildContextPrompt()  → 聊天记录（纯文本）
buildGameContext()    → 游戏状态
buildExtrasContext()  → 事件摘要
buildMemoryContext()  → 长期记忆
```

这导致：
1. **时序断裂** — 玩家消息、机器人行为、游戏事件各自独立，因果关系丢失
2. **语义模糊** — 纯文本拼接，AI 难以区分"谁说的"和"发生了什么"
3. **时间盲区** — 无法感知"刚才"与"10分钟前"的区别

### 解决方案

**Single Source of Truth** — 所有上下文事件进入同一条总线，按时间戳排序，统一序列化。

## 核心设计

### 事件类型

```
player  → 玩家发言
server  → 服务器广播
bot     → AI 回复
tool    → 内部工具输出
event   → 系统事件（death/respawn/skill.end/health.low）
```

### 序列化格式

```xml
<ctx>
<!-- p=player s=server e=event b=bot t=tool g=gap -->
<p n="Steve">帮我挖钻石</p>
<b>好的</b>
<e t="skill.end" d="mine:success"/>
<t>收获钻石x3</t>
<g d="12m"/>
<p n="Steve">回来了</p>
</ctx>
```

**设计考量：**

| 决策 | 理由 |
|------|------|
| 单字母标签 `<p>` `<b>` `<e>` | Token 经济性，单条消息节省 ~60% |
| 属性而非子元素 | 减少嵌套层级，降低解析复杂度 |
| 头部图例注释 | 自解释，无需外部 schema |
| Gap 标记 `<g d="5m"/>` | 时间感知，区分连续对话与跨时段 |

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

### 新增事件类型

```javascript
contextBus.pushEvent('combat.kill', 'zombie:1')
contextBus.pushEvent('trade.complete', 'emerald:5')
```

无需修改序列化逻辑，`<e t="..." d="..."/>` 通用承载。

### 自定义序列化

可扩展 `serializeEntry()` 支持新标签类型，保持向后兼容。

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

*Author: Claude + Human*
*Version: 1.0*
*Date: 2025-12*
