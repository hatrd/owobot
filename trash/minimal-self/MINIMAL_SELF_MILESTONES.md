# Minimal Self - 里程碑

> 详细 API 与架构见 `MINIMAL_SELF_PROJECT.md`

## 进度总览

```
████████▒▒▒▒▒▒▒▒▒▒▒ 60%（M1-M4 被动运行，M5 驱动力未接通主动聊天）
```

| 里程碑 | 核心能力 | 交付文件 | 状态 |
|--------|----------|----------|------|
| M1 世界模型 | 预测 + 归因 | `world-model.js`, `attribution.js` | ✅ |
| M2 身份存储 | 技能统计 + 承诺 | `identity.js` | ✅ |
| M3 叙事记忆 | I-CAN / I-DID / I-OWE | `narrative.js` | ✅ |
| M4 自省调节 | 自适应 λ, β | `identity.js` 扩展 | ✅ |
| M5 内在驱动 | 四元驱动力 | `drive.js` | ⚠️ 触发禁用（历史刷屏问题，待修复） |

## 可验证计划（待完成）

| 编号 | 目标 | 验收标准 |
|------|------|----------|
| P1: 驱动力发言复活（防刷屏） | 重启 `drive.generateQuestion()`，仅在空闲/无外部任务时产出消息；保持 `toolUsed=drive:<type>` | - 当前执行任务/`externalBusy`/pathfinder goal 时不触发<br>- 空闲且有玩家时，每种驱动力最多 1 条/冷却周期<br>- `minimal-self:drive` 实际触发，`ai-chat` 发送 1 条消息并带 `toolUsed=drive:*` |
| P2: 反馈闭环恢复 | REFS `recentSignals` 的 `drive:*` 信号更新阈值/冷却 | - 发送 IGNORE 信号后，`drive.threshold` 上升且写回 state<br>- POSITIVE/FRUSTRATION 信号分别降低/提升阈值，下一次触发间隔随之变化 |
| P3: 身份/承诺接入聊天 | 在聊天工具执行链路调用 `scoreAction()`/`addCommitment()`，并把承诺/身份注入 context-bus | - AI 工具执行前可获取 `scoreAction` 结果并在低分时拒绝/提示<br>- 玩家请求承诺时生成 commitment，出现在 context-bus XML（不再默认注入 `buildIdentityContext()` 到 prompt） |
| P4: 驱动力事件入上下文 | 驱动力触发时写入 context-bus（事件流）供 LLM 参考 | - 触发时生成 `drive.<type>` 事件，能在 prompt XML 中看到<br>- 后续聊天中 LLM 可引用上一次驱动原因（可人工检查日志/prompt trace） |
| P5: 任务期不累积无聊 | 在执行任务或外部 busy 时冻结/衰减 boredom/social，避免再触发刷屏 | - `state.currentTask` 存在时 boredom/social 不增长（或衰减）<br>- 完成任务后才恢复积累；验证连续任务期间 drive 不触发 |

## 关键技术决策

| 决策 | 值 | 理由 |
|------|-----|------|
| 状态量化精度 | pos±2, hp±5 | 平衡精度与模型容量 |
| 归因公式 | `sigmoid(err_none - err_with)` | 预测误差差值量化因果 |
| 技能成熟阈值 | 5 次尝试 | 样本足够判断能力 |
| 身份衰减 | 0.02/小时 | 允许能力边界扩展 |
| 驱动力冷却 | 2min ~ 1h (自适应) | 防止过频打扰 |

## 依赖关系

```
M1 ──┬──> M2 ──┬──> M4
     └──> M3 ──┤
               └──> M5 ──> 主动行为
```

## 变更日志

| 版本 | 变更 |
|------|------|
| 5.2 | 校正状态：M5 触发未启用；新增可验证计划 P1-P5 |
| 5.1 | M5 完成: DriveEngine + REFS 反馈调节 |
| 4.0 | M4 完成: 自省 + 自适应参数 |
| 3.0 | M3 完成: 叙事记忆 |
| 2.0 | M2 完成: 身份存储 + 策略评分 |
| 1.0 | M1 完成: 世界模型 + 归因 |

---

*Date: 2025-01*
