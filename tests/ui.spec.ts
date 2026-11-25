import { expect, test, type Page } from '@playwright/test'
test.use({ locale: 'zh-CN' })

// The bridge is replaced only in tests; the application never supplies fake database data.
async function installBridge(page: Page) {
  await page.addInitScript(() => {

    const calls: Record<string, unknown>[] = []
    const sessions: Record<string, any> = {}
    const savedObjects: any[] = []
    const additionalDbs: Record<string,string[]> = {}
    const rows = [{ id: '1', name: 'Ada', email: 'ada@example.test' }]
    const document = '{"_id":{"$oid":"64b000000000000000000001"},"name":"Ada","createdAt":{"$date":{"$numberLong":"1700000000000"}},"score":{"$numberInt":"7"},"nullable":null,"nested":{"values":[{"$numberLong":"99"},"99"]}}'
    const secondDocument = '{"_id":{"$oid":"64b000000000000000000002"},"name":"Grace","score":"7","nullable":"NULL"}'
    const thirdDocument = '{"_id":{"$oid":"64b000000000000000000003"},"name":"Lin","score":{"$numberDouble":"7.0"}}'
    const mongoMetadata = [
      { type: 'Document', children: { _id: 'ObjectId', name: 'String', createdAt: 'Date', score: 'Int32', nullable: 'Null', nested: { type: 'Document', children: { values: { type: 'Array', children: { '0': 'Int64', '1': 'String' } } } } } },
      { type: 'Document', children: { _id: 'ObjectId', name: 'String', score: 'String', nullable: 'String' } },
      { type: 'Document', children: { _id: 'ObjectId', name: 'String', score: 'Double' } },
    ]
    const configs = [
      { id: 'sql', name: 'MySQL Local', kind: 'mysql', host: '127.0.0.1', port: 3306 },
      { id: 'mongo', name: 'Mongo Local', kind: 'mongodb', host: '127.0.0.1', port: 27017 },
      { id: 'redis', name: 'Redis Local', kind: 'redis', host: '127.0.0.1', port: 6379 },
      { id: 'sql2', name: 'MySQL Other', kind: 'mysql', host: '127.0.0.2', port: 3306 },
      {id:'ch',name:'ClickHouse Local',kind:'clickhouse',host:'127.0.0.1',port:8123},
    ].map(value => ({ ...value, sshEnabled: false, tlsEnabled: false }))
    const grid = (values: Record<string, string>[]) => ({ columns: Object.keys(values[0] || {}), rows: values })
    ;(window as any).__dbexCalls = calls
    ;(window as any).dbex = {
      windowChrome:localStorage.getItem('mock.window-chrome')==='mac-native-controls'?'mac-native-controls':'native',
      async getNativePreferences(){return JSON.parse(localStorage.getItem('mock.native-preferences')||'{"tools":{},"diagnostics":false}')},
      async saveNativePreferences(value:any){localStorage.setItem('mock.native-preferences',JSON.stringify(value));return value},
      async logPath(){return '/mock/logs'},async openLogs(){calls.push({action:'openLogs'})},
      async pickTool(name:string){return '/opt/bin/'+name},async checkTool(_name:string,path:string){return path.startsWith('/opt/bin/')},
      async saveRecovery(value:any){calls.push({action:'saveRecovery',value});const key=JSON.stringify([value.connectionId,value.database,value.entity,value.kind]);const all=JSON.parse(localStorage.getItem('mock.recovery')||'{}');all[key]=value;localStorage.setItem('mock.recovery',JSON.stringify(all))},
      async loadRecovery(value:any){const key=JSON.stringify([value.connectionId,value.database,value.entity,value.kind]);return JSON.parse(localStorage.getItem('mock.recovery')||'{}')[key]||null},
      async deleteRecovery(value:any){const key=JSON.stringify([value.connectionId,value.database,value.entity,value.kind]);const all=JSON.parse(localStorage.getItem('mock.recovery')||'{}');delete all[key];localStorage.setItem('mock.recovery',JSON.stringify(all));calls.push({action:'deleteRecovery'})},
      async clearRecovery(){localStorage.removeItem('mock.recovery')},
      async getSystemLanguage() { return navigator.language },
      async setLocale(locale: string) { calls.push({ action: 'setLocale', locale }) },
      async listConnections() { return configs },
      async updateConnectionAppearance(id: string, patch: { color?: string | null; group?: string | null }) { calls.push({ action: 'appearance', id, patch }); const item = configs.find(value => value.id === id)!; if ('color' in patch) (item as any).color = patch.color || undefined; if ('group' in patch) (item as any).group = patch.group || undefined; return { ...item } },
      async saveConnection(config: any, clearSecrets: string[]) { calls.push({ action: 'saveConnection', config, clearSecrets }); return { ...config, id: config.id || 'new' } },
      async editConnection(id: string) { return { config: { ...configs.find(value => value.id === id), password: '', ssh: { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }, tls: { enabled: false } }, secretFields: ['password'] } },
      async deleteConnection(id: string) { calls.push({ action: 'deleteConnection', id }) },
      async trustHostKey() {},
      async connectSaved(id: string) { const config = configs.find(value => value.id === id)!; sessions[id] = { ...config, id, connectionId: id, displayHost: config.host, writable: false, transaction: false }; return sessions[id] },
      async connectTemporary(config: any) { return { ...config, id: 'temporary', writable: false, transaction: false, displayHost: config.host } },
      async testConnection(config: any, clearSecrets: string[]) { calls.push({ action: 'testConnection', config, clearSecrets }); return '连接成功' },
      async pickConnectionFile(kind: string) { calls.push({ action: 'pickConnectionFile', kind }); return '/test/client.pem' },
      async disconnect(id: string) { calls.push({ action: 'disconnect', id }) },
      async roots(id: string) { return [{ id: id + '-db', label: id === 'redis' ? 'DB 0' : id === 'sql2' ? 'other' : 'app', kind: id === 'redis' ? 'keyspace' : 'database', database: id === 'sql2' ? 'other' : 'app' },...(additionalDbs[id]||[]).map(database=>({id:id+'-'+database,label:database,kind:'database',database}))] },
      async children(id: string, database: string, category?: string) {
        if(id==='ch')return [{id:database+'-events',label:'events',database,entity:'events',kind:'table',metrics:[{label:'存储引擎',value:'MergeTree'},{label:'记录数（估算）',value:'10'}]}]
        if(id!=='mongo')return [{ id: database + '-users', label: 'users', database, entity: 'users', kind: 'table' }]
        if(!category)return [['collections','集合'],['views','视图'],['functions','函数'],['indexes','索引'],['pipelines','聚合管道'],['gridfs','GridFS 存储桶'],['queries','查询']].map(([key,label])=>({id:database+'-'+key,label,database,kind:'mongo-category',category:key}))
        if(category==='collections')return [{id:database+'-users',label:'users',database,entity:'users',kind:'collection',metrics:[{label:'文档数',value:'10'},{label:'数据大小',value:'2048',format:'bytes'}]},...((window as any).__dbexCatalogFixture?[{id:database+'-audit',label:'audit',database,entity:'audit',kind:'collection',metrics:[{label:'文档数',value:'2'},{label:'数据大小',value:'100',format:'bytes'}]}]:[])]
        if(category==='views')return [{id:database+'-users-view',label:'users_view',database,entity:'users_view',kind:'view',readOnly:true}]
        if(category==='indexes')return [{id:database+'-users-indexes',label:'users',database,entity:'users',kind:'mongo-indexes'}]
        if(category==='gridfs')return [{id:database+'-fs',label:'fs',database,entity:'fs.files',kind:'gridfs-bucket',readOnly:true}]
        if(category==='functions')return [{id:database+'-system.js',label:'system.js',database,entity:'system.js',kind:'mongo-function',readOnly:true}]
        return []
      },
      async execute(id: string, op: any) {
        calls.push({ sessionId: id, ...op })
        if(op.action==='clickhouse.browse'||op.action==='clickhouse.query')return {...grid([{id:'18446744073709551615',amount:'12345678901234567890.12345678'}]),columnTypes:['UInt64','Decimal(38,8)'],rawRows:[{id:'18446744073709551615',amount:'12345678901234567890.12345678'}],queryId:'fixture-id'}
        if(op.action==='clickhouse.structure')return grid([{name:'id',type:'UInt64'}])
        if(op.action==='clickhouse.inspect')return {columns:[],rows:[],inspection:{kind:'table',metrics:[{label:'存储引擎',value:'MergeTree'}],definition:'CREATE TABLE events (id UInt64) ENGINE=MergeTree ORDER BY id'}}
        if(op.action==='clickhouse.insert')return {columns:[],rows:[],affectedRows:1,message:'操作已完成'}

        if(op.action==='mongo.createDatabase'||op.action==='mysql.createDatabase'){additionalDbs[id]=[...(additionalDbs[id]||[]),op.database];return {columns:[],rows:[],message:'数据库已创建'}}
        if(op.action==='mongo.dropDatabase'||op.action==='mysql.dropDatabase'){additionalDbs[id]=(additionalDbs[id]||[]).filter(name=>name!==op.database);return {columns:[],rows:[],message:'数据库已删除'}}
        if (op.action === 'mysql.structure') return { ...grid([{ name: 'id', type: 'int', key: 'PRI' }, { name: 'name', type: 'varchar', key: '' }]), primaryKeys: ['id'] }
        if (op.action === 'mysql.browse' && op.countOnly) return { columns: [], rows: [], totalRows: '501', countLimited: false }
        if (op.action === 'mongo.count') return { columns: [], rows: [], totalRows: '401', countLimited: false }
        if (op.action === 'mysql.query' || op.action === 'mysql.browse') {
          if (op.sql?.includes('slow_query')) await new Promise(resolve => setTimeout(resolve, 400))
          const values = (window as any).__dbexLargeGrid ? Array.from({ length: 500 }, (_, index) => ({ id: String(index + 1), name: 'User ' + (index + 1), email: 'user' + (index + 1) + '@example.test' })) : id === 'sql2' ? [{ id: '2', name: 'Grace', email: 'grace@example.test' }] : rows
          return { ...grid(values), rawRows: values, columnTypes: ['BIGINT','VARCHAR','VARCHAR'], nullCells: values.map(() => []), durationMs: 4, transaction: false, nextOffset: op.action === 'mysql.browse' && (op.offset || 0) < 500 ? (op.offset || 0) + op.limit : undefined }
        }
        if(op.action==='mysql.updateBatch'||op.action==='mongo.replaceBatch')return {columns:[],rows:[],affectedRows:op.edits.length,gridBatch:{total:op.edits.length,completed:op.edits.length,atomic:op.action==='mysql.updateBatch'}}
        if (op.action === 'mysql.begin') return { columns: [], rows: [], transaction: true }
        if (op.action === 'mysql.commit' || op.action === 'mysql.rollback') return { columns: [], rows: [], transaction: false }
        if (op.action === 'mongo.find' || op.action === 'mongo.aggregate') return { columns: ['_id', 'name', 'createdAt', 'score', 'nullable', 'nested'], rows: [{ _id: '64b000000000000000000001', name: 'Ada', createdAt: 'date', score: '7', nullable: 'NULL', nested: '{...}' }, { _id: '64b000000000000000000002', name: 'Grace', score: '7', nullable: 'NULL' }, { _id: '64b000000000000000000003', name: 'Lin', score: '7' }], documents: [document, secondDocument, thirdDocument], bsonTypes: mongoMetadata, durationMs: 3, nextOffset: op.action === 'mongo.find' && (op.offset || 0) < 400 ? (op.offset || 0) + op.limit : undefined }
        if (op.action === 'mysql.inspect') return { columns: [], rows: [], inspection: { kind: 'table', metrics: [{ label: '存储引擎', value: 'InnoDB' }, { label: '记录数（估算）', value: '1234', format: 'estimate' }, { label: '数据大小', value: '32768', format: 'bytes' }], definition: 'CREATE TABLE users (id BIGINT PRIMARY KEY, name VARCHAR(255));' } }
        if (op.action === 'mongo.inspect') return { columns: [], rows: [], inspection: { kind: 'collection', metrics: [{ label: '文档数', value: '3' }, { label: '已固定', value: 'false', format: 'boolean' }, { label: '存储大小', value: '32768', format: 'bytes' }], definition: 'db.getSiblingDB("app").createCollection("users");\n\ndb.getSiblingDB("app").getCollection("users").createIndex({ "score": Int32("1") }, { "name": "score_1" });' } }
        if (op.action === 'redis.inspect') return { columns: [], rows: [], inspection: { kind: 'key', metrics: [{ label: '类型', value: 'string' }, { label: 'TTL（秒）', value: '-1' }, { label: '内存占用', value: '72', format: 'bytes' }], definition: JSON.stringify(['TYPE', op.key]) + '\n' + JSON.stringify(['TTL', op.key]), definitionNote: 'Redis 没有 DDL；以下是只读 Key 检查命令，不是数据备份。' } }
        if (op.action === 'mongo.indexes') return grid([{ name: '_id_', key: '{"_id":1}' }])
        if (op.action === 'redis.nodes') return grid([{ id: '127.0.0.1:6379', host: '127.0.0.1', port: '6379', role: 'master' }, { id: '127.0.0.2:6379', host: '127.0.0.2', port: '6379', role: 'master' }])
        if (op.action === 'redis.scan') return { ...grid([{ key: 'profile:1', type: 'string', ttl: '-1' }]), redisRowTypes: ['string'], nextCursor: undefined }
        if (op.action === 'redis.get') return { ...grid([{ value: 'hello' }]), value: 'hello', redisType: 'string', ttl: -1, length: 5, truncated: false }
        return { columns: [], rows: [], affectedRows: 1, message: '操作已完成' }
      },
      async cancel(id: string) { calls.push({ action: 'cancel', id }) },
      async copyText(value: string) { calls.push({ action: 'copyText', value }) },
      async validateMongoDocument(document: string, original?: string) { calls.push({ action: 'validateMongoDocument', document, original }) },
      async setWriteAccess(id: string, writable: boolean) { sessions[id] = { ...sessions[id], writable }; calls.push({ action: 'writeAccess', id, writable }); return sessions[id] },
      async listSavedQueries(id:string,database:string,mode:string) {
        return JSON.parse(localStorage.getItem('mock.query-objects')||'[]').filter((x:any)=>x.connectionId===id&&x.database===database&&x.mode===mode).map((x:any)=>({...x,bytes:new TextEncoder().encode(x.text+(x.parameters||'')).length}))
      },
      async getSavedQuery(id:string,database:string,queryId:string){
        const item=JSON.parse(localStorage.getItem('mock.query-objects')||'[]').find((x:any)=>x.id===queryId&&x.connectionId===id&&x.database===database)
        if(!item)throw new Error('missing query');return item
      },
      async saveQueryObject(id:string,database:string,input:any){
        const all=JSON.parse(localStorage.getItem('mock.query-objects')||'[]')
        const old=all.find((x:any)=>x.id===input.id&&x.connectionId===id&&x.database===database)
        if(input.id&&(!old||old.revision!==input.revision))throw new Error('stale query')
        const now=new Date().toISOString(),item={...input.draft,id:old?.id||crypto.randomUUID(),connectionId:id,kind:sessions[id].kind,database,createdAt:old?.createdAt||now,updatedAt:now,revision:crypto.randomUUID()}
        localStorage.setItem('mock.query-objects',JSON.stringify([item,...all.filter((x:any)=>x.id!==item.id)]))
        calls.push({action:'saveQueryObject',item});return item
      },
      async copySavedQuery(id:string,database:string,queryId:string){
        const item=await (window as any).dbex.getSavedQuery(id,database,queryId)
        const {name,mode,text,parameters,entity}=item
        return (window as any).dbex.saveQueryObject(id,database,{draft:{name:name+' (2)',mode,text,parameters,entity}})
      },
      async deleteSavedQuery(id:string,database:string,queryId:string,revision:string){
        const item=await (window as any).dbex.getSavedQuery(id,database,queryId)
        if(item.revision!==revision)throw new Error('stale query')
        const all=JSON.parse(localStorage.getItem('mock.query-objects')||'[]')
        localStorage.setItem('mock.query-objects',JSON.stringify(all.filter((x:any)=>x.id!==queryId)))
      },
      async importSavedQuery(id:string,database:string,mode:string){
        return (window as any).dbex.saveQueryObject(id,database,{draft:{name:'Imported query',mode,text:mode==='sql'?'SELECT ?':mode==='mongo-find'?JSON.stringify({filter:'{}',projection:'{}',sort:'{}'}):'[]',parameters:'[42]'}})
      },
      async exportSavedQuery(id:string,database:string,queryId:string,format:string){const item=await (window as any).dbex.getSavedQuery(id,database,queryId);calls.push({action:'exportSavedQuery',item,format});return true},
      async listSnippets() { return [...savedObjects] }, async saveSnippet(value: any) { const item={...value,id:value.id||String(savedObjects.length+1),updatedAt:new Date().toISOString()}; const index=savedObjects.findIndex(x=>x.id===item.id); if(index>=0)savedObjects[index]=item;else savedObjects.push(item);return item }, async deleteSnippet(id:string) { const index=savedObjects.findIndex(x=>x.id===id);if(index>=0)savedObjects.splice(index,1) },
      async importFile() { return { name: 'data.csv', format: 'csv', text: 'name,email\nEve,eve@example.test' } }, async exportFile(name: string, content: string, format: string) { calls.push({ action: 'export', name, content, format }); return true },
      async importConnections() { calls.push({ action: 'importConnections' }); return 2 }, async exportConnections(id?: string) { calls.push({ action: 'exportConnections', id }); return true },
      async importSshConfig() { return { hosts: [{ name: 'bastion', ssh: { enabled: true, host: 'jump.example.test', port: 22, username: 'dev', authMode: 'agent' } }], warnings: ['未执行 ProxyCommand'] } },
    }
  })
}
async function connect(page: Page, name: string) {
  await page.locator('.connection-item').filter({ hasText: name }).getByTitle('连接', { exact: true }).click()
}
async function openUsers(page: Page, database = 'app') {
  const tree=page.locator('.resource-list[data-active-session="true"]')
  await tree.locator('.resource-node').filter({ hasText: database }).first().click()
  const folders=tree.locator('.resource-node[data-object-category="collections"]')
  await expect(tree.locator('.resource-node[data-object-kind="table"], .resource-node[data-object-category="collections"]').first()).toBeVisible()
  if(await folders.count()) await folders.click()
  await tree.locator('.child-node').filter({ hasText: 'users' }).click()
  await expect(page.locator('.workbench:visible .data-table tbody tr').first()).toContainText(database === 'other' ? 'Grace' : 'Ada')
}
async function replaceEditor(page: Page, selector: string, text: string) {
  const editor = page.locator(selector).last()
  // Focus Monaco's actual input surface (textarea or native EditContext), rather
  // than a coordinate which may land on a view overlay while it is rendering.
  const input = editor.getByRole('textbox')
  await input.focus()
  await expect(input).toBeFocused()
  await input.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  // Assert deletion settled before inserting: Monaco may otherwise leave the
  // trailing brace of the previous JSON document under CI scheduling pressure.
  await expect.poll(async () => (await editor.locator('.view-lines').textContent() || '').trim()).toBe('')
  await page.keyboard.insertText(text)
  // The tests replace short, single-line fixtures. Verify the real rendered
  // document has changed before clicking Save; never set editor/Vue state.
  await expect.poll(async () => (await editor.locator('.view-lines').textContent() || '').replace(/\u00a0/g, ' ')).toBe(text)
}
test.beforeEach(async ({ page }) => { await installBridge(page); await page.goto('/') })

test('connection editing protects stored credentials and exposes advanced transport settings', async ({ page }) => {
  await page.locator('.connection-item').filter({ hasText: 'MySQL Local' }).click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '编辑连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '编辑数据库连接' })).toBeVisible()
  await expect(page.getByPlaceholder('已保存 · 留空保留')).toHaveValue('')
  await page.getByRole('button', { name: 'SSH / 多跳', exact: true }).click()
  await page.getByRole('button', { name: '导入 SSH config', exact: true }).click()
  await page.getByLabel('导入主机').selectOption('bastion')
  await expect(page.getByLabel('SSH 服务器', { exact: true })).toHaveValue('jump.example.test')
  await page.getByRole('button', { name: '＋ 添加前置跳板机（最多 3 级）' }).click()
  await expect(page.getByRole('heading', { name: '前置跳板机 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '代理', exact: true }).click()
  await page.getByLabel('启用网络代理').check()
  await page.getByLabel('代理协议').selectOption('http-connect')
  await expect(page.getByLabel('代理主机')).toBeVisible()
  await page.getByRole('button', { name: 'TLS / SSL', exact: true }).click()
  await page.getByLabel('启用 TLS / SSL').check()
  await expect(page.getByLabel('证书主机名 / SNI')).toBeVisible()
})

test('MySQL query, guarded row edits, transactions, and CSV import use the typed bridge', async ({ page }) => {
  await connect(page, 'MySQL Local'); await openUsers(page)
  await expect(page.getByRole('button', { name: '新增', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'SQL 编辑器', exact: true }).click()
  await replaceEditor(page, '.query-editor .monaco-editor', 'SELECT ? AS answer;')
  await page.getByLabel('SQL 参数 JSON 数组').fill('[42]')
  await page.getByRole('button', { name: /运行选中/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'mysql.query' && call.parameters?.[0] === 42))).toBe(true)
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await page.getByRole('button', { name: '开始事务', exact: true }).click()
  await expect(page.locator('.workbench:visible').getByText('事务进行中', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '回滚', exact: true }).click()
  await page.getByRole('button', { name: '数据', exact: true }).click()
  await page.locator('.workbench:visible .data-table tbody tr').first().click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await replaceEditor(page, '.document-editor .monaco-editor', '{"id":"1","name":"Ada Updated","email":"ada@example.test"}')
  await page.getByRole('button', { name: '审阅并保存', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'mysql.update' && call.key.id === '1' && call.original.name === 'Ada' && call.changes.name === 'Ada Updated' && call.confirmed))).toBe(true)
  await page.getByRole('button', { name: '导入 CSV / JSON', exact: true }).click()
  await expect(page.getByRole('heading', { name: '导入预览' })).toBeVisible()
  await page.getByRole('button', { name: '审阅并保存', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'mysql.import' && call.rows[0].name === 'Eve'))).toBe(true)
})

test('MongoDB right-click document editor uses typed syntax, validates locally and preserves canonical EJSON', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  const row = page.locator('.workbench:visible .data-table tbody tr').first()
  await row.click({ button: 'right' })
  await expect(page.locator('.mongo-row-menu').getByRole('button', { name: '编辑文档…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await row.click({ button: 'right' })
  await page.locator('.mongo-row-menu').getByRole('button', { name: '编辑文档…' }).click()
  const editor = page.getByRole('dialog', { name: '编辑文档' })
  await expect(editor.locator('.document-editor')).toContainText('ObjectId')
  await expect(editor.locator('.document-editor')).toContainText('Int32')
  await expect(editor.locator('.document-editor')).toContainText('Long')
  await replaceEditor(page, '.document-editor .monaco-editor', '{"_id":ObjectId("64b000000000000000000001"),"name":"Ada Updated","createdAt":ISODate("2023-11-14T22:13:20.000Z"),"score":Int32("7"),"long":Long("9223372036854775807")}')
  await editor.getByRole('button', { name: '验证', exact: true }).click()
  await expect(editor.getByRole('status')).toHaveText('文档验证通过')
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'validateMongoDocument' && JSON.parse(call.document).long.$numberLong === '9223372036854775807'))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((call: any) => call.action === 'mongo.replace').length)).toBe(0)
  await editor.getByRole('button', { name: '更新', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'mongo.replace' && call.original.includes('$oid') && call.document.includes('$date') && JSON.parse(call.document).name === 'Ada Updated' && call.confirmed))).toBe(true)
  await page.getByRole('button', { name: '查询条件', exact: true }).click()
  await page.getByRole('button', { name: '文本', exact: true }).click()
  await page.getByLabel('Projection', { exact: true }).fill('{"name":1}')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await row.click({ button: 'right' })
  await expect(page.locator('.mongo-row-menu').getByRole('button', { name: '编辑文档…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
})

test('Redis uses SCAN and compare-and-set string updates with explicit write permission', async ({ page }) => {
  await connect(page, 'Redis Local')
  await expect(page.getByText('profile:1', { exact: true })).toBeVisible()
  await page.getByLabel('Redis Key 匹配模式').fill('profile:*')
  await page.getByLabel('Cluster 节点', { exact: true }).selectOption('127.0.0.2:6379')
  await page.getByRole('button', { name: '扫描 Key', exact: true }).click()
  await page.getByText('profile:1', { exact: true }).dblclick()
  await expect(page.getByRole('button', { name: '保存 String', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await replaceEditor(page, '.redis-value-editor .monaco-editor', 'updated value')
  await page.getByRole('button', { name: '保存 String', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'redis.set' && call.expected === 'hello' && call.value === 'updated value' && call.confirmed))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'redis.scan' && call.pattern === 'profile:*' && call.node === '127.0.0.2:6379'))).toBe(true)
})

test('switching sessions keeps pending results and editor state bound to their session', async ({ page }) => {
  await connect(page, 'MySQL Local'); await openUsers(page)
  await page.getByRole('button', { name: 'SQL 编辑器', exact: true }).click()
  await replaceEditor(page, '.query-editor .monaco-editor', 'SELECT slow_query FROM users;')
  await page.getByRole('button', { name: /运行选中/ }).click()
  await connect(page, 'MySQL Other'); await openUsers(page, 'other')
  await expect(page.locator('.workbench:visible .data-table')).toContainText('Grace')
  await page.waitForTimeout(450)
  await expect(page.locator('.workbench:visible .data-table')).not.toContainText('Ada')
  await page.locator('.session-tab').filter({ hasText: 'MySQL Local' }).locator('.tab').click()
  await expect(page.locator('.workbench:visible .query-editor')).toContainText('slow_query')
  await expect(page.locator('.workbench:visible .data-table')).toContainText('Ada')
})


test('large result grids render a bounded row window and retain the original row identity', async ({ page }) => {
  await page.evaluate(() => { (window as any).__dbexLargeGrid = true })
  await connect(page, 'MySQL Local')
  await page.locator('.resource-node').filter({ hasText: 'app' }).first().click()
  await page.locator('.child-node').filter({ hasText: 'users' }).click()
  const grid = page.locator('.workbench:visible .grid-scroll')
  const rows = grid.locator('tr[data-row-index]')
  await expect(rows.first()).toContainText('User 1')
  expect(await rows.count()).toBeLessThan(80)
  await grid.evaluate(element => { element.scrollTop = 34 * 440 })
  const target = grid.locator('tr[data-row-index="450"]')
  await expect(target).toBeVisible()
  await target.click()
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('.document-editor')).toContainText('User 451')
  await replaceEditor(page, '.document-editor .monaco-editor', '{"id":"451","name":"Edited 451","email":"user451@example.test"}')
  await page.getByRole('button', { name: '审阅并保存', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const updates = (window as any).__dbexCalls.filter((call: any) => call.action === 'mysql.update')
    // These are generated test records only. A failure prints the actual bridge
    // payload or the visible validation error instead of an uninformative false.
    return updates[updates.length - 1] || {
      action: 'missing mysql.update',
      errors: Array.from(document.querySelectorAll('[role="alert"]'), element => element.textContent),
    }
  })).toMatchObject({
    sessionId: 'sql', action: 'mysql.update', confirmed: true,
    key: { id: '451' }, original: { id: '451', name: 'User 451' }, changes: { name: 'Edited 451' },
  })
})


test('new connection chooses the database before opening its own general form', async ({ page }) => {
  await page.getByRole('button', { name: '＋ 新建连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择数据库类型' })).toBeVisible()
  await page.getByRole('button', { name: 'MySQL', exact: true }).click()
  await expect(page.getByLabel('端口', { exact: true })).toHaveValue('3306')
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('root')
  await expect(page.getByLabel('连接超时（毫秒）')).toHaveCount(0)
  await page.getByRole('button', { name: '高级设置', exact: true }).click()
  await expect(page.getByLabel('连接超时（毫秒）')).toHaveValue('12000')
  await page.getByRole('button', { name: '基本设置', exact: true }).click()
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: 'Redis', exact: true }).click()
  await expect(page.getByLabel('端口', { exact: true })).toHaveValue('6379')
  await expect(page.getByLabel('认证方式')).toHaveValue('none')
  await page.getByLabel('Redis 拓扑').selectOption('sentinel')
  await expect(page.getByLabel('节点 1 端口')).toHaveValue('26379')
  await expect(page.getByLabel('Master 名称')).toBeVisible()
  await page.getByLabel('认证方式').selectOption('password')
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'TLS / SSL', exact: true }).click()
  await page.getByLabel('启用 TLS / SSL').check()
  await page.getByRole('button', { name: '浏览… CA 证书路径', exact: true }).click()
  await expect(page.getByLabel('CA 证书路径', { exact: true })).toHaveValue('/test/client.pem')
})

test('MongoDB topology, authentication and independent URI entry preserve active inputs', async ({ page }) => {
  await page.getByRole('button', { name: '＋ 新建连接', exact: true }).click()
  await page.getByRole('button', { name: 'MongoDB', exact: true }).click()
  await expect(page.getByLabel('端口', { exact: true })).toHaveValue('27017')
  await expect(page.getByLabel('连接拓扑')).toHaveValue('auto')
  await page.getByLabel('连接拓扑').selectOption('discover')
  await page.getByRole('button', { name: '＋ 添加节点', exact: true }).click()
  await page.getByLabel('节点 1 主机').fill('seed.example.test')
  await expect(page.getByText('使用种子节点连接，不再使用单独的主机和端口。')).toBeVisible()
  await page.getByLabel('认证方式').selectOption('password')
  await expect(page.getByLabel('认证库 (authSource)')).toHaveValue('admin')
  await page.getByLabel('用户名', { exact: true }).fill('field-user')
  await page.getByLabel('密码', { exact: true }).fill('field-password')
  await page.getByRole('button', { name: 'MongoDB URI', exact: true }).click()
  await page.getByLabel('MongoDB URI（优先于主机设置）').fill('mongodb://uri-user:uri-secret@db.example.test:27017/admin?directConnection=true')
  await expect(page.getByText('db.example.test:27017', { exact: true })).toBeVisible()
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const call = (window as any).__dbexCalls.filter((x: any) => x.action === 'testConnection').at(-1)
    return call && { host: call.config.host, topology: call.config.mongoTopology, nodes: call.config.nodes.length, username: call.config.username, uri: call.config.uri }
  })).toEqual({ host: '', topology: 'auto', nodes: 0, username: '', uri: 'mongodb://uri-user:uri-secret@db.example.test:27017/admin?directConnection=true' })
  await page.getByRole('button', { name: '主机和端口', exact: true }).click()
  await expect(page.getByLabel('节点 1 主机')).toHaveValue('seed.example.test')
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('field-user')
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: '使用 MongoDB URI', exact: true }).click()
  await expect(page.getByLabel('MongoDB URI（优先于主机设置）')).toBeVisible()
})

test('connection backups export one or all profiles and import without a key prompt', async ({ page }) => {
  await page.getByRole('button', { name: '导出连接', exact: true }).click()
  await expect(page.getByText(/连接备份已导出（包含加密凭据）/)).toBeVisible()
  await page.locator('.connection-item').first().click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '导出此连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((call: any) => call.action === 'exportConnections').map((call: any) => Boolean(call.id)))).toEqual([false, true])
  await page.getByRole('button', { name: '导入连接', exact: true }).click()
  await expect(page.getByText('已导入 2 个连接配置')).toBeVisible()
})


async function openLanguageSettings(page:Page,label:string){
  await page.locator('.preferences-button').click()
  const dialog=page.locator('.preferences-dialog')
  const select=dialog.getByRole('combobox',{name:label,exact:true})
  await expect(select).toBeVisible()
  return {dialog,select}
}
async function chooseLanguage(page:Page,label:string,language:string,expected:string){
  const {dialog,select}=await openLanguageSettings(page,label)
  await select.selectOption(language)
  await dialog.locator('[data-action="save-preferences"]').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('lang',expected)
}
test('English interface can switch live, persists and preserves connection identity', async ({ page }) => {
  await chooseLanguage(page,'语言','en','en')
  await expect(page.getByRole('button', { name: '+ New connection', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import connections', exact: true })).toBeVisible()
  await expect(page.locator('.connection-item').filter({ hasText: 'MySQL Local' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'setLocale' && call.locale === 'en'))).toBe(true)
  await page.getByRole('button', { name: '+ New connection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Select database type' })).toBeVisible()
  await page.getByRole('button', { name: 'MySQL', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create database connection' })).toBeVisible()
  await expect(page.getByLabel('Connection name', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'SSH / jump hosts', exact: true }).click()
  await expect(page.getByLabel('Enable SSH tunnel')).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.reload()
  {const {dialog,select}=await openLanguageSettings(page,'Language');await expect(select).toHaveValue('en');await dialog.getByRole('button',{name:'Cancel',exact:true}).click()}
  await page.locator('.connection-item').filter({ hasText: 'MySQL Local' }).getByTitle('Connect', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'SQL editor', exact: true })).toBeVisible()
  await chooseLanguage(page,'Language','zh-CN','zh-CN')
  await expect(page.getByRole('button', { name: 'SQL 编辑器', exact: true })).toBeVisible()
})


test.describe('system language default', () => {
  test.use({ locale: 'de-DE' })
  test('first launch follows system; selecting a language overrides it, system resets it', async ({ page }) => {
    const {dialog,select}=await openLanguageSettings(page,'Sprache');await expect(select).toHaveValue('system')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await select.selectOption('ja');await dialog.locator('[data-action="save-preferences"]').click();await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '＋ 新規接続', exact: true })).toBeVisible()
    await page.reload()
    {const reopened=await openLanguageSettings(page,'言語');await expect(reopened.select).toHaveValue('ja');await reopened.select.selectOption('system');await reopened.dialog.locator('[data-action="save-preferences"]').click();await expect(reopened.dialog).toHaveCount(0)}
    await expect(page.getByRole('button', { name: '+ Neue Verbindung', exact: true })).toBeVisible()
  })
})
test('Arabic direction and all 14 language options are available', async ({ page }) => {
  const {dialog,select}=await openLanguageSettings(page,'语言')
  await expect(select.locator('option')).toHaveCount(15)
  await select.selectOption('ar');await dialog.locator('[data-action="save-preferences"]').click();await expect(dialog).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('button', { name: '+ اتصال جديد', exact: true })).toBeVisible()
  await expect(page.locator('.connection-item').filter({ hasText: 'MySQL Local' })).toBeVisible()
  await chooseLanguage(page,'اللغة','zh-TW','zh-TW')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expect(page.getByRole('button', { name: '＋ 新建連線', exact: true })).toBeVisible()
})


test('connection context colors, custom colors, grouping and live tab highlighting', async ({ page }) => {
  const row = () => page.locator('.connection-item').filter({ hasText: 'MySQL Local' })
  await row().click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '红色', exact: true }).click()
  await expect(row()).toHaveAttribute('data-color', '#e05252')
  await connect(page, 'MySQL Local')
  await expect(page.locator('.session-tab').filter({ hasText: 'MySQL Local' })).toHaveAttribute('data-color', '#e05252')
  await row().getByTitle('连接菜单').click()
  await page.locator('.connection-context-menu').getByLabel('自定义颜色').fill('#123abc')
  await page.locator('.connection-context-menu').getByRole('button', { name: '应用', exact: true }).click()
  await expect(row()).toHaveAttribute('data-color', '#123abc')
  await expect(page.locator('.session-tab').filter({ hasText: 'MySQL Local' })).toHaveAttribute('data-color', '#123abc')
  await row().click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '移动到分组' }).click()
  await page.getByLabel('分组名称', { exact: true }).fill('Project Alpha')
  await page.getByRole('dialog', { name: '移动到分组' }).getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.locator('.connection-group[data-group="Project Alpha"]')).toBeVisible()
  await expect(row()).toHaveClass(/in-group/)
  await page.locator('.connection-group[data-group="Project Alpha"] button').click()
  await expect(row()).toHaveCount(0)
  await page.locator('.connection-group[data-group="Project Alpha"] button').click()
  await expect(row()).toBeVisible()
  await row().click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '无颜色', exact: true }).click()
  await expect(row()).toHaveAttribute('data-color', '')
  await expect(page.locator('.session-tab').filter({ hasText: 'MySQL Local' })).toHaveAttribute('data-color', '')
  await row().click({ button: 'right' })
  await page.locator('.connection-context-menu').getByRole('button', { name: '移动到分组' }).click()
  await page.getByRole('dialog', { name: '移动到分组' }).getByRole('button', { name: '移出分组', exact: true }).click()
  await expect(page.locator('.connection-group[data-group="Project Alpha"]')).toHaveCount(0)
  await expect(row()).not.toHaveClass(/in-group/)
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c: any) => c.action === 'appearance').map((c: any) => c.patch))).toEqual([{ color: '#e05252' }, { color: '#123abc' }, { group: 'Project Alpha' }, { color: null }, { group: null }])
})


test('MongoDB uses per-value BSON colors, nested document types and saved custom preferences', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  const grid = page.locator('.workbench:visible .data-table').first()
  await expect(grid.locator('tr[data-row-index="0"] [data-bson-type="Int32"]')).toHaveText('7')
  await expect(grid.locator('tr[data-row-index="0"] [data-bson-type="ObjectId"]')).toHaveText('64b000000000000000000001')
  await expect(grid.locator('tr[data-row-index="0"] [data-bson-type="Document"]')).toHaveText('(Document) 1 个字段')
  await expect(grid.locator('tr[data-row-index="0"] [data-bson-type="Date"]')).toHaveText('2023-11-14 22:13:20.000 UTC')
  await expect(grid.locator('.bson-type-label')).toHaveCount(0)
  await expect(page.getByLabel('Projection', { exact: true })).toHaveCount(0)
  await expect(page.locator('.mongo-query-summary')).toContainText('.limit(200)')
  await expect(grid.locator('tr[data-row-index="1"] [data-bson-type="String"]').filter({ hasText: '7' })).toBeVisible()
  await expect(grid.locator('tr[data-row-index="2"] [data-bson-type="Double"]')).toBeVisible()
  await expect(grid.locator('tr[data-row-index="0"] [data-bson-type="Null"]')).toContainText('NULL')
  await expect(grid.locator('tr[data-row-index="2"] [data-bson-type="Missing"]').first()).toBeVisible()
  await grid.locator('tr[data-row-index="0"]').dblclick()
  const viewer = page.getByRole('dialog', { name: '查看文档' })
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: 'nested', exact: true }).click()
  await viewer.getByRole('button', { name: 'values', exact: true }).click()
  await expect(viewer.locator('[data-bson-type="Int64"]')).toContainText('99')
  await viewer.getByRole('button', { name: '原始 EJSON', exact: true }).click()
  await expect(viewer.locator('.bson-raw-document')).toContainText('$numberLong')
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: 'BSON 类型配色', exact: true }).click()
  const settings = page.locator('.object-inspector:visible')
  await settings.locator('.bson-type-option').filter({ hasText: 'Int32' }).click()
  await settings.getByLabel('HEX', { exact: true }).fill('#123abc')
  await settings.getByRole('button', { name: '应用', exact: true }).click()
  await settings.getByRole('button', { name: '保存', exact: true }).click()
  await expect(grid.locator('[data-bson-type="Int32"]')).toHaveAttribute('data-bson-color', '#123abc')
  await page.reload()
  await connect(page, 'Mongo Local'); await openUsers(page)
  await expect(page.locator('.workbench:visible [data-bson-type="Int32"]')).toHaveAttribute('data-bson-color', '#123abc')
  await page.getByRole('button', { name: 'BSON 类型配色', exact: true }).click()
  await page.locator('.object-inspector:visible').getByRole('button', { name: '恢复全部默认颜色' }).click()
  await page.locator('.object-inspector:visible').getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.workbench:visible [data-bson-type="Int32"]')).toHaveAttribute('data-bson-color', '#4da96b')
})

test('connection settings use optional custom groups and colors, not fixed environments', async ({ page }) => {
  await page.getByRole('button', { name: '＋ 新建连接', exact: true }).click()
  await page.getByRole('button', { name: 'MySQL', exact: true }).click()
  await page.getByLabel('连接名称', { exact: true }).fill('Region 100')
  await page.getByRole('button', { name: '高级设置', exact: true }).click()
  await expect(page.getByLabel('环境', { exact: true })).toHaveCount(0)
  await page.getByLabel('分组名称', { exact: true }).fill('Project A / Region 100')
  await page.getByRole('button', { name: '蓝色', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const call = (window as any).__dbexCalls.filter((item: any) => item.action === 'saveConnection').at(-1)
    if (!call) return null
    return { environment: Object.hasOwn(call.config, 'environment'), group: call.config.group, color: call.config.color }
  })).toEqual({ environment: false, group: 'Project A / Region 100', color: '#4b88d9' })
  await expect(page.locator('.env-tag')).toHaveCount(0)
  await connect(page, 'MySQL Local')
  await expect(page.locator('.workbench:visible .workbench-header .eyebrow')).toHaveCount(0)
})

test('MongoDB row and cell menu copies exact values, prepares duplicate and field drafts, and filters by value', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  const row = page.locator('.workbench:visible .data-table tbody tr[data-row-index="0"]')
  const cell = row.locator('[data-mongo-field="score"]')
  const menu = page.locator('.mongo-row-menu')
  await cell.click({ button: 'right' })
  await menu.getByRole('button', { name: '复制字段值', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.find((c: any) => c.action === 'copyText')?.value)).toBe('7')
  await cell.click({ button: 'right' })
  await menu.getByRole('button', { name: '复制完整文档', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c: any) => c.action === 'copyText').at(-1)?.value)).toContain('$numberInt')
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await cell.click({ button: 'right' })
  await menu.getByRole('button', { name: '复制为新文档…', exact: true }).click()
  const draft = page.getByRole('dialog', { name: '新增记录' })
  await expect(draft.locator('.document-editor')).toContainText('Int32')
  await expect(draft.locator('.document-editor')).not.toContainText('"_id"')
  await draft.getByRole('button', { name: '取消', exact: true }).click()
  await cell.click({ button: 'right' })
  await menu.getByRole('button', { name: '设为 NULL', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑文档' })
  await expect(edit.locator('.document-editor')).toContainText('null')
  await edit.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c: any) => ['mongo.insert','mongo.replace','mongo.delete'].includes(c.action)).length)).toBe(0)
  await cell.click({ button: 'right' })
  await menu.getByRole('button', { name: '按此值筛选', exact: true }).click()
  await expect(page.getByLabel('Filter', { exact: true })).toHaveValue('{"score":{"$eq":{"$numberInt":"7"}}}')
})

test('object inspector shows real-engine metadata, DDL, copy and independent colors for MySQL', async ({ page }) => {
  await connect(page, 'MySQL Local'); await openUsers(page)
  await page.locator('.workbench:visible').getByRole('button', { name: '对象信息', exact: true }).click()
  const panel = page.locator('.object-inspector:visible')
  await expect(panel.locator('.object-metrics')).toContainText('InnoDB')
  await expect(panel.locator('.object-metrics')).toContainText('32 KiB')
  await panel.getByRole('button', { name: 'DDL', exact: true }).click()
  await expect(panel.locator('.inspector-definition')).toContainText('CREATE TABLE')
  await panel.getByRole('button', { name: '复制语句', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.find((c: any) => c.action === 'copyText')?.value)).toContain('CREATE TABLE')
  await panel.getByRole('button', { name: '导出语句', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.find((c: any) => c.action === 'export')?.name)).toBe('users.sql')
  await panel.getByRole('button', { name: '数据类型配色', exact: true }).click()
  await panel.locator('.bson-type-option').filter({ hasText: /^BIGINT/ }).click()
  await panel.getByLabel('HEX', { exact: true }).fill('#123abc')
  await panel.getByRole('button', { name: '应用', exact: true }).click()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.workbench:visible td[data-value-type="BIGINT"]').first()).toHaveAttribute('data-type-color', '#123abc')
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toHaveCount(0)
})
test('MongoDB object inspection contains collection DDL and Redis inspection identifies keys without fake DDL', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  await page.locator('.workbench:visible').getByRole('button', { name: '对象信息', exact: true }).click()
  const panel = page.locator('.object-inspector:visible')
  await expect(panel.locator('.object-metrics')).toContainText('文档数')
  await panel.getByRole('button', { name: 'DDL', exact: true }).click()
  await expect(panel.locator('.inspector-definition')).toContainText('createCollection')
  await expect(panel.locator('.inspector-definition')).toContainText('createIndex')
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await connect(page, 'Redis Local')
  const row = page.locator('.workbench:visible .redis-key-list tr[data-row-index="0"]')
  await expect(row).toContainText('profile:1')
  await row.click()
  await page.locator('.workbench:visible').getByRole('button', { name: '对象信息', exact: true }).click()
  await expect(panel.locator('.object-metrics')).toContainText('72 B')
  await panel.getByRole('button', { name: '检查命令', exact: true }).click()
  await expect(panel).toContainText('Redis 没有 DDL')
  await expect(panel.locator('.inspector-definition')).toContainText('TYPE')
  await panel.getByRole('button', { name: '数据类型配色', exact: true }).click()
  await panel.getByRole('checkbox', { name: '按类型着色' }).uncheck()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.locator('td[data-value-type="string"]').first()).not.toHaveAttribute('data-type-color', /.+/)
})

test('visual MongoDB filters, sort, page jumps and views preserve the applied query', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  const workbench = page.locator('.workbench:visible')
  await workbench.getByRole('button', { name: '查询条件', exact: true }).click()
  const builder = workbench.locator('.visual-query-builder')
  await builder.getByRole('button', { name: '添加筛选条件', exact: true }).click()
  const rule = builder.locator('.builder-rule').first()
  await rule.getByLabel('字段', { exact: true }).fill('score')
  await rule.getByLabel('类型', { exact: true }).selectOption('number')
  await rule.getByLabel('字段值', { exact: true }).fill('7')
  await builder.getByRole('button', { name: '添加排序条件', exact: true }).click()
  await builder.getByLabel('排序字段', { exact: true }).fill('score')
  await builder.getByLabel('排序方式', { exact: true }).selectOption('-1')
  await builder.getByRole('button', { name: '应用筛选与排序', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c:any) => c.action === 'mongo.find').at(-1)?.filter)).toBe('{"score":{"$eq":{"$numberInt":"7"}}}')
  await workbench.getByRole('button', { name: '文本', exact: true }).click()
  await expect(workbench.getByLabel('Sort', { exact: true })).toHaveValue('{"score":-1}')
  await workbench.getByRole('button', { name: '查询条件', exact: true }).click()
  await workbench.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(workbench.getByLabel('页码', { exact: true })).toHaveValue('2')
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c:any) => c.action === 'mongo.find').at(-1)?.filter)).toBe('{"score":{"$eq":{"$numberInt":"7"}}}')
  await workbench.getByRole('button', { name: '末页', exact: true }).click()
  await expect(workbench.getByLabel('页码', { exact: true })).toHaveValue('3')
  await workbench.getByRole('button', { name: '首页', exact: true }).click()
  await expect(workbench.getByLabel('页码', { exact: true })).toHaveValue('1')
  await workbench.getByRole('button', { name: '记录视图', exact: true }).click()
  await expect(workbench.locator('.browse-record-view')).toContainText('ObjectId')
  await workbench.getByRole('button', { name: '文本视图', exact: true }).click()
  await expect(workbench.locator('.browse-record-view pre')).toContainText('Int32("7")')
  await workbench.getByRole('button', { name: '表格视图', exact: true }).click()
  await expect(workbench.locator('.mongo-grid')).toBeVisible()
})
test('MySQL uses visual filters without constructing user SQL in the renderer', async ({ page }) => {
  await connect(page, 'MySQL Local'); await openUsers(page)
  const workbench = page.locator('.workbench:visible')
  await workbench.getByRole('button', { name: '查询条件', exact: true }).click()
  const builder = workbench.locator('.visual-query-builder')
  await builder.getByRole('button', { name: '添加筛选条件', exact: true }).click()
  await builder.getByLabel('字段', { exact: true }).selectOption('name')
  await builder.getByLabel('比较方式', { exact: true }).selectOption('contains')
  await builder.getByLabel('字段值', { exact: true }).fill("Ada' OR 1=1")
  await builder.getByRole('button', { name: '应用筛选与排序', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c:any) => c.action === 'mysql.browse').at(-1)?.filter.groups[0]?.rules[0]?.value)).toBe("Ada' OR 1=1")
  await workbench.getByRole('button', { name: '查询条件', exact: true }).click()
  await workbench.getByLabel('页码', { exact: true }).fill('3')
  await workbench.getByLabel('页码', { exact: true }).press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.filter((c:any) => c.action === 'mysql.browse').at(-1)?.offset)).toBe(200)
  await workbench.getByRole('button', { name: '记录视图', exact: true }).click()
  await expect(workbench.locator('.browse-record-view')).toContainText('BIGINT')
})

test('advanced MongoDB filter value picker, mixed connectors and disabled rules', async ({ page }) => {
  await connect(page,'Mongo Local'); await openUsers(page)
  const workbench=page.locator('.workbench:visible')
  await workbench.getByRole('button',{name:'查询条件',exact:true}).click()
  const builder=workbench.locator('.visual-query-builder')
  await builder.getByRole('button',{name:'添加筛选条件',exact:true}).click()
  const first=builder.locator('.builder-rule').first()
  await first.getByLabel('字段',{exact:true}).fill('score')
  await first.getByRole('button',{name:'编辑筛选值 1',exact:true}).click()
  const picker=page.getByRole('dialog',{name:'编辑筛选值'})
  await expect(picker).toContainText('来自当前查询页')
  await expect(picker.getByLabel('类型',{exact:true}).locator('option')).toHaveText(['文本','数字','日期时间','对象 ID','自定义'])
  await picker.getByLabel('搜索建议值').fill('7')
  await picker.locator('.filter-suggestion').filter({hasText:'Int32'}).locator('input').check()
  await picker.getByRole('button',{name:'确认',exact:true}).click()
  await expect(first.getByLabel('类型',{exact:true})).toHaveValue('number')
  await expect(first.getByLabel('字段值',{exact:true})).toHaveValue('7')
  await builder.getByRole('button',{name:'添加筛选条件',exact:true}).click()
  const second=builder.locator('.builder-rule').nth(1)
  await second.getByLabel('字段',{exact:true}).fill('name')
  await second.getByLabel('比较方式',{exact:true}).selectOption('notStarts')
  await second.getByLabel('字段值',{exact:true}).fill('G')
  await first.getByLabel('下一条件关系 1',{exact:true}).selectOption('or')
  await second.getByLabel('启用条件 2',{exact:true}).uncheck()
  await builder.getByRole('button',{name:'应用筛选与排序',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>(window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1)?.filter)).toBe('{"score":{"$eq":{"$numberInt":"7"}}}')
  await second.getByLabel('启用条件 2',{exact:true}).check()
  await builder.getByRole('button',{name:'应用筛选与排序',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>(window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1)?.filter)).toBe('{"$or":[{"score":{"$eq":{"$numberInt":"7"}}},{"name":{"$type":"string","$not":{"$regex":"^G"}}}]}')
})

test('MongoDB filter detects ObjectId while typing and preserves a manual text override in the value dialog',async({page})=>{
  await connect(page,'Mongo Local');await openUsers(page)
  const workbench=page.locator('.workbench:visible')
  await workbench.getByRole('button',{name:'查询条件',exact:true}).click()
  const builder=workbench.locator('.visual-query-builder')
  await builder.getByRole('button',{name:'添加筛选条件',exact:true}).click()
  const first=builder.locator('.builder-rule').first()
  const value=first.getByLabel('字段值',{exact:true}),type=first.getByLabel('类型',{exact:true})
  const id='507f1f77bcf86cd799439011'
  // The fixture has no such field; inference must come from the value.
  await first.getByLabel('字段',{exact:true}).fill('reference_id')
  await value.fill(id.slice(1))
  await expect(type).toHaveValue('text')
  await value.fill(id.toUpperCase())
  await expect(type).toHaveValue('objectId')
  await value.fill(id+'0')
  await expect(type).toHaveValue('text')
  await value.fill(id.slice(0,23)+'g')
  await expect(type).toHaveValue('text')
  await value.fill(id)
  await expect(type).toHaveValue('objectId')
  await first.getByRole('button',{name:'编辑筛选值 1',exact:true}).click()
  const picker=page.getByRole('dialog',{name:'编辑筛选值'})
  const dialogValue=picker.getByLabel('字段值',{exact:true}),dialogType=picker.getByLabel('类型',{exact:true})
  await dialogValue.fill('abc')
  await expect(dialogType).toHaveValue('text')
  await dialogValue.fill(id)
  await expect(dialogType).toHaveValue('objectId')
  await dialogType.selectOption('text')
  await expect(dialogValue).toHaveValue(id)
  await dialogValue.fill(id.toUpperCase())
  await expect(dialogType).toHaveValue('text')
  await picker.getByRole('button',{name:'确认',exact:true}).click()
  await expect(type).toHaveValue('text')
  await expect(value).toHaveValue(id.toUpperCase())
  await value.fill(id)
  await expect(type).toHaveValue('text')
  await builder.getByRole('button',{name:'应用筛选与排序',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>(window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1)?.filter)).toBe(JSON.stringify({reference_id:{$eq:id}}))
})

test('MongoDB classified explorer and saved query library',async({page})=>{
  await connect(page,'Mongo Local')
  await page.locator('.resource-node[data-object-kind="database"]').click()
  await expect(page.locator('.resource-node[data-object-kind="mongo-category"]')).toHaveCount(7)
  await page.locator('[data-object-category="views"]').click()
  await page.locator('[data-object-kind="view"]').click()
  await expect(page.locator('.workbench:visible')).toContainText('只读对象')
  await expect(page.locator('.workbench:visible').getByRole('button',{name:'新增',exact:true})).toBeDisabled()
  await page.locator('[data-object-category="indexes"]').click()
  await page.locator('[data-object-kind="mongo-indexes"]').click()
  await expect(page.locator('.workbench:visible').getByRole('button',{name:'刷新结构',exact:true})).toBeVisible()
  await page.locator('[data-object-category="gridfs"]').click()
  await page.locator('[data-object-kind="gridfs-bucket"]').click()
  await expect(page.locator('.workbench:visible')).toContainText('GridFS 文件元数据浏览')
  await page.locator('[data-object-category="queries"]').click()
  const catalog=page.locator('.object-list-panel:visible')
  await catalog.getByRole('button',{name:/新建查询/}).click()
  const library=page.locator('.mongo-library:visible')
  await expect(library.getByLabel('目标集合或视图',{exact:true})).toHaveCount(0)
  await expect(library.getByLabel('Filter',{exact:true})).toHaveCount(0)
  await library.getByLabel('名称',{exact:true}).fill('My saved query')
  await replaceEditor(page,'.mongo-library:visible .native-mongo-editor .monaco-editor','db.')
  await page.keyboard.press('Control+Space')
  await expect(page.locator('.suggest-widget.visible')).toContainText('users')
  await page.keyboard.press('Escape')
  await replaceEditor(page,'.mongo-library:visible .native-mongo-editor .monaco-editor','db.users.')
  await page.keyboard.press('Control+Space')
  await expect(page.locator('.suggest-widget.visible')).toContainText('find')
  await page.keyboard.press('Escape')
  await replaceEditor(page,'.mongo-library:visible .native-mongo-editor .monaco-editor','db.users.find({score:NumberInt(7)})')
  await library.getByRole('button',{name:'美化语句',exact:true}).click()
  await expect(library.locator('.view-lines')).toContainText('NumberInt(7)')
  await expect.poll(()=>library.locator('.view-lines').textContent()).toContain('score:')
  await library.getByRole('button',{name:'保存',exact:true}).click()
  await expect(library.getByRole('status')).toHaveText('保存成功')
  await library.getByRole('button',{name:'运行选中 / 全部',exact:true}).click()
  await expect(library.locator('.data-table')).toContainText('Ada')
  await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1)?.filter)).toBe('{"score":{"$numberInt":"7"}}')
  await page.locator('[data-object-category="pipelines"]').click()
  await catalog.getByRole('button',{name:/新建查询/}).click()
  await library.getByLabel('名称',{exact:true}).fill('My pipeline')
  await replaceEditor(page,'.mongo-library:visible .native-mongo-editor .monaco-editor','db.users.aggregate([{$limit:10}])')
  await library.getByRole('button',{name:'保存',exact:true}).click()
  await expect(library.getByRole('status')).toHaveText('保存成功')
  await library.getByRole('button',{name:'运行选中 / 全部',exact:true}).click()
  await expect(library.locator('.data-table')).toContainText('Ada')
  await page.locator('[data-object-category="queries"]').click()
  await expect(catalog.locator('tbody')).toContainText('My saved query')
  await catalog.locator('tbody tr').filter({hasText:'My saved query'}).dblclick()
  await expect(library.locator('.view-lines')).toContainText('NumberInt(7)')
  await expect(page.locator('[data-object-category="mapReduce"]')).toHaveCount(0)
  await expect(page.locator('[data-object-category="pipelines"]')).toBeVisible()
})

test('database menu creates and drops a named MongoDB database, with typed confirmation',async({page})=>{
  await connect(page,'Mongo Local')
  const menu=page.locator('.database-context-menu')
  await page.locator('.resource-node[data-object-kind="database"]').first().click({button:'right'})
  await menu.getByRole('button',{name:'新建数据库…',exact:true}).click()
  const create=page.getByRole('dialog',{name:'新建数据库'})
  await create.getByRole('button',{name:'解锁此会话',exact:true}).click()
  await create.getByLabel('数据库名称',{exact:true}).fill('db_test_created')
  await create.getByLabel('初始集合',{exact:true}).fill('items')
  await create.getByRole('button',{name:'新建',exact:true}).click()
  const root=page.locator('.resource-node[data-object-kind="database"]').filter({hasText:'db_test_created'})
  await expect(root).toBeVisible()
  await root.click({button:'right'})
  await menu.getByRole('button',{name:'删除数据库…',exact:true}).click()
  const drop=page.getByRole('dialog',{name:'删除数据库'})
  await expect(drop.getByRole('button',{name:'删除',exact:true})).toBeDisabled()
  await drop.getByLabel('输入数据库名称以确认删除').fill('db_test_created')
  await drop.getByRole('button',{name:'删除',exact:true}).click()
  await expect(root).toHaveCount(0)
  await expect.poll(()=>page.evaluate(()=>(window as any).__dbexCalls.filter((op:any)=>op.action==='mongo.dropDatabase').at(-1)?.database)).toBe('db_test_created')
})
test('database menu opens query and finds objects without scanning data',async({page})=>{
  await connect(page,'MySQL Local')
  const root=page.locator('.resource-node[data-object-kind="database"]').first()
  const menu=page.locator('.database-context-menu')
  await root.click({button:'right'})
  await menu.getByRole('button',{name:'新建查询',exact:true}).click()
  await expect(page.locator('.workbench:visible .query-editor')).toBeVisible()
  await root.click({button:'right'})
  await menu.getByRole('button',{name:'查找数据库对象…',exact:true}).click()
  const search=page.getByRole('dialog',{name:'查找数据库对象'})
  await search.getByLabel('查找数据库对象',{exact:true}).fill('users')
  await search.getByRole('button',{name:/users/}).click()
  await expect(page.locator('.workbench:visible .data-table')).toContainText('Ada')
  await root.click({button:'right'})
  await menu.getByRole('button',{name:'关闭数据库',exact:true}).click()
  await expect(page.locator('.workbench:visible .data-table')).toHaveCount(0)
})

test('unified preferences persist editor, record and external tool settings',async({page})=>{
  await page.getByRole('button',{name:'偏好设置',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'偏好设置'})
  await dialog.getByRole('button',{name:'编辑器',exact:true}).click()
  await dialog.getByRole('checkbox',{name:'显示行号',exact:true}).uncheck()
  await dialog.getByLabel('字号',{exact:true}).fill('16')
  await dialog.getByRole('button',{name:'记录',exact:true}).click()
  await dialog.getByLabel('MySQL',{exact:true}).selectOption('500')
  await dialog.getByLabel('行高',{exact:true}).selectOption('40')
  await dialog.getByRole('button',{name:'外部工具',exact:true}).click()
  await dialog.getByRole('button',{name:'选择可执行文件 mongodump',exact:true}).click()
  await expect(dialog.getByLabel('mongodump',{exact:true})).toHaveValue('/opt/bin/mongodump')
  await dialog.getByRole('button',{name:'确认',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await connect(page,'MySQL Local');await openUsers(page)
  await expect(page.locator('.workbench:visible .browse-page-size select')).toHaveValue('500')
  await expect(page.locator('.workbench:visible .configured-grid').first()).toHaveCSS('--record-height','40px')
  await page.reload()
  await page.getByRole('button',{name:'偏好设置',exact:true}).click()
  await dialog.getByRole('button',{name:'编辑器',exact:true}).click()
  await expect(dialog.getByRole('checkbox',{name:'显示行号',exact:true})).not.toBeChecked()
  await expect(dialog.getByLabel('字号',{exact:true})).toHaveValue('16')
  await dialog.getByRole('button',{name:'外部工具',exact:true}).click()
  await expect(dialog.getByLabel('mongodump',{exact:true})).toHaveValue('/opt/bin/mongodump')
  await dialog.getByRole('button',{name:'还原默认值',exact:true}).click()
  await dialog.getByRole('button',{name:'取消',exact:true}).click()
  await page.getByRole('button',{name:'偏好设置',exact:true}).click()
  await dialog.getByRole('button',{name:'外部工具',exact:true}).click()
  await expect(dialog.getByLabel('mongodump',{exact:true})).toHaveValue('/opt/bin/mongodump')
})


test('workspace restores the selected object and editor tab without executing a saved query or enabling writes',async({page})=>{
 await connect(page,'MySQL Local');await openUsers(page)
 await page.getByRole('button',{name:'SQL 编辑器',exact:true}).click()
 await page.getByLabel('SQL 参数 JSON 数组').waitFor()
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('dbex.workspace.v1')||'{}').positions?.sql?.tab)).toBe('query')
 await page.evaluate(()=>{const pref=JSON.parse(localStorage.getItem('dbex.preferences.v1')||'{}');pref.startup='workspace';pref.recoverySeconds=15;localStorage.setItem('dbex.preferences.v1',JSON.stringify(pref));const draft={connectionId:'sql',database:'app',entity:'users',kind:'mysql-query',text:JSON.stringify({sql:'SELECT 42 AS restored;',parameters:'[]'})};localStorage.setItem('mock.recovery',JSON.stringify({[JSON.stringify(['sql','app','users','mysql-query'])]:draft}))})
 await page.reload()
 await expect(page.locator('.resource-node.active')).toContainText('users')
 await expect(page.locator('.workbench:visible .query-editor')).toBeVisible()
 await page.getByRole('button',{name:'恢复草稿',exact:true}).click()
 await expect(page.locator('.workbench:visible .query-editor .view-lines')).toContainText('SELECT 42 AS restored;')
 await expect(page.getByRole('button',{name:'只读 · 启用写入',exact:true})).toBeVisible()
 {
   const writes=await page.evaluate(()=> (window as any).__dbexCalls.filter((call:any)=>call.action==='mysql.query'||call.action==='writeAccess'))
   expect(writes).toEqual([])
 }
})

test('saved record draft restores as an editor only after explicit write access',async({page})=>{
 await page.evaluate(()=>{
  localStorage.setItem('dbex.preferences.v1',JSON.stringify({recoverySeconds:15}))
  const draft={connectionId:'sql',database:'app',entity:'users',kind:'record-edit',text:JSON.stringify({mode:'insert',text:'{"name":"Draft only","email":"draft@example.test"}'})}
  localStorage.setItem('mock.recovery',JSON.stringify({[JSON.stringify(['sql','app','users','record-edit'])]:draft}))
 })
 await page.reload()
 await connect(page,'MySQL Local');await openUsers(page)
 await expect(page.getByText('发现未保存的记录编辑草稿',{exact:true})).toBeVisible()
 await expect(page.getByRole('button',{name:'恢复草稿',exact:true})).toBeDisabled()
 await page.getByRole('button',{name:'只读 · 启用写入',exact:true}).click()
 await page.getByRole('button',{name:'恢复草稿',exact:true}).click()
 await expect(page.getByRole('heading',{name:'新增记录',exact:true})).toBeVisible()
 await expect(page.locator('.document-editor .view-lines')).toContainText('Draft only')
 expect(await page.evaluate(()=> (window as any).__dbexCalls.filter((call:any)=>call.action==='mysql.insert'||call.action==='mysql.update'))).toEqual([])
 await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('mock.recovery')||'{}')).length)).toBe(0)
})

test('MariaDB has its own connection form, persisted settings and backup tools',async({page})=>{
 await page.getByRole('button',{name:'＋ 新建连接',exact:true}).click()
 await page.getByRole('button',{name:'MariaDB',exact:true}).click()
 await expect(page.getByLabel('端口',{exact:true})).toHaveValue('3306')
 await expect(page.getByLabel('用户名',{exact:true})).toHaveValue('root')
 await page.getByRole('button',{name:'测试连接',exact:true}).click()
 await expect(page.getByRole('status').filter({hasText:'连接成功'})).toBeVisible()
 expect(await page.evaluate(()=> (window as any).__dbexCalls.find((c:any)=>c.action==='testConnection')?.config.kind)).toBe('mariadb')
 await page.getByRole('button',{name:'取消',exact:true}).click()
 await page.getByRole('button',{name:'偏好设置',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'偏好设置'})
 await dialog.getByRole('button',{name:'记录',exact:true}).click()
 await dialog.getByLabel('MariaDB',{exact:true}).selectOption('500')
 await dialog.getByRole('button',{name:'外部工具',exact:true}).click()
 await expect(dialog.getByLabel('mariadb-dump',{exact:true})).toBeVisible()
 await dialog.getByRole('button',{name:'确认',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('dbex.preferences.v1')||'{}').records?.mariadbPageSize)).toBe(500)
})


test('top toolbar contains settings only; language, theme and connection creation are centralized',async({page})=>{
 const toolbar=page.locator('.top-actions')
 await expect(toolbar.locator(':scope > *')).toHaveCount(1)
 await expect(toolbar.getByRole('button',{name:'偏好设置',exact:true})).toBeVisible()
 await expect(toolbar.locator('select')).toHaveCount(0)
 await toolbar.getByRole('button',{name:'偏好设置',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'偏好设置'})
 const language=dialog.locator('[data-preference="language"]')
 const theme=dialog.locator('[data-preference="theme"]')
 await expect(language.locator('option')).toHaveCount(15)
 await language.selectOption('en')
 await theme.selectOption('light')
 // Opening the existing connection form neither saves nor drops the settings draft.
 await dialog.locator('[data-action="create-connection"]').click()
 await expect(dialog).not.toBeVisible()
 await expect(page.getByRole('heading',{name:'选择数据库类型'})).toBeVisible()
 await page.getByRole('button',{name:'取消',exact:true}).click()
 await expect(dialog).toBeVisible()
 await expect(language).toHaveValue('en')
 await expect(theme).toHaveValue('light')
 await expect(page.locator('html')).toHaveAttribute('lang','zh-CN')
 await dialog.locator('[data-action="save-preferences"]').click()
 await expect(page.locator('html')).toHaveAttribute('lang','en')
 await expect(page.locator('html')).toHaveAttribute('data-theme','light')
 await page.reload()
 await expect(page.locator('html')).toHaveAttribute('lang','en')
 await expect(page.locator('html')).toHaveAttribute('data-theme','light')
 await page.locator('.preferences-button').click()
 await expect(page.locator('.preferences-dialog [data-preference="language"]')).toHaveValue('en')
 await expect(page.locator('.preferences-dialog [data-preference="theme"]')).toHaveValue('light')
})


test('object catalog supports numeric column sorting, independent object tabs and query tabs',async({page})=>{
 await page.evaluate(()=>{(window as any).__dbexCatalogFixture=true})
 await connect(page,'Mongo Local')
 await page.locator('.resource-node[data-object-kind="database"]').first().click()
 await page.locator('[data-object-category="collections"]').click()
 const list=page.locator('.object-list-panel:visible')
 await expect(list.locator('tbody tr').first()).toContainText('audit')
 await list.getByRole('button',{name:'文档数'}).click()
 await expect(list.locator('tbody tr').first()).toContainText('audit')
 await list.getByRole('button',{name:'文档数'}).click()
 await expect(list.locator('tbody tr').first()).toContainText('users')
 await list.locator('tbody tr').filter({hasText:'users'}).dblclick()
 await expect(page.locator('.workbench:visible .data-table')).toContainText('Ada')
 await page.getByRole('button',{name:'查询条件',exact:true}).click()
 const tabs=page.locator('.object-tabbar:visible')
 await tabs.getByRole('button',{name:'对象',exact:true}).click()
 await list.locator('tbody tr').filter({hasText:'audit'}).dblclick()
 await expect(page.locator('.workbench:visible .workbench-header h2')).toHaveText('audit')
 await expect(tabs.locator('.object-tab')).toHaveCount(2)
 await tabs.locator('.object-tab-main').filter({hasText:'users@app'}).click()
 await expect(page.locator('.workbench:visible .browse-filter-panel')).toBeVisible()
 await expect(page.locator('.workbench:visible .workbench-header .eyebrow')).toHaveCount(0)
 await tabs.getByRole('button',{name:'对象',exact:true}).click()
 await list.getByRole('button',{name:/新建查询/}).click()
 await expect(page.locator('.mongo-library:visible')).toBeVisible()
 await expect(tabs.locator('.object-tab')).toHaveCount(3)
 await tabs.getByRole('button',{name:'关闭 audit',exact:true}).click()
 await expect(tabs.locator('.object-tab')).toHaveCount(2)
})

test('column menu sorts the complete database query, retains filters and supports a filter draft',async({page})=>{
 await connect(page,'Mongo Local');await openUsers(page)
 await page.getByRole('button',{name:'查询条件',exact:true}).click()
 await page.getByRole('button',{name:'文本',exact:true}).click()
 const panel=page.locator('.workbench:visible .browse-filter-panel')
 await panel.locator('textarea').nth(0).fill('{"score":{"$gte":7}}')
 await panel.locator('textarea').nth(1).fill('{"_id":1,"name":1}')
 await panel.getByRole('button',{name:'查询',exact:true}).click()
 const grid=page.locator('.workbench:visible .data-table')
 await grid.getByRole('button',{name:'列操作: _id',exact:true}).click()
 await page.getByRole('menuitem',{name:'降序排序',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1))).toMatchObject({filter:'{"score":{"$gte":7}}',projection:'{"_id":1,"name":1}',sort:'{"_id":-1}',offset:0})
 await grid.getByRole('button',{name:'列操作: name',exact:true}).click()
 await page.getByRole('menuitem',{name:'升序排序',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1)?.sort)).toBe('{"_id":-1,"name":1}')
 await grid.getByRole('button',{name:'列操作: name',exact:true}).click()
 await page.getByRole('menuitem',{name:'移除所有排序',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').at(-1))).toMatchObject({filter:'{"score":{"$gte":7}}',projection:'{"_id":1,"name":1}',sort:'{}'})
 const count=await page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').length)
 await grid.getByRole('button',{name:'列操作: name',exact:true}).click()
 await page.getByRole('menuitem',{name:'添加筛选',exact:true}).click()
 await expect(panel.locator('textarea').nth(0)).toHaveValue('{"$and":[{"score":{"$gte":7}},{"name":{"$eq":""}}]}')
 expect(await page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.find').length)).toBe(count)
})


test('named SQL query objects persist parameters, multiple editor tabs and catalog actions',async({page})=>{
 await connect(page,'MySQL Local')
 await page.locator('.resource-node[data-object-kind="database"]').first().click()
 await page.locator('[data-object-kind="query-folder"]').click()
 const catalog=page.locator('.object-list-panel:visible')
 await catalog.getByRole('button',{name:/新建查询/}).click()
 const editor=page.locator('.saved-query-editor:visible')
 await editor.getByLabel('名称',{exact:true}).fill('Find users')
 await replaceEditor(page,'.saved-query-editor:visible .query-editor .monaco-editor','SELECT * FROM users WHERE id = ?')
 await editor.getByLabel('SQL 参数 JSON 数组').fill('["9223372036854775807"]')
 await editor.getByLabel('SQL 参数 JSON 数组').press('ControlOrMeta+s')
 await expect(editor.getByRole('status')).toHaveText('保存成功')
 await editor.getByRole('button',{name:'运行选中 / 全部',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mysql.query').at(-1))).toMatchObject({sql:'SELECT * FROM users WHERE id = ?',parameters:['9223372036854775807'],database:'app'})
 const tabs=page.locator('.object-tabbar:visible')
 await tabs.getByRole('button',{name:'对象',exact:true}).click()
 await expect(catalog.locator('tbody')).toContainText('Find users')
 await catalog.getByRole('button',{name:/新建查询/}).click()
 await editor.getByLabel('名称',{exact:true}).fill('Second query')
 await editor.getByRole('button',{name:'保存',exact:true}).click()
 await expect(editor.getByRole('status')).toHaveText('保存成功')
 await expect(tabs.locator('.object-tab')).toHaveCount(2)
 await tabs.getByRole('button',{name:'对象',exact:true}).click()
 await catalog.locator('tbody tr').filter({hasText:'Find users'}).click()
 await catalog.getByRole('button',{name:'复制',exact:true}).click()
 await expect(catalog.locator('tbody')).toContainText('Find users (2)')
 await catalog.locator('tbody tr').filter({hasText:'Find users (2)'}).click()
 await catalog.getByRole('button',{name:'重命名',exact:true}).click()
 const rename=page.getByRole('dialog',{name:'重命名'})
 await rename.getByLabel('名称',{exact:true}).fill('Renamed copy')
 await rename.getByRole('button',{name:'确认',exact:true}).click()
 await expect(catalog.locator('tbody')).toContainText('Renamed copy')
 await catalog.locator('tbody tr').filter({hasText:'Renamed copy'}).click()
 await catalog.getByRole('button',{name:'导出查询',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='exportSavedQuery').at(-1)?.item.parameters)).toBe('["9223372036854775807"]')
 await catalog.getByRole('button',{name:'删除',exact:true}).click()
 await expect(catalog.locator('tbody')).not.toContainText('Renamed copy')
 await catalog.getByRole('button',{name:'导入查询',exact:true}).click()
 await expect(catalog.locator('tbody')).toContainText('Imported query')
 await page.reload()
 await connect(page,'MySQL Local')
 await page.locator('.resource-node[data-object-kind="database"]').first().click()
 await page.locator('[data-object-kind="query-folder"]').click()
 await catalog.locator('tbody tr').filter({hasText:'Find users'}).dblclick()
 await expect(editor.getByLabel('SQL 参数 JSON 数组')).toHaveValue('["9223372036854775807"]')
 await expect(editor.locator('.view-lines')).toContainText('SELECT')
 expect(await page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mysql.query').length)).toBe(0)
})


test('macOS integrated title bar reserves native controls and keeps preferences clickable',async({page})=>{
 const root=page.locator('html'),bar=page.locator('.topbar'),settings=bar.getByRole('button',{name:'偏好设置',exact:true})
 await expect(root).toHaveAttribute('data-window-chrome','native')
 await expect(bar).toHaveCSS('padding-left','18px')
 await page.evaluate(()=>localStorage.setItem('mock.window-chrome','mac-native-controls'))
 await page.reload()
 await expect(root).toHaveAttribute('data-window-chrome','mac-native-controls')
 await expect(bar).toHaveCSS('padding-left','100px')
 const regions=await bar.evaluate(el=>{
   const css=(node:Element,pseudo?:string)=>{const style=getComputedStyle(node,pseudo);return style.getPropertyValue('app-region')||style.getPropertyValue('-webkit-app-region')}
   return {bar:css(el),controls:css(el,'::before'),settings:css(el.querySelector('.preferences-button')!)}
 })
 expect(regions).toEqual({bar:'drag',controls:'no-drag',settings:'no-drag'})
 await expect(bar.locator('.top-actions > *')).toHaveCount(1)
 const layout=await bar.evaluate(el=>({brand:el.querySelector('.brand')!.getBoundingClientRect().left,bar:el.getBoundingClientRect().left}))
 expect(layout.brand-layout.bar).toBeGreaterThanOrEqual(100)
 await settings.click()
 const prefs=page.getByRole('dialog',{name:'偏好设置'})
 await prefs.locator('[data-preference="theme"]').selectOption('light')
 await prefs.locator('[data-action="save-preferences"]').click()
 await expect(root).toHaveAttribute('data-theme','light')
 await expect(bar).toHaveCSS('background-color','rgb(255, 255, 255)')
 await settings.click()
 await prefs.locator('[data-preference="theme"]').selectOption('dark')
 await prefs.locator('[data-action="save-preferences"]').click()
 await expect(bar).toHaveCSS('background-color','rgb(29, 34, 43)')
 // Physical left reservation must remain valid when locale direction is RTL.
 await page.evaluate(()=>document.documentElement.dir='rtl')
 await expect(bar).toHaveCSS('direction','ltr')
 await settings.click()
 await expect(prefs).toBeVisible()
})


test('ClickHouse uses its own typed query actions and analytical workspace',async({page})=>{
 await connect(page,'ClickHouse Local')
 await page.locator('.resource-node[data-object-kind="database"]').first().click()
 await page.locator('.resource-node[data-object-kind="table"]').filter({hasText:'events'}).click()
 const workbench=page.locator('.clickhouse-workbench:visible')
 await expect(workbench.locator('.data-table')).toContainText('18446744073709551615')
 await expect(workbench.getByRole('button',{name:'开始事务',exact:true})).toHaveCount(0)
 await expect(workbench.getByRole('button',{name:'编辑',exact:true})).toHaveCount(0)
 await workbench.locator('.data-table').getByRole('button',{name:'列操作: id',exact:true}).click()
 await page.getByRole('menuitem',{name:'降序排序',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='clickhouse.browse').at(-1)?.sort)).toEqual([{field:'id',direction:-1}])
 await workbench.getByRole('button',{name:'结构',exact:true}).click()
 await expect(workbench.locator('.data-table')).toContainText('UInt64')
 await page.locator('[data-object-kind="query-folder"]').click()
 await page.locator('.object-list-panel:visible').getByRole('button',{name:/新建查询/}).click()
 const editor=page.locator('.saved-query-editor:visible')
 await editor.getByLabel('名称',{exact:true}).fill('Analytics')
 await replaceEditor(page,'.saved-query-editor:visible .query-editor .monaco-editor','SELECT {id:UInt64} AS id')
 await editor.getByLabel('ClickHouse 参数 JSON 对象').fill('{"id":"18446744073709551615"}')
 await editor.getByRole('button',{name:'保存',exact:true}).click()
 await expect(editor.getByRole('status')).toHaveText('保存成功')
 await editor.getByRole('button',{name:'运行选中 / 全部',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='clickhouse.query').at(-1)?.parameters)).toEqual({id:'18446744073709551615'})
 await expect(editor.getByRole('button',{name:'开始事务',exact:true})).toHaveCount(0)
 await expect(editor.locator('.data-table')).toContainText('18446744073709551615')
})

test('MongoDB index syntax help preserves the draft and inserts examples without creating an index',async({page})=>{
 await connect(page,'Mongo Local')
 await page.locator('.resource-node[data-object-kind="database"]').click()
 await page.locator('[data-object-category="indexes"]').click()
 await page.locator('[data-object-kind="mongo-indexes"]').click()
 const workbench=page.locator('.workbench:visible')
 await workbench.getByRole('button',{name:'只读 · 启用写入',exact:true}).click()
 await workbench.getByRole('button',{name:'新建索引',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'创建 MongoDB 索引',exact:true})
 const keys=dialog.locator('[data-index-keys]'),options=dialog.locator('[data-index-options]')
 await keys.fill('{"custom":-1}')
 await options.fill('{"name":"custom_index"}')
 await dialog.getByRole('button',{name:'语法帮助',exact:true}).click()
 await expect(dialog.locator('[data-index-help]')).toContainText('partialFilterExpression')
 await expect(dialog.locator('[data-index-help]')).toContainText('expireAfterSeconds')
 await dialog.getByRole('button',{name:'返回',exact:true}).click()
 await expect(keys).toHaveValue('{"custom":-1}')
 await expect(options).toHaveValue('{"name":"custom_index"}')
 await dialog.getByRole('button',{name:'语法帮助',exact:true}).click()
 await dialog.locator('[data-index-example]').selectOption('ttl')
 await dialog.getByRole('button',{name:'填入示例',exact:true}).click()
 expect(JSON.parse(await keys.inputValue())).toEqual({expiresAt:1})
 expect(JSON.parse(await options.inputValue())).toEqual({name:'expiresAt_ttl',expireAfterSeconds:0})
 expect(await page.evaluate(()=> (window as any).__dbexCalls.filter((c:any)=>c.action==='mongo.createIndex').length)).toBe(0)
 await dialog.getByRole('button',{name:'审阅并创建',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.find((c:any)=>c.action==='mongo.createIndex'))).toMatchObject({database:'app',entity:'users',confirmed:true})
 await expect(dialog).toHaveCount(0)
})


test('database brand icons are consistent in sidebar, session tabs and connection dialogs; welcome is empty',async({page})=>{
 const sidebar=page.locator('.connection-sidebar')
 await expect(page.locator('.empty-workspace')).toBeVisible()
 await expect(page.locator('.empty-workspace')).toBeEmpty()
 await expect(page.locator('.welcome-mark,.welcome-features')).toHaveCount(0)
 const mongo=sidebar.locator('.connection-item').filter({hasText:'Mongo Local'})
 await expect(mongo.locator('[data-database-icon="mongodb"] img')).toBeVisible()
 await expect.poll(()=>mongo.locator('img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true)
 await page.getByRole('button',{name:'＋ 新建连接',exact:true}).click()
 const choices=page.locator('.connection-choice:not(.uri-choice)')
 await expect(choices.locator('[data-database-icon]')).toHaveCount(6)
 for(const kind of ['mysql','mariadb','mongodb','redis','sqlite','clickhouse']){
  const image=choices.locator('[data-database-icon="'+kind+'"] img')
  await expect(image).toBeVisible()
  await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true)
 }
 await page.getByRole('button',{name:'MongoDB',exact:true}).click()
 await expect(page.locator('.connection-dialog-title [data-database-icon="mongodb"] img')).toBeVisible()
 await page.getByRole('button',{name:'取消',exact:true}).click()
 await connect(page,'Mongo Local')
 await expect(page.locator('.session-tab.active [data-database-icon="mongodb"] img')).toBeVisible()
})


test('a single connection tree keeps multiple independent session resources expanded',async({page})=>{
 await connect(page,'MySQL Local');await openUsers(page)
 const local=page.locator('[data-resource-session="sql"]')
 await expect(local.locator('.resource-node').filter({hasText:'users'})).toBeVisible()
 await connect(page,'MySQL Other');await openUsers(page,'other')
 const other=page.locator('[data-resource-session="sql2"]')
 await expect(local).toBeVisible()
 await expect(other).toBeVisible()
 await expect(page.locator('.explorer-pane')).toHaveCount(0)
 await expect(page.locator('.resize-handle[role="separator"]')).toHaveCount(1)
 await expect(page.locator('.connection-sidebar .resource-list')).toHaveCount(2)
 await local.locator('.resource-node').filter({hasText:'users'}).click()
 await expect(page.locator('.workbench:visible .data-table')).toContainText('Ada')
 await other.locator('.resource-node').filter({hasText:'users'}).click()
 await expect(page.locator('.workbench:visible .data-table')).toContainText('Grace')
 const chevron=page.locator('[data-connection-id="sql"] .connection-chevron')
 await chevron.click()
 await expect(local).toHaveCount(0)
 await expect(other).toBeVisible()
 await expect(page.locator('.session-tab')).toHaveCount(2)
 await chevron.click()
 await expect(local.locator('.resource-node').filter({hasText:'users'})).toBeVisible()
 await expect(other.locator('.resource-node').filter({hasText:'users'})).toBeVisible()
 // A database context action on an inactive tree activates the correct session.
 await local.locator('[data-object-kind="database"]').click({button:'right'})
 await page.locator('.database-context-menu').getByRole('button',{name:'新建查询',exact:true}).click()
 await expect(page.locator('.session-tab.active')).toContainText('MySQL Local')
 await expect(page.locator('.saved-query-editor:visible')).toBeVisible()
})


test('grid inline edits and column assignment are staged, cancellable and explicitly committed',async({page})=>{
 await connect(page,'Mongo Local');await openUsers(page)
 const workbench=page.locator('.workbench:visible'),grid=workbench.locator('.data-table')
 await workbench.getByRole('button',{name:'只读 · 启用写入',exact:true}).click()
 const cell=grid.locator('tr[data-row-index="0"] [data-grid-field="name"]')
 await cell.dblclick()
 const input=grid.locator('.inline-grid-input')
 await expect(input).toHaveValue('Ada')
 await input.fill('Ada staged');await input.press('Enter')
 await expect(cell).toContainText('Ada staged')
 expect(await page.evaluate(()=> (window as any).__dbexCalls.filter((x:any)=>x.action==='mongo.replaceBatch').length)).toBe(0)
 await workbench.getByRole('button',{name:'取消表格修改',exact:true}).click()
 await expect(cell).toContainText('Ada')
 await grid.locator('thead th').filter({hasText:/^name/}).dblclick()
 await workbench.getByLabel('整列修改值',{exact:true}).fill('New name')
 await expect(grid.locator('tr[data-row-index="1"] [data-grid-field="name"]')).toContainText('New name')
 await workbench.getByRole('button',{name:'保存表格修改',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((x:any)=>x.action==='mongo.replaceBatch').at(-1)?.edits.map((x:any)=>JSON.parse(x.document).name))).toEqual(['New name','New name','New name'])
 await expect(workbench.getByRole('button',{name:'保存表格修改',exact:true})).toBeDisabled()
})

test('SQL inline edits retain exact record identity and block pagination until resolved',async({page})=>{
 await connect(page,'MySQL Local');await openUsers(page)
 const workbench=page.locator('.workbench:visible'),grid=workbench.locator('.data-table')
 await workbench.getByRole('button',{name:'只读 · 启用写入',exact:true}).click()
 await grid.locator('tr[data-row-index="0"] [data-grid-field="name"]').dblclick()
 const input=grid.locator('.inline-grid-input')
 await input.fill('Changed');await input.press('Enter')
 await workbench.getByRole('button',{name:'下一页',exact:true}).click()
 await expect(workbench.getByRole('alert')).toContainText('请先保存或取消表格修改。')
 await workbench.getByRole('button',{name:'保存表格修改',exact:true}).click()
 await expect.poll(()=>page.evaluate(()=> (window as any).__dbexCalls.filter((x:any)=>x.action==='mysql.updateBatch').at(-1)?.edits[0])).toMatchObject({key:{id:'1'},original:{name:'Ada'},changes:{name:'Changed'}})
})
