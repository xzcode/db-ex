import test from 'node:test'
import assert from 'node:assert/strict'
import {defaultPreferences,normalizePreferences,normalizeNativePreferences,gridRowHeight,pageSizeFor,normalizeRecoveryDraft,recoveryKey} from '../src/shared/preferences'
test('preferences retain safe defaults and reject out-of-range settings',()=>{
 const p=normalizePreferences({theme:'system',language:'ja',editor:{tabSize:8,fontSize:99,colors:{keyword:'#ABCDEF',background:'url(evil)'}},records:{mysqlPageSize:500,mongoPageSize:800,rowHeight:26,fontSize:22},recoverySeconds:30})
 assert.equal(p.theme,'system');assert.equal(p.language,'ja');assert.equal(p.editor.tabSize,8);assert.equal(p.editor.fontSize,13)
 assert.equal(p.editor.colors.keyword,'#abcdef');assert.equal(p.editor.colors.background,defaultPreferences().editor.colors.background)
 assert.equal(pageSizeFor(p,'mysql'),500);assert.equal(pageSizeFor(p,'mongodb'),200)
 assert.equal(gridRowHeight(p,true),32);assert.equal(p.recoverySeconds,30)
 assert.deepEqual(normalizeNativePreferences({tools:{mongodump:'/opt/bin/mongodump',fake:'/evil',mongoexport:'bad\0path'},diagnostics:true}),{tools:{mongodump:'/opt/bin/mongodump'},diagnostics:true})
})
test('recovery scope is isolated by connection, database, object and editor mode',()=>{
 const v=normalizeRecoveryDraft({connectionId:'abc',database:'app',entity:'users',kind:'mysql-query',text:'SELECT 1',unused:'secret'})
 assert.equal(v.text,'SELECT 1');assert.equal(Object.hasOwn(v,'unused'),false)
 assert.notEqual(recoveryKey(v),recoveryKey({...v,connectionId:'def'}))
 assert.throws(()=>normalizeRecoveryDraft({...v,connectionId:'../bad'}),/INVALID_RECOVERY/)
 assert.throws(()=>normalizeRecoveryDraft({...v,text:'x'.repeat(100001)}),/INVALID_RECOVERY/)
})
