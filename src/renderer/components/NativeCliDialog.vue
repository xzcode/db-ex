<script setup lang="ts">
import {onBeforeUnmount,ref} from 'vue'
import {t,localize} from '../i18n'
import type {SessionInfo,NativeCliSnapshot} from '../../shared/types'
const props=defineProps<{session:SessionInfo;database:string}>()
const emit=defineEmits<{close:[];session:[SessionInfo]}>()
const state=ref<NativeCliSnapshot>(),sql=ref(''),busy=ref(false),error=ref(''),started=ref(false)
let timer:ReturnType<typeof setInterval>|undefined,disposed=false
async function task(fn:()=>Promise<void>){if(busy.value||disposed)return;busy.value=true;error.value='';try{await fn()}catch(e){if(!disposed)error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function refresh(){if(!started.value||disposed)return;try{state.value=await window.dbex.readNativeCli(props.session.id);if(state.value.closed&&timer)clearInterval(timer)}catch(e){if(timer)clearInterval(timer);if(!disposed)error.value=String(e)}}
async function open(){await task(async()=>{await window.dbex.startNativeCli(props.session.id,props.database);started.value=true;await refresh();timer=setInterval(()=>void refresh(),300)})}
async function unlock(){await task(async()=>emit('session',await window.dbex.setWriteAccess(props.session.id,true)))}
async function send(){if(!sql.value.trim()||state.value?.running||state.value?.closed)return;await task(async()=>{await window.dbex.sendNativeCli(props.session.id,sql.value);sql.value='';await refresh()})}
async function close(){if(timer)clearInterval(timer);await task(async()=>{if(started.value)await window.dbex.stopNativeCli(props.session.id);emit('close')})}
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);if(started.value)void window.dbex.stopNativeCli(props.session.id).catch(()=>{})})
</script>
<template>
 <div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" :aria-label="t('原生数据库 CLI')" style="width:min(1000px,94vw)">
  <header class="dialog-header"><h2>{{t('原生数据库 CLI')}} · {{database}}</h2></header>
  <div class="dialog-body" style="display:flex;flex-direction:column;gap:10px">
   <p class="helper">{{t('独立原生会话；关闭会话不会撤销已提交的操作。')}}</p>
   <p class="helper">{{t('支持单条 SQL 与事务控制，不支持客户端 Shell 命令。输出不保存。')}}</p>
   <p v-if="error" role="alert" class="inline-message error">{{localize(error)}}</p>
   <template v-if="!started"><button v-if="!session.writable" class="btn secondary" :disabled="busy" @click="unlock">{{t('启用写入')}}</button><button class="btn primary" :disabled="busy||!session.writable||session.transaction" @click="open">{{t('确认打开原生数据库 CLI？')}}</button></template>
   <template v-else>
    <div class="muted-text">{{state?.status||'connecting'}}</div>
    <pre aria-label="CLI output" style="height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);padding:10px;margin:0">{{state?.output||''}}</pre>
    <textarea v-model="sql" rows="4" spellcheck="false" aria-label="SQL" :disabled="busy||state?.running||state?.closed" @keydown.ctrl.enter="send" @keydown.meta.enter="send"/>
    <button class="btn primary" :disabled="busy||state?.running||state?.closed||!sql.trim()" @click="send">{{t('执行命令')}}</button>
   </template>
  </div>
  <footer class="dialog-footer"><button class="btn secondary" :disabled="busy" @click="close">{{t('关闭')}}</button></footer>
 </section></div>
</template>
