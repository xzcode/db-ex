<script setup lang="ts">
import { databaseCapabilities } from '../shared/database-capabilities'
import { t, localize } from './i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ConnectionDialog from './ConnectionDialog.vue'
import ConnectionSidebar from './components/ConnectionSidebar.vue'
import DatabaseIcon from './components/DatabaseIcon.vue'
import ConnectionResourceTree from './components/ConnectionResourceTree.vue'
import { colorStyle } from '../shared/connection-appearance'
import DatabaseWorkbench from './DatabaseWorkbench.vue'
import ObjectList from './components/ObjectList.vue'
import SavedQueryEditor from './components/SavedQueryEditor.vue'
import ClickHouseWorkbench from './components/ClickHouseWorkbench.vue'
import {queryFolder,isQueryFolder,folderQueryMode,savedQueryNode,querySummary,type QueryMode,type QuerySummary} from '../shared/saved-query'
import { mongoCategory, mongoCategoryNodes } from '../shared/mongo-catalog'
import { protectedDatabase } from '../shared/database-admin'
import PreferencesDialog from './components/PreferencesDialog.vue'
import { normalizeWorkspace, workspacePosition, categoryForNode, matchWorkspaceNode, validWorkbenchTab, type WorkspacePosition, type WorkbenchTab } from '../shared/workspace-recovery'
import { preferences, resolvedTheme } from './preferences'
import NativeToolDialog from './components/NativeToolDialog.vue'
import DatabaseActionsDialog from './components/DatabaseActionsDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useConfirmation } from './composables/useConfirmation'
import type { ConnectionAppearancePatch, ConnectionDraft, ExplorerNode, SavedConnection, SessionInfo } from '../shared/types'

interface ObjectTab {node:ExplorerNode;tab?:WorkbenchTab;busy?:boolean;dirty?:boolean;mounted?:boolean}
interface ExplorerState { roots: ExplorerNode[]; children: Record<string, ExplorerNode[]>; expanded: string[]; selected?: ExplorerNode; tab?:WorkbenchTab; busy: boolean; loading: Set<string>; tabs:ObjectTab[]; activeObject?:string; catalog?:ExplorerNode; catalogVisible:boolean; baseBusy?:boolean; baseTab?:WorkbenchTab }
const connections = ref<SavedConnection[]>([])
const sessions = ref<SessionInfo[]>([])
const explorers = reactive<Record<string, ExplorerState>>({})
const current = ref<string | null>(null)
const activeSession = computed(() => sessions.value.find(item => item.id === current.value))
function expandable(node:ExplorerNode) { return isQueryFolder(node)||node.kind==='database' || node.kind==='mongo-category' && !!mongoCategory(node.category)?.expandable }
function nodeIcon(node:ExplorerNode) {
  if(node.kind==='saved-query')return '▤'
  if(node.kind==='query-folder')return '▤'
  if(node.kind==='mongo-category')return mongoCategory(node.category)?.icon||'▦'
  return node.kind==='database'?'▤':node.kind==='view'?'◉':node.kind==='mongo-indexes'?'A–Z':node.kind==='mongo-function'?'ƒ':node.kind==='gridfs-bucket'?'▣':node.kind==='keyspace'?'⬡':'▦'
}
type DatabaseMode='create'|'drop'|'search'|'import'|'export'|'schema'
const dbMenu=ref<{sessionId:string;node?:ExplorerNode;x:number;y:number}>()
const dbMenuHost=ref<HTMLElement>()
const nativeDialog=ref<{sessionId:string;database:string}>()
const nativeSession=computed(()=>sessions.value.find(item=>item.id===nativeDialog.value?.sessionId))
const dbDialog=ref<{sessionId:string;database:string;mode:DatabaseMode}>()
const dbDialogSession=computed(()=>sessions.value.find(item=>item.id===dbDialog.value?.sessionId))
const dbMenuSession=computed(()=>sessions.value.find(item=>item.id===dbMenu.value?.sessionId))
const busy = ref(false)
const error = ref('')
const notice = ref('')
const dialogOpen = ref(false)
const connectionDraft = ref<ConnectionDraft>()
const theme = computed(()=>resolvedTheme(preferences.value.theme))
const preferencesOpen=ref(false)
function settingsKey(event:KeyboardEvent){if((event.metaKey||event.ctrlKey)&&event.key===','){event.preventDefault();if(!dialogOpen.value)preferencesOpen.value=true}}
const sidebarWidth = ref(300)
const { confirmation, confirm, answer } = useConfirmation()
let stopResize: (() => void) | undefined
let restoringWorkspace=true
const workspaceReady=ref(false)
function workspaceSnapshot(){
  const positions:Record<string,WorkspacePosition>=Object.create(null)
  const ids:string[]=[]
  for(const s of sessions.value){
    if(!s.connectionId||ids.includes(s.connectionId))continue
    ids.push(s.connectionId)
    const state=explorers[s.id]
    positions[s.connectionId]={...workspacePosition(state?.selected,state?.tab),tabs:state?.tabs.map(item=>workspacePosition(item.node,item.tab))}
  }
  return normalizeWorkspace({ids,active:activeSession.value?.connectionId,positions})
}
function persistWorkspace(){if(restoringWorkspace)return;try{localStorage.setItem('dbex.workspace.v1',JSON.stringify(workspaceSnapshot()))}catch{}}
watch(workspaceSnapshot,persistWorkspace,{deep:true})
function sessionBusy(state?:ExplorerState){return !!state&&(state.busy||state.loading.size>0||!!state.baseBusy||state.tabs.some(tab=>tab.busy))}
function workbenchTabChanged(id:string,tab:WorkbenchTab,objectId?:string){
 const state=explorers[id];if(!state)return
 if(objectId){const item=state.tabs.find(x=>x.node.id===objectId);if(item)item.tab=tab;if(state.activeObject===objectId)state.tab=tab}
 else{state.baseTab=tab;if(!state.activeObject&&!state.catalogVisible)state.tab=tab}
}
function workbenchBusyChanged(id:string,value:boolean,objectId?:string){
 const state=explorers[id];if(!state)return
 if(objectId){const item=state.tabs.find(x=>x.node.id===objectId);if(item)item.busy=value}
 else state.baseBusy=value
}
function workbenchDirtyChanged(id:string,value:boolean,objectId:string){const item=explorers[id]?.tabs.find(x=>x.node.id===objectId);if(item)item.dirty=value}
function showCatalog(state:ExplorerState,node=state.catalog){
 state.catalog=node;state.catalogVisible=true;state.activeObject=undefined;state.selected=node;state.tab='data'
}
function openObject(state:ExplorerState,node:ExplorerNode,tab?:WorkbenchTab){
 let item=state.tabs.find(x=>x.node.id===node.id||!!node.queryId&&x.node.queryId===node.queryId)
 if(!item){
   if(state.tabs.length>=12){error.value='最多打开 12 个对象标签页，请先关闭不使用的标签页。';return}
   state.tabs.push({node,tab,mounted:!restoringWorkspace});item=state.tabs[state.tabs.length-1]!
 }
 if(!restoringWorkspace)item.mounted=true
 state.activeObject=item.node.id;state.catalogVisible=false;state.selected=item.node;state.tab=item.tab||'data'
}
function activateObject(id:string,node:ExplorerNode){const state=explorers[id];if(!state||sessionBusy(state))return;openObject(state,node)}
function activateCatalog(id:string){const state=explorers[id];if(!state||sessionBusy(state))return;showCatalog(state);if(state.catalog)void loadCatalog(id,state.catalog)}
function catalogNodes(state?:ExplorerState):ExplorerNode[]{return !state?[]:state.catalog?(state.children[state.catalog.id]||[]).filter(node=>state.catalog?.kind!=='database'||node.kind!=='query-folder'):state.roots}
function objectTabTitle(node:ExplorerNode){return node.kind==='mongo-category'||node.kind==='database-query'||node.kind==='query-folder'||node.kind==='saved-query'&&!node.queryId?t(node.label):node.label}
function objectTabTooltip(node:ExplorerNode,session:SessionInfo){return objectTabTitle(node)+(node.database?'@'+node.database:'')+' ('+session.name+')'}
async function closeObject(id:string,objectId:string){
 const state=explorers[id];if(!state||sessionBusy(state))return
 const index=state.tabs.findIndex(x=>x.node.id===objectId);if(index<0)return
 const item=state.tabs[index]!
 if(item.dirty&&!await confirm({title:t('关闭'),message:t('关闭标签页将丢弃未保存的修改。'),danger:false,confirmLabel:t('关闭')}))return
 if(explorers[id]!==state||sessionBusy(state))return
 state.tabs=state.tabs.filter(x=>x.node.id!==objectId)
 if(state.activeObject===objectId){
   const next=state.tabs[Math.max(0,index-1)]
   if(next)openObject(state,next.node)
   else showCatalog(state)
 }
}
async function loadCatalog(id:string,node:ExplorerNode,force=false){
 const state=explorers[id];if(!state||state.loading.has(node.id)||(!force&&state.children[node.id]))return
 state.loading.add(node.id)
 try{
   const session=sessions.value.find(s=>s.id===id)
   if(!session)return
   const database=node.database||node.label
   let children:ExplorerNode[]
   if(isQueryFolder(node))children=session.connectionId?(await window.dbex.listSavedQueries(id,database,folderQueryMode(node))).map(savedQueryNode):[]
   else{
     children=await window.dbex.children(id,database,node.category,true)
     if(node.kind==='database'&&session.kind!=='mongodb'&&session.kind!=='redis')children=[...children,queryFolder(database,session.kind)]
   }
   if(explorers[id]===state)state.children[node.id]=children
 }catch(reason){if(explorers[id]===state)error.value=messageOf(reason)}
 finally{if(explorers[id]===state)state.loading.delete(node.id)}
}
async function refreshCatalog(id:string){
 const state=explorers[id];if(!state||sessionBusy(state))return
 if(state.catalog)await loadCatalog(id,state.catalog,true)
 else await refreshRoots(id)
}
async function restorePosition(session:SessionInfo,position:WorkspacePosition|undefined){
  const state=explorers[session.id]
  if(!state||!position)return
  state.tab=validWorkbenchTab(session.kind,position.tab)
  const desired=position.node
  if(!desired){state.baseTab=state.tab;if(state.tabs.length&&session.kind!=='redis')showCatalog(state);return}
  const root=state.roots.find(n=>n.database===desired.database)
  if(!root)return
  if(desired.kind==='database'){showCatalog(state,root);state.expanded=[...new Set([...state.expanded,root.id])];await loadCatalog(session.id,root);return}
  if(desired.kind==='keyspace'){state.selected=root;state.baseTab=state.tab;return}
  if(desired.kind==='saved-query'&&desired.queryId&&session.connectionId&&session.kind!=='redis'){
    const item=await window.dbex.getSavedQuery(session.id,desired.database,desired.queryId)
    state.catalog=queryFolder(desired.database,session.kind,item.mode)
    openObject(state,savedQueryNode(querySummary(item)),position.tab);return
  }
  if((desired.kind==='query-folder'||desired.kind==='mongo-category'&&(desired.category==='queries'||desired.category==='pipelines'))&&session.kind!=='redis'){
    const folder=queryFolder(desired.database,session.kind,desired.queryMode||(session.kind==='mongodb'?(desired.category==='pipelines'?'mongo-aggregation':'mongo-find'):'sql'))
    showCatalog(state,folder);await loadCatalog(session.id,root);state.expanded=[...new Set([...state.expanded,root.id,folder.id])];await loadCatalog(session.id,folder);return
  }
  if(desired.kind==='database-query'&&databaseCapabilities(session.kind).editor==='query'){openQuery(session.id,desired.database);return}
  if(desired.kind==='saved-query'&&desired.draftId&&session.connectionId&&session.kind!=='redis'){
    const mode=desired.queryMode||(session.kind==='mongodb'?'mongo-find':'sql')
    if((session.kind==='mongodb')===(mode==='sql'))return
    state.catalog=queryFolder(desired.database,session.kind,mode)
    openObject(state,{id:'query-draft:'+desired.draftId,draftId:desired.draftId,kind:'saved-query',label:'未命名查询',database:desired.database,queryMode:mode},position.tab)
    return
  }
  if(desired.kind==='saved-query'){showCatalog(state,root);return}

  await loadCatalog(session.id,root)
  const children=state.children[root.id]||[];state.expanded=[...new Set([...state.expanded,root.id])]
  let found=matchWorkspaceNode(children,desired)
  if(session.kind==='mongodb'&&!found){
    const category=categoryForNode(desired)
    const folder=children.find(n=>n.kind==='mongo-category'&&n.category===category)
    if(folder&&expandable(folder)){
      const objects=await window.dbex.children(session.id,root.database||root.label,category,true)
      state.children[folder.id]=objects;state.expanded.push(folder.id);state.catalog=folder
      found=matchWorkspaceNode(objects,desired)
    }
  }
  state.catalog=state.catalog||root
  if(found&&!expandable(found))openObject(state,found,validWorkbenchTab(session.kind,position.tab,found.readOnly))
  else{showCatalog(state,found||root);if(found&&expandable(found))await loadCatalog(session.id,found)}
}

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
async function task<T>(callback: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return undefined
  busy.value = true; error.value = ''; notice.value = ''
  try { return await callback() } catch (reason) { error.value = messageOf(reason); return undefined }
  finally { busy.value = false }
}
async function refreshConnections() {
  try { connections.value = await window.dbex.listConnections() } catch (reason) { error.value = messageOf(reason) }
}
async function refreshRoots(id: string) {
  const state = explorers[id]
  if (!state || state.busy) return
  state.busy = true
  try {
    const roots = await window.dbex.roots(id)
    if (explorers[id] !== state) return
    state.roots = roots; state.children = {}; state.expanded = []
    const exists=(database?:string)=>!database||roots.some(root=>root.database===database)
    state.tabs=state.tabs.filter(tab=>exists(tab.node.database))
    if(state.catalog&&!exists(state.catalog.database))state.catalog=undefined
    if(state.activeObject&&!state.tabs.some(tab=>tab.node.id===state.activeObject))showCatalog(state)
    if(state.selected?.database&&!exists(state.selected.database))state.selected=undefined
    if (sessions.value.find(item => item.id === id)?.kind === 'redis') state.selected = roots[0]
    if(sessions.value.find(item=>item.id===id)?.kind==='clickhouse'&&!state.activeObject&&!state.catalog)showCatalog(state)
  } catch (reason) { if (explorers[id] === state) error.value = messageOf(reason) }
  finally { if (explorers[id] === state) state.busy = false }
}
async function startSession(session: SessionInfo) {
  if (sessions.value.some(item => item.id === session.id)) { current.value = session.id; return }
  explorers[session.id] = { roots: [], children: {}, expanded: [], busy: false, loading: new Set(),tabs:[],catalogVisible:false }
  sessions.value.push(session); current.value = session.id
  if(session.connectionId){try{localStorage.setItem('dbex.last-connection',session.connectionId)}catch{}}
  await refreshRoots(session.id)
}
function updateSession(session: SessionInfo) { sessions.value = sessions.value.map(item => item.id === session.id ? session : item) }
async function connectSaved(connection: SavedConnection) {
  const existing = sessions.value.find(item => item.connectionId === connection.id)
  if (existing) { current.value = existing.id; return }
  const session = await task(() => window.dbex.connectSaved(connection.id))
  if (session) await startSession(session)
}
async function updateAppearance(id: string, patch: ConnectionAppearancePatch) {
  await task(async () => {
    const updated = await window.dbex.updateConnectionAppearance(id, patch)
    connections.value = connections.value.map(item => item.id === id ? updated : item)
  })
}
function sessionColor(session?: SessionInfo): string | undefined {
  return connections.value.find(item => item.id === session?.connectionId)?.color
}
function newConnection() { connectionDraft.value = undefined; dialogOpen.value = true }
async function editConnection(connection: SavedConnection) {
  const draft = await task(() => window.dbex.editConnection(connection.id))
  if (draft) { connectionDraft.value = draft; dialogOpen.value = true }
}
async function deleteConnection(connection: SavedConnection) {
  if (!await confirm({ title: t('删除保存的连接'), message: t('删除“{0}”的本地连接配置，并断开其活动会话。未提交事务将回滚；数据库中已提交的数据不受影响。', [connection.name]), danger: true, confirmLabel: t('删除配置') })) return
  await task(async () => { await window.dbex.deleteConnection(connection.id); for (const session of [...sessions.value]) if (session.connectionId === connection.id) removeSession(session.id); await refreshConnections() })
}
function removeSession(id: string) {
  sessions.value = sessions.value.filter(item => item.id !== id)
  delete explorers[id]
  if (current.value === id) current.value = sessions.value[0]?.id || null
}
async function disconnect(id: string) {
  const session = sessions.value.find(item => item.id === id)
  if (!session) return
  if(explorers[id]?.tabs.some(tab=>tab.dirty)&&!await confirm({title:t('关闭'),message:t('关闭标签页将丢弃未保存的修改。'),danger:false,confirmLabel:t('关闭')}))return
  if (session.transaction && !await confirm({ title: t('断开并回滚事务'), message: t('“{0}”仍有打开的事务。断开连接会回滚尚未提交的修改。', [session.name]), danger: true, confirmLabel: t('回滚并断开') })) return
  await task(async () => { await window.dbex.disconnect(id); removeSession(id) })
}
function closeDbMenu(){dbMenu.value=undefined}
function outsideMenu(event:PointerEvent){if(dbMenu.value&&!dbMenuHost.value?.contains(event.target as Node))closeDbMenu()}
function menuKey(event:KeyboardEvent){if(event.key==='Escape')closeDbMenu()}
async function showDbMenu(event:MouseEvent|KeyboardEvent,node?:ExplorerNode,sessionId=current.value||''){
  const session=sessions.value.find(item=>item.id===sessionId)
  if(!session||databaseCapabilities(session.kind).browser==='keyspace'||busy.value||sessionBusy(explorers[session.id])||dbDialog.value)return
  if(node&&node.kind!=='database')return
  event.preventDefault();event.stopPropagation()
  const rect=(event.currentTarget as HTMLElement).getBoundingClientRect()
  const mouse='clientX' in event
  current.value=session.id
  dbMenu.value={sessionId:session.id,node,x:Math.max(4,Math.min(mouse?event.clientX:rect.left,window.innerWidth-254)),y:Math.max(4,Math.min(mouse?event.clientY:rect.bottom,window.innerHeight-60))}
  await nextTick()
  if(dbMenu.value&&dbMenuHost.value){
    dbMenu.value.y=Math.max(4,Math.min(dbMenu.value.y,window.innerHeight-dbMenuHost.value.getBoundingClientRect().height-4))
    dbMenuHost.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true})
  }
}
function clearDatabase(state:ExplorerState,database:string){
  for(const key of Object.keys(state.children)){
    const root=state.roots.find(item=>item.id===key)
    if(root?.database===database||state.children[key]?.some(item=>item.database===database)){
      delete state.children[key];state.expanded=state.expanded.filter(id=>id!==key)
    }
  }
  state.tabs=state.tabs.filter(item=>item.node.database!==database)
  if(state.catalog?.database===database)state.catalog=undefined
  if(state.selected?.database===database||state.activeObject&&!state.tabs.some(tab=>tab.node.id===state.activeObject))showCatalog(state)

}
function actualQueryFolder(state:ExplorerState,database:string,kind:import('../shared/saved-query').QueryEngine,mode:QueryMode){
 const matches=(node:ExplorerNode|undefined):node is ExplorerNode=>!!node&&node.database===database&&isQueryFolder(node)&&folderQueryMode(node)===mode
 return Object.values(state.children).flat().find(matches)||(matches(state.catalog)?state.catalog:queryFolder(database,kind,mode))
}
function openQuery(id:string,database?:string,explicitMode?:QueryMode){
 const state=explorers[id],session=sessions.value.find(item=>item.id===id)
 if(!state||!session||!database||sessionBusy(state)||session.kind==='redis')return
 const mode=explicitMode||(session.kind==='mongodb'?(state.catalog?.database===database&&isQueryFolder(state.catalog)?folderQueryMode(state.catalog!):'mongo-find'):'sql')
 state.catalog=actualQueryFolder(state,database,session.kind,mode)
 const draftId=crypto.randomUUID()
 const node:ExplorerNode={id:'query-draft:'+draftId,draftId,kind:'saved-query',label:'未命名查询',database,queryMode:mode}
 openObject(state,node,mode==='sql'?'query':'data')
}
function querySaved(id:string,tabId:string,value:QuerySummary){
 const state=explorers[id],item=state?.tabs.find(t=>t.node.id===tabId)
 if(!state||!item)return
 item.node={...savedQueryNode(value),id:tabId}
 if(state.activeObject===tabId)state.selected=item.node
 const folder=actualQueryFolder(state,value.database,value.kind,value.mode)
 void loadCatalog(id,folder,true)
}
async function catalogQueryAction(id:string,action:'copy'|'delete'|'export'|'export-sql'|'import'|'rename',node?:ExplorerNode,newName?:string){
 const state=explorers[id],session=sessions.value.find(x=>x.id===id),folder=state?.catalog
 if(!state||!session?.connectionId||!folder?.database||!isQueryFolder(folder)||sessionBusy(state))return
 const database=folder.database,mode=folderQueryMode(folder)
 const opened=node?.queryId?state.tabs.find(tab=>tab.node.queryId===node.queryId):undefined
 if((action==='delete'||action==='rename')&&opened?.dirty){error.value='请先保存或关闭已修改的查询。';return}
 if(action==='rename'&&opened){error.value='请在已打开的查询编辑器内修改名称并保存。';return}
 const ok=await task(async()=>{
   if(action==='import')await window.dbex.importSavedQuery(id,database,mode)
   else if(node?.queryId){
     if(action==='copy')await window.dbex.copySavedQuery(id,database,node.queryId)
     if(action==='delete'){
       await window.dbex.deleteSavedQuery(id,database,node.queryId,node.queryRevision||'')
       state.tabs=state.tabs.filter(tab=>tab.node.queryId!==node.queryId)
     }
     if(action==='rename'){
       const item=await window.dbex.getSavedQuery(id,database,node.queryId)
       await window.dbex.saveQueryObject(id,database,{id:item.id,revision:node.queryRevision,draft:{...item,name:newName||''}})
     }
     if(action==='export'||action==='export-sql')await window.dbex.exportSavedQuery(id,database,node.queryId,action==='export-sql'?'sql':'json')
   }
   return true
 })
 if(ok)await loadCatalog(id,folder,true)
}
async function dbMenuAction(action:DatabaseMode|'close'|'query'|'refresh'|'native'|'sqlite-backup'){
  const menu=dbMenu.value, session=dbMenuSession.value
  closeDbMenu()
  if(!menu||!session||current.value!==session.id)return
  const state=explorers[session.id],database=menu.node?.database||''
  if(!state)return
  if(action==='sqlite-backup'){if(databaseCapabilities(session.kind).backup==='file')void task(async()=>{if(await window.dbex.backupSqlite(session.id))notice.value='操作已完成'});return}
  if(action==='native'){if(database&&databaseCapabilities(session.kind).backup==='native-tools')nativeDialog.value={sessionId:session.id,database};return}
  if(action==='refresh'){void refreshRoots(session.id);return}
  if(action==='close'){if(state.tabs.some(tab=>tab.node.database===database&&tab.dirty)&&!await confirm({title:t('关闭'),message:t('关闭标签页将丢弃未保存的修改。'),danger:false,confirmLabel:t('关闭')}))return;clearDatabase(state,database);return}
  if(action==='query'){
    if(!database)return
    openQuery(session.id,database)
    return
  }
  if(!databaseCapabilities(session.kind).databaseAdministration&&(action==='create'||action==='drop'))return
  if(action!=='create'&&!database)return
  if(action==='drop'&&(protectedDatabase(session.kind,database)||session.transaction))return
  dbDialog.value={sessionId:session.id,database,mode:action}
}
async function databaseChanged(database:string){
  const dialog=dbDialog.value
  if(!dialog)return
  dbDialog.value=undefined
  const state=explorers[dialog.sessionId]
  if(state)clearDatabase(state,database)
  notice.value=dialog.mode==='drop'?'数据库已删除':'数据库已创建'
  await refreshRoots(dialog.sessionId)
}
function databaseObjectSelected(node:ExplorerNode){
  const dialog=dbDialog.value
  if(!dialog)return
  dbDialog.value=undefined
  const state=explorers[dialog.sessionId]
  if(state){if(state.catalog?.database!==node.database)state.catalog=state.roots.find(root=>root.database===node.database);openObject(state,node)}
}
watch(current,()=>{if(dbMenu.value?.sessionId!==current.value)closeDbMenu();const id=activeSession.value?.connectionId;if(id){try{localStorage.setItem('dbex.last-connection',id)}catch{}}})
async function toggleRoot(node: ExplorerNode,fromList=false,id=current.value||'') {
  const state=explorers[id],session=sessions.value.find(item=>item.id===id)
  if(!session||!state||sessionBusy(state))return
  current.value=id
  if(!expandable(node)){
    if(node.kind==='keyspace'){state.selected=node;state.catalogVisible=false;return}
    if(node.kind==='saved-query'&&node.database&&node.queryMode&&session.kind!=='redis')state.catalog=actualQueryFolder(state,node.database,session.kind,node.queryMode)
    openObject(state,node);return
  }
  showCatalog(state,node)
  if(!fromList&&state.expanded.includes(node.id)){state.expanded=state.expanded.filter(value=>value!==node.id);return}
  if(!state.expanded.includes(node.id))state.expanded.push(node.id)
  await loadCatalog(id,node)
}
async function importConnections() {
  await task(async () => { const count = await window.dbex.importConnections(); await refreshConnections(); notice.value = `已导入 ${count} 个连接配置` })
}
async function exportConnections(id?: string) {
  await task(async () => { if (await window.dbex.exportConnections(id)) notice.value = '连接备份已导出（包含加密凭据），其他 DB EX 可直接导入，请妥善保管文件。' })
}
function refreshSessionResources(id:string){if(!busy.value&&!sessionBusy(explorers[id]))void refreshRoots(id)}
function persistView() {
  try { localStorage.setItem('dbex.view', JSON.stringify({ theme: theme.value, sidebar: sidebarWidth.value })) } catch { /* UI preferences are optional. */ }
}
function resize(event: PointerEvent) {
  event.preventDefault(); stopResize?.()
  const start = event.clientX
  const width = sidebarWidth
  const initial = width.value
  const direction = document.documentElement.dir === 'rtl' ? -1 : 1
  function move(value: PointerEvent) { width.value = Math.max(170, Math.min(520, initial + direction * (value.clientX - start))) }
  function stop() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.classList.remove('resizing'); persistView(); stopResize = undefined }
  stopResize = stop
  document.body.classList.add('resizing')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true })
}
function resizeKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const width = sidebarWidth
  width.value = Math.max(170, Math.min(520, width.value + (event.key === 'ArrowRight' ? 10 : -10) * (document.documentElement.dir === 'rtl' ? -1 : 1))); persistView()
}
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('dbex.view') || '{}')
    if (Number.isFinite(saved.sidebar)) sidebarWidth.value = Math.max(170, Math.min(520, saved.sidebar))
  } catch { /* Ignore invalid preference data. */ }
  document.documentElement.dataset.theme = theme.value
  window.addEventListener('pointerdown',outsideMenu); window.addEventListener('keydown',menuKey); window.addEventListener('keydown',settingsKey); window.addEventListener('resize',closeDbMenu)
  void (async()=>{
    try{
      await refreshConnections()
      if(preferences.value.startup==='lastConnection'){
        const id=localStorage.getItem('dbex.last-connection');const item=connections.value.find(value=>value.id===id&&!value.locked)
        if(item&&!sessions.value.length)await connectSaved(item)
      }else if(preferences.value.startup==='workspace'){
        const saved=normalizeWorkspace(JSON.parse(localStorage.getItem('dbex.workspace.v1')||'{}'))
        for(const id of saved.ids){const item=connections.value.find(value=>value.id===id&&!value.locked);if(item){await connectSaved(item);const session=sessions.value.find(s=>s.connectionId===id);if(session){
          const position=saved.positions[id]
          for(const tab of position?.tabs||[])try{await restorePosition(session,tab)}catch(reason){error.value=messageOf(reason)}
          try{await restorePosition(session,position)}catch(reason){error.value=messageOf(reason)}
          const state=explorers[session.id],activeTab=state?.tabs.find(tab=>tab.node.id===state.activeObject)
          if(activeTab)activeTab.mounted=true
        }}}
        const active=sessions.value.find(s=>s.connectionId===saved.active);if(active)current.value=active.id
      }
    }catch{}finally{restoringWorkspace=false;workspaceReady.value=true;persistWorkspace()}
  })()
})
onBeforeUnmount(() => { stopResize?.(); window.removeEventListener('pointerdown',outsideMenu); window.removeEventListener('keydown',menuKey); window.removeEventListener('keydown',settingsKey); window.removeEventListener('resize',closeDbMenu) })
</script>

<template>
  <main class="desktop" :style="{ '--sidebar-width': sidebarWidth + 'px' }">
    <header class="topbar"><div class="brand"><span class="brand-symbol">▦</span><strong>DB EX</strong><span class="brand-subtitle">DATABASE WORKSPACE</span></div><div class="top-actions"><button class="icon-button preferences-button" :aria-label="t('偏好设置')" :title="t('偏好设置')" @click="preferencesOpen=true">⚙</button></div></header>
    <div class="workspace"><ConnectionSidebar :connections="connections" :sessions="sessions" :current="current" :busy="busy" @refresh="refreshConnections" @create="newConnection" @connect="connectSaved" @activate="current = $event" @disconnect="disconnect" @edit="editConnection" @remove="deleteConnection" @import="importConnections" @export="exportConnections" @appearance="updateAppearance" @resource-menu="(event,id)=>showDbMenu(event,undefined,id)" @refresh-resources="refreshSessionResources">
        <template #resources="{session,grouped}">
          <ConnectionResourceTree :session="session" :state="explorers[session.id]" :active="session.id===current" :busy="busy||sessionBusy(explorers[session.id])" :color="sessionColor(session)" :grouped="grouped" @select="node=>toggleRoot(node,false,session.id)" @menu="(event,node)=>showDbMenu(event,node,session.id)" />
        </template>
      </ConnectionSidebar>
      <div class="resize-handle" role="separator" :aria-label="t('调整连接列表宽度')" aria-orientation="vertical" :aria-valuenow="sidebarWidth" :aria-valuemin="170" :aria-valuemax="520" tabindex="0" @pointerdown="resize($event)" @keydown="resizeKey($event)"></div>
      <section class="main-panel"><div v-show="preferences.alwaysShowTabs || sessions.length > 1" class="tabbar"><div v-if="!sessions.length" class="tab active">{{ t('欢迎') }}</div><div v-for="session in sessions" :key="session.id" :class="['session-tab', { active: current === session.id, 'has-color': !!sessionColor(session) }]" :style="colorStyle(sessionColor(session))" :data-color="sessionColor(session) || ''"><button class="tab" @click="current = session.id"><DatabaseIcon :kind="session.kind" size="small" />{{ session.name }}</button><button class="tab-close" :title="t('断开 {0}', [session.name])" :disabled="busy" @click="disconnect(session.id)">×</button></div><div class="tab-filler"></div><span v-if="busy" class="tab-trailing">{{ t('正在连接 / 处理…') }}</span></div><div v-if="error" class="inline-message error" role="alert">{{ localize(error) }}<button class="ghost-icon" :aria-label="t('关闭错误')" @click="error = ''">×</button></div><div v-if="notice" class="inline-message notice">{{ localize(notice) }}</div>
        <div v-if="!current" class="welcome-body empty-workspace" aria-hidden="true"></div>
        <div v-else class="data-area"><div class="content-pane"><template v-if="workspaceReady">
  <section v-for="session in sessions" v-show="session.id===current" :key="session.id" class="object-workspace">
    <nav v-if="session.kind!=='redis'" class="object-tabbar" :aria-label="t('对象')">
      <button class="object-list-tab" type="button" :class="{active:explorers[session.id]?.catalogVisible}" :disabled="sessionBusy(explorers[session.id])" @click="activateCatalog(session.id)">{{ t('对象') }}</button>
      <div v-for="item in explorers[session.id]?.tabs||[]" :key="item.node.id" :class="['object-tab',{'active':explorers[session.id]?.activeObject===item.node.id,'has-color':!!sessionColor(session)}]" :style="colorStyle(sessionColor(session))">
        <button class="object-tab-main" type="button" :title="objectTabTooltip(item.node,session)" :disabled="sessionBusy(explorers[session.id])" @click="activateObject(session.id,item.node)"><span class="catalog-object-icon" aria-hidden="true">{{ nodeIcon(item.node) }}</span><span class="ellipsis">{{ objectTabTitle(item.node) }}<template v-if="item.node.database">@{{ item.node.database }}</template></span><span v-if="item.dirty" class="object-dirty" aria-hidden="true">•</span></button>
        <button class="tab-close" type="button" :title="t('关闭')+' '+objectTabTitle(item.node)" :aria-label="t('关闭')+' '+objectTabTitle(item.node)" :disabled="sessionBusy(explorers[session.id])" @click="closeObject(session.id,item.node.id)">×</button>
      </div>
    </nav>
    <ObjectList v-if="explorers[session.id]?.catalogVisible" :kind="session.kind" :node="explorers[session.id]?.catalog" :nodes="catalogNodes(explorers[session.id])" :busy="busy||sessionBusy(explorers[session.id])" :can-save-queries="!!session.connectionId" @query-action="(action,node,name)=>catalogQueryAction(session.id,action,node,name)" @open="toggleRoot($event,true,session.id)" @query="openQuery(session.id,explorers[session.id]?.catalog?.database)" @refresh="refreshCatalog(session.id)" />
    <DatabaseWorkbench v-if="session.kind!=='clickhouse'" v-show="!explorers[session.id]?.catalogVisible&&!explorers[session.id]?.activeObject" :session="session" :node="session.kind==='redis'?explorers[session.id]?.selected:undefined" :initial-tab="explorers[session.id]?.baseTab" :active="session.id===current&&!explorers[session.id]?.catalogVisible&&!explorers[session.id]?.activeObject" @tab-change="workbenchTabChanged(session.id,$event)" @busy-change="workbenchBusyChanged(session.id,$event)" @update-session="updateSession" @disconnect="removeSession(session.id)" @refresh-tree="refreshRoots(session.id)" />
    <template v-for="item in explorers[session.id]?.tabs||[]" :key="item.node.id">
    <template v-if="item.mounted">
      <SavedQueryEditor v-if="item.node.kind==='saved-query'" v-show="explorers[session.id]?.activeObject===item.node.id" :session="session" :node="item.node" :active="session.id===current&&explorers[session.id]?.activeObject===item.node.id" :table-suggestions="Object.values(explorers[session.id]?.children||{}).flat().filter(n=>(n.kind==='table'||n.kind==='view')&&n.database===item.node.database).map(n=>n.label)" @saved="querySaved(session.id,item.node.id,$event)" @busy-change="workbenchBusyChanged(session.id,$event,item.node.id)" @dirty-change="workbenchDirtyChanged(session.id,$event,item.node.id)" @update-session="updateSession" @disconnect="removeSession(session.id)" />
    <ClickHouseWorkbench v-else-if="session.kind==='clickhouse'" v-show="explorers[session.id]?.activeObject===item.node.id" :session="session" :node="item.node" :active="session.id===current&&explorers[session.id]?.activeObject===item.node.id" :initial-tab="item.tab" @tab-change="workbenchTabChanged(session.id,$event,item.node.id)" @busy-change="workbenchBusyChanged(session.id,$event,item.node.id)" @dirty-change="workbenchDirtyChanged(session.id,$event,item.node.id)" @update-session="updateSession" @disconnect="removeSession(session.id)" />
    <DatabaseWorkbench v-else v-show="explorers[session.id]?.activeObject===item.node.id"  :session="session" :node="item.node" :initial-tab="item.tab" :active="session.id===current&&explorers[session.id]?.activeObject===item.node.id" :table-suggestions="Object.values(explorers[session.id]?.children || {}).flat().filter(n=>(n.kind==='table'||n.kind==='view')&&n.database===item.node.database).map(n=>n.label)" @tab-change="workbenchTabChanged(session.id,$event,item.node.id)" @busy-change="workbenchBusyChanged(session.id,$event,item.node.id)" @dirty-change="workbenchDirtyChanged(session.id,$event,item.node.id)" @update-session="updateSession" @disconnect="removeSession(session.id)" @refresh-tree="refreshRoots(session.id)" />
    </template>
    </template>
  </section>
</template></div></div>
      </section>
    </div>
    <footer class="statusbar"><span class="status-dot"></span>{{ activeSession ? activeSession.displayHost : 'Ready' }}<span class="separator">|</span>{{ activeSession?.name || t('未连接数据库') }}<span v-if="activeSession?.transaction" class="transaction-text">{{ t('事务尚未提交') }}</span><span class="status-right">DB EX · Core Preview</span></footer>
    <Teleport to="body"><div v-if="dbMenu" ref="dbMenuHost" class="connection-context-menu database-context-menu" :style="{left:dbMenu.x+'px',top:dbMenu.y+'px'}" @contextmenu.prevent @pointerdown.stop>
      <div class="context-title"><strong>{{ dbMenu.node?.label || dbMenuSession?.name }}</strong></div>
      <button v-if="dbMenu.node" class="context-action" @click="dbMenuAction('close')">{{ t('关闭数据库') }}</button>
      <button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).databaseAdministration" class="context-action" :disabled="dbMenuSession?.transaction" @click="dbMenuAction('create')">{{ t('新建数据库') }}…</button>
      <button v-if="dbMenu.node && dbMenuSession && databaseCapabilities(dbMenuSession.kind).databaseAdministration" class="context-action danger" :disabled="protectedDatabase(dbMenuSession?.kind || 'mongodb',dbMenu.node.database || '') || dbMenuSession?.transaction" @click="dbMenuAction('drop')">{{ t('删除数据库') }}…</button>
      <template v-if="dbMenu.node"><div class="context-menu-divider"></div><button class="context-action" @click="dbMenuAction('query')">{{ t('新建查询') }}</button><button class="context-action" @click="dbMenuAction('search')">{{ t('查找数据库对象') }}…</button><div class="context-menu-divider"></div><button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).backup==='file'" class="context-action" :disabled="dbMenuSession.transaction" @click="dbMenuAction('sqlite-backup')">{{ t('备份数据库') }}…</button><button v-if="dbMenuSession && databaseCapabilities(dbMenuSession.kind).backup==='native-tools'" class="context-action" @click="dbMenuAction('native')">{{ t('外部工具') }}…</button><button v-if="dbMenuSession?.kind!=='clickhouse'" class="context-action" @click="dbMenuAction('schema')">{{ t('导出结构脚本') }}…</button><button v-if="dbMenuSession?.kind!=='clickhouse'" class="context-action" @click="dbMenuAction('import')">{{ t('导入数据') }}…</button><button v-if="dbMenuSession?.kind!=='clickhouse'" class="context-action" @click="dbMenuAction('export')">{{ t('导出数据') }}…</button></template>
      <div class="context-menu-divider"></div><button class="context-action" @click="dbMenuAction('refresh')">{{ t('刷新') }}</button>
    </div></Teleport>
    <NativeToolDialog v-if="nativeDialog&&nativeSession" :session="nativeSession" :database="nativeDialog.database" @close="nativeDialog=undefined" @session="updateSession" @disconnect="removeSession(nativeSession.id);nativeDialog=undefined" />
    <DatabaseActionsDialog v-if="dbDialog && dbDialogSession" :session="dbDialogSession" :database="dbDialog.database" :mode="dbDialog.mode" :existing="explorers[dbDialog.sessionId]?.roots.map(item=>item.database || item.label) || []" @close="dbDialog=undefined" @changed="databaseChanged" @select="databaseObjectSelected" @session="updateSession" />
    <PreferencesDialog v-if="preferencesOpen" v-show="!dialogOpen" :connection-busy="busy" @create-connection="newConnection" @close="preferencesOpen=false" />
    <ConnectionDialog v-if="dialogOpen" :draft="connectionDraft" @close="dialogOpen = false" @saved="refreshConnections" @connected="startSession" />
    <ConfirmDialog v-if="confirmation" v-bind="confirmation" @confirm="answer(true)" @cancel="answer(false)" />
  </main>
</template>
