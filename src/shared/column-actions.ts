import type { SortRule } from './browse-filter'
export type ColumnAction='asc'|'desc'|'clear'|'filter'
export function canActOnColumn(field:string,mongo:boolean):boolean{
  if(!field.trim()||field.length>200||/[\u0000-\u001f]/.test(field))return false
  return mongo?!field.split('.').some(part=>!part||part.startsWith('$')||['__proto__','constructor','prototype'].includes(part)):!field.includes('\\')
}
export function changeColumnSort(rules:readonly SortRule[],field:string,action:Exclude<ColumnAction,'filter'>):SortRule[]{
  if(action==='clear')return []
  const direction=action==='asc'?1:-1
  const next=rules.map(rule=>({...rule}))
  const existing=next.find(rule=>rule.field===field)
  if(existing)existing.direction=direction
  else{if(next.length>=32)throw new Error('LIMIT_EXCEEDED: 最多 32 个排序字段');next.push({field,direction})}
  return next
}
export function mongoSortRules(text:string):SortRule[]{
  const value:unknown=JSON.parse(text||'{}')
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_FILTER: 筛选或排序条件无效')
  const entries=Object.entries(value)
  if(entries.length>32)throw new Error('LIMIT_EXCEEDED: 最多 32 个排序字段')
  return entries.map(([field,raw])=>{
    const wrapper=raw&&typeof raw==='object'?raw as Record<string,unknown>:undefined
    const number=wrapper?Number(wrapper.$numberInt??wrapper.$numberLong??wrapper.$numberDouble):raw
    if(!canActOnColumn(field,true)||(number!==1&&number!==-1))throw new Error('INVALID_FILTER: 筛选或排序条件无效')
    return {field,direction:number}
  })
}
export function mongoSortText(rules:readonly SortRule[]):string{
  return JSON.stringify(Object.fromEntries(rules.map(rule=>[rule.field,rule.direction])))
}
