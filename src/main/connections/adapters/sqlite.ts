import type { MysqlOperation } from '../../../shared/types'
import { SqliteClient } from '../../operations/sqlite-client'
import type { DatabaseAdapter } from './types'
import { mysqlActions } from './mysql'

export const sqliteAdapter:DatabaseAdapter={
  kind:'sqlite',
  // Compatibility: the existing relational IPC uses mysql.* action names,
  // but local files cannot create or drop server-level databases.
  actions:mysqlActions.filter(action=>action!=='mysql.createDatabase'&&action!=='mysql.dropDatabase'),
  rollback:{action:'mysql.rollback'},
  async connect({config,sqliteProcessFactory,sqliteModulePath}){
    const operations=new SqliteClient(config.filePath!,sqliteProcessFactory,sqliteModulePath)
    try{await operations.connect()}catch(error){await operations.close().catch(()=>{});throw error}
    return {
      execute:(input,context)=>operations.execute(input as MysqlOperation,context),
      async roots(){return [{id:'db:main',label:'main',kind:'database',database:'main'}]},
      async children(database){if(database!=='main')throw new Error('INVALID_OPERATION: 不支持的操作');return operations.children()},
      close:()=>operations.close().catch(()=>{}),
      transactionActive:()=>operations.transactionActive,
      disconnected:()=>operations.disconnected,
      backupTo:path=>operations.backupTo(path)
    }
  },
  preview(database,entity,offset){return {action:'mysql.browse',database,entity,filter:{join:'and',groups:[],sort:[]},offset,limit:100}}
}
