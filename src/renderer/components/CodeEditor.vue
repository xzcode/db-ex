<script setup lang="ts">
import { t } from '../i18n'
import { sqlContext,sqlKeywords,sqlFunctions,mongoSuggestions,redisSuggestions } from '../../shared/editor-completion'
import { preferences } from '../preferences'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
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
function applyTheme() {
  const light=document.documentElement.dataset.theme==='light'
  const p=preferences.value.editor
  if(!p.customColors){monaco.editor.setTheme(light?'vs':'vs-dark');return}
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
      triggerCharacters:language==='sql'?['.',' ']:['$','"'],
      provideCompletionItems(model,position){
        if(model!==editor?.getModel()||!preferences.value.completion||activeLanguage()==='plaintext'||props.readonly)return {suggestions:[]}
        const word=model.getWordUntilPosition(position)
        const range=new monaco.Range(position.lineNumber,language==='json'&&model.getLineContent(position.lineNumber)[word.startColumn-2]==='$'?word.startColumn-1:word.startColumn,position.lineNumber,word.endColumn)
        const kinds=monaco.languages.CompletionItemKind
        const prefix=model.getValueInRange(new monaco.Range(position.lineNumber,1,position.lineNumber,position.column))
        const entries:monaco.languages.CompletionItem[]=[]
        function add(labels:readonly string[],kind:monaco.languages.CompletionItemKind,priority:string,format:(s:string)=>string=(s=>s)){
          for(const label of [...new Set(labels)].filter(Boolean).slice(0,500))entries.push({label,insertText:format(label),kind,range,sortText:priority+label})
        }
        if(language==='sql'){
          const context=sqlContext(prefix)
          const quote=(name:string)=>'\x60'+name.replaceAll('\x60','\x60\x60')+'\x60'
          add(props.tableSuggestions||[],kinds.Class,context==='table'?'0':'2',quote)
          add(props.suggestions||[],kinds.Field,context==='field'?'0':'2',quote)
          add(sqlKeywords,kinds.Keyword,'3')
          add(sqlFunctions,kinds.Function,'4',name=>name+'()')
        }else if(props.completionKind==='mongodb'){
          add(mongoSuggestions,kinds.Keyword,'1')
          add(props.suggestions||[],kinds.Field,'2')
        }else if(props.completionKind==='redis')add(redisSuggestions,kinds.Keyword,'1')
        return {suggestions:entries}
      }
    })
  }
  completion=[provider('sql'),provider('json')]
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
