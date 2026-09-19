// CPU rendering and PNG compression stay off the Minecraft event loop.
const { parentPort, workerData } = require('worker_threads')
const zlib = require('zlib')
function crc32 (buf) {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk (name, data) {
  const type = Buffer.from(name)
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([size, type, data, crc])
}
function render ({ grid, size, origin, eye, yaw, pitch, palette, radius, width = 160, height = 100 }) {
  const pixels = Buffer.alloc(height * (width * 3 + 1))
  const forward = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const up = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (2 * (x + 0.5) / width - 1) * 0.7 * width / height
    const v = (1 - 2 * (y + 0.5) / height) * 0.7
    const ray = forward.map((f, i) => f + u * right[i] + v * up[i])
    const norm = Math.hypot(...ray)
    const d = ray.map(n => n / norm)
    let color = [140, 190, 225]
    for (let t = 0; t < radius; t += 0.15) {
      const p = d.map((a, i) => Math.floor(eye[i] + a * t) - origin[i])
      if (p.some(a => a < 0 || a >= size)) { color = [65, 55, 85]; break }
      const id = grid[(p[1] * size + p[2]) * size + p[0]]
      if (id === -1) { color = [65, 55, 85]; break }
      if (id > 0) {
        const shade = Math.max(0.3, 1 - t / radius * 0.65)
        color = palette[id].rgb.map(c => Math.round(c * shade))
        break
      }
    }
    const offset = y * (width * 3 + 1) + 1 + x * 3
    for (let i = 0; i < 3; i++) pixels[offset + i] = color[i]
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
if (parentPort) parentPort.postMessage(render(workerData).toString('base64'))
module.exports = { render }
