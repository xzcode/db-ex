import test from 'node:test'
import assert from 'node:assert/strict'
import {canActOnColumn,changeColumnSort,mongoSortRules,mongoSortText} from '../src/shared/column-actions'
test('column actions preserve sort priority, avoid duplicate sort fields and clear only sorting',()=>{
 const original=[{field:'a',direction:1 as const},{field:'b',direction:-1 as const}]
 assert.deepEqual(changeColumnSort(original,'a','desc'),[{field:'a',direction:-1},{field:'b',direction:-1}])
 assert.deepEqual(changeColumnSort(original,'c','asc'),[...original,{field:'c',direction:1}])
 assert.deepEqual(changeColumnSort(original,'a','clear'),[])
 assert.equal(original[0]!.direction,1)
 assert.deepEqual(mongoSortRules('{"a":{"$numberInt":"1"},"b":-1}'),original)
 assert.equal(mongoSortText(original),'{"a":1,"b":-1}')
 assert.equal(canActOnColumn('nested.value',true),true)
 assert.equal(canActOnColumn('__proto__.x',true),false)
 assert.equal(canActOnColumn('$bad',true),false)
})
