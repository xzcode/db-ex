<script setup lang="ts">
import { t } from '../i18n'
import Papa from 'papaparse'
import GridColumnSettings from './GridColumnSettings.vue'
import {normalizeGridLayout,visibleGridColumns,gridRange,tsvCell,type GridLayout,type GridPoint} from '../../shared/grid-layout'
import {cellDraftKey,type CellDraft} from '../../shared/grid-edit'
import type { ColumnAction } from '../../shared/column-actions'
import type { SortRule } from '../../shared/browse-filter'
import { preferences } from '../preferences'
import { gridRowHeight } from '../../shared/preferences'
import { bsonLabel, gridBsonType, type BsonTypeBranch, type BsonType } from '../../shared/bson-types'
import { canSafelyEditMongoDocument, mongoFieldFilter } from '../../shared/bson-editor'
import { formatBsonValue, parseBsonDocument } from '../../shared/bson-display'
import { activeTypeColor } from '../../shared/bson-palette'
import { bsonPalette } from '../bson-preferences'
import { databasePalettes } from '../database-color-preferences'
import { databaseTypeColor } from '../../shared/database-palette'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  columns: string[]
  rows: Record<string, unknown>[]
  selected?: number
  selectable?: boolean
  checked?: number[]
  offset?: number
  bsonTypes?: BsonTypeBranch[]
  columnTypes?: string[]
  relationalKind?: 'mysql'|'mariadb'|'clickhouse'
  sqliteTypes?: string[][]
  nullCells?: number[][]
  redisRowTypes?: string[]
  documents?: string[]
  documentMenu?: boolean
  canEditDocument?: boolean
  canAddDocument?: boolean
  canFilterDocument?: boolean
  active?:boolean
  showColors?:boolean
  resizeAll?:boolean
  workspaceTools?:boolean
  layoutScope?:string
  layoutValue?:GridLayout
  columnDetails?:Record<string,{type?:string;comment?:string}>
  exportSelection?:boolean
  exactCell?:(row:number,field:string)=>string|undefined
  editableCellText?:(row:number,field:string)=>string|undefined
  actionColumns?: string[]
  columnSort?: SortRule[]
  inlineCell?:CellDraft
  inlineDrafts?:Record<string,string>
  canInlineEdit?:(row:number,field:string)=>boolean
  canEditColumn?:(field:string)=>boolean
}>(), { selected: -1, selectable: false, checked: () => [], offset: 0, showColors:true })
const emit = defineEmits<{ cellView:[row:number,field:string];stageCells:[drafts:CellDraft[]];exportRows:[indices:number[]];layoutChange:[layout:GridLayout];inlineBegin:[row:number,field:string];inlineInput:[text:string];inlineFinish:[cancel:boolean];columnSelected:[field:string];columnEdit:[field:string]; columnAction:[action:ColumnAction,field:string]; select: [index: number]; open: [index: number]; check: [index: number]; checkAll: []; documentEdit: [index: number]; documentView: [index: number]; documentAction: [action: 'add' | 'copy-value' | 'copy-document' | 'duplicate' | 'delete' | 'null' | 'empty' | 'filter', index: number, field?: string] }>()
const mongo = computed(() => props.bsonTypes !== undefined)
const rowHeight = computed(() => gridRowHeight(preferences.value,mongo.value))
const headerHeight = computed(() => Math.max(mongo.value?28:34,preferences.value.records.fontSize+12))
const gridStyle=computed(()=>({'--record-height':rowHeight.value+'px','--record-header-height':headerHeight.value+'px','--record-font-size':preferences.value.records.fontSize+'px','--record-font':preferences.value.records.fontFamily==='default'?(mongo.value?'inherit':'"SFMono-Regular", Consolas, monospace'):'"'+preferences.value.records.fontFamily+'", sans-serif',...((mongo.value||props.resizeAll||props.workspaceTools)?{width:tableWidth.value+'px'}:{})}))
const OVERSCAN = 6
const scrollHost = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(400)
const virtual = computed(() => props.rows.length > 100)
let observer: ResizeObserver | undefined
let frame = 0
let stopResize: (() => void) | undefined
const rowMenu = ref<{ index: number; x: number; y: number; field?: string }>()
const menuHost = ref<HTMLElement>()
const columnMenu=ref<{field:string;x:number;y:number}>()
const columnMenuHost=ref<HTMLElement>()
const selectedColumn=ref('')
const canUseColumn=(field:string)=>props.actionColumns?.includes(field)===true
function selectColumn(field:string){
 if(canUseColumn(field)||props.canEditColumn?.(field)){selectedColumn.value=field;emit('columnSelected',field)}
}
function beginInline(event:MouseEvent,row:number,field:string){
 if(!props.canInlineEdit?.(row,field))return
 event.preventDefault();event.stopPropagation();emit('inlineBegin',row,field)
}
watch(()=>props.inlineCell?cellDraftKey(props.inlineCell.row,props.inlineCell.field):undefined,async key=>{
 if(!key)return
 await nextTick()
 const element=scrollHost.value?.querySelector<HTMLInputElement>('.inline-grid-input')
 if(element){element.focus();element.select()}
})
function draftText(row:number,field:string){const key=cellDraftKey(row,field);return props.inlineDrafts&&Object.hasOwn(props.inlineDrafts,key)?props.inlineDrafts[key]:undefined}
function isInline(row:number,field:string){return props.inlineCell?.row===row&&props.inlineCell.field===field}

function directionFor(field:string){return props.columnSort?.find(rule=>rule.field===field)?.direction}
function closeColumnMenu(){columnMenu.value=undefined}
async function openColumnMenu(event:MouseEvent|KeyboardEvent,field:string){
  if(!canUseColumn(field))return
  event.preventDefault();event.stopPropagation();closeRowMenu();selectColumn(field)
  const rect=(event.currentTarget as HTMLElement).getBoundingClientRect()
  columnMenu.value={field,x:Math.max(4,Math.min(rect.right-195,window.innerWidth-212)),y:Math.max(4,rect.bottom+3)}
  await nextTick()
  if(columnMenu.value&&columnMenuHost.value){
    columnMenu.value.y=Math.max(4,Math.min(columnMenu.value.y,window.innerHeight-columnMenuHost.value.getBoundingClientRect().height-4))
    columnMenuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true})
  }
}
function columnAction(action:ColumnAction){
  const field=columnMenu.value?.field
  if(!field||!canUseColumn(field))return
  closeColumnMenu();emit('columnAction',action,field)
}
watch(()=>props.columns.join('\u0000'),()=>{if(!props.columns.includes(selectedColumn.value))selectedColumn.value='';closeColumnMenu()})
watch(()=>props.actionColumns,()=>{if(columnMenu.value&&!canUseColumn(columnMenu.value.field))closeColumnMenu()})
watch(()=>props.active,value=>{if(value===false){closeColumnMenu();closeRowMenu()}})
const menuDocument = computed(() => rowMenu.value ? props.documents?.[rowMenu.value.index] : undefined)
const menuMetadata = computed(() => rowMenu.value ? props.bsonTypes?.[rowMenu.value.index] : undefined)
const menuRaw = computed(() => menuDocument.value ? parseBsonDocument(menuDocument.value) : undefined)
const menuHasField = computed(() => !!menuRaw.value && rowMenu.value?.field !== undefined && Object.hasOwn(menuRaw.value, rowMenu.value.field))
const menuCanEdit = computed(() => !!props.canEditDocument && !!menuDocument.value && !!menuRaw.value && Object.hasOwn(menuRaw.value, '_id') && canSafelyEditMongoDocument(menuDocument.value, menuMetadata.value))
const menuCanSetField = computed(() => menuCanEdit.value && menuHasField.value && rowMenu.value?.field !== '_id')
const menuCanFilter = computed(() => !!props.canFilterDocument && !!menuDocument.value && menuHasField.value && !!mongoFieldFilter(menuDocument.value, menuMetadata.value, rowMenu.value!.field!))
function closeRowMenu() { rowMenu.value = undefined }
async function openRowMenu(event: MouseEvent | KeyboardEvent, index: number) {
  if (!props.documentMenu || !props.documents?.[index]) return
  event.preventDefault(); event.stopPropagation()
  closeColumnMenu()
  emit('select', index)
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const mouse = 'clientX' in event
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('td[data-mongo-field]') : null
  rowMenu.value = { index, field: target?.dataset.mongoField, x: Math.max(4, Math.min(mouse ? event.clientX : rect.left + 20, window.innerWidth - 260)), y: Math.max(4, Math.min(mouse ? event.clientY : rect.bottom, window.innerHeight - 100)) }
  await nextTick()
  if (!rowMenu.value || !menuHost.value) return
  rowMenu.value.y = Math.max(4, Math.min(rowMenu.value.y, window.innerHeight - menuHost.value.getBoundingClientRect().height - 4))
  menuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
}
function menuAction(action: 'view' | 'edit' | 'add' | 'copy-value' | 'copy-document' | 'duplicate' | 'delete' | 'null' | 'empty' | 'filter') {
  const menu = rowMenu.value
  if (!menu || !props.documents?.[menu.index]) { closeRowMenu(); return }
  if (['edit','duplicate','delete'].includes(action) && !menuCanEdit.value) return
  if (action === 'add' && !props.canAddDocument) return
  if (['null','empty'].includes(action) && !menuCanSetField.value) return
  if (action === 'copy-value' && !menuHasField.value) return
  if (action === 'filter' && !menuCanFilter.value) return
  closeRowMenu()
  if (action === 'edit') emit('documentEdit', menu.index)
  else if (action === 'view') emit('documentView', menu.index)
  else emit('documentAction', action, menu.index, menu.field)
}
function outside(event: PointerEvent) { if (rowMenu.value && !menuHost.value?.contains(event.target as Node)) closeRowMenu();if(columnMenu.value&&!columnMenuHost.value?.contains(event.target as Node))closeColumnMenu() }
function escapeMenu(event: KeyboardEvent) { if (event.key === 'Escape'){closeRowMenu();closeColumnMenu()} }
watch(() => props.rows,()=>{closeRowMenu();closeColumnMenu();anchor.value=undefined;focus.value=undefined})
watch(() => props.documentMenu, closeRowMenu)
const parsed = computed(() => props.documents?.map(parseBsonDocument) || [])
const layoutKey=computed(()=>props.layoutScope?'dbex.grid-layout.v1:'+props.layoutScope:'')
function readLayout(){try{return normalizeGridLayout(layoutKey.value?JSON.parse(localStorage.getItem(layoutKey.value)||'null'):null,props.columns)}catch{return normalizeGridLayout(null,props.columns)}}
const layout=ref<GridLayout>(readLayout()),settingsOpen=ref(false)
const widths=computed(()=>layout.value.widths)
const displayedColumns=computed(()=>props.workspaceTools?visibleGridColumns(layout.value):props.columns)
function saveLayout(value:GridLayout){
 const next=normalizeGridLayout(value,props.columns)
 if(JSON.stringify(visibleGridColumns(layout.value))!==JSON.stringify(visibleGridColumns(next))){anchor.value=undefined;focus.value=undefined}
 layout.value=next
 if(layoutKey.value)try{localStorage.setItem(layoutKey.value,JSON.stringify(layout.value))}catch{}
 emit('layoutChange',JSON.parse(JSON.stringify(layout.value)))
}
watch([layoutKey,()=>props.columns.join('\0')],()=>{layout.value=readLayout();anchor.value=undefined;focus.value=undefined})
watch(()=>props.layoutValue,v=>{if(v)saveLayout(v)},{deep:true})
const anchor=ref<GridPoint>(),focus=ref<GridPoint>()
const range=computed(()=>anchor.value&&focus.value?gridRange(anchor.value,focus.value):undefined)
const selectionRows=computed(()=>range.value?Array.from({length:range.value.bottom-range.value.top+1},(_,i)=>range.value!.top+i):[])
const rangeCount=computed(()=>range.value?(range.value.bottom-range.value.top+1)*(range.value.right-range.value.left+1):0)
function inRange(row:number,column:number){const r=range.value;return !!r&&row>=r.top&&row<=r.bottom&&column>=r.left&&column<=r.right}
function focusCell(row:number,column:number,extend=false,move=false){
 if(!props.workspaceTools||!props.rows.length||!displayedColumns.value.length)return
 const point={row:Math.max(0,Math.min(props.rows.length-1,row)),column:Math.max(0,Math.min(displayedColumns.value.length-1,column))}
 if(!extend||!anchor.value)anchor.value=point
 focus.value=point;selectedColumn.value='';emit('select',point.row)
 if(move&&scrollHost.value){
  const host=scrollHost.value,top=headerHeight.value+point.row*rowHeight.value
  if(top<host.scrollTop+headerHeight.value)host.scrollTop=Math.max(0,top-headerHeight.value)
  else if(top+rowHeight.value>host.scrollTop+host.clientHeight)host.scrollTop=top+rowHeight.value-host.clientHeight
  scrollTop.value=host.scrollTop
  void nextTick(()=>{const cell=host.querySelector<HTMLElement>('tr[data-row-index="'+point.row+'"] td[data-visible-column="'+point.column+'"]');cell?.scrollIntoView({block:'nearest',inline:'nearest'})})
 }
}
function selectCell(e:MouseEvent,row:number,column:number){if(!props.workspaceTools)return;e.stopPropagation();focusCell(row,column,e.shiftKey);if(!(e.target instanceof HTMLInputElement))scrollHost.value?.focus({preventScroll:true})}
function fullText(row:number,field:string){return draftText(row,field)??props.exactCell?.(row,field)??cellText(props.rows[row]!,row,field)}
function clipboardText(){
 const r=range.value;if(!r)return ''
 const lines:string[]=[]
 for(let row=r.top;row<=r.bottom;row++)lines.push(displayedColumns.value.slice(r.left,r.right+1).map(field=>tsvCell(fullText(row,field))).join('\t'))
 return lines.join('\n')
}
function copyRange(e?:ClipboardEvent){
 if(!range.value)return
 const text=clipboardText()
 if(e?.clipboardData){e.preventDefault();e.clipboardData.setData('text/plain',text)}else void window.dbex.copyText(text).catch(()=>{})
}
function pasteRange(e:ClipboardEvent){
 if(!props.workspaceTools||!focus.value||e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement)return
 const text=e.clipboardData?.getData('text/plain');if(text===undefined)return
 e.preventDefault()
 const parsed=Papa.parse<string[]>(text.replace(/\r?\n$/,''),{delimiter:'\t',skipEmptyLines:false})
 if(parsed.errors.length||!parsed.data.length){emit('stageCells',[]);return}
 const cells:CellDraft[]=[],start=range.value?{row:range.value.top,column:range.value.left}:focus.value
 for(const [r,values] of parsed.data.entries())for(const [c,value] of values.entries()){
  const field=displayedColumns.value[start.column+c],row=start.row+r
  if(!field||row>=props.rows.length){emit('stageCells',[]);return}
  cells.push({row,field,text:value})
 }
 emit('stageCells',cells)
}
function keyGrid(e:KeyboardEvent){
 if(!props.workspaceTools||e.target!==scrollHost.value)return
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();if(props.rows.length&&displayedColumns.value.length){anchor.value={row:0,column:0};focus.value={row:props.rows.length-1,column:displayedColumns.value.length-1}}return}
 if(!focus.value){if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Enter','Tab'].includes(e.key))focusCell(0,0);else return}
 const f=focus.value!
 if(e.key==='F2'||e.key==='Enter'){e.preventDefault();const field=displayedColumns.value[f.column]!;if(props.canInlineEdit?.(f.row,field))emit('inlineBegin',f.row,field);else emit('cellView',f.row,field);return}
 const delta:Record<string,[number,number]>={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0],Tab:[0,e.shiftKey?-1:1]}
 const d=delta[e.key];if(!d)return
 e.preventDefault();let row=f.row+d[0],column=f.column+d[1]
 if(e.key==='Tab'&&column>=displayedColumns.value.length){column=0;row++}else if(e.key==='Tab'&&column<0){column=displayedColumns.value.length-1;row--}
 focusCell(row,column,e.key!=='Tab'&&e.shiftKey,true)
}
async function finishAndAdvance(e:KeyboardEvent,row:number,field:string){
 e.preventDefault();e.stopPropagation();emit('inlineFinish',false);await nextTick()
 if(props.inlineCell)return
 let column=displayedColumns.value.indexOf(field)+(e.shiftKey?-1:1)
 if(column<0){column=displayedColumns.value.length-1;row--}else if(column>=displayedColumns.value.length){column=0;row++}
 focusCell(row,column,false,true)
 const next=focus.value;if(next){const nextField=displayedColumns.value[next.column]!;if(props.canInlineEdit?.(next.row,nextField))emit('inlineBegin',next.row,nextField);else scrollHost.value?.focus()}
}
const search=ref(''),replace=ref(''),searchIndex=ref(-1),showFind=ref(false)
const matches=computed(()=>{if(!search.value)return [];const out:GridPoint[]=[];for(let row=0;row<props.rows.length;row++)for(const [column,field] of displayedColumns.value.entries())if(fullText(row,field).includes(search.value))out.push({row,column});return out})
watch(search,()=>{searchIndex.value=-1})
function nextMatch(){if(!matches.value.length)return;searchIndex.value=(searchIndex.value+1)%matches.value.length;const p=matches.value[searchIndex.value]!;focusCell(p.row,p.column,false,true)}
function replaceMatches(){
 if(!search.value)return
 const drafts:CellDraft[]=[]
 for(const m of matches.value){const field=displayedColumns.value[m.column]!,text=props.editableCellText?.(m.row,field);if(text===undefined){emit('stageCells',[]);return}drafts.push({row:m.row,field,text:(draftText(m.row,field)??text).split(search.value).join(replace.value)})}
 if(drafts.length)emit('stageCells',drafts)
}
function pinStyle(field:string){
 if(!props.workspaceTools||!layout.value.pinned.includes(field))return {}
 const left=(props.selectable?76:38)+displayedColumns.value.slice(0,displayedColumns.value.indexOf(field)).reduce((n,f)=>n+columnWidth(f),0)
 return {position:'sticky' as const,insetInlineStart:left+'px',zIndex:2}
}
const cellRows = computed(() => {
  if (!mongo.value) return []
  return props.rows.map((row, index) => {
    const doc = parsed.value[index]
    const cells: Record<string, { type: BsonType; text: string }> = Object.create(null)
    for (const column of props.columns) {
      const type = gridBsonType(row, props.bsonTypes?.[index], column)
      // Canonical EJSON + actual BSON metadata are separate from the legacy
      // string rows used by CSV and from the original document for editing.
      const value = doc && Object.hasOwn(doc, column) ? doc[column] : row[column]
      cells[column] = { type, text: formatBsonValue(type, value, t).replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, '⇥') }
    }
    return cells
  })
})
function cellText(row: Record<string, unknown>, index: number, key: string): string {
  return cellRows.value[index]?.[key]?.text ?? display(Object.hasOwn(row, key) ? row[key] : undefined)
}
const autoWidths = computed(() => {
  const out: Record<string, number> = Object.create(null)
  for (const column of props.columns) {
    let width = Math.min(310, column.length * 8 + (props.actionColumns?.includes(column)?52:22))
    for (const row of cellRows.value.slice(0, 60)) {
      const cell = row[column]
      if (!cell) continue
      const valueWidth = Math.min(310, [...cell.text.slice(0, 90)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 13 : 7.4), 0) + 20)
      width = Math.max(width, valueWidth + (bsonPalette.value.showLabels ? 74 : 0))
    }
    if(!mongo.value)for(const row of props.rows.slice(0,60))width=Math.max(width,Math.min(310,display(row[column]).length*7.5+20))
    out[column] = Math.max(66, Math.min(400, Math.ceil(width)))
  }
  return out
})
function columnWidth(key: string): number { return widths.value[key] || autoWidths.value[key] || 100 }
const tableWidth = computed(() => (props.selectable?76:38) + displayedColumns.value.reduce((sum, column) => sum + columnWidth(column), 0))
function resizeColumn(event: PointerEvent, key: string) {
  event.preventDefault()
  stopResize?.()
  const x = event.clientX, start = columnWidth(key)
  function move(next: PointerEvent) { widths.value[key] = Math.max(52, Math.min(1000, start + next.clientX - x)) }
  function stop() {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop)
    document.body.classList.remove('resizing'); stopResize = undefined;saveLayout(layout.value)
  }
  stopResize = stop; document.body.classList.add('resizing')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
}
function resizeColumnKey(event: KeyboardEvent, key: string) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') delete widths.value[key]
  else widths.value[key] = Math.max(52, Math.min(1000, columnWidth(key) + (event.key === 'ArrowRight' ? 12 : -12)))
  saveLayout(layout.value)
}

const windowRange = computed(() => {
  if (!virtual.value) return { start: 0, end: props.rows.length }
  const first = Math.max(0, Math.floor((scrollTop.value - headerHeight.value) / rowHeight.value))
  const start = Math.min(Math.max(0, first - OVERSCAN), Math.max(0, props.rows.length - 1))
  const count = Math.ceil(Math.max(rowHeight.value, viewportHeight.value - headerHeight.value) / rowHeight.value)
  return { start, end: Math.min(props.rows.length, first + count + OVERSCAN) }
})
const visibleRows = computed(() => props.rows.slice(windowRange.value.start, windowRange.value.end).map((row, index) => ({ row, index: windowRange.value.start + index })))
const topSpace = computed(() => windowRange.value.start * rowHeight.value)
const bottomSpace = computed(() => (props.rows.length - windowRange.value.end) * rowHeight.value)
const columnCount = computed(() => displayedColumns.value.length + (props.selectable ? 2 : 1))

function onScroll() {
  closeRowMenu();closeColumnMenu()
  if (frame) return
  frame = requestAnimationFrame(() => { frame = 0; scrollTop.value = scrollHost.value?.scrollTop || 0 })
}
onMounted(() => {
  window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escapeMenu); window.addEventListener('resize', closeRowMenu);window.addEventListener('resize',closeColumnMenu)
  if (!scrollHost.value) return
  observer = new ResizeObserver(() => { viewportHeight.value = scrollHost.value?.clientHeight || 0 })
  observer.observe(scrollHost.value)
  viewportHeight.value = scrollHost.value.clientHeight
})
watch(() => props.rows, () => {
  scrollTop.value = 0;anchor.value=undefined;focus.value=undefined
  if (scrollHost.value) scrollHost.value.scrollTop = 0
})
onBeforeUnmount(() => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escapeMenu); window.removeEventListener('resize', closeRowMenu);window.removeEventListener('resize',closeColumnMenu); observer?.disconnect(); stopResize?.(); if (frame) cancelAnimationFrame(frame) })

function cellType(row: Record<string, unknown>, index: number, key: string): BsonType | undefined {
  return cellRows.value[index]?.[key]?.type ?? (props.bsonTypes ? gridBsonType(row, props.bsonTypes[index], key) : undefined)
}
function genericType(index: number, column: number): string | undefined {
  if(props.sqliteTypes)return props.sqliteTypes[index]?.[column]||'NULL'
  if (props.columnTypes) return props.nullCells?.[index]?.includes(column) ? 'NULL' : props.columnTypes[column] || 'UNKNOWN'
  if (props.redisRowTypes) return props.redisRowTypes[index] || 'unknown'
  return undefined
}
function gridType(row: Record<string, unknown>, index: number, key: string, column: number): string | undefined { return cellType(row, index, key) || genericType(index, column) }
function gridColor(row: Record<string, unknown>, index: number, key: string, column: number): string | undefined {
  if(props.showColors===false)return undefined
  const bson = cellType(row, index, key)
  if (bson) return activeTypeColor(bsonPalette.value, bson)
  const kind = props.sqliteTypes?'sqlite':props.columnTypes ? (props.relationalKind||'mysql') : props.redisRowTypes ? 'redis' : undefined
  const type = genericType(index, column)
  return kind && type && databasePalettes.value[kind].enabled ? databaseTypeColor(kind, databasePalettes.value[kind], type) : undefined
}
function gridLabel(row: Record<string, unknown>, index: number, key: string, column: number): string {
  const bson = cellType(row, index, key)
  return bson ? t(bsonLabel(bson)) : genericType(index, column) || ''
}
const showTypeLabels = computed(() => mongo.value ? bsonPalette.value.showLabels : props.sqliteTypes?databasePalettes.value.sqlite.showLabels:props.columnTypes ? databasePalettes.value[props.relationalKind||'mysql'].showLabels : props.redisRowTypes ? databasePalettes.value.redis.showLabels : false)
function display(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return '—'
  if (typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, 4096) } catch { return '[Object]' }
  }
  return String(value).slice(0, 4096)
}
</script>

<template>
  <div v-if="workspaceTools" class="grid-tools">
    <button class="btn secondary small" :disabled="!focus" @click="focus&&emit('cellView',focus.row,displayedColumns[focus.column]!)">{{t('字段编辑器')}}</button><button class="btn secondary small" @click="settingsOpen=true">{{t('列管理')}}</button><button class="btn secondary small" @click="showFind=!showFind">{{t('查找替换')}}</button><button class="btn secondary small" :disabled="!rangeCount" @click="copyRange()">{{t('复制选区')}}</button><button v-if="exportSelection" class="btn secondary small" :disabled="!selectionRows.length" @click="emit('exportRows',selectionRows)">{{t('导出所选记录')}}</button><span class="muted-text">{{rangeCount?rangeCount+' '+t('个单元格'):''}}</span>
    <template v-if="showFind"><input v-model="search" :aria-label="t('查找')" :placeholder="t('查找')"/><button class="btn secondary small" :disabled="!matches.length" @click="nextMatch">{{t('查找下一处')}} · {{matches.length}}</button><input v-if="editableCellText" v-model="replace" :aria-label="t('替换为')" :placeholder="t('替换为')"/><button v-if="editableCellText" class="btn secondary small" :disabled="!matches.length" @click="replaceMatches">{{t('暂存当前页替换')}}</button></template>
    <GridColumnSettings v-if="settingsOpen" :fields="columns" :model-value="layout" :details="columnDetails" @update:model-value="saveLayout" @close="settingsOpen=false"/>
  </div>
  <div ref="scrollHost" class="grid-scroll" tabindex="0" :aria-label="t('结果表格')" @scroll.passive="onScroll" @keydown="keyGrid" @copy="copyRange" @paste="pasteRange">
    <table :class="['data-table', 'configured-grid', { 'virtual-grid': virtual, 'mongo-grid': mongo||resizeAll||workspaceTools, 'typed-grid': !!columnTypes || !!redisRowTypes || !!sqliteTypes }]" :style="gridStyle" :aria-rowcount="rows.length + 1" :dir="mongo ? 'ltr' : undefined">
      <colgroup v-if="mongo||resizeAll||workspaceTools"><col v-if="selectable" style="width:38px"/><col style="width: 38px" /><col v-for="column in displayedColumns" :key="column" :style="{ width: columnWidth(column) + 'px' }" /></colgroup>
      <thead><tr>
        <th v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择当前页')" :checked="rows.length > 0 && checked.length === rows.length" @change="emit('checkAll')" /></th>
        <th class="number-cell">#</th><th v-for="column in displayedColumns" :style="pinStyle(column)" :key="column" :title="column" :class="{'column-active':selectedColumn===column,'column-actionable':canUseColumn(column)}" :aria-sort="columnSort?.[0]?.field===column?(directionFor(column)===1?'ascending':'descending'):undefined" @click="selectColumn(column)" @dblclick="canEditColumn?.(column)&&emit('columnEdit',column)" @contextmenu="openColumnMenu($event,column)">
          <div class="grid-heading-content"><span class="grid-column-title">{{ column }}</span><span v-if="directionFor(column)" class="column-sort-indicator" aria-hidden="true">{{ directionFor(column)===1?'↑':'↓' }}<small v-if="(columnSort?.length||0)>1">{{ (columnSort?.findIndex(rule=>rule.field===column)??0)+1 }}</small></span><button v-if="canUseColumn(column)" type="button" class="column-menu-trigger" :title="t('列操作')+': '+column" :aria-label="t('列操作')+': '+column" aria-haspopup="menu" :aria-expanded="columnMenu?.field===column" @click.stop="openColumnMenu($event,column)" @keydown.shift.f10.stop="openColumnMenu($event,column)">···</button></div><span v-if="mongo||resizeAll||workspaceTools" class="grid-column-resize" role="separator" aria-orientation="vertical" :aria-label="t('调整列宽') + ': ' + column" :aria-valuemin="52" :aria-valuemax="1000" :aria-valuenow="columnWidth(column)" tabindex="0" @pointerdown.stop="resizeColumn($event, column)" @keydown.stop="resizeColumnKey($event, column)" @dblclick.stop="delete widths[column];saveLayout(layout)"></span></th>
      </tr></thead>
      <tbody>
        <tr v-if="topSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: topSpace + 'px' }"></td></tr>
        <tr v-for="item in visibleRows" :key="item.index" :data-row-index="item.index" :aria-rowindex="item.index + 2" :class="{ selected: selected === item.index, 'record-stripe': preferences.records.stripes > 0 && (offset + item.index + 1) % preferences.records.stripes === 0 }" @click="selectedColumn='';emit('select', item.index)" @dblclick="emit('open', item.index)" :tabindex="documentMenu ? 0 : undefined" @contextmenu="openRowMenu($event, item.index)" @keydown.shift.f10="openRowMenu($event, item.index)">
          <td v-if="selectable" class="number-cell"><input type="checkbox" :aria-label="t('选择第 {0} 行', [item.index + 1])" :checked="checked.includes(item.index)" @click.stop @change="emit('check', item.index)" /></td>
          <td class="number-cell">{{ offset + item.index + 1 }}</td>
          <td v-for="(column, visibleIndex) in displayedColumns" :data-visible-column="visibleIndex" @click="selectCell($event,item.index,visibleIndex)" :key="column"
            :class="{ 'grid-range-cell':inRange(item.index,visibleIndex),'grid-focus-cell':focus?.row===item.index&&focus?.column===visibleIndex,'grid-search-match':!!search&&fullText(item.index,column).includes(search),'grid-pinned-cell':workspaceTools&&layout.pinned.includes(column),'column-active':selectedColumn===column&&canUseColumn(column), 'inline-draft-cell':draftText(item.index,column)!==undefined, 'inline-editable-cell':!!canInlineEdit?.(item.index,column), 'null-cell': item.row[column] === null || !Object.hasOwn(item.row, column) || cellType(item.row, item.index, column) === 'Null' || cellType(item.row, item.index, column) === 'Undefined' || genericType(item.index, columns.indexOf(column)) === 'NULL', 'has-bson-color': !!gridColor(item.row, item.index, column, columns.indexOf(column)) }"
            :data-mongo-field="documentMenu ? column : undefined"
            :data-grid-field="column" @dblclick="beginInline($event,item.index,column)"
            :data-bson-type="cellType(item.row, item.index, column)"
            :data-value-type="gridType(item.row, item.index, column, columns.indexOf(column))"
            :data-type-color="gridColor(item.row, item.index, column, columns.indexOf(column))"
            :data-bson-color="mongo ? gridColor(item.row, item.index, column, columns.indexOf(column)) : undefined"
            :style="{...pinStyle(column),...(gridColor(item.row, item.index, column, columns.indexOf(column)) ? { '--bson-color': gridColor(item.row, item.index, column, columns.indexOf(column)) } : {})}"
            :title="(gridLabel(item.row, item.index, column, columns.indexOf(column)) ? gridLabel(item.row, item.index, column, columns.indexOf(column)) + ': ' : '') + cellText(item.row, item.index, column)">
            <input v-if="isInline(item.index,column)" class="inline-grid-input" :value="inlineCell?.text" :aria-label="t('编辑')+' '+column" spellcheck="false" @input="emit('inlineInput',($event.target as HTMLInputElement).value)" @click.stop @dblclick.stop @keydown.tab="finishAndAdvance($event,item.index,column)" @keydown.enter.prevent.stop="emit('inlineFinish',false)" @keydown.esc.prevent.stop="emit('inlineFinish',true)" @blur="emit('inlineFinish',false)" />
            <template v-else><span v-if="showTypeLabels && gridType(item.row, item.index, column, columns.indexOf(column))" class="bson-type-label">{{ gridLabel(item.row, item.index, column, columns.indexOf(column)) }}</span><span class="grid-value">{{ draftText(item.index,column) ?? cellText(item.row, item.index, column) }}</span></template>
          </td>
        </tr>
        <tr v-if="bottomSpace" class="virtual-spacer" aria-hidden="true"><td :colspan="columnCount" :style="{ height: bottomSpace + 'px' }"></td></tr>
        <tr v-if="!rows.length"><td :colspan="columnCount" class="empty-grid">{{ t('暂无记录') }}</td></tr>
      </tbody>
    </table>
    <Teleport to="body">
      <div v-if="columnMenu" ref="columnMenuHost" class="connection-context-menu grid-column-menu" role="menu" :style="{left:columnMenu.x+'px',top:columnMenu.y+'px'}" @contextmenu.prevent @pointerdown.stop>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('asc')"><span class="column-menu-symbol" aria-hidden="true">↑</span>{{ t('升序排序') }}</button>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('desc')"><span class="column-menu-symbol" aria-hidden="true">↓</span>{{ t('降序排序') }}</button>
        <button class="context-action" type="button" role="menuitem" :disabled="!columnSort?.length" @click="columnAction('clear')"><span class="column-menu-symbol clear-sort" aria-hidden="true">⊖</span>{{ t('移除所有排序') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" role="menuitem" @click="columnAction('filter')"><span class="column-menu-symbol"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg></span>{{ t('添加筛选') }}</button>
      </div>
      <div v-if="rowMenu" ref="menuHost" class="connection-context-menu mongo-row-menu" :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }" @contextmenu.prevent @pointerdown.stop>
        <button class="context-action" type="button" @click="menuAction('view')">{{ t('查看文档') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanEdit" @click="menuAction('edit')">{{ t('编辑文档') }}…</button>
        <button class="context-action" type="button" :disabled="!canAddDocument" @click="menuAction('add')">{{ t('新增文档') }}…</button>
        <button class="context-action" type="button" :disabled="!menuCanEdit" @click="menuAction('duplicate')">{{ t('复制为新文档') }}…</button>
        <button class="context-action danger" type="button" :disabled="!menuCanEdit" @click="menuAction('delete')">{{ t('删除文档') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" :disabled="!menuHasField" @click="menuAction('copy-value')">{{ t('复制字段值') }}</button>
        <button class="context-action" type="button" @click="menuAction('copy-document')">{{ t('复制完整文档') }}</button>
        <div class="context-menu-divider"></div>
        <button class="context-action" type="button" :disabled="!menuCanSetField" @click="menuAction('null')">{{ t('设为 NULL') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanSetField" @click="menuAction('empty')">{{ t('设为空字符串') }}</button>
        <button class="context-action" type="button" :disabled="!menuCanFilter" @click="menuAction('filter')">{{ t('按此值筛选') }}</button>
        <p v-if="!menuCanEdit" class="context-edit-help">{{ t('编辑需要完整文档和写入权限。') }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.grid-scroll { overflow-anchor: none; }
.virtual-grid thead tr, .virtual-grid tbody tr:not(.virtual-spacer), .virtual-grid tbody tr:not(.virtual-spacer) td { height: 34px; }
.virtual-grid tbody tr:not(.virtual-spacer) td { line-height: 17px; padding-top: 8px; padding-bottom: 8px; }
.virtual-grid .virtual-spacer, .virtual-grid .virtual-spacer td { padding: 0; border: 0; line-height: 0; pointer-events: none; }

.mongo-grid { table-layout: fixed; min-width: 0; }
.mongo-grid th, .mongo-grid td { box-sizing: border-box; min-width: 0; max-width: none; height: 26px; padding: 3px 7px; line-height: 19px; font-family: inherit; font-size: 12px; }
.mongo-grid th { height: 28px; font-weight: 600; color: var(--text); padding-inline-end: 12px; }
.mongo-grid .number-cell { width: 38px; min-width: 0; padding: 2px 4px; }
.mongo-grid .grid-value { white-space: pre; }
.mongo-grid .grid-column-title { display: block; overflow: hidden; text-overflow: ellipsis; }
.grid-column-resize { position: absolute; top: 0; bottom: 0; right: 0; width: 7px; cursor: col-resize; }
.grid-column-resize:hover, .grid-column-resize:focus-visible { background: var(--accent); }
.mongo-grid.virtual-grid thead tr { height: 28px; }
.mongo-grid.virtual-grid tbody tr:not(.virtual-spacer), .mongo-grid.virtual-grid tbody tr:not(.virtual-spacer) td { height: 26px; }
.mongo-grid.virtual-grid tbody tr:not(.virtual-spacer) td { line-height: 19px; padding: 3px 7px; }

.configured-grid.data-table th { height:var(--record-header-height);font-size:var(--record-font-size); }
.configured-grid.data-table tbody tr:not(.virtual-spacer),.configured-grid.data-table tbody tr:not(.virtual-spacer) td { height:var(--record-height);box-sizing:border-box; }
.configured-grid.data-table tbody tr:not(.virtual-spacer) td { font-size:var(--record-font-size);font-family:var(--record-font);padding-top:3px;padding-bottom:3px;line-height:calc(var(--record-font-size) + 4px); }
.configured-grid.data-table tbody tr.record-stripe:not(.selected):not(:hover) td:not(.has-bson-color) { background:color-mix(in srgb,var(--panel-raised) 70%,var(--panel)); }
.grid-tools{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:4px 8px;background:var(--toolbar-bg);border-bottom:1px solid var(--border);flex:none}.grid-tools input{max-width:160px;min-width:80px}.data-table td.grid-range-cell{box-shadow:inset 0 0 0 1px var(--accent);background:color-mix(in srgb,var(--selected) 68%,var(--panel))}.data-table td.grid-focus-cell{outline:2px solid var(--accent);outline-offset:-2px}.data-table td.grid-search-match .grid-value{text-decoration:underline;text-decoration-color:var(--warning);text-decoration-thickness:2px}.data-table td.grid-pinned-cell{background-color:var(--panel-raised)}.grid-tools+.grid-scroll .data-table .number-cell:first-child{position:sticky;inset-inline-start:0;z-index:3;background:var(--header-bg)}.grid-tools+.grid-scroll .data-table th[style*=sticky]{z-index:4!important}
</style>

<style>
.grid-heading-content{user-select:none;-webkit-user-select:none;display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}.grid-heading-content .grid-column-title{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:1}.column-menu-trigger{width:23px;height:22px;flex:none;padding:0;border:0;border-radius:3px;background:transparent;color:var(--accent);font-size:17px;line-height:18px;font-weight:700;opacity:0;cursor:pointer}.column-actionable:hover .column-menu-trigger,.column-active .column-menu-trigger,.column-menu-trigger:focus-visible,.column-menu-trigger[aria-expanded=true]{opacity:1}.column-sort-indicator{flex:none;color:var(--accent);font-size:12px;font-weight:700}.column-sort-indicator small{font-size:9px}.data-table th.column-active{color:var(--text);box-shadow:inset 0 -2px var(--accent)}.data-table tbody td.column-active{background:color-mix(in srgb,var(--accent) 18%,var(--panel));}.data-table tbody tr.selected td.column-active{background:color-mix(in srgb,var(--accent) 28%,var(--panel));}.grid-column-menu{width:208px;z-index:85}.grid-column-menu .context-action{display:flex;align-items:center;gap:9px;padding:8px 10px}.column-menu-symbol{display:inline-flex;width:18px;justify-content:center;align-items:center;font-size:16px;color:var(--muted)}.column-menu-symbol.clear-sort{color:var(--danger)}
.grid-tools{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:4px 8px;background:var(--toolbar-bg);border-bottom:1px solid var(--border);flex:none}.grid-tools input{max-width:160px;min-width:80px}.data-table td.grid-range-cell{box-shadow:inset 0 0 0 1px var(--accent);background:color-mix(in srgb,var(--selected) 68%,var(--panel))}.data-table td.grid-focus-cell{outline:2px solid var(--accent);outline-offset:-2px}.data-table td.grid-search-match .grid-value{text-decoration:underline;text-decoration-color:var(--warning);text-decoration-thickness:2px}.data-table td.grid-pinned-cell{background-color:var(--panel-raised)}.grid-tools+.grid-scroll .data-table .number-cell:first-child{position:sticky;inset-inline-start:0;z-index:3;background:var(--header-bg)}.grid-tools+.grid-scroll .data-table th[style*=sticky]{z-index:4!important}
</style>

<style scoped>
.inline-grid-input{width:100%;min-width:0;height:100%;padding:1px 4px;background:var(--input);color:var(--text);border:1px solid var(--accent);border-radius:0;font:inherit;outline:none}.inline-draft-cell{box-shadow:inset 0 -2px var(--warning)!important;background:color-mix(in srgb,var(--warning) 13%,var(--panel))!important}.inline-editable-cell{cursor:text}
.grid-tools{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:4px 8px;background:var(--toolbar-bg);border-bottom:1px solid var(--border);flex:none}.grid-tools input{max-width:160px;min-width:80px}.data-table td.grid-range-cell{box-shadow:inset 0 0 0 1px var(--accent);background:color-mix(in srgb,var(--selected) 68%,var(--panel))}.data-table td.grid-focus-cell{outline:2px solid var(--accent);outline-offset:-2px}.data-table td.grid-search-match .grid-value{text-decoration:underline;text-decoration-color:var(--warning);text-decoration-thickness:2px}.data-table td.grid-pinned-cell{background-color:var(--panel-raised)}.grid-tools+.grid-scroll .data-table .number-cell:first-child{position:sticky;inset-inline-start:0;z-index:3;background:var(--header-bg)}.grid-tools+.grid-scroll .data-table th[style*=sticky]{z-index:4!important}
</style>
