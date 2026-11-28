import {_electron as electron} from 'playwright'
import {DatabaseSync} from 'node:sqlite'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,readdir,stat,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,basename} from 'node:path'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'

const root=await mkdtemp(join(tmpdir(),'dbex-m11-upgrade-'))
const profile=join(root,'profile'),install=join(root,'installed')
const previous=resolve(process.env.DBEX_M11_PREVIOUS_DIR||'')
const next=resolve(process.env.DBEX_M11_CURRENT_DIR||'release')
const previousVersion=process.env.DBEX_M11_PREVIOUS_VERSION||'0.7.0'
assert(/^\d+\.\d+\.\d+$/.test(previousVersion),'Invalid previous release version')
const osName=process.platform==='darwin'?'macOS-ARM64':process.platform==='win32'?'Windows-X64':'Linux-X64'
const appName=process.platform==='darwin'?'DB EX.app':process.platform==='win32'?'DB EX.exe':'db-ex'
let app
function command(bin,args){execFileSync(bin,args,{stdio:'inherit',timeout:180000})}
async function exists(path){try{await access(path);return true}catch{return false}}
async function sha256(file){const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);return hash.digest('hex')}
async function verifiedInstaller(dir,version,extension){
 const names=await readdir(dir)
 const name=names.find(n=>n.startsWith('DB-EX-'+version+'-')&&n.endsWith(extension))
 assert(name,'Missing installer '+version+' '+extension)
 const checksum=names.find(n=>n==='SHA256SUMS-'+osName+'.txt')||'SHA256SUMS.txt'
 const lines=(await readFile(join(dir,checksum),'utf8')).trim().split(/\r?\n/)
 const entry=lines.find(line=>line.slice(66)===name)
 assert(entry&&/^[a-f0-9]{64}  /.test(entry),'Missing installer checksum: '+name)
 const file=join(dir,name)
 assert.equal(await sha256(file),entry.slice(0,64))
 assert((await stat(file)).size>1048576)
 return file
}
async function findExecutable(path,depth=0){
 if(depth>6)return undefined
 for(const entry of await readdir(path,{withFileTypes:true})){
  if(entry.isDirectory()&&entry.name===appName&&process.platform==='darwin')return join(path,entry.name,'Contents','MacOS','DB EX')
  if(entry.isFile()&&entry.name===appName)return join(path,entry.name)
 }
 for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()){
  const found=await findExecutable(join(path,entry.name),depth+1);if(found)return found
 }
}
async function installPackage(dir,version){
 if(process.platform==='darwin'){
  const dmg=await verifiedInstaller(dir,version,'.dmg')
  const mount=join(root,'mounted-'+version)
  const {mkdir}=await import('node:fs/promises');await mkdir(mount)
  command('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg])
  try{
   await rm(join(install,'DB EX.app'),{recursive:true,force:true})
   await mkdir(install,{recursive:true})
   command('ditto',[join(mount,'DB EX.app'),join(install,'DB EX.app')])
  }finally{command('hdiutil',['detach',mount])}
 }else if(process.platform==='win32'){
  const exe=await verifiedInstaller(dir,version,'.exe')
  // NSIS requires /D to be the final argument. CI is a disposable VM.
  command(exe,['/S','/D='+install])
 }else{
  const deb=await verifiedInstaller(dir,version,'.deb')
  // Validate the DEB and upgrade the installed tree in a private prefix;
  // do not modify the machine's package database or global applications.
  command('dpkg-deb',['--info',deb]);command('dpkg-deb',['-x',deb,install])
 }
 const exe=await findExecutable(install)
 assert(exe,'Installed executable missing')
 return exe
}
async function launch(exe){
 app=await electron.launch({executablePath:exe,args:['--disable-gpu','--user-data-dir='+profile],timeout:60000})
 const page=await app.firstWindow({timeout:60000})
 await page.locator('.desktop').waitFor({state:'visible',timeout:60000})
 await page.waitForFunction(()=>typeof window.dbex?.listConnections==='function')
 return page
}
async function close(){if(app){await app.close();app=undefined}}
try{
 if(!process.env.DBEX_M11_PREVIOUS_DIR)throw new Error('DBEX_M11_PREVIOUS_DIR is required')
 const currentVersion=JSON.parse(await readFile('package.json','utf8')).version
 assert(currentVersion!==previousVersion,'Upgrade must use a different version')
 const file=join(root,'数据库 upgrade.sqlite'),seed=new DatabaseSync(file)
 try{seed.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO records VALUES(1,'keep me')")}finally{seed.close()}
 const oldExe=await installPackage(previous,previousVersion)
 let page=await launch(oldExe)
 assert.equal(await app.evaluate(({app})=>app.getVersion()),previousVersion)
 const state=await page.evaluate(async file=>{
  const sqlite=await window.dbex.saveConnection({name:'Upgrade SQLite',kind:'sqlite',host:'',port:0,filePath:file,ssh:{enabled:false},tls:{enabled:false}})
  const sql=await window.dbex.saveConnection({name:'Upgrade encrypted profile',kind:'mysql',host:'localhost',port:3306,username:'fixture',password:'m11-synthetic-only',ssh:{enabled:false},tls:{enabled:false},color:'#abcdef',group:'Upgrade'})
  const session=await window.dbex.connectSaved(sqlite.id)
  let query
  try{
   query=await window.dbex.saveQueryObject(session.id,'main',{draft:{name:'Upgrade query',mode:'sql',text:'SELECT ? AS value',parameters:'["upgrade-preserved"]'}})
  }finally{await window.dbex.disconnect(session.id)}
  await window.dbex.saveRecovery({connectionId:sqlite.id,database:'main',entity:'records',kind:'sqlite-query',text:'SELECT 42 AS draft'})
  localStorage.setItem('dbex.language','en')
  localStorage.setItem('dbex.preferences.v1',JSON.stringify({language:'en',theme:'light',startup:'welcome',recoverySeconds:30}))
  return {sqliteId:sqlite.id,sqlId:sql.id,queryId:query.id}
 },file)
 await close()
 const newExe=await installPackage(next,currentVersion)
 page=await launch(newExe)
 assert.equal(await app.evaluate(({app})=>app.getVersion()),currentVersion)
 await page.waitForFunction(()=>document.documentElement.lang==='en'&&document.documentElement.dataset.theme==='light')
 const actual=await page.evaluate(async state=>{
  const connections=await window.dbex.listConnections(),sql=connections.find(c=>c.id===state.sqlId)
  const edited=await window.dbex.editConnection(state.sqlId)
  const session=await window.dbex.connectSaved(state.sqliteId)
  try{
   const query=await window.dbex.getSavedQuery(session.id,'main',state.queryId)
   const result=await window.dbex.execute(session.id,{action:'mysql.query',database:'main',sql:query.text,parameters:JSON.parse(query.parameters)})
   const data=await window.dbex.execute(session.id,{action:'mysql.query',database:'main',sql:'SELECT note FROM records'})
   const draft=await window.dbex.loadRecovery({connectionId:state.sqliteId,database:'main',entity:'records',kind:'sqlite-query',text:''})
   return {sql,secretFields:edited.secretFields,password:edited.config.password,writable:session.writable,result:result.rows[0]?.value,note:data.rows[0]?.note,draft:draft?.text}
  }finally{await window.dbex.disconnect(session.id)}
 },state)
 assert.equal(actual.sql?.color,'#abcdef');assert.equal(actual.sql?.group,'Upgrade');assert(actual.secretFields.includes('password'));assert.equal(actual.password,undefined);assert.equal(actual.writable,false)
 assert.equal(actual.result,'upgrade-preserved');assert.equal(actual.note,'keep me');assert.equal(actual.draft,'SELECT 42 AS draft')
 if(currentVersion==='1.1.0'){
  // Check the new installed app's real migration IPC and packaged SQLite
  // worker after the old application's profile has been retained. This is
  // a read-only preview; no native confirmation is bypassed.
  const targetFile=join(root,'migration target.sqlite'),target=new DatabaseSync(targetFile)
  try{target.exec('CREATE TABLE renamed(key_id INTEGER PRIMARY KEY, description TEXT)')}finally{target.close()}
  const result=await page.evaluate(async ({sourceId,targetFile})=>{
   const target=await window.dbex.saveConnection({name:'Upgrade migration target',kind:'sqlite',host:'',port:0,filePath:targetFile,ssh:{enabled:false},tls:{enabled:false}})
   const request={source:{connectionId:sourceId,database:'main'},target:{connectionId:target.id,database:'main'},mode:'data',objects:['records'],mappings:[{source:'records',target:'renamed',fields:[{source:'id',target:'key_id',conversion:'auto'},{source:'note',target:'description',conversion:'auto'}],predicate:{text:'id = ?',parameters:[1]}}]}
   const fields=await window.dbex.migrationFields(sourceId,'main','records')
   const plan=await window.dbex.previewMigration(request)
   const template=await window.dbex.saveMigrationTemplate({name:'Upgrade mapping fixture',request})
   return {fields,plan,template}
  },{sourceId:state.sqliteId,targetFile})
  assert.deepEqual(result.fields.map(f=>f.name),['id','note'])
  assert.equal(result.plan.steps.length,1)
  assert.equal(result.plan.steps[0].executable,true)
  assert.equal(result.plan.steps[0].targetName,'renamed')
  const stored=JSON.parse(await readFile(join(profile,'migration-templates.secure.json'),'utf8'))
  assert.equal(stored.version,1);assert.equal(typeof stored.encrypted,'string')
  assert(!JSON.stringify(stored).includes('Upgrade mapping fixture'))
  await close()
  page=await launch(newExe)
  const reopened=await page.evaluate(()=>window.dbex.listMigrationTemplates())
  assert.deepEqual(reopened.find(t=>t.id===result.template.id),result.template)
  const untouched=new DatabaseSync(targetFile)
  try{assert.equal(untouched.prepare('SELECT COUNT(*) AS n FROM renamed').get().n,0)}finally{untouched.close()}
  console.log('M12 installed-app mapped migration preview, encrypted template restart and no implicit target write passed')
 }
 await close()
 if(process.platform==='win32'){
  const uninstall=join(install,'Uninstall DB EX.exe')
  assert(await exists(uninstall),'NSIS uninstaller missing')
  command(uninstall,['/S'])
  for(let i=0;i<30&&await exists(newExe);i++)await new Promise(r=>setTimeout(r,250))
  assert(!(await exists(newExe)),'Uninstaller did not remove executable')
 }else{
  await rm(install,{recursive:true,force:true})
  assert(!(await exists(newExe)))
 }
 // Removing the application must never remove the separate profile/database.
 assert(await exists(file));assert(await exists(join(profile,'connections.secure.json')))
 console.log('M11 upgrade passed: v'+previousVersion+' -> '+currentVersion+' '+osName+', preferences, encrypted connections, saved query, draft, SQLite data, application removal')
}finally{await close().catch(()=>{});await rm(root,{recursive:true,force:true})}
