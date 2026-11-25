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
