<script setup lang="ts">
import {computed,ref} from 'vue'
import {t,localize} from '../i18n'
import CodeEditor from './CodeEditor.vue'
import SqlTemporalEditor from './SqlTemporalEditor.vue'
import {sqlTemporalKind,validateSqlTemporal} from '../../shared/sql-temporal'
const props=defineProps<{field:string;type:string;value:string;editable:boolean;exact:boolean;mongo:boolean}>()
const emit=defineEmits<{stage:[value:string,format:'ejson'|'extended'];close:[]}>()
const temporal=!props.mongo&&!!sqlTemporalKind(props.type)
const value=ref(props.value),error=ref(''),mode=ref<'text'|'json'|'hex'|'temporal'>(temporal?'temporal':props.type==='EJSON'||props.type==='JSON'?'json':'text')
const isEjson=computed(()=>props.mongo&&props.type==='EJSON')
const binary=computed(()=>{try{const parsed=JSON.parse(value.value),b=parsed?.$binary;return typeof b?.base64==='string'&&/^[a-f0-9]{2}$/i.test(b.subType)?b:!props.mongo&&typeof parsed?.$dbexBinary==='string'?{base64:parsed.$dbexBinary,subType:'00'}:undefined}catch{return undefined}})
const hex=computed(()=>{try{return binary.value?Array.from(atob(binary.value.base64),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(' '):''}catch{return ''}})
const imageUrl=computed(()=>{const b=binary.value?.base64;if(!b||b.length>2*1024*1024)return '';if(b.startsWith('iVBORw0KGgo'))return 'data:image/png;base64,'+b;if(b.startsWith('/9j/'))return 'data:image/jpeg;base64,'+b;if(b.startsWith('R0lGOD'))return 'data:image/gif;base64,'+b;return ''})
const hexDraft=ref('')
if(binary.value){mode.value='hex';hexDraft.value=hex.value}
function changeMode(next:'text'|'json'|'hex'|'temporal'){if(next==='hex')hexDraft.value=hex.value;mode.value=next}
function copy(){void window.dbex.copyText(mode.value==='hex'?hexDraft.value:value.value)}
function format(){try{value.value=JSON.stringify(JSON.parse(value.value),null,2);error.value=''}catch{error.value='格式无效，请检查 JSON / BSON / SQL 输入'}}
function stage(){
 try{
  let text=value.value
  if(mode.value==='hex'&&binary.value){const raw=hexDraft.value.replace(/\s+/g,'');if(!/^(?:[0-9a-f]{2})*$/i.test(raw))throw new Error('十六进制数据无效');text=JSON.stringify({$binary:{base64:btoa((raw.match(/../g)||[]).map(x=>String.fromCharCode(parseInt(x,16))).join('')),subType:binary.value.subType}})}
  if(temporal)validateSqlTemporal(props.type,text)
  if(isEjson.value||props.type==='JSON')JSON.parse(text)
  emit('stage',text,isEjson.value?'ejson':'extended')
 }catch(e){error.value=e instanceof Error?e.message:String(e)}
}
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog field-value-dialog" role="dialog" :aria-label="t('字段编辑器')">
 <header class="dialog-header"><div><h2>{{field}}</h2><span class="muted-text">{{type}}</span></div><button class="icon-button" @click="emit('close')">×</button></header>
 <div class="editor-toolbar"><button class="btn secondary small" :class="{selected:mode==='text'}" @click="changeMode('text')">{{t('文本')}}</button><button class="btn secondary small" :class="{selected:mode==='json'}" @click="changeMode('json')">JSON / EJSON</button><button v-if="temporal" class="btn secondary small" :class="{selected:mode==='temporal'}" @click="changeMode('temporal')">{{t('日期时间')}}</button><button v-if="binary" class="btn secondary small" :class="{selected:mode==='hex'}" @click="changeMode('hex')">{{t('十六进制')}}</button><button v-if="mode==='json'&&editable" class="btn secondary small" @click="format">{{t('美化语句')}}</button><span class="toolbar-spacer"/><button class="btn secondary small" @click="copy">{{t('复制')}}</button></div>
 <p v-if="!exact" class="inline-message error">{{t('当前仅有预览值；不能据此覆盖完整字段。')}}</p>
 <p v-if="error" class="inline-message error">{{localize(error)}}</p>
 <div class="field-value-body"><div class="field-value-code"><SqlTemporalEditor v-if="mode==='temporal'" v-model="value" :type="type" :readonly="!editable"/><CodeEditor v-else-if="mode!=='hex'" v-model="value" :language="mode==='json'?'json':'plaintext'" :readonly="!editable"/><textarea v-else v-model="hexDraft" spellcheck="false" :readonly="!editable"/></div><img v-if="imageUrl&&mode==='hex'" :src="imageUrl" class="field-image-preview" :alt="t('图片预览')"/></div>
 <footer class="dialog-footer"><button class="btn secondary" @click="emit('close')">{{t('关闭')}}</button><button v-if="editable" class="btn primary" @click="stage">{{t('暂存修改')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.field-value-dialog{width:min(820px,92vw);height:min(640px,85vh);display:flex;flex-direction:column}.field-value-body{display:flex;flex:1;min-height:0;overflow:hidden}.field-value-code{flex:1;min-width:0;min-height:0}.field-value-code textarea{width:100%;height:100%;font:13px monospace;resize:none}.field-image-preview{max-width:42%;object-fit:contain;padding:8px;background:var(--input)}</style>
