import { createMysqlFamilyAdapter } from './mysql'

/** Independent identity and dialect; reuse the tested MySQL wire transport. */
export const mariadbAdapter=createMysqlFamilyAdapter('mariadb')
