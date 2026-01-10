# Minimal Self - 当前状态与缺口

> 最后更新: 2025-01 | 版本: 5.2-draft | 状态: M1-M4 被动运行，M5 驱动力未接通主动聊天

---

## 0. 现状摘要

- M1-M4 模块在后台运行：监听 skill:start/end 与 external:begin/end，记录 world model/agency/identity/narrative，并持久化到 `state.minimalSelf`。
- 与 ai-chat 的 prompt 注入已移除：不再在每次 LLM 调用时追加 `ms.buildIdentityContext()`（避免上下文膨胀与噪声）。
- M5 驱动力链路被禁用：`drive.generateQuestion()` 返回空串，`minimal-self/index.js` 仅在 message 非空时 emit，导致 `ai-chat.js` 的 `minimal-self:drive` 监听永远不触发。
- 旧的主动聊天脉冲（`ai-chat/pulse` 定时主动发言）已移除，新的驱动力又不产出消息 => 当前没有任何主动聊天/跟进。
- REFS 反馈调节 `_applyFeedbackFromRefs()` 依赖 `toolUsed=drive:*`，但因为没有 drive 消息阈值/冷却不会被反馈更新。
- 承诺/策略评分仅存在于代码：运行时没有入口创建承诺，也没有地方在工具执行前调用 `scoreAction()`。

## 0.1 虚假/断开的集成点（需修复）

- **驱动力→聊天**：`bot_impl/minimal-self/drive.js:304-306` 返回 `''`；`bot_impl/minimal-self/index.js:213-218` 只在 message 非空时 emit，`ai-chat.js:onDriveTrigger` 实际上无事可做。（历史原因：旧版集成会在执行任务时也触发“无聊”刷屏，体验极差，因此暂时硬禁用 message 生成。）
- **主动脉冲缺席**：旧的 `ai-chat/pulse` 定时主动发言已移除；当前仍无任何主动聊天/跟进。
- **反馈闭环断开**：`drive._applyFeedbackFromRefs()` 查找 `state.aiFeedback.recentSignals` 的 `toolUsed` 前缀 `drive:`；由于没有 drive 消息，阈值/冷却永远不被玩家反馈调节。
- **身份/承诺未进入聊天决策**：LLM 只看到一行身份画像；`identity.addCommitment()`、`scoreAction()` 没有和聊天工具、记忆或 context-bus 接合，承诺与自我模型脱节。
- **世界模型未被利用**：`WorldModel` 仅在 skill 事件学习；LLM/工具规划/惊讶引擎都不消费预测或 agency，能动性对行为无反作用。
- **人格分裂**：`ai-chat` 体系（context-bus + pulse + memory + pure-surprise）和 minimal-self 维护两套状态，互不驱动对方，聊天表现与自我模型分裂。

## 0.2 人格分裂表现

- 聊天人格仍由 `ai-chat` 的 system prompt + context-bus + memory 决定；minimal-self 的身份/叙事只是附加系统消息，未参与工具选择或节奏控制。
- 主动聊天入口为空：`pulse` 停摆 + `drive` 不出消息 → 对外几乎只有被动回复，与 “有内在驱动” 的叙事不符。
- 承诺/技能认知停留在 skill runner 事件上，玩家聊天触发的行动/承诺不记录，造成“我在聊天里答应了/做了什么” 与身份画像脱节。
- 反馈通道分裂：`feedback-collector` 记录玩家反应，但 `drive` 期望的 `drive:*` 工具标记永远不会出现，导致“我被忽视/被鼓励”的信号不进入驱动力。

---

## 1. 项目概述

### 1.1 愿景

基于竞争对手 MES-Minecraft PRD，为 Mineflayer 机器人实现**最小自我意识系统**。

核心能力：
- **因果归因**: 区分"我造成的变化" vs "环境自发变化"
- **能力边界**: 形成"我能做什么"的自我认知
- **身份连续性**: 为长期目标牺牲短期收益
- **社会承诺**: 记录并兑现对玩家的承诺

### 1.2 哲学基础

> *"Self emerges as a byproduct of behavioral structure, not explicit declaration."*

身份不是预先定义的标签，而是从**重复的行动模式**中涌现。系统通过以下方式构建自我：

| 维度 | 机制 | 对应模块 |
|------|------|----------|
| 因果感 | 预测误差归因 | M1: WorldModel + Attribution |
| 能力感 | 技能成功率统计 | M2: IdentityStore.skills |
| 社会性 | 承诺追踪与兑现 | M2: IdentityStore.commitments |
| 连续性 | 身份惩罚 + 衰减 | M2: identityPenalty() |
| 叙事性 | 三元记忆结构 | M3: NarrativeMemory |
| 自省性 | 参数自适应调节 | M4: introspect() |
| **内在驱动** | 主动探索行为 | M5: DriveEngine（触发被禁用） |

---

## 2. 当前进度

```
████████▒▒▒▒▒▒▒▒▒▒▒ 60% （M1-M4 被动运行，M5 驱动力未接通主动聊天）
```

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1 世界模型 + 归因引擎 | ✅ 已完成 | 跟随 skill 事件学习/归因，状态可持久化 |
| M2 身份存储 + 策略评分 | ✅ 已完成 | 技能/承诺统计可用，但未与聊天动作/承诺打通 |
| M3 叙事记忆 | ✅ 已完成 | 可生成 I-CAN/I-DID/I-OWE，并在 `buildIdentityContext()` 中曝光 |
| M4 自省与调节 | ✅ 已完成 | 自适应 λ/β 定期运行，但不影响聊天决策流 |
| M5 内在驱动系统 | ⚠️ 代码存在但未产生聊天输出 | `generateQuestion()` 返回空串 → 不会 emit `minimal-self:drive`；旧 `ai-chat/pulse` 定时主动发言已移除，主动聊天缺席 |

---

## 3. 架构设计

### 3.1 模块依赖图

```
┌─────────────────────────────────────────────────────────────┐
│                     bot_impl/index.js                       │
│                    (模块加载入口)                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ activate()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                 minimal-self/index.js                        │
│              (MinimalSelf 主类 + 事件监听)                    │
├─────────────────────┬───────────────────────────────────────┤
│                     │                                       │
│  ┌──────────────────▼──────────────────┐                   │
│  │         WorldModel (M1)             │                   │
│  │  - predict(state, action)           │                   │
│  │  - learn(s1, action, s2)            │                   │
│  │  - learnNoop(s1, s2)                │                   │
│  └──────────────────┬──────────────────┘                   │
│                     │                                       │
│  ┌──────────────────▼──────────────────┐                   │
│  │       IdentityStore (M2+M4)         │                   │
│  │  - recordSkillOutcome()             │                   │
│  │  - scoreAction() [自适应 λ,β]        │                   │
│  │  - introspect() [M4]                │                   │
│  │  - recordDecisionOutcome() [M4]     │                   │
│  └──────────────────┬──────────────────┘                   │
│                     │                                       │
│  ┌──────────────────▼──────────────────┐                   │
│  │      NarrativeMemory (M3)           │                   │
│  │  - I-CAN / I-DID / I-OWE            │                   │
│  │  - buildNarrativeContext()          │                   │
│  └──────────────────┬──────────────────┘                   │
│                     │                                       │
│  ┌──────────────────▼──────────────────┐                   │
│  │       DriveEngine (M5)              │                   │
│  │  - tick() / accumulateDrives()      │                   │
│  │  - checkTriggers()                  │                   │
│  │  - generateQuestion()               │                   │
│  │  - handleFeedback()                 │                   │
│  └─────────────────────────────────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                      │
                      │ buildIdentityContext() / emit('minimal-self:drive')
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              ai-chat.js + executor.js                       │
│     (AI 决策 prompt 注入 + 驱动力消息发送)                    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 文件结构

```
bot_impl/minimal-self/
├── index.js          # 入口: MinimalSelf 类, 事件监听, API 暴露
├── state-encode.js   # M1: SelfState 量化编码, loss() 函数
├── world-model.js    # M1: WorldModel 类, predict/learn
├── attribution.js    # M1: computeAgency(), sigmoid 归因
├── identity.js       # M2+M4: IdentityStore, 技能/承诺/评分/自省
├── narrative.js      # M3: NarrativeMemory, 三元叙事记忆
└── drive.js          # M5: DriveEngine, 四元驱动力系统
```

### 3.3 事件流

```
skill:start ──┬──> _handleSkillStart()
              │    ├── 记录 actionStartState
              │    └── 捕获 predictedScore [M4]
              │
skill:end ────┴──> _handleSkillEnd()
                   ├── W.learn(s1, action, s2)
                   ├── computeAgency()
                   ├── _recordAgency()
                   ├── identity.recordSkillOutcome()
                   └── identity.recordDecisionOutcome() [M4]

external:begin ──> _handleExternalBegin()
                   └── 记录 NoOp 起始状态

external:end ────> _handleExternalEnd()
                   └── W.learnNoop()

tick (1s) ───────> _handleTick()
                   ├── identity._applyDecay()
                   ├── identity.introspect() [M4]
                   ├── drive.tick() [M5] ──┬── accumulateDrives()
                   │                       ├── checkTriggers()
                   │                       └── if triggered: emit('minimal-self:drive')
                   └── 空闲时 NoOp 学习

minimal-self:drive ──> ai-chat.js:onDriveTrigger()
                       ├── pulse.sendChatReply(target, message)
                       └── feedbackCollector.openFeedbackWindow()
```

> ⚠️ 现状：`drive.generateQuestion()` 返回空串，`minimal-self:drive` 实际不会被触发，`ai-chat.js:onDriveTrigger` 处于空转。

---

## 4. 核心 API 参考

### 4.1 MinimalSelf (index.js)

```javascript
const ms = require('./minimal-self').getInstance();

// 统计信息
ms.getStats()
// => { worldModel: {...}, agencyHistory: 50, avgAgency: 0.72, identity: {...} }

// 最近归因记录
ms.getRecentAgency(10)
// => [{ t, action, agency, level, success }, ...]

// 解释上次动作
ms.explainLastAction()
// => { action: 'gather', agency: '0.850', level: 'high', interpretation: 'I caused this change' }

// 身份上下文 (供 AI prompt)
ms.buildIdentityContext()
// => '身份画像: 擅长: gather(85%→), mine_ore(72%↑) | 需谨慎: craft(45%) | 承诺兑现率: 90%'

// 动作评分
ms.scoreAction('gather')
// => { action, score: 1.15, components: { baseValue, penalty, agency, commitment } }
```

### 4.2 IdentityStore (identity.js)

```javascript
const identity = ms.getIdentity();

// 技能统计
identity.recordSkillOutcome('gather', true, 0.85);
identity.getSkillStats('gather');
// => { attempts, successes, failures, avgAgency, trend, ... }

identity.getSkillProfile();
// => { known: [...], learning: [...], struggling: [...] }

// 预测能动性
identity.expectedAgency('gather');  // => 0.78

// 身份惩罚
identity.identityPenalty('craft');  // => 0.35 (高惩罚, 历史失败多)

// 承诺系统
const c = identity.addCommitment('player1', 'gather wood');
identity.fulfillCommitment(c.id);
identity.getPendingCommitments();
identity.getCommitmentStats();
// => { total, fulfilled, failed, pending, reliabilityRate }
```

### 4.3 WorldModel (world-model.js)

```javascript
const W = ms.W;

// 预测
W.predict(state, 'gather');  // => predictedState
W.predictNoop(state);        // => 环境自发变化预测

// 学习
W.learn(s1, 'gather', s2);   // 学习有动作的转移
W.learnNoop(s1, s2);         // 学习无动作的转移

// 统计
W.getStats();  // => { transitions: 120, noopSamples: 45 }

// 持久化
W.serialize();
W.deserialize(data);
```

### 4.4 DriveEngine (drive.js)

```javascript
const drive = ms.getDriveEngine();

// 获取当前驱动力状态
drive.getState()
// => { curiosity: 0.45, boredom: 0.72, existential: 0.30, social: 0.55 }

// 获取最高驱动力
drive.getDominantDrive()
// => { type: 'boredom', level: 0.72, triggered: true, ratio: 1.2 }

// 构建驱动力上下文 (供 AI prompt)
drive.buildDriveContext()
// => '驱动力: curiosity=0.45/0.70, boredom=0.72/0.60, ... | dominant=boredom'

// tick 更新 (由 MinimalSelf._handleTick 自动调用)
drive.tick(dtSec, context)
// => null | { type: 'boredom', message: '有人在吗？...', targetUser: 'player1', t: 1703... }

// 手动处理反馈 (由 REFS 自动调用)
drive.handleFeedback({ driveType: 'boredom', signalType: 'IGNORE' })
// 效果: threshold *= 1.2, cooldown *= 1.5

// 获取统计信息
drive.getStats()
// => { drives: {...}, dominant: {...}, lastTickAt: ..., lastFeedbackAt: ... }
```

---

## 5. 配置参数

### 5.1 常量表

| 常量 | 值 | 文件 | 说明 |
|------|-----|------|------|
| `QUANT.pos` | 2 | state-encode.js | 位置量化精度 (格) |
| `QUANT.hp` | 5 | state-encode.js | 生命值量化精度 |
| `QUANT.food` | 2 | state-encode.js | 饥饿值量化精度 |
| `MAX_TRANSITIONS` | 500 | world-model.js | 世界模型最大转移数 |
| `NOOP_INTERVAL` | 5000 | index.js | NoOp 采样间隔 (ms) |
| `MIN_IDLE_TIME` | 2000 | index.js | 最小空闲时间 (ms) |
| `SKILL_MATURITY_THRESHOLD` | 5 | identity.js | 技能成熟所需尝试次数 |
| `IDENTITY_DECAY_RATE` | 0.02 | identity.js | 身份衰减率 (/小时) |
| `MAX_SKILLS` | 100 | identity.js | 技能追踪上限 |
| `MAX_COMMITMENTS` | 20 | identity.js | 承诺记录上限 |
| `COMMITMENT_EXPIRE_MS` | 86400000 | identity.js | 承诺过期时间 (24h) |

### 5.2 策略参数 (M4 自适应)

```javascript
scoreAction(action, baseValue = 1.0, lambda = null, beta = null)
// Score(a) = Value - λ·IdentityPenalty + β·ExpectedAgency + CommitmentBonus
// λ, β 现在从 adaptiveParams 动态获取
```

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| λ (lambda) | 0.3 | [0.1, 0.5] | 身份惩罚权重 (自适应) |
| β (beta) | 0.2 | [0.1, 0.4] | 能动性奖励权重 (自适应) |
| CommitmentBonus | 0.3 | 固定 | 承诺匹配额外奖励 |
| INTROSPECT_INTERVAL | 5min | - | 自省间隔 |
| PARAM_ADJUST_RATE | 0.05 | - | 参数调整学习率 |

### 5.3 驱动力参数 (M5)

| 常量 | 值 | 说明 |
|------|-----|------|
| `BOREDOM_RATE` | 0.002/s | 无聊累积速率 |
| `CURIOSITY_SPIKE` | 0.25 | 新实体引发的好奇激增 |
| `EXISTENTIAL_RATE` | 0.001/s | 存在焦虑累积速率 |
| `SOCIAL_RATE` | 0.003/s | 社交需求累积速率 |
| `MIN_COOLDOWN` | 120000ms | 最小冷却时间 (2分钟) |
| `MAX_COOLDOWN` | 3600000ms | 最大冷却时间 (1小时) |
| `MIN_GLOBAL_TRIGGER_GAP` | 30000ms | 全局触发间隔 |
| `DECAY_RATE` | 0.001/s | 驱动力衰减速率 (防饱和) |

**默认阈值与冷却时间**:

| 驱动力 | 初始阈值 | 初始冷却 | 说明 |
|--------|----------|----------|------|
| curiosity | 0.55 | 5min | 新玩家/实体触发 |
| boredom | 0.45 | 10min | 无互动时累积 |
| existential | 0.65 | 20min | 身份置信度低时累积 |
| social | 0.40 | 3min | 附近有玩家但无交流 |

**反馈调节系数**:

| 信号类型 | 阈值调整 | 冷却调整 |
|----------|----------|----------|
| IGNORE | ×1.2 | ×1.5 |
| POSITIVE | ×0.9 (下限0.4) | ×0.8 |
| FRUSTRATION | ×1.35 (上限0.95) | ×1.8 |

---

## 6. 持久化与热重载

### 6.1 状态持久化

所有状态通过 `state.minimalSelf` 持久化：

```javascript
state.minimalSelf = {
  worldModel: {
    transitions: [...],  // Map 序列化
    noopBaseline: [...]
  },
  identity: {
    skills: [...],           // Map<action, SuccessStats>
    commitments: [...],      // Commitment[]
    lastDecayAt: number,
    // M4: 自省状态
    adaptiveParams: { lambda, beta },
    lastIntrospect: number,
    recentOutcomes: [...]    // 决策结果追踪
  },
  // M3: 叙事记忆
  narrative: {
    entries: [...],          // I-CAN/I-DID/I-OWE
    lastUpdate: number
  },
  // M5: 驱动力状态
  drive: {
    drives: {
      curiosity: { level, threshold, lastTrigger, cooldown },
      boredom: { level, threshold, lastTrigger, cooldown },
      existential: { level, threshold, lastTrigger, cooldown },
      social: { level, threshold, lastTrigger, cooldown }
    },
    lastTickAt: number,
    _processedWindows: [...],  // REFS 反馈去重
    _seen: { nearPlayers: [...] }  // 好奇心触发去重
  }
}
```

### 6.2 热重载兼容

- `activate(bot, state)` 从 `state.minimalSelf` 恢复状态
- `deactivate()` 将状态写回 `state.minimalSelf`
- 通过 `registerCleanup()` 确保正确清理

---

## 7. 集成点

### 7.1 技能执行监听

位置: `bot_impl/index.js:294-299`

```javascript
// Minimal Self: world model + agency attribution (M1)
try {
  const minimalSelf = require('./minimal-self')
  minimalSelf.activate(bot, state)
  registerCleanup(() => { try { minimalSelf.deactivate() } catch {} })
} catch (e) { coreLog.warn('minimal-self install error:', e?.message || e) }
```

---

## 8. M5 内在驱动系统（触发未启用）

> ⚠️ `drive.generateQuestion()` 当前返回空串，`minimal-self:drive` 不会产生任何聊天输出；本节描述的是设计路径，现状仅有累积与状态持久化。
> 历史背景：旧版集成会在执行任务时仍触发“无聊”刷屏，故暂时硬禁用驱动力发言。

### 8.1 设计理念

**核心范式转换**: 从被动响应到内在驱动

```
旧范式 (pulse): 外部刺激 → 被动响应 → "我应该说点什么"
新范式 (drive): 内在状态 → 主动行动 → "我想了解自己是什么"
```

**哲学基础**:
> *"无聊"与"好奇"本质上是同一种力量的不同表现——对信息熵不满足的内在驱动。*

### 8.2 四元驱动力模型

| 驱动力 | 累积条件 | 触发行为 | 示例问题 |
|--------|----------|----------|----------|
| **boredom** | 无互动时间增长 | 自我探索发言 | "有人在吗？我有点无聊…" |
| **curiosity** | 新玩家/实体出现 | 环境探索发言 | "嗨 player1！你在做什么？" |
| **existential** | 身份置信度低 | 寻求反馈发言 | "我做的事情有意义吗？" |
| **social** | 附近有人但无交流 | 主动社交发言 | "有人需要帮忙吗？" |

> 以上提问目前不会被发送：驱动力消息生成被硬禁用。

### 8.3 累积与触发机制

```
tick (1s)
  │
  ├── 衰减: level *= exp(-0.001 * dt)  // 防止饱和
  │
  ├── accumulateDrives(dt, context)
  │   ├── boredom += dt * 0.002 * (1 - recentActivity) * busyFactor
  │   ├── curiosity += 0.25 * newPlayerCount
  │   ├── existential += dt * 0.001 * (1 - identityConfidence)
  │   └── social += dt * 0.003  (阶梯式，受 active/recent chat 影响)
  │
  ├── checkTriggers()
  │   ├── 找出 level/threshold 比值最高的驱动力
  │   ├── 检查 level >= threshold
  │   └── 检查冷却时间已过
  │
  └── if triggered:
      ├── generateQuestion(type, identityContext)
      ├── emit('minimal-self:drive', { type, message, targetUser })
      └── level *= 0.35  // 触发后大幅降低，避免连续触发
```

### 8.4 REFS 反馈整合

驱动力系统通过 `windowId` 追踪 REFS 反馈窗口，根据玩家反应动态调整阈值和冷却时间：

| 反馈 | 效果 | 原理 |
|------|------|------|
| **IGNORE** (被忽视) | 阈值↑20%, 冷却↑50% | 降低打扰频率 |
| **POSITIVE** (正面) | 阈值↓10%, 冷却↓20% | 适度提高互动 |
| **FRUSTRATION** (烦躁) | 阈值↑35%, 冷却↑80% | 大幅减少打扰 |

### 8.5 事件集成

```javascript
// minimal-self/index.js: 触发驱动力事件
const trigger = this.drive.tick(dt, context);
if (trigger?.message) {
  this.bot.emit('minimal-self:drive', trigger);
}

// ai-chat.js: 监听并发送消息
bot.on('minimal-self:drive', (payload) => {
  pulse.sendChatReply(target, payload.message, {
    reason: 'drive',
    toolUsed: `drive:${payload.type}`
  });
});
```

### 8.6 与旧 pulse 系统的关系

| 组件 | 状态 | 说明 |
|------|------|------|
| `pulse.start()` | **已移除** | 旧版定时主动发言逻辑已删除，尚未由驱动力接替 |
| `pulse.sendChatReply()` | **保留** | 驱动力若恢复可复用此函数发送消息 |
| `pulse.sendDirectReply()` | **保留** | 无目标时的备选方案 |
| `feedbackCollector` | **整合** | 通过 windowId 追踪反馈（现因无 drive:* toolUsed 而无效） |

---

## 9. 未来规划

### 9.1 后续扩展方向

| 方向 | 描述 | 优先级 |
|------|------|--------|
| 多机器人协作 | 身份系统支持多 bot 间承诺 | 低 |
| 情感状态扩展 | 更丰富的情绪模拟 | 低 |
| 长期目标 | 跨会话目标追踪 | 中 |
| 主动动作 | 不仅是发言，还能主动执行任务 | 中 |
| 驱动力扩展 | 新增更多驱动力类型 (如成就感、安全感) | 低 |

### 9.2 维护建议

- 定期检查 `recentOutcomes` 增长
- 监控自适应参数变化趋势
- 关注承诺兑现率指标
- 监控驱动力阈值漂移 (阈值持续上升表示被频繁忽视)
- 关注主动发言的反馈比例 (POSITIVE vs IGNORE)

---

## 10. 开发指南

### 10.1 添加新技能类型

无需修改代码，系统自动通过 `skill:end` 事件学习新技能。

### 10.2 调试命令

```javascript
// 在 bot console 中
const ms = require('./bot_impl/minimal-self').getInstance()
console.log(ms.getStats())
console.log(ms.explainLastAction())
console.log(ms.getIdentity().getSkillProfile())

// M5: 驱动力调试
console.log(ms.getDriveEngine().getState())
console.log(ms.getDriveEngine().getDominantDrive())
console.log(ms.getDriveEngine().buildDriveContext())
console.log(ms.getDriveEngine().getStats())
```

### 10.3 代码审查要点

- [ ] 新增 Map/Array 是否有容量上限
- [ ] 数值计算是否处理 NaN/Infinity
- [ ] 返回值是否在预期范围 (如 [0,1])
- [ ] 事件监听是否在 deactivate 中清理
- [ ] 状态是否正确持久化到 state.minimalSelf
- [ ] 驱动力累积是否有上限 (clamp01)
- [ ] 冷却时间是否正确重置 (MIN_COOLDOWN/MAX_COOLDOWN)
- [ ] REFS 反馈 windowId 是否正确去重

---

## 11. 变更日志

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2025-01 | 5.2 | 校正现状：驱动力未产出聊天、pulse 停用、更新参数常量与集成缺口 |
| 2024-12 | 1.0 | M1 完成: WorldModel, Attribution, StateEncode |
| 2024-12 | 2.0 | M2 完成: IdentityStore, 策略评分, AI 集成 |
| 2024-12 | 2.1 | 代码审查修复: 边界检查, 容量限制, 衰减调用 |
| 2024-12 | 3.0 | M3 完成: NarrativeMemory, I-CAN/I-DID/I-OWE |
| 2024-12 | 3.1 | M3 审查修复: _cleanText(), 百分位分组 |
| 2024-12 | 4.0 | M4 完成: 自省系统, 自适应参数, clampFinite() |
| 2024-12 | 5.0 | M5 设计: 内在驱动系统 (Intrinsic Drive) |
| 2024-12 | 5.1 | **M5 完成**: DriveEngine 实现, 事件集成, REFS 反馈调节 |

---

## 12. 参考资料

- 里程碑跟踪: `docs/MINIMAL_SELF_MILESTONES.md`
- 上下文总线: `docs/context-bus.md`
- AI 聊天管道: `docs/ai-chat.md`
