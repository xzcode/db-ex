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
let application,page
const startupErrors=[]
const observedPages=new WeakSet()
function observePage(candidate){
  if(observedPages.has(candidate))return
  observedPages.add(candidate)
  candidate.on('pageerror',error=>startupErrors.push(String(error.message).slice(0,1500)))
  candidate.on('console',message=>{if(message.type()==='error')startupErrors.push(message.text().slice(0,1500))})
  candidate.on('requestfailed',request=>startupErrors.push('Request failed: '+request.url().slice(0,300)+' · '+request.failure()?.errorText))
  candidate.on('crash',()=>startupErrors.push('Renderer crashed'))
}
async function launch(){
  const app=await electron.launch({
    ...(packaged ? { executablePath: await packagedExecutable() } : {}),
    args: [...(packaged ? [] : ['.']), '--disable-gpu', '--enable-logging=stderr', '--user-data-dir=' + userData],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    timeout: 60000,
  })
  app.on('window',observePage)
  return app
}
async function ready(candidate){
  observePage(candidate)
  await candidate.waitForLoadState('domcontentloaded',{timeout:60000})
  await candidate.locator('.desktop').waitFor({state:'visible',timeout:60000})
  await candidate.waitForFunction(() => typeof window.dbex?.listConnections === 'function',undefined,{timeout:60000})
  return candidate
}
try {
  application=await launch()
  page=await application.firstWindow({timeout:60000})
  await ready(page)
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
  await page.waitForFunction(()=>{const img=document.querySelector('img.brand-symbol');return img?.complete&&img.naturalWidth===64})
  const logo=await page.locator('img.brand-symbol').evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight,loaded:img.complete}))
  assert.deepEqual(logo,{width:64,height:64,loaded:true})
  assert.equal(await page.evaluate(()=>window.dbex.workspaceWindowId),'primary')
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
  // Two real renderer windows must not share session IDs, privileges or recovery drafts.
  const secondWindow=application.waitForEvent('window',{timeout:15000})
  await page.evaluate(()=>window.dbex.newWorkspaceWindow())
  const second=await secondWindow
  await second.waitForFunction(()=>typeof window.dbex?.workspaceWindowId==='string')
  const secondaryId=await second.evaluate(()=>window.dbex.workspaceWindowId)
  assert.notEqual(secondaryId,'primary')
  const isolated=await page.evaluate(async filePath=>window.dbex.connectTemporary({name:'Primary SQLite',kind:'sqlite',host:'',port:0,filePath,ssh:{enabled:false},tls:{enabled:false}}),sqlitePath)
  try{
    assert.equal(await second.evaluate(async id=>{try{await window.dbex.roots(id);return false}catch{return true}},isolated.id),true)
    const secondSession=await second.evaluate(async filePath=>window.dbex.connectTemporary({name:'Secondary SQLite',kind:'sqlite',host:'',port:0,filePath,ssh:{enabled:false},tls:{enabled:false}}),sqlitePath)
    assert.notEqual(secondSession.id,isolated.id)
    assert.equal(await page.evaluate(async id=>{try{await window.dbex.roots(id);return false}catch{return true}},secondSession.id),true)
    const closed=second.waitForEvent('close')
    // Electron may omit additionalArguments from getLastWebPreferences().
    // Use Playwright's actual BrowserWindow handle for this exact renderer.
    const secondaryWindow=await application.browserWindow(second)
    await secondaryWindow.evaluate(win=>win.close())
    await closed
    assert.equal((await page.evaluate(id=>window.dbex.roots(id),isolated.id))[0].database,'main')
  }finally{await page.evaluate(id=>window.dbex.disconnect(id),isolated.id)}
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
  // Exercise actual quit/restart, not a browser reload. Connect a saved
  // fixture in each window and persist separate recovery drafts. No automatic SQL.
  const restartProfile=await page.evaluate(async filePath=>window.dbex.saveConnection({name:'Workspace restart fixture',kind:'sqlite',host:'',port:0,filePath,ssh:{enabled:false},tls:{enabled:false}}),sqlitePath)
  await page.reload()
  await ready(page)
  const rowFor=(target,id)=>target.locator('.connection-item[data-connection-id="'+id+'"]')
  await rowFor(page,restartProfile.id).locator('.row-connect').click()
  await rowFor(page,restartProfile.id).locator('.connection-indicator.online').waitFor()
  const nextWindow=application.waitForEvent('window',{timeout:60000})
  await page.evaluate(()=>window.dbex.newWorkspaceWindow())
  const secondary=await ready(await nextWindow)
  const restartId=await secondary.evaluate(()=>window.dbex.workspaceWindowId)
  await rowFor(secondary,restartProfile.id).locator('.row-connect').click()
  await rowFor(secondary,restartProfile.id).locator('.connection-indicator.online').waitFor()
  const draftScope={connectionId:restartProfile.id,database:'main',entity:'fixture',kind:'sqlite-query'}
  await page.evaluate(scope=>window.dbex.saveRecovery({...scope,text:'SELECT 101'}),draftScope)
  await secondary.evaluate(scope=>window.dbex.saveRecovery({...scope,text:'SELECT 202'}),draftScope)
  assert.equal((await page.evaluate(scope=>window.dbex.loadRecovery({...scope,text:''}),draftScope)).text,'SELECT 101')
  assert.equal((await secondary.evaluate(scope=>window.dbex.loadRecovery({...scope,text:''}),draftScope)).text,'SELECT 202')
  await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('dbex.preferences.v1')||'{}');p.startup='workspace';localStorage.setItem('dbex.preferences.v1',JSON.stringify(p))})
  for(const [target,id] of [[page,'primary'],[secondary,restartId]]){
    await target.waitForFunction(({id,profile})=>JSON.parse(localStorage.getItem(id==='primary'?'dbex.workspace.v1':'dbex.workspace.v1.'+id)||'{}').ids?.includes(profile),{id,profile:restartProfile.id})
  }
  await application.close()
  application=undefined
  const stored=JSON.parse(await readFile(join(userData,'workspace-windows.json'),'utf8'))
  assert(stored.some(w=>w.id==='primary')&&stored.some(w=>w.id===restartId),'both native windows must be persisted')
  application=await launch()
  page=await ready(await application.firstWindow({timeout:60000}))
  await rowFor(page,restartProfile.id).locator('.connection-indicator.online').waitFor({timeout:60000})
  const deadline=Date.now()+60000
  let restoredWindow
  while(Date.now()<deadline&&!restoredWindow){
    for(const candidate of application.windows()){
      if(candidate===page||candidate.isClosed())continue
      try{if(await candidate.evaluate(()=>window.dbex?.workspaceWindowId)===restartId){restoredWindow=candidate;break}}catch{}
    }
    if(!restoredWindow)await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert(restoredWindow,'secondary workspace did not restore')
  await ready(restoredWindow)
  await rowFor(restoredWindow,restartProfile.id).locator('.connection-indicator.online').waitFor({timeout:60000})
  const primarySessionId=await page.locator('.resource-list[data-active-session="true"]').getAttribute('data-resource-session')
  const restoredSessionId=await restoredWindow.locator('.resource-list[data-active-session="true"]').getAttribute('data-resource-session')
  assert(primarySessionId&&restoredSessionId&&primarySessionId!==restoredSessionId)
  assert.equal(await page.locator('.tiny-badge.write,.tiny-badge:has-text("TX")').count(),0)
  assert.equal(await restoredWindow.locator('.tiny-badge.write,.tiny-badge:has-text("TX")').count(),0)
  assert.equal((await page.evaluate(scope=>window.dbex.loadRecovery({...scope,text:''}),draftScope)).text,'SELECT 101')
  assert.equal((await restoredWindow.evaluate(scope=>window.dbex.loadRecovery({...scope,text:''}),draftScope)).text,'SELECT 202')
  assert.equal(await restoredWindow.evaluate(async id=>{try{await window.dbex.roots(id);return false}catch{return true}},primarySessionId),true)
  const restoredClosed=restoredWindow.waitForEvent('close')
  await (await application.browserWindow(restoredWindow)).evaluate(win=>win.close())
  await restoredClosed
  await page.evaluate(async fixture=>{
    await window.dbex.deleteConnection(fixture.id)
    const p=JSON.parse(localStorage.getItem('dbex.preferences.v1')||'{}');p.startup='welcome';localStorage.setItem('dbex.preferences.v1',JSON.stringify(p))
  },restartProfile)
  console.log('Native workspace restart passed: two persisted windows, isolated sessions and drafts, no restored write access')
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
} catch(error) {
  console.error('Desktop smoke diagnostics:',JSON.stringify({errors:startupErrors.slice(-25)}))
  if(page&&!page.isClosed()){
    try{console.error('Renderer startup state:',await page.evaluate(()=>({url:location.href,readyState:document.readyState,bridge:typeof window.dbex,appChildren:document.querySelector('#app')?.childElementCount??-1})))}
    catch{}
    await page.screenshot({path:'electron-smoke.png',timeout:5000}).catch(()=>{})
  }
  throw error
} finally {
  if (application) await application.close()
  await rm(userData, { recursive: true, force: true })
}
