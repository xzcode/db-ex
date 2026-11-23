// Deterministic native app icons: Node standard library, no external converter.
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const segments = []
const line = (ax, ay, bx, by) => segments.push([ax, ay, bx, by, bx - ax, by - ay, (bx - ax) ** 2 + (by - ay) ** 2])
const ellipse = (cx, cy, rx, ry, n = 96) => {
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n, b = (i + 1) * Math.PI * 2 / n
    line(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, cx + Math.cos(b) * rx, cy + Math.sin(b) * ry)
  }
}
const curve = (x0, y0, x1, y1, x2, y2, x3, y3, n = 36) => {
  let px = x0, py = y0
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    const x = u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3
    const y = u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * x2 + t ** 3 * y3
    line(px, py, x, y)
    px = x
    py = y
  }
}
ellipse(512, 388, 226, 77)
line(286, 388, 286, 697)
line(738, 388, 738, 697)
curve(286, 496, 286, 559, 738, 559, 738, 496)
curve(286, 595, 286, 660, 738, 660, 738, 595)
curve(286, 697, 286, 762, 738, 762, 738, 697)

const clamp = x => Math.max(0, Math.min(1, x))
const blend = (a, b, mix) => Math.round(a + (b - a) * mix)
function raster(size) {
  const data = Buffer.alloc(size * size * 4)
  const scale = SIZE / size
  for (let py = 0; py < size; py++) {
    const y = (py + 0.5) * scale
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * scale
      const dx = Math.abs(x - 512) - 235, dy = Math.abs(y - 512) - 235
      const dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - 229
      const tileAlpha = clamp(0.5 - dist / scale)
      if (tileAlpha === 0) continue
      const off = (py * size + px) * 4
      let r = blend(19, 11, y / 1024)
      let g = blend(30, 17, y / 1024)
      let b = blend(70, 47, y / 1024)
      if (x >= 258 && x <= 765 && y >= 285 && y <= 806) {
        let min = Infinity
        for (const [ax, ay, , , vx, vy, vv] of segments) {
          const ux = x - ax, uy = y - ay
          const t = clamp((ux * vx + uy * vy) / vv)
          const qx = ux - t * vx, qy = uy - t * vy
          const ds = qx * qx + qy * qy
          if (ds < min) min = ds
        }
        const ink = clamp(0.5 + (19 - Math.sqrt(min)) / scale)
        if (ink > 0) {
          const mix = clamp((y - 310) / 510)
          r = blend(r, blend(62, 48, mix), ink)
          g = blend(g, blend(230, 127, mix), ink)
          b = blend(b, blend(244, 248, mix), ink)
        }
      }
      data[off] = r
      data[off + 1] = g
      data[off + 2] = b
      data[off + 3] = Math.round(tileAlpha * 255)
    }
  }
  return data
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i
  for (let j = 0; j < 8; j++) n = (n & 1) ? 0xEDB88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function chunk(name, body) {
  const tag = Buffer.from(name)
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  tag.copy(out, 4)
  body.copy(out, 8)
  let crc = 0xFFFFFFFF
  for (let i = 4; i < 8 + body.length; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8)
  out.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 8 + body.length)
  return out
}
function png(size) {
  const pixels = raster(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
function ico(images) {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  for (const [i, size] of sizes.entries()) {
    const base = 6 + i * 16, bytes = images.get(size)
    header[base] = size % 256
    header[base + 1] = size % 256
    header.writeUInt16LE(1, base + 4)
    header.writeUInt16LE(32, base + 6)
    header.writeUInt32LE(bytes.length, base + 8)
    header.writeUInt32LE(offset, base + 12)
    offset += bytes.length
  }
  return Buffer.concat([header, ...sizes.map(size => images.get(size))])
}
function icns(images) {
  const entries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
    ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64],
    ['ic13', 256], ['ic14', 512]
  ].map(([name, size]) => {
    const bytes = images.get(size)
    const header = Buffer.alloc(8)
    header.write(name, 0, 'ascii')
    header.writeUInt32BE(bytes.length + 8, 4)
    return Buffer.concat([header, bytes])
  })
  const total = 8 + entries.reduce((n, entry) => n + entry.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...entries])
}

await mkdir('build', { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const images = new Map(sizes.map(size => [size, png(size)]))
await Promise.all([
  writeFile('build/icon.png', images.get(1024)),
  writeFile('build/icon.ico', ico(images)),
  writeFile('build/icon.icns', icns(images))
])
console.log('Generated DB EX icons: build/icon.png, build/icon.ico, build/icon.icns')
