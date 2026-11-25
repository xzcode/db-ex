import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
test('release lockfile keeps consistent package version and portable public npm tarballs',()=>{
 const pkg=JSON.parse(readFileSync('package.json','utf8'))
 const lock=JSON.parse(readFileSync('package-lock.json','utf8'))
 assert.equal(lock.version,pkg.version)
 assert.equal(lock.packages[''].version,pkg.version)
 for(const [name,entry] of Object.entries(lock.packages) as [string,{resolved?:string;integrity?:string}][]){
   if(entry.resolved){
     assert.match(entry.resolved,/^https:\/\/registry\.npmjs\.org\//,name+' has a nonportable registry address')
     assert.ok(entry.integrity,name+' must have integrity metadata')
   }
 }
})
