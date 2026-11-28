import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,open,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ParquetRecords,writeParquetRecords} from '../src/main/file-transfer/parquet-records'
import {inspectFile,mapRecord} from '../src/main/file-transfer/records'

test('Parquet preserves native UInt64, fixed-point decimal, binary, nullable text and row groups',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-parquet-'))
 try{
  const path=join(dir,'data.parquet'),signal=new AbortController().signal
  const fields=['id','amount','payload','note','ratio']
  const expected={id:{$dbexInteger:'18446744073709551615'},amount:'-12345678901234567890.12345678',payload:{$dbexBinary:'AP8='},note:null,ratio:{$dbexReal:'2.25'}}
  async function* rows(){for(let i=0;i<1001;i++)yield {...expected,id:i===1000?'18446744073709551615':String(i+1),payload:{$dbexBinary:'AP8='},ratio:2.25}}
  let count=0,bytes=0
  await writeParquetRecords(path,fields,'mysql',[{name:'id',type:'bigint unsigned'},{name:'amount',type:'decimal(30,8)'},{name:'payload',type:'varbinary(100)'},{name:'note',type:'varchar(200)'},{name:'ratio',type:'double'}],rows(),signal,(n,b)=>{count+=n;bytes=b})
  assert.equal(count,1001);assert(bytes>0)
  const {asyncBufferFromFile,parquetMetadataAsync}=await import('hyparquet')
  const metadata=await parquetMetadataAsync(await asyncBufferFromFile(path))
  assert.equal(metadata.num_rows,1001n);assert.equal(metadata.row_groups.length,2)
  assert.equal(metadata.schema[1]?.converted_type,'UINT_64');assert.equal(metadata.schema[2]?.converted_type,'DECIMAL')
  const preview=await inspectFile(path,'parquet',',')
  assert.deepEqual(preview.fields,fields);assert.equal(preview.sample.length,20)
  const handle=await open(path,'r')
  try{let total=0,last:unknown;const reader=await ParquetRecords.open(handle);for await(const row of reader.records()){total++;last=row};assert.equal(total,1001);assert.deepEqual(last,expected)}finally{await handle.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('Parquet SQLite dynamic storage and MongoDB EJSON retain explicit type wrappers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dbex-parquet-'))
 try{
  const path=join(dir,'sqlite.parquet'),signal=new AbortController().signal
  const row={id:{$dbexInteger:'9223372036854775807'},dynamic:{$dbexReal:'2'},blob:{$dbexBinary:'AP8='},text:'中文'}
  async function* source(){yield row}
  await writeParquetRecords(path,Object.keys(row),'sqlite',[{name:'id',type:'INTEGER'},{name:'dynamic',type:''},{name:'blob',type:'BLOB'},{name:'text',type:'TEXT'}],source(),signal,()=>{})
  assert.deepEqual((await inspectFile(path,'parquet',',')).sample,[row])
  const mongo={_id:{$oid:'64b000000000000000000001'},value:{$numberDecimal:'12345678901234567890.12345678'},nested:{long:{$numberLong:'9223372036854775807'}}}
  async function* documents(){yield mongo}
  const m=join(dir,'mongo.parquet')
  await writeParquetRecords(m,Object.keys(mongo),'mongodb',[],documents(),signal,()=>{})
  const preview=await inspectFile(m,'parquet',',')
  assert.deepEqual(preview.sample,[mongo])
  assert.deepEqual({...mapRecord(preview.sample[0]!,{direction:'import',database:'app',entity:'records',format:'parquet',delimiter:',',mapping:Object.keys(mongo).map(field=>({source:field,target:field,conversion:'auto'}))},true)},mongo)
 }finally{await rm(dir,{recursive:true,force:true})}
})
