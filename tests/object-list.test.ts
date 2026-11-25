import test from 'node:test'
import assert from 'node:assert/strict'
import {collectionColumns,sortedObjects} from '../src/shared/object-list'
import type {ExplorerNode} from '../src/shared/types'
const fixture=(label:string,value?:string):ExplorerNode=>({id:label,label,kind:'collection',database:'app',entity:label,metrics:value===undefined?undefined:[{label:'文档数',value}]})
test('catalog sorts actual integer metadata, retains exact large values and places unknowns last',()=>{
 const rows=[fixture('ten','10'),fixture('two','2'),fixture('unknown'),fixture('big','9007199254740993'),fixture('less','9007199254740992')]
 const column=collectionColumns[1]!
 assert.deepEqual(sortedObjects(rows,column,1).map(n=>n.label),['two','ten','less','big','unknown'])
 assert.deepEqual(sortedObjects(rows,column,-1).map(n=>n.label),['big','less','ten','two','unknown'])
 assert.deepEqual(sortedObjects(rows,column,1,'tw').map(n=>n.label),['two'])
 assert.equal(rows[0]!.label,'ten')
})
