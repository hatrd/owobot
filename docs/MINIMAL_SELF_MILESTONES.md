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

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 状态空间爆炸 | 模型无法收敛 | 量化 + 容量上限 + LRU 淘汰 |
| 归因噪声 | 误判因果 | NoOp 基线 + EMA 平滑 |
| 身份僵化 | 无法学习新技能 | 衰减机制 + 承诺过期 |
| 性能开销 | tick 延迟 | 采样间隔 5s + 异步处理 |

---

## 依赖关系图

```
M1 (世界模型 + 归因) ──┬──> M2 (身份 + 策略) ──┬──> M4 (自省 + 调节) ✅
                      │                       │
                      └──> M3 (叙事记忆) ─────┘
```

---

## 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2024-12 | 1.0 | M1 完成，文档创建 |
| 2024-12 | 2.0 | M2 完成: identity.js, 策略评分集成 |
| 2024-12 | 3.0 | M3 完成: narrative.js, 叙事记忆系统 |
| 2024-12 | 4.0 | M4 完成: 自省与自适应参数调节 |
