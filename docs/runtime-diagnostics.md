# 内存与事件循环排查

`runtime-diagnostics` 模块每 30 秒采样一次，`state.runtimeDiagnostics.samples` 最多 240 条（约两小时）。热重载保留数据，回收旧 timer、GC observer 和事件循环 histogram 后重新启动；重启进程会清空内存样本。每五分钟以及模块激活、连接断开时输出一条 `runtime.sample` 结构化 JSON 到正常日志，供跨重启对比。这些 event 证据不受 `.log` 的 verbosity 过滤；文件落盘仍由进程的 MC_LOG_FILE/MC_LOG_DIR 配置控制。

只读取证：

```bash
npm run interaction:dry
node scripts/botctl.js dry observe_detail what=runtime max=20
```

`max` 限制返回样本数，上限 240。查询只读已有数据，不强制 GC、不生成 heap snapshot、不重启、不改变采样频率。`ageMs` 表示最新样本年龄；`windowMs/deltaBytes` 是本次返回窗口内的首尾差，不是泄漏判定。

字段与单位：

- `memory`：Node process.memoryUsage，单位 bytes；rss、heapUsed、heapTotal、external、arrayBuffers。arrayBuffers 已包含在 external 内，不要重复相加。
- `eventLoop`：自上次采样以来的 p99Ms、maxMs。激活时暂无数据，值为 0。
- `gc`：采样间隔内 GC 次数、累计耗时、单次最大耗时，单位 ms；PerformanceObserver 异步投递可能使边界事件落在下一段。
- `counts`：实体、在线玩家、已加载区块、聊天/摘要/上下文/决策记录、记忆队列、承诺和技能任务数量。只计数，不输出聊天内容。
- `listeners`：bot 与 client 的事件监听器数量及各事件分布。
- `reloads`：本诊断模块在同一 shared state 的安装次数。激活样本较早，cleanups/listeners 尚未完成整轮安装；对比重载前后请用后续 interval 样本。

先收集同等负载下的一段样本，再对齐断线和 AI 错误时间：

```bash
rg -n 'runtime.sample|keepAliveError|Bot error|ai error' logs/bot-YYYY-MM-DD.log
```

RSS 上升而 heapUsed 回落可能与原生分配、区块缓存或堆保留有关；不能仅凭 RSS 判定泄漏。若 GC 后堆低点持续升高，再看哪个计数同步增长。若 maxMs 与 keepalive 超时接近，继续查同步计算、GC 暂停或大量区块加载。若采样长期停止，先检查进程与事件循环是否仍响应，而非把陈旧样本当健康状态。

历史基线：2026-09-18 03:51（Asia/Shanghai）断线日志记录 RSS 1122 MB、heapUsed 792 MB；2026-09-19 改造前 RSS 约 1.14 GiB。这只证明需要观测，不证明已定位泄漏。此模块用于形成后续诊断证据，不自动杀进程或宣称修复内存问题。
