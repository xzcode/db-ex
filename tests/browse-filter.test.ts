import test from 'node:test'
import assert from 'node:assert/strict'
import { compileMongoFilter, compileMysqlFilter, browseOffset, newBrowseFilter, type BrowseFilter, type FilterRule } from '../src/shared/browse-filter'
const rule = (field: string, value: string, type: FilterRule['type'] = 'String', operator: FilterRule['operator'] = 'eq'): FilterRule => ({ field, value, type, operator })
test('visual MongoDB filters preserve BSON types and group conditions', () => {
  const input: BrowseFilter = { join:'or', groups:[{join:'and',rules:[rule('score','7','Int32'),rule('id','9223372036854775807','Long')]},{join:'or',rules:[rule('name','a.*','String','contains'),rule('missing','','String','missing')]}], sort:[{field:'score',direction:-1}] }
  const output=compileMongoFilter(input)
  assert.deepEqual(JSON.parse(output.filter), {$or:[{$and:[{score:{$eq:{$numberInt:'7'}}},{id:{$eq:{$numberLong:'9223372036854775807'}}}]},{$or:[{name:{$regex:'a\\.\\*'}},{missing:{$exists:false}}]}]})
  assert.equal(output.sort,'{"score":-1}')
  assert.throws(() => compileMongoFilter({ ...input, groups:[{join:'and',rules:[rule('$where','x')]}] }), /INVALID_FILTER/)
})
test('visual MySQL filters bind values, quote fields and support exact ordered paging', () => {
  const value: BrowseFilter={join:'and',groups:[{join:'or',rules:[rule('name',"x%' OR 1=1 --",'String','contains'),rule('id','9007199254740993','Long')]}],sort:[{field:'id',direction:-1}]}
  const compiled=compileMysqlFilter('app','users',value)
  assert.equal(compiled.sql,'SELECT * FROM \x60app\x60.\x60users\x60 WHERE (\x60name\x60 LIKE ? ESCAPE \'!\' OR \x60id\x60 = CAST(? AS SIGNED)) ORDER BY \x60id\x60 DESC')
  assert.deepEqual(compiled.parameters,["%x!%' OR 1=1 --%",'9007199254740993'])
  assert(!compiled.sql.includes('OR 1=1'))
  assert.match(compiled.countSql,/LIMIT 1000001/)
  assert.throws(() => compileMysqlFilter('app','users',{...newBrowseFilter(),sort:[{field:'id',direction:2}]}),/INVALID_FILTER/)
  assert.equal(browseOffset(3,200),400)
  assert.throws(() => browseOffset(0,200),/INVALID_FILTER/)
  assert.throws(() => browseOffset(1000000,500),/INVALID_FILTER/)
})

test('mixed connectors respect AND precedence and disabled conditions are ignored', () => {
  const input: BrowseFilter = {join:'and',groups:[{join:'and',rules:[
    {...rule('a','x'),join:'or'},
    {...rule('','bad','Int32'),enabled:false,join:'and'},
    {...rule('b','y'),join:'and'},
    rule('c','z')
  ]}],sort:[]}
  assert.deepEqual(JSON.parse(compileMongoFilter(input).filter),{$or:[{a:{$eq:'x'}},{$and:[{b:{$eq:'y'}},{c:{$eq:'z'}}]}]})
  assert.equal(compileMysqlFilter('app','users',input).sql,'SELECT * FROM \x60app\x60.\x60users\x60 WHERE (\x60a\x60 = ? OR (\x60b\x60 = ? AND \x60c\x60 = ?))')
  assert.equal(compileMongoFilter({...input,groups:[{join:'and',rules:[{...rule('','invalid'),enabled:false}]}]}).filter,'{}')
})
test('advanced text, list, type and custom predicates keep typed exactness', () => {
  const one=(value:FilterRule)=>({join:'and' as const,groups:[{join:'and' as const,rules:[value]}],sort:[]})
  const mongo=(value:FilterRule)=>JSON.parse(compileMongoFilter(one(value)).filter)
  assert.deepEqual(mongo(rule('name','a.b','String','starts')),{name:{$regex:'^a\\.b'}})
  assert.deepEqual(mongo(rule('name','x','String','notEnds')),{name:{$type:'string',$not:{$regex:'x$'}}})
  assert.deepEqual(mongo(rule('score','["7","9223372036854775807"]','Long','in')),{score:{$in:[{$numberLong:'7'},{$numberLong:'9223372036854775807'}]}})
  assert.deepEqual(mongo(rule('score','long','String','isType')),{score:{$type:'long'}})
  assert.deepEqual(mongo(rule('score','long','String','notType')),{score:{$exists:true,$not:{$type:'long'}}})
  assert.deepEqual(mongo(rule('score','{"$gte":{"$numberInt":"5"}}','String','custom')),{score:{$gte:{$numberInt:'5'}}})
  assert.throws(()=>mongo(rule('score','{"$where":"return true"}','String','custom')),/INVALID_FILTER/)
  assert.throws(()=>mongo(rule('score','[9223372036854775807]','Long','in')),/INVALID_FILTER/)
  const sql=compileMysqlFilter('app','users',one(rule('name','a%_','String','notStarts')))
  assert.match(sql.sql,/NOT LIKE \? ESCAPE/)
  assert.deepEqual(sql.parameters,['a!%!_%'])
  assert.deepEqual(compileMysqlFilter('app','users',one(rule('id','["1","2"]','Long','notIn'))).parameters,['1','2'])
  assert.throws(()=>compileMysqlFilter('app','users',one(rule('id','int','String','isType'))),/INVALID_FILTER/)
})

test('friendly Number and Custom preserve BSON numeric semantics without evaluating JavaScript',()=>{
  const compile=(type:FilterRule['type'],value:string)=>JSON.parse(compileMongoFilter({join:'and',groups:[{join:'and',rules:[rule('value',value,type)]}],sort:[]}).filter).value.$eq
  assert.deepEqual(compile('Number','19107'),{$numberInt:'19107'})
  assert.deepEqual(compile('Number','9223372036854775807'),{$numberLong:'9223372036854775807'})
  assert.deepEqual(compile('Number','0.25'),{$numberDouble:'0.25'})
  assert.deepEqual(compile('Number','12345678901234567890.1234'),{$numberDecimal:'12345678901234567890.1234'})
  assert.deepEqual(compile('Custom','Long("7")'),{$numberLong:'7'})
  assert.deepEqual(compile('Custom','true'),true)
  assert.deepEqual(compile('Custom','{"x":Int32("1")}'),{x:{$numberInt:'1'}})
  assert.throws(()=>compile('Custom','db.dropDatabase()'),/BSON_EDITOR_INVALID/)
  assert.throws(()=>compile('Custom','1,"other":2'),/INVALID_FILTER/)
  assert.throws(()=>compile('Number','9000abc'),/INVALID_FILTER/)
  assert.throws(()=>compileMysqlFilter('app','users',{join:'and',groups:[{join:'and',rules:[rule('id','1','Number')]}],sort:[]}),/INVALID_FILTER/)
})
