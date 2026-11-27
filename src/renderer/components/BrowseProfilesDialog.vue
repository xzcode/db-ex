<script setup lang="ts">
import {onMounted,ref} from 'vue'
import {t,localize} from '../i18n'
import type {BrowseProfile,BrowseProfileDraft} from '../../shared/browse-profile'
const props=defineProps<{sessionId:string;database:string;entity:string;draft:BrowseProfileDraft}>()
const emit=defineEmits<{close:[];apply:[profile:BrowseProfile]}>()
const profiles=ref<BrowseProfile[]>([]),name=ref(''),selected=ref(''),busy=ref(false),error=ref('')
async function act(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
async function reload(){profiles.value=await window.dbex.listBrowseProfiles(props.sessionId,props.database,props.entity)}
function choose(p:BrowseProfile){selected.value=p.id;name.value=p.name}
async function save(update=false){await act(async()=>{const p=await window.dbex.saveBrowseProfile(props.sessionId,props.database,props.entity,{...props.draft,name:name.value},update?selected.value:undefined);await reload();choose(p)})}
async function remove(){await act(async()=>{await window.dbex.deleteBrowseProfile(props.sessionId,props.database,props.entity,selected.value);selected.value='';name.value='';await reload()})}
onMounted(()=>void act(reload))
</script>
<template>
 <Teleport to="body"><div class="modal-backdrop"><section class="dialog browse-profiles-dialog" role="dialog" :aria-label="t('浏览配置')">
 <header class="dialog-header"><div><h2>{{t('浏览配置')}}</h2><span class="muted-text">{{database}} / {{entity}}</span></div><button class="icon-button" :disabled="busy" @click="emit('close')">×</button></header>
 <div class="browse-profiles-list"><button v-for="p in profiles" :key="p.id" :class="['browse-profile-row',{active:selected===p.id}]" @click="choose(p)" @dblclick="emit('apply',p)"><strong>{{p.name}}</strong><span>{{new Date(p.updatedAt).toLocaleString()}}</span></button><p v-if="!profiles.length" class="muted-text">{{t('暂无浏览配置')}}</p></div>
 <div class="dialog-body"><label class="field field-wide">{{t('名称')}}<input v-model="name" :disabled="busy" :aria-label="t('名称')" maxlength="200"/></label><p v-if="error" class="inline-message error field-wide">{{localize(error)}}</p></div>
 <footer class="dialog-footer"><button class="btn secondary" :disabled="busy||!name.trim()" @click="save()">{{t('另存当前配置')}}</button><button class="btn secondary" :disabled="busy||!selected||!name.trim()" @click="save(true)">{{t('更新配置')}}</button><button class="btn secondary danger-text" :disabled="busy||!selected" @click="remove">{{t('删除')}}</button><span class="toolbar-spacer"/><button class="btn primary" :disabled="busy||!selected" @click="emit('apply',profiles.find(p=>p.id===selected)!)">{{t('应用配置')}}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>.browse-profiles-dialog{width:min(700px,90vw);max-height:80vh}.browse-profiles-list{max-height:320px;overflow:auto;padding:8px 16px}.browse-profile-row{width:100%;display:flex;justify-content:space-between;text-align:start;padding:8px;border:0;background:transparent;color:var(--text)}.browse-profile-row.active{background:var(--selected)}.browse-profile-row span{color:var(--muted);font-size:12px}</style>
