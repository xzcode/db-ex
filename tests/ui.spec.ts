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
    ].map(value => ({ ...value, sshEnabled: false, tlsEnabled: false }))
    const grid = (values: Record<string, string>[]) => ({ columns: Object.keys(values[0] || {}), rows: values })
    ;(window as any).__dbexCalls = calls
    ;(window as any).dbex = {
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
        if(id!=='mongo')return [{ id: database + '-users', label: 'users', database, entity: 'users', kind: 'table' }]
        if(!category)return [['collections','集合'],['views','视图'],['functions','函数'],['indexes','索引'],['mapReduce','MapReduce'],['pipelines','聚合管道'],['gridfs','GridFS 存储桶'],['queries','查询']].map(([key,label])=>({id:database+'-'+key,label,database,kind:'mongo-category',category:key}))
        if(category==='collections')return [{id:database+'-users',label:'users',database,entity:'users',kind:'collection'}]
        if(category==='views')return [{id:database+'-users-view',label:'users_view',database,entity:'users_view',kind:'view',readOnly:true}]
        if(category==='indexes')return [{id:database+'-users-indexes',label:'users',database,entity:'users',kind:'mongo-indexes'}]
        if(category==='gridfs')return [{id:database+'-fs',label:'fs',database,entity:'fs.files',kind:'gridfs-bucket',readOnly:true}]
        if(category==='functions')return [{id:database+'-system.js',label:'system.js',database,entity:'system.js',kind:'mongo-function',readOnly:true}]
        return []
      },
      async execute(id: string, op: any) {
        calls.push({ sessionId: id, ...op })
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
  await page.locator('.resource-node').filter({ hasText: database }).first().click()
  const folders=page.locator('.resource-node[data-object-category="collections"]')
  await expect(page.locator('.resource-node[data-object-kind="table"], .resource-node[data-object-category="collections"]').first()).toBeVisible()
  if(await folders.count()) await folders.click()
  await page.locator('.child-node').filter({ hasText: 'users' }).click()
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
  await expect(page.getByText('事务进行中', { exact: true })).toBeVisible()
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


test('English interface can switch live, persists and preserves connection identity', async ({ page }) => {
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
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
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
  await page.locator('.connection-item').filter({ hasText: 'MySQL Local' }).getByTitle('Connect', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'SQL editor', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
  await expect(page.getByRole('button', { name: 'SQL 编辑器', exact: true })).toBeVisible()
})


test.describe('system language default', () => {
  test.use({ locale: 'de-DE' })
  test('first launch follows system; selecting a language overrides it, system resets it', async ({ page }) => {
    await expect(page.getByRole('combobox', { name: 'Sprache', exact: true })).toHaveValue('system')
    await expect(page.getByRole('button', { name: '+ Neue Verbindung', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await page.getByRole('combobox', { name: 'Sprache', exact: true }).selectOption('ja')
    await expect(page.getByRole('button', { name: '＋ 新規接続', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('combobox', { name: '言語', exact: true })).toHaveValue('ja')
    await page.getByRole('combobox', { name: '言語', exact: true }).selectOption('system')
    await expect(page.getByRole('button', { name: '+ Neue Verbindung', exact: true })).toBeVisible()
  })
})
test('Arabic direction and all 14 language options are available', async ({ page }) => {
  const select = page.getByRole('combobox', { name: '语言', exact: true })
  await expect(select.locator('option')).toHaveCount(15)
  await select.selectOption('ar')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('button', { name: '+ اتصال جديد', exact: true })).toBeVisible()
  await expect(page.locator('.connection-item').filter({ hasText: 'MySQL Local' })).toBeVisible()
  await page.getByRole('combobox', { name: 'اللغة', exact: true }).selectOption('zh-TW')
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
  await expect(page.locator('.workbench:visible .workbench-header .eyebrow')).toHaveText('MYSQL')
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
  await expect(page.locator('.resource-node[data-object-kind="mongo-category"]')).toHaveCount(8)
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
  const library=page.locator('.mongo-library:visible')
  await library.getByLabel('目标集合或视图',{exact:true}).selectOption('users')
  await library.getByLabel('名称',{exact:true}).fill('My saved query')
  await library.getByLabel('Filter',{exact:true}).fill('{"score":{"$numberInt":"7"}}')
  await library.getByRole('button',{name:'保存',exact:true}).click()
  await expect(library.getByRole('status')).toHaveText('保存成功')
  await library.getByRole('button',{name:'查询',exact:true}).click()
  await expect(library.locator('.data-table')).toContainText('Ada')
  await page.locator('[data-object-category="pipelines"]').click()
  await library.getByLabel('目标集合或视图',{exact:true}).selectOption('users')
  await library.getByLabel('名称',{exact:true}).fill('My pipeline')
  await library.getByRole('button',{name:'保存',exact:true}).click()
  await expect(library.getByRole('status')).toHaveText('保存成功')
  await library.getByRole('button',{name:'运行 Aggregation',exact:true}).click()
  await expect(library.locator('.data-table')).toContainText('Ada')
  await page.locator('[data-object-category="queries"]').click()
  await expect(library.getByLabel('已保存对象').locator('option')).toHaveText(['未选择对象','My saved query'])
  await library.getByLabel('已保存对象').selectOption({label:'My saved query'})
  await expect(library.getByLabel('Filter',{exact:true})).toHaveValue('{"score":{"$numberInt":"7"}}')
  await page.locator('[data-object-category="mapReduce"]').click()
  await expect(page.locator('.workbench:visible')).toContainText('MapReduce 已弃用')
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
