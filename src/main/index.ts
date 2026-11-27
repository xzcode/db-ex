import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, utilityProcess, nativeImage, screen, session as electronSession } from 'electron'
import { windowChromeOptions } from '../shared/window-chrome'
import { isLocale, resolveLocale, translate, localizeMessage, type Locale } from '../shared/i18n'
import {publishNewFile} from './operations/publish-file'
import { randomUUID } from 'node:crypto'
import { normalizeWorkspaceWindows,PRIMARY_WORKSPACE,type WorkspaceWindow } from '../shared/workspace-windows'
import { join, basename, extname, dirname } from 'node:path'
import { readFile, stat, writeFile, mkdir, mkdtemp, rm, chmod } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ConnectionConfig, DatabaseOperation, FileImport, QuerySnippet } from '../shared/types'
import { ConnectionStore } from './connections/store'
import {MigrationService} from './migration/service'
import {MigrationHistory} from './migration/history'
import {migrationPolicyLabel,type MigrationJob} from '../shared/migration'
import { SessionManager } from './connections/manager'
import { validateId } from './connections/validation'
import { SnippetStore } from './storage/snippets'
import { SavedQueryStore } from './storage/saved-queries'
import { decrypt,encrypt,readJson,writeJson,SerialWrites } from './storage/secure-json'
import { normalizeQueryScope,queryModeFor,portableQuery,readPortableQuery,type QueryMode,type SavedQuery,type QuerySave } from '../shared/saved-query'
import { initNativePreferences, getNativePreferences, saveNativePreferences, checkTool, diagnosticDirectory, diagnostic, saveRecovery, loadRecovery, clearRecovery, deleteRecovery } from './storage/preferences'
import { NativeCliProcess,cliStatement,cliToolFor,prepareNativeCli } from './operations/native-cli'
import { nativeTasks,runNativeTool,toolVersion } from './operations/native-tools'
import { nativeToolTasks,toolNames, type ToolName,type NativeToolTask } from '../shared/preferences'
import { parseSshConfig } from './connections/ssh-config'
import { adapterOperationWrites } from './connections/adapters'
import { transferFormat } from './operations/clickhouse-transfer'
import { validateMongoDocumentEdit } from './operations/mongodb'

function getSystemLanguage(): string { return app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en' }
let currentLocale: Locale = 'en'
const tr = (key: string, values: readonly unknown[] = []) => translate(currentLocale, key, values)
const store = new ConnectionStore()
const migrationHistory=new MigrationHistory({
 async load(){const value=await readJson<{version:number;encrypted:string}>('migration-history.secure.json');if(!value)return [];if(value.version!==1||typeof value.encrypted!=='string')throw new Error('MIGRATION_HISTORY: 迁移历史文件无效');return decrypt<MigrationJob[]>(value.encrypted)},
 async save(jobs){await writeJson('migration-history.secure.json',{version:1,encrypted:encrypt(jobs)})}
})
const migrations=new MigrationService(id=>store.get(id),modulePath=>{
 const child=utilityProcess.fork(modulePath,[],{stdio:'ignore',serviceName:'DB EX SQLite migration'})
 return {send:message=>child.postMessage(message),onMessage:callback=>{child.on('message',callback)},onExit:callback=>{child.once('exit',callback)},onError:callback=>{child.on('error',callback)},kill:()=>{child.kill()}}
},app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','sqlite-worker.cjs'):join(__dirname,'sqlite-worker.cjs'),migrationHistory)
const sessions = new SessionManager(modulePath=>{
  const child=utilityProcess.fork(modulePath,[],{stdio:'ignore',serviceName:'DB EX SQLite'})
  return {send:message=>child.postMessage(message),onMessage:callback=>{child.on('message',callback)},onExit:callback=>{child.once('exit',callback)},onError:callback=>{child.on('error',callback)},kill:()=>{child.kill()}}
},app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','sqlite-worker.cjs'):join(__dirname,'sqlite-worker.cjs'))
const snippets = new SnippetStore()
const savedQueries=new SavedQueryStore({
  async read(){
    const file=await readJson<{version:number;encrypted:string}>('saved-queries.secure.json')
    if(!file)return []
    if(file.version!==1||typeof file.encrypted!=='string')throw new Error('查询记录格式不兼容')
    return decrypt<SavedQuery[]>(file.encrypted)
  },
  write:values=>writeJson('saved-queries.secure.json',{version:1,encrypted:encrypt(values)})
})
function savedQueryScope(id:string,database:string){
  const info=sessions.info(id)
  return normalizeQueryScope({connectionId:info.connectionId,kind:info.kind,database})
}
let quitting = false
const development = !app.isPackaged && process.argv.includes('--dev')
const rendererUrl = development ? 'http://127.0.0.1:5173/' : pathToFileURL(join(__dirname, '../dist/index.html')).href
const windows = new Set<number>()
const windowIds=new Map<number,string>(),sessionOwners=new Map<string,number>()
const nativeClis=new Map<string,NativeCliProcess>(),nativeCliJobs=new Map<string,Promise<unknown>>()
const windowWrites=new SerialWrites()
let savedWindows:WorkspaceWindow[]=[],startupWindowId=PRIMARY_WORKSPACE,windowRestoreStarted=false,windowSaveTimer:ReturnType<typeof setTimeout>|undefined
function liveWindows(){return normalizeWorkspaceWindows(BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()&&windowIds.has(w.webContents.id)).map(w=>({id:windowIds.get(w.webContents.id),bounds:w.getNormalBounds()})))}
async function persistWindows(){const snapshot=liveWindows();if(snapshot.length)await windowWrites.run(()=>writeJson('workspace-windows.json',snapshot))}
function scheduleWindows(){if(quitting||!windowRestoreStarted)return;if(windowSaveTimer)clearTimeout(windowSaveTimer);windowSaveTimer=setTimeout(()=>{void persistWindows().catch(()=>{})},350)}
async function ownedConnect(win:BrowserWindow,config:ConnectionConfig,connectionId?:string){
 const owner=win.webContents.id,info=await sessions.connect(config,connectionId)
 if(!windows.has(owner)||quitting){await sessions.disconnect(info.id);throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接')}
 sessionOwners.set(info.id,owner);return info
}
function assertOwner(win:BrowserWindow,id:string){
 if(sessionOwners.get(id)!==win.webContents.id)throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接')
 try{sessions.info(id)}catch(error){sessionOwners.delete(id);throw error}
}
function sessionHandler<T extends unknown[]>(fn:(win:BrowserWindow,id:string,...args:T)=>Promise<unknown>|unknown){
 return handler((win,id:string,...args:T)=>{assertOwner(win,id);return fn(win,id,...args)})
}
async function disconnectOwned(id:string){
 sessionOwners.delete(id);nativeClis.get(id)?.stop();nativeClis.delete(id)
 try{await sessions.disconnect(id)}finally{await nativeCliJobs.get(id)?.catch(()=>{});nativeCliJobs.delete(id)}
}
async function closeWindowSessions(owner:number){await Promise.allSettled([...sessionOwners].filter(([,w])=>w===owner).map(([id])=>disconnectOwned(id)))}

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
function writes(op: DatabaseOperation, writable: boolean, kind:import('../shared/types').DatabaseKind): boolean {
  if (!op || typeof op !== 'object' || typeof op.action !== 'string') throw new Error('INVALID_OPERATION: 操作参数无效')
  if (Buffer.byteLength(JSON.stringify(op)) > 4 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED: 操作参数最多4 MiB')
  return adapterOperationWrites(kind,op,writable)
}
function operationDetail(id: string, op: DatabaseOperation): string {
  const info = sessions.info(id)
  const target = op.action==='mongo.renameCollection' ? `${op.database}.${op.entity} → ${op.database}.${op.newName}` : 'entity' in op ? `${op.database}.${op.entity}` : 'initialCollection' in op ? `${op.database}.${op.initialCollection}` : 'database' in op ? op.database || '' : 'key' in op ? op.key : 'keys' in op ? tr('{0} 个已选择的Key', [op.keys.length]) : ''
  const count = 'edits' in op ? '\n' + tr('修改 {0} 条选中记录', [op.edits.length]) : 'rows' in op ? '\n' + tr('导入 {0} 行', [op.rows.length]) : 'documents' in op ? '\n' + tr('写入 {0} 个文档', [op.documents.length]) : ''
  const sql = (op.action === 'mysql.query'||op.action==='clickhouse.query') ? `\n\n${op.sql.slice(0, 1500)}` : op.action==='mongo.scriptWrite' ? '\n\n'+op.method+'\nFilter: '+op.filter.slice(0,3000)+'\nUpdate / replacement: '+(op.value||'').slice(0,3000)+'\nOptions: '+(op.options||'{}').slice(0,1000) : op.action==='mariadb.sequenceRestart' ? '\nRESTART WITH '+op.value : op.action==='clickhouse.change' ? '\n\n'+JSON.stringify(op.change,null,2).slice(0,8192) : op.action === 'redis.command' ? '\n' + tr('命令：') + ' ' + op.args[0] : ''
  return `${tr('连接：')} ${info.name}\n${tr('地址：')} ${info.displayHost}\n${tr('操作：')} ${op.action}${target ? '\n' + tr('目标：') + ' ' + target : ''}${count}\n${tr(info.transaction ? '当前有未提交事务。' : '本操作可能立即持久化。')}${sql}`
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
  const requestedExtension = extname(name).slice(1).toLowerCase()
  const extension = format === 'text' ? (['txt', 'sql', 'js'].includes(requestedExtension) ? requestedExtension : 'txt') : format
  const answer = await dialog.showSaveDialog(win, { title: tr(title), defaultPath: basename(name), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] })
  if (answer.canceled || !answer.filePath) return false
  await writeFile(answer.filePath, content, { encoding: 'utf8', mode: 0o600 })
  return true
}
function registerIpc(): void {
  ipcMain.handle('migration:catalog',handler((win,id:unknown,database?:unknown)=>migrations.catalog(win.webContents.id,id,database)))
  ipcMain.handle('migration:preview',handler((win,request:unknown)=>migrations.preview(win.webContents.id,request)))
  ipcMain.handle('migration:jobs',handler(win=>migrations.list(win.webContents.id)))
  ipcMain.handle('migration:remove-history',handler((win,id:unknown)=>migrations.removeHistory(win.webContents.id,id)))
  ipcMain.handle('migration:cancel',handler((win,id:unknown)=>migrations.cancel(win.webContents.id,id)))
  ipcMain.handle('migration:run',handler(async(win,planId:unknown,steps:unknown)=>{
    const owner=win.webContents.id
    const info=migrations.confirmation(owner,planId,steps)
    await confirm(win,info.policy==='replace'?'确认清空目标表并重新传输？':info.policy==='upsert'?'确认覆盖匹配的数据？':'确认执行数据库迁移？',tr('源数据库')+': '+info.source+'\n'+tr('目标数据库')+': '+info.target+'\n'+tr('结构变更')+': '+info.ddl+'\n'+tr('数据传输')+': '+info.data+'\n'+tr('写入模式')+': '+tr(migrationPolicyLabel(info.policy,info.kind))+(info.condition?'\n'+tr('源记录条件')+': '+info.condition.field+' '+info.condition.operator+' ('+info.condition.type+') '+JSON.stringify(info.condition.value):'')+'\n\n'+info.names.join(', ')+'\n\n'+tr('已完成的结构变更和已写入的数据可能无法自动回滚。源与目标结构须在执行前复核。'))
    if(!windows.has(owner)||quitting)throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接')
    return migrations.start(owner,planId,steps)
  }))
  ipcMain.handle('workspace:new-window',handler(()=>{if(windows.size>=8)throw new Error('LIMIT_EXCEEDED: 最多打开8个工作区窗口');createWindow(randomUUID());return true}))
  ipcMain.handle('workspace:restore-windows',handler((win,restore:unknown)=>{
    if(typeof restore!=='boolean'||windowIds.get(win.webContents.id)!==startupWindowId||windowRestoreStarted)return
    windowRestoreStarted=true
    if(restore)for(const item of savedWindows)if(item.id!==startupWindowId&&windows.size<8&&!Array.from(windowIds.values()).includes(item.id))createWindow(item.id,item.bounds)
    scheduleWindows()
  }))
  ipcMain.handle('preferences:native-get', handler(()=>getNativePreferences()))
  ipcMain.handle('preferences:native-save', handler((_win,value:unknown)=>saveNativePreferences(value)))
  ipcMain.handle('preferences:pick-tool', handler(async(win,name:ToolName)=>{
    if(!toolNames.includes(name))throw new Error('INVALID_TOOL_PATH: 请输入可执行文件的绝对路径')
    const result=await dialog.showOpenDialog(win,{title:tr('选择可执行文件')+' · '+name,properties:['openFile']})
    return result.canceled?null:result.filePaths[0]||null
  }))
  ipcMain.handle('preferences:check-tool',handler((_win,name:ToolName,path:unknown)=>checkTool(name,path)))
  ipcMain.handle('preferences:tool-version',handler(async(win,name:ToolName,path:string)=>{
    if(!await checkTool(name,path))throw new Error('INVALID_TOOL_PATH: 请输入可执行文件的绝对路径')
    await confirm(win,'确认执行外部工具？',name+' --version\n'+path)
    return toolVersion(path)
  }))
  ipcMain.handle('preferences:log-path',handler(()=>diagnosticDirectory()))
  ipcMain.handle('preferences:open-logs',handler(async()=>{const dir=diagnosticDirectory();await mkdir(dir,{recursive:true,mode:0o700});const error=await shell.openPath(dir);if(error)throw new Error('无法打开日志目录')}))
  ipcMain.handle('recovery:save',handler((win,value:unknown)=>saveRecovery({...(value&&typeof value==='object'?value:{}),windowId:windowIds.get(win.webContents.id)})))
  ipcMain.handle('recovery:load',handler((win,value:unknown)=>loadRecovery({...(value&&typeof value==='object'?value:{}),windowId:windowIds.get(win.webContents.id)})))
  ipcMain.handle('recovery:delete',handler((win,value:unknown)=>deleteRecovery({...(value&&typeof value==='object'?value:{}),windowId:windowIds.get(win.webContents.id)})))
  ipcMain.handle('recovery:clear',handler(()=>clearRecovery()))

  ipcMain.handle('connections:pick-file', handler(async (win, kind: unknown) => {
    if(kind==='sqlite-create'){
      const answer=await dialog.showSaveDialog(win,{title:'SQLite',defaultPath:'database.sqlite',filters:[{name:'SQLite',extensions:['sqlite','sqlite3','db']}]})
      if(answer.canceled||!answer.filePath)return null
      await writeFile(answer.filePath,'',{flag:'wx',mode:0o600})
      return answer.filePath
    }
    if(kind==='sqlite'){
      const answer=await dialog.showOpenDialog(win,{title:'SQLite',properties:['openFile'],filters:[{name:'SQLite',extensions:['sqlite','sqlite3','db','db3']},{name:tr('所有文件'),extensions:['*']}]})
      return answer.canceled?null:answer.filePaths[0]||null
    }
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
  ipcMain.handle('connections:delete', handler(async (_win, id: string) => {
    validateId(id)
    const owned:string[]=[]
    for(const sessionId of sessionOwners.keys()){
      try{if(sessions.info(sessionId).connectionId===id)owned.push(sessionId)}
      catch{sessionOwners.delete(sessionId)}
    }
    await Promise.all(owned.map(disconnectOwned))
    await sessions.disconnectForConnection(id)
    await store.delete(id)
  }))
  ipcMain.handle('connections:trust-host', handler(async (win, id: string, fingerprint: string) => {
    validateId(id)
    if (!/^[a-f\d]{64}$/i.test(fingerprint)) throw new Error('指纹格式错误')
    const config = store.get(id)
    await confirm(win, '保存已独立核验的 SSH 主机指纹？', `SSH: ${config.ssh.host}:${config.ssh.port}\nSHA-256: ${fingerprint}\n${tr('请先与可信来源核对，指纹不符时不要继续。')}`, '已核验，保存')
    await store.trustHostKey(id, fingerprint)
  }))
  ipcMain.handle('connections:connect-saved', handler((win, id: string) => ownedConnect(win,store.get(id), id)))
  ipcMain.handle('connections:connect-temporary', handler((win, config: ConnectionConfig, clearSecrets?: string[]) => ownedConnect(win,store.resolve(config, clearSecrets))))
  ipcMain.handle('connections:test', handler(async (_win, config: ConnectionConfig, clearSecrets?: string[]) => {
    const info = await sessions.connect(store.resolve(config, clearSecrets))
    try { return `连接成功：${info.kind} · ${info.displayHost}` } finally { await sessions.disconnect(info.id) }
  }))
  ipcMain.handle('connections:disconnect', sessionHandler((_win, id: string) => disconnectOwned(id)))
  ipcMain.handle('connections:import', handler(async win => { const file = await openText(win, '导入 DB EX 连接备份', 16 * 1024 * 1024); if (!file) return 0; return store.importConnections(JSON.parse(file.text)) }))
  ipcMain.handle('connections:export', handler((win, id?: string) => {
    if (id !== undefined) validateId(id)
    return saveText(win, id ? 'db-ex-connection.json' : 'db-ex-connections.json', JSON.stringify(store.exportConnections(id), null, 2), 'json', '导出 DB EX 连接备份（含加密凭据）', 16 * 1024 * 1024)
  }))
  ipcMain.handle('connections:ssh-config', handler(async win => { const file = await openText(win, '选择 SSH config 文件', 1024 * 1024); return file ? parseSshConfig(file.text) : null }))
  ipcMain.handle('explorer:roots', sessionHandler((_win, id: string) => sessions.roots(id)))
  ipcMain.handle('explorer:children', sessionHandler((_win, id: string, database: string, category?: import('../shared/mongo-catalog').MongoCategory, withStatistics?:boolean) => sessions.children(id, database, category, withStatistics)))
  ipcMain.handle('explorer:preview', sessionHandler((_win, id: string, database: string, entity: string, offset?: number) => sessions.preview(id, database, entity, offset)))
  ipcMain.handle('explorer:redis-keys', sessionHandler((_win, id: string, cursor?: string, pattern?: string) => sessions.redisKeys(id, cursor, pattern)))
  ipcMain.handle('explorer:redis-value', sessionHandler((_win, id: string, key: string) => sessions.redisValue(id, key)))
  ipcMain.handle('sessions:write-access', sessionHandler(async (win, id: string, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('权限参数无效')
    const info = sessions.info(id)
    if (enabled && !info.writable) await confirm(win, tr('允许修改 {0} 的数据？', [info.name]), `${tr('地址：')} ${info.displayHost}\n${tr('本会话将允许执行写操作，断开连接后恢复只读。数据库账号权限仍然有效。')}`, '解锁此会话')
    return sessions.setWriteAccess(id, enabled)
  }))
  ipcMain.handle('sessions:execute', sessionHandler(async (win, id: string, operation: DatabaseOperation) => {
    const info = sessions.info(id)
    if (writes(operation, info.writable, info.kind)) {
      if (!info.writable || !('confirmed' in operation) || operation.confirmed !== true) throw new Error('WRITE_CONFIRMATION_REQUIRED: 请先解锁会话，并主动确认写入')
      await confirm(win, operation.action === 'mongo.dropDatabase' || operation.action === 'mysql.dropDatabase' ? '确认永久删除整个数据库？' : operation.action==='mongo.dropCollection'?'确认永久删除集合？':operation.action==='mongo.clearCollection'?'确认清空集合全部文档？':operation.action==='mongo.scriptWrite'&&['deleteOne','deleteMany','findOneAndDelete'].includes(operation.method)?'确认删除符合筛选条件的文档？':'确认执行数据库写操作？', operationDetail(id, operation))
    }
    const start=Date.now()
    try { const result=await sessions.execute(id,operation);diagnostic(operation.action,'ok',Date.now()-start);return result }
    catch(error){diagnostic(operation.action,'error',Date.now()-start);throw error}
  }))
  ipcMain.handle('clipboard:copy-text', handler((_win, value: unknown) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED: 剪贴板文本过大')
    clipboard.writeText(value)
  }))
  ipcMain.handle('mongo:validate-document', handler((_win, document: string, original?: string) => validateMongoDocumentEdit(document, original)))
  ipcMain.handle('sessions:sqlite-backup',sessionHandler(async(win,id:string)=>{
    const info=sessions.info(id)
    if(info.kind!=='sqlite'||info.transaction)throw new Error('INVALID_OPERATION: 不支持的操作')
    const answer=await dialog.showSaveDialog(win,{title:tr('备份数据库'),defaultPath:'backup.sqlite',filters:[{name:'SQLite',extensions:['sqlite','sqlite3','db']}]})
    if(answer.canceled||!answer.filePath)return false
    await confirm(win,'备份数据库',info.name+'\n'+answer.filePath+'\n'+tr('导出仅创建新文件，不覆盖现有文件。'))
    const dir=await mkdtemp(join(dirname(answer.filePath),'.dbex-sqlite-'))
    try{const temp=join(dir,'backup.sqlite');await sessions.backupSqlite(id,temp);await chmod(temp,0o600);await publishNewFile(temp,answer.filePath);return true}
    finally{await rm(dir,{recursive:true,force:true})}
  }))
  ipcMain.handle('sessions:native-tool',sessionHandler(async(win,id:string,task:NativeToolTask,database:string,entity?:string)=>{
    if(!nativeToolTasks.includes(task))throw new Error('INVALID_OPERATION: 不支持的操作')
    const spec=nativeTasks[task],info=sessions.info(id)
    if(info.kind!==spec.kind)throw new Error('INVALID_OPERATION: 操作与连接类型不匹配')
    if(spec.write&&!info.writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
    const executable=getNativePreferences().tools[spec.tool]
    if(!executable||!await checkTool(spec.tool,executable))throw new Error('INVALID_TOOL_PATH: 请输入可执行文件的绝对路径')
    const filters=[{name:spec.tool,extensions:[spec.extension]}]
    const result=spec.write?await dialog.showOpenDialog(win,{properties:['openFile'],filters}):await dialog.showSaveDialog(win,{defaultPath:'database.'+spec.extension,filters})
    const file='filePaths'in result?result.filePaths[0]:result.filePath
    if(result.canceled||!file)return false
    await confirm(win,'确认执行外部工具？',spec.tool+'\n'+info.name+' · '+database+(entity?'.'+entity:'')+'\n'+file+'\n'+tr(spec.write?'导入或恢复可能写入数据库，请确认文件来源及目标。':'导出仅创建新文件，不覆盖现有文件。'))
    await sessions.routedExternal(id,spec.write,(config,signal,route)=>runNativeTool(executable,task,config,database,entity,file,signal,route))
    return true
  }))
  ipcMain.handle('sessions:cli-start',sessionHandler(async(win,id,database:string)=>{
    const info=sessions.info(id),tool=cliToolFor(info.kind)
    if(!tool||!info.writable||info.transaction||nativeClis.has(id))throw new Error('INVALID_OPERATION: Native CLI requires write-enabled idle session')
    const path=getNativePreferences().tools[tool]
    if(!path||!await checkTool(tool,path))throw new Error('INVALID_TOOL_PATH: 请输入可执行文件的绝对路径')
    await confirm(win,'确认打开原生数据库 CLI？',info.name+' · '+info.displayHost+'\n'+database+'\n'+tr('独立原生会话；关闭会话不会撤销已提交的操作。'))
    assertOwner(win,id)
    if(nativeClis.has(id))throw new Error('SESSION_BUSY: 当前连接正在执行操作')
    const cli=new NativeCliProcess(info.kind,text=>sessions.redact(text))
    nativeClis.set(id,cli)
    await new Promise<void>((resolve,reject)=>{
      const job=sessions.routedExternal(id,true,async(config,signal,route)=>{
        const prepared=await prepareNativeCli(config,database,route)
        try{await cli.start(path,prepared.args,signal);resolve();await cli.finished}
        catch(error){cli.stop();reject(error);throw error}
        finally{await prepared.cleanup()}
      }).catch(error=>{nativeClis.delete(id);reject(error)})
      nativeCliJobs.set(id,job)
      void job.finally(()=>{if(nativeCliJobs.get(id)===job)nativeCliJobs.delete(id)})
    })
  }))
  ipcMain.handle('sessions:cli-read',sessionHandler((_win,id)=>{const cli=nativeClis.get(id);if(!cli)throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接');return cli.snapshot()}))
  ipcMain.handle('sessions:cli-send',sessionHandler(async(win,id,sql:string)=>{
    const cli=nativeClis.get(id),info=sessions.info(id)
    if(!cli||!info.writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
    const plan=cliStatement(info.kind,sql)
    if(plan.mode==='write')await confirm(win,'确认执行数据库写操作？',info.name+' · '+info.displayHost+'\n'+plan.sql.slice(0,4096))
    assertOwner(win,id)
    if(nativeClis.get(id)!==cli)throw new Error('SESSION_CLOSED: 会话已关闭，请重新连接')
    cli.send(plan.sql)
  }))
  ipcMain.handle('sessions:cli-stop',sessionHandler(async(_win,id)=>{
    const cli=nativeClis.get(id);if(!cli)return;cli.stop();await nativeCliJobs.get(id);nativeClis.delete(id)
  }))
  ipcMain.handle('sessions:clickhouse-transfer',sessionHandler(async(win,id:string,input:import('../shared/types').ClickHouseTransfer)=>{
    const info=sessions.info(id)
    if(info.kind!=='clickhouse'||!input||!['import','export'].includes(input.direction)||typeof input.database!=='string'||typeof input.entity!=='string'||input.database.length>200||input.entity.length>200)throw new Error('INVALID_INPUT: ClickHouse transfer')
    transferFormat(input.format)
    if(input.direction==='import'&&!info.writable)throw new Error('READ_ONLY: 请先启用当前会话的写入权限')
    const filters=[{name:input.format.toUpperCase(),extensions:[input.format]}]
    const selected=input.direction==='import'?await dialog.showOpenDialog(win,{properties:['openFile'],filters}):await dialog.showSaveDialog(win,{defaultPath:'clickhouse.'+input.format,filters})
    const path='filePaths'in selected?selected.filePaths[0]:selected.filePath
    if(selected.canceled||!path)return null
    await confirm(win,'确认执行外部工具？',info.name+' · '+info.displayHost+'\n'+input.database+'.'+input.entity+'\n'+input.direction+' '+input.format+'\n'+path+'\n'+tr(input.direction==='import'?'流式导入可能部分写入；失败或取消后请核对，不要直接重试。':'导出整表（无当前页筛选），最多256 MiB；不覆盖现有文件。')+(input.direction==='export'&&input.format==='csv'?'\n'+tr('原始 CSV 保留原值；在电子表格中打开前请检查公式风险。'):''))
    return sessions.clickhouseTransfer(id,input,path)
  }))
  ipcMain.handle('sessions:cancel', sessionHandler((_win, id: string) => disconnectOwned(id)))
  ipcMain.handle('query-objects:list',sessionHandler((_win,id:string,database:string,mode:QueryMode)=>savedQueries.list(savedQueryScope(id,database),mode)))
  ipcMain.handle('query-objects:get',sessionHandler((_win,id:string,database:string,queryId:string)=>savedQueries.get(savedQueryScope(id,database),queryId)))
  ipcMain.handle('query-objects:save',sessionHandler((_win,id:string,database:string,input:QuerySave)=>savedQueries.save(savedQueryScope(id,database),input)))
  ipcMain.handle('query-objects:copy',sessionHandler((_win,id:string,database:string,queryId:string)=>savedQueries.copy(savedQueryScope(id,database),queryId)))
  ipcMain.handle('query-objects:delete',sessionHandler(async(win,id:string,database:string,queryId:string,revision:string)=>{
    const scope=savedQueryScope(id,database),item=await savedQueries.get(scope,queryId)
    await confirm(win,'删除已保存的查询？',item.name+' @ '+database,'删除')
    await savedQueries.remove(scope,queryId,revision)
  }))
  ipcMain.handle('query-objects:import',sessionHandler(async(win,id:string,database:string,mode:QueryMode)=>{
    const scope=savedQueryScope(id,database);queryModeFor(scope.kind,mode)
    const file=await openText(win,'导入查询',512*1024)
    if(!file)return null
    const isSql=extname(file.name).toLowerCase()==='.sql'
    const draft=readPortableQuery(scope.kind,mode,file.text,basename(file.name,extname(file.name)).slice(0,100)||tr('未命名查询'),isSql)
    return savedQueries.import(scope,draft)
  }))
  ipcMain.handle('query-objects:export',sessionHandler(async(win,id:string,database:string,queryId:string,format:'json'|'sql')=>{
    const item=await savedQueries.get(savedQueryScope(id,database),queryId)
    if(format!=='json'&&format!=='sql'||format==='sql'&&item.mode!=='sql')throw new Error('查询记录参数错误')
    // Query files are intentionally portable plaintext; never include profile credentials.
    await confirm(win,'导出查询文件（明文）？',tr(format==='sql'?'SQL 文件仅包含语句，不包含绑定参数。':'JSON 文件包含查询内容和参数，不包含连接凭据。'),'导出')
    const name=item.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100)||'query'
    return saveText(win,name+(format==='sql'?'.sql':'.dbex-query.json'),format==='sql'?item.text:JSON.stringify(portableQuery(item),null,2),format==='sql'?'text':'json','导出查询')
  }))
  ipcMain.handle('snippets:list', handler(() => snippets.list()))
  ipcMain.handle('snippets:save', handler((_win, value: Omit<QuerySnippet, 'id' | 'updatedAt'> & { id?: string }) => snippets.save(value)))
  ipcMain.handle('snippets:delete', handler((_win, id: string) => snippets.delete(id)))
  ipcMain.handle('files:import', handler(win => openText(win, '选择数据文件（最多4 MiB）')))
  ipcMain.handle('files:export', handler((win, name: string, content: string, format: 'csv' | 'json' | 'text') => saveText(win, name, content, format)))
}
// Use the same approved generated artwork as the installed app bundle.
function runtimeIconPath():string {
  const mac=process.platform==='darwin'
  return app.isPackaged?join(process.resourcesPath,'icons',mac?'db-ex-mac.png':'db-ex.png'):join(app.getAppPath(),'build',mac?'icon-mac.png':'icon.png')
}
function runtimeIcon(){
  const image=nativeImage.createFromPath(runtimeIconPath())
  return image.isEmpty()?undefined:image
}
function createWindow(id=PRIMARY_WORKSPACE,bounds?:WorkspaceWindow['bounds']): void {
  const safeBounds=bounds&&screen.getAllDisplays().some(d=>bounds.x<d.workArea.x+d.workArea.width-100&&bounds.y<d.workArea.y+d.workArea.height-100&&bounds.x+bounds.width>d.workArea.x+100&&bounds.y+bounds.height>d.workArea.y+100)?bounds:undefined
  const win = new BrowserWindow({ title: 'DB EX', width: 1440, height: 900,...safeBounds, minWidth: 1040, minHeight: 640,
    backgroundColor: '#111821', show: false,
    icon: runtimeIcon(),
    // On macOS retain AppKit's real traffic-light controls and extend web content
    // into the old title bar. Other operating systems keep their native frames.
    ...windowChromeOptions(process.platform),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false,additionalArguments:['--dbex-workspace='+id] },
  })
  const contentsId = win.webContents.id
  windows.add(contentsId);windowIds.set(contentsId,id)
  win.on('move',scheduleWindows);win.on('resize',scheduleWindows)
  win.on('close',()=>{if(!quitting&&windows.size===1)void persistWindows().catch(()=>{})})
  win.webContents.once('destroyed', () => {windows.delete(contentsId);windowIds.delete(contentsId);void closeWindowSessions(contentsId);void migrations.closeOwner(contentsId);if(!quitting&&windowRestoreStarted)void persistWindows().catch(()=>{})})
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  void win.loadURL(rendererUrl)
  scheduleWindows()
}
app.whenReady().then(async () => {
  currentLocale = resolveLocale('system', getSystemLanguage())
  if(process.platform==='win32')app.setAppUserModelId('dev.dbex.desktop')
  if(process.platform==='darwin'){
    const image=runtimeIcon()
    if(image)app.dock?.setIcon(image)
  }
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
  electronSession.defaultSession.on('will-download', event => event.preventDefault())
  await store.init()
  // Keep ordinary browsing available if history is damaged; migration
  // tasks fail before writes when their journal cannot initialize.
  await migrations.init().catch(()=>{})
  // Preferences are optional; a corrupt preferences file must not prevent opening existing connections.
  await initNativePreferences().catch(()=>{})
  savedWindows=normalizeWorkspaceWindows(await readJson('workspace-windows.json').catch(()=>undefined))
  registerIpc()
  const initial=savedWindows.find(w=>w.id===PRIMARY_WORKSPACE)||savedWindows[0]
  startupWindowId=initial?.id||PRIMARY_WORKSPACE
  createWindow(startupWindowId,initial?.bounds)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox(tr('DB EX 启动失败'), localizeMessage(currentLocale, safeError(error).message)); app.quit() })
app.on('window-all-closed', () => { void sessions.closeAll(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); quitting = true
  if(windowSaveTimer)clearTimeout(windowSaveTimer)
  for(const cli of nativeClis.values())cli.stop()
  void Promise.allSettled([persistWindows(),sessions.closeAll(),migrations.closeAll(),...nativeCliJobs.values()]).finally(() => app.quit())
})
