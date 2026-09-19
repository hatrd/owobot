const { spawn } = require('child_process')
// Bounded diagnostics and cancellation for goal executors invoking a CLI stage.
function runNode (file, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('canceled'))
    let stdout = '', stderr = ''
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-12000) })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    child.on('error', reject)
    child.on('close', status => {
      signal?.removeEventListener('abort', stop)
      if (status !== 0 || signal?.aborted) reject(Object.assign(Error(signal?.aborted ? 'canceled' : 'segment_failed'), { detail: { file, pid: child.pid, status, stdout, stderr } }))
      else resolve({ stdout, stderr })
    })
  })
}
module.exports = { runNode }
