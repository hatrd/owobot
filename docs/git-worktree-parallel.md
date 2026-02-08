# 基于 `git worktree` 的并行 Codex 流程

目标：让“主 Codex”（负责拆分任务/验收/合并）可以把任务分配给多个“子 Codex”，它们在独立 worktree 里并行改动，最后主 Codex 低成本 review + 合入。

## 约定

- 每个子任务 = 一个 worktree + 一个分支
- worktree 目录：`.worktrees/<slug>`
- 分支名：`wt/<slug>`
- 任务描述文件：`.worktrees/<slug>/TASK.md`

仓库提供脚本：`bash scripts/wt ...`

## 主 Codex：分配任务

1) 创建 worktree 并写入任务说明：

```bash
npm run wt -- assign observe-detail "完善 observe_detail 的容器读失败诊断输出，并补 dry 验证点"
```

2) 把下面这三样发给子 Codex（最小上下文切片）：

- `TASK.md` 的全文
- 你期望它只改哪些目录/文件（例如只改 `bot_impl/agent/`）
- 验收方式（怎么跑、怎么观察）

提示：可以让子 Codex 在完成后额外写一个 `HANDOFF.md`（变更摘要 + 如何测试）。

## 子 Codex：在 worktree 内开发

1) 进入 worktree：

```bash
cd .worktrees/drive-m5
```

2) 依赖处理（两选一）：

- 推荐（每个 worktree 独立）：`npm install`
- 省时间（共享主 worktree 的依赖，风险是依赖差异时会踩坑）：
  - 创建时加 `--link-deps`：`npm run wt -- new <slug> --link-deps`

3) 开发完成后，自检并整理交付物：

```bash
npm test
bash scripts/wt report drive-m5
```

把 `report` 输出 + `HANDOFF.md`（如有）交回主 Codex。

## 主 Codex：验收与合入

1) 看差异摘要（无需切换目录）：

```bash
bash scripts/wt report drive-m5
```

2) 合入（建议默认 squash，减少“子 Codex 的碎 commit”噪音）：

```bash
bash scripts/wt merge drive-m5 --squash
git commit
```

3) 清理 worktree（可选）：

```bash
bash scripts/wt close drive-m5 --delete-branch
```

## 和本仓库热重载的配合

- 尽量把功能放在 `bot_impl/`，保持 `bot.js` 只做 loader/wiring。
- 改动完成后再 `touch open_fire` 触发热重载（闸门是“最后人工确认”）。
- 多个 worktree 并行时，避免多个 bot 同时上线抢同一个账号；要并行跑，至少改 `MC_USERNAME` 和 `MC_LOG_DIR` 做隔离。

