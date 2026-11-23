import { contextBridge, ipcRenderer } from 'electron'
import type { DbExAPI } from '../shared/types'
// Every bridge method is explicit. Renderer receives no filesystem, raw IPC or driver handles.
const api: DbExAPI = {
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (config, clearSecrets) => ipcRenderer.invoke('connections:save', config, clearSecrets),
  editConnection: id => ipcRenderer.invoke('connections:edit', id),
  deleteConnection: id => ipcRenderer.invoke('connections:delete', id),
  trustHostKey: (id, fingerprint) => ipcRenderer.invoke('connections:trust-host', id, fingerprint),
  connectSaved: id => ipcRenderer.invoke('connections:connect-saved', id),
  connectTemporary: (config, clearSecrets) => ipcRenderer.invoke('connections:connect-temporary', config, clearSecrets),
  testConnection: (config, clearSecrets) => ipcRenderer.invoke('connections:test', config, clearSecrets),
  disconnect: id => ipcRenderer.invoke('connections:disconnect', id),
  roots: id => ipcRenderer.invoke('explorer:roots', id),
  children: (id, database) => ipcRenderer.invoke('explorer:children', id, database),
  preview: (id, database, entity, offset) => ipcRenderer.invoke('explorer:preview', id, database, entity, offset),
  redisKeys: (id, cursor, pattern) => ipcRenderer.invoke('explorer:redis-keys', id, cursor, pattern),
  redisValue: (id, key) => ipcRenderer.invoke('explorer:redis-value', id, key),
  execute: (id, operation) => ipcRenderer.invoke('sessions:execute', id, operation),
  cancel: id => ipcRenderer.invoke('sessions:cancel', id),
  setWriteAccess: (id, enabled) => ipcRenderer.invoke('sessions:write-access', id, enabled),
  listSnippets: () => ipcRenderer.invoke('snippets:list'),
  saveSnippet: value => ipcRenderer.invoke('snippets:save', value),
  deleteSnippet: id => ipcRenderer.invoke('snippets:delete', id),
  importFile: () => ipcRenderer.invoke('files:import'),
  exportFile: (name, content, format) => ipcRenderer.invoke('files:export', name, content, format),
  importConnections: () => ipcRenderer.invoke('connections:import'),
  exportConnections: () => ipcRenderer.invoke('connections:export'),
  importSshConfig: () => ipcRenderer.invoke('connections:ssh-config'),
}
contextBridge.exposeInMainWorld('dbex', api)
