import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSuggestions } from '../src/shared/filter-suggestions'
import type { OperationResult } from '../src/shared/types'
test('suggestions come from actual BSON values and distinguish equal-looking strings and integers',()=>{
  const result:OperationResult={columns:['value'],rows:[{value:'7'},{value:'7'},{value:'7'},{value:'NULL'},{value:'long'}],documents:['{"value":{"$numberInt":"7"}}','{"value":"7"}','{"value":{"$numberInt":"7"}}','{"value":null}','{"value":{"$numberLong":"9223372036854775807"}}'],bsonTypes:[
    {type:'Document',children:{value:'Int32'}},{type:'Document',children:{value:'String'}},{type:'Document',children:{value:'Int32'}},{type:'Document',children:{value:'Null'}},{type:'Document',children:{value:'Int64'}}
  ]}
  assert.deepEqual(filterSuggestions(result,'value',true),[{value:'7',type:'Int32'},{value:'7',type:'String'},{value:'9223372036854775807',type:'Long'}])
  assert.deepEqual(filterSuggestions(result,'missing',true),[])
  assert.deepEqual(filterSuggestions({columns:['id'],rows:[{id:'9223372036854775807'}],rawRows:[{id:'9223372036854775807'}],columnTypes:['BIGINT']},'id',false),[{value:'9223372036854775807',type:'Long'}])
})
