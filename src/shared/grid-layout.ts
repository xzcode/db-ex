export interface GridLayout {order:string[];hidden:string[];pinned:string[];widths:Record<string,number>}
export function normalizeGridLayout(value:unknown,fields:readonly string[]):GridLayout{
 const v=value&&typeof value==='object'&&!Array.isArray(value)?value as Partial<GridLayout>:{}
 const valid=new Set(fields),list=(raw:unknown)=>Array.isArray(raw)?[...new Set(raw.filter((x):x is string=>typeof x==='string'&&valid.has(x)))]:[]
 const order=[...new Set([...list(v.order),...fields])],hidden=list(v.hidden),pinned=list(v.pinned)
 if(fields.length&&fields.every(f=>hidden.includes(f)))hidden.splice(hidden.indexOf(order[0]!),1)
 const widths:Record<string,number>=Object.create(null)
 for(const [k,w] of Object.entries(v.widths||{}))if(valid.has(k)&&typeof w==='number'&&Number.isFinite(w))widths[k]=Math.max(52,Math.min(1600,Math.round(w)))
 return {order,hidden,pinned,widths}
}
export function visibleGridColumns(layout:GridLayout){return [...layout.order.filter(c=>layout.pinned.includes(c)),...layout.order.filter(c=>!layout.pinned.includes(c))].filter(c=>!layout.hidden.includes(c))}
export interface GridPoint {row:number;column:number}
export function gridRange(a:GridPoint,b:GridPoint){return {top:Math.min(a.row,b.row),bottom:Math.max(a.row,b.row),left:Math.min(a.column,b.column),right:Math.max(a.column,b.column)}}
export function tsvCell(text:string){return /[\t\r\n"]/.test(text)?'"'+text.replaceAll('"','""')+'"':text}
