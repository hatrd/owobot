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
        history: Array.isArray(ctrl.history) ? ctrl.history.slice(-20) : []
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
你是Minecraft机器人项目的协作者，负责根据运行日志提出改进，并在需要时直接给出代码补丁。改进包括不限于修复代码错误、优化玩家体验、增加有趣的功能等`,
      `# 触发信息
${summary}
触发原因：${reason}`,
      `# 最近迭代记录
${historyText}`,
      `# 输入日志
${logs}`,
      `# 输出格式
请输出一个JSON对象：
{
  "summary": "<<=200字摘要>",
  "actions": [
    { "kind": "patch"|"note", "detail": "说明", "patch": "统一diff（当kind=patch时必填）" }
  ],
  "broadcast": "若有新功能，对玩家的中文播报",
  "notes": ["可选补充"]
}
要求：
- 无需额外文本，仅输出JSON。
- 当没有修改时，actions 为空数组，并在 summary 说明原因。
- 所有补丁必须是标准 unified diff，可直接用于 \`git apply\`，且仅包含当前仓库内变更。请确保每个 hunk 行写成 \`@@ -旧行,旧数 +新行,新数 @@\`（例如 \`@@ -12,5 +12,7 @@\`），不要只写 \`@@\`。返回前请确认 \`git apply --check\`（dry run）已通过。
- 如有多处修改，可提供多个 patch 项。
- 你可以通过 git 命令确定仓库历史、当前状态等。`
    ].join('\n\n')
  }

  async function runCodex ({ logChunk, reason }) {
    const prompt = buildPrompt({ logChunk, reason })
    const okHome = await ensureDir(codexHome)
    if (!okHome) return { ok: false, reason: 'codex_home_unwritable' }
    let tmpDir = null
    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'auto-iter-'))
    } catch (e) {
      logger.warn('Failed to create tmp dir for codex:', e?.message || e)
      return { ok: false, reason: 'tmpdir_failed' }
    }
    const outputPath = path.join(tmpDir, 'last-message.json')
    const args = ['exec', '-', '--skip-git-repo-check', '--output-last-message', outputPath, '-c', 'task.max_iterations=1', '-c', 'sandbox_permissions=["disk-full-read-access"]', '-c', 'shell_environment_policy.inherit=all']
    if (codexModel && codexModel.trim()) args.push('-m', codexModel.trim())
    if (codexExtraArgs.length) args.push(...codexExtraArgs)

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
          const trimmed = raw.trim()
          if (!trimmed) {
            finish({ ok: false, reason: 'empty_output', detail: stdout || stderr })
            return
          }
          let parsed
          try {
            parsed = JSON.parse(trimmed)
          } catch (e) {
            logger.warn('codex output not JSON:', trimmed.slice(0, 200))
            finish({ ok: false, reason: 'invalid_json', detail: trimmed.slice(0, 200) })
            return
          }
          const summary = String(parsed.summary || '').trim()
          const broadcast = parsed.broadcast ? String(parsed.broadcast).trim() : null
          const actions = Array.isArray(parsed.actions) ? parsed.actions : []
          const notes = Array.isArray(parsed.notes) ? parsed.notes : null
          const patches = actions.filter(a => a && a.kind === 'patch' && a.patch && String(a.patch).trim()).map(a => ({
            detail: a.detail ? String(a.detail) : '',
            patch: String(a.patch).trim()
          }))
          const notables = actions.filter(a => !a || a.kind !== 'patch')
          finish({ ok: true, summary, broadcast, patches, notes, raw: parsed, otherActions: notables })
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

  function normalizeUnifiedDiff (input) {
    if (!input) return input
    const raw = input.replace(/\r\n/g, '\n')
    const lines = raw.split('\n')
    let mutated = false
    const files = new Map()
    let currentFile = null
    let currentOldPath = null

    function parsePath (token) {
      const trimmed = token.trim()
      if (trimmed === '/dev/null') return '/dev/null'
      const part = trimmed.split(/\s+/)[0] || ''
      return part.replace(/^([ab])\//, '')
    }

    function getFileInfo (filePath, oldPathHint) {
      if (!filePath || filePath === '/dev/null') return null
      if (!files.has(filePath)) {
        const info = { delta: 0, lastOldStart: 1, content: null, oldPath: oldPathHint }
        const oldPath = (oldPathHint && oldPathHint !== '/dev/null') ? oldPathHint : filePath
        const abs = path.resolve(process.cwd(), oldPath)
        try {
          if (fs.existsSync(abs)) info.content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')
          else info.content = []
        } catch { info.content = [] }
        files.set(filePath, info)
      }
      const info = files.get(filePath)
      if (oldPathHint && !info.oldPath) info.oldPath = oldPathHint
      return info
    }

    function findOldStart (info, hunkLines) {
      if (!info) return 1
      if (!info.content || !info.content.length) return info.lastOldStart || 1
      const candidates = hunkLines
        .filter(line => line && (line[0] === ' ' || line[0] === '-'))
        .map(line => line.slice(1))
      if (!candidates.length) return info.lastOldStart || 1
      const maxWindow = Math.min(6, candidates.length)
      for (let take = maxWindow; take >= 1; take--) {
        const needle = candidates.slice(0, take)
        const first = needle[0]
        for (let idx = 0; idx < info.content.length; idx++) {
          if (info.content[idx] !== first) continue
          let match = true
          for (let k = 1; k < needle.length; k++) {
            if (info.content[idx + k] !== needle[k]) { match = false; break }
          }
          if (match) return idx + 1
        }
      }
      return info.lastOldStart || 1
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('--- ')) {
        currentOldPath = parsePath(line.slice(4))
        continue
      }
      if (line.startsWith('+++ ')) {
        currentFile = parsePath(line.slice(4))
        getFileInfo(currentFile, currentOldPath)
        continue
      }
      if (!line.startsWith('@@')) continue
      const trimmed = line.trim()
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(trimmed)) {
        const info = currentFile ? files.get(currentFile) : null
        if (info) {
          const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(trimmed)
          if (m) {
            const oldStart = parseInt(m[1] || '1', 10) || 1
            const oldCount = parseInt(m[2] || m[1] || '0', 10) || 0
            const newCount = parseInt(m[4] || m[3] || '0', 10) || 0
            info.lastOldStart = oldStart
            info.delta = (info.delta || 0) + (newCount - oldCount)
          }
        }
        continue
      }
      const hunkLines = []
      let removed = 0
      let added = 0
      let context = 0
      for (let j = i + 1; j < lines.length; j++) {
        const hunkLine = lines[j]
        if (!hunkLine) break
        const prefix = hunkLine[0]
        if (prefix === 'd' && hunkLine.startsWith('diff --git ')) break
        if (prefix === '@' && hunkLine.startsWith('@@')) break
        hunkLines.push(hunkLine)
        if (prefix === ' ') { context++; continue }
        if (prefix === '+') { added++; continue }
        if (prefix === '-') { removed++; continue }
        if (prefix === '\\') continue
        break
      }
      const oldCount = context + removed
      const newCount = context + added
      const info = currentFile ? getFileInfo(currentFile, currentOldPath) : null
      let oldStart = oldCount > 0 ? 1 : 0
      if (info && oldCount > 0) {
        const guess = findOldStart(info, hunkLines)
        if (Number.isFinite(guess) && guess > 0) oldStart = guess
        info.lastOldStart = oldStart
      }
      let newStart = newCount > 0 ? Math.max(1, oldStart) : 0
      if (info) {
        const delta = info.delta || 0
        newStart = newCount > 0 ? Math.max(1, oldStart + delta) : Math.max(0, oldStart + delta)
        info.delta = delta + (newCount - oldCount)
      }
      lines[i] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
      mutated = true
    }
    const result = lines.join('\n')
    const normalized = result.endsWith('\n') ? result : result + '\n'
    return mutated ? normalized : input
  }

  async function applyPatch (patchText) {
    const normalized = normalizeUnifiedDiff(patchText)
    if (normalized !== patchText) {
      logger.warn('Normalized diff with missing hunk metadata before apply')
    }
    return new Promise((resolve) => {
      try {
        const proc = spawn('git', ['apply', '--whitespace=nowarn'], { cwd: process.cwd() })
        let stderr = ''
        proc.stdout.on('data', () => {})
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (err) => {
          logger.error('git apply error:', err?.message || err)
          resolve({ ok: false, error: err?.message || String(err) })
        })
        proc.on('close', (code) => {
          if (code === 0) resolve({ ok: true })
          else {
            logger.error('git apply failed:', stderr || `exit ${code}`)
            resolve({ ok: false, error: stderr || `exit ${code}` })
          }
        })
        proc.stdin.end(normalized)
      } catch (e) {
        logger.error('applyPatch exception:', e?.message || e)
        resolve({ ok: false, error: e?.message || String(e) })
      }
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
      const { text: logChunk } = await readLogSegment()
      ctrl.phase = 'codex'
      logger.info('[iterate] contacting codex…')
      const codexRes = await runCodex({ logChunk, reason: reasonLabel })
      if (!codexRes.ok) {
        ctrl.failureCount = (ctrl.failureCount || 0) + 1
        ctrl.lastRunAt = now
        ctrl.lastReason = `${reasonLabel}:${codexRes.reason}`
        ctrl.phase = 'error'
        logger.warn('Iteration stopped:', codexRes.reason)
        ctrl.history = ctrl.history || []
        ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: 'fail', summary: String(codexRes.reason || ''), broadcast: null })
        if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
        ctrl.persistDirty = true
        return { ok: false, reason: codexRes.reason }
      }
      ctrl.lastSummary = codexRes.summary || ''
      ctrl.lastRunAt = now
      ctrl.lastReason = reasonLabel
      const patches = codexRes.patches || []
      let changed = false
      let broadcastMsg = null
      for (const item of patches) {
        ctrl.phase = 'apply_patch'
        logger.info('[iterate] applying patch:', item.detail || '(no detail)')
        const res = await applyPatch(item.patch)
        if (!res.ok) {
          ctrl.failureCount = (ctrl.failureCount || 0) + 1
          ctrl.lastRunAt = Date.now()
          ctrl.lastReason = `${reasonLabel}:patch_failed`
          ctrl.phase = 'error'
          ctrl.history = ctrl.history || []
          ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: 'patch_failed', summary: String(res.error || ''), broadcast: null })
          if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
          ctrl.persistDirty = true
          return { ok: false, reason: 'patch_failed', detail: res.error }
        }
        changed = true
      }
      ctrl.phase = 'post'
      if (source === 'deepseek') ctrl.deepseekCooldownUntil = Date.now() + ctrl.cooldownMs
      if (changed) await touchReloadGate()
      if (codexRes.broadcast && codexRes.broadcast.length) {
        broadcastMsg = codexRes.broadcast
        queueBroadcast(broadcastMsg)
      } else if (changed) {
        broadcastMsg = `【迭代完成】新功能上线（来源：${reasonLabel}），快来试试看！`
        queueBroadcast(broadcastMsg)
      }
      ctrl.lastBroadcast = broadcastMsg || null
      ctrl.failureCount = 0
      if (codexRes.summary) logger.info('[iterate] summary:', codexRes.summary)
      ctrl.history = ctrl.history || []
      ctrl.history.push({ at: Date.now(), reason: reasonLabel, status: changed ? 'changed' : 'noop', summary: ctrl.lastSummary || '', broadcast: broadcastMsg || null })
      if (ctrl.history.length > 20) ctrl.history.splice(0, ctrl.history.length - 20)
      ctrl.persistDirty = true
      return { ok: true, changed, summary: ctrl.lastSummary, broadcast: broadcastMsg }
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
