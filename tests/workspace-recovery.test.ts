import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkspace, workspacePosition, matchWorkspaceNode, categoryForNode,validWorkbenchTab } from '../src/shared/workspace-recovery'
import { normalizeRecoveryDraft, recoveryKey } from '../src/shared/preferences'
test('workspace persists only known connection IDs, object identities and supported view tabs',()=>{
 const restored=normalizeWorkspace({ids:['abc','abc','../bad','def'],active:'def',positions:{abc:{tab:'query',node:{database:'main',entity:'users',kind:'table',sql:'DROP TABLE users'},writable:true},def:{tab:'console',node:{database:'0',kind:'keyspace'},password:'synthetic'}}})
 assert.deepEqual(restored.ids,['abc','def'])
 assert.equal(restored.active,'def')
 assert.deepEqual(restored.positions.abc,{tab:'query',node:{database:'main',entity:'users',kind:'table',category:undefined}})
 assert.ok(!JSON.stringify(restored).includes('DROP TABLE'))
 assert.ok(!JSON.stringify(restored).includes('synthetic'))
 assert.equal(validWorkbenchTab('sqlite','console'),'data')
 assert.equal(validWorkbenchTab('mongodb','structure',true),'data')
 assert.equal(validWorkbenchTab('redis','console'),'console')
})
test('restoration matches real explorer object metadata rather than a saved fake object',()=>{
 const node={id:'real',kind:'collection',label:'users',database:'app',entity:'users'} as const
 const saved=workspacePosition(node,'aggregation').node!
 assert.equal(categoryForNode(saved),'collections')
 assert.equal(matchWorkspaceNode([node],saved)?.id,'real')
 assert.equal(matchWorkspaceNode([node],{...saved,entity:'deleted'}),undefined)
 const draft=normalizeRecoveryDraft({connectionId:'abc',database:'app',entity:'users',kind:'record-edit',text:'{"mode":"insert","text":"{}"}'})
 assert.notEqual(recoveryKey(draft),recoveryKey({...draft,kind:'mysql-query'}))
})
