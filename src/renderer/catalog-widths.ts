import {ref} from 'vue'
import {normalizeCatalogWidths,catalogWidthMin,catalogWidthMax} from '../shared/catalog-widths'
const KEY='dbex.catalog-widths.v1'
function load(){try{return normalizeCatalogWidths(JSON.parse(localStorage.getItem(KEY)||'null'))}catch{return normalizeCatalogWidths(null)}}
export const catalogWidths=ref(load())
export function setCatalogWidth(scope:string,column:string,width?:number){
 const values=load(),fields=values[scope]||Object.create(null)
 if(width===undefined)delete fields[column];else fields[column]=Math.round(Math.max(catalogWidthMin,Math.min(catalogWidthMax,width)))
 values[scope]=fields;catalogWidths.value=values
 try{localStorage.setItem(KEY,JSON.stringify(values))}catch{}
}
window.addEventListener('storage',event=>{if(event.key===KEY)catalogWidths.value=load()})
