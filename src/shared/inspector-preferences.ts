export const inspectorTabs=['info','ddl','colors'] as const
export type InspectorTab=typeof inspectorTabs[number]
export interface InspectorPreferences {open:boolean;tab:InspectorTab;expanded:boolean;width:number}
export const defaultInspectorPreferences=():InspectorPreferences=>({open:true,tab:'info',expanded:false,width:310})
export function normalizeInspectorPreferences(value:unknown):InspectorPreferences{
 const d=defaultInspectorPreferences(),v=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
 return {open:typeof v.open==='boolean'?v.open:d.open,tab:inspectorTabs.includes(v.tab as InspectorTab)?v.tab as InspectorTab:d.tab,expanded:typeof v.expanded==='boolean'?v.expanded:d.expanded,width:typeof v.width==='number'&&Number.isInteger(v.width)&&v.width>=220&&v.width<=680?v.width:d.width}
}
