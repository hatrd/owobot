# AGENT_OPS.md

这份文档是后续 AI 运维本项目的入口。先读本文件，再根据故障类型查 `docs/interaction.md`、`docs/hot-reload.md` 和生成的 schema 文档。

运维判断必须以 live schema、结构化状态和可回放日志为准；不要从自然语言 action 或散落字符串猜测状态，也不要用一次成功的人工观察替代控制面证据。

## 运行结构

- `bot.js`：连接 Minecraft、装载 `bot_impl/`、提供热重载和 Unix socket 控制面。
- `scripts/bot-watch.js`：监督 bot 进程并在异常退出后自动重启；长期运行优先使用 watcher。
- `scripts/start-bot.sh` / `npm start`：进入仓库并启动 watcher（默认 `--takeover=true`）。
- `.mcbot.pid`：当前 bot 子进程 PID；`.mcbot.sock`：控制面 socket。
- `logs/bot-YYYY-MM-DD.log`：按日运行日志；不要把 API key 写入日志或贴到报告中。
- `open_fire`：热重载闸门。只有确认改动可加载时才触碰它。
- `data/`：AI memory、people、greet zones 和玩家统计等持久数据。

当前实例的连接和 AI 配置来自环境变量：`MC_HOST`、`MC_PORT`、`MC_USERNAME`、`MC_AUTH`、`MC_PASSWORD`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_PATH`、`DEEPSEEK_MODEL`（也支持 `AI_MODEL`）。环境变量在进程启动时固定。

## 常规启动

在仓库根目录执行：

```bash
cd /home/oyxy/src/mcbot
npm start
```

这是前台 watcher，适合人工维护或交给 systemd/tmux/supervisor 托管。直接运行 `npm run bot:start:direct` 只用于短时诊断，不适合作为生产守护方式。

需要脱离当前终端时，使用明确的进程组和日志路径，不要启动多个 watcher：

```bash
cd /home/oyxy/src/mcbot
setsid env DEEPSEEK_MODEL="<model>" node scripts/bot-watch.js --takeover=true \
  </dev/null >/tmp/mcbot-watch.log 2>&1 &
```

生产环境应把同样的命令交给进程管理器；不要把 API key 直接写进命令行或本文件。

启动后立即确认：

```bash
node scripts/botctl.js hello
ps -ef | rg 'bot-watch|/home/oyxy/src/mcbot/bot.js' | rg -v rg
```

`hello` 应返回 `ok: true`、`hasBot: true`、当前 PID 和 schema hash。

## 停止、重启和接管

优先使用控制面重启，让 watcher 接管后续拉起：

```bash
node scripts/botctl.js restart
```

若 socket 不可用，先定位精确的 watcher PID，再发送 `SIGINT`；不要使用无范围的 `pkill node`：

```bash
ps -eo pid,ppid,stat,cmd | rg 'bot-watch|/home/oyxy/src/mcbot/bot.js' | rg -v rg
kill -INT <watcher-pid>
npm start
```

`npm run bot:restart` 会启动一个前台 direct bot，已有 watcher 时不要用它作为日常重启命令，避免形成两个监督链。

## AI 配置和模型切换

配置文件（例如 `~/.bashrc`）修改后，必须重启进程；热重载不会刷新进程环境变量。运行中的前台 bot 也可以通过 stdin CLI 更新状态：

```text
.ai info
.ai model <model-id>
.ai base <base-url>
.ai path /v1/chat/completions
.ai env reload ~/.bashrc
```

`.ai env reload` 只更新当前进程状态；要让 watcher 下次重启仍使用新值，必须同步修改启动环境（通常是 `~/.bashrc` 或进程管理器配置）。

每次模型或 provider 变更后都执行：

```bash
node scripts/botctl.js ai-connectivity timeoutMs=12000 maxOutputTokens=128
```

只接受返回 `result.ok: true`、HTTP 200 且有非空 `reply` 的结果。不要用 `tool.run` 做连通性测试。

## 代码改动与热重载

默认只修改 `bot_impl/`，共享状态收束在 `state`。每次改动按顺序执行：

```bash
node --check <每个改动的.js文件>
npm run bot:reload
node scripts/botctl.js schema ctl
node scripts/botctl.js schema observe
node scripts/botctl.js schema tool
npm run interaction:dry
```

涉及观察能力时，再做只读取证：

```bash
node scripts/botctl.js dry observe_detail what=entities radius=32 max=20
node scripts/botctl.js dry observe_detail what=cats radius=32 max=10
node scripts/botctl.js dry observe_detail what=containers radius=20 max=8
```

涉及交互契约、入口、脚本或运行方式时，更新快照并检查文档漂移：

```bash
npm run interaction:docgen
```

AI 只能执行 dry interaction。`tool.run` 和服务器内真实操作必须由真人明确执行；不要为了验证而移动、挖掘、攻击、发送公屏消息或操作语音。

## 日志和故障排查

先看当前日志，而不是猜状态：

```bash
latest="logs/bot-$(date +%F).log"
tail -120 "$latest"
rg -n 'ERROR|FATAL|\[WARN\]|ai error|external call|keepAlive|reconnect|Connected to server|joined the game' "$latest"
```

常见信号：

- `HTTP 401/403`：key 无效、过期或权限不足。只检查是否存在，不要打印 key。
- `HTTP 404`：模型 ID、路径或账号权限不匹配；先查询 provider 的 `/models`，再用 `ai-connectivity` 验证。
- `HTTP 410`：模型已下线，立即切换到 provider 当前可用型号并重启。
- `HTTP 429`：限流或额度耗尽；记录时间、模型、重试间隔，不要高频重试。
- `timeout`：区分 provider 请求超时和 Minecraft keepalive 超时；分别检查 connectivity、DNS 和服务器连接。
- `getaddrinfo ENOTFOUND/EAI_AGAIN`：服务器或 provider DNS/网络问题，不要把它误判成代码回归。
- `client timed out after 30000 milliseconds`：Minecraft keepalive 失败；同时记录 RSS/heap，若内存异常升高，先有序重启 watcher，再继续定位泄漏。
- `voicechat ... noop packets`：语音插件不可用的降级警告，不等于文字聊天故障。

进程和内存证据：

```bash
ps -eo pid,ppid,etime,%cpu,%mem,rss,cmd | rg 'bot-watch|/home/oyxy/src/mcbot/bot.js' | rg -v rg
botpid=$(cat .mcbot.pid)
tr '\0' '\n' </proc/$botpid/environ | rg '^(MC_HOST|MC_PORT|MC_USERNAME|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL|MCBOT_WATCHER)='
```

环境输出必须脱敏；不要输出 `DEEPSEEK_API_KEY` 的值。

## 标准取证顺序

遇到“机器人不工作”时固定执行：

1. `node scripts/botctl.js hello`：控制面、PID、`hasBot`、schema hash。
2. `ps` 和 `.mcbot.pid`：确认 watcher、bot 是否存在，是否有重复实例。
3. `tail`/`rg` 当日日志：确定首次错误时间和错误类别。
4. 分别执行 `node scripts/botctl.js schema ctl`、`node scripts/botctl.js schema observe`、`node scripts/botctl.js schema tool`，以 live schema 为准。
5. `node scripts/botctl.js ai-connectivity ...`：只测 provider 连通性。
6. `npm run interaction:dry`：验证完整 dry interaction 闭环。
7. 观察类问题使用 `dry observe_detail`，失败时保留 `error`/`openErrors` 等诊断字段。
8. 只有证据表明是代码问题时才修改代码，并执行静态检查、热重载、schema、dry 全套流程。

## 交接报告模板

每次运维结束至少记录：

- 故障开始时间（含时区）和用户可见症状。
- 受影响范围：Minecraft 连接、AI 回复、观察、工具、语音中的哪一项。
- 首个确定性错误及对应日志文件/行号。
- 修改了什么配置或代码，是否重启/热重载。
- `hello`、`ai-connectivity`、`interaction:dry` 的结果。
- 当前 watcher/bot PID、模型 ID、RSS；模型 key 只写“已设置”，绝不写值。
- 未解决事项和下一步需要真人执行的操作。

## 事实来源

- 交互契约：`docs/interaction.md`
- Live/生成 schema：`node scripts/botctl.js schema ...`、`docs/interaction.generated.md`
- 热重载规则：`docs/hot-reload.md`
- AI 管线：`docs/ai-chat.md`
- 工具和观察契约：`docs/actions-contract.md`、`docs/observer-contract.md`

## 内存取证

使用 `node scripts/botctl.js dry observe_detail what=runtime max=20` 读取有界采样；先执行 `npm run interaction:dry`。结合日志中的 `runtime.sample` 与 keepAliveError 对齐时间，具体字段、单位与分析边界见 `docs/runtime-diagnostics.md`。不要只看一次 RSS 就认定泄漏。
