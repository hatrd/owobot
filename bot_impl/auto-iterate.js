const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const logging = require('./logging')
const fileLogger = require('./file-logger')

const HOUR_MS = 60 * 60 * 1000
const MAX_LOG_BYTES = 200 * 1024
const DEFAULT_DEEPSEEK_COOLDOWN_MS = 30 * 60 * 1000

let hourlyTimer = null

function install (bot, { on, dlog, state, registerCleanup, log }) {
  const logger = log || logging.getLogger('iterate')
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
      failureCount: 0
    }
  }
  const ctrl = state.autoIter
  ctrl.cooldownMs = parseInt(process.env.AUTO_ITERATE_DEEPSEEK_COOLDOWN_MS || `${DEFAULT_DEEPSEEK_COOLDOWN_MS}`, 10)
  if (!Number.isFinite(ctrl.cooldownMs) || ctrl.cooldownMs <= 0) ctrl.cooldownMs = DEFAULT_DEEPSEEK_COOLDOWN_MS

  const codexModel = process.env.CODEX_EXEC_MODEL || process.env.CODEX_MODEL || ''
  const codexExtraArgs = String(process.env.CODEX_EXEC_ARGS || '').split(/\s+/).filter(Boolean)
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

  function msUntilNextHour () {
    const now = Date.now()
    const next = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS
    return next - now
  }

  async function touchReloadGate () {
    try {
      const gate = path.resolve(process.cwd(), 'open_fire')
      await fs.promises.writeFile(gate, `${Date.now()}\n`)
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
      } else {
        ctrl.lastLogFile = file
        ctrl.lastLogOffset = 0
      }
      let length = size - start
      if (length > MAX_LOG_BYTES) {
        start = size - MAX_LOG_BYTES
        length = MAX_LOG_BYTES
      }
      if (length <= 0) {
        ctrl.lastLogOffset = size
        return { text: '', file, size }
      }
      const fh = await fs.promises.open(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await fh.read(buffer, 0, length, start)
        ctrl.lastLogOffset = size
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
    const sections = [
      '# 角色\n你是Minecraft机器人项目的协作者，负责根据运行日志提出改进，并在需要时直接给出代码补丁。',
      '# 触发信息\n' + summary + `\n触发原因：${reason}`,
      '# 输入日志\n' + (logChunk && logChunk.trim() ? logChunk.trim() : '(无新日志)'),
      '# 输出格式\n请输出一个JSON对象：\n{\n  "summary": "<<=200字摘要>",\n  "actions": [\n    { "kind": "patch"|"note", "detail": "说明", "patch": "统一diff（当kind=patch时必填）" }\n  ],\n  "broadcast": "若有新功能，对玩家的中文播报",\n  "notes": ["可选补充"]\n}\n要求：\n- 无需额外文本，仅输出JSON。\n- 当没有修改时，actions 为空数组，并在 summary 说明原因。\n- 所有补丁必须是标准 unified diff，可直接用于 `git apply`，且仅包含当前仓库内变更。\n- 如有多处修改，可提供多个 patch 项。`
    ]
    return sections.join('\n\n')
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
      function finish (res) {
        if (!resolved) {
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
      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('error', (err) => {
        logger.error('codex exec error:', err?.message || err)
        const reason = err && err.code === 'ENOENT' ? 'codex_missing' : 'codex_spawn_error'
        finish({ ok: false, reason, detail: err?.message || String(err) })
      })
      proc.on('close', (code) => {
        (async () => {
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

  async function applyPatch (patchText) {
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
        proc.stdin.end(patchText)
      } catch (e) {
        logger.error('applyPatch exception:', e?.message || e)
        resolve({ ok: false, error: e?.message || String(e) })
      }
    })
  }

  async function runIteration (source, opts = {}) {
    if (ctrl.running) return { ok: false, reason: 'busy' }
    const now = Date.now()
    if (source === 'deepseek' && !opts.force) {
      if (now < ctrl.deepseekCooldownUntil) {
        return { ok: false, reason: 'cooldown', until: ctrl.deepseekCooldownUntil }
      }
    }
    const reasonLabel = opts.reason ? `${source}:${opts.reason}` : source
    ctrl.running = true
    try {
      const { text: logChunk } = await readLogSegment()
      const codexRes = await runCodex({ logChunk, reason: reasonLabel })
      if (!codexRes.ok) {
        ctrl.failureCount = (ctrl.failureCount || 0) + 1
        ctrl.lastRunAt = now
        ctrl.lastReason = `${reasonLabel}:${codexRes.reason}`
        logger.warn('Iteration stopped:', codexRes.reason)
        return { ok: false, reason: codexRes.reason }
      }
      ctrl.lastSummary = codexRes.summary || ''
      ctrl.lastRunAt = now
      ctrl.lastReason = reasonLabel
      const patches = codexRes.patches || []
      let changed = false
      let broadcastMsg = null
      for (const item of patches) {
        const res = await applyPatch(item.patch)
        if (!res.ok) {
          ctrl.failureCount = (ctrl.failureCount || 0) + 1
          return { ok: false, reason: 'patch_failed', detail: res.error }
        }
        changed = true
      }
      if (source === 'deepseek') ctrl.deepseekCooldownUntil = now + ctrl.cooldownMs
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
      return { ok: true, changed, summary: ctrl.lastSummary, broadcast: broadcastMsg }
    } catch (e) {
      ctrl.failureCount = (ctrl.failureCount || 0) + 1
      logger.error('Iteration run error:', e?.message || e)
      return { ok: false, reason: 'exception', detail: e?.message || String(e) }
    } finally {
      ctrl.running = false
    }
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

  function announceHour () {
    try {
      if (!bot || typeof bot.chat !== 'function') return
      if (!state.hasSpawned) return
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      bot.chat(`【整点播报】现在是${hh}:00，系统自检中~`)
    } catch {}
  }

  async function hourlyTick () {
    hourlyTimer = null
    announceHour()
    await runIteration('hourly')
    scheduleNextTick()
  }

  function scheduleNextTick () {
    if (hourlyTimer) {
      clearTimeout(hourlyTimer)
      hourlyTimer = null
    }
    const wait = msUntilNextHour()
    hourlyTimer = setTimeout(() => { hourlyTimer = null; hourlyTick().catch(() => {}) }, wait)
  }

  function status () {
    return {
      running: Boolean(ctrl.running),
      lastRunAt: ctrl.lastRunAt,
      lastReason: ctrl.lastReason,
      lastSummary: ctrl.lastSummary,
      lastBroadcast: ctrl.lastBroadcast,
      deepseekCooldownUntil: ctrl.deepseekCooldownUntil,
      cooldownMs: ctrl.cooldownMs
    }
  }

  bot.autoIter = {
    trigger: (source, opts) => runIteration(source || 'manual', opts || {}),
    status
  }

  scheduleNextTick()

  registerCleanup && registerCleanup(() => {
    if (hourlyTimer) clearTimeout(hourlyTimer)
    hourlyTimer = null
  })

  on && on('end', () => {
    if (hourlyTimer) clearTimeout(hourlyTimer)
    hourlyTimer = null
  })
}

module.exports = { install }
