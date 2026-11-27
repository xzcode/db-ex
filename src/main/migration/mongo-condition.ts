import {BSON,type Document} from 'mongodb'
import type {MigrationCondition} from '../../shared/migration'
import {validateReadDocument} from '../operations/mongodb'
import {compileMongoFilter} from '../../shared/browse-filter'
import {migrationBrowseFilter} from './condition'

export function mongoMigrationFilter(condition?:MigrationCondition):Document{
 if(!condition)return {}
 const value=BSON.EJSON.parse(compileMongoFilter(migrationBrowseFilter(condition)).filter,{relaxed:false})
 validateReadDocument(value)
 return value as Document
}
