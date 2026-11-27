<script setup lang="ts">
import { t } from '../i18n'
import { sqlContext,sqlKeywords,sqlFunctions,clickHouseFunctions,sqliteFunctions,mongoSuggestions,redisSuggestions } from '../../shared/editor-completion'
import {mongoConstructors} from '../../shared/mongo-query-script'
import {mongoCollectionSignatures,mongoCursorSignatures,type MongoSignature} from '../../shared/mongo-completion'
import { preferences } from '../preferences'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/language/json/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'

const props = withDefaults(defineProps<{
  modelValue: string
  language?: string
  readonly?: boolean
  suggestions?: string[]
  tableSuggestions?: string[]
  completionKind?: 'mongodb'|'redis'
  sqlDialect?: 'mysql'|'mariadb'|'sqlite'|'clickhouse'
}>(), { language: 'sql', readonly: false, suggestions: () => [] })
const emit = defineEmits<{ 'update:modelValue': [value: string]; execute: [] }>()
const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined
let observer: MutationObserver | undefined
let completion: monaco.IDisposable[] = []
let change: monaco.IDisposable | undefined

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) { return label === 'json' ? new JsonWorker() : new EditorWorker() },
}

// Friendly BSON syntax is a data language, not an executable JavaScript editor.
monaco.languages.register({ id: 'dbex-bson-document' })
monaco.languages.setMonarchTokensProvider('dbex-bson-document', {
  tokenizer: { root: [
    [/"(?:[^"\\]|\\.)*"/, 'string'],
    [/\b(?:ObjectId|Int32|Long|Double|Decimal128|ISODate|Date|Timestamp|BinData|Regex|MinKey|MaxKey)\b/, 'keyword'],
    [/\b(?:true|false|null)\b/, 'keyword'],
    [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
    [/[{}\[\]()]/, '@brackets'],
    [/[,:]/, 'delimiter'],
    [/[A-Za-z_$][\w$]*/, 'invalid'],
  ] }
})
monaco.languages.setLanguageConfiguration('dbex-bson-document', {
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
})
if (!monaco.languages.getLanguages().some(language => language.id === 'dbex-mongo-ddl')) {
  monaco.languages.register({ id: 'dbex-mongo-ddl' })
  monaco.languages.setMonarchTokensProvider('dbex-mongo-ddl', {
    tokenizer: { root: [
      [/\/\/.*$/, 'comment'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/\b(?:db|EJSON|ObjectId|Int32|Long|Double|Decimal128|ISODate|Date|Timestamp|BinData|Regex|MinKey|MaxKey|true|false|null)\b/, 'keyword'],
      [/\b(?:getSiblingDB|getCollection|createCollection|createIndex|deserialize)\b/, 'type.identifier'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[,:;.]/, 'delimiter'],
      [/[A-Za-z_$][\w$]*/, 'identifier'],
    ] }
  })
}
if (!monaco.languages.getLanguages().some(language=>language.id==='dbex-mongo-script')){
 monaco.languages.register({id:'dbex-mongo-script'})
 monaco.languages.setMonarchTokensProvider('dbex-mongo-script',{
  tokenizer:{root:[
   [/\/\/.*$/,'comment'],[/\/\*/,'comment','@comment'],[/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,'string'],
   [/\b(?:db|true|false|null|new|ObjectId|NumberInt|NumberLong|NumberDecimal|Int32|Long|Decimal128|ISODate|Date)\b/,'keyword'],
   [/\$[A-Za-z_][\w$]*/,'keyword'],[/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,'number'],[/[{}\[\]()]/,'@brackets'],[/[,:;.]/,'delimiter'],[/[A-Za-z_$][\w$]*/,'identifier']
  ],comment:[[/[^*/]+/,'comment'],[/\*\//,'comment','@pop'],[/[*/]/,'comment']]}})
 monaco.languages.setLanguageConfiguration('dbex-mongo-script',{comments:{lineComment:'//',blockComment:['/*','*/']},brackets:[['{','}'],['[',']'],['(',')']],autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:'"',close:'"'},{open:"'",close:"'"}]})
}
function applyTheme() {
  const theme=document.documentElement.dataset.theme||'dark'
  const light=theme==='light'||theme==='soft-light'
  const p=preferences.value.editor
  if(!p.customColors){
    if(theme==='gray'||theme==='black'||theme==='soft-light'){
      const color=(key:string)=>getComputedStyle(document.documentElement).getPropertyValue(key).trim()
      monaco.editor.defineTheme('dbex-interface',{base:light?'vs':'vs-dark',inherit:true,rules:[],colors:{'editor.background':color('--editor-bg'),'editor.foreground':color('--text'),'editorGutter.background':color('--editor-bg'),'editorLineNumber.foreground':color('--muted'),'editor.selectionBackground':color('--selected'),'editor.lineHighlightBackground':color('--toolbar-bg')}})
      monaco.editor.setTheme('dbex-interface')
    }else monaco.editor.setTheme(light?'vs':'vs-dark')
    return
  }
  const colors=p.colors
  monaco.editor.defineTheme('dbex-custom',{base:light?'vs':'vs-dark',inherit:true,rules:[
    {token:'',foreground:colors.foreground.slice(1)},{token:'keyword',foreground:colors.keyword.slice(1)},{token:'comment',foreground:colors.comment.slice(1)},{token:'string',foreground:colors.string.slice(1)},{token:'number',foreground:colors.number.slice(1)}
  ],colors:{'editor.foreground':colors.foreground,'editor.background':colors.background}})
  monaco.editor.setTheme('dbex-custom')
}
function activeLanguage(){
 const p=preferences.value.editor
 return p.syntax&&new TextEncoder().encode(props.modelValue).length<=p.maxHighlightMB*1024*1024?props.language:'plaintext'
}
function applyOptions(){
 const p=preferences.value.editor,completionOn=preferences.value.completion&&activeLanguage()!=='plaintext'
 editor?.updateOptions({lineNumbers:p.lineNumbers?'on':'off',folding:p.folding,matchBrackets:p.brackets?'always':'never',bracketPairColorization:{enabled:p.brackets},insertSpaces:p.insertSpaces,tabSize:p.tabSize,wordWrap:p.wordWrap?'on':'off',fontSize:p.fontSize,fontFamily:p.fontFamily==='default'?'"SFMono-Regular", Consolas, "Liberation Mono", monospace':'"'+p.fontFamily+'", monospace',quickSuggestions:completionOn&&preferences.value.autoCompletion,suggestOnTriggerCharacters:completionOn&&preferences.value.autoCompletion,suggestSelection:preferences.value.firstSuggestion?'first':'recentlyUsed',acceptSuggestionOnEnter:completionOn?'on':'off',wordBasedSuggestions:completionOn?'currentDocument':'off'})
 editor?.getModel()?.updateOptions({tabSize:p.tabSize,insertSpaces:p.insertSpaces})
 const model=editor?.getModel()
 if(model&&model.getLanguageId()!==activeLanguage())monaco.editor.setModelLanguage(model,activeLanguage())
}
onMounted(() => {
  if (!host.value) return
  editor = monaco.editor.create(host.value, {
    value: props.modelValue, language: props.language, readOnly: props.readonly,
    automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    tabSize: 2, wordWrap: 'on', scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 }, fixedOverflowWidgets: true,
  })
  applyTheme(); applyOptions()
  change = editor.onDidChangeModelContent(() => emit('update:modelValue', editor!.getValue()))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('execute'))
  function provider(language:string){
    return monaco.languages.registerCompletionItemProvider(language,{
      triggerCharacters:language==='sql'?['.',' ']:language==='dbex-mongo-script'?['.','$','"',"'"]:['$','"'],
      provideCompletionItems(model,position){
        if(model!==editor?.getModel()||!preferences.value.completion||activeLanguage()==='plaintext'||props.readonly)return {suggestions:[]}
        const word=model.getWordUntilPosition(position)
        const range=new monaco.Range(position.lineNumber,(language==='json'||language==='dbex-mongo-script')&&model.getLineContent(position.lineNumber)[word.startColumn-2]==='$'?word.startColumn-1:word.startColumn,position.lineNumber,word.endColumn)
        const kinds=monaco.languages.CompletionItemKind
        const prefix=model.getValueInRange(new monaco.Range(position.lineNumber,1,position.lineNumber,position.column))
        const entries:monaco.languages.CompletionItem[]=[]
        function add(labels:readonly string[],kind:monaco.languages.CompletionItemKind,priority:string,format:(s:string)=>string=(s=>s)){
          for(const label of [...new Set(labels)].filter(Boolean).slice(0,500))entries.push({label,insertText:format(label),kind,range,sortText:priority+label})
        }
        function addSignatures(signatures:MongoSignature[]){
          for(const [index,sig] of signatures.entries()){
            const detail='('+sig.parameters.join(', ')+')'
            entries.push({label:{label:sig.name,detail:' '+detail,description:sig.reference?t('仅供参考，暂不支持执行'):undefined},kind:kinds.Method,
              filterText:sig.name,sortText:(sig.reference?'2':'0')+sig.name+String(index).padStart(3,'0'),
              detail:sig.name+detail,documentation:sig.note,insertText:sig.snippet,insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,range})
          }
        }
        if(language==='sql'){
          const context=sqlContext(prefix)
          const quote=(name:string)=>props.sqlDialect==='clickhouse'?'"'+name.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"':props.sqlDialect==='sqlite'?'"'+name.replaceAll('"','""')+'"':'\x60'+name.replaceAll('\x60','\x60\x60')+'\x60'
          add(props.tableSuggestions||[],kinds.Class,context==='table'?'0':'2',quote)
          add(props.suggestions||[],kinds.Field,context==='field'?'0':'2',quote)
          add(sqlKeywords,kinds.Keyword,'3')
          add([...sqlFunctions,...(props.sqlDialect==='clickhouse'?clickHouseFunctions:props.sqlDialect==='sqlite'?sqliteFunctions:[])],kinds.Function,'4',name=>name+'()')
        }else if(language==='dbex-mongo-script'){
          const fullPrefix=model.getValueInRange(new monaco.Range(1,1,position.lineNumber,position.column))
          const collectionPrefix=/\bdb\.([\w$]*)$/.exec(fullPrefix)
          const quotedCollection=/\bdb\.getCollection\(\s*["']([^"']*)$/.exec(fullPrefix)
          const methodPrefix=/\bdb(?:\.[\w$]+|\.getCollection\([^)]*\)|\[["'][^"']+["']\])\.([\w$]*)$/.test(fullPrefix)
          if(collectionPrefix){
           add(props.tableSuggestions||[],kinds.Class,'0',name=>/^[A-Za-z_$][\w$]*$/.test(name)?name:'getCollection('+JSON.stringify(name)+')')
           add(['getCollection'],kinds.Function,'1',()=> 'getCollection("")')
          }else if(quotedCollection){
           for(const label of [...new Set(props.tableSuggestions||[])].slice(0,500))entries.push({label,kind:kinds.Class,range:new monaco.Range(position.lineNumber,position.column-quotedCollection[1]!.length,position.lineNumber,position.column),insertText:JSON.stringify(label).slice(1,-1).replaceAll("'","\\'"),sortText:'0'+label})
          }else if(methodPrefix){
           addSignatures(mongoCollectionSignatures)
          }else if(/\)\s*\.\w*$/.test(fullPrefix)){
           addSignatures(mongoCursorSignatures)
          }else{
           add(mongoSuggestions,kinds.Keyword,'1')
           add(props.suggestions||[],kinds.Field,'0',name=>/^[A-Za-z_$][\w$]*$/.test(name)?name:JSON.stringify(name))
           add(mongoConstructors,kinds.Constructor,'2',name=>name+'()')
          }
        }else if(props.completionKind==='mongodb'){
          add(mongoSuggestions,kinds.Keyword,'1')
          add(props.suggestions||[],kinds.Field,'2')
        }else if(props.completionKind==='redis')add(redisSuggestions,kinds.Keyword,'1')
        return {suggestions:entries}
      }
    })
  }
  const hints=monaco.languages.registerSignatureHelpProvider('dbex-mongo-script',{
   signatureHelpTriggerCharacters:['(',','],
   signatureHelpRetriggerCharacters:[','],
   provideSignatureHelp(model,position){
    if(model!==editor?.getModel()||props.readonly||!preferences.value.completion)return null
    const text=model.getValueInRange(new monaco.Range(1,1,position.lineNumber,position.column))
    // Walk the prefix; keep unclosed call frames and count top-level commas.
    const stack:{kind:string;name?:string;commas:number}[]=[]
    let quote='',escaped=false
    for(let i=0;i<text.length;i++){
      const c=text[i]!
      if(quote){if(escaped){escaped=false;continue}if(c==='\\'){escaped=true;continue}if(c===quote)quote='';continue}
      if(c==='"'||c==="'"){quote=c;continue}
      if(c==='('){const name=/([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0,i))?.[1];stack.push({kind:c,name,commas:0})}
      else if(c==='{'||c==='[')stack.push({kind:c,commas:0})
      else if(c===')'||c==='}'||c===']')stack.pop()
      else if(c===','&&stack.at(-1)?.kind==='(')stack.at(-1)!.commas++
    }
    const call=[...stack].reverse().find(x=>x.kind==='('&&x.name)
    if(!call)return null
    const signatures=[...mongoCollectionSignatures,...mongoCursorSignatures].filter(s=>s.name===call.name&&!s.reference)
    if(!signatures.length)return null
    const index=Math.max(0,signatures.findIndex(s=>s.parameters.length>call.commas))
    return {value:{signatures:signatures.map(s=>({label:s.name+'('+s.parameters.join(', ')+')',documentation:s.note,parameters:s.parameters.map(label=>({label}))})),activeSignature:index,activeParameter:Math.min(call.commas,Math.max(0,signatures[index]!.parameters.length-1))},dispose(){}}
   }
  })
  completion=[provider('sql'),provider('json'),provider('dbex-mongo-script'),hints]
  observer = new MutationObserver(applyTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
watch(() => props.modelValue, value => { if (editor && editor.getValue() !== value) editor.setValue(value); if(editor?.getModel()?.getLanguageId()!==activeLanguage())applyOptions() })
watch(() => props.language,applyOptions)
watch(preferences,()=>{applyTheme();applyOptions()},{deep:true})
watch(() => props.readonly, value => editor?.updateOptions({ readOnly: value }))
onBeforeUnmount(() => {
  observer?.disconnect(); completion.forEach(item=>item.dispose()); change?.dispose()
  const model = editor?.getModel(); editor?.dispose(); model?.dispose()
})
defineExpose({
  selection: () => {
    const selection = editor?.getSelection()
    return selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) || '' : props.modelValue
  },
  focus: () => editor?.focus(),
})
</script>

<template><div ref="host" class="code-editor" :aria-label="t('代码编辑器')"></div></template>
