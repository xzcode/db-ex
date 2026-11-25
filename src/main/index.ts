import { app, BrowserWindow, dialog, ipcMain, session as electronSession } from 'electron'
import { isLocale, resolveLocale, translate, localizeMessage, type Locale } from '../shared/i18n'
import { join, basename, extname } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ConnectionConfig, DatabaseOperation, FileImport, QuerySnippet } from '../shared/types'
import { ConnectionStore } from './connections/store'
import { SessionManager } from './connections/manager'
import { validateId } from './connections/validation'
import { SnippetStore } from './storage/snippets'
import { parseSshConfig } from './connections/ssh-config'
import { inspectSql } from './operations/sql-policy'
import { redisCommandWrites, validateRedisCommand } from './operations/redis'

function getSystemLanguage(): string { return app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en' }
let currentLocale: Locale = 'en'
const tr = (key: string, values: readonly unknown[] = []) => translate(currentLocale, key, values)
const store = new ConnectionStore()
const sessions = new SessionManager()
const snippets = new SnippetStore()
let quitting = false
const development = !app.isPackaged && process.argv.includes('--dev')
const rendererUrl = development ? 'http://127.0.0.1:5173/' : pathToFileURL(join(__dirname, '../dist/index.html')).href
const windows = new Set<number>()
function safeError(error: unknown): Error {
  const original = error instanceof Error ? error.message : '操作失败'
  if (error instanceof SyntaxError) return new Error('格式无效，请检查 JSON / BSON / SQL 输入')
  return new Error(sessions.redact(original))
}
function caller(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  const source = event.senderFrame?.url?.split('#')[0]
  if (!win || !windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame || source !== rendererUrl) throw new Error('IPC_FORBIDDEN: 请求来源不受信任')
  return win
}
function handler<T extends unknown[]>(fn: (win: BrowserWindow, ...args: T) => Promise<unknown> | unknown) {
  return async (event: Electron.IpcMainInvokeEvent, ...args: T): Promise<unknown> => {
    try { return await fn(caller(event), ...args) } catch (error) { throw safeError(error) }
  }
}
async function confirm(win: BrowserWindow, message: string, detail: string, action = '确认执行'): Promise<void> {
  const answer = await dialog.showMessageBox(win, { type: 'warning', title: tr('DB EX · 操作确认'), message: tr(message), detail, buttons: [tr('取消'), tr(action)], defaultId: 0, cancelId: 0, noLink: true })
  if (answer.response !== 1) throw new Error('CANCELLED: 已取消操作')
}
function writes(op: DatabaseOperation, writable: boolean): boolean {
  if (!op || typeof op !== 'object' || typeof op.action !== 'string') throw new Error('INVALID_OPERATION: 操作参数无效')
  if (Buffer.byteLength(JSON.stringify(op)) > 4 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED: 操作参数最多4 MiB')
  if (op.action === 'mysql.query') return inspectSql(op.sql, writable).mode === 'write'
  if (op.action === 'redis.command') return redisCommandWrites(validateRedisCommand(op.args))
  return new Set(['mysql.insert', 'mysql.update', 'mysql.delete', 'mysql.import', 'mysql.begin', 'mysql.commit', 'mongo.insert', 'mongo.replace', 'mongo.delete', 'mongo.createIndex', 'mongo.dropIndex', 'redis.set', 'redis.mutate', 'redis.ttl', 'redis.delete']).has(op.action)
}
function operationDetail(id: string, op: DatabaseOperation): string {
  const info = sessions.info(id)
  const target = 'entity' in op ? `${op.database}.${op.entity}` : 'key' in op ? op.key : 'keys' in op ? tr('{0} 个已选择的Key', [op.keys.length]) : ''
  const count = 'rows' in op ? '\n' + tr('导入 {0} 行', [op.rows.length]) : 'documents' in op ? '\n' + tr('写入 {0} 个文档', [op.documents.length]) : ''
  const sql = op.action === 'mysql.query' ? `\n\n${op.sql.slice(0, 1500)}` : op.action === 'redis.command' ? '\n' + tr('命令：') + ' ' + op.args[0] : ''
  return `${tr('连接：')} ${info.name}\n${tr('环境：')} ${info.environment}\n${tr('操作：')} ${op.action}${target ? '\n' + tr('目标：') + ' ' + target : ''}${count}\n${tr(info.transaction ? '当前有未提交事务。' : '本操作可能立即持久化。')}${sql}`
}
async function openText(win: BrowserWindow, title: string, limit = 4 * 1024 * 1024): Promise<FileImport | null> {
  const selected = await dialog.showOpenDialog(win, { title: tr(title), properties: ['openFile'], filters: [{ name: tr('数据文件'), extensions: ['csv', 'json', 'jsonl', 'sql', 'txt', 'conf'] }, { name: tr('所有文件'), extensions: ['*'] }] })
  if (selected.canceled || !selected.filePaths[0]) return null
  const path = selected.filePaths[0]
  const info = await stat(path)
  if (!info.isFile() || info.size > limit) throw new Error(`导入文件必须是不超过 ${limit / 1024 / 1024} MiB 的普通文本文件`)
  const text = await readFile(path, 'utf8')
  const extension = extname(path).toLowerCase()
  return { name: basename(path), text, format: extension === '.csv' ? 'csv' : extension === '.json' ? 'json' : 'text' }
}
async function saveText(win: BrowserWindow, name: string, content: string, format: 'csv' | 'json' | 'text', title = '导出当前数据', limit = 8 * 1024 * 1024): Promise<boolean> {
  if (typeof name !== 'string' || name.length > 200 || typeof content !== 'string' || Buffer.byteLength(content) > limit || !['csv', 'json', 'text'].includes(format)) throw new Error(`导出参数无效或超过${limit / 1024 / 1024} MiB`)
  const extension = format === 'text' ? 'txt' : format
  const answer = await dialog.showSaveDialog(win, { title: tr(title), defaultPath: basename(name), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] })
  if (answer.canceled || !answer.filePath) return false
  await writeFile(answer.filePath, content, { encoding: 'utf8', mode: 0o600 })
  return true
}
function registerIpc(): void {
  ipcMain.handle('connections:pick-file', handler(async (win, kind: unknown) => {
    if (kind !== 'certificate' && kind !== 'private-key') throw new Error('INVALID_FILE_KIND')
    const all = { name: tr('所有文件'), extensions: ['*'] }
    const answer = await dialog.showOpenDialog(win, { title: tr(kind === 'certificate' ? '客户端证书 PEM 路径' : '私钥文件'),
      properties: ['openFile'], filters: kind === 'certificate' ? [{ name: 'PEM / CRT / CER', extensions: ['pem', 'crt', 'cer'] }, all] : [all] })
    return answer.canceled ? null : answer.filePaths[0] || null
  }))

  ipcMain.handle('preferences:system-language', handler(() => getSystemLanguage()))
  ipcMain.handle('preferences:locale', handler((_win, value: unknown) => {
    if (!isLocale(value)) throw new Error('INVALID_LOCALE')
    currentLocale = value
  }))
  ipcMain.handle('connections:list', handler(() => store.list()))
  ipcMain.handle('connections:appearance', handler((_win, id: string, patch: unknown) => store.updateAppearance(id, patch)))
  ipcMain.handle('connections:edit', handler((_win, id: string) => store.edit(id)))
  ipcMain.handle('connections:save', handler((_win, config: ConnectionConfig, clearSecrets?: string[]) => store.save(config, clearSecrets)))
  ipcMain.handle('connections:delete', handler(async (_win, id: string) => { validateId(id); await sessions.disconnectForConnection(id); await store.delete(id) }))
  ipcMain.handle('connections:trust-host', handler(async (win, id: string, fingerprint: string) => {
    validateId(id)
    if (!/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('指纹格式错误')
    const config = store.get(id)
    await confirm(win, '保存已独立核验的 SSH 主机指纹？', `SSH: ${config.ssh.host}:${config.ssh.port}\nSHA-256: ${fingerprint}\n${tr('请先与可信来源核对，指纹不符时不要继续。')}`, '已核验，保存')
    await store.trustHostKey(id, fingerprint)
  }))
  ipcMain.handle('connections:connect-saved', handler((_win, id: string) => sessions.connect(store.get(id), id)))
  ipcMain.handle('connections:connect-temporary', handler((_win, config: ConnectionConfig, clearSecrets?: string[]) => sessions.connect(store.resolve(config, clearSecrets))))
  ipcMain.handle('connections:test', handler(async (_win, config: ConnectionConfig, clearSecrets?: string[]) => {
    const info = await sessions.connect(store.resolve(config, clearSecrets))
    try { return `连接成功：${info.kind} · ${info.displayHost}` } finally { await sessions.disconnect(info.id) }
  }))
  ipcMain.handle('connections:disconnect', handler((_win, id: string) => sessions.disconnect(id)))
  ipcMain.handle('connections:import', handler(async win => { const file = await openText(win, '导入 DB EX 连接备份', 16 * 1024 * 1024); if (!file) return 0; return store.importConnections(JSON.parse(file.text)) }))
  ipcMain.handle('connections:export', handler((win, id?: string) => {
    if (id !== undefined) validateId(id)
    return saveText(win, id ? 'db-ex-connection.json' : 'db-ex-connections.json', JSON.stringify(store.exportConnections(id), null, 2), 'json', '导出 DB EX 连接备份（含加密凭据）', 16 * 1024 * 1024)
  }))
  ipcMain.handle('connections:ssh-config', handler(async win => { const file = await openText(win, '选择 SSH config 文件', 1024 * 1024); return file ? parseSshConfig(file.text) : null }))
  ipcMain.handle('explorer:roots', handler((_win, id: string) => sessions.roots(id)))
  ipcMain.handle('explorer:children', handler((_win, id: string, database: string) => sessions.children(id, database)))
  ipcMain.handle('explorer:preview', handler((_win, id: string, database: string, entity: string, offset?: number) => sessions.preview(id, database, entity, offset)))
  ipcMain.handle('explorer:redis-keys', handler((_win, id: string, cursor?: string, pattern?: string) => sessions.redisKeys(id, cursor, pattern)))
  ipcMain.handle('explorer:redis-value', handler((_win, id: string, key: string) => sessions.redisValue(id, key)))
  ipcMain.handle('sessions:write-access', handler(async (win, id: string, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('权限参数无效')
    const info = sessions.info(id)
    if (enabled && !info.writable) await confirm(win, tr('允许修改 {0} 的数据？', [info.name]), `${tr('环境：')} ${info.environment}\n${tr('地址：')} ${info.displayHost}\n${tr('本会话将允许执行写操作，断开连接后恢复只读。数据库账号权限仍然有效。')}`, '解锁此会话')
    return sessions.setWriteAccess(id, enabled)
  }))
  ipcMain.handle('sessions:execute', handler(async (win, id: string, operation: DatabaseOperation) => {
    const info = sessions.info(id)
    if (writes(operation, info.writable)) {
      if (!info.writable || !('confirmed' in operation) || operation.confirmed !== true) throw new Error('WRITE_CONFIRMATION_REQUIRED: 请先解锁会话，并主动确认写入')
      await confirm(win, info.environment === 'production' ? '确认修改生产环境数据？' : '确认执行数据库写操作？', operationDetail(id, operation))
    }
    return sessions.execute(id, operation)
  }))
  ipcMain.handle('sessions:cancel', handler((_win, id: string) => sessions.cancel(id)))
  ipcMain.handle('snippets:list', handler(() => snippets.list()))
  ipcMain.handle('snippets:save', handler((_win, value: Omit<QuerySnippet, 'id' | 'updatedAt'> & { id?: string }) => snippets.save(value)))
  ipcMain.handle('snippets:delete', handler((_win, id: string) => snippets.delete(id)))
  ipcMain.handle('files:import', handler(win => openText(win, '选择数据文件（最多4 MiB）')))
  ipcMain.handle('files:export', handler((win, name: string, content: string, format: 'csv' | 'json' | 'text') => saveText(win, name, content, format)))
}
function createWindow(): void {
  const win = new BrowserWindow({ title: 'DB EX', width: 1440, height: 900, minWidth: 1040, minHeight: 640,
    backgroundColor: '#111821', show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false },
  })
  const contentsId = win.webContents.id
  windows.add(contentsId)
  win.webContents.once('destroyed', () => windows.delete(contentsId))
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  void win.loadURL(rendererUrl)
}
app.whenReady().then(async () => {
  currentLocale = resolveLocale('system', getSystemLanguage())
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
  electronSession.defaultSession.on('will-download', event => event.preventDefault())
  await store.init()
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox(tr('DB EX 启动失败'), localizeMessage(currentLocale, safeError(error).message)); app.quit() })
app.on('window-all-closed', () => { void sessions.closeAll(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); quitting = true
  void sessions.closeAll().finally(() => app.quit())
})
