export interface WorkspaceWindow {id:string;bounds?:{x:number;y:number;width:number;height:number}}
export const PRIMARY_WORKSPACE='primary'
export const isWorkspaceWindowId=(id:unknown):id is string=>id===PRIMARY_WORKSPACE||typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
export function workspaceStorageKey(id:unknown){return id===PRIMARY_WORKSPACE||!isWorkspaceWindowId(id)?'dbex.workspace.v1':'dbex.workspace.v1.'+id}
export function normalizeWorkspaceWindows(input:unknown):WorkspaceWindow[]{
 const list=Array.isArray(input)?input:[],out:WorkspaceWindow[]=[],seen=new Set<string>()
 for(const item of list.slice(0,16)){
  if(!item||typeof item!=='object'||!isWorkspaceWindowId(item.id)||seen.has(item.id))continue
  seen.add(item.id)
  const b=item.bounds
  const bounds=b&&[b.x,b.y,b.width,b.height].every(Number.isSafeInteger)&&Math.abs(b.x)<=100000&&Math.abs(b.y)<=100000&&b.width>=1040&&b.width<=8192&&b.height>=640&&b.height<=8192?{x:b.x,y:b.y,width:b.width,height:b.height}:undefined
  out.push({id:item.id,...(bounds?{bounds}:{})})
  if(out.length>=8)break
 }
 return out
}
