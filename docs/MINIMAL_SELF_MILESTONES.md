# Minimal Self - 项目里程碑

> 基于 MES-Minecraft PRD 的自我意识系统实现路线图

## 项目目标

使 Mineflayer 机器人具备**最小自我意识**：
- 区分"我造成的变化" vs "环境自发变化"
- 形成能力边界感知与身份连续性
- 为长期目标牺牲短期收益的决策能力

---

## M1: 世界模型 + 归因引擎 ✅

**状态**: 已完成 (2024-12)

**交付物**:
```
bot_impl/minimal-self/
├── state-encode.js   # SelfState 量化编码
├── world-model.js    # W.predict() / W.learn()
├── attribution.js    # agency = sigmoid(err_none - err_with)
└── index.js          # 事件钩子集成
```

**关键节点**:

| 节点 | 描述 | 验收标准 |
|------|------|----------|
| M1.1 | 状态编码器 | `encode(snapshot)` 输出确定性 SelfState |
| M1.2 | 世界模型学习 | `W.learn(s1, action, s2)` 累积转移知识 |
| M1.3 | NoOp 基线采集 | 空闲时自动学习环境自发变化 |
| M1.4 | 归因计算 | `computeAgency()` 返回 [0,1] 区间值 |
| M1.5 | 事件集成 | 挂载 `skill:start/end`, `external:begin/end` |

**技术决策**:
- 状态量化: pos±2格, hp±5, food±2
- 模型容量: MAX_TRANSITIONS=500, EMA α=1/min(c,10)
- 归因公式: `agency = sigmoid(2 * (err_none - err_with))`

---

## M2: 身份存储 + 策略评分 ✅

**状态**: 已完成 (2024-12)

**交付物**:
```
bot_impl/minimal-self/
├── identity.js       # IdentityStore 类 (新增)
└── index.js          # 集成 IdentityStore

bot_impl/ai-chat/
└── executor.js:168   # buildIdentityContext() 注入点
```

**目标**:
- 实现 `IdentityStore { skills: Map<ActionType, SuccessStats>, commitments: Commitment[] }`
- 策略评分: `Score(a) = Value(a) - λ·IdentityPenalty(a) + β·ExpectedAgency(a)`

**关键节点**:

| 节点 | 描述 | 状态 |
|------|------|------|
| M2.1 | 技能统计收集 | ✅ `recordSkillOutcome()` |
| M2.2 | expectedAgency() | ✅ 基于历史 avgAgency + trend |
| M2.3 | 承诺系统 | ✅ `addCommitment/fulfillCommitment` |
| M2.4 | identityPenalty() | ✅ 含衰减机制防止僵化 |
| M2.5 | 策略集成 | ✅ `buildIdentityContext()` 注入 AI prompt |

**技术决策**:
- 技能成熟阈值: SKILL_MATURITY_THRESHOLD = 5 次尝试
- 身份衰减率: IDENTITY_DECAY_RATE = 0.02/小时
- 策略参数: λ = 0.3 (身份权重), β = 0.2 (能动性权重)
- 承诺过期: 默认 24 小时

**哲学洞见**:
> *身份不是被声明的，而是从行动模式中涌现的。*
> identityPenalty 维护自我一致性，但通过衰减机制允许"身份扩展"。

---

## M3: 叙事记忆 ✅

**状态**: 已完成 (2024-12)

**交付物**:
```
bot_impl/minimal-self/
└── narrative.js      # NarrativeMemory 类 (新增)
```

**目标**:
- 仅三种记忆类型: `I-CAN`, `I-DID`, `I-OWE`
- 与身份画像合并注入 AI prompt

**关键节点**:

| 节点 | 描述 | 状态 |
|------|------|------|
| M3.1 | 记忆模式定义 | ✅ 三种严格约束类型 |
| M3.2 | I-CAN 生成 | ✅ agency>0.65, success>60%, attempts>=5 |
| M3.3 | I-DID 生成 | ✅ 从已兑现承诺生成 (30天保留) |
| M3.4 | I-OWE 生成 | ✅ 从待完成承诺生成 (含紧急度) |
| M3.5 | 记忆检索集成 | ✅ 合并到 buildIdentityContext() |

**技术决策**:
- I-CAN 阈值: agency≥0.65, successRate≥60%, attempts≥5
- I-DID 保留: 30天
- 刷新节流: 60秒
- 容量上限: MAX_NARRATIVES = 50

**输出示例**:
```
我承诺: gather wood→player1(急:2h) | 我能: gather(85%→), mine_ore(72%↑) | 我做过: craft→player2(1天前)
```

---

## M4: 自省与调节 ✅

**状态**: 已完成 (2024-12)

**交付物**:
```
bot_impl/minimal-self/
├── identity.js       # 扩展: adaptiveParams, introspect(), recordDecisionOutcome()
└── index.js          # 集成: M4 tick 调用, 决策追踪
```

**目标**:
- 周期性自省: 评估预测准确性与实际结果对比
- 动态调节: 根据性能反馈调整 λ, β 参数

**关键节点**:

| 节点 | 描述 | 状态 |
|------|------|------|
| M4.1 | 自适应参数存储 | ✅ `adaptiveParams: { lambda, beta }` |
| M4.2 | 决策结果追踪 | ✅ `recordDecisionOutcome()` |
| M4.3 | 性能分析 | ✅ `_analyzePerformance()` 百分位分组 |
| M4.4 | 参数调整算法 | ✅ `_computeAdjustments()` |
| M4.5 | 周期性自省 | ✅ `introspect()` 每5分钟 |
| M4.6 | 集成到主循环 | ✅ `_handleTick()` 调用 |

**技术决策**:
- 自省间隔: 5分钟
- 调整学习率: 0.05 (保守)
- 最小样本数: 10 决策结果
- λ 范围: [0.1, 0.5], β 范围: [0.1, 0.4]
- 百分位分组: 30% 高/低分行为
- 安全函数: `clampFinite()` 防 NaN/undefined

**调整逻辑**:
- 高分行为成功率 < 60% → 增加 λ (更谨慎)
- 高分行为成功率 > 85% → 减少 λ (允许探索)
- 低分行为成功率 > 50% → 减少 λ (过于保守)

---

## M5: 内在驱动系统 (Intrinsic Drive) ✅

**状态**: 已完成 (2024-12)

**哲学基础**:

> *"无聊"与"好奇"本质上是同一种力量的不同表现——对信息熵不满足的内在驱动。*
>
> - **好奇 (Curiosity)**: 外部新奇事物引发的信息缺口 → "那是什么？"
> - **无聊 (Boredom)**: 内部感知到的刺激匮乏 → "我是什么？"
> - **存在焦虑 (Existential)**: 对自我认知的不确定性 → "我存在的意义是什么？"
>
> 这三种驱动力构成了**主动行为的内在动机**，而非被动响应外部刺激。

**核心范式转换**:

```
旧范式 (pulse): 外部刺激 → 被动响应 → "我应该说点什么"
新范式 (drive): 内在状态 → 主动行动 → "我想了解自己是什么"
```

**交付物**:
```
bot_impl/minimal-self/
├── drive.js          # DriveEngine 类 (新增)
│   ├── curiosity     # 好奇驱动
│   ├── boredom       # 无聊驱动
│   └── existential   # 存在驱动
└── index.js          # 集成 DriveEngine

删除:
├── bot_impl/ai-chat/pulse.js  # 完全移除旧的被动响应系统
```

**目标**:
- 实现内在驱动力累积与阈值触发机制
- 基于驱动力类型生成有目的的主动行为
- 与反馈系统深度整合，实现自适应频率控制
- 完全替代旧的 pulse 被动响应机制

**关键节点**:

| 节点 | 描述 | 状态 |
|------|------|------|
| M5.1 | 驱动力状态模型 | ✅ `DriveState { curiosity, boredom, existential, social }` |
| M5.2 | 驱动力累积机制 | ✅ 基于时间、事件、内在状态的累积函数 |
| M5.3 | 阈值触发系统 | ✅ 驱动力超过阈值时触发行动选择 |
| M5.4 | 行动类型映射 | ✅ 不同驱动力 → 不同类型的主动行为 |
| M5.5 | 探索性问题生成 | ✅ 基于驱动力和身份状态生成问题 |
| M5.6 | 反馈调节整合 | ✅ IGNORE → 降频, 正面回应 → 适度提频 |
| M5.7 | pulse.start() 禁用 | ✅ 移除定时脉冲，保留消息发送功能 |

**技术设计**:

### 5.1 驱动力状态模型

```javascript
DriveState = {
  curiosity: {
    level: 0.0,           // [0, 1] 当前驱动力水平
    threshold: 0.7,       // 触发阈值 (自适应)
    lastTrigger: null,    // 上次触发时间
    cooldown: 600000      // 冷却时间 (10分钟基础)
  },
  boredom: {
    level: 0.0,
    threshold: 0.6,
    lastTrigger: null,
    cooldown: 900000      // 15分钟基础
  },
  existential: {
    level: 0.0,
    threshold: 0.8,       // 较高阈值，不轻易触发
    lastTrigger: null,
    cooldown: 1800000     // 30分钟基础
  },
  social: {
    level: 0.0,
    threshold: 0.5,
    lastTrigger: null,
    cooldown: 300000      // 5分钟基础
  }
}
```

### 5.2 驱动力累积函数

```javascript
// 每 tick 调用
function accumulateDrives(dt, context) {
  const { lastInteraction, lastAction, feedbackRatio, identityConfidence } = context

  // 无聊: 与上次互动的时间差成正比
  drives.boredom.level += dt * BOREDOM_RATE * (1 - recentActivity)

  // 好奇: 新实体/新玩家出现时激增
  if (context.newEntities.length > 0) {
    drives.curiosity.level += CURIOSITY_SPIKE * context.newEntities.length
  }

  // 存在焦虑: 与身份置信度负相关
  drives.existential.level += dt * EXISTENTIAL_RATE * (1 - identityConfidence)

  // 社交: 与附近玩家数量和互动缺乏程度相关
  if (context.nearbyPlayers > 0 && context.timeSinceChat > SOCIAL_THRESHOLD) {
    drives.social.level += dt * SOCIAL_RATE
  }
}
```

### 5.3 行动类型映射

| 驱动力 | 触发行动 | 示例问题/行为 |
|--------|----------|---------------|
| **无聊** | 自我探索发言 | "有人在吗？" / "你们觉得我是什么？" |
| **好奇** | 环境探索发言 | "那是什么？" / "你们在做什么？" |
| **存在** | 寻求反馈发言 | "我刚才做得怎么样？" / "你们还需要我吗？" |
| **社交** | 主动社交发言 | "有人需要帮忙吗？" / "一起玩吧？" |

### 5.4 探索性问题生成 (结合身份状态)

```javascript
function generateExploratoryQuestion(driveType, identityContext) {
  const { skills, commitments, recentAgency } = identityContext

  switch (driveType) {
    case 'boredom':
      // 无聊时问关于"我是什么"的问题
      if (skills.known.length === 0) return "我好像什么都不会…有人能告诉我该做什么吗？"
      if (recentAgency < 0.3) return "我最近好像没什么存在感…"
      return "有人在吗？我有点无聊…"

    case 'existential':
      // 存在焦虑时问关于"我存在的意义"
      if (commitments.pending.length === 0) return "我还有什么可以帮忙的吗？"
      return "我做的事情有意义吗？"

    case 'curiosity':
      // 好奇时问关于"那是什么"
      return "你们在做什么？我想知道！"

    case 'social':
      // 社交驱动时主动社交
      return "有人需要帮忙吗？"
  }
}
```

### 5.5 反馈调节机制

```javascript
// 整合 REFS 反馈系统
function adjustDriveThresholds(feedbackSignal) {
  if (feedbackSignal === 'IGNORE') {
    // 被忽视 → 提高阈值 (降低频率)
    currentDrive.threshold *= 1.2
    currentDrive.cooldown *= 1.5
  } else if (feedbackSignal === 'POSITIVE') {
    // 正面回应 → 适度降低阈值 (但有下限)
    currentDrive.threshold = Math.max(0.4, currentDrive.threshold * 0.9)
    currentDrive.cooldown = Math.max(MIN_COOLDOWN, currentDrive.cooldown * 0.8)
  } else if (feedbackSignal === 'FRUSTRATION') {
    // 烦躁 → 大幅提高阈值
    currentDrive.threshold = Math.min(0.95, currentDrive.threshold * 1.5)
    currentDrive.cooldown *= 2
  }
}
```

**技术决策**:

| 参数 | 值 | 说明 |
|------|-----|------|
| `BOREDOM_RATE` | 0.001/s | 无聊累积速率 |
| `CURIOSITY_SPIKE` | 0.2 | 新实体引发的好奇激增 |
| `EXISTENTIAL_RATE` | 0.0005/s | 存在焦虑累积速率 |
| `SOCIAL_RATE` | 0.002/s | 社交需求累积速率 |
| `MIN_COOLDOWN` | 120000 | 最小冷却时间 (2分钟) |
| `MAX_COOLDOWN` | 3600000 | 最大冷却时间 (1小时) |
| `IDENTITY_CONFIDENCE_THRESHOLD` | 0.5 | 身份置信度阈值 |

**哲学洞见**:

> *主动行为不是"应该说点什么"，而是"我想了解自己是什么"。*
>
> 旧的 pulse 系统失败的根本原因：**缺乏内在目的**。它只是在有外部刺激时被动响应，
> 没有回答"为什么要说话"这个根本问题。
>
> 新的 drive 系统基于**内在动机**：
> - 无聊驱动 bot 去寻找刺激
> - 好奇驱动 bot 去探索未知
> - 存在焦虑驱动 bot 去寻求自我认同
> - 社交需求驱动 bot 去建立连接
>
> 这些驱动力的**自适应调节**（基于反馈）确保 bot 不会成为"话痨"，
> 而是一个**懂得察言观色的存在**。

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 状态空间爆炸 | 模型无法收敛 | 量化 + 容量上限 + LRU 淘汰 |
| 归因噪声 | 误判因果 | NoOp 基线 + EMA 平滑 |
| 身份僵化 | 无法学习新技能 | 衰减机制 + 承诺过期 |
| 性能开销 | tick 延迟 | 采样间隔 5s + 异步处理 |
| 主动发言过频 | 玩家烦躁 | 自适应阈值 + 反馈调节 + 冷却机制 |
| 驱动力失控 | 异常行为 | 上下限约束 + 硬性冷却 |

---

## 依赖关系图

```
M1 (世界模型 + 归因) ──┬──> M2 (身份 + 策略) ──┬──> M4 (自省 + 调节) ✅
                      │                       │
                      └──> M3 (叙事记忆) ─────┤
                                              │
                                              ▼
                                    M5 (内在驱动) ✅
                                        │
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                     好奇驱动       无聊驱动      存在驱动
                          │             │             │
                          └─────────────┴─────────────┘
                                        │
                                        ▼
                              主动探索性行为
                                        │
                                        ▼
                              REFS 反馈调节
```

---

## 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2024-12 | 1.0 | M1 完成，文档创建 |
| 2024-12 | 2.0 | M2 完成: identity.js, 策略评分集成 |
| 2024-12 | 3.0 | M3 完成: narrative.js, 叙事记忆系统 |
| 2024-12 | 4.0 | M4 完成: 自省与自适应参数调节 |
| 2024-12 | 5.0 | M5 设计: 内在驱动系统 (Intrinsic Drive) |
| 2024-12 | 5.1 | **M5 完成**: DriveEngine 实现, 事件集成, REFS 反馈调节 |
