import {link,lstat,open} from 'node:fs/promises'
import {checkAborted} from './common'

/**
 * Stage output in a private sibling directory, then publish with a single
 * no-clobber directory-entry operation. Never substitute a truncating copy
 * or rename if the destination filesystem cannot provide this primitive.
 */
export async function publishNewFile(staged:string,destination:string,signal?:AbortSignal,allowEmpty=false){
 checkAborted(signal)
 const entry=await lstat(staged)
 if(!entry.isFile()||entry.isSymbolicLink()||(!allowEmpty&&entry.size===0))throw new Error('INVALID_INPUT: 数据文件')
 const handle=await open(staged,'r+')
 try{
  const stat=await handle.stat()
  if(!stat.isFile()||stat.dev!==entry.dev||stat.ino!==entry.ino||stat.size!==entry.size)throw new Error('INVALID_INPUT: 数据文件')
  await handle.sync()
 }finally{await handle.close()}
 checkAborted(signal)
 try{await link(staged,destination)}catch(error){
  const code=(error as NodeJS.ErrnoException).code
  if(code==='EEXIST')throw new Error('OUTPUT_EXISTS: 目标文件已存在，不会覆盖')
  if(['EPERM','EOPNOTSUPP','ENOTSUP','EXDEV','ENOSYS'].includes(code||''))throw new Error('OUTPUT_FILESYSTEM: 目标文件系统不支持安全的原子发布，请选择其他磁盘')
  throw error
 }
}
