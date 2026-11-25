import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'

function pixel(png: Buffer, x: number, y: number): number[] {
  const width = png.readUInt32BE(16)
  let at = 8
  const compressed: Buffer[] = []
  while (at + 12 <= png.length) {
    const size = png.readUInt32BE(at)
    const name = png.toString('ascii', at + 4, at + 8)
    if (name === 'IDAT') compressed.push(png.subarray(at + 8, at + 8 + size))
    at += size + 12
    if (name === 'IEND') break
  }
  const data = inflateSync(Buffer.concat(compressed))
  const offset = y * (width * 4 + 1) + 1 + x * 4
  assert.equal(data[y * (width * 4 + 1)], 0, 'generated PNG must use unfiltered rows')
  return [...data.subarray(offset, offset + 4)]
}

test('native PNG/ICNS/ICO use the user-approved bitmap rather than legacy redraw', () => {
  const source = Buffer.from(
    Array.from({ length: 4 }, (_, i) => readFileSync('assets/approved-icon-source.00' + i + '.txt', 'utf8')).join(''),
    'base64'
  )
  assert.equal(createHash('sha256').update(source).digest('hex'), '068ee4c0ae1c9f59da28b337c3e58508b9e437bcb59fe6413aee913e5a5d750f')
  const result = spawnSync(process.execPath, ['scripts/generate-icons.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const png = readFileSync('build/icon.png')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(pixel(png, 0, 0)[3], 0, 'background must be transparent, not a screenshot checkerboard')
  const background = pixel(png, 512, 512)
  assert(background[2] > background[0] && background[0] < 50, 'approved tile is dark navy')
  const topArc = pixel(png, 512, 260)
  assert(topArc[1] > 160 && topArc[2] > 160, 'thin approved cyan ellipse must remain present')
  const dots = [[675, 470], [675, 580], [675, 685]].map(([x, y]) => pixel(png, x, y))
  assert(dots.every(dot => dot[3] === 255 && dot[2] > 190), 'all three status dots must be visible')
  assert(dots[1][0] > dots[0][0] + 65, 'middle indicator must be purple rather than all-cyan')
  const ico = readFileSync('build/icon.ico')
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 7)
  const icns = readFileSync('build/icon.icns')
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  assert(icns.includes(Buffer.from('ic10')))
  let macPng: Buffer | undefined
  for (let at = 8; at + 8 <= icns.length;) {
    const length = icns.readUInt32BE(at + 4)
    assert(length >= 8 && at + length <= icns.length)
    if (icns.toString('ascii', at, at + 4) === 'ic10') macPng = icns.subarray(at + 8, at + length)
    at += length
  }
  assert(macPng)
  assert.deepEqual(readFileSync('build/icon-mac.png'),macPng,'runtime Dock PNG uses the same approved Mac artwork as the ICNS')
  assert.equal(macPng.readUInt32BE(16), 1024)
  assert.equal(macPng.readUInt32BE(20), 1024)
  // Verify the actual packaged Mac artwork, not just the Linux PNG.
  for (const [x, y] of [[99, 512], [924, 512], [512, 99], [512, 924], [100, 100]]) {
    assert.equal(pixel(macPng, x, y)[3], 0, 'Mac icon must stay inside its inset rounded-square template')
  }
  for (const [x, y] of [[100, 512], [923, 512], [512, 100], [512, 923]]) {
    const edge = pixel(macPng, x, y)
    assert.equal(edge[3], 255, 'Mac artwork has an opaque inner edge, no separate translucent border')
    assert(edge[0] < 70 && edge[2] > edge[0], 'Mac artwork edge remains dark navy, not white')
  }
  const macCenter = pixel(macPng, 512, 512)
  assert(macCenter[0] < 50 && macCenter[2] > macCenter[0] && macCenter[3] === 255)
  // The existing cyan ellipse is rescaled with the original approved symbol.
  const arc = Array.from({ length: 7 }, (_, i) => pixel(macPng!, 512, 293 + i))
  assert(arc.some(value => value[1] > 160 && value[2] > 160), 'Mac icon preserves the approved cyan ellipse')
})
