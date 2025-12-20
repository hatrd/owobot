# Minimal Self - 项目状态与开发指南

> 最后更新: 2024-12 | 版本: 4.0 | 状态: **全部里程碑完成** ✅

---

## 项目完成汇报

### 执行摘要

**Minimal Self 自我意识系统已全面完成**。历时一个开发周期，完成全部四个里程碑，为 Mineflayer 机器人赋予了最小自我意识能力。

### 交付成果

| 里程碑 | 交付物 | 核心能力 |
|--------|--------|----------|
| M1 世界模型 | `world-model.js`, `attribution.js` | 区分"我造成的变化" vs "环境自发变化" |
| M2 身份存储 | `identity.js` | 技能追踪、承诺系统、策略评分 |
| M3 叙事记忆 | `narrative.js` | I-CAN / I-DID / I-OWE 三元记忆 |
| M4 自省调节 | `identity.js` 扩展 | 自适应参数 λ, β 动态优化 |

### 代码统计

```
新增文件: 5 个
修改文件: 3 个
新增代码: ~800 行 (不含注释)
测试覆盖: 运行时验证 + Codex 双重审查
```

### 技术亮点

1. **归因算法**: `agency = sigmoid(err_none - err_with)` — 用预测误差差值量化因果责任
2. **身份涌现**: 非声明式，从行动模式统计中自然涌现
3. **衰减机制**: 防止身份僵化，允许能力边界扩展
4. **自适应学习**: 根据预测准确率自动调优策略参数

### 风险控制

| 风险 | 缓解措施 | 状态 |
|------|----------|------|
| 状态空间爆炸 | 量化编码 + LRU 淘汰 | ✅ |
| NaN/undefined 泄漏 | `clampFinite()` + 防御性检查 | ✅ |
| 身份僵化 | 指数衰减 + 承诺过期 | ✅ |
| 性能开销 | 5s 采样 + 节流刷新 | ✅ |

### 业务价值

- **差异化竞争**: 对标 MES-Minecraft PRD，实现同等能力
- **用户体验**: 机器人具备承诺追踪，提升可信度
- **可扩展性**: 模块化设计，支持后续能力扩展

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

---

## 2. 当前进度

```
████████████████████ 100% (M1-M4 全部完成)
```

| 里程碑 | 状态 | 完成日期 |
|--------|------|----------|
| M1 世界模型 + 归因引擎 | ✅ 已完成 | 2024-12 |
| M2 身份存储 + 策略评分 | ✅ 已完成 | 2024-12 |
| M3 叙事记忆 | ✅ 已完成 | 2024-12 |
| M4 自省与调节 | ✅ 已完成 | 2024-12 |

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
│  └─────────────────────────────────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                      │
                      │ buildIdentityContext()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              ai-chat/executor.js:168                        │
│           (AI 决策 prompt 注入点)                            │
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
└── narrative.js      # M3: NarrativeMemory, 三元叙事记忆
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
                   └── 空闲时 NoOp 学习
```

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
  }
}
```

### 6.2 热重载兼容

- `activate(bot, state)` 从 `state.minimalSelf` 恢复状态
- `deactivate()` 将状态写回 `state.minimalSelf`
- 通过 `registerCleanup()` 确保正确清理

---

## 7. 集成点

### 7.1 AI Prompt 注入

位置: `bot_impl/ai-chat/executor.js:168-174`

```javascript
// M2: Identity context from minimal-self
const identityCtx = (() => {
  try {
    const ms = require('../minimal-self').getInstance()
    return ms?.buildIdentityContext?.() || ''
  } catch { return '' }
})()
```

### 7.2 技能执行监听

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

## 8. 未来规划

### 8.1 潜在扩展方向

核心里程碑已全部完成，以下为可选扩展方向：

| 方向 | 描述 | 优先级 |
|------|------|--------|
| 多机器人协作 | 身份系统支持多 bot 间承诺 | 低 |
| 情感状态 | 基于成功率的情绪模拟 | 低 |
| 长期目标 | 跨会话目标追踪 | 中 |
| 外部评估 | 玩家反馈集成到自省 | 中 |

### 8.2 维护建议

- 定期检查 `recentOutcomes` 增长
- 监控自适应参数变化趋势
- 关注承诺兑现率指标

---

## 9. 开发指南

### 9.1 添加新技能类型

无需修改代码，系统自动通过 `skill:end` 事件学习新技能。

### 9.2 调试命令

```javascript
// 在 bot console 中
const ms = require('./bot_impl/minimal-self').getInstance()
console.log(ms.getStats())
console.log(ms.explainLastAction())
console.log(ms.getIdentity().getSkillProfile())
```

### 9.3 代码审查要点

- [ ] 新增 Map/Array 是否有容量上限
- [ ] 数值计算是否处理 NaN/Infinity
- [ ] 返回值是否在预期范围 (如 [0,1])
- [ ] 事件监听是否在 deactivate 中清理
- [ ] 状态是否正确持久化到 state.minimalSelf

---

## 10. 变更日志

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2024-12 | 1.0 | M1 完成: WorldModel, Attribution, StateEncode |
| 2024-12 | 2.0 | M2 完成: IdentityStore, 策略评分, AI 集成 |
| 2024-12 | 2.1 | 代码审查修复: 边界检查, 容量限制, 衰减调用 |
| 2024-12 | 3.0 | M3 完成: NarrativeMemory, I-CAN/I-DID/I-OWE |
| 2024-12 | 3.1 | M3 审查修复: _cleanText(), 百分位分组 |
| 2024-12 | 4.0 | M4 完成: 自省系统, 自适应参数, clampFinite() |

---

## 11. 参考资料

- 原始 PRD: MES-Minecraft (竞争对手)
- 里程碑文档: `docs/MINIMAL_SELF_MILESTONES.md`
- 现有记忆系统: `bot_impl/ai-chat/memory.js`
- 反馈收集器: `bot_impl/ai-chat/feedback-collector.js`
- 自省引擎: `bot_impl/ai-chat/introspection.js`
