const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const logging = require('./logging')
const fileLogger = require('./file-logger')

const DATA_DIR = path.join(process.cwd(), 'data')

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000
const MAX_LOG_BYTES = 200 * 1024
const DEFAULT_DEEPSEEK_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_CODEX_TIMEOUT_MS = 0

let hourlyTimer = null

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const logger = log || logging.getLogger('iterate')
  const persistPath = path.join(DATA_DIR, 'auto-iterate.json')

  function loadPersistent () {
    try {
      const raw = fs.readFileSync(persistPath, 'utf8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object') {
        if (typeof data.lastLogFile === 'string') ctrl.lastLogFile = data.lastLogFile
        if (Number.isFinite(data.lastLogOffset)) ctrl.lastLogOffset = data.lastLogOffset
        if (Array.isArray(data.history)) ctrl.history = data.history.slice(-10)
        if (typeof data.codexSessionId === 'string') ctrl.codexSessionId = data.codexSessionId
      }
    } catch {}
  }

  function savePersistent () {
    try {
      if (!ctrl.persistDirty) return
      ctrl.persistDirty = false
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const payload = {
        version: 1,
        lastLogFile: ctrl.lastLogFile || null,
        lastLogOffset: ctrl.lastLogOffset || 0,
        history: Array.isArray(ctrl.history) ? ctrl.history.slice(-20) : [],
        codexSessionId: ctrl.codexSessionId || null
      }
      fs.writeFileSync(persistPath, JSON.stringify(payload, null, 2))
    } catch (e) {
      logger.warn('Failed to persist iterate state:', e?.message || e)
    }
  }

  if (!state.autoIter) {
    state.autoIter = {
      lastRunAt: 0,
      lastReason: null,
      lastSummary: null,
      lastBroadcast: null,
      lastLogFile: null,
      lastLogOffset: 0,
      deepseekCooldownUntil: 0,
      running: false,
      failureCount: 0,
      currentRun: null,
      nextTickAt: null,
      intervalMs: null,
      phase: 'idle',
      history: [],
      persistDirty: false
    }
  }
  const ctrl = state.autoIter
  if (typeof ctrl.currentRun === 'undefined') ctrl.currentRun = null
  if (typeof ctrl.nextTickAt === 'undefined') ctrl.nextTickAt = null
  if (typeof ctrl.phase !== 'string') ctrl.phase = 'idle'
  if (!Array.isArray(ctrl.history)) ctrl.history = []
  if (typeof ctrl.persistDirty !== 'boolean') ctrl.persistDirty = false
  if (typeof ctrl.codexSessionId !== 'string') ctrl.codexSessionId = null

  loadPersistent()
  function parseDurationMs (raw) {
    if (raw == null) return null
    const s = String(raw).trim()
    if (!s) return null
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(s)
    if (!match) return null
    const value = parseFloat(match[1])
    if (!Number.isFinite(value) || value <= 0) return null
    const unit = (match[2] || 'ms').toLowerCase()
    if (unit === 'ms') return Math.round(value)
    if (unit === 's') return Math.round(value * 1000)
    if (unit === 'm') return Math.round(value * 60 * 1000)
    if (unit === 'h') return Math.round(value * 60 * 60 * 1000)
    return null
  }

  function resolveIntervalMs () {
    const raw = process.env.AUTO_ITERATE_INTERVAL_MS
    if (raw != null) {
      const ms = parseDurationMs(raw)
      if (Number.isFinite(ms) && ms > 0) return ms
    }
    return DEFAULT_INTERVAL_MS
  }

  ctrl.intervalMs = resolveIntervalMs()

  ctrl.cooldownMs = parseInt(process.env.AUTO_ITERATE_DEEPSEEK_COOLDOWN_MS || `${DEFAULT_DEEPSEEK_COOLDOWN_MS}`, 10)
  if (!Number.isFinite(ctrl.cooldownMs) || ctrl.cooldownMs <= 0) ctrl.cooldownMs = DEFAULT_DEEPSEEK_COOLDOWN_MS

  const codexModel = process.env.CODEX_EXEC_MODEL || process.env.CODEX_MODEL || ''
  const codexExtraArgs = String(process.env.CODEX_EXEC_ARGS || '').split(/\s+/).filter(Boolean)
  const codexTimeoutMs = (() => {
    const raw = process.env.CODEX_EXEC_TIMEOUT_MS
    const parsed = raw ? parseInt(raw, 10) : DEFAULT_CODEX_TIMEOUT_MS
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return DEFAULT_CODEX_TIMEOUT_MS
  })()
  const codexHome = (() => {
    const envHome = process.env.CODEX_HOME_DIR || process.env.CODEX_EXEC_HOME
    if (envHome && envHome.trim()) return path.resolve(process.cwd(), envHome.trim())
    return path.join(process.cwd(), '.codex_home')
  })()

  async function ensureDir (dir) {
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      return true
    } catch (e) {
      logger.warn('Failed to create dir', dir, e?.message || e)
      return false
    }
  }

  function msUntilNextInterval () {
    const now = Date.now()
    const interval = ctrl.intervalMs || DEFAULT_INTERVAL_MS
    const next = Math.ceil((now + 1) / interval) * interval
    const delta = next - now
    return delta > 0 ? delta : interval
  }

  async function touchReloadGate () {
    try {
      const gate = path.resolve(process.cwd(), 'open_fire')
      await fs.promises.appendFile(gate, `${Date.now()}\n`)
      logger.info('Touched reload gate to apply new code')
    } catch (e) {
      logger.warn('Failed to touch reload gate:', e?.message || e)
    }
  }

  async function gitStatusSnapshot () {
    return new Promise((resolve) => {
      try {
        const proc = spawn('git', ['status', '--porcelain'], { cwd: process.cwd() })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => { stdout += d.toString() })
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (err) => {
          logger.warn('git status error:', err?.message || err)
          resolve(null)
        })
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.replace(/\s+$/, ''))
          else {
            logger.warn('git status failed:', stderr || `exit ${code}`)
            resolve(null)
          }
        })
      } catch (e) {
        logger.warn('git status exception:', e?.message || e)
        resolve(null)
      }
    })
  }

  async function runGitCommand (args, { stdin } = {}) {
    return new Promise((resolve) => {
      try {
        const proc = spawn('git', args, { cwd: process.cwd() })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => { stdout += d.toString() })
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (err) => {
          resolve({ ok: false, code: null, stdout, stderr: stderr || (err?.message || String(err)) })
        })
        proc.on('close', (code) => {
          resolve({ ok: code === 0, code, stdout, stderr })
        })
        if (stdin) {
          proc.stdin.write(stdin)
        }
        proc.stdin.end()
      } catch (e) {
        resolve({ ok: false, code: null, stdout: '', stderr: e?.message || String(e) })
      }
    })
  }

  async function commitIterationChanges ({ summary, reasonLabel }) {
    const status = await gitStatusSnapshot()
    if (!status) {
      logger.warn('[iterate] git status unavailable; skip auto commit')
      return
    }
    if (!status.trim()) {
      logger.info('[iterate] git status clean; no auto commit needed')
      return
    }
    const addRes = await runGitCommand(['add', '-A'])
    if (!addRes.ok) {
      logger.warn('[iterate] git add failed:', addRes.stderr || addRes.stdout || addRes.code)
      return
    }
    const rawSummary = (summary && summary.trim()) || ''
    const fallback = reasonLabel || 'auto-iterate update'
    const singleLine = (rawSummary || fallback).split('\n').map(s => s.trim()).filter(Boolean).join(' ').slice(0, 72) || 'auto-iterate update'
    const message = `chore(auto-iterate): ${singleLine}`
    const commitRes = await runGitCommand(['commit', '-m', message])
    if (!commitRes.ok) {
      logger.warn('[iterate] git commit failed:', commitRes.stderr || commitRes.stdout || commitRes.code)
      // Attempt to unstage to avoid locking future commits
      await runGitCommand(['reset', '--mixed', 'HEAD'])
      return
    }
    logger.info('[iterate] auto commit created:', singleLine)
  }

  function currentLogPath () {
    try {
      const active = fileLogger.currentPath && fileLogger.currentPath()
      if (active && fs.existsSync(active)) return active
    } catch {}
    try {
      const dir = path.resolve(process.cwd(), 'logs')
      const entries = fs.readdirSync(dir).filter(name => name.endsWith('.log'))
      if (!entries.length) return null
      entries.sort()
      const latest = entries[entries.length - 1]
      return path.join(dir, latest)
    } catch {}
    return null
  }

  async function readLogSegment () {
    const file = currentLogPath()
    if (!file) return { text: '', file: null, size: 0 }
    try {
      const stat = await fs.promises.stat(file)
      const size = stat.size
      let start = 0
      if (ctrl.lastLogFile === file) {
        start = Math.max(0, Math.min(ctrl.lastLogOffset || 0, size))
        if (start > size) start = Math.max(0, size - MAX_LOG_BYTES)
      } else {
        ctrl.lastLogFile = file
        start = Math.max(0, size - MAX_LOG_BYTES)
      }
      let length = size - start
      if (length > MAX_LOG_BYTES) {
        start = size - MAX_LOG_BYTES
        length = MAX_LOG_BYTES
      }
      if (length <= 0) {
        ctrl.lastLogOffset = size
        ctrl.persistDirty = true
        return { text: '', file, size }
      }
      const fh = await fs.promises.open(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await fh.read(buffer, 0, length, start)
        ctrl.lastLogOffset = size
        ctrl.persistDirty = true
        return { text: buffer.toString('utf8'), file, size }
      } finally {
        await fh.close()
      }
    } catch (e) {
      logger.warn('Failed to read log segment:', e?.message || e)
      return { text: '', file: null, size: 0 }
    }
  }

  function buildPrompt ({ logChunk, reason }) {
    const summary = ctrl.lastSummary ? `上次总结：${ctrl.lastSummary}` : '暂无历史总结'
    const logs = logChunk && logChunk.trim() ? logChunk.trim() : '(无新日志)'
    const recentHistory = Array.isArray(ctrl.history) ? ctrl.history.slice(-5) : []
    const historyText = recentHistory.length
      ? recentHistory.map((h) => {
        const when = h && h.at ? new Date(h.at).toISOString() : '未知时间'
        const status = h?.status || 'unknown'
        const reasonTag = h?.reason ? `[${h.reason}]` : ''
        const sum = h?.summary ? String(h.summary).slice(0, 160) : ''
        return `- ${when} ${reasonTag} ${status} ${sum}`.trim()
      }).join('\n')
      : '- 暂无记录'
    return [
      `# 角色
你是Minecraft机器人项目的合作者。根据运行日志，自主分析并直接修改仓库中的代码/配置，以提升稳定性、玩家体验或功能性。`,
      `# 触发信息
${summary}
触发原因：${reason}`,
      `# 最近迭代记录
${historyText}`,
      `# 输入日志
${logs}`,
      `# 权限与限制
- 你拥有当前仓库的写入权限及 git 命令（status/diff/checkout 等）执行权限，可直接编辑文件、创建/删除文件、运行脚本。
- 禁止提交、推送或重写 git 历史；如需撤销请自行使用 \`git checkout -- <file>\` 等命令。`,
      `# 工作方式
- 直接在当前仓库中运行命令、编辑文件并检查结果；不要返回补丁或 JSON。
- 可使用 \`git status\` / \`git diff\` 等命令确认变更，但不要提交、推送或重写历史。
- 修改范围以日志暴露的问题/改进为主，避免与当前上下文无关的大规模改动。`,
      `# 输出要求
完成修改后，请以以下三行结尾（若无内容可留空）：
Summary: <简短中文总结>
Broadcast: <给玩家的播报，无则留空>
Notes: <可选补充>

如需额外说明，可在上述三行之前自由撰写。`
    ].join('\n\n')
  }

  async function runCodex ({ logChunk, reason, resume }) {
    const prompt = resume && resume.message ? resume.message : buildPrompt({ logChunk, reason })
    const okHome = await ensureDir(codexHome)
    if (!okHome) return { ok: false, reason: 'codex_home_unwritable' }
    let tmpDir = null
    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auto-iter-'))
    } catch (e) {
      logger.warn('Failed to create tmp dir for codex:', e?.message || e)
      return { ok: false, reason: 'tmpdir_failed' }
    }
    const outputPath = path.join(tmpDir, 'last-message.txt')
    const repoEnv = process.env.CODEX_REPO_ROOT || process.env.AUTO_ITERATE_REPO_ROOT || process.env.PROJECT_ROOT || process.cwd()
    const scopedDir = path.resolve(process.cwd(), repoEnv)
    logger.info('[iterate] codex sandbox scope:', scopedDir)
    const sharedConfigArgs = ['-c', 'task.max_iterations=1', '-c', 'shell_environment_policy.inherit=all']
    const sharedModelArgs = []
    if (codexModel && codexModel.trim()) sharedModelArgs.push('-m', codexModel.trim())
    if (codexExtraArgs.length) sharedModelArgs.push(...codexExtraArgs)

    const optionArgs = ['--json', '--sandbox', 'workspace-write', '-C', scopedDir, '--skip-git-repo-check', '--output-last-message', outputPath, ...sharedConfigArgs, ...sharedModelArgs]
    const args = ['exec']
    let resumeSessionId = null
    if (resume) {
      const hint = resume.hint || null
      resumeSessionId = hint && hint.sessionId ? String(hint.sessionId).trim() : ''
      if (!resumeSessionId) {
        logger.warn('runCodex resume requested without session id')
        return { ok: false, reason: 'resume_session_missing', detail: 'missing_session_id' }
      }
      args.push('resume', ...optionArgs, resumeSessionId, '-')
    } else {
      args.push(...optionArgs, '-')
    }

    const env = { ...process.env, HOME: codexHome }

    return await new Promise((resolve) => {
      let resolved = false
      let timedOut = false
      let timer = null
      function finish (res) {
        if (!resolved) {
          if (timer) clearTimeout(timer)
          resolved = true
          resolve(res)
        }
      }
      let stdout = ''
      let stderr = ''
      let proc
      try {
        proc = spawn('codex', args, { cwd: process.cwd(), env })
      } catch (e) {
        logger.error('Failed to spawn codex:', e?.message || e)
        finish({ ok: false, reason: 'codex_spawn_failed', detail: e?.message || String(e) })
        return
      }
      if (codexTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (!resolved) {
            timedOut = true
            logger.warn('codex exec timeout; terminating process')
            try { proc.kill('SIGTERM') } catch {}
            setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 2000)
          }
        }, codexTimeoutMs)
      }
      proc.stdout.on('data', (d) => {
        const text = d.toString()
        stdout += text
        const chunk = text.trim()
        if (chunk) logger.info('[iterate] codex stdout:', chunk)
      })
      proc.stderr.on('data', (d) => {
        const text = d.toString()
        stderr += text
        const chunk = text.trim()
        if (chunk) logger.warn('[iterate] codex stderr:', chunk)
      })
      proc.on('error', (err) => {
        logger.error('codex exec error:', err?.message || err)
        const reason = err && err.code === 'ENOENT' ? 'codex_missing' : 'codex_spawn_error'
        finish({ ok: false, reason, detail: err?.message || String(err) })
      })
      proc.on('close', (code) => {
        (async () => {
          if (timedOut) {
            finish({ ok: false, reason: 'codex_timeout', detail: 'codex exec timed out after ' + codexTimeoutMs + 'ms' })
            return
          }
          if (code !== 0) {
            logger.warn('codex exec exited with code', code, stderr || stdout)
            finish({ ok: false, reason: 'codex_exit', detail: stderr || stdout || `exit ${code}` })
            return
          }
          let raw = ''
          try {
            raw = await fs.promises.readFile(outputPath, 'utf8')
          } catch (e) {
            logger.warn('codex output missing:', e?.message || e)
            finish({ ok: false, reason: 'no_output', detail: stdout || stderr })
            return
          }
          const message = raw.trim()
          if (!message) {
            finish({ ok: false, reason: 'empty_output', detail: stdout || stderr })
            return
          }

          const summaryMatch = Array.from(message.matchAll(/^Summary:\s*(.*)$/gmi)).pop()
          const broadcastMatch = Array.from(message.matchAll(/^Broadcast:\s*(.*)$/gmi)).pop()
          const notesMatch = Array.from(message.matchAll(/^Notes:\s*(.*)$/gmi)).pop()
          const summary = summaryMatch ? summaryMatch[1].trim() : ''
          const broadcast = broadcastMatch ? broadcastMatch[1].trim() : ''
          const notes = notesMatch ? notesMatch[1].trim() : ''

          const extractSessionId = (text) => {
            const lines = text.split(/\r?\n/)
            for (const line of lines) {
              const trimmedLine = line.trim()
              if (!trimmedLine) continue
              try {
                const obj = JSON.parse(trimmedLine)
                const probe = (value) => {
                  if (!value || typeof value !== 'object') return null
                  if (typeof value.session_id === 'string' && value.session_id.trim()) return value.session_id.trim()
                  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId.trim()
                  for (const key of Object.keys(value)) {
                    const res = probe(value[key])
                    if (res) return res
                  }
                  return null
                }
                const found = probe(obj)
                if (found) return found
              } catch {}
            }
            const regex = /\"session_id\"\s*:\s*\"([^\"]+)\"/g
            const match = regex.exec(text)
            return match ? match[1].trim() : null
          }

          const sessionId = extractSessionId(stdout) || (resumeSessionId ? resumeSessionId.trim() : null)
          if (resumeSessionId && sessionId && sessionId !== resumeSessionId) {
            logger.warn('resume session mismatch:', resumeSessionId, sessionId)
            finish({ ok: false, reason: 'resume_session_mismatch', detail: `expected ${resumeSessionId} got ${sessionId}` })
            return
          }
          const resumeHint = sessionId ? { sessionId } : null
          finish({
            ok: true,
            summary,
            broadcast,
            notes,
            raw: message,
            resumeHint
          })
        })().catch((err) => {
          logger.error('codex post-processing error:', err?.message || err)
          finish({ ok: false, reason: 'processing_error', detail: err?.message || String(err) })
        })
      })
      try {
        proc.stdin.write(prompt)
        if (!prompt.endsWith('\n')) proc.stdin.write('\n')
      } catch {}
      try { proc.stdin.end() } catch {}
    })
  }

  async function runIteration (source, opts = {}) {
    if (ctrl.currentRun) {
      try { await ctrl.currentRun } catch {}
    }
    const now = Date.now()
    if (source === 'deepseek' && !opts.force) {
      if (now < ctrl.deepseekCooldownUntil) {
        return { ok: false, reason: 'cooldown', until: ctrl.deepseekCooldownUntil }
      }
    }
    const reasonLabel = opts.reason ? `${source}:${opts.reason}` : source
    ctrl.running = true
    ctrl.phase = 'starting'
    const startedAt = Date.now()
    logger.info('[iterate] run begin:', reasonLabel)
    try { bot.emit && bot.emit('autoIter:start', { source: reasonLabel, startedAt }) } catch {}

    const corePromise = (async () => {
      ctrl.phase = 'collect_logs'
      logger.info('[iterate] collecting logs…')
      const beforeStatus = await gitStatusSnapshot()
      const { text: logChunk } = await readLogSegment()
      ctrl.phase = 'codex'
      logger.info('[iterate] contacting codex…')
      const initialSession = typeof ctrl.codexSessionId === 'string' && ctrl.codexSessionId.trim() ? ctrl.codexSessionId.trim() : null
      let sessionId = initialSession
      const baseMessage = buildPrompt({ logChunk, reason: reasonLabel })
      let codexRes
      let codexAttempts = 0
      while (true) {
        codexAttempts++
        const options = sessionId
          ? { logChunk, reason: reasonLabel, resume: { message: baseMessage, hint: { sessionId } } }
          : { logChunk, reason: reasonLabel }
        codexRes = await runCodex(options)
        if (!codexRes.ok && sessionId && (codexRes.reason === 'resume_session_missing' || codexRes.reason === 'resume_session_mismatch')) {
          logger.warn('[iterate] stored Codex session unusable, resetting id:', sessionId, 'reason=', codexRes.reason)
          sessionId = null
          if (ctrl.codexSessionId) {
            ctrl.codexSessionId = null
            ctrl.persistDirty = true
          }
          if (codexAttempts < 3) continue
        }
        break
      }
      if (!codexRes.ok) {
        ctrl.failureCount = (ctrl.failureCount || 0) + 1
        ctrl.lastRunAt = Date.now()
        ctrl.lastReason = `${reasonLabel}:${codexRes.reason}`
        ctrl.phase = 'error'
        logger.warn('Iteration stopped:', codexRes.reason)
        ctrl.history = ctrl.history || []
        ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: 'fail', summary: String(codexRes.reason || ''), broadcast: null })
        if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
        ctrl.persistDirty = true
        return { ok: false, reason: codexRes.reason }
      }
      const returnedSession = codexRes.resumeHint && codexRes.resumeHint.sessionId ? String(codexRes.resumeHint.sessionId).trim() : null
      if (returnedSession) sessionId = returnedSession
      if (sessionId && sessionId !== ctrl.codexSessionId) {
        ctrl.codexSessionId = sessionId
        ctrl.persistDirty = true
      }
      const finalSummary = codexRes.summary || ''
      ctrl.lastSummary = finalSummary
      ctrl.lastRunAt = Date.now()
      ctrl.lastReason = reasonLabel
      ctrl.persistDirty = true
      const afterStatus = await gitStatusSnapshot()
      let changed = false
      if (afterStatus != null) {
        if (beforeStatus == null) changed = afterStatus.trim().length > 0
        else changed = beforeStatus !== afterStatus
      }
      if (ctrl.codexSessionId !== (sessionId || null)) {
        ctrl.codexSessionId = sessionId || null
        ctrl.persistDirty = true
      }
      ctrl.phase = 'post'
      if (source === 'deepseek') ctrl.deepseekCooldownUntil = Date.now() + ctrl.cooldownMs
      if (changed) await touchReloadGate()
      let broadcastMsg = codexRes.broadcast && codexRes.broadcast.trim() ? codexRes.broadcast.trim() : null
      if (!broadcastMsg && changed) {
        broadcastMsg = `【迭代完成】新功能上线（来源：${reasonLabel}），快来试试看！`
      }
      if (broadcastMsg) queueBroadcast(broadcastMsg)
      ctrl.lastBroadcast = broadcastMsg || null
      ctrl.failureCount = 0
      if (finalSummary) logger.info('[iterate] summary:', finalSummary)
      ctrl.history = ctrl.history || []
      ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: changed ? 'changed' : 'noop', summary: finalSummary || '', broadcast: broadcastMsg || null })
      if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
      ctrl.persistDirty = true
      if (changed) {
        try {
          await commitIterationChanges({ summary: finalSummary, reasonLabel })
        } catch (e) {
          logger.warn('[iterate] auto commit error:', e?.message || e)
        }
      }
      return { ok: true, changed, summary: finalSummary, broadcast: broadcastMsg }
    })().catch((e) => {
      ctrl.failureCount = (ctrl.failureCount || 0) + 1
      logger.error('Iteration run error:', e?.message || e)
      ctrl.phase = 'error'
      ctrl.history = ctrl.history || []
      ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: 'error', summary: String(e?.message || e), broadcast: null })
      if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
      ctrl.persistDirty = true
      return { ok: false, reason: 'exception', detail: e?.message || String(e) }
    })

    const wrapped = corePromise.then((result) => {
      logger.info('[iterate] run end:', reasonLabel, 'result=', result?.ok ? 'ok' : (result?.reason || 'fail'))
      try { bot.emit && bot.emit('autoIter:end', { source: reasonLabel, result, duration: Date.now() - startedAt }) } catch {}
      return result
    }).finally(() => {
      ctrl.running = false
      if (!ctrl.running) ctrl.phase = 'idle'
      ctrl.currentRun = null
      savePersistent()
    })
    ctrl.currentRun = wrapped
    return wrapped
  }

  function queueBroadcast (text) {
    if (!text) return
    try {
      if (!bot || typeof bot.chat !== 'function') return
      if (!state.hasSpawned) return
      bot.chat(text)
    } catch (e) {
      logger.warn('Broadcast chat failed:', e?.message || e)
    }
  }

  function formatInterval (ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '未知间隔'
    if (ms % (60 * 60 * 1000) === 0) return `${Math.round(ms / (60 * 60 * 1000))}小时`
    if (ms % (60 * 1000) === 0) return `${Math.round(ms / (60 * 1000))}分钟`
    if (ms % 1000 === 0) return `${Math.round(ms / 1000)}秒`
    return `${ms}毫秒`
  }

  async function fetchOnlineCount () {
    const url = String(process.env.MAP_API_URL || '').trim()
    if (!url) return null
    try {
      const ac = new AbortController()
      const timeout = setTimeout(() => { try { ac.abort('timeout') } catch {} }, 4000)
      const res = await fetch(url, { method: 'GET', signal: ac.signal })
      clearTimeout(timeout)
      if (!res.ok) return null
      const data = await res.json().catch(() => null)
      if (Array.isArray(data)) return data.length
      if (Array.isArray(data?.players)) return data.players.length
      return null
    } catch (e) {
      logger.warn('[iterate] online count fetch error:', e?.message || e)
      return null
    }
  }

  async function announceTick () {
    try {
      if (!bot || typeof bot.chat !== 'function') return
      if (!state.hasSpawned) return
      const now = new Date()
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      let message = `现在是 ${timeStr}，祝大家玩得开心~`
      const count = await fetchOnlineCount()
      if (Number.isInteger(count) && count >= 0) {
        message = `现在是 ${timeStr}，线上有 ${count} 位伙伴~`
      }
      bot.chat(message)
    } catch {}
  }

  async function hourlyTick () {
    hourlyTimer = null
    await announceTick()
    await runIteration('hourly')
    scheduleNextTick()
  }

  function scheduleNextTick () {
    if (hourlyTimer) {
      clearTimeout(hourlyTimer)
      hourlyTimer = null
    }
    ctrl.intervalMs = resolveIntervalMs()
    const wait = msUntilNextInterval()
    ctrl.nextTickAt = Date.now() + wait
    ctrl.phase = 'waiting'
    hourlyTimer = setTimeout(() => {
      hourlyTimer = null
      ctrl.nextTickAt = null
      hourlyTick().catch(() => {})
    }, wait)
  }

  function status () {
    return {
      running: Boolean(ctrl.running),
      lastRunAt: ctrl.lastRunAt,
      lastReason: ctrl.lastReason,
      lastSummary: ctrl.lastSummary,
      lastBroadcast: ctrl.lastBroadcast,
      deepseekCooldownUntil: ctrl.deepseekCooldownUntil,
      cooldownMs: ctrl.cooldownMs,
      intervalMs: ctrl.intervalMs,
      nextTickAt: ctrl.nextTickAt,
      phase: ctrl.phase
    }
  }

  bot.autoIter = {
    trigger: (source, opts) => runIteration(source || 'manual', opts || {}),
    status
  }

  scheduleNextTick()

  function fmtMs (ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '未知'
    const mins = ms / (60 * 1000)
    if (mins >= 60 && mins % 60 === 0) return `${Math.round(mins / 60)}小时`
    if (mins >= 1 && mins % 1 === 0) return `${Math.round(mins)}分钟`
    if (ms % 1000 === 0) return `${Math.round(ms / 1000)}秒`
    return `${ms}毫秒`
  }

  function cliStatus () {
    const s = status()
    const nextIn = s.nextTickAt ? Math.max(0, s.nextTickAt - Date.now()) : null
    const nextStr = nextIn != null ? `${fmtMs(nextIn)} 后` : '未计划'
    console.log('[ITERATE]', `状态: ${s.running ? '运行中' : '空闲'}`, '| 阶段:', s.phase || '未知', '| 上次原因:', s.lastReason || '无', '| 当前周期:', fmtMs(s.intervalMs || DEFAULT_INTERVAL_MS), '| 下次:', nextStr)
    if (s.lastSummary) console.log('[ITERATE]', '上次摘要:', s.lastSummary)
    if (s.lastBroadcast) console.log('[ITERATE]', '上次播报:', s.lastBroadcast)
  }

  function cliInterval (raw, opts = {}) {
    const ms = parseDurationMs(raw)
    if (!ms) {
      console.log('[ITERATE]', '间隔格式错误，可用示例：300000、30s、5m、1h')
      return
    }
    ctrl.intervalMs = ms
    process.env.AUTO_ITERATE_INTERVAL_MS = String(ms)
    console.log('[ITERATE]', '已设置新的迭代间隔 =', fmtMs(ms))
    if (opts.reschedule !== false) scheduleNextTick()
  }

  function cliRunNow () {
    console.log('[ITERATE]', '手动触发迭代...')
    runIteration('cli', { reason: 'manual' }).then((res) => {
      if (res && res.ok) {
        console.log('[ITERATE]', res.changed ? '已完成迭代（含变更）' : '已完成迭代（无变更）')
        if (res.summary) console.log('[ITERATE]', '摘要:', res.summary)
      } else {
        console.log('[ITERATE]', '迭代失败:', res?.detail || res?.reason || '未知错误')
      }
    }).catch((e) => console.log('[ITERATE]', '触发异常:', e?.message || e))
  }

  async function resetLogCursor () {
    const file = currentLogPath()
    if (!file) {
      console.log('[ITERATE]', '没有找到日志文件，无法重置光标')
      return
    }
    try {
      const stat = await fs.promises.stat(file)
      ctrl.lastLogFile = file
      ctrl.lastLogOffset = stat.size
      ctrl.persistDirty = true
      savePersistent()
      console.log('[ITERATE]', '日志游标已移动到当前末尾:', path.basename(file), 'size=', stat.size)
    } catch (e) {
      console.log('[ITERATE]', '重置游标失败:', e?.message || e)
    }
  }

  function handleCli (payload) {
    try {
      if (!payload || payload.cmd !== 'iterate') return
      const [sub, ...rest] = payload.args || []
      const cmd = (sub || '').toLowerCase()
      if (!cmd || cmd === 'status') { cliStatus(); return }
      if (cmd === 'interval') {
        if (!rest.length) {
          console.log('[ITERATE]', '当前间隔 =', fmtMs(ctrl.intervalMs || DEFAULT_INTERVAL_MS))
          return
        }
        cliInterval(rest[0])
        return
      }
      if (cmd === 'run' || cmd === 'now') { cliRunNow(); return }
      if (cmd === 'cooldown') {
        if (!rest.length) {
          console.log('[ITERATE]', '当前 Deepseek 冷却 =', fmtMs(ctrl.cooldownMs))
          return
        }
        const val = parseDurationMs(rest[0])
        if (!val) {
          console.log('[ITERATE]', '冷却格式错误，可用示例：180000、3m')
          return
        }
        ctrl.cooldownMs = val
        process.env.AUTO_ITERATE_DEEPSEEK_COOLDOWN_MS = String(val)
        console.log('[ITERATE]', '已设置新的冷却 =', fmtMs(val))
        return
      }
      if (cmd === 'reset') {
        resetLogCursor().catch((e) => console.log('[ITERATE]', '重置异常:', e?.message || e))
        return
      }
      console.log('[ITERATE]', '未知子命令，支持: status|interval <值>|run|cooldown <值>')
    } catch (e) {
      console.log('[ITERATE]', '命令处理异常:', e?.message || e)
    }
  }

  on && on('cli', handleCli)
  registerCleanup && registerCleanup(() => {
    try { bot.off('cli', handleCli) } catch {}
    try { savePersistent() } catch {}
  })

  registerCleanup && registerCleanup(() => {
    if (hourlyTimer) clearTimeout(hourlyTimer)
    hourlyTimer = null
  })

  on && on('end', () => {
    if (hourlyTimer) clearTimeout(hourlyTimer)
    hourlyTimer = null
    try { savePersistent() } catch {}
  })
}

module.exports = { install }
