// Deterministic native app icons: Node standard library, no external converter.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'


const expectedSha256 = '068ee4c0ae1c9f59da28b337c3e58508b9e437bcb59fe6413aee913e5a5d750f'
const chunkFiles = Array.from({ length: 4 }, (_, i) => 'assets/approved-icon-source.00' + i + '.txt')
const base64 = (await Promise.all(chunkFiles.map(file => readFile(file, 'utf8')))).join('')
const source = Buffer.from(base64, 'base64')
if (createHash('sha256').update(source).digest('hex') !== expectedSha256) {
  throw new Error('APPROVED_ICON_MISMATCH: user-approved icon source has changed')
}
function decodeIndexedPng(data) {
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('APPROVED_ICON_PNG: invalid PNG header')
  let width = 0, height = 0, palette, transparency, idat = []
  for (let at = 8; at + 12 <= data.length;) {
    const length = data.readUInt32BE(at), end = at + 12 + length
    if (end > data.length) throw new Error('APPROVED_ICON_PNG: bad chunk length')
    const type = data.toString('ascii', at + 4, at + 8)
    const bytes = data.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4)
      if (width !== 384 || height !== 384 || bytes[8] !== 8 || bytes[9] !== 3 || bytes[12] !== 0) {
        throw new Error('APPROVED_ICON_PNG: unexpected size, bit depth or color type')
      }
    } else if (type === 'PLTE') palette = bytes
    else if (type === 'tRNS') transparency = bytes
    else if (type === 'IDAT') idat.push(bytes)
    else if (type === 'IEND') break
    at = end
  }
  if (!palette || !transparency || !idat.length) throw new Error('APPROVED_ICON_PNG: missing palette, alpha or compressed data')
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length !== height * (width + 1)) throw new Error('APPROVED_ICON_PNG: invalid decompressed length')
  const rgba = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(width), index = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[index++], row = Buffer.alloc(width)
    for (let x = 0; x < width; x++) {
      const value = raw[index++], left = x ? row[x - 1] : 0, up = prev[x], ul = x ? prev[x - 1] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - ul
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - ul)
        predictor = a <= b && a <= c ? left : b <= c ? up : ul
      } else if (filter !== 0) throw new Error('APPROVED_ICON_PNG: invalid row filter')
      const n = (value + predictor) & 255
      if (n * 3 + 2 >= palette.length) throw new Error('APPROVED_ICON_PNG: missing color')
      row[x] = n
      const off = (y * width + x) * 4
      rgba[off] = palette[n * 3]; rgba[off + 1] = palette[n * 3 + 1]; rgba[off + 2] = palette[n * 3 + 2]
      // Clip the checkerboard around the approved reference screenshot. Do not
      // redraw or distort the original database symbol and its 3 status dots.
      const chroma = rgba[off + 2] - rgba[off]
      const edgeAlpha = Math.max(0, Math.min(1, (chroma - 10) / 20))
      const radius = 69, dx = Math.abs(x - 192) - (181 - radius), dy = Math.abs(y - 192) - (180 - radius)
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
      const clip = Math.max(0, Math.min(1, .5 - d))
      rgba[off + 3] = Math.round((transparency[n] ?? 255) * edgeAlpha * clip)
    }
    prev = row
  }
  return { pixels: rgba, width, height }
}
const approved = decodeIndexedPng(source)
function sample(x, y) {
  const { pixels, width, height } = approved
  const ax = Math.max(0, Math.min(width - 1, x)), ay = Math.max(0, Math.min(height - 1, y))
  const x0 = Math.floor(ax), y0 = Math.floor(ay), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1)
  const tx = ax - x0, ty = ay - y0
  const points = [[x0,y0,(1-tx)*(1-ty)],[x1,y0,tx*(1-ty)],[x0,y1,(1-tx)*ty],[x1,y1,tx*ty]]
  let alpha = 0, r = 0, g = 0, b = 0
  for (const [px,py,weight] of points) {
    const at = (py * width + px) * 4, a = pixels[at+3] / 255, factor = weight*a
    alpha += factor; r += pixels[at]*factor; g += pixels[at+1]*factor; b += pixels[at+2]*factor
  }
  return [alpha ? r/alpha : 0, alpha ? g/alpha : 0, alpha ? b/alpha : 0, alpha*255]
}
function raster(size) {
  const pixels = Buffer.alloc(size*size*4), oversample = size <= 64 ? 4 : size <= 128 ? 2 : 1
  for (let y=0;y<size;y++) for(let x=0;x<size;x++){
    const total = [0,0,0,0]
    for(let fy=0;fy<oversample;fy++) for(let fx=0;fx<oversample;fx++){
      const u=(x+(fx+.5)/oversample)*approved.width/size-.5
      const v=(y+(fy+.5)/oversample)*approved.height/size-.5
      const p=sample(u,v)
      for(let k=0;k<4;k++)total[k]+=p[k]
    }
    const at=(y*size+x)*4
    for(let k=0;k<4;k++)pixels[at+k]=Math.round(total[k]/(oversample*oversample))
  }
  return pixels
}

// The original bitmap occupies ~94% of its canvas. macOS Tahoe can
// interpret that oversize legacy ICNS as an irregular icon and place it
// inside a system-generated light tile. Normalize ONLY the Mac icon to the
// standard inset rounded-square artwork area (824 of 1024 pixels).
// Preserve the approved symbol and composite its edge onto navy, not white.
function rasterMac(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const oversample = size <= 64 ? 4 : size <= 256 ? 2 : 1
  const half = 412, radius = 185
  const step = 1024 / (size * oversample)
  const center = sample(192, 192)
  const navy = center[3] >= 240 && center[0] < 50 && center[2] > center[0] ? center.slice(0, 3) : [13, 20, 47]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let alpha = 0, r = 0, g = 0, b = 0
    for (let fy = 0; fy < oversample; fy++) for (let fx = 0; fx < oversample; fx++) {
      const u = (x + (fx + .5) / oversample) * 1024 / size - 512
      const v = (y + (fy + .5) / oversample) * 1024 / size - 512
      const dx = Math.abs(u) - (half - radius), dy = Math.abs(v) - (half - radius)
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
      const coverage = Math.max(0, Math.min(1, .5 - d / step))
      if (coverage === 0) continue
      const p = sample(192 + u * 181 / half, 192 + v * 180 / half)
      const a = p[3] / 255
      alpha += coverage
      r += coverage * (p[0] * a + navy[0] * (1 - a))
      g += coverage * (p[1] * a + navy[1] * (1 - a))
      b += coverage * (p[2] * a + navy[2] * (1 - a))
    }
    const at = (y * size + x) * 4
    if (alpha > 0) {
      pixels[at] = Math.round(r / alpha)
      pixels[at + 1] = Math.round(g / alpha)
      pixels[at + 2] = Math.round(b / alpha)
      pixels[at + 3] = Math.round(255 * alpha / (oversample * oversample))
    }
  }
  return pixels
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
function png(size, mac = false) {
  const pixels = mac ? rasterMac(size) : raster(size)
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
const macImages = new Map([16, 32, 64, 128, 256, 512, 1024].map(size => [size, png(size, true)]))
await Promise.all([
  writeFile('build/icon.png', images.get(1024)),
  writeFile('build/icon.ico', ico(images)),
  writeFile('build/icon.icns', icns(macImages)),
  writeFile('build/icon-mac.png', macImages.get(1024))
])
console.log('Generated user-approved DB EX icons (source SHA-256 verified): build/icon.png, build/icon.ico, build/icon.icns')
