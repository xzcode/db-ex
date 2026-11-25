<script setup lang="ts">
import { computed,onMounted,ref } from 'vue'
import { t,localize,languages } from '../i18n'
import { preferences,resolvedTheme,savePreferences } from '../preferences'
import { defaultPreferences,normalizePreferences,normalizeNativePreferences,syntaxDefaults,syntaxRoles,editorFonts,gridFonts,toolNames,type NativePreferences,type ToolName,type SyntaxRole } from '../../shared/preferences'
import { bsonPalette,saveBsonPalette } from '../bson-preferences'
import { databasePalettes,saveDatabasePalette } from '../database-color-preferences'
import { bsonTypes,bsonLabel,isBsonType } from '../../shared/bson-types'
import { normalizeBsonPalette,newBsonPalette,typeColor } from '../../shared/bson-palette'
import { databaseTypes,normalizeDatabasePalette,newDatabasePalette,databaseTypeColor,type DatabasePalette } from '../../shared/database-palette'
import ConnectionColorPicker from './ConnectionColorPicker.vue'
defineProps<{connectionBusy?:boolean}>()
const emit=defineEmits<{close:[];createConnection:[]}>()
const tabs=[['general','常规','⚙'],['tabs','选项卡','▣'],['completion','代码补全','⌨'],['editor','编辑器','✎'],['records','记录','▦'],['colors','数据类型配色','◉'],['recovery','自动恢复','↶'],['tools','外部工具','ENV'],['advanced','高级','⚒']] as const
type Tab=typeof tabs[number][0]
const tab=ref<Tab>('general')
const draft=ref(normalizePreferences(preferences.value))
const native=ref<NativePreferences>({tools:{},diagnostics:false})
const status=ref<Partial<Record<ToolName,boolean>>>({})
const versions=ref<Partial<Record<ToolName,string>>>({})
const busy=ref(false), ready=ref(false),error=ref(''),notice=ref(''),logPath=ref('')
const paletteKind=ref<'mongodb'|'mysql'|'redis'|'sqlite'|'mariadb'|'clickhouse'>('mongodb')
const palettes=ref<Record<'mongodb'|'mysql'|'redis'|'sqlite'|'mariadb'|'clickhouse',DatabasePalette>>({
 mongodb:{...normalizeBsonPalette(bsonPalette.value),overrides:{...bsonPalette.value.overrides}},
 mysql:normalizeDatabasePalette('mysql',databasePalettes.value.mysql),mariadb:normalizeDatabasePalette('mariadb',databasePalettes.value.mariadb),redis:normalizeDatabasePalette('redis',databasePalettes.value.redis),sqlite:normalizeDatabasePalette('sqlite',databasePalettes.value.sqlite),clickhouse:normalizeDatabasePalette('clickhouse',databasePalettes.value.clickhouse)
})
const activePalette=computed(()=>palettes.value[paletteKind.value])
const activeTypes=computed<readonly string[]>(()=>paletteKind.value==='mongodb'?bsonTypes:databaseTypes(paletteKind.value))
const selectedType=ref('String')
const activeType=computed(()=>activeTypes.value.includes(selectedType.value)?selectedType.value:activeTypes.value[0]!)
function paletteLabel(value:string){return paletteKind.value==='mongodb'&&isBsonType(value)?t(bsonLabel(value)):value}
function paletteColor(value:string){
 const kind=paletteKind.value
 return kind==='mongodb'&&isBsonType(value)?typeColor(normalizeBsonPalette(activePalette.value),value):kind!=='mongodb'?databaseTypeColor(kind,activePalette.value,value):undefined
}
const colorLabels:Record<SyntaxRole,string>={foreground:'常规',keyword:'关键字',comment:'注释',string:'字符串',number:'数字',background:'背景'}
const colors=computed(()=>draft.value.editor.customColors?draft.value.editor.colors:syntaxDefaults(resolvedTheme(draft.value.theme)==='light'))
function fail(reason:unknown){error.value=reason instanceof Error?reason.message:String(reason)}
async function action(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn()}catch(reason){fail(reason)}finally{busy.value=false}}
function openLogs(){return action(()=>window.dbex.openLogs())}
async function browse(name:ToolName){await action(async()=>{const path=await window.dbex.pickTool(name);if(path){native.value.tools[name]=path;status.value[name]=await window.dbex.checkTool(name,path)}})}
async function version(name:ToolName){await action(async()=>{versions.value[name]=await window.dbex.toolVersion(name,native.value.tools[name]||'')})}
async function check(name:ToolName){await action(async()=>{status.value[name]=await window.dbex.checkTool(name,native.value.tools[name]||'')})}
function reset(){
 const d=defaultPreferences()
 if(tab.value==='general'){draft.value.theme=d.theme;draft.value.language=d.language}
 else if(tab.value==='tabs'){draft.value.alwaysShowTabs=d.alwaysShowTabs;draft.value.startup=d.startup}
 else if(tab.value==='completion'){draft.value.completion=d.completion;draft.value.autoCompletion=d.autoCompletion;draft.value.firstSuggestion=d.firstSuggestion}
 else if(tab.value==='editor'){draft.value.editor=d.editor;draft.value.editor.colors=syntaxDefaults(resolvedTheme(draft.value.theme)==='light')}
 else if(tab.value==='records')draft.value.records=d.records
 else if(tab.value==='colors')palettes.value[paletteKind.value]=paletteKind.value==='mongodb'?{...newBsonPalette(),overrides:{}}:newDatabasePalette()
 else if(tab.value==='recovery')draft.value.recoverySeconds=d.recoverySeconds
 else if(tab.value==='tools'){native.value.tools={};status.value={};versions.value={}}
 else if(tab.value==='advanced')native.value.diagnostics=false
}
function customColorsChanged(){if(draft.value.editor.customColors)draft.value.editor.colors=syntaxDefaults(resolvedTheme(draft.value.theme)==='light')}
async function save(){await action(async()=>{
 await window.dbex.saveNativePreferences(normalizeNativePreferences(native.value))
 savePreferences(normalizePreferences(draft.value))
 saveBsonPalette(normalizeBsonPalette(palettes.value.mongodb));saveDatabasePalette('mysql',palettes.value.mysql);saveDatabasePalette('mariadb',palettes.value.mariadb);saveDatabasePalette('redis',palettes.value.redis);saveDatabasePalette('sqlite',palettes.value.sqlite);saveDatabasePalette('clickhouse',palettes.value.clickhouse)
 emit('close')
})}
onMounted(()=>{void action(async()=>{native.value=normalizeNativePreferences(await window.dbex.getNativePreferences());logPath.value=await window.dbex.logPath();ready.value=true})})
</script>
<template>
  <div class="modal-backdrop preferences-backdrop" @keydown.esc.stop="!busy&&emit('close')">
    <section class="dialog preferences-dialog" role="dialog" aria-modal="true" :aria-label="t('偏好设置')">
      <header class="dialog-header"><h2>{{ t('偏好设置') }}</h2><button class="icon-button" :aria-label="t('关闭')" :disabled="busy" @click="emit('close')">×</button></header>
      <nav class="preferences-tabs"><button v-for="[key,label,icon] in tabs" :key="key" type="button" :class="{active:tab===key}" :aria-pressed="tab===key" :aria-label="t(label)" @click="tab=key"><span class="pref-tab-icon" aria-hidden="true">{{ icon }}</span>{{ t(label) }}</button></nav>
      <div class="preferences-body">
        <div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}</div>
        <div v-if="notice" class="inline-message notice" role="status">{{ localize(notice) }}</div>
        <template v-if="tab==='general'">
          <div class="pref-section-title">{{ t('外观') }}</div>
          <label class="pref-row"><span>{{ t('语言') }}</span><select v-model="draft.language" data-preference="language" :aria-label="t('语言')"><option value="system">{{ t('跟随系统') }}</option><option v-for="language in languages" :key="language.locale" :value="language.locale">{{ language.label }}</option></select></label>
          <label class="pref-row"><span>{{ t('主题') }}</span><select v-model="draft.theme" data-preference="theme" :aria-label="t('主题')"><option value="system">{{ t('跟随系统') }}</option><option value="light">{{ t('浅色主题') }}</option><option value="dark">{{ t('深色主题') }}</option></select></label>
          <div class="pref-section-title">{{ t('连接列表') }}</div>
          <div class="pref-row"><span></span><div><button class="btn secondary" type="button" data-action="create-connection" :disabled="busy||connectionBusy" @click="emit('createConnection')">{{ t('＋ 新建连接') }}</button></div></div>
          <div class="pref-section-title">{{ t('本地数据') }}</div>
          <p class="helper">{{ t('本地优先 · 内置加密') }}</p>
        </template>
        <template v-else-if="tab==='tabs'">
          <label class="pref-row"><span>{{ t('启动画面') }}</span><select v-model="draft.startup" :aria-label="t('启动画面')"><option value="welcome">{{ t('欢迎') }}</option><option value="lastConnection">{{ t('重新打开上次连接') }}</option><option value="workspace">{{ t('恢复工作区') }}</option></select></label>
          <div class="pref-row"><span></span><label class="checkbox-row"><input v-model="draft.alwaysShowTabs" type="checkbox" /> {{ t('始终显示选项卡栏') }}</label></div>
          <p class="helper">{{ t('恢复已保存的连接选项卡，不会自动执行查询或启用写入。') }}</p>
        </template>
        <template v-else-if="tab==='completion'">
          <label class="checkbox-row"><input v-model="draft.completion" type="checkbox" /> {{ t('使用代码补全') }}</label>
          <label class="checkbox-row"><input v-model="draft.autoCompletion" :disabled="!draft.completion" type="checkbox" /> {{ t('输入时自动显示建议') }}</label>
          <label class="checkbox-row"><input v-model="draft.firstSuggestion" :disabled="!draft.completion" type="checkbox" /> {{ t('优先选择第一个建议') }}</label>
          <p class="helper">{{ t('代码补全使用当前编辑器和已读取的字段信息，不额外扫描数据库。') }}</p>
        </template>
        <template v-else-if="tab==='editor'">
          <label class="pref-row"><span>{{ t('高亮与补全大小限制') }}</span><div class="pref-inline"><input v-model.number="draft.editor.maxHighlightMB" type="number" min="1" max="32" :aria-label="t('高亮与补全大小限制')" /> MB</div></label>
          <div class="pref-row"><span>{{ t('显示') }}</span><div class="pref-checks"><label class="checkbox-row"><input v-model="draft.editor.lineNumbers" type="checkbox" /> {{ t('显示行号') }}</label><label class="checkbox-row"><input v-model="draft.editor.folding" type="checkbox" /> {{ t('使用代码折叠') }}</label><label class="checkbox-row"><input v-model="draft.editor.brackets" type="checkbox" /> {{ t('括号高亮') }}</label><label class="checkbox-row"><input v-model="draft.editor.syntax" type="checkbox" /> {{ t('语法高亮') }}</label></div></div>
          <div class="pref-row"><span>{{ t('文本布局') }}</span><div class="pref-checks"><label class="checkbox-row"><input v-model="draft.editor.insertSpaces" type="checkbox" /> {{ t('Tab 插入空格') }}</label><label class="pref-inline">{{ t('制表符宽度') }}<input v-model.number="draft.editor.tabSize" type="number" min="1" max="8" :aria-label="t('制表符宽度')" /></label><label class="checkbox-row"><input v-model="draft.editor.wordWrap" type="checkbox" /> {{ t('自动换行') }}</label></div></div>
          <div class="pref-row"><span>{{ t('字体') }}</span><div class="pref-inline"><select v-model="draft.editor.fontFamily" :aria-label="t('字体')"><option v-for="font in editorFonts" :key="font" :value="font">{{ font==='default'?t('默认字体'):font }}</option></select><label class="pref-inline">{{ t('字号') }}<input v-model.number="draft.editor.fontSize" :aria-label="t('字号')" type="number" min="10" max="28" /></label></div></div>
          <div class="pref-section-title">{{ t('语法颜色') }}</div>
          <label class="checkbox-row"><input v-model="draft.editor.customColors" type="checkbox" @change="customColorsChanged" /> {{ t('自定义语法颜色') }}</label>
          <div class="pref-color-grid"><label v-for="role in syntaxRoles" :key="role"><input v-model="draft.editor.colors[role]" type="color" :disabled="!draft.editor.customColors" :aria-label="t(colorLabels[role])" />{{ t(colorLabels[role]) }}</label></div>
          <div class="pref-section-title">{{ t('预览') }}</div>
          <pre class="pref-preview" :style="{background:colors.background,color:colors.foreground,fontSize:draft.editor.fontSize+'px',fontFamily:draft.editor.fontFamily==='default'?'monospace':draft.editor.fontFamily}"><span :style="{color:colors.comment}">-- SQL Editor Preview</span>
<span :style="{color:colors.keyword}">SELECT</span> name, score
<span :style="{color:colors.keyword}">FROM</span> users
<span :style="{color:colors.keyword}">WHERE</span> score &gt; <span :style="{color:colors.number}">100</span>
  <span :style="{color:colors.keyword}">AND</span> status = <span :style="{color:colors.string}">'active'</span>;</pre>
        </template>
        <template v-else-if="tab==='records'">
          <div class="pref-section-title">{{ t('默认每页记录数') }}</div>
          <label class="pref-row"><span>MySQL</span><select v-model.number="draft.records.mysqlPageSize" aria-label="MySQL"><option v-for="size in [100,200,500]" :key="size" :value="size">{{ size }}</option></select></label>
          <label class="pref-row"><span>ClickHouse</span><select v-model.number="draft.records.clickhousePageSize" aria-label="ClickHouse"><option v-for="size in [100,200,500]" :key="size" :value="size">{{ size }}</option></select></label>
          <label class="pref-row"><span>MariaDB</span><select v-model.number="draft.records.mariadbPageSize" aria-label="MariaDB"><option v-for="size in [100,200,500]" :key="size" :value="size">{{ size }}</option></select></label>
          <label class="pref-row"><span>MongoDB</span><select v-model.number="draft.records.mongoPageSize" aria-label="MongoDB"><option v-for="size in [100,200,500]" :key="size" :value="size">{{ size }}</option></select></label>
          <label class="pref-row"><span>SQLite</span><select v-model.number="draft.records.sqlitePageSize" aria-label="SQLite"><option v-for="size in [100,200,500]" :key="size" :value="size">{{ size }}</option></select></label><div class="pref-section-title">{{ t('结果表格') }}</div>
          <label class="pref-row"><span>{{ t('字体') }}</span><select v-model="draft.records.fontFamily" :aria-label="t('字体')"><option v-for="font in gridFonts" :key="font" :value="font">{{ font==='default'?t('默认字体'):font }}</option></select></label>
          <label class="pref-row"><span>{{ t('字号') }}</span><input v-model.number="draft.records.fontSize" :aria-label="t('字号')" type="number" min="10" max="22" /></label>
          <label class="pref-row"><span>{{ t('行高') }}</span><select v-model.number="draft.records.rowHeight" :aria-label="t('行高')"><option :value="0">{{ t('自动') }}</option><option v-for="size in [26,30,34,40]" :key="size" :value="size">{{ size }} px</option></select></label>
          <label class="pref-row"><span>{{ t('行底纹') }}</span><select v-model.number="draft.records.stripes" :aria-label="t('行底纹')"><option :value="0">{{ t('关闭') }}</option><option :value="2">{{ t('每两行') }}</option><option :value="3">{{ t('每三行') }}</option></select></label>
          <label class="checkbox-row"><input v-model="draft.records.recordHistory" type="checkbox" /> {{ t('保存查询历史') }}</label>
          <p class="helper">{{ t('每页数量适用于新打开的数据对象；现有读取上限和写入确认保持不变。') }}</p>
        </template>
        <template v-else-if="tab==='colors'">
          <label class="pref-row"><span>{{ t('数据库类型') }}</span><select v-model="paletteKind" :aria-label="t('数据库类型')"><option value="mongodb">MongoDB</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="redis">Redis</option><option value="sqlite">SQLite</option><option value="clickhouse">ClickHouse</option></select></label>
          <label class="checkbox-row"><input v-model="activePalette.enabled" type="checkbox" /> {{ t('按类型着色') }}</label><label class="checkbox-row"><input v-model="activePalette.showLabels" type="checkbox" /> {{ t('显示类型标记') }}</label>
          <div class="inspector-type-list"><button v-for="type in activeTypes" :key="type" type="button" :class="['bson-type-option',{selected:activeType===type}]" @click="selectedType=type"><span class="type-swatch" :style="{background:paletteColor(type)||'transparent'}"></span><span>{{ paletteLabel(type) }}</span><small>{{ paletteColor(type)?.toUpperCase()||'—' }}</small></button></div>
          <strong>{{ paletteLabel(activeType) }}</strong><ConnectionColorPicker :model-value="paletteColor(activeType)" group-label="数据类型配色" @update:model-value="activePalette.overrides[activeType]=$event||null" /><button class="btn secondary small" @click="delete activePalette.overrides[activeType]">{{ t('恢复此类型默认颜色') }}</button>
        </template>
        <template v-else-if="tab==='recovery'">
          <label class="pref-row"><span>{{ t('自动保存已修改的查询') }}</span><select v-model.number="draft.recoverySeconds" :aria-label="t('自动保存已修改的查询')"><option :value="0">{{ t('关闭') }}</option><option v-for="seconds in [15,30,60,180]" :key="seconds" :value="seconds">{{ t('每 {0} 秒',[seconds]) }}</option></select></label>
          <p class="helper">{{ t('草稿在本机加密保存，仅恢复编辑内容，不自动运行查询。临时连接不保存草稿。') }}</p>
        </template>
        <template v-else-if="tab==='tools'">
          <div class="pref-section-title">{{ t('可执行文件') }}</div>
          <div v-for="name in toolNames" :key="name" class="tool-path"><label :for="'tool-'+name">{{ name }}</label><input :id="'tool-'+name" :value="native.tools[name]||''" :aria-label="name" spellcheck="false" :disabled="busy" @input="native.tools[name]=($event.target as HTMLInputElement).value;delete status[name];delete versions[name]" /><button class="btn secondary small" :aria-label="t('选择可执行文件')+' '+name" :disabled="busy" @click="browse(name)">…</button><button class="btn secondary small" :disabled="busy||!native.tools[name]" @click="check(name)">{{ t('验证') }}</button><button class="btn secondary small" :disabled="busy||!native.tools[name]" @click="version(name)">--version</button><span v-if="versions[name]" class="tool-version" style="grid-column:2/-1;white-space:pre-wrap;overflow-wrap:anywhere">{{ versions[name] }}</span><span></span><span v-if="status[name]!==undefined" class="tool-status">{{ t(status[name]?'文件可用':'文件不可用') }}</span></div>
          <p class="helper">{{ t('配置工具绝对路径并检查版本。数据库菜单可执行受控导入、导出和备份恢复。') }}</p>
        </template>
        <template v-else>
          <div class="pref-section-title">{{ t('诊断日志') }}</div><label class="checkbox-row"><input v-model="native.diagnostics" type="checkbox" /> {{ t('启用诊断日志') }}</label>
          <div class="pref-log-path">{{ logPath }}</div><button class="btn secondary" :disabled="busy||!ready" @click="openLogs">{{ t('打开日志目录') }}</button>
          <p class="helper">{{ t('日志只记录操作类别、耗时及成功状态，不记录连接地址、查询内容或凭据。') }}</p>
          <div class="pref-section-title">{{ t('本地数据') }}</div><p class="helper">{{ t('所有设置保存在本机，不需要账户或云服务。') }}</p>
        </template>
      </div>
      <footer class="dialog-footer"><button class="btn secondary pref-reset" :disabled="busy||!ready" @click="reset">{{ t('还原默认值') }}</button><button class="btn secondary" :disabled="busy" @click="emit('close')">{{ t('取消') }}</button><button class="btn primary" data-action="save-preferences" :disabled="busy||!ready" @click="save">{{ t('确认') }}</button></footer>
    </section>
  </div>
</template>
