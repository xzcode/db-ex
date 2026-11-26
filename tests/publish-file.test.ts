import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {publishNewFile} from '../src/main/operations/publish-file'
test('atomic publication never replaces an existing output; aborted and invalid sources leave no file',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-publish-file-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const src=join(dir,'stage'),dst=join(dir,'final'),empty=join(dir,'empty')
 await writeFile(src,'complete export')
 await publishNewFile(src,dst)
 assert.equal(await readFile(dst,'utf8'),'complete export')
 const other=join(dir,'stage2');await writeFile(other,'other contents')
 await assert.rejects(()=>publishNewFile(other,dst),/OUTPUT_EXISTS/)
 assert.equal(await readFile(dst,'utf8'),'complete export')
 const controller=new AbortController();controller.abort()
 await assert.rejects(()=>publishNewFile(other,join(dir,'aborted'),controller.signal),/CANCELLED/)
 await writeFile(empty,'')
 await assert.rejects(()=>publishNewFile(empty,join(dir,'empty-denied')),/INVALID_INPUT/)
 await publishNewFile(empty,join(dir,'empty-jsonl'),undefined,true)
 assert.deepEqual((await readdir(dir)).sort(),['empty','empty-jsonl','final','stage','stage2'])
})
