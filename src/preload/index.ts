import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectionConfig, DbExAPI } from '../shared/types'

// Expose only the narrow calls needed by the Renderer. No generic invoke/send bridge.
const api: DbExAPI = {
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (config: ConnectionConfig) => ipcRenderer.invoke('connections:save', config),
  deleteConnection: (id: string) => ipcRenderer.invoke('connections:delete', id),
  trustHostKey: (id: string, fingerprint: string) => ipcRenderer.invoke('connections:trust-host', id, fingerprint),
  connectSaved: (id: string) => ipcRenderer.invoke('connections:connect-saved', id),
  connectTemporary: (config: ConnectionConfig) => ipcRenderer.invoke('connections:connect-temporary', config),
  disconnect: (sessionId: string) => ipcRenderer.invoke('connections:disconnect', sessionId),
  roots: (sessionId: string) => ipcRenderer.invoke('explorer:roots', sessionId),
  children: (sessionId: string, database: string) => ipcRenderer.invoke('explorer:children', sessionId, database),
  preview: (sessionId: string, database: string, entity: string, offset?: number) =>
    ipcRenderer.invoke('explorer:preview', sessionId, database, entity, offset),
  redisKeys: (sessionId: string, cursor?: number, pattern?: string) =>
    ipcRenderer.invoke('explorer:redis-keys', sessionId, cursor, pattern),
  redisValue: (sessionId: string, key: string) => ipcRenderer.invoke('explorer:redis-value', sessionId, key),
}

contextBridge.exposeInMainWorld('dbex', api)
