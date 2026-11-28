<script setup lang="ts">
import {computed,ref,onMounted,onBeforeUnmount,watch} from 'vue'
import {t} from '../i18n'
export type QueryLayout='bottom'|'right'|'editor'|'result'
const props=defineProps<{layout:QueryLayout;active?:boolean}>()
const emit=defineEmits<{ 'update:layout':[QueryLayout] }>()
const host=ref<HTMLElement>()
const key='dbex.query-split.v1'
function read(){
 try{const v=JSON.parse(localStorage.getItem(key)||'{}');return {bottom:typeof v.bottom==='number'&&Number.isFinite(v.bottom)?Math.max(.15,Math.min(.85,v.bottom)):.43,right:typeof v.right==='number'&&Number.isFinite(v.right)?Math.max(.15,Math.min(.85,v.right)):.5}}catch{return {bottom:.43,right:.5}}
}
const ratios=ref(read()),size=ref(0),dragging=ref(false)
const horizontal=computed(()=>props.layout==='right')
const direction=computed(()=>horizontal.value?'right':'bottom')
const ratio=computed(()=>ratios.value[direction.value])
const split=computed(()=>props.layout==='bottom'||props.layout==='right')
const firstSize=computed(()=>{
 const available=Math.max(0,size.value-8),minimum=Math.min(horizontal.value?200:100,available*.35)
 return Math.round(Math.max(minimum,Math.min(available-minimum,available*ratio.value)))
})
let observer:ResizeObserver|undefined,stop:(()=>void)|undefined
function measure(){if(host.value){size.value=horizontal.value?host.value.clientWidth:host.value.clientHeight}}
function persist(){try{localStorage.setItem(key,JSON.stringify(ratios.value))}catch{}}
function update(value:number){const available=size.value-8;if(available<=0)return;ratios.value={...ratios.value,[direction.value]:Math.max(.15,Math.min(.85,value/available))}}
function drag(e:PointerEvent){
 if(e.button!==0||!split.value)return
 e.preventDefault();stop?.();measure();dragging.value=true
 const initial=firstSize.value,x=e.clientX,y=e.clientY,rtl=horizontal.value&&document.documentElement.dir==='rtl'
 const move=(event:PointerEvent)=>update(initial+(horizontal.value?(event.clientX-x)*(rtl?-1:1):event.clientY-y))
 function end(){window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);dragging.value=false;document.body.classList.remove('query-resizing');persist();stop=undefined}
 stop=end;document.body.classList.add('query-resizing');window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end)
}
function resizeKey(e:KeyboardEvent){
 const keys=horizontal.value?['ArrowLeft','ArrowRight','Home']:['ArrowUp','ArrowDown','Home']
 if(!keys.includes(e.key))return
 e.preventDefault()
 if(e.key==='Home')ratios.value={...ratios.value,[direction.value]:horizontal.value ? .5 : .43}
 else update(firstSize.value+(e.key==='ArrowDown'||e.key==='ArrowRight'?20:-20)*(horizontal.value&&document.documentElement.dir==='rtl'?-1:1))
 persist()
}
onMounted(()=>{measure();observer=new ResizeObserver(measure);if(host.value)observer.observe(host.value)})
watch(()=>props.layout,()=>{stop?.();measure()})
watch(()=>props.active,active=>{if(active===false)stop?.();else{ratios.value=read();measure()}})
onBeforeUnmount(()=>{stop?.();observer?.disconnect()})
</script>
<template>
 <div ref="host" :class="['query-split',layout,{'query-split-dragging':dragging}]" :style="{'--query-first':firstSize+'px'}">
  <div v-show="layout!=='result'" class="query-split-editor"><slot name="editor"/></div>
  <div v-if="split" class="query-split-handle" role="separator" :aria-label="t('调整查询与结果区域大小')" :aria-orientation="horizontal?'vertical':'horizontal'" :aria-valuemin="15" :aria-valuemax="85" :aria-valuenow="Math.round(ratio*100)" tabindex="0" @pointerdown="drag" @keydown="resizeKey" @dblclick="ratios={...ratios,[direction]:horizontal ? .5 : .43};persist()"><span/></div>
  <div v-show="layout!=='editor'" class="query-split-result"><slot name="result"/></div>
 </div>
</template>
<style scoped>
.query-split{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;flex-direction:column}
.query-split.right{flex-direction:row}
.query-split-editor,.query-split-result{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.query-split.bottom>.query-split-editor,.query-split.right>.query-split-editor{flex:0 0 var(--query-first)}
.query-split-result,.query-split.editor>.query-split-editor{flex:1}
.query-split-editor :deep(.query-editor){height:auto!important;max-height:none!important;min-height:0!important;flex:1!important;resize:none!important;border:0}
.query-split-handle{flex:0 0 8px;display:flex;justify-content:center;align-items:center;background:var(--toolbar-bg);border-block:1px solid var(--border);cursor:row-resize;touch-action:none;user-select:none}
.query-split-handle span{width:34px;height:2px;background:var(--muted);border-radius:3px}
.right>.query-split-handle{cursor:col-resize;border-block:0;border-inline:1px solid var(--border)}
.right>.query-split-handle span{width:2px;height:34px}
.query-split-handle:hover,.query-split-handle:focus-visible,.query-split-dragging>.query-split-handle{background:var(--accent-bg)}
</style>
<style>
body.query-resizing,body.query-resizing *{user-select:none!important}
</style>
