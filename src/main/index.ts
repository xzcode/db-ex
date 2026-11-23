import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { ConnectionStore } from './connections/store'
import { SessionManager } from './connections/manager'
import { validateConnection, validateId } from './connections/validation'

const store = new ConnectionStore()
const sessions = new SessionManager()
let quitting = false

function safeError(error: unknown): Error {
  let message = error instanceof Error ? error.message : '未知错误'
  // Driver errors can contain connection strings; never pass credentials back to Renderer.
  message = message.replace(/(mongodb(?:\+srv)?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/((?:password|passphrase|pwd)=)[^\s&;,]+/gi, '$1***')
  return new Error(message.slice(0, 1500))
}

function handler<T extends unknown[]>(fn: (...args: T) => Promise<unknown> | unknown) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: T): Promise<unknown> => {
    try { return await fn(...args) } catch (error) { throw safeError(error) }
  }
}

function registerIpc(): void {
  ipcMain.handle('connections:list', handler(() => store.list()))
  ipcMain.handle('connections:save', handler(async (config: unknown) => store.save(validateConnection(config))))
  ipcMain.handle('connections:delete', handler(async (id: string) => {
    validateId(id)
    await sessions.disconnectForConnection(id)
    await store.delete(id)
  }))
  ipcMain.handle('connections:trust-host', handler(async (id: string, fingerprint: string) => {
    validateId(id)
    await store.trustHostKey(id, fingerprint)
  }))
  ipcMain.handle('connections:connect-saved', handler(async (id: string) => {
    validateId(id)
    return sessions.connect(store.get(id), id)
  }))
  ipcMain.handle('connections:connect-temporary', handler(async (config: unknown) => {
    return sessions.connect(validateConnection(config))
  }))
  ipcMain.handle('connections:disconnect', handler(async (id: string) => sessions.disconnect(id)))
  ipcMain.handle('explorer:roots', handler(async (id: string) => sessions.roots(id)))
  ipcMain.handle('explorer:children', handler(async (id: string, database: string) => sessions.children(id, database)))
  ipcMain.handle('explorer:preview', handler(async (id: string, database: string, entity: string, offset?: number) => {
    return sessions.preview(id, database, entity, offset)
  }))
  ipcMain.handle('explorer:redis-keys', handler(async (id: string, cursor?: number, pattern?: string) => {
    return sessions.redisKeys(id, cursor, pattern)
  }))
  ipcMain.handle('explorer:redis-value', handler(async (id: string, key: string) => sessions.redisValue(id, key)))
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'DB EX', width: 1330, height: 820, minWidth: 950, minHeight: 620,
    backgroundColor: '#111821', show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  if (process.argv.includes('--dev')) {
    void win.loadURL('http://127.0.0.1:5173')
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  await store.init()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => {
  // Do not log raw database credentials.
  console.error('DB EX failed to start:', safeError(error).message)
  app.quit()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void sessions.closeAll().finally(() => app.quit())
})
