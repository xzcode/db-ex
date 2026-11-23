import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { access, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
async function packagedExecutable() {
  const root = resolve('release')
  const candidates = [join(root, 'linux-unpacked/db-ex'), join(root, 'linux-arm64-unpacked/db-ex'), join(root, 'win-unpacked/DB EX.exe'), join(root, 'win-arm64-unpacked/DB EX.exe')]
  for (const directory of await readdir(root)) if (directory.startsWith('mac')) candidates.push(join(root, directory, 'DB EX.app/Contents/MacOS/DB EX'))
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  throw new Error('Packaged DB EX executable was not found')
}
const packaged = process.env.DB_EX_PACKAGED === '1'
const application = await electron.launch({
  ...(packaged ? { executablePath: await packagedExecutable() } : {}),
  args: [...(packaged ? [] : ['.']), '--disable-gpu'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  timeout: 30000,
})
try {
  const page = await application.firstWindow({ timeout: 30000 })
  await page.waitForSelector('#app', { state: 'visible' })
  await page.waitForFunction(() => typeof window.dbex?.listConnections === 'function')
  const boundary = await page.evaluate(() => ({ node: typeof window.require, ipc: typeof window.dbex?.execute, title: document.title }))
  assert.equal(boundary.node, 'undefined')
  assert.equal(boundary.ipc, 'function')
  assert.match(boundary.title, /DB EX/)
  assert(Array.isArray(await page.evaluate(() => window.dbex.listConnections())))
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // Only test handlers are replaced, in this smoke process. Shipped application code has no mocks.
  await application.evaluate(({ ipcMain }) => {
    const fixture = { id: 'smoke', name: 'Smoke MySQL', kind: 'mysql', environment: 'testing', host: 'localhost', port: 3306, sshEnabled: false, tlsEnabled: false }
    const handlers = {
      'connections:list': () => [fixture],
      'connections:connect-saved': () => ({ ...fixture, displayHost: 'localhost', writable: false, transaction: false }),
      'explorer:roots': () => [{ id: 'db', label: 'smoke', kind: 'database', database: 'smoke' }],
      'sessions:execute': () => ({ columns: ['value'], rows: [{ value: '1' }], durationMs: 1 }),
    }
    for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
  })
  await page.reload()
  await page.locator('.connection-item').filter({ hasText: 'Smoke MySQL' }).getByTitle('连接', { exact: true }).click()
  await page.getByRole('button', { name: 'SQL 编辑器', exact: true }).click()
  await page.locator('.query-editor .monaco-editor').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: /运行选中/ }).click()
  await page.locator('.workbench:visible .data-table tbody tr').first().waitFor()
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: 'electron-smoke.png', fullPage: true })
  console.log(`${packaged ? 'Packaged' : 'Built'} Electron smoke passed: desktop launch, sandbox, real preload IPC, Monaco and query UI`)
} finally { await application.close() }
