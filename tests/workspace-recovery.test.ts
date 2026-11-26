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

test('legacy MapReduce workspace restores the database catalog instead',()=>{
 const saved=normalizeWorkspace({ids:['abc'],positions:{abc:{tab:'aggregation',node:{kind:'mongo-category',database:'app',category:'mapReduce'}}}})
 assert.deepEqual(saved.positions.abc,{tab:'data',node:{kind:'database',database:'app'}})
})

test('workspace restores multiple validated object tabs and stable draft identities without write state',()=>{
 const draft={tab:'query',node:{database:'app',kind:'saved-query',draftId:'draft_123',queryMode:'sql',sql:'SECRET SELECT'},writable:true}
 const other={tab:'structure',node:{database:'app',kind:'table',entity:'events'}}
 const result=normalizeWorkspace({ids:['abc'],positions:{abc:{...draft,tabs:[other,draft,other,{tab:'data',node:{kind:'saved-query',database:'app',draftId:'../../bad'}},{tab:'data',node:{kind:'database',database:'app'}}]}}})
 assert.equal(result.positions.abc?.tabs?.length,2)
 assert.equal(result.positions.abc?.node?.draftId,'draft_123')
 assert.equal(result.positions.abc?.tabs?.[0]?.tab,'structure')
 assert(!JSON.stringify(result).includes('SECRET'));assert(!JSON.stringify(result).includes('writable'))
})

import {mergePendingWorkspace,forgetWorkspaceConnection} from '../src/shared/workspace-recovery'
test('temporarily unavailable saved connections retain workspace recovery data until a retry or explicit removal',()=>{
 const pending=normalizeWorkspace({ids:['offline'],active:'offline',positions:{offline:{tab:'query',node:{kind:'table',database:'app',entity:'events'}}}})
 const live=normalizeWorkspace({ids:['online'],active:'online',positions:{online:{tab:'data'}}})
 const recovered=mergePendingWorkspace(live,pending)
 assert.deepEqual(recovered.ids,['online','offline'])
 assert.equal(recovered.positions.offline?.node?.entity,'events')
 assert.equal(recovered.active,'online')
 assert.deepEqual(forgetWorkspaceConnection(recovered,'offline').ids,['online'])
})
