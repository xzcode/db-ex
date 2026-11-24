import { expect, test, type Page } from '@playwright/test'
test.use({ locale: 'zh-CN' })

// The bridge is replaced only in tests; the application never supplies fake database data.
async function installBridge(page: Page) {
  await page.addInitScript(() => {

    const calls: Record<string, unknown>[] = []
    const sessions: Record<string, any> = {}
    const rows = [{ id: '1', name: 'Ada', email: 'ada@example.test' }]
    const document = '{"_id":{"$oid":"64b000000000000000000001"},"name":"Ada","createdAt":{"$date":{"$numberLong":"1700000000000"}}}'
    const configs = [
      { id: 'sql', name: 'MySQL Local', kind: 'mysql', host: '127.0.0.1', port: 3306 },
      { id: 'mongo', name: 'Mongo Local', kind: 'mongodb', host: '127.0.0.1', port: 27017 },
      { id: 'redis', name: 'Redis Local', kind: 'redis', host: '127.0.0.1', port: 6379 },
      { id: 'sql2', name: 'MySQL Other', kind: 'mysql', host: '127.0.0.2', port: 3306 },
    ].map(value => ({ ...value, environment: 'development', sshEnabled: false, tlsEnabled: false }))
    const grid = (values: Record<string, string>[]) => ({ columns: Object.keys(values[0] || {}), rows: values })
    ;(window as any).__dbexCalls = calls
    ;(window as any).dbex = {
      async getSystemLanguage() { return navigator.language },
      async setLocale(locale: string) { calls.push({ action: 'setLocale', locale }) },
      async listConnections() { return configs },
      async saveConnection(config: any, clearSecrets: string[]) { calls.push({ action: 'saveConnection', config, clearSecrets }); return { ...config, id: config.id || 'new' } },
      async editConnection(id: string) { return { config: { ...configs.find(value => value.id === id), password: '', ssh: { enabled: false, host: '', port: 22, username: '', authMode: 'agent' }, tls: { enabled: false } }, secretFields: ['password'] } },
      async deleteConnection(id: string) { calls.push({ action: 'deleteConnection', id }) },
      async trustHostKey() {},
      async connectSaved(id: string) { const config = configs.find(value => value.id === id)!; sessions[id] = { ...config, id, connectionId: id, displayHost: config.host, writable: false, transaction: false }; return sessions[id] },
      async connectTemporary(config: any) { return { ...config, id: 'temporary', writable: false, transaction: false, displayHost: config.host } },
      async testConnection(config: any, clearSecrets: string[]) { calls.push({ action: 'testConnection', config, clearSecrets }); return '连接成功' },
      async pickConnectionFile(kind: string) { calls.push({ action: 'pickConnectionFile', kind }); return '/test/client.pem' },
      async disconnect(id: string) { calls.push({ action: 'disconnect', id }) },
      async roots(id: string) { return [{ id: id + '-db', label: id === 'redis' ? 'DB 0' : id === 'sql2' ? 'other' : 'app', kind: id === 'redis' ? 'keyspace' : 'database', database: id === 'sql2' ? 'other' : 'app' }] },
      async children(_id: string, database: string) { return [{ id: database + '-users', label: 'users', database, entity: 'users', kind: 'table' }] },
      async execute(id: string, op: any) {
        calls.push({ sessionId: id, ...op })
        if (op.action === 'mysql.structure') return { ...grid([{ name: 'id', type: 'int', key: 'PRI' }, { name: 'name', type: 'varchar', key: '' }]), primaryKeys: ['id'] }
        if (op.action === 'mysql.query') {
          if (op.sql.includes('slow_query')) await new Promise(resolve => setTimeout(resolve, 400))
          const values = (window as any).__dbexLargeGrid ? Array.from({ length: 500 }, (_, index) => ({ id: String(index + 1), name: 'User ' + (index + 1), email: 'user' + (index + 1) + '@example.test' })) : id === 'sql2' ? [{ id: '2', name: 'Grace', email: 'grace@example.test' }] : rows
          return { ...grid(values), rawRows: values, durationMs: 4, transaction: false }
        }
        if (op.action === 'mysql.begin') return { columns: [], rows: [], transaction: true }
        if (op.action === 'mysql.commit' || op.action === 'mysql.rollback') return { columns: [], rows: [], transaction: false }
        if (op.action === 'mongo.find' || op.action === 'mongo.aggregate') return { ...grid([{ _id: '64b000000000000000000001', name: 'Ada' }]), documents: [document], durationMs: 3 }
        if (op.action === 'mongo.indexes') return grid([{ name: '_id_', key: '{"_id":1}' }])
        if (op.action === 'redis.nodes') return grid([{ id: '127.0.0.1:6379', host: '127.0.0.1', port: '6379', role: 'master' }, { id: '127.0.0.2:6379', host: '127.0.0.2', port: '6379', role: 'master' }])
        if (op.action === 'redis.scan') return { ...grid([{ key: 'profile:1', type: 'string', ttl: '-1' }]), nextCursor: undefined }
        if (op.action === 'redis.get') return { ...grid([{ value: 'hello' }]), value: 'hello', redisType: 'string', ttl: -1, length: 5, truncated: false }
        return { columns: [], rows: [], affectedRows: 1, message: '操作已完成' }
      },
      async cancel(id: string) { calls.push({ action: 'cancel', id }) },
      async setWriteAccess(id: string, writable: boolean) { sessions[id] = { ...sessions[id], writable }; calls.push({ action: 'writeAccess', id, writable }); return sessions[id] },
      async listSnippets() { return [] }, async saveSnippet(value: any) { return { ...value, id: 'snippet', updatedAt: new Date().toISOString() } }, async deleteSnippet() {},
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
  await page.locator('.connection-item').filter({ hasText: 'MySQL Local' }).getByTitle('编辑连接').click()
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

test('MongoDB edits preserve canonical EJSON and disable editing projected documents', async ({ page }) => {
  await connect(page, 'Mongo Local'); await openUsers(page)
  await page.getByRole('button', { name: '只读 · 启用写入', exact: true }).click()
  await page.locator('.workbench:visible .data-table tbody tr').first().click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('.document-editor')).toContainText('$oid')
  await page.getByRole('button', { name: '审阅并保存', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__dbexCalls.some((call: any) => call.action === 'mongo.replace' && call.original.includes('$oid') && call.document.includes('$date') && call.confirmed))).toBe(true)
  await page.getByLabel('Projection', { exact: true }).fill('{"name":1}')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.locator('.workbench:visible .data-table tbody tr').first().click()
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
  await page.getByTitle('导出此连接').first().click()
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
