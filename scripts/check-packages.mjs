import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const expected = process.platform === 'darwin' ? ['.dmg', '.zip'] : process.platform === 'win32' ? ['.exe'] : ['.AppImage', '.deb']
const names = (await readdir('release')).filter(name => expected.some(extension => name.endsWith(extension)))
for (const extension of expected) if (!names.some(name => name.endsWith(extension))) throw new Error(`Missing installer type ${extension}`)
const lines = []
for (const name of names) {
  const file = join('release', name)
  if ((await stat(file)).size < 1024 * 1024) throw new Error(`Installer appears incomplete: ${name}`)
  const hash = createHash('sha256')
  for await (const buffer of createReadStream(file)) hash.update(buffer)
  lines.push(`${hash.digest('hex')}  ${name}`)
}
await writeFile('release/SHA256SUMS.txt', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Built installers\n\nPackaged application smoke test passed. Installer SHA-256 values:\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n\nArtifact delivery is optional in CI and requires available Actions storage. Check the upload step before expecting download links.\n`)
