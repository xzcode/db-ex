import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NativeCliProcess,prepareNativeCli} from '../src/main/operations/native-cli'
import {newConnectionConfig} from '../src/shared/connection-form'
const executable=process.env.DBEX_SQLITE_CLI
if(!executable)throw new Error('Missing SQLite CLI path')
const dir=await mkdtemp(join(tmpdir(),'dbex-sqlite-cli-fixture-'))
const file=join(dir,'fixture.sqlite')
const controller=new AbortController(),cli=new NativeCliProcess('sqlite',value=>value)
let cleanup:(()=>Promise<void>)|undefined
try{
 await writeFile(file,'',{flag:'wx'})
 const prepared=await prepareNativeCli({...newConnectionConfig('sqlite'),filePath:file},'main')
 cleanup=prepared.cleanup
 await cli.start(executable,prepared.args,controller.signal)
 const send=async(sql:string)=>{
  cli.send(sql)
  for(let i=0;i<100&&cli.snapshot().running;i++)await new Promise(r=>setTimeout(r,50))
  assert.equal(cli.snapshot().running,false);assert.equal(cli.snapshot().closed,false)
 }
 await send('CREATE TABLE notes(id INTEGER PRIMARY KEY, note TEXT)')
 await send('BEGIN')
 await send("INSERT INTO notes VALUES (1,'rollback')")
 await send('ROLLBACK')
 await send('SELECT count(*) FROM notes')
 assert.match(cli.snapshot().output,/(^|\n)0(\n|$)/)
 await send('BEGIN')
 await send("INSERT INTO notes VALUES (2,'committed')")
 await send('COMMIT')
 await send('SELECT note FROM notes WHERE id=2')
 assert.match(cli.snapshot().output,/committed/)
 console.log('Real sqlite3 process: create, begin, rollback, commit and query verified')
}finally{controller.abort();cli.stop();if(cleanup)await cli.finished;await cleanup?.();await rm(dir,{recursive:true,force:true})}
