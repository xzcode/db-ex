import type { LanguagePreference } from './i18n'
import { isLanguagePreference } from './i18n'
export const toolNames=['mongosh','mongodump','mongorestore','mongoimport','mongoexport','mysql','mysqldump','redis-cli','sqlite3'] as const
export type ToolName=typeof toolNames[number]
export const nativeToolTasks=['mysql-backup','mysql-restore','mongo-backup','mongo-restore','mongo-export','mongo-import'] as const
export type NativeToolTask=typeof nativeToolTasks[number]
export const syntaxRoles=['foreground','keyword','comment','string','number','background'] as const
export type SyntaxRole=typeof syntaxRoles[number]
export const editorFonts=['default','Menlo','Monaco','Consolas','Courier New','SFMono-Regular','Liberation Mono'] as const
export const gridFonts=['default','system-ui','Menlo','Consolas','Courier New'] as const
export interface EditorPreferences {
  lineNumbers:boolean; folding:boolean; brackets:boolean; syntax:boolean; insertSpaces:boolean; tabSize:number; wordWrap:boolean;
  fontFamily:typeof editorFonts[number]; fontSize:number; maxHighlightMB:number; customColors:boolean; colors:Record<SyntaxRole,string>
}
export interface AppPreferences {
  theme:'dark'|'light'|'system'; language:LanguagePreference; alwaysShowTabs:boolean;
  startup:'welcome'|'lastConnection'|'workspace'; completion:boolean; autoCompletion:boolean; firstSuggestion:boolean;
  editor:EditorPreferences;
  records:{ mysqlPageSize:100|200|500; mongoPageSize:100|200|500; sqlitePageSize:100|200|500; fontFamily:typeof gridFonts[number]; fontSize:number; rowHeight:0|26|30|34|40; stripes:0|2|3; recordHistory:boolean };
  recoverySeconds:0|15|30|60|180
}
export interface NativePreferences { tools:Partial<Record<ToolName,string>>; diagnostics:boolean }
export function syntaxDefaults(light:boolean):Record<SyntaxRole,string> {
 return light?{foreground:'#30343b',keyword:'#006dcc',comment:'#858585',string:'#c72545',number:'#07843c',background:'#ffffff'}:{foreground:'#d4d4d4',keyword:'#569cd6',comment:'#82956f',string:'#ce9178',number:'#b5cea8',background:'#1e1e1e'}
}
export function defaultPreferences():AppPreferences{
 return {theme:'dark',language:'system',alwaysShowTabs:true,startup:'welcome',completion:true,autoCompletion:true,firstSuggestion:true,
 editor:{lineNumbers:true,folding:true,brackets:true,syntax:true,insertSpaces:true,tabSize:2,wordWrap:true,fontFamily:'default',fontSize:13,maxHighlightMB:11,customColors:false,colors:syntaxDefaults(false)},
 records:{mysqlPageSize:100,mongoPageSize:200,sqlitePageSize:100,fontFamily:'default',fontSize:12,rowHeight:0,stripes:2,recordHistory:true},recoverySeconds:0}
}
function obj(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function bool(value:unknown,fallback:boolean){return typeof value==='boolean'?value:fallback}
function int(value:unknown,fallback:number,min:number,max:number){return typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max?value:fallback}
function choice<T>(value:unknown,options:readonly T[],fallback:T):T{return options.some(x=>x===value)?value as T:fallback}
export function normalizePreferences(value:unknown):AppPreferences{
 const d=defaultPreferences(),v=obj(value),e=obj(v.editor),r=obj(v.records),c=obj(e.colors)
 const colors={...d.editor.colors}
 for(const key of syntaxRoles){const color=c[key];if(typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color))colors[key]=color.toLowerCase()}
 return {
 theme:choice(v.theme,['dark','light','system'] as const,d.theme),language:isLanguagePreference(v.language)?v.language:d.language,
 alwaysShowTabs:bool(v.alwaysShowTabs,d.alwaysShowTabs),startup:choice(v.startup,['welcome','lastConnection','workspace'] as const,d.startup),
 completion:bool(v.completion,d.completion),autoCompletion:bool(v.autoCompletion,d.autoCompletion),firstSuggestion:bool(v.firstSuggestion,d.firstSuggestion),
 editor:{lineNumbers:bool(e.lineNumbers,d.editor.lineNumbers),folding:bool(e.folding,d.editor.folding),brackets:bool(e.brackets,d.editor.brackets),syntax:bool(e.syntax,d.editor.syntax),insertSpaces:bool(e.insertSpaces,d.editor.insertSpaces),tabSize:int(e.tabSize,2,1,8),wordWrap:bool(e.wordWrap,d.editor.wordWrap),fontFamily:choice(e.fontFamily,editorFonts,'default'),fontSize:int(e.fontSize,13,10,28),maxHighlightMB:int(e.maxHighlightMB,11,1,32),customColors:bool(e.customColors,false),colors},
 records:{mysqlPageSize:choice(r.mysqlPageSize,[100,200,500] as const,100),mongoPageSize:choice(r.mongoPageSize,[100,200,500] as const,200),sqlitePageSize:choice(r.sqlitePageSize,[100,200,500] as const,100),fontFamily:choice(r.fontFamily,gridFonts,'default'),fontSize:int(r.fontSize,12,10,22),rowHeight:choice(r.rowHeight,[0,26,30,34,40] as const,0),stripes:choice(r.stripes,[0,2,3] as const,2),recordHistory:bool(r.recordHistory,true)},
 recoverySeconds:choice(v.recoverySeconds,[0,15,30,60,180] as const,0)}
}
export function normalizeNativePreferences(value:unknown):NativePreferences{
 const v=obj(value),raw=obj(v.tools),tools:NativePreferences['tools']={}
 for(const name of toolNames){const path=raw[name];if(typeof path==='string'&&path.length<=4096&&!/[\u0000-\u001f]/.test(path)&&path.trim())tools[name]=path.trim()}
 return {tools,diagnostics:v.diagnostics===true}
}
export function pageSizeFor(p:AppPreferences,kind:string){return kind==='mongodb'?p.records.mongoPageSize:kind==='sqlite'?p.records.sqlitePageSize:p.records.mysqlPageSize}
export function gridRowHeight(p:AppPreferences,mongo:boolean){return Math.max(p.records.rowHeight||(mongo?26:34),p.records.fontSize+10)}
export interface RecoveryDraft { connectionId:string; database:string; entity:string; kind:'mysql-query'|'sqlite-query'|'mongo-pipeline'|'mongo-query'|'redis-command'; text:string; updatedAt?:string }
export function normalizeRecoveryDraft(input:unknown):RecoveryDraft{
 const v=obj(input)
 if(typeof v.connectionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(v.connectionId)||typeof v.database!=='string'||v.database.length>200||typeof v.entity!=='string'||v.entity.length>200||!['mysql-query','sqlite-query','mongo-pipeline','mongo-query','redis-command'].includes(String(v.kind))||typeof v.text!=='string'||v.text.length>100000)throw new Error('INVALID_RECOVERY: 查询草稿参数无效')
 return {connectionId:v.connectionId,database:v.database,entity:v.entity,kind:v.kind as RecoveryDraft['kind'],text:v.text}
}
export function recoveryKey(input:Pick<RecoveryDraft,'connectionId'|'database'|'entity'|'kind'>){return JSON.stringify([input.connectionId,input.database,input.entity,input.kind])}
