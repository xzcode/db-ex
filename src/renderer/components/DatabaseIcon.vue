<script setup lang="ts">
import type {DatabaseKind} from '../../shared/types'
import mysql from '../assets/database-icons/mysql.svg'
import mariadb from '../assets/database-icons/mariadb.svg'
import mongodb from '../assets/database-icons/mongodb.svg'
import redis from '../assets/database-icons/redis.svg'
import sqlite from '../assets/database-icons/sqlite.svg'
import clickhouse from '../assets/database-icons/clickhouse.svg'
defineProps<{kind:DatabaseKind;size?:'small'|'normal'|'large'}>()
const icons:Record<DatabaseKind,string>={mysql,mariadb,mongodb,redis,sqlite,clickhouse}
</script>
<template>
 <span :class="['database-brand-icon',kind,size||'normal']" :data-database-icon="kind" aria-hidden="true"><img :src="icons[kind]" alt="" draggable="false" /></span>
</template>
<style scoped>
.database-brand-icon{display:inline-flex;justify-content:center;align-items:center;width:24px;height:24px;flex:0 0 auto;border-radius:4px;overflow:hidden;vertical-align:middle}
.database-brand-icon img{display:block;width:78%;height:78%;object-fit:contain;filter:invert(1);pointer-events:none;user-select:none}
.database-brand-icon.small{width:18px;height:18px;border-radius:3px}
.database-brand-icon.large{width:34px;height:34px;border-radius:5px}
.database-brand-icon.mysql{background:#176c8c}
.database-brand-icon.mariadb{background:#805640}
.database-brand-icon.mongodb{background:#13764b}
.database-brand-icon.redis{background:#bd3440}
.database-brand-icon.sqlite{background:#267ba9}
.database-brand-icon.clickhouse{background:#f5cc3c}
.database-brand-icon.clickhouse img{filter:none}
</style>
