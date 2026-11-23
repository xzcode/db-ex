/// <reference types="vite/client" />
import type { DbExAPI } from '../shared/types'

declare global {
  interface Window { dbex: DbExAPI }
}
