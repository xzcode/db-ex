import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { access, readdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
async function packagedExecutable() {
  const root = resolve('release')
  const candidates = [join(root, 'linux-unpacked/db-ex'), join(root, 'linux-arm64-unpacked/db-ex'), join(root, 'win-unpacked/DB EX.exe'), join(root, 'win-arm64-unpacked/DB EX.exe')]
  for (const directory of await readdir(root)) if (directory.startsWith('mac')) candidates.push(join(root, directory, 'DB EX.app/Contents/MacOS/DB EX'))
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  throw new Error('Packaged DB EX executable was not found')
}
const packaged = process.env.DB_EX_PACKAGED === '1'
const userData = await mkdtemp(join(tmpdir(), 'dbex-smoke-'))
let application
try {
application = await electron.launch({
  ...(packaged ? { executablePath: await packagedExecutable() } : {}),
  args: [...(packaged ? [] : ['.']), '--disable-gpu', '--user-data-dir=' + userData],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  timeout: 30000,
})
  const page = await application.firstWindow({ timeout: 30000 })
  await page.waitForSelector('#app', { state: 'visible' })
  await page.waitForFunction(() => typeof window.dbex?.listConnections === 'function')
  const boundary = await page.evaluate(() => ({ node: typeof window.require, ipc: typeof window.dbex?.execute, title: document.title }))
  assert.equal(boundary.node, 'undefined')
  assert.equal(boundary.ipc, 'function')
  const runtimeArtwork=await application.evaluate(({app,nativeImage})=>{
    const mac=process.platform==='darwin'
    const path=app.isPackaged?process.resourcesPath+'/icons/'+(mac?'db-ex-mac.png':'db-ex.png'):app.getAppPath()+'/build/'+(mac?'icon-mac.png':'icon.png')
    const expected=nativeImage.createFromPath(path)
    const dockAvailable=!mac||typeof app.dock?.setIcon==='function'
    return {empty:expected.isEmpty(),size:expected.getSize(),dockAvailable}
  })
  assert.equal(runtimeArtwork.empty,false)
  assert.equal(runtimeArtwork.size.width,1024)
  assert.equal(runtimeArtwork.size.height,1024)
  assert.equal(runtimeArtwork.dockAvailable,true)
  assert.equal(await page.locator('.empty-workspace').textContent(),'')
  assert.equal(await page.locator('.welcome-mark,.welcome-features').count(),0)
  assert.match(boundary.title, /DB EX/)
  assert(Array.isArray(await page.evaluate(() => window.dbex.listConnections())))
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  // Real desktop chrome contract: macOS has native traffic-light placement;
  // Windows and Linux retain the native frame and do not reserve that space.
  const expectedChrome=process.platform==='darwin'?'mac-native-controls':'native'
  await page.waitForFunction(expected=>document.documentElement.dataset.windowChrome===expected,expectedChrome)
  if(process.platform==='darwin'){
    const nativeButtons=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getWindowButtonPosition())
    assert.deepEqual(nativeButtons,{x:16,y:22})
    const chrome=await page.locator('.topbar').evaluate(el=>{
      const css=node=>{const style=getComputedStyle(node);return style.getPropertyValue('app-region')||style.getPropertyValue('-webkit-app-region')}
      return {padding:getComputedStyle(el).paddingLeft,drag:css(el),button:css(el.querySelector('.preferences-button')),brand:el.querySelector('.brand').getBoundingClientRect().left-el.getBoundingClientRect().left}
    })
    assert.equal(chrome.padding,'100px')
    assert.equal(chrome.drag,'drag')
    assert.equal(chrome.button,'no-drag')
    assert(chrome.brand>=100)
  }else{
    assert.equal(await page.locator('.topbar').evaluate(el=>getComputedStyle(el).paddingLeft),'18px')
  }
  // Exercise the real encrypted store and metadata-only bridge before fixture handlers.
  const profile = await page.evaluate(async () => {
    const saved = await window.dbex.saveConnection({ name: 'Appearance smoke', kind: 'mysql', host: 'localhost', port: 3306, username: 'test', password: 'synthetic-smoke-password', ssh: { enabled: false }, tls: { enabled: false } })
    const updated = await window.dbex.updateConnectionAppearance(saved.id, { color: '#123abc', group: 'Smoke Group' })
    const draft = await window.dbex.editConnection(saved.id)
    return { saved, updated, draft }
  })
  assert.equal(profile.updated.color, '#123abc')
  assert.equal(profile.updated.group, 'Smoke Group')
  assert(profile.draft.secretFields.includes('password'))
  assert.equal(profile.draft.config.password, undefined)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[data-color="#123abc"]'))
  await page.evaluate(id => window.dbex.deleteConnection(id), profile.saved.id)
  // A real SQLite file via the shipped bridge and packaged child process.
  // The fixture is a new empty file; no user database is touched.
  const sqlitePath=join(userData,'sqlite-smoke.db')
  await writeFile(sqlitePath,'',{flag:'wx',mode:0o600})
  const sqlite=await page.evaluate(async filePath=>{
    const config={name:'SQLite smoke',kind:'sqlite',host:'',port:0,filePath,ssh:{enabled:false},tls:{enabled:false}}
    const session=await window.dbex.connectTemporary(config)
    try{
      const roots=await window.dbex.roots(session.id)
      const data=await window.dbex.execute(session.id,{action:'mysql.query',sql:"SELECT 7 AS value, 'text' AS label"})
      let readOnly=false
      try{await window.dbex.execute(session.id,{action:'mysql.query',sql:'CREATE TABLE forbidden(id INTEGER)',confirmed:true})}catch{readOnly=true}
      return {session,roots,data,readOnly}
    }finally{await window.dbex.disconnect(session.id)}
  },sqlitePath)
  assert.equal(sqlite.session.kind,'sqlite')
  assert.equal(sqlite.session.writable,false)
  assert.equal(sqlite.roots[0].database,'main')
  assert.equal(sqlite.data.rows[0].value,'7')
  assert.deepEqual(sqlite.data.sqliteTypes[0],['INTEGER','TEXT'])
  assert.equal(sqlite.readOnly,true)
  // Exercise the actual packaged preload, scoped saved-query IPC and on-disk encryption.
  const queryFixture=await page.evaluate(async filePath=>{
    const profile=await window.dbex.saveConnection({name:'Saved query smoke',kind:'sqlite',host:'',port:0,filePath,ssh:{enabled:false},tls:{enabled:false}})
    const session=await window.dbex.connectSaved(profile.id)
    try{
      const saved=await window.dbex.saveQueryObject(session.id,'main',{draft:{name:'Saved smoke',mode:'sql',text:'SELECT ? AS value',parameters:'["exact query fixture"]'}})
      return {profileId:profile.id,queryId:saved.id}
    }finally{await window.dbex.disconnect(session.id)}
  },sqlitePath)
  await page.reload()
  const restored=await page.evaluate(async fixture=>{
    const session=await window.dbex.connectSaved(fixture.profileId)
    try{
      const list=await window.dbex.listSavedQueries(session.id,'main','sql')
      const saved=await window.dbex.getSavedQuery(session.id,'main',fixture.queryId)
      const result=await window.dbex.execute(session.id,{action:'mysql.query',database:'main',sql:saved.text,parameters:JSON.parse(saved.parameters)})
      return {list,saved,result}
    }finally{await window.dbex.disconnect(session.id);await window.dbex.deleteConnection(fixture.profileId)}
  },queryFixture)
  assert.equal(restored.list[0].name,'Saved smoke')
  assert.equal(restored.saved.parameters,'["exact query fixture"]')
  assert.equal(restored.result.rows[0].value,'exact query fixture')
  assert(!(await readFile(join(userData,'saved-queries.secure.json'),'utf8')).includes('exact query fixture'))
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // Only test handlers are replaced, in this smoke process. Shipped application code has no mocks.
  await application.evaluate(({ ipcMain }) => {
    const fixture = { id: 'smoke', name: 'Smoke MySQL', kind: 'mysql', host: 'localhost', port: 3306, sshEnabled: false, tlsEnabled: false }
    const handlers = {
      'connections:list': () => [fixture],
      'connections:connect-saved': () => ({ ...fixture, displayHost: 'localhost', writable: false, transaction: false }),
      'explorer:roots': () => [{ id: 'db', label: 'smoke', kind: 'database', database: 'smoke' }],
      'sessions:execute': () => ({ columns: ['value'], rows: [{ value: '1' }], durationMs: 1 }),
    }
    for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
  })
  await page.reload()
  // The top toolbar exposes settings only. Language changes go through the
  // real preferences dialog and must persist after reload.
  assert.equal(await page.locator('.top-actions > *').count(), 1)
  const settings=page.locator('.preferences-button')
  const prefs=page.locator('.preferences-dialog')
  const select=prefs.locator('[data-preference="language"]')
  const save=prefs.locator('[data-action="save-preferences"]')
  await settings.click()
  await select.waitFor({state:'visible'})
  assert.equal(await select.inputValue(),'system')
  assert.equal(await select.locator('option').count(),15)
  const systemLocale=await page.evaluate(()=>window.dbex.getSystemLanguage())
  assert.equal(typeof systemLocale,'string')
  assert(systemLocale.length>0)
  assert(await page.locator('html').getAttribute('lang'))
  await select.selectOption('en')
  await save.click()
  await page.waitForFunction(()=>document.documentElement.lang==='en')
  await page.getByRole('button',{name:'+ New connection',exact:true}).waitFor({state:'visible'})
  await settings.click()
  await select.selectOption('zh-CN')
  await save.click()
  await page.waitForFunction(()=>document.documentElement.lang==='zh-CN')
  await page.reload()
  await page.waitForFunction(()=>document.documentElement.lang==='zh-CN')
  await settings.click()
  assert.equal(await select.inputValue(),'zh-CN')
  await prefs.getByRole('button',{name:'取消',exact:true}).click()
  await page.locator('.connection-item').filter({ hasText: 'Smoke MySQL' }).getByTitle('连接', { exact: true }).click()
  await page.getByRole('button', { name: 'SQL 编辑器', exact: true }).click()
  await page.locator('.query-editor .monaco-editor').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: /运行选中/ }).click()
  await page.locator('.workbench:visible .data-table tbody tr').first().waitFor()
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: 'electron-smoke.png', fullPage: true })
  console.log(`${packaged ? 'Packaged' : 'Built'} Electron smoke passed: desktop launch, sandbox, real preload IPC, Monaco and query UI`)
} finally {
  if (application) await application.close()
  await rm(userData, { recursive: true, force: true })
}
